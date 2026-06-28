#!/usr/bin/env python3
"""
Run alert inference from FINAL_4_PIPELINE_MODELS.h5 in the H5 copy workspace.

The script is deliberately conservative:
- it reads model feature metadata from the H5 checkpoint artifacts;
- it runs only pipelines whose required features can be formed from local data;
- it writes separate H5 experiment outputs and never overwrites rule-based files.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import warnings
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import h5py
import joblib
import numpy as np
import pandas as pd
import torch
from torch import nn
import torch.nn.functional as F


DEFAULT_MODEL = Path("KAPAL YG TERDETEKSI/FINAL_4_PIPELINE_MODELS.h5")
DEFAULT_TRAJECTORY_INPUT = Path("new/metadata/ais_trajectory_points_kalman.csv")
DEFAULT_SCENE_INPUTS = [
    Path("new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv"),
    Path("new/metadata/metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled_kalman_estimated.csv"),
]
DEFAULT_OUTPUT = Path("KAPAL YG TERDETEKSI/final_h5_alert_predictions.csv")
DEFAULT_REPORT = Path("KAPAL YG TERDETEKSI/h5_inference_report.json")
DEFAULT_MISSING_FEATURES = Path("KAPAL YG TERDETEKSI/h5_missing_features_report.csv")

ALERT_PIPELINES = ["godark", "spoofing", "transshipment"]
ALERT_LABELS = {
    "godark": "go_dark",
    "spoofing": "spoofing",
    "transshipment": "transshipment",
}
POSITIVE_LABELS = {
    "godark": {"go_dark", "godark"},
    "spoofing": {"spoofing"},
    "transshipment": {"potential_transshipment", "transshipment"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="FINAL_4_PIPELINE_MODELS.h5 path.")
    parser.add_argument("--trajectory-input", type=Path, default=DEFAULT_TRAJECTORY_INPUT, help="AIS/Kalman trajectory point CSV.")
    parser.add_argument("--scene-input", type=Path, default=None, help="AIS-SAR final scene metadata CSV.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="H5 alert prediction CSV output.")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="H5 inference report JSON output.")
    parser.add_argument(
        "--missing-features-output",
        type=Path,
        default=DEFAULT_MISSING_FEATURES,
        help="Missing feature report CSV output.",
    )
    parser.add_argument("--min-points", type=int, default=1, help="Minimum trajectory points required per scene inference.")
    return parser.parse_args()


def choose_scene_input(path: Path | None) -> Path:
    if path is not None:
        if not path.exists():
            raise FileNotFoundError(f"Scene input CSV not found: {path}")
        return path
    for candidate in DEFAULT_SCENE_INPUTS:
        if candidate.exists():
            return candidate
    searched = ", ".join(str(p) for p in DEFAULT_SCENE_INPUTS)
    raise FileNotFoundError(f"No default scene input found. Searched: {searched}")


def normalize_mmsi(value: object) -> str:
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text


def first_existing(df: pd.DataFrame, names: list[str]) -> str | None:
    for name in names:
        if name in df.columns:
            return name
    return None


def to_num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


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


def scene_time_from_scene(scene: object) -> str:
    match = re.search(r"_(\d{8}T\d{6})_", str(scene))
    if not match:
        return ""
    raw = match.group(1)
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}T{raw[9:11]}:{raw[11:13]}:{raw[13:15]}Z"


def dataset_bytes(dataset: h5py.Dataset) -> bytes:
    raw = dataset[()]
    if isinstance(raw, bytes):
        return raw
    return bytes(raw)


def read_json_dataset(h5: h5py.File, path: str) -> Any:
    raw = dataset_bytes(h5[path])
    return json.loads(raw.decode("utf-8-sig", errors="replace"))


def read_joblib_dataset(h5: h5py.File, path: str) -> Any:
    return joblib.load(io.BytesIO(dataset_bytes(h5[path])))


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        if np.isnan(value):
            return None
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


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


class SequenceClassifier(nn.Module):
    def __init__(self, meta: dict[str, Any], seq_len: int, context_summary: bool):
        super().__init__()
        input_size = int(meta["input_size"])
        hidden = int(meta["hidden_size"])
        input_proj = int(meta["input_proj_dim"])
        embed_dim = int(meta["embed_dim"])
        dropout = float(meta["dropout"])
        heads = int(meta.get("attention_heads", 4))
        layers = int(meta.get("attention_layers", 1))
        self.context_summary = bool(context_summary)
        self.seq_len = int(seq_len)

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

        pooled_parts = 4
        if self.context_summary:
            self.context_proj = nn.Sequential(nn.LayerNorm(self.seq_len), nn.Linear(self.seq_len, dim))
            pooled_parts = 5

        self.norm = nn.LayerNorm(dim * pooled_parts)
        self.pooled_dropout = nn.Dropout(dropout)
        self.embed = nn.Sequential(nn.Linear(dim * pooled_parts, embed_dim), nn.GELU(), nn.Dropout(dropout))
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
        parts = [last, mean, max_pool, attn]
        if self.context_summary:
            parts.append(self.context_proj(out.mean(dim=2)))
        pooled = torch.cat(parts, dim=1)
        pooled = self.pooled_dropout(self.norm(pooled))
        emb = self.embed(pooled)
        return self.head(emb)


def prepare_points(input_path: Path) -> pd.DataFrame:
    if not input_path.exists():
        raise FileNotFoundError(f"Trajectory input CSV not found: {input_path}")
    df = pd.read_csv(input_path, low_memory=False)
    mmsi_col = first_existing(df, ["MMSI", "mmsi"])
    time_col = first_existing(df, ["timestamp_utc", "timestamp", "kalman_scene_timestamp_utc", "scene_time_utc"])
    lat_col = first_existing(df, ["kalman_lat", "kalman_est_lat", "ais_lat", "AIS_Latitude", "lat"])
    lon_col = first_existing(df, ["kalman_lon", "kalman_est_lon", "ais_lon", "AIS_Longitude", "lon"])
    sog_col = first_existing(df, ["kalman_est_sog", "sog", "Sog", "speed"])
    cog_col = first_existing(df, ["kalman_est_cog", "cog", "Cog", "course"])
    if not all([mmsi_col, time_col, lat_col, lon_col, sog_col, cog_col]):
        found = {
            "mmsi": mmsi_col,
            "time": time_col,
            "lat": lat_col,
            "lon": lon_col,
            "sog": sog_col,
            "cog": cog_col,
        }
        raise ValueError(f"Trajectory CSV is missing required columns: {found}")

    out = pd.DataFrame(
        {
            "MMSI": df[mmsi_col].map(normalize_mmsi),
            "timestamp_utc": pd.to_datetime(df[time_col], errors="coerce", utc=True),
            "lat": to_num(df[lat_col]),
            "lon": to_num(df[lon_col]),
            "speed": to_num(df[sog_col]),
            "course": to_num(df[cog_col]),
        }
    )
    for optional in ["scene", "Name", "category"]:
        if optional in df.columns:
            out[optional] = df[optional]
    out = out[(out["MMSI"] != "") & out["timestamp_utc"].notna()]
    out = out.dropna(subset=["lat", "lon", "speed", "course"])
    out = out.sort_values(["MMSI", "timestamp_utc"]).reset_index(drop=True)
    return out


def add_motion_features(points: pd.DataFrame) -> pd.DataFrame:
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
        curvature = (
            wrap180(pos_bearing - pos_bearing.shift(1).fillna(pos_bearing)).abs() / step_km.replace(0, np.nan)
        ).replace([np.inf, -np.inf], np.nan).fillna(0)

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

    if not rows:
        return pd.DataFrame()
    features = pd.concat(rows, ignore_index=True)
    numeric_cols = [c for c in features.columns if c not in {"MMSI", "timestamp_utc", "scene", "Name", "category"}]
    for col in numeric_cols:
        features[col] = to_num(features[col]).replace([np.inf, -np.inf], np.nan).fillna(0)
    return features


def prepare_scenes(scene_path: Path) -> pd.DataFrame:
    df = pd.read_csv(scene_path, low_memory=False)
    mmsi_col = first_existing(df, ["MMSI", "mmsi"])
    if not mmsi_col:
        raise ValueError(f"Scene CSV has no MMSI column: {scene_path}")
    if "scene" not in df.columns:
        raise ValueError(f"Scene CSV has no scene column: {scene_path}")

    out = df.copy()
    out["MMSI_norm"] = out[mmsi_col].map(normalize_mmsi)
    out["scene_id"] = out["scene"].fillna("").astype(str)
    scene_time = pd.Series(pd.NaT, index=out.index, dtype="datetime64[ns, UTC]")
    for col in ["kalman_scene_timestamp_utc", "sog_cog_scene_timestamp_utc", "ais_position_scene_timestamp_utc", "scene_time_utc"]:
        if col in out.columns:
            parsed = pd.to_datetime(out[col], errors="coerce", utc=True)
            scene_time = scene_time.fillna(parsed)
    from_scene_name = pd.to_datetime(out["scene_id"].map(scene_time_from_scene), errors="coerce", utc=True)
    out["scene_time_utc"] = scene_time.fillna(from_scene_name)
    return out


def load_checkpoint_from_h5(h5: h5py.File, model_path: str) -> dict[str, Any]:
    checkpoint = torch.load(io.BytesIO(dataset_bytes(h5[model_path])), map_location="cpu", weights_only=False)
    if not isinstance(checkpoint, dict):
        raise TypeError(f"Unsupported checkpoint object in {model_path}: {type(checkpoint).__name__}")
    if "model_state" not in checkpoint:
        raise KeyError(f"Checkpoint has no model_state: {model_path}")
    return checkpoint


def infer_seq_len_and_context(state: dict[str, torch.Tensor], meta: dict[str, Any]) -> tuple[int, bool]:
    if "context_proj.0.weight" in state:
        return int(state["context_proj.0.weight"].shape[0]), True
    return int(meta.get("seq_len", 120)), False


def normalize_label_map(label_map: dict[Any, Any]) -> dict[int, str]:
    out: dict[int, str] = {}
    for key, value in label_map.items():
        try:
            out[int(key)] = str(value)
        except Exception:
            continue
    return out


def positive_class_index(label_map: dict[int, str], pipeline: str) -> int:
    positives = POSITIVE_LABELS[pipeline]
    for idx, label in label_map.items():
        if label.strip().lower() in positives:
            return int(idx)
    raise ValueError(f"No positive label found for {pipeline}: {label_map}")


def checkpoint_metadata(checkpoint: dict[str, Any]) -> dict[str, Any]:
    skip = {"model_state", "optimizer_state", "scheduler_state"}
    return {k: v for k, v in checkpoint.items() if k not in skip}


def load_member(h5: h5py.File, pipeline: str, model_path: str, scaler_path: str, member_id: str) -> dict[str, Any]:
    checkpoint = load_checkpoint_from_h5(h5, model_path)
    state = checkpoint["model_state"]
    meta = checkpoint_metadata(checkpoint)
    label_map = normalize_label_map(meta.get("label_map", {}))
    seq_len, context_summary = infer_seq_len_and_context(state, meta)
    model = SequenceClassifier(meta, seq_len=seq_len, context_summary=context_summary)
    model.load_state_dict(state, strict=True)
    model.eval()
    scaler = read_joblib_dataset(h5, scaler_path)
    return {
        "pipeline": pipeline,
        "member_id": member_id,
        "model": model,
        "scaler": scaler,
        "meta": meta,
        "label_map": label_map,
        "positive_index": positive_class_index(label_map, pipeline),
        "seq_len": seq_len,
        "context_summary": context_summary,
    }


def threshold_from_h5(h5: h5py.File, pipeline: str) -> float | None:
    paths = {
        "godark": "pipelines/godark/files/godark/GODARK_MODEL_LOCK.json",
        "spoofing": "pipelines/spoofing/files/spoofing/SPOOFING_MODEL_LOCK.json",
        "transshipment": "pipelines/transshipment/files/transshipment/TRANSSHIPMENT_MODEL_LOCK.json",
    }
    path = paths.get(pipeline)
    if not path or path not in h5:
        return None
    data = read_json_dataset(h5, path)
    for key in ["decision_threshold", "threshold"]:
        if key in data:
            return float(data[key])
    return None


def load_runtime(h5: h5py.File, pipeline: str) -> dict[str, Any]:
    runtime: dict[str, Any] = {"pipeline": pipeline, "members": [], "calibrator": None, "calibration_policy": None}
    if pipeline == "godark":
        base = "pipelines/godark/files/godark/model/ensemble"
        for seed in sorted(h5[base].keys()):
            runtime["members"].append(
                load_member(
                    h5,
                    pipeline,
                    f"{base}/{seed}/model.pt",
                    f"{base}/{seed}/scaler.joblib",
                    seed,
                )
            )
        calibrator_path = "pipelines/godark/files/godark/model/compact_h128_platt.joblib"
        if calibrator_path in h5:
            runtime["calibrator"] = read_joblib_dataset(h5, calibrator_path)
    elif pipeline == "spoofing":
        base = "pipelines/spoofing/files/spoofing/source_model_files"
        for seed in sorted(h5[base].keys()):
            model_dir = f"{base}/{seed}/model_spoofing"
            if f"{model_dir}/model.pt" in h5:
                runtime["members"].append(
                    load_member(
                        h5,
                        pipeline,
                        f"{model_dir}/model.pt",
                        f"{model_dir}/scaler.joblib",
                        seed,
                    )
                )
        policy_path = "pipelines/spoofing/files/spoofing/validation/platt_scenario_policy.json"
        if policy_path in h5:
            runtime["calibration_policy"] = read_json_dataset(h5, policy_path)
    elif pipeline == "transshipment":
        base = "pipelines/transshipment/files/transshipment/model/ensemble"
        calibrators: dict[str, Any] = {}
        for seed in sorted(h5[base].keys()):
            calibrator_path = f"pipelines/transshipment/files/transshipment/model/calibrators/syn125_{seed}_platt.joblib"
            if calibrator_path in h5:
                calibrators[seed] = read_joblib_dataset(h5, calibrator_path)
            for fold in sorted(h5[f"{base}/{seed}"].keys()):
                fold_dir = f"{base}/{seed}/{fold}"
                runtime["members"].append(
                    load_member(
                        h5,
                        pipeline,
                        f"{fold_dir}/model.pt",
                        f"{fold_dir}/scaler.joblib",
                        f"{seed}/{fold}",
                    )
                )
        runtime["calibrator"] = calibrators
    else:
        raise ValueError(f"Unsupported runtime pipeline: {pipeline}")
    return runtime


def extract_first_checkpoint_info(h5: h5py.File, pipeline: str) -> dict[str, Any]:
    paths = {
        "godark": "pipelines/godark/files/godark/model/ensemble/seed_42/model.pt",
        "spoofing": "pipelines/spoofing/files/spoofing/source_model_files/seed_42/model_spoofing/model.pt",
        "transshipment": "pipelines/transshipment/files/transshipment/model/ensemble/seed_42/fold_0/model.pt",
        "gear": "pipelines/gear/files/gear/model/ensemble/seed_42/model.pt",
    }
    path = paths[pipeline]
    info: dict[str, Any] = {"checkpoint_path": path, "available": path in h5}
    if path not in h5:
        return info
    checkpoint = load_checkpoint_from_h5(h5, path)
    meta = checkpoint_metadata(checkpoint)
    state = checkpoint["model_state"]
    seq_len, context_summary = infer_seq_len_and_context(state, meta)
    info.update(
        {
            "task": meta.get("task"),
            "input_size": meta.get("input_size"),
            "num_classes": meta.get("num_classes"),
            "label_map": normalize_label_map(meta.get("label_map", {})),
            "feature_cols": meta.get("feature_cols", []),
            "primary_metric_scope": meta.get("primary_metric_scope"),
            "hidden_size": meta.get("hidden_size"),
            "num_layers": meta.get("num_layers"),
            "input_proj_dim": meta.get("input_proj_dim"),
            "embed_dim": meta.get("embed_dim"),
            "dropout": meta.get("dropout"),
            "bidirectional": meta.get("bidirectional"),
            "attention_heads": meta.get("attention_heads"),
            "attention_layers": meta.get("attention_layers"),
            "context_summary": context_summary,
            "seq_len": seq_len,
            "model_state_keys": len(state),
        }
    )
    return info


def inspect_h5_model(h5: h5py.File) -> dict[str, Any]:
    summary = read_json_dataset(h5, "SUMMARY_JSON") if "SUMMARY_JSON" in h5 else {}
    manifest = read_json_dataset(h5, "MANIFEST_JSON") if "MANIFEST_JSON" in h5 else []
    file_counts = Counter(item.get("pipeline", "unknown") for item in manifest if isinstance(item, dict))
    payload_bytes = defaultdict(int)
    for item in manifest:
        if isinstance(item, dict):
            payload_bytes[item.get("pipeline", "unknown")] += int(item.get("size_bytes", 0))

    pipelines: dict[str, Any] = {}
    for pipeline in ["gear", *ALERT_PIPELINES]:
        try:
            pipelines[pipeline] = extract_first_checkpoint_info(h5, pipeline)
        except Exception as exc:
            pipelines[pipeline] = {"available": False, "error": str(exc)}
        pipelines[pipeline]["threshold"] = threshold_from_h5(h5, pipeline)
        pipelines[pipeline]["artifact_file_count"] = int(file_counts.get(pipeline, 0))
        pipelines[pipeline]["artifact_payload_bytes"] = int(payload_bytes.get(pipeline, 0))

    return {
        "root_attrs": {k: json_safe(v) for k, v in h5.attrs.items()},
        "summary": summary,
        "manifest_file_count": len(manifest),
        "pipelines": pipelines,
    }


def constructible_transshipment_features(scene_df: pd.DataFrame) -> set[str]:
    cols = set(scene_df.columns)
    out: set[str] = set()
    if {"Center_latitude", "Center_longitude"}.issubset(cols):
        out.update({"distance_between_km", "lat_mid", "lon_mid", "valid_point"})
    if "Sog" in cols:
        out.update({"speed_a", "speed_b", "speed_pair_mean", "relative_speed_knots", "both_slow"})
    if "Cog" in cols:
        out.update({"course_diff_deg", "same_direction_score"})
    if {"category", "Ship_Type", "gfw_shiptype", "Elaborated_type"} & cols:
        out.update({"is_fishing_a", "is_fishing_b"})
    return out


def feature_availability_report(
    h5_info: dict[str, Any],
    motion_features: pd.DataFrame,
    scene_df: pd.DataFrame,
) -> tuple[dict[str, Any], pd.DataFrame]:
    motion_available = set(motion_features.columns)
    transshipment_available = constructible_transshipment_features(scene_df)
    rows = []
    status: dict[str, Any] = {}

    for pipeline in ALERT_PIPELINES:
        info = h5_info["pipelines"].get(pipeline, {})
        required = list(info.get("feature_cols") or [])
        if pipeline in {"godark", "spoofing"}:
            available = sorted(set(required) & motion_available)
            all_available = sorted(motion_available)
            notes = "Trajectory features are formed from AIS/Kalman points."
        else:
            available = sorted(set(required) & transshipment_available)
            all_available = sorted(transshipment_available)
            notes = "Only same-scene pair features can be derived; trained event/loitering/shore/port features are not present."

        missing = [feature for feature in required if feature not in set(available)]
        can_run = bool(required) and not missing and bool(info.get("available", False))
        if pipeline == "transshipment" and can_run:
            notes = "All required transshipment features are constructible."
        if not required:
            notes = "Checkpoint did not expose feature_cols metadata."

        status[pipeline] = {
            "required_features": required,
            "available_features": available,
            "available_feature_pool": all_available,
            "missing_features": missing,
            "can_run": can_run,
            "status": "ready" if can_run else "missing_features",
            "notes": notes,
        }
        rows.append(
            {
                "pipeline": pipeline,
                "required_features": ";".join(required),
                "available_features": ";".join(available),
                "missing_features": ";".join(missing),
                "can_run": str(can_run),
                "notes": notes,
            }
        )

    return status, pd.DataFrame(rows)


def build_sequence(group: pd.DataFrame, feature_cols: list[str], seq_len: int) -> np.ndarray:
    values = group[feature_cols].to_numpy(dtype=np.float32)
    if len(values) >= seq_len:
        values = values[-seq_len:]
    elif len(values):
        pad = np.repeat(values[:1], seq_len - len(values), axis=0)
        values = np.vstack([pad, values])
    else:
        values = np.zeros((seq_len, len(feature_cols)), dtype=np.float32)
    return values.astype(np.float32)


def calibrate_sklearn_probability(prob: float, calibrator: Any) -> float:
    if not calibrator:
        return float(prob)
    estimator = calibrator.get("estimator") if isinstance(calibrator, dict) else calibrator
    if estimator is None or not hasattr(estimator, "predict_proba"):
        return float(prob)
    eps = 1e-6
    logit_p = np.log(np.clip(prob, eps, 1 - eps) / np.clip(1 - prob, eps, 1 - eps)).reshape(1, 1)
    try:
        return float(estimator.predict_proba(logit_p)[0, 1])
    except Exception:
        return float(estimator.predict_proba(np.array([[prob]], dtype=float))[0, 1])


def calibrate_spoofing_probability(prob: float, policy: dict[str, Any] | None) -> float:
    if not policy:
        return float(prob)
    if "platt_coefficient" not in policy or "platt_intercept" not in policy:
        return float(prob)
    eps = 1e-6
    logit_p = math.log(max(eps, min(1 - eps, prob)) / max(eps, min(1 - eps, 1 - prob)))
    z = float(policy["platt_coefficient"]) * logit_p + float(policy["platt_intercept"])
    return float(1.0 / (1.0 + math.exp(-z)))


def raw_member_probability(member: dict[str, Any], group: pd.DataFrame, feature_cols: list[str]) -> float:
    seq = build_sequence(group, feature_cols, int(member["seq_len"]))
    scaler = member["scaler"]
    scaled = scaler.transform(seq.reshape(-1, seq.shape[-1])).reshape(1, seq.shape[0], seq.shape[-1]).astype(np.float32)
    with torch.no_grad():
        logits = member["model"](torch.from_numpy(scaled))
        probs = torch.softmax(logits, dim=1)
    return float(probs[0, int(member["positive_index"])].item())


def run_sequence_pipeline(
    pipeline: str,
    runtime: dict[str, Any],
    group: pd.DataFrame,
    feature_cols: list[str],
) -> tuple[float, list[float]]:
    raw_probs = [raw_member_probability(member, group, feature_cols) for member in runtime["members"]]
    if not raw_probs:
        return math.nan, []

    if pipeline == "transshipment" and isinstance(runtime.get("calibrator"), dict):
        calibrated = []
        for member, prob in zip(runtime["members"], raw_probs):
            seed = str(member["member_id"]).split("/")[0]
            calibrator = runtime["calibrator"].get(seed)
            calibrated.append(calibrate_sklearn_probability(prob, calibrator))
        return float(np.mean(calibrated)), raw_probs

    mean_raw = float(np.mean(raw_probs))
    if pipeline == "godark":
        return calibrate_sklearn_probability(mean_raw, runtime.get("calibrator")), raw_probs
    if pipeline == "spoofing":
        return calibrate_spoofing_probability(mean_raw, runtime.get("calibration_policy")), raw_probs
    return mean_raw, raw_probs


def group_for_scene(features_by_mmsi: dict[str, pd.DataFrame], mmsi: str, scene_id: str, scene_time: Any) -> pd.DataFrame:
    group = features_by_mmsi.get(mmsi)
    if group is None or group.empty:
        return pd.DataFrame()
    if "scene" in group.columns:
        same_scene = group[group["scene"].fillna("").astype(str).eq(str(scene_id))]
        if not same_scene.empty:
            cutoff = same_scene["timestamp_utc"].max()
            return group[group["timestamp_utc"] <= cutoff].copy()
    if pd.notna(scene_time):
        before = group[group["timestamp_utc"] <= scene_time]
        if not before.empty:
            return before.copy()
    return pd.DataFrame()


def choose_alert(row: dict[str, Any], pipeline_status: dict[str, Any], thresholds: dict[str, float | None]) -> tuple[str, str, float | None]:
    candidates = []
    for pipeline in ALERT_PIPELINES:
        status = pipeline_status.get(pipeline, {})
        if not status.get("ran"):
            continue
        prob = row.get(f"{ALERT_LABELS[pipeline]}_probability")
        threshold = thresholds.get(pipeline)
        if prob is None or pd.isna(prob) or threshold is None:
            continue
        if float(prob) >= float(threshold):
            candidates.append((ALERT_LABELS[pipeline], float(prob)))

    if candidates:
        label, score = max(candidates, key=lambda item: item[1])
        return label, label, score

    available_scores = []
    for pipeline in ALERT_PIPELINES:
        prob = row.get(f"{ALERT_LABELS[pipeline]}_probability")
        if prob is not None and not pd.isna(prob):
            available_scores.append(float(prob))
    if available_scores:
        return "normal", "normal", max(available_scores)
    return "not_available", "not_available", None


def run_predictions(
    scenes: pd.DataFrame,
    features: pd.DataFrame,
    runtimes: dict[str, dict[str, Any]],
    h5_info: dict[str, Any],
    feature_status: dict[str, Any],
    min_points: int,
    scene_input: Path,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    features_by_mmsi = {mmsi: group.sort_values("timestamp_utc").copy() for mmsi, group in features.groupby("MMSI", sort=False)}
    thresholds = {pipeline: h5_info["pipelines"].get(pipeline, {}).get("threshold") for pipeline in ALERT_PIPELINES}
    pipeline_status = {
        pipeline: {
            "ran": pipeline in runtimes,
            "can_run": feature_status.get(pipeline, {}).get("can_run", False),
            "missing_features": feature_status.get(pipeline, {}).get("missing_features", []),
            "threshold": thresholds.get(pipeline),
        }
        for pipeline in ALERT_PIPELINES
    }
    rows = []

    for _, scene_row in scenes.iterrows():
        mmsi = normalize_mmsi(scene_row.get("MMSI_norm", ""))
        scene_id = str(scene_row.get("scene_id", ""))
        scene_time = scene_row.get("scene_time_utc")
        seq_group = group_for_scene(features_by_mmsi, mmsi, scene_id, scene_time)

        out: dict[str, Any] = {
            "MMSI": mmsi,
            "scene_id": scene_id,
            "go_dark_probability": math.nan,
            "spoofing_probability": math.nan,
            "transshipment_probability": math.nan,
            "pred_label": "not_available",
            "alert_type": "not_available",
            "score": math.nan,
            "evidence": "",
            "n_trajectory_points_used": int(len(seq_group)),
            "scene_time_utc": scene_time.isoformat() if pd.notna(scene_time) else "",
            "source_scene_file": str(scene_input),
        }

        evidence = []
        if seq_group.empty or len(seq_group) < min_points:
            evidence.append("No usable AIS/Kalman trajectory sequence for this MMSI+scene.")
        else:
            for pipeline, runtime in runtimes.items():
                feature_cols = list(h5_info["pipelines"][pipeline].get("feature_cols") or [])
                prob, raw_probs = run_sequence_pipeline(pipeline, runtime, seq_group, feature_cols)
                alert_label = ALERT_LABELS[pipeline]
                out[f"{alert_label}_probability"] = prob
                threshold = thresholds.get(pipeline)
                seq_lens = sorted({int(member["seq_len"]) for member in runtime["members"]})
                evidence.append(
                    f"{pipeline} H5 probability={prob:.6f}; threshold={threshold}; "
                    f"members={len(runtime['members'])}; seq_len={','.join(map(str, seq_lens))}; "
                    f"points={len(seq_group)}; raw_member_mean={np.mean(raw_probs):.6f}"
                )

        for pipeline in ALERT_PIPELINES:
            if pipeline not in runtimes:
                missing = feature_status.get(pipeline, {}).get("missing_features", [])
                if missing:
                    evidence.append(f"{pipeline} not run: missing features {', '.join(missing)}.")
                else:
                    evidence.append(f"{pipeline} not run.")

        pred_label, alert_type, score = choose_alert(out, pipeline_status, thresholds)
        out["pred_label"] = pred_label
        out["alert_type"] = alert_type
        out["score"] = score if score is not None else math.nan
        out["evidence"] = " | ".join(evidence)
        rows.append(out)

    predictions = pd.DataFrame(rows)
    run_summary = {
        "total_scene_rows": int(len(scenes)),
        "prediction_rows": int(len(predictions)),
        "alert_counts": predictions["alert_type"].value_counts(dropna=False).to_dict() if not predictions.empty else {},
        "pipeline_status": pipeline_status,
    }
    return predictions, run_summary


def main() -> None:
    args = parse_args()
    warnings.filterwarnings("ignore", category=UserWarning)
    if not args.model.exists():
        raise FileNotFoundError(f"H5 model file not found: {args.model}")

    scene_input = choose_scene_input(args.scene_input)
    points = prepare_points(args.trajectory_input)
    motion_features = add_motion_features(points)
    scenes = prepare_scenes(scene_input)

    report: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "workspace_note": "H5 experiment outputs only; rule-based CSV/dashboard files are not modified.",
        "inputs": {
            "model": str(args.model),
            "trajectory_input": str(args.trajectory_input),
            "scene_input": str(scene_input),
        },
        "outputs": {
            "predictions": str(args.output),
            "report": str(args.report),
            "missing_features": str(args.missing_features_output),
        },
        "input_rows": {
            "trajectory_points": int(len(points)),
            "motion_feature_rows": int(len(motion_features)),
            "scene_rows": int(len(scenes)),
        },
        "warnings": [
            "Most local AIS/Kalman sequences have fewer than the 120+ points used by some trained models; padded inference is a technical integration test.",
        ],
    }

    with h5py.File(args.model, "r") as h5:
        h5_info = inspect_h5_model(h5)
        feature_status, missing_df = feature_availability_report(h5_info, motion_features, scenes)
        report["h5"] = h5_info
        report["feature_status"] = feature_status

        runtimes: dict[str, dict[str, Any]] = {}
        for pipeline in ALERT_PIPELINES:
            if not feature_status[pipeline]["can_run"]:
                continue
            try:
                runtimes[pipeline] = load_runtime(h5, pipeline)
                report["feature_status"][pipeline]["status"] = "ran"
                report["feature_status"][pipeline]["loaded_members"] = len(runtimes[pipeline]["members"])
            except Exception as exc:
                report["feature_status"][pipeline]["status"] = "load_failed"
                report["feature_status"][pipeline]["load_error"] = str(exc)

        predictions, run_summary = run_predictions(
            scenes=scenes,
            features=motion_features,
            runtimes=runtimes,
            h5_info=h5_info,
            feature_status=feature_status,
            min_points=args.min_points,
            scene_input=scene_input,
        )
        report["run_summary"] = run_summary

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.missing_features_output.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(args.output, index=False)
    missing_df.to_csv(args.missing_features_output, index=False)
    args.report.write_text(json.dumps(json_safe(report), indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"H5 model: {args.model}")
    print(f"Scene input: {scene_input}")
    print(f"Trajectory points: {len(points)}")
    print(f"Prediction rows: {len(predictions)}")
    print("Pipeline status:")
    for pipeline in ALERT_PIPELINES:
        status = report["feature_status"][pipeline]["status"]
        missing = report["feature_status"][pipeline].get("missing_features", [])
        suffix = f" missing={len(missing)}" if missing else ""
        print(f"  {pipeline}: {status}{suffix}")
    if not predictions.empty:
        print("Alert counts:")
        print(predictions["alert_type"].value_counts(dropna=False).to_string())
    print(f"Predictions CSV: {args.output}")
    print(f"Missing feature CSV: {args.missing_features_output}")
    print(f"Report JSON: {args.report}")


if __name__ == "__main__":
    main()
