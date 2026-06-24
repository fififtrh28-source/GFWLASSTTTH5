#!/usr/bin/env python3
"""
Find scene candidates for go-dark, spoofing, and transshipment review.

This script is intentionally rule-based. The workspace currently has a go-dark
model bundle, but no local spoofing/transshipment model bundle, so these outputs
are triage candidates rather than final labels.
"""

from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

import pandas as pd


DEFAULT_INPUTS = [
    Path("new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv"),
    Path("new/metadata/metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled_kalman_estimated.csv"),
]

DEFAULT_OUTPUT = Path("KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=None, help="Metadata CSV with scene/MMSI/Kalman columns.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output CSV path.")
    parser.add_argument("--summary", type=Path, default=None, help="Optional text summary path.")
    parser.add_argument("--godark-gap-hours", type=float, default=24.0, help="Minimum AIS update gap for go-dark candidate.")
    parser.add_argument("--spoof-close-hours", type=float, default=2.0, help="Time-gap limit for close-time spoofing rule.")
    parser.add_argument("--spoof-distance-km", type=float, default=5.0, help="Minimum SAR-AIS distance for close-time spoofing rule.")
    parser.add_argument("--spoof-wide-hours", type=float, default=6.0, help="Time-gap limit for wide-distance spoofing rule.")
    parser.add_argument("--spoof-wide-distance-km", type=float, default=20.0, help="Minimum SAR-AIS distance for wide spoofing rule.")
    parser.add_argument("--kalman-residual-m", type=float, default=10_000.0, help="Minimum Kalman residual for spoofing rule.")
    parser.add_argument("--transship-distance-km", type=float, default=2.0, help="Maximum same-scene vessel distance for transshipment candidate.")
    parser.add_argument("--transship-slow-knots", type=float, default=3.0, help="Maximum SOG for slow pair transshipment evidence.")
    return parser.parse_args()


def choose_input(path: Path | None) -> Path:
    if path is not None:
        if not path.exists():
            raise FileNotFoundError(f"Input CSV not found: {path}")
        return path
    for candidate in DEFAULT_INPUTS:
        if candidate.exists():
            return candidate
    searched = ", ".join(str(p) for p in DEFAULT_INPUTS)
    raise FileNotFoundError(f"No default input found. Searched: {searched}")


def to_num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def first_existing(df: pd.DataFrame, names: list[str]) -> str | None:
    for name in names:
        if name in df.columns:
            return name
    return None


def haversine_km(lat1, lon1, lat2, lon2) -> pd.Series:
    lat1 = to_num(lat1)
    lon1 = to_num(lon1)
    lat2 = to_num(lat2)
    lon2 = to_num(lon2)

    r = 6371.0088
    p1 = lat1.map(math.radians)
    p2 = lat2.map(math.radians)
    dlat = (lat2 - lat1).map(math.radians)
    dlon = (lon2 - lon1).map(math.radians)
    a = (dlat / 2).map(math.sin) ** 2 + p1.map(math.cos) * p2.map(math.cos) * (dlon / 2).map(math.sin) ** 2
    return 2 * r * a.map(lambda x: math.atan2(math.sqrt(x), math.sqrt(1 - x)) if pd.notna(x) else math.nan)


def scene_time(scene: object) -> str:
    match = re.search(r"_(\d{8}T\d{6})_", str(scene))
    if not match:
        return ""
    raw = match.group(1)
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}T{raw[9:11]}:{raw[11:13]}:{raw[13:15]}Z"


def ship_text(row: pd.Series) -> str:
    parts = []
    for col in ("Ship_Type", "gfw_shiptype", "category", "Name", "gfw_name"):
        value = row.get(col)
        if pd.notna(value) and str(value).strip():
            parts.append(str(value).upper())
    return " ".join(parts)


def score_gap(hours: float, threshold: float) -> float:
    if pd.isna(hours):
        return 0.0
    return min(1.0, 0.55 + (float(hours) - threshold) / max(1.0, threshold * 4))


def add_common(row: pd.Series, source_file: Path) -> dict:
    keep = {
        "scene": row.get("scene", ""),
        "scene_time_utc": row.get("scene_time_utc", ""),
        "MMSI": row.get("MMSI", ""),
        "Name": row.get("Name", row.get("gfw_name", "")),
        "Ship_Type": row.get("Ship_Type", ""),
        "gfw_shiptype": row.get("gfw_shiptype", ""),
        "Center_latitude": row.get("Center_latitude", ""),
        "Center_longitude": row.get("Center_longitude", ""),
        "Sog": row.get("Sog", ""),
        "Cog": row.get("Cog", ""),
        "AIS_Latitude": row.get("AIS_Latitude", ""),
        "AIS_Longitude": row.get("AIS_Longitude", ""),
        "sar_ais_distance_km": row.get("sar_ais_distance_km", ""),
        "sar_projected_distance_km": row.get("sar_projected_distance_km", ""),
        "sar_kalman_est_distance_km": row.get("sar_kalman_est_distance_km", ""),
        "AIS_update_time_gap_hours": row.get("AIS_update_time_gap_hours", ""),
        "ais_position_time_gap_hours": row.get("ais_position_time_gap_hours", ""),
        "kalman_dt_hours": row.get("kalman_dt_hours", ""),
        "kalman_pred_residual_m": row.get("kalman_pred_residual_m", ""),
        "kalman_mmsi_observation_count": row.get("kalman_mmsi_observation_count", ""),
        "patch_rgb_vv_actual_file": row.get("patch_rgb_vv_actual_file", ""),
        "patch_rgb_vh_actual_file": row.get("patch_rgb_vh_actual_file", ""),
        "source_file": str(source_file),
    }
    return keep


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "scene" not in df.columns:
        raise ValueError("Input must contain a 'scene' column.")
    if "MMSI" not in df.columns:
        raise ValueError("Input must contain an 'MMSI' column.")

    df["scene_time_utc"] = df["scene"].map(scene_time)

    if {"Center_latitude", "Center_longitude", "AIS_Latitude", "AIS_Longitude"}.issubset(df.columns):
        df["sar_ais_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["AIS_Latitude"], df["AIS_Longitude"])
    else:
        df["sar_ais_distance_km"] = math.nan

    if {"Center_latitude", "Center_longitude", "Projected_Latitude", "Projected_Longitude"}.issubset(df.columns):
        df["sar_projected_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["Projected_Latitude"], df["Projected_Longitude"])
    else:
        df["sar_projected_distance_km"] = math.nan

    if {"Center_latitude", "Center_longitude", "kalman_est_lat", "kalman_est_lon"}.issubset(df.columns):
        df["sar_kalman_est_distance_km"] = haversine_km(df["Center_latitude"], df["Center_longitude"], df["kalman_est_lat"], df["kalman_est_lon"])
    else:
        df["sar_kalman_est_distance_km"] = math.nan

    for col in [
        "Sog",
        "AIS_update_time_gap_hours",
        "ais_position_time_gap_hours",
        "kalman_dt_hours",
        "kalman_pred_residual_m",
        "kalman_mmsi_observation_count",
    ]:
        if col in df.columns:
            df[col] = to_num(df[col])
    return df


def find_godark(df: pd.DataFrame, source_file: Path, gap_hours: float) -> list[dict]:
    out = []
    if "AIS_update_time_gap_hours" not in df.columns:
        return out
    for _, row in df[df["AIS_update_time_gap_hours"] >= gap_hours].iterrows():
        item = add_common(row, source_file)
        gap = row.get("AIS_update_time_gap_hours")
        item.update(
            {
                "candidate_type": "godark",
                "score": round(score_gap(gap, gap_hours), 4),
                "rule": f"AIS_update_time_gap_hours >= {gap_hours:g}",
                "evidence": f"SAR scene has MMSI but nearest AIS update is {gap:.2f} hours from scene time.",
                "neighbor_mmsi": "",
                "neighbor_distance_km": "",
                "neighbor_sog": "",
            }
        )
        out.append(item)
    return out


def find_spoofing(df: pd.DataFrame, source_file: Path, args: argparse.Namespace) -> list[dict]:
    out = []
    for _, row in df.iterrows():
        ais_gap = row.get("AIS_update_time_gap_hours")
        pos_gap = row.get("ais_position_time_gap_hours")
        time_gap = min([x for x in [ais_gap, pos_gap] if pd.notna(x)], default=math.nan)
        dist = row.get("sar_ais_distance_km")
        residual = row.get("kalman_pred_residual_m")
        kalman_dt = row.get("kalman_dt_hours")

        reasons = []
        scores = []
        if pd.notna(time_gap) and pd.notna(dist) and time_gap <= args.spoof_close_hours and dist >= args.spoof_distance_km:
            reasons.append(f"SAR-AIS distance {dist:.2f} km with time gap {time_gap:.2f} h")
            scores.append(min(1.0, 0.55 + (dist - args.spoof_distance_km) / 30))
        if pd.notna(time_gap) and pd.notna(dist) and time_gap <= args.spoof_wide_hours and dist >= args.spoof_wide_distance_km:
            reasons.append(f"wide SAR-AIS distance {dist:.2f} km with time gap {time_gap:.2f} h")
            scores.append(min(1.0, 0.7 + (dist - args.spoof_wide_distance_km) / 50))
        if pd.notna(kalman_dt) and pd.notna(residual) and kalman_dt <= args.spoof_wide_hours and residual >= args.kalman_residual_m:
            reasons.append(f"Kalman residual {residual:.0f} m after {kalman_dt:.2f} h")
            scores.append(min(1.0, 0.6 + (residual - args.kalman_residual_m) / 100_000))

        if not reasons:
            continue

        item = add_common(row, source_file)
        item.update(
            {
                "candidate_type": "spoofing",
                "score": round(max(scores), 4),
                "rule": "close-time SAR/AIS mismatch or Kalman residual",
                "evidence": "; ".join(reasons),
                "neighbor_mmsi": "",
                "neighbor_distance_km": "",
                "neighbor_sog": "",
            }
        )
        out.append(item)
    return out


def find_transshipment(df: pd.DataFrame, source_file: Path, max_distance_km: float, slow_knots: float) -> list[dict]:
    out = []
    required = {"scene", "MMSI", "Center_latitude", "Center_longitude"}
    if not required.issubset(df.columns):
        return out

    for scene, group in df.groupby("scene", dropna=True):
        group = group.dropna(subset=["MMSI", "Center_latitude", "Center_longitude"]).copy()
        if group["MMSI"].nunique() < 2:
            continue

        records = list(group.iterrows())
        for idx, row in records:
            best = None
            lat1 = pd.to_numeric(pd.Series([row["Center_latitude"]]), errors="coerce")
            lon1 = pd.to_numeric(pd.Series([row["Center_longitude"]]), errors="coerce")
            for jdx, other in records:
                if idx == jdx or str(row["MMSI"]) == str(other["MMSI"]):
                    continue
                dist = haversine_km(
                    lat1,
                    lon1,
                    pd.Series([other["Center_latitude"]]),
                    pd.Series([other["Center_longitude"]]),
                ).iloc[0]
                if pd.isna(dist):
                    continue
                if best is None or dist < best["dist"]:
                    best = {"row": other, "dist": float(dist)}

            if not best or best["dist"] > max_distance_km:
                continue

            other = best["row"]
            sog1 = row.get("Sog")
            sog2 = other.get("Sog")
            slow_pair = pd.notna(sog1) and pd.notna(sog2) and float(sog1) <= slow_knots and float(sog2) <= slow_knots
            cargo_fishing_pair = ("CARGO" in ship_text(row) and "FISHING" in ship_text(other)) or (
                "FISHING" in ship_text(row) and "CARGO" in ship_text(other)
            )

            score = 0.55 + max(0.0, (max_distance_km - best["dist"]) / max_distance_km) * 0.25
            reasons = [f"nearest MMSI {other.get('MMSI')} at {best['dist']:.3f} km in same SAR scene"]
            if slow_pair:
                score += 0.15
                reasons.append(f"both vessels slow (SOG {float(sog1):.2f} and {float(sog2):.2f} kn)")
            if cargo_fishing_pair:
                score += 0.1
                reasons.append("cargo/fishing pair")

            item = add_common(row, source_file)
            item.update(
                {
                    "candidate_type": "transshipment",
                    "score": round(min(score, 1.0), 4),
                    "rule": f"same-scene nearest-vessel distance <= {max_distance_km:g} km",
                    "evidence": "; ".join(reasons),
                    "neighbor_mmsi": other.get("MMSI", ""),
                    "neighbor_distance_km": round(best["dist"], 6),
                    "neighbor_sog": other.get("Sog", ""),
                }
            )
            out.append(item)
    return out


def write_summary(out: pd.DataFrame, summary_path: Path, source: Path) -> None:
    lines = [
        "Scene Candidate Summary",
        f"Source: {source}",
        f"Output rows: {len(out)}",
        "",
        "Counts by candidate_type:",
    ]
    if out.empty:
        lines.append("(none)")
    else:
        counts = out["candidate_type"].value_counts()
        for key, value in counts.items():
            lines.append(f"- {key}: {value}")
        lines.append("")
        lines.append("Top candidates:")
        for _, row in out.sort_values(["score", "candidate_type"], ascending=[False, True]).head(20).iterrows():
            lines.append(
                f"- {row['candidate_type']} score={row['score']} scene={row['scene']} "
                f"MMSI={row['MMSI']} evidence={row['evidence']}"
            )
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    source = choose_input(args.input)
    df = pd.read_csv(source, low_memory=False)
    df = build_features(df)

    candidates = []
    candidates.extend(find_godark(df, source, args.godark_gap_hours))
    candidates.extend(find_spoofing(df, source, args))
    candidates.extend(find_transshipment(df, source, args.transship_distance_km, args.transship_slow_knots))

    out = pd.DataFrame(candidates)
    if not out.empty:
        out = out.drop_duplicates(
            subset=["candidate_type", "scene", "MMSI", "neighbor_mmsi"],
            keep="first",
        )
        out = out.sort_values(["candidate_type", "score", "scene", "MMSI"], ascending=[True, False, True, True])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.output, index=False)

    summary = args.summary or args.output.with_suffix(".summary.txt")
    write_summary(out, summary, source)

    print(f"Input: {source}")
    print(f"Rows read: {len(df)}")
    print(f"Candidates written: {len(out)}")
    if not out.empty:
        print(out["candidate_type"].value_counts().to_string())
    print(f"Output: {args.output}")
    print(f"Summary: {summary}")


if __name__ == "__main__":
    main()
