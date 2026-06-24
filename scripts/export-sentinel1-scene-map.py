#!/usr/bin/env python3
"""
Export a Sentinel-1 SAR scene map with SAR targets and AIS/Kalman overlays.

This creates the paper-style scene figure the patch gallery cannot create:
VV SAR background, SAR target circles, AIS/Kalman points, event colors, legend,
north arrow, and a nautical-mile scale bar. It also writes a clean SAR-only
HTML viewer for presentation/download screenshots without bounding boxes.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zipfile import ZipFile

import matplotlib.pyplot as plt
from matplotlib import image as mpl_image
from matplotlib.lines import Line2D
from matplotlib.patches import Circle
import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import GCPTransformer
from rasterio.windows import Window


DEFAULT_SCENES_DIR = Path("KAPAL YG TERDETEKSI/SENTINEL1_SCENES")
DEFAULT_PREDICTIONS = Path("KAPAL YG TERDETEKSI/godark_h5_predictions_fishing_by_scene_enriched_ais.csv")
DEFAULT_ALL_PREDICTIONS = Path("KAPAL YG TERDETEKSI/godark_h5_predictions_by_scene.csv")
DEFAULT_METADATA = Path("new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv")
DEFAULT_OUTPUT_DIR = Path("KAPAL YG TERDETEKSI/SENTINEL1_SCENE_MAPS")


EVENT_STYLES = {
    "go_dark": {"color": "#ff2d2d", "label": "GoDark"},
    "spoofing": {"color": "#ffd000", "label": "Spoofing"},
    "transshipment": {"color": "#00d47a", "label": "Transshipment"},
    "normal": {"color": "#d8d8d8", "label": "Not detected"},
    "unknown": {"color": "#9b9b9b", "label": "Unknown"},
}


HTML_LAYER_LABELS = {
    "sar": "SAR targets",
    "links": "AIS/Kalman to SAR",
    "ais": "AIS trajectory",
    "kalman": "Kalman trajectory",
    "go_dark": "GoDark vessels",
    "spoofing": "Spoofing vessels",
    "transshipment": "Transshipment vessels",
    "normal": "Not detected vessels",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene-zip", type=Path, default=None, help="One Sentinel-1 .zip scene to render. Default: render all zips.")
    parser.add_argument("--scenes-dir", type=Path, default=DEFAULT_SCENES_DIR)
    parser.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS, help="Fishing-only GoDark prediction CSV.")
    parser.add_argument("--all-predictions", type=Path, default=DEFAULT_ALL_PREDICTIONS, help="All-vessel GoDark prediction CSV.")
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA, help="Scene metadata CSV with SAR/AIS/Kalman columns.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--polarization", default="vv", choices=["vv", "vh"])
    parser.add_argument("--max-size", type=int, default=1800, help="Maximum rendered image side in pixels.")
    parser.add_argument("--margin-px", type=int, default=900, help="Crop margin around SAR target pixels.")
    parser.add_argument("--full-scene", action="store_true", help="Render the full SAR raster instead of cropping around targets.")
    parser.add_argument("--png-only", action="store_true", help="Write PNG outputs only; skip HTML viewers and CSV sidecars.")
    parser.add_argument("--clean-title", default="Scene SAR tanpa bounding box - zoom bersih")
    parser.add_argument("--clean-subtitle", default="", help="Subtitle for the clean SAR-only HTML. Default includes scene/window info.")
    parser.add_argument(
        "--trajectory-points",
        type=Path,
        action="append",
        default=[],
        help="CSV trajectory points to overlay. Can be repeated. Needs MMSI plus raw/kalman lat/lon columns.",
    )
    parser.add_argument("--trajectory-hours-before", type=float, default=24.0, help="Trajectory time window before SAR scene time.")
    parser.add_argument("--trajectory-hours-after", type=float, default=6.0, help="Trajectory time window after SAR scene time.")
    return parser.parse_args()


def clean_text(value: object) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value).strip()


def to_float(value: object) -> float | None:
    try:
        x = float(value)
        if math.isnan(x):
            return None
        return x
    except Exception:
        return None


def normalize_scene_name(path_or_name: object) -> str:
    name = clean_text(path_or_name)
    if not name:
        return ""
    name = Path(name).name
    for suffix in [".zip", ".SAFE", ".safe"]:
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return name


def normalize_mmsi(value: object) -> str:
    text = clean_text(value)
    if text.endswith(".0"):
        text = text[:-2]
    return text


def parse_scene_time(scene: str) -> pd.Timestamp | None:
    match = re.search(r"_(\d{8}T\d{6})_", scene)
    if not match:
        return None
    try:
        dt = datetime.strptime(match.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        return pd.Timestamp(dt)
    except Exception:
        return None


def find_measurement(zip_path: Path, polarization: str) -> str:
    pol = f"-{polarization.lower()}-"
    with ZipFile(zip_path) as zf:
        matches = [
            name
            for name in zf.namelist()
            if "/measurement/" in name.lower() and pol in name.lower() and name.lower().endswith((".tif", ".tiff"))
        ]
    if not matches:
        raise FileNotFoundError(f"No {polarization.upper()} measurement TIFF found in {zip_path}")
    return matches[0]


def vsizip_path(zip_path: Path, inner_path: str) -> str:
    return f"/vsizip/{zip_path.resolve().as_posix()}/{inner_path}"


def load_scene_rows(scene: str, predictions_path: Path, all_predictions_path: Path, metadata_path: Path) -> pd.DataFrame:
    if not metadata_path.exists():
        raise FileNotFoundError(f"Metadata CSV not found: {metadata_path}")
    meta = pd.read_csv(metadata_path, low_memory=False, dtype={"MMSI": str})
    if "scene" not in meta.columns:
        raise ValueError(f"Metadata CSV has no scene column: {metadata_path}")

    meta["scene_norm"] = meta["scene"].map(normalize_scene_name)
    rows = meta[meta["scene_norm"].eq(scene)].copy()
    if rows.empty:
        return rows

    rows["MMSI"] = rows["MMSI"].map(normalize_mmsi)
    rows["event_type"] = "normal"
    rows["go_dark_probability_calibrated"] = np.nan
    rows["pred_label"] = ""
    rows["alat_tangkap"] = ""

    prediction_frames = []
    for path in [all_predictions_path, predictions_path]:
        if not path.exists():
            continue
        pred = pd.read_csv(path, low_memory=False, dtype={"MMSI": str})
        if "scene" not in pred.columns or "MMSI" not in pred.columns:
            continue
        pred = pred.copy()
        pred["scene_norm"] = pred["scene"].map(normalize_scene_name)
        pred["MMSI"] = pred["MMSI"].map(normalize_mmsi)
        prediction_frames.append(pred[pred["scene_norm"].eq(scene)].copy())

    if prediction_frames:
        pred = pd.concat(prediction_frames, ignore_index=True)
        pred = pred.drop_duplicates(["scene_norm", "MMSI"], keep="last")
        keep = [
            c
            for c in [
                "scene_norm",
                "MMSI",
                "pred_label",
                "go_dark_probability_calibrated",
                "alat_tangkap",
                "alat_tangkap_source",
                "ais_gear_label",
            ]
            if c in pred.columns
        ]
        rows = rows.merge(pred[keep], on=["scene_norm", "MMSI"], how="left", suffixes=("", "_pred"))
        for col in ["pred_label", "go_dark_probability_calibrated", "alat_tangkap"]:
            pred_col = f"{col}_pred"
            if pred_col in rows.columns:
                rows[col] = rows[pred_col].combine_first(rows[col])
                rows = rows.drop(columns=[pred_col])
        labels = rows["pred_label"].fillna("").astype(str)
        rows["event_type"] = np.where(labels.isin(["go_dark", "spoofing", "transshipment"]), labels, "normal")

    return rows


def lonlat_to_pixel(transformer: GCPTransformer, lon: object, lat: object) -> tuple[float, float] | None:
    lon_f = to_float(lon)
    lat_f = to_float(lat)
    if lon_f is None or lat_f is None:
        return None
    try:
        rows, cols = transformer.rowcol([lon_f], [lat_f], op=float)
    except Exception:
        return None
    return float(cols[0]), float(rows[0])


def first_existing(columns: list[str], names: list[str]) -> str | None:
    lower = {c.lower(): c for c in columns}
    for name in names:
        if name.lower() in lower:
            return lower[name.lower()]
    return None


def load_trajectory_points(paths: list[Path], rows: pd.DataFrame, scene: str, args: argparse.Namespace) -> pd.DataFrame:
    if not paths or rows.empty:
        return pd.DataFrame()

    target_mmsi = set(rows["MMSI"].map(normalize_mmsi))
    scene_time = parse_scene_time(scene)
    start_time = scene_time - timedelta(hours=args.trajectory_hours_before) if scene_time is not None else None
    end_time = scene_time + timedelta(hours=args.trajectory_hours_after) if scene_time is not None else None

    frames = []
    for path in paths:
        if not path.exists():
            print(f"WARNING: trajectory file not found: {path}")
            continue
        try:
            header = pd.read_csv(path, nrows=0)
        except Exception as exc:
            print(f"WARNING: cannot read trajectory header {path}: {exc}")
            continue

        columns = list(header.columns)
        mmsi_col = first_existing(columns, ["MMSI", "mmsi"])
        time_col = first_existing(columns, ["timestamp_utc", "timestamp", "time_iso", "time"])
        raw_lat_col = first_existing(columns, ["ais_lat", "raw_lat", "lat", "AIS_Latitude"])
        raw_lon_col = first_existing(columns, ["ais_lon", "raw_lon", "lon", "AIS_Longitude"])
        kalman_lat_col = first_existing(columns, ["kalman_lat", "kalman_est_lat", "kalman_pred_lat"])
        kalman_lon_col = first_existing(columns, ["kalman_lon", "kalman_est_lon", "kalman_pred_lon"])
        if not mmsi_col or not ((raw_lat_col and raw_lon_col) or (kalman_lat_col and kalman_lon_col)):
            print(f"WARNING: skipped trajectory file without usable columns: {path}")
            continue

        usecols = [mmsi_col]
        for col in [time_col, raw_lat_col, raw_lon_col, kalman_lat_col, kalman_lon_col]:
            if col and col not in usecols:
                usecols.append(col)
        try:
            part = pd.read_csv(path, usecols=usecols, low_memory=False, dtype={mmsi_col: str})
        except Exception as exc:
            print(f"WARNING: cannot read trajectory file {path}: {exc}")
            continue

        out = pd.DataFrame({"MMSI": part[mmsi_col].map(normalize_mmsi)})
        out = out[out["MMSI"].isin(target_mmsi)].copy()
        if out.empty:
            continue

        if time_col:
            out["trajectory_time"] = pd.to_datetime(part.loc[out.index, time_col], errors="coerce", utc=True)
            if start_time is not None and end_time is not None:
                out = out[(out["trajectory_time"] >= start_time) & (out["trajectory_time"] <= end_time)].copy()
        else:
            out["trajectory_time"] = pd.NaT

        if raw_lat_col and raw_lon_col:
            out["raw_lat"] = pd.to_numeric(part.loc[out.index, raw_lat_col], errors="coerce")
            out["raw_lon"] = pd.to_numeric(part.loc[out.index, raw_lon_col], errors="coerce")
        else:
            out["raw_lat"] = np.nan
            out["raw_lon"] = np.nan

        if kalman_lat_col and kalman_lon_col:
            out["kalman_lat"] = pd.to_numeric(part.loc[out.index, kalman_lat_col], errors="coerce")
            out["kalman_lon"] = pd.to_numeric(part.loc[out.index, kalman_lon_col], errors="coerce")
        else:
            out["kalman_lat"] = np.nan
            out["kalman_lon"] = np.nan

        out["trajectory_source"] = str(path)
        out = out.dropna(subset=["raw_lat", "raw_lon", "kalman_lat", "kalman_lon"], how="all")
        if not out.empty:
            frames.append(out)

    if not frames:
        return pd.DataFrame()

    traj = pd.concat(frames, ignore_index=True)
    return traj.sort_values(["MMSI", "trajectory_time"], na_position="last").reset_index(drop=True)


def add_trajectory_pixels(traj: pd.DataFrame, transformer: GCPTransformer) -> pd.DataFrame:
    if traj.empty:
        return traj
    out = traj.copy()
    raw_pixels = []
    kalman_pixels = []
    for _, row in out.iterrows():
        raw_pixels.append(lonlat_to_pixel(transformer, row.get("raw_lon"), row.get("raw_lat")))
        kalman_pixels.append(lonlat_to_pixel(transformer, row.get("kalman_lon"), row.get("kalman_lat")))
    out["raw_x"] = [p[0] if p else np.nan for p in raw_pixels]
    out["raw_y"] = [p[1] if p else np.nan for p in raw_pixels]
    out["trajectory_kalman_x"] = [p[0] if p else np.nan for p in kalman_pixels]
    out["trajectory_kalman_y"] = [p[1] if p else np.nan for p in kalman_pixels]
    return out


def pixel_to_lonlat(transformer: GCPTransformer, x: float, y: float) -> tuple[float, float] | None:
    try:
        xs, ys = transformer.xy([y], [x])
    except Exception:
        return None
    return float(xs[0]), float(ys[0])


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0088
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def sar_and_ais_pixels(rows: pd.DataFrame, transformer: GCPTransformer) -> pd.DataFrame:
    out = rows.copy()
    sar_pixels = []
    ais_pixels = []
    kalman_pixels = []
    for _, row in out.iterrows():
        sar_pixels.append(lonlat_to_pixel(transformer, row.get("Center_longitude"), row.get("Center_latitude")))
        ais_pixels.append(lonlat_to_pixel(transformer, row.get("AIS_Longitude"), row.get("AIS_Latitude")))
        kalman_pixels.append(lonlat_to_pixel(transformer, row.get("kalman_est_lon"), row.get("kalman_est_lat")))

    out["sar_x"] = [p[0] if p else np.nan for p in sar_pixels]
    out["sar_y"] = [p[1] if p else np.nan for p in sar_pixels]
    out["ais_x"] = [p[0] if p else np.nan for p in ais_pixels]
    out["ais_y"] = [p[1] if p else np.nan for p in ais_pixels]
    out["kalman_x"] = [p[0] if p else np.nan for p in kalman_pixels]
    out["kalman_y"] = [p[1] if p else np.nan for p in kalman_pixels]
    return out


def compute_window(rows: pd.DataFrame, width: int, height: int, margin_px: int, full_scene: bool) -> Window:
    if full_scene or rows.empty or rows["sar_x"].dropna().empty:
        return Window(0, 0, width, height)

    xs = rows["sar_x"].dropna().to_numpy()
    ys = rows["sar_y"].dropna().to_numpy()
    left = max(0, math.floor(xs.min() - margin_px))
    right = min(width, math.ceil(xs.max() + margin_px))
    top = max(0, math.floor(ys.min() - margin_px))
    bottom = min(height, math.ceil(ys.max() + margin_px))
    return Window(left, top, max(1, right - left), max(1, bottom - top))


def stretch_sar(data: np.ndarray) -> np.ndarray:
    arr = data.astype(np.float32)
    arr = np.where(arr > 0, arr, np.nan)
    arr = np.log1p(arr)
    lo, hi = np.nanpercentile(arr, [1, 99.5])
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = np.nanmin(arr), np.nanmax(arr)
    arr = (arr - lo) / max(1e-6, hi - lo)
    arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=0.0)
    return np.clip(arr, 0, 1)


def read_display_image(src, window: Window, max_size: int) -> tuple[np.ndarray, float]:
    scale = max(1.0, max(window.width, window.height) / max_size)
    out_h = max(1, int(round(window.height / scale)))
    out_w = max(1, int(round(window.width / scale)))
    data = src.read(1, window=window, out_shape=(out_h, out_w), resampling=rasterio.enums.Resampling.bilinear)
    return stretch_sar(data), scale


def local_point(row: pd.Series, x_col: str, y_col: str, window: Window, scale: float) -> tuple[float, float] | None:
    x = to_float(row.get(x_col))
    y = to_float(row.get(y_col))
    if x is None or y is None:
        return None
    lx = (x - window.col_off) / scale
    ly = (y - window.row_off) / scale
    if lx < 0 or ly < 0 or lx > window.width / scale or ly > window.height / scale:
        return None
    return lx, ly


def local_points(group: pd.DataFrame, x_col: str, y_col: str, window: Window, scale: float) -> list[tuple[float, float]]:
    pts = []
    for _, row in group.iterrows():
        x = to_float(row.get(x_col))
        y = to_float(row.get(y_col))
        if x is None or y is None:
            pts.append((np.nan, np.nan))
            continue
        pts.append(((x - window.col_off) / scale, (y - window.row_off) / scale))
    return pts


def format_lon(lon: float) -> str:
    hemi = "E" if lon >= 0 else "W"
    return f"{abs(lon):.2f} deg {hemi}"


def format_lat(lat: float) -> str:
    hemi = "N" if lat >= 0 else "S"
    return f"{abs(lat):.2f} deg {hemi}"


def add_geo_ticks(ax, transformer: GCPTransformer, window: Window, scale: float, img_shape: tuple[int, int]) -> None:
    h, w = img_shape
    x_ticks = np.linspace(0, w, 5)
    y_ticks = np.linspace(0, h, 5)
    mid_y = window.row_off + (h * scale / 2)
    mid_x = window.col_off + (w * scale / 2)

    x_labels = []
    for x in x_ticks:
        lonlat = pixel_to_lonlat(transformer, window.col_off + x * scale, mid_y)
        x_labels.append(format_lon(lonlat[0]) if lonlat else "")
    y_labels = []
    for y in y_ticks:
        lonlat = pixel_to_lonlat(transformer, mid_x, window.row_off + y * scale)
        y_labels.append(format_lat(lonlat[1]) if lonlat else "")

    ax.set_xticks(x_ticks)
    ax.set_xticklabels(x_labels, fontsize=8)
    ax.set_yticks(y_ticks)
    ax.set_yticklabels(y_labels, fontsize=8)
    ax.xaxis.tick_top()
    ax.yaxis.tick_right()
    ax.tick_params(axis="both", colors="black", length=3)


def add_scale_bar(ax, transformer: GCPTransformer, window: Window, scale: float, img_shape: tuple[int, int]) -> None:
    h, w = img_shape
    center_x = window.col_off + w * scale * 0.5
    center_y = window.row_off + h * scale * 0.5
    p1 = pixel_to_lonlat(transformer, center_x, center_y)
    p2 = pixel_to_lonlat(transformer, center_x + 1000, center_y)
    if not p1 or not p2:
        return
    km_per_px = haversine_km(p1[1], p1[0], p2[1], p2[0]) / 1000
    nm_per_px = km_per_px / 1.852
    if nm_per_px <= 0:
        return
    for desired_nm in [20, 10, 5, 2, 1]:
        bar_px = desired_nm / (nm_per_px * scale)
        if bar_px < w * 0.28:
            break
    x0 = w * 0.06
    y0 = h * 0.92
    ax.plot([x0, x0 + bar_px], [y0, y0], color="white", linewidth=3)
    ax.plot([x0, x0 + bar_px], [y0, y0], color="black", linewidth=1)
    ax.text(x0 + bar_px / 2, y0 - 14, f"{desired_nm} NM", ha="center", va="bottom", color="white", fontsize=8)


def add_north_arrow(ax, transformer: GCPTransformer, window: Window, scale: float, img_shape: tuple[int, int]) -> None:
    h, w = img_shape
    x = window.col_off + w * scale * 0.88
    y = window.row_off + h * scale * 0.82
    lonlat = pixel_to_lonlat(transformer, x, y)
    if not lonlat:
        return
    north = lonlat_to_pixel(transformer, lonlat[0], lonlat[1] + 0.1)
    if not north:
        return
    nx = (north[0] - x) / scale
    ny = (north[1] - y) / scale
    length = math.hypot(nx, ny)
    if length <= 0:
        return
    nx, ny = nx / length, ny / length
    base_x = w * 0.88
    base_y = h * 0.82
    arrow_len = min(w, h) * 0.08
    ax.annotate(
        "",
        xy=(base_x + nx * arrow_len, base_y + ny * arrow_len),
        xytext=(base_x, base_y),
        arrowprops={"arrowstyle": "-|>", "color": "white", "linewidth": 2, "mutation_scale": 24},
    )
    ax.text(base_x + nx * (arrow_len + 14), base_y + ny * (arrow_len + 14), "N", color="white", ha="center", va="center")


def point_to_local_xy(row: pd.Series, x_col: str, y_col: str, window: Window, scale: float) -> dict | None:
    point = local_point(row, x_col, y_col, window, scale)
    if point is None:
        return None
    return {"x": round(point[0], 3), "y": round(point[1], 3)}


def local_line_points(group: pd.DataFrame, x_col: str, y_col: str, window: Window, scale: float) -> list[list[float]]:
    pts = []
    for x, y in local_points(group, x_col, y_col, window, scale):
        if np.isfinite(x) and np.isfinite(y):
            pts.append([round(float(x), 3), round(float(y), 3)])
    return pts


def scene_html_data(rows: pd.DataFrame, trajectories: pd.DataFrame, window: Window, scale: float, img_shape: tuple[int, int]) -> dict:
    vessels = []
    for _, row in rows.iterrows():
        sar = point_to_local_xy(row, "sar_x", "sar_y", window, scale)
        ais = point_to_local_xy(row, "ais_x", "ais_y", window, scale)
        kalman = point_to_local_xy(row, "kalman_x", "kalman_y", window, scale)
        event = clean_text(row.get("event_type")) or "unknown"
        vessels.append(
            {
                "mmsi": clean_text(row.get("MMSI")),
                "name": clean_text(row.get("Name")),
                "category": clean_text(row.get("category")),
                "event": event,
                "eventLabel": EVENT_STYLES.get(event, EVENT_STYLES["unknown"])["label"],
                "probability": None
                if pd.isna(row.get("go_dark_probability_calibrated"))
                else round(float(row.get("go_dark_probability_calibrated")), 6),
                "gear": clean_text(row.get("alat_tangkap")),
                "sar": sar,
                "ais": ais,
                "kalman": kalman,
                "sarLat": to_float(row.get("Center_latitude")),
                "sarLon": to_float(row.get("Center_longitude")),
                "aisLat": to_float(row.get("AIS_Latitude")),
                "aisLon": to_float(row.get("AIS_Longitude")),
            }
        )

    tracks = []
    if not trajectories.empty:
        for mmsi, group in trajectories.groupby("MMSI", sort=False):
            group = group.sort_values("trajectory_time", na_position="last")
            raw = local_line_points(group, "raw_x", "raw_y", window, scale)
            kalman = local_line_points(group, "trajectory_kalman_x", "trajectory_kalman_y", window, scale)
            if raw or kalman:
                tracks.append(
                    {
                        "mmsi": clean_text(mmsi),
                        "raw": raw,
                        "kalman": kalman,
                        "pointCount": int(len(group)),
                        "start": clean_text(group["trajectory_time"].iloc[0]) if "trajectory_time" in group else "",
                        "end": clean_text(group["trajectory_time"].iloc[-1]) if "trajectory_time" in group else "",
                    }
                )

    return {
        "width": int(img_shape[1]),
        "height": int(img_shape[0]),
        "vessels": vessels,
        "tracks": tracks,
    }


def write_interactive_html(
    html_path: Path,
    background_name: str,
    scene: str,
    polarization: str,
    data: dict,
) -> None:
    data_json = json.dumps(data, ensure_ascii=True, allow_nan=False).replace("</", "<\\/")
    scene_label = html.escape(scene)
    layer_checkboxes = "\n".join(
        f'<label><input type="checkbox" data-layer="{key}" checked> {html.escape(label)}</label>'
        for key, label in HTML_LAYER_LABELS.items()
    )
    html_text = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{scene_label} | Sentinel-1 {html.escape(polarization.upper())}</title>
  <style>
    :root {{
      color-scheme: light;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #667085;
      --line: #d0d5dd;
      --accent: #e11d48;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: #f4f6f8;
      overflow: hidden;
    }}
    header {{
      height: 52px;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      white-space: nowrap;
    }}
    header h1 {{
      font-size: 15px;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    header .hint {{
      color: var(--muted);
      font-size: 12px;
    }}
    .app {{
      display: grid;
      grid-template-columns: 320px 1fr;
      height: calc(100vh - 52px);
    }}
    aside {{
      background: var(--panel);
      border-right: 1px solid var(--line);
      overflow: auto;
      padding: 12px;
    }}
    .section {{
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
      margin-bottom: 12px;
    }}
    .section h2 {{
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
      margin: 0 0 8px;
    }}
    .layers label {{
      display: block;
      font-size: 13px;
      margin: 7px 0;
      cursor: pointer;
    }}
    .buttons {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }}
    button {{
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 13px;
    }}
    button:hover {{ border-color: #98a2b3; }}
    .vessel {{
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #fff;
    }}
    .vessel:hover {{ border-color: #98a2b3; }}
    .vessel.active {{ outline: 2px solid #2563eb; }}
    .vessel .name {{
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 4px;
    }}
    .pill {{
      display: inline-block;
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      margin: 2px 4px 0 0;
      border: 1px solid var(--line);
    }}
    .pill.go_dark {{ background: #fee2e2; color: #991b1b; border-color: #fecaca; }}
    .pill.spoofing {{ background: #fef3c7; color: #92400e; border-color: #fde68a; }}
    .pill.transshipment {{ background: #dcfce7; color: #166534; border-color: #bbf7d0; }}
    .pill.normal {{ background: #f2f4f7; color: #344054; }}
    .meta {{ color: var(--muted); font-size: 12px; line-height: 1.45; }}
    #viewer {{
      position: relative;
      overflow: hidden;
      background: #111;
      cursor: grab;
      user-select: none;
    }}
    #viewer.dragging {{ cursor: grabbing; }}
    #stage {{
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      will-change: transform;
    }}
    #sarImage {{
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: auto;
    }}
    #overlay {{
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    }}
    .sar-target {{
      fill: transparent;
      stroke: #ff1f1f;
      stroke-width: 3;
      vector-effect: non-scaling-stroke;
    }}
    .event-point {{
      stroke: #111;
      stroke-width: 1.2;
      vector-effect: non-scaling-stroke;
      cursor: pointer;
    }}
    .event-point.go_dark {{ fill: #ff2d2d; }}
    .event-point.spoofing {{ fill: #ffd000; }}
    .event-point.transshipment {{ fill: #00d47a; }}
    .event-point.normal {{ fill: #e5e7eb; }}
    .event-point.unknown {{ fill: #999; }}
    .link {{
      stroke: #ff3b3b;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
      opacity: .8;
    }}
    .raw-track {{
      fill: none;
      stroke: #00b7ff;
      stroke-width: 2.2;
      stroke-dasharray: 8 7;
      vector-effect: non-scaling-stroke;
      opacity: .9;
    }}
    .kalman-track {{
      fill: none;
      stroke: #ffd21a;
      stroke-width: 3;
      vector-effect: non-scaling-stroke;
      opacity: .95;
    }}
    .track-dot {{
      fill: #ffd21a;
      stroke: #111;
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }}
    #tooltip {{
      position: fixed;
      pointer-events: none;
      z-index: 5;
      max-width: 280px;
      padding: 8px 10px;
      border-radius: 7px;
      background: rgba(17, 24, 39, .92);
      color: white;
      font-size: 12px;
      line-height: 1.45;
      display: none;
    }}
    .legend {{
      position: absolute;
      right: 16px;
      bottom: 16px;
      background: rgba(255,255,255,.9);
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.6;
      pointer-events: none;
    }}
    .legend span {{
      display: inline-block;
      width: 22px;
      height: 0;
      border-top: 3px solid currentColor;
      vertical-align: middle;
      margin-right: 6px;
    }}
    .legend .dash {{ border-top-style: dashed; color: #00b7ff; }}
    .legend .yellow {{ color: #ffd21a; }}
    .legend .red {{ color: #ff2d2d; }}
    .legend .ring {{
      width: 14px;
      height: 14px;
      border: 2px solid #ff1f1f;
      border-radius: 999px;
      border-top-style: solid;
    }}
    .legend .dot {{
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border-top: 0;
      margin-left: 1px;
      margin-right: 9px;
    }}
    .legend .go-dark {{ background: #ff2d2d; }}
    .legend .normal-dot {{ background: #e5e7eb; border: 1px solid #111; }}
  </style>
</head>
<body>
  <header>
    <h1>{scene_label} | Sentinel-1 {html.escape(polarization.upper())}</h1>
    <div class="hint">Scroll untuk zoom, drag untuk geser, klik kapal untuk detail.</div>
  </header>
  <div class="app">
    <aside>
      <div class="section">
        <h2>Controls</h2>
        <div class="buttons">
          <button id="fitBtn">Fit</button>
          <button id="zoomInBtn">Zoom +</button>
          <button id="zoomOutBtn">Zoom -</button>
        </div>
      </div>
      <div class="section layers">
        <h2>Layers</h2>
        {layer_checkboxes}
      </div>
      <div class="section">
        <h2>Selected</h2>
        <div id="details" class="meta">Klik kapal di peta atau daftar.</div>
      </div>
      <div>
        <h2>Vessels</h2>
        <div id="vesselList"></div>
      </div>
    </aside>
    <main id="viewer">
      <div id="stage">
        <img id="sarImage" src="{html.escape(background_name)}" alt="Sentinel-1 SAR background">
        <svg id="overlay"></svg>
      </div>
      <div class="legend">
        <div><span class="ring"></span>SAR targets</div>
        <div><span class="dot go-dark"></span>GoDark</div>
        <div><span class="dot normal-dot"></span>Not detected</div>
        <div><span class="yellow"></span>Kalman trajectory</div>
        <div><span class="dash"></span>AIS trajectory</div>
        <div><span class="red"></span>AIS/Kalman to SAR</div>
      </div>
    </main>
  </div>
  <div id="tooltip"></div>
  <script>
    const DATA = {data_json};
    const COLORS = {{
      go_dark: "#ff2d2d",
      spoofing: "#ffd000",
      transshipment: "#00d47a",
      normal: "#e5e7eb",
      unknown: "#999999"
    }};
    const viewer = document.getElementById("viewer");
    const stage = document.getElementById("stage");
    const overlay = document.getElementById("overlay");
    const tooltip = document.getElementById("tooltip");
    const details = document.getElementById("details");
    const vesselList = document.getElementById("vesselList");
    let scale = 1, tx = 0, ty = 0, dragging = false, lastX = 0, lastY = 0, activeMmsi = null;
    const layerState = Object.fromEntries([...document.querySelectorAll("[data-layer]")].map(i => [i.dataset.layer, i.checked]));

    stage.style.width = DATA.width + "px";
    stage.style.height = DATA.height + "px";
    overlay.setAttribute("viewBox", `0 0 ${{DATA.width}} ${{DATA.height}}`);

    function applyTransform() {{
      stage.style.transform = `translate(${{tx}}px, ${{ty}}px) scale(${{scale}})`;
    }}

    function fit() {{
      const pad = 24;
      const sx = (viewer.clientWidth - pad * 2) / DATA.width;
      const sy = (viewer.clientHeight - pad * 2) / DATA.height;
      scale = Math.min(sx, sy);
      tx = (viewer.clientWidth - DATA.width * scale) / 2;
      ty = (viewer.clientHeight - DATA.height * scale) / 2;
      applyTransform();
    }}

    function zoomAt(cx, cy, factor) {{
      const beforeX = (cx - tx) / scale;
      const beforeY = (cy - ty) / scale;
      scale = Math.max(0.08, Math.min(12, scale * factor));
      tx = cx - beforeX * scale;
      ty = cy - beforeY * scale;
      applyTransform();
    }}

    function vesselTitle(v) {{
      return `${{v.name || "Unnamed vessel"}} (${{v.mmsi || "no MMSI"}})`;
    }}

    function vesselHtml(v) {{
      const prob = v.probability == null ? "" : `<br>GoDark probability: ${{v.probability}}`;
      return `<strong>${{vesselTitle(v)}}</strong><br>Event: ${{v.eventLabel}}<br>Category: ${{v.category || "-"}}<br>Gear: ${{v.gear || "-"}}${{prob}}<br>SAR: ${{v.sarLat?.toFixed?.(5) ?? "-"}}, ${{v.sarLon?.toFixed?.(5) ?? "-"}}`;
    }}

    function polyline(points) {{
      return points.map(p => p.join(",")).join(" ");
    }}

    function setActive(mmsi) {{
      activeMmsi = mmsi;
      const v = DATA.vessels.find(item => item.mmsi === mmsi);
      details.innerHTML = v ? vesselHtml(v) : "Klik kapal di peta atau daftar.";
      [...document.querySelectorAll(".vessel")].forEach(el => el.classList.toggle("active", el.dataset.mmsi === mmsi));
      [...overlay.querySelectorAll(".event-point")].forEach(el => {{
        el.setAttribute("r", el.dataset.mmsi === mmsi ? 8 : 5);
      }});
      if (v?.sar) {{
        tx = viewer.clientWidth / 2 - v.sar.x * scale;
        ty = viewer.clientHeight / 2 - v.sar.y * scale;
        applyTransform();
      }}
    }}

    function addSvg(tag, attrs, parent=overlay) {{
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      parent.appendChild(el);
      return el;
    }}

    function render() {{
      overlay.innerHTML = "";
      const tracksGroup = addSvg("g", {{id: "tracks"}});
      for (const track of DATA.tracks) {{
        if (layerState.ais && track.raw.length >= 2) {{
          addSvg("polyline", {{points: polyline(track.raw), class: "raw-track", "data-mmsi": track.mmsi}}, tracksGroup);
        }}
        if (layerState.kalman && track.kalman.length >= 2) {{
          addSvg("polyline", {{points: polyline(track.kalman), class: "kalman-track", "data-mmsi": track.mmsi}}, tracksGroup);
          const last = track.kalman[track.kalman.length - 1];
          addSvg("circle", {{cx: last[0], cy: last[1], r: 4, class: "track-dot", "data-mmsi": track.mmsi}}, tracksGroup);
        }}
      }}

      for (const v of DATA.vessels) {{
        const showEvent = layerState[v.event] ?? layerState.normal ?? true;
        if (!showEvent) continue;
        if (layerState.links && v.sar && (v.kalman || v.ais)) {{
          const p = v.kalman || v.ais;
          addSvg("line", {{x1: p.x, y1: p.y, x2: v.sar.x, y2: v.sar.y, class: "link"}});
        }}
        if (layerState.sar && v.sar) {{
          addSvg("circle", {{cx: v.sar.x, cy: v.sar.y, r: 9, class: "sar-target"}});
        }}
        const p = v.kalman || v.ais || v.sar;
        if (p) {{
          const c = addSvg("circle", {{cx: p.x, cy: p.y, r: activeMmsi === v.mmsi ? 8 : 5, class: `event-point ${{v.event}}`, "data-mmsi": v.mmsi}});
          c.addEventListener("click", evt => {{ evt.stopPropagation(); setActive(v.mmsi); }});
          c.addEventListener("mousemove", evt => {{
            tooltip.innerHTML = vesselHtml(v);
            tooltip.style.display = "block";
            tooltip.style.left = (evt.clientX + 14) + "px";
            tooltip.style.top = (evt.clientY + 14) + "px";
          }});
          c.addEventListener("mouseleave", () => tooltip.style.display = "none");
        }}
      }}
    }}

    function renderList() {{
      vesselList.innerHTML = "";
      DATA.vessels.forEach(v => {{
        const el = document.createElement("div");
        el.className = "vessel";
        el.dataset.mmsi = v.mmsi;
        const prob = v.probability == null ? "" : ` &middot; p=${{v.probability}}`;
        el.innerHTML = `<div class="name">${{vesselTitle(v)}}</div><span class="pill ${{v.event}}">${{v.eventLabel}}</span><div class="meta">${{v.category || "-"}} &middot; ${{v.gear || "unknown gear"}}${{prob}}</div>`;
        el.addEventListener("click", () => setActive(v.mmsi));
        vesselList.appendChild(el);
      }});
    }}

    viewer.addEventListener("wheel", evt => {{
      evt.preventDefault();
      zoomAt(evt.clientX - viewer.getBoundingClientRect().left, evt.clientY - viewer.getBoundingClientRect().top, evt.deltaY < 0 ? 1.18 : 0.85);
    }}, {{passive: false}});
    viewer.addEventListener("mousedown", evt => {{ dragging = true; lastX = evt.clientX; lastY = evt.clientY; viewer.classList.add("dragging"); }});
    window.addEventListener("mousemove", evt => {{
      if (!dragging) return;
      tx += evt.clientX - lastX;
      ty += evt.clientY - lastY;
      lastX = evt.clientX;
      lastY = evt.clientY;
      applyTransform();
    }});
    window.addEventListener("mouseup", () => {{ dragging = false; viewer.classList.remove("dragging"); }});
    document.getElementById("fitBtn").addEventListener("click", fit);
    document.getElementById("zoomInBtn").addEventListener("click", () => zoomAt(viewer.clientWidth / 2, viewer.clientHeight / 2, 1.25));
    document.getElementById("zoomOutBtn").addEventListener("click", () => zoomAt(viewer.clientWidth / 2, viewer.clientHeight / 2, 0.8));
    document.querySelectorAll("[data-layer]").forEach(input => {{
      input.addEventListener("change", () => {{ layerState[input.dataset.layer] = input.checked; render(); }});
    }});
    window.addEventListener("resize", fit);
    renderList();
    render();
    fit();
  </script>
</body>
</html>
"""
    html_path.write_text(html_text, encoding="utf-8")


def write_clean_html(
    html_path: Path,
    background_name: str,
    scene: str,
    polarization: str,
    image_shape: tuple[int, int],
    title: str,
    subtitle: str,
) -> None:
    data_json = json.dumps(
        {
            "width": int(image_shape[1]),
            "height": int(image_shape[0]),
            "image": background_name,
            "scene": scene,
            "polarization": polarization.upper(),
        },
        ensure_ascii=True,
        allow_nan=False,
    ).replace("</", "<\\/")
    title_text = html.escape(title)
    subtitle_text = html.escape(subtitle)
    html_text = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title_text}</title>
  <style>
    * {{ box-sizing: border-box; }}
    html, body {{
      width: 100%;
      height: 100%;
      margin: 0;
      background: #000;
      color: #e5e7eb;
      font-family: Arial, Helvetica, sans-serif;
      overflow: hidden;
    }}
    .topbar {{
      height: 46px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 0 12px;
      background: #11161c;
      border-bottom: 1px solid #171d25;
    }}
    .topbar h1 {{
      margin: 0;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.1;
      color: #f3f4f6;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    .topbar p {{
      margin: 0;
      font-size: 11px;
      line-height: 1.1;
      color: #9ca3af;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }}
    #viewer {{
      position: relative;
      width: 100vw;
      height: calc(100vh - 46px);
      overflow: hidden;
      background: #000;
      cursor: grab;
      user-select: none;
    }}
    #viewer.dragging {{ cursor: grabbing; }}
    #stage {{
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      will-change: transform;
    }}
    #stage img {{
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: auto;
      pointer-events: none;
    }}
  </style>
</head>
<body>
  <header class="topbar">
    <h1>{title_text}</h1>
    <p>{subtitle_text}</p>
  </header>
  <main id="viewer" title="Scroll untuk zoom, drag untuk geser, double click untuk reset.">
    <div id="stage">
      <img src="{html.escape(background_name)}" alt="Sentinel-1 SAR tanpa overlay">
    </div>
  </main>
  <script>
    const DATA = {data_json};
    const viewer = document.getElementById("viewer");
    const stage = document.getElementById("stage");
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    stage.style.width = DATA.width + "px";
    stage.style.height = DATA.height + "px";

    function applyTransform() {{
      stage.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
    }}

    function fit() {{
      const sx = viewer.clientWidth / DATA.width;
      const sy = viewer.clientHeight / DATA.height;
      scale = Math.min(sx, sy);
      tx = (viewer.clientWidth - DATA.width * scale) / 2;
      ty = (viewer.clientHeight - DATA.height * scale) / 2;
      applyTransform();
    }}

    function zoomAt(cx, cy, factor) {{
      const beforeX = (cx - tx) / scale;
      const beforeY = (cy - ty) / scale;
      scale = Math.max(0.05, Math.min(18, scale * factor));
      tx = cx - beforeX * scale;
      ty = cy - beforeY * scale;
      applyTransform();
    }}

    viewer.addEventListener("wheel", evt => {{
      evt.preventDefault();
      const rect = viewer.getBoundingClientRect();
      zoomAt(evt.clientX - rect.left, evt.clientY - rect.top, evt.deltaY < 0 ? 1.18 : 0.85);
    }}, {{ passive: false }});

    viewer.addEventListener("mousedown", evt => {{
      dragging = true;
      lastX = evt.clientX;
      lastY = evt.clientY;
      viewer.classList.add("dragging");
    }});

    window.addEventListener("mousemove", evt => {{
      if (!dragging) return;
      tx += evt.clientX - lastX;
      ty += evt.clientY - lastY;
      lastX = evt.clientX;
      lastY = evt.clientY;
      applyTransform();
    }});

    window.addEventListener("mouseup", () => {{
      dragging = false;
      viewer.classList.remove("dragging");
    }});

    viewer.addEventListener("dblclick", fit);
    window.addEventListener("resize", fit);
    fit();
  </script>
</body>
</html>
"""
    html_path.write_text(html_text, encoding="utf-8")


def vessel_display_name(row: pd.Series) -> str:
    name = clean_text(row.get("Name"))
    mmsi = normalize_mmsi(row.get("MMSI"))
    if name and mmsi:
        return f"{name} ({mmsi})"
    return name or mmsi or "Unknown vessel"


def vessel_gear(row: pd.Series) -> str:
    for col in ["alat_tangkap", "ais_gear_label", "gfw_geartype", "gear_label"]:
        value = clean_text(row.get(col))
        if value:
            return value
    return "UNKNOWN_GEAR"


def is_fishing_row(row: pd.Series) -> bool:
    values = [row.get("category"), row.get("Ship_Type"), row.get("gfw_shiptype"), row.get("Elaborated_type")]
    return any("fishing" in clean_text(value).lower() for value in values)


def wrap_panel_line(text: str, width: int = 39) -> list[str]:
    return textwrap.wrap(text, width=width, break_long_words=False, replace_whitespace=False) or [text]


def draw_detection_panel(ax, rows: pd.DataFrame, scene: str) -> None:
    ax.set_axis_off()
    ax.set_facecolor("#f8fafc")
    for spine in ax.spines.values():
        spine.set_visible(True)
        spine.set_color("#cbd5e1")

    total = len(rows)
    fishing_count = int(rows.apply(is_fishing_row, axis=1).sum()) if total else 0
    event_counts = rows["event_type"].fillna("unknown").astype(str).value_counts().to_dict() if total else {}
    y = 0.98

    def write(text: str, size: int = 8, weight: str = "normal", color: str = "#0f172a", dy: float = 0.026) -> None:
        nonlocal y
        ax.text(0.03, y, text, transform=ax.transAxes, ha="left", va="top", fontsize=size, fontweight=weight, color=color)
        y -= dy

    def section(title: str, subset: pd.DataFrame, color: str) -> None:
        nonlocal y
        y -= 0.012
        write(title, size=9, weight="bold", color=color, dy=0.031)
        if subset.empty:
            write("Tidak ada di scene ini.", size=7.5, color="#64748b", dy=0.025)
            return
        for _, row in subset.head(8).iterrows():
            prob = row.get("go_dark_probability_calibrated")
            prob_text = "" if pd.isna(prob) else f" | p={float(prob):.2f}"
            line = f"{vessel_display_name(row)} | {clean_text(row.get('category')) or '-'} | {vessel_gear(row)}{prob_text}"
            for i, part in enumerate(wrap_panel_line(line)):
                prefix = "- " if i == 0 else "  "
                write(prefix + part, size=7.2, color="#1e293b", dy=0.022)
        if len(subset) > 8:
            write(f"... +{len(subset) - 8} kapal lagi", size=7.2, color="#64748b", dy=0.023)

    write("RINGKASAN DETEKSI", size=11, weight="bold", dy=0.036)
    write(scene, size=7.2, color="#475569", dy=0.047)
    write(f"Total SAR-linked vessels: {total}", size=8, weight="bold", dy=0.027)
    write(f"Fishing vessels: {fishing_count}", size=8, weight="bold", dy=0.027)
    write(
        "Event: "
        + ", ".join(f"{key}={event_counts.get(key, 0)}" for key in ["go_dark", "spoofing", "transshipment", "normal"]),
        size=7.4,
        color="#334155",
        dy=0.038,
    )

    labels = rows["event_type"].fillna("unknown").astype(str) if total else pd.Series(dtype=str)
    section("GO DARK", rows[labels.eq("go_dark")] if total else rows, EVENT_STYLES["go_dark"]["color"])
    section("SPOOFING", rows[labels.eq("spoofing")] if total else rows, "#b77900")
    section("TRANSSHIPMENT", rows[labels.eq("transshipment")] if total else rows, "#008f52")
    section("FISHING + GEAR", rows[rows.apply(is_fishing_row, axis=1)] if total else rows, "#0f766e")


def trajectory_residual_summary(trajectories: pd.DataFrame) -> pd.DataFrame:
    if trajectories.empty:
        return pd.DataFrame()
    records = []
    for _, row in trajectories.iterrows():
        raw_lat = to_float(row.get("raw_lat"))
        raw_lon = to_float(row.get("raw_lon"))
        kalman_lat = to_float(row.get("kalman_lat"))
        kalman_lon = to_float(row.get("kalman_lon"))
        raw_x = to_float(row.get("raw_x"))
        raw_y = to_float(row.get("raw_y"))
        kalman_x = to_float(row.get("trajectory_kalman_x"))
        kalman_y = to_float(row.get("trajectory_kalman_y"))
        if None in [raw_lat, raw_lon, kalman_lat, kalman_lon, raw_x, raw_y, kalman_x, kalman_y]:
            continue
        records.append(
            {
                "MMSI": normalize_mmsi(row.get("MMSI")),
                "residual_m": haversine_km(raw_lat, raw_lon, kalman_lat, kalman_lon) * 1000,
                "residual_px": math.hypot(raw_x - kalman_x, raw_y - kalman_y),
            }
        )
    if not records:
        return pd.DataFrame()
    residuals = pd.DataFrame(records)
    return (
        residuals.groupby("MMSI")
        .agg(points=("MMSI", "size"), mean_m=("residual_m", "mean"), max_m=("residual_m", "max"), mean_px=("residual_px", "mean"), max_px=("residual_px", "max"))
        .reset_index()
    )


def draw_residual_panel(ax, trajectories: pd.DataFrame) -> None:
    summary = trajectory_residual_summary(trajectories)
    if summary.empty:
        ax.text(0.03, 0.03, "AIS-Kalman residual: no trajectory data", transform=ax.transAxes, fontsize=7, color="#64748b")
        return
    lines = ["AIS-Kalman residual (kenapa garis tampak menumpuk):"]
    for _, row in summary.iterrows():
        lines.append(
            f"MMSI {row['MMSI']}: mean {row['mean_m']:.1f} m / max {row['max_m']:.1f} m "
            f"({row['mean_px']:.2f}-{row['max_px']:.2f} px)"
        )
    ax.text(
        0.03,
        0.03,
        "\n".join(lines),
        transform=ax.transAxes,
        ha="left",
        va="bottom",
        fontsize=7,
        color="#0f172a",
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#cbd5e1", "alpha": 0.88},
        zorder=20,
    )


def render_detection_kalman_png(
    out_png: Path,
    image: np.ndarray,
    rows: pd.DataFrame,
    trajectories: pd.DataFrame,
    transformer: GCPTransformer,
    window: Window,
    scale: float,
    scene: str,
    polarization: str,
) -> None:
    fig_h = max(6.5, 11.5 * image.shape[0] / image.shape[1])
    fig = plt.figure(figsize=(15.8, fig_h), dpi=180, facecolor="white")
    gs = fig.add_gridspec(1, 2, width_ratios=[4.9, 1.45], wspace=0.055)
    ax = fig.add_subplot(gs[0, 0])
    panel = fig.add_subplot(gs[0, 1])

    ax.imshow(image, cmap="gray", origin="upper")
    add_geo_ticks(ax, transformer, window, scale, image.shape)
    add_scale_bar(ax, transformer, window, scale, image.shape)
    add_north_arrow(ax, transformer, window, scale, image.shape)

    drew_ais_pings = False
    drew_raw_ais = False
    drew_kalman = False
    drew_residual = False
    if not trajectories.empty:
        for _, group in trajectories.groupby("MMSI", sort=False):
            group = group.sort_values("trajectory_time", na_position="last")
            raw_pts = local_points(group, "raw_x", "raw_y", window, scale)
            kalman_pts = local_points(group, "trajectory_kalman_x", "trajectory_kalman_y", window, scale)
            raw_valid = [(x, y) for x, y in raw_pts if np.isfinite(x) and np.isfinite(y)]
            kalman_valid = [(x, y) for x, y in kalman_pts if np.isfinite(x) and np.isfinite(y)]

            if len(raw_valid) >= 2:
                xs, ys = zip(*raw_valid)
                ax.plot(xs, ys, color="#00b7ff", linewidth=1.15, linestyle="--", alpha=0.8, zorder=4)
                drew_raw_ais = True
            if raw_valid:
                xs, ys = zip(*raw_valid)
                ax.scatter(xs, ys, s=10, c="#a3e635", edgecolors="black", linewidths=0.25, alpha=0.9, zorder=4)
                drew_ais_pings = True
            if len(kalman_valid) >= 2:
                xs, ys = zip(*kalman_valid)
                ax.plot(xs, ys, color="#ffd21a", linewidth=1.55, alpha=0.93, zorder=5)
                ax.scatter(xs, ys, s=8, c="#ffd21a", edgecolors="black", linewidths=0.2, alpha=0.8, zorder=5)
                drew_kalman = True
            elif len(kalman_valid) == 1:
                ax.scatter([kalman_valid[0][0]], [kalman_valid[0][1]], s=16, c="#ffd21a", edgecolors="black", linewidths=0.3, zorder=5)
                drew_kalman = True

            for raw, kalman in zip(raw_pts, kalman_pts):
                rx, ry = raw
                kx, ky = kalman
                if not all(np.isfinite(v) for v in [rx, ry, kx, ky]):
                    continue
                residual_px = math.hypot(rx - kx, ry - ky)
                if residual_px < 0.35:
                    continue
                ax.plot([rx, kx], [ry, ky], color="#ffffff", linewidth=1.05, alpha=0.75, zorder=6)
                ax.plot([rx, kx], [ry, ky], color="#a855f7", linewidth=0.7, alpha=0.9, zorder=7)
                drew_residual = True

    for _, row in rows.iterrows():
        sar = local_point(row, "sar_x", "sar_y", window, scale)
        kalman = local_point(row, "kalman_x", "kalman_y", window, scale)
        ais = local_point(row, "ais_x", "ais_y", window, scale)
        p = kalman or ais or sar
        event = clean_text(row.get("event_type")) or "unknown"
        style = EVENT_STYLES.get(event, EVENT_STYLES["unknown"])
        color = style["color"]

        if sar:
            ax.add_patch(Circle(sar, radius=9, fill=False, edgecolor="#ff1a1a", linewidth=1.35, zorder=7))
        if sar and p and p != sar:
            ax.plot([p[0], sar[0]], [p[1], sar[1]], color="white", linewidth=1.25, alpha=0.72, zorder=6)
            ax.plot([p[0], sar[0]], [p[1], sar[1]], color=color, linewidth=0.85, alpha=0.92, zorder=7)
        if p:
            ax.scatter([p[0]], [p[1]], s=24, c=[color], edgecolors="black", linewidths=0.45, zorder=8)
        if sar and is_fishing_row(row):
            label = f"{normalize_mmsi(row.get('MMSI'))}\n{vessel_gear(row)}"
            ax.text(
                sar[0] + 10,
                sar[1] - 10,
                label,
                fontsize=5.8,
                color="white",
                ha="left",
                va="top",
                zorder=9,
                bbox={"boxstyle": "round,pad=0.18", "facecolor": "black", "edgecolor": "none", "alpha": 0.55},
            )

    handles = [
        Line2D([0], [0], marker="o", color="none", markerfacecolor="none", markeredgecolor="#ff1a1a", markersize=7, label="SAR targets"),
        Line2D([0], [0], color="#ff6b6b", linewidth=1.1, label="AIS/Kalman to SAR lines"),
        Line2D([0], [0], color=EVENT_STYLES["go_dark"]["color"], marker="o", linestyle="none", markeredgecolor="black", markersize=6, label="GoDark"),
        Line2D([0], [0], color=EVENT_STYLES["spoofing"]["color"], marker="o", linestyle="none", markeredgecolor="black", markersize=6, label="Spoofing"),
        Line2D([0], [0], color=EVENT_STYLES["transshipment"]["color"], marker="o", linestyle="none", markeredgecolor="black", markersize=6, label="Transshipment"),
    ]
    if drew_kalman:
        handles.append(Line2D([0], [0], color="#ffd21a", linewidth=1.8, label="Kalman trajectory"))
    if drew_raw_ais:
        handles.append(Line2D([0], [0], color="#00b7ff", linewidth=1.2, linestyle="--", label="Raw AIS trajectory"))
    if drew_ais_pings:
        handles.append(Line2D([0], [0], marker="o", color="none", markerfacecolor="#a3e635", markeredgecolor="black", markersize=6, label="AIS pings"))
    if drew_residual:
        handles.append(Line2D([0], [0], color="#a855f7", linewidth=1.1, label="Raw AIS to Kalman residual"))
    handles.append(Line2D([0], [0], marker="s", color="none", markerfacecolor="black", markeredgecolor="white", markersize=7, label="Fishing gear label"))
    ax.legend(handles=handles, loc="lower left", framealpha=0.88, facecolor="white", edgecolor="black", fontsize=7.5)
    draw_residual_panel(ax, trajectories)

    event_counts = rows["event_type"].value_counts().to_dict() if not rows.empty else {}
    counts_text = ", ".join(f"{k}: {v}" for k, v in event_counts.items())
    ax.set_title(
        f"{scene} | Sentinel-1 {polarization.upper()} | SAR detection + Kalman trajectory | {counts_text}",
        fontsize=9.5,
        pad=14,
    )
    ax.set_xlim(0, image.shape[1])
    ax.set_ylim(image.shape[0], 0)
    ax.set_facecolor("black")

    draw_detection_panel(panel, rows, scene)
    fig.savefig(out_png, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def render_scene(zip_path: Path, args: argparse.Namespace) -> list[Path]:
    scene = normalize_scene_name(zip_path)
    measurement = find_measurement(zip_path, args.polarization)
    raster_path = vsizip_path(zip_path, measurement)
    rows = load_scene_rows(scene, args.predictions, args.all_predictions, args.metadata)
    trajectories = load_trajectory_points(args.trajectory_points, rows, scene, args)

    with rasterio.open(raster_path) as src:
        gcps, gcp_crs = src.gcps
        if not gcps or str(gcp_crs).upper() != "EPSG:4326":
            raise ValueError(f"{zip_path.name} has no EPSG:4326 GCP geolocation.")

        transformer = GCPTransformer(gcps)
        rows = sar_and_ais_pixels(rows, transformer)
        trajectories = add_trajectory_pixels(trajectories, transformer)
        window = compute_window(rows, src.width, src.height, args.margin_px, args.full_scene)
        image, scale = read_display_image(src, window, args.max_size)

        args.output_dir.mkdir(parents=True, exist_ok=True)
        background_png = args.output_dir / f"{scene}_{args.polarization.lower()}_sar_background.png"
        html_path = args.output_dir / f"{scene}_{args.polarization.lower()}_interactive.html"
        clean_html_path = args.output_dir / f"{scene}_{args.polarization.lower()}_clean.html"
        out_png = args.output_dir / f"{scene}_{args.polarization.lower()}_scene_map.png"
        detection_png = args.output_dir / f"{scene}_{args.polarization.lower()}_detection_kalman.png"
        outputs = [background_png, out_png, detection_png]
        mpl_image.imsave(background_png, image, cmap="gray", vmin=0, vmax=1)
        html_data = scene_html_data(rows, trajectories, window, scale, image.shape)
        if not args.png_only:
            write_interactive_html(html_path, background_png.name, scene, args.polarization, html_data)
            clean_subtitle = args.clean_subtitle or (
                f"{scene} | window pixel "
                f"x={int(window.col_off)}:{int(window.col_off + window.width)}, "
                f"y={int(window.row_off)}:{int(window.row_off + window.height)} | tanpa overlay"
            )
            write_clean_html(
                clean_html_path,
                background_png.name,
                scene,
                args.polarization,
                image.shape,
                args.clean_title,
                clean_subtitle,
            )
            outputs.extend([html_path, clean_html_path])

        fig_w = 12
        fig_h = max(6, fig_w * image.shape[0] / image.shape[1])
        fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=180)
        ax.imshow(image, cmap="gray", origin="upper")

        add_geo_ticks(ax, transformer, window, scale, image.shape)
        add_scale_bar(ax, transformer, window, scale, image.shape)
        add_north_arrow(ax, transformer, window, scale, image.shape)

        drew_raw_trajectory = False
        drew_kalman_trajectory = False
        if not trajectories.empty:
            for _, group in trajectories.groupby("MMSI", sort=False):
                group = group.sort_values("trajectory_time", na_position="last")
                raw_pts = local_points(group, "raw_x", "raw_y", window, scale)
                kalman_pts = local_points(group, "trajectory_kalman_x", "trajectory_kalman_y", window, scale)
                raw_valid = [(x, y) for x, y in raw_pts if np.isfinite(x) and np.isfinite(y)]
                kalman_valid = [(x, y) for x, y in kalman_pts if np.isfinite(x) and np.isfinite(y)]

                if len(raw_valid) >= 2:
                    xs, ys = zip(*raw_pts)
                    ax.plot(xs, ys, color="#00b7ff", linewidth=1.1, alpha=0.78, linestyle="--", zorder=3)
                    drew_raw_trajectory = True
                elif len(raw_valid) == 1:
                    ax.scatter([raw_valid[0][0]], [raw_valid[0][1]], s=12, c="#00b7ff", edgecolors="black", linewidths=0.25, zorder=4)

                if len(kalman_valid) >= 2:
                    xs, ys = zip(*kalman_pts)
                    ax.plot(xs, ys, color="#ffd21a", linewidth=1.25, alpha=0.88, zorder=4)
                    drew_kalman_trajectory = True
                elif len(kalman_valid) == 1:
                    ax.scatter([kalman_valid[0][0]], [kalman_valid[0][1]], s=12, c="#ffd21a", edgecolors="black", linewidths=0.25, zorder=4)

        for _, row in rows.iterrows():
            sar = local_point(row, "sar_x", "sar_y", window, scale)
            ais = local_point(row, "kalman_x", "kalman_y", window, scale) or local_point(row, "ais_x", "ais_y", window, scale)
            event = clean_text(row.get("event_type")) or "unknown"
            style = EVENT_STYLES.get(event, EVENT_STYLES["unknown"])
            color = style["color"]

            if sar:
                ax.add_patch(Circle(sar, radius=9, fill=False, edgecolor="#ff1a1a", linewidth=1.4))
            if sar and ais:
                ax.plot([ais[0], sar[0]], [ais[1], sar[1]], color="white", linewidth=0.9, alpha=0.75)
                ax.plot([ais[0], sar[0]], [ais[1], sar[1]], color=color, linewidth=0.65, alpha=0.9)
            if ais:
                ax.scatter([ais[0]], [ais[1]], s=24, c=[color], edgecolors="black", linewidths=0.4, zorder=5)
            if sar and event == "go_dark":
                ax.scatter([sar[0]], [sar[1]], s=18, c=[color], edgecolors="white", linewidths=0.3, zorder=6)

        handles = [
            Line2D([0], [0], marker="o", color="none", markerfacecolor="none", markeredgecolor="#ff1a1a", markersize=7, label="SAR targets"),
            Line2D([0], [0], color="white", linewidth=1, label="AIS/Kalman to SAR"),
        ]
        if drew_raw_trajectory:
            handles.append(Line2D([0], [0], color="#00b7ff", linewidth=1.2, linestyle="--", label="AIS trajectory"))
        if drew_kalman_trajectory:
            handles.append(Line2D([0], [0], color="#ffd21a", linewidth=1.4, label="Kalman trajectory"))
        present = set(rows["event_type"].fillna("unknown").astype(str))
        for key in ["go_dark", "spoofing", "transshipment", "normal", "unknown"]:
            if key in present:
                handles.append(
                    Line2D(
                        [0],
                        [0],
                        marker="o",
                        color="none",
                        markerfacecolor=EVENT_STYLES[key]["color"],
                        markeredgecolor="black",
                        markersize=7,
                        label=EVENT_STYLES[key]["label"],
                    )
                )
        ax.legend(handles=handles, loc="lower left", framealpha=0.88, facecolor="white", edgecolor="black", fontsize=8)

        event_counts = rows["event_type"].value_counts().to_dict() if not rows.empty else {}
        counts_text = ", ".join(f"{k}: {v}" for k, v in event_counts.items())
        ax.set_title(f"{scene} | Sentinel-1 {args.polarization.upper()} | {len(rows)} SAR-linked vessels ({counts_text})", fontsize=10, pad=16)
        ax.set_xlim(0, image.shape[1])
        ax.set_ylim(image.shape[0], 0)
        ax.set_facecolor("black")
        fig.tight_layout()

        fig.savefig(out_png, bbox_inches="tight")
        plt.close(fig)

        render_detection_kalman_png(
            detection_png,
            image,
            rows,
            trajectories,
            transformer,
            window,
            scale,
            scene,
            args.polarization,
        )

    if not args.png_only:
        pixel_csv = args.output_dir / f"{scene}_{args.polarization.lower()}_scene_points.csv"
        keep = [
            c
            for c in [
                "scene",
                "MMSI",
                "Name",
                "category",
                "event_type",
                "pred_label",
                "go_dark_probability_calibrated",
                "alat_tangkap",
                "Center_latitude",
                "Center_longitude",
                "AIS_Latitude",
                "AIS_Longitude",
                "kalman_est_lat",
                "kalman_est_lon",
                "sar_x",
                "sar_y",
                "ais_x",
                "ais_y",
                "kalman_x",
                "kalman_y",
            ]
            if c in rows.columns
        ]
        rows[keep].to_csv(pixel_csv, index=False)
        outputs.append(pixel_csv)
        if not trajectories.empty:
            trajectory_csv = args.output_dir / f"{scene}_{args.polarization.lower()}_scene_trajectories.csv"
            trajectories.to_csv(trajectory_csv, index=False)
            outputs.append(trajectory_csv)
    return outputs


def main() -> None:
    args = parse_args()
    if args.scene_zip:
        zips = [args.scene_zip]
    else:
        zips = sorted(args.scenes_dir.glob("S1*.zip"))
    if not zips:
        raise FileNotFoundError(f"No Sentinel-1 zip files found in {args.scenes_dir}")

    outputs = []
    for zip_path in zips:
        outputs.extend(render_scene(zip_path, args))
    for output in outputs:
        print(output)


if __name__ == "__main__":
    main()
