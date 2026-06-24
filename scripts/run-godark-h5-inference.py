#!/usr/bin/env python3
"""
Run the bundled GoDark PyTorch ensemble stored in the .h5 artifact.

This script is intentionally self-contained because the provided .h5 is not a
Keras model. It stores PyTorch state_dicts, RobustScalers, metadata, and a Platt
calibrator inside an HDF5 bundle.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import warnings
from pathlib import Path

import h5py
import joblib
import numpy as np
import pandas as pd
import torch
from torch import nn
import torch.nn.functional as F


DEFAULT_INPUT = Path("new/metadata/ais_trajectory_points_kalman.csv")
DEFAULT_SCENE_METADATA = Path("new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv")
DEFAULT_OUTPUT = Path("KAPAL YG TERDETEKSI/godark_h5_predictions_by_scene.csv")
DEFAULT_GEAR_REFERENCE_DIR = Path("Dataset_Test_Enriched")


FEATURE_COLS = [
    "speed",
    "vx",
    "vy",
    "dspeed",
    "accel",
    "dcourse",
    "turn_rate",
    "abs_dcourse",
    "step_km",
    "step_km_raw",
    "dt",
    "dt_raw_seconds",
    "dt_log",
    "implied_speed_knots_raw",
    "pos_speed_knots",
    "dpos_speed",
    "pos_bearing_sin",
    "pos_bearing_cos",
    "bearing_error",
    "curvature",
    "pos_speed_ma5",
    "pos_speed_std5",
    "abs_turn_ma5",
    "curvature_ma5",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=None, help="Path to godark_final_compact_h128_ensemble.h5.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="AIS/Kalman trajectory points CSV.")
    parser.add_argument("--scene-metadata", type=Path, default=DEFAULT_SCENE_METADATA, help="Scene metadata CSV for joining scene fields.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output prediction CSV.")
    parser.add_argument("--threshold", type=float, default=None, help="Override decision threshold. Default uses H5 root attr.")
    parser.add_argument("--seq-len", type=int, default=120, help="Model sequence length.")
    parser.add_argument("--min-points", type=int, default=1, help="Minimum points per MMSI group to run.")
    parser.add_argument("--fishing-only", action="store_true", help="Keep only fishing vessels after joining scene metadata.")
    parser.add_argument(
        "--gear-reference-dir",
        type=Path,
        default=DEFAULT_GEAR_REFERENCE_DIR,
        help="Directory containing AIS CSVs with gear_label columns for MMSI lookup.",
    )
    return parser.parse_args()


def choose_model(path: Path | None) -> Path:
    if path is not None:
        if not path.exists():
            raise FileNotFoundError(f"Model not found: {path}")
        return path

    model_dir = Path("KAPAL YG TERDETEKSI")
    candidates = sorted(model_dir.glob("godark_final_compact_h128_ensemble*.h5"))
    healthy = []
    for candidate in candidates:
        try:
            with h5py.File(candidate, "r") as f:
                if f.attrs.get("artifact_type") == "pytorch_godark_ensemble_bundle":
                    healthy.append(candidate)
        except Exception:
            continue
    if not healthy:
        raise FileNotFoundError("No healthy godark_final_compact_h128_ensemble*.h5 found.")
    return healthy[0]


def wrap180(deg: pd.Series) -> pd.Series:
    return ((deg + 180.0) % 360.0) - 180.0


def haversine_km(lat1: pd.Series, lon1: pd.Series, lat2: pd.Series, lon2: pd.Series) -> pd.Series:
    r = 6371.0088
    lat1r = np.radians(lat1.astype(float))
    lat2r = np.radians(lat2.astype(float))
    dlat = np.radians(lat2.astype(float) - lat1.astype(float))
    dlon = np.radians(lon2.astype(float) - lon1.astype(float))
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1r) * np.cos(lat2r) * np.sin(dlon / 2) ** 2
    return pd.Series(2 * r * np.arctan2(np.sqrt(a), np.sqrt(1 - a)), index=lat1.index)


def bearing_deg(lat1: pd.Series, lon1: pd.Series, lat2: pd.Series, lon2: pd.Series) -> pd.Series:
    lat1r = np.radians(lat1.astype(float))
    lat2r = np.radians(lat2.astype(float))
    dlon = np.radians(lon2.astype(float) - lon1.astype(float))
    y = np.sin(dlon) * np.cos(lat2r)
    x = np.cos(lat1r) * np.sin(lat2r) - np.sin(lat1r) * np.cos(lat2r) * np.cos(dlon)
    return pd.Series((np.degrees(np.arctan2(y, x)) + 360) % 360, index=lat1.index)


def first_existing(df: pd.DataFrame, names: list[str]) -> str | None:
    for name in names:
        if name in df.columns:
            return name
    return None


def normalize_mmsi(value) -> str:
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text


def normalize_gear(value: object) -> str:
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return ""
    return text.upper().replace(" ", "_").replace("-", "_")


def prepare_points(input_path: Path) -> pd.DataFrame:
    if not input_path.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_path}")
    df = pd.read_csv(input_path, low_memory=False)
    mmsi_col = first_existing(df, ["MMSI", "mmsi"])
    time_col = first_existing(df, ["timestamp_utc", "timestamp", "kalman_scene_timestamp_utc", "scene_time_utc"])
    lat_col = first_existing(df, ["kalman_lat", "kalman_est_lat", "ais_lat", "AIS_Latitude", "lat"])
    lon_col = first_existing(df, ["kalman_lon", "kalman_est_lon", "ais_lon", "AIS_Longitude", "lon"])
    sog_col = first_existing(df, ["kalman_est_sog", "sog", "Sog", "speed"])
    cog_col = first_existing(df, ["kalman_est_cog", "cog", "Cog", "course"])
    if not all([mmsi_col, time_col, lat_col, lon_col, sog_col, cog_col]):
        missing = {
            "mmsi": mmsi_col,
            "time": time_col,
            "lat": lat_col,
            "lon": lon_col,
            "sog": sog_col,
            "cog": cog_col,
        }
        raise ValueError(f"Input CSV is missing required columns: {missing}")

    out = pd.DataFrame(
        {
            "MMSI": df[mmsi_col].map(normalize_mmsi),
            "timestamp_utc": pd.to_datetime(df[time_col], errors="coerce", utc=True),
            "lat": pd.to_numeric(df[lat_col], errors="coerce"),
            "lon": pd.to_numeric(df[lon_col], errors="coerce"),
            "speed": pd.to_numeric(df[sog_col], errors="coerce"),
            "course": pd.to_numeric(df[cog_col], errors="coerce"),
        }
    )
    for optional in ["scene", "Name", "category"]:
        if optional in df.columns:
            out[optional] = df[optional]
    out = out[out["MMSI"] != ""]
    out = out.dropna(subset=["timestamp_utc", "lat", "lon", "speed", "course"])
    out = out.sort_values(["MMSI", "timestamp_utc"]).reset_index(drop=True)
    return out


def add_features(points: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for _, group in points.groupby("MMSI", sort=False):
        g = group.copy().sort_values("timestamp_utc")
        prev_lat = g["lat"].shift(1).fillna(g["lat"])
        prev_lon = g["lon"].shift(1).fillna(g["lon"])
        prev_speed = g["speed"].shift(1).fillna(g["speed"])
        prev_course = g["course"].shift(1).fillna(g["course"])
        prev_time = g["timestamp_utc"].shift(1)

        dt_seconds = (g["timestamp_utc"] - prev_time).dt.total_seconds().fillna(0).clip(lower=0)
        dt_hours = dt_seconds / 3600.0
        step_km = haversine_km(prev_lat, prev_lon, g["lat"], g["lon"]).fillna(0)
        pos_bearing = bearing_deg(prev_lat, prev_lon, g["lat"], g["lon"]).fillna(g["course"])

        speed = g["speed"].fillna(0)
        course_rad = np.radians(g["course"].fillna(0))
        dspeed = (speed - prev_speed).fillna(0)
        dcourse = wrap180(g["course"] - prev_course).fillna(0)
        safe_dt_hours = dt_hours.where(dt_hours > 0, np.nan)
        pos_speed = (step_km / 1.852 / safe_dt_hours).replace([np.inf, -np.inf], np.nan).fillna(0)
        bearing_error = wrap180(pos_bearing - g["course"]).fillna(0)
        curvature = (wrap180(pos_bearing - pos_bearing.shift(1).fillna(pos_bearing)).abs() / step_km.replace(0, np.nan)).replace(
            [np.inf, -np.inf], np.nan
        ).fillna(0)

        g["vx"] = speed * np.sin(course_rad)
        g["vy"] = speed * np.cos(course_rad)
        g["dspeed"] = dspeed
        g["accel"] = (dspeed / safe_dt_hours).replace([np.inf, -np.inf], np.nan).fillna(0)
        g["dcourse"] = dcourse
        g["turn_rate"] = (dcourse / safe_dt_hours).replace([np.inf, -np.inf], np.nan).fillna(0)
        g["abs_dcourse"] = dcourse.abs()
        g["step_km"] = step_km
        g["step_km_raw"] = step_km
        g["dt"] = dt_hours
        g["dt_raw_seconds"] = dt_seconds
        g["dt_log"] = np.log1p(dt_seconds)
        g["implied_speed_knots_raw"] = pos_speed
        g["pos_speed_knots"] = pos_speed
        g["dpos_speed"] = (pos_speed - pos_speed.shift(1).fillna(pos_speed)).fillna(0)
        g["pos_bearing_sin"] = np.sin(np.radians(pos_bearing))
        g["pos_bearing_cos"] = np.cos(np.radians(pos_bearing))
        g["bearing_error"] = bearing_error
        g["curvature"] = curvature
        g["pos_speed_ma5"] = pos_speed.rolling(5, min_periods=1).mean()
        g["pos_speed_std5"] = pos_speed.rolling(5, min_periods=1).std().fillna(0)
        g["abs_turn_ma5"] = dcourse.abs().rolling(5, min_periods=1).mean()
        g["curvature_ma5"] = curvature.rolling(5, min_periods=1).mean()
        rows.append(g)
    features = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()
    for col in FEATURE_COLS:
        features[col] = pd.to_numeric(features[col], errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0)
    return features


def build_sequence(group: pd.DataFrame, seq_len: int) -> np.ndarray:
    values = group[FEATURE_COLS].to_numpy(dtype=np.float32)
    if len(values) >= seq_len:
        values = values[-seq_len:]
    else:
        pad = np.repeat(values[:1], seq_len - len(values), axis=0) if len(values) else np.zeros((seq_len, len(FEATURE_COLS)), dtype=np.float32)
        values = np.vstack([pad, values])
    return values.astype(np.float32)


class SelfAttentionBlock(nn.Module):
    def __init__(self, dim: int, heads: int, dropout: float):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(dim, heads, dropout=dropout, batch_first=True)
        self.drop = nn.Dropout(dropout)
        self.norm2 = nn.LayerNorm(dim)
        self.ffn = nn.Sequential(
            nn.Linear(dim, dim * 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim * 2, dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.norm1(x)
        attn_out, _ = self.attn(y, y, y, need_weights=False)
        x = x + self.drop(attn_out)
        x = x + self.ffn(self.norm2(x))
        return x


class AttentionPool(nn.Module):
    def __init__(self, dim: int, dropout: float):
        super().__init__()
        self.scorer = nn.Sequential(
            nn.Linear(dim, dim),
            nn.Tanh(),
            nn.Dropout(dropout),
            nn.Linear(dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weights = torch.softmax(self.scorer(x).squeeze(-1), dim=1)
        return torch.sum(x * weights.unsqueeze(-1), dim=1)


class CosineClassifier(nn.Module):
    def __init__(self, num_classes: int, embed_dim: int, scale: float = 30.0):
        super().__init__()
        self.W = nn.Parameter(torch.empty(num_classes, embed_dim))
        self.scale = scale

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.scale * F.linear(F.normalize(x, dim=-1), F.normalize(self.W, dim=-1))


class GoDarkNet(nn.Module):
    def __init__(self, meta: dict):
        super().__init__()
        input_size = int(meta["input_size"])
        hidden = int(meta["hidden_size"])
        input_proj = int(meta["input_proj_dim"])
        embed_dim = int(meta["embed_dim"])
        dropout = float(meta["dropout"])
        heads = int(meta.get("attention_heads", 4))
        layers = int(meta.get("attention_layers", 1))
        self.seq_len = 120
        self.in_proj = nn.Sequential(nn.Linear(input_size, input_proj), nn.GELU(), nn.Dropout(dropout))
        self.lstm = nn.LSTM(
            input_proj,
            hidden,
            num_layers=int(meta["num_layers"]),
            batch_first=True,
            bidirectional=bool(meta["bidirectional"]),
        )
        dim = hidden * (2 if bool(meta["bidirectional"]) else 1)
        self.self_attn = nn.ModuleList([SelfAttentionBlock(dim, heads, dropout) for _ in range(layers)])
        self.attn = AttentionPool(dim, dropout)
        self.context_proj = nn.Sequential(nn.LayerNorm(self.seq_len), nn.Linear(self.seq_len, dim), nn.GELU(), nn.Dropout(dropout))
        self.norm = nn.LayerNorm(dim * 5)
        self.pooled_dropout = nn.Dropout(dropout)
        self.embed = nn.Sequential(nn.Linear(dim * 5, embed_dim), nn.GELU(), nn.Dropout(dropout))
        self.head = CosineClassifier(int(meta["num_classes"]), embed_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.in_proj(x)
        out, _ = self.lstm(x)
        for block in self.self_attn:
            out = block(out)
        last = out[:, -1, :]
        mean = out.mean(dim=1)
        max_pool = out.max(dim=1).values
        attn = self.attn(out)
        context = self.context_proj(out.mean(dim=2))
        pooled = torch.cat([last, mean, max_pool, attn, context], dim=1)
        pooled = self.pooled_dropout(self.norm(pooled))
        emb = self.embed(pooled)
        return self.head(emb)


def load_bundle(model_path: Path):
    models = []
    calibrator = None
    with h5py.File(model_path, "r") as f:
        threshold = float(f.attrs.get("decision_threshold", 0.35))
        for seed in sorted(f["models"].keys()):
            meta_raw = f[f"models/{seed}/checkpoint_metadata_json"][()]
            meta = json.loads(meta_raw.decode("utf-8") if isinstance(meta_raw, bytes) else meta_raw)
            state = {
                key: torch.tensor(f[f"models/{seed}/state_dict/{key}"][()], dtype=torch.float32)
                for key in f[f"models/{seed}/state_dict"].keys()
            }
            scaler = joblib.load(io.BytesIO(bytes(f[f"models/{seed}/scaler_joblib"][:])))
            net = GoDarkNet(meta)
            net.load_state_dict(state, strict=True)
            net.eval()
            models.append({"seed": seed, "meta": meta, "model": net, "scaler": scaler})

        if "ensemble_artifacts/platt_calibrator_joblib" in f:
            try:
                calibrator = joblib.load(io.BytesIO(bytes(f["ensemble_artifacts/platt_calibrator_joblib"][:])))
            except Exception:
                calibrator = None
    return models, calibrator, threshold


def calibrate_probs(probs: np.ndarray, calibrator) -> np.ndarray:
    if not calibrator:
        return probs
    estimator = calibrator.get("estimator") if isinstance(calibrator, dict) else calibrator
    if estimator is None or not hasattr(estimator, "predict_proba"):
        return probs
    eps = 1e-6
    logit_p = np.log(np.clip(probs, eps, 1 - eps) / np.clip(1 - probs, eps, 1 - eps)).reshape(-1, 1)
    try:
        return estimator.predict_proba(logit_p)[:, 1]
    except Exception:
        try:
            return estimator.predict_proba(probs.reshape(-1, 1))[:, 1]
        except Exception:
            return probs


def run_inference(features: pd.DataFrame, models: list[dict], calibrator, seq_len: int, min_points: int) -> pd.DataFrame:
    rows = []
    with torch.no_grad():
        for mmsi, group in features.groupby("MMSI", sort=False):
            if len(group) < min_points:
                continue
            group = group.sort_values("timestamp_utc")
            raw_seq = build_sequence(group, seq_len)
            seed_probs = []
            for item in models:
                scaler = item["scaler"]
                scaled = scaler.transform(raw_seq.reshape(-1, raw_seq.shape[-1])).reshape(1, seq_len, raw_seq.shape[-1]).astype(np.float32)
                logits = item["model"](torch.from_numpy(scaled))
                prob = torch.softmax(logits, dim=1)[0, 1].item()
                seed_probs.append(prob)
            mean_prob = float(np.mean(seed_probs))
            calibrated_prob = float(calibrate_probs(np.array([mean_prob], dtype=float), calibrator)[0])
            last = group.iloc[-1]
            rows.append(
                {
                    "MMSI": mmsi,
                    "Name": last.get("Name", ""),
                    "category": last.get("category", ""),
                    "scene": last.get("scene", ""),
                    "last_timestamp_utc": last["timestamp_utc"].isoformat(),
                    "n_points": len(group),
                    "go_dark_probability_raw_mean": mean_prob,
                    "go_dark_probability_calibrated": calibrated_prob,
                    "seed_probabilities": ";".join(f"{p:.6f}" for p in seed_probs),
                }
            )
    return pd.DataFrame(rows)


def join_scene_metadata(pred: pd.DataFrame, scene_metadata_path: Path) -> pd.DataFrame:
    if pred.empty or not scene_metadata_path.exists():
        return pred
    meta = pd.read_csv(scene_metadata_path, low_memory=False)
    keep = [
        c
        for c in [
            "scene",
            "MMSI",
            "Ship_Type",
            "gfw_shiptype",
            "gfw_geartype",
            "gfw_geartype_source",
            "Elaborated_type",
            "Center_latitude",
            "Center_longitude",
            "AIS_Latitude",
            "AIS_Longitude",
            "AIS_update_time_gap_hours",
            "kalman_est_lat",
            "kalman_est_lon",
            "kalman_pred_residual_m",
            "patch_rgb_vv_actual_file",
            "patch_rgb_vh_actual_file",
        ]
        if c in meta.columns
    ]
    if "scene" not in keep or "MMSI" not in keep:
        return pred
    meta = meta[keep].copy()
    meta["MMSI"] = meta["MMSI"].map(normalize_mmsi)
    pred["MMSI"] = pred["MMSI"].map(normalize_mmsi)
    return pred.merge(meta, on=["scene", "MMSI"], how="left")


def first_nonempty(values: pd.Series) -> str:
    for value in values:
        text = "" if pd.isna(value) else str(value).strip()
        if text and text.lower() not in {"nan", "none", "null"}:
            return text
    return ""


def load_ais_gear_reference(reference_dir: Path) -> pd.DataFrame:
    if not reference_dir.exists():
        return pd.DataFrame()

    frames = []
    for csv_path in sorted(reference_dir.rglob("*.csv")):
        try:
            header = pd.read_csv(csv_path, nrows=0)
        except Exception:
            continue
        mmsi_col = first_existing(header, ["mmsi", "MMSI"])
        gear_col = first_existing(header, ["gear_label", "gear", "gfw_geartype"])
        if not mmsi_col or not gear_col:
            continue

        optional_cols = [c for c in ["gear_raw_gfw", "gear_inferred", "gear_registry", "vessel_name", "dataset_file"] if c in header.columns]
        usecols = [mmsi_col, gear_col, *optional_cols]
        try:
            part = pd.read_csv(csv_path, usecols=usecols, low_memory=False)
        except Exception:
            continue

        part = part.rename(columns={mmsi_col: "MMSI", gear_col: "ais_gear_label"})
        part["MMSI"] = part["MMSI"].map(normalize_mmsi)
        part["ais_gear_label"] = part["ais_gear_label"].map(normalize_gear)
        part = part[(part["MMSI"] != "") & (part["ais_gear_label"] != "")]
        if part.empty:
            continue

        part["ais_gear_source_file"] = str(csv_path)
        frames.append(part)

    if not frames:
        return pd.DataFrame()

    all_gear = pd.concat(frames, ignore_index=True)
    all_gear = all_gear.drop_duplicates()
    count = (
        all_gear.groupby(["MMSI", "ais_gear_label"], dropna=False)
        .size()
        .reset_index(name="ais_gear_observation_count")
        .sort_values(["MMSI", "ais_gear_observation_count", "ais_gear_label"], ascending=[True, False, True])
    )
    chosen = count.drop_duplicates("MMSI", keep="first")

    details = []
    for mmsi, group in all_gear.groupby("MMSI", sort=False):
        source_files = sorted(set(str(v) for v in group["ais_gear_source_file"].dropna()))
        details.append(
            {
                "MMSI": mmsi,
                "ais_gear_source": ";".join(source_files[:5]),
                "ais_gear_raw_gfw": first_nonempty(group["gear_raw_gfw"]) if "gear_raw_gfw" in group else "",
                "ais_gear_inferred": first_nonempty(group["gear_inferred"]) if "gear_inferred" in group else "",
                "ais_gear_registry": first_nonempty(group["gear_registry"]) if "gear_registry" in group else "",
                "ais_vessel_name": first_nonempty(group["vessel_name"]) if "vessel_name" in group else "",
            }
        )
    details_df = pd.DataFrame(details)
    return chosen.merge(details_df, on="MMSI", how="left")


def add_fishing_gear_columns(df: pd.DataFrame, gear_reference: pd.DataFrame | None = None) -> pd.DataFrame:
    if df.empty:
        return df
    out = df.copy()
    for col in ["category", "Ship_Type", "gfw_shiptype", "gfw_geartype", "Elaborated_type"]:
        if col not in out.columns:
            out[col] = ""

    gear = out["gfw_geartype"].fillna("").astype(str).str.strip().str.upper()
    invalid = {"", "NAN", "NONE", "INCONCLUSIVE", "FISHING", "OTHER", "CARGO", "PASSENGER"}
    out["alat_tangkap"] = gear.where(~gear.isin(invalid), "UNKNOWN_FISHING_GEAR")
    out["alat_tangkap_source"] = np.where(out["alat_tangkap"].eq("UNKNOWN_FISHING_GEAR"), "UNKNOWN", "GFW_GEARTYPE")
    out["alat_tangkap_ais_match_status"] = "NO_AIS_GEAR_MATCH"

    if gear_reference is not None and not gear_reference.empty:
        out["MMSI"] = out["MMSI"].map(normalize_mmsi)
        ref = gear_reference.copy()
        ref["MMSI"] = ref["MMSI"].map(normalize_mmsi)
        out = out.merge(ref, on="MMSI", how="left")
        ais_gear = out["ais_gear_label"].fillna("").astype(str).str.strip()
        use_ais = out["alat_tangkap"].eq("UNKNOWN_FISHING_GEAR") & ais_gear.ne("")
        gfw_valid = ~out["alat_tangkap"].eq("UNKNOWN_FISHING_GEAR")
        agrees = gfw_valid & ais_gear.ne("") & out["alat_tangkap"].eq(ais_gear)
        conflicts = gfw_valid & ais_gear.ne("") & ~out["alat_tangkap"].eq(ais_gear)
        out.loc[use_ais, "alat_tangkap"] = ais_gear[use_ais]
        out.loc[use_ais, "alat_tangkap_source"] = "AIS_DATASET_GEAR_LABEL"
        out.loc[use_ais, "alat_tangkap_ais_match_status"] = "FILLED_FROM_AIS"
        out.loc[agrees, "alat_tangkap_source"] = "GFW_GEARTYPE_AND_AIS_DATASET"
        out.loc[agrees, "alat_tangkap_ais_match_status"] = "AIS_AGREES_WITH_GFW"
        out.loc[conflicts, "alat_tangkap_source"] = "GFW_GEARTYPE_AIS_CONFLICT"
        out.loc[conflicts, "alat_tangkap_ais_match_status"] = "AIS_CONFLICTS_WITH_GFW"
    else:
        out["ais_gear_label"] = ""
        out["ais_gear_observation_count"] = ""
        out["ais_gear_source"] = ""
        out["ais_gear_raw_gfw"] = ""
        out["ais_gear_inferred"] = ""
        out["ais_gear_registry"] = ""
        out["ais_vessel_name"] = ""

    out["is_fishing_vessel"] = (
        out["category"].fillna("").astype(str).str.upper().eq("FISHING")
        | out["Ship_Type"].fillna("").astype(str).str.upper().eq("FISHING")
        | out["gfw_shiptype"].fillna("").astype(str).str.upper().eq("FISHING")
        | out["Elaborated_type"].fillna("").astype(str).str.upper().eq("FISHING")
    )
    return out


def main() -> None:
    args = parse_args()
    warnings.filterwarnings("ignore", category=UserWarning)
    model_path = choose_model(args.model)
    models, calibrator, model_threshold = load_bundle(model_path)
    threshold = args.threshold if args.threshold is not None else model_threshold

    points = prepare_points(args.input)
    features = add_features(points)
    pred = run_inference(features, models, calibrator, args.seq_len, args.min_points)
    gear_reference = load_ais_gear_reference(args.gear_reference_dir)
    if not pred.empty:
        pred["threshold"] = threshold
        pred["pred_label"] = np.where(pred["go_dark_probability_calibrated"] >= threshold, "go_dark", "normal")
        pred = join_scene_metadata(pred, args.scene_metadata)
        pred = add_fishing_gear_columns(pred, gear_reference)
        if args.fishing_only:
            pred = pred[pred["is_fishing_vessel"]].copy()
        pred = pred.drop_duplicates(subset=["scene", "MMSI"], keep="first")
        pred = pred.sort_values("go_dark_probability_calibrated", ascending=False)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    pred.to_csv(args.output, index=False)
    print(f"Model: {model_path}")
    print(f"Input rows: {len(points)}")
    print(f"AIS gear reference MMSI: {0 if gear_reference.empty else gear_reference['MMSI'].nunique()}")
    print(f"Predicted MMSI groups: {len(pred)}")
    if not pred.empty:
        print(pred["pred_label"].value_counts().to_string())
    print(f"Output: {args.output}")
    print("")
    print("NOTE: If your input CSV has only 1-5 points per MMSI, this is a technical run of the model,")
    print("not a strong scientific inference. The model was trained for 120-step trajectory windows.")


if __name__ == "__main__":
    main()
