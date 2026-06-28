#!/usr/bin/env python3
"""Render one Sentinel-1 scene as a paper-style overview map."""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from zipfile import ZipFile

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Polygon, Rectangle
from matplotlib.ticker import FuncFormatter
import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import GCPTransformer


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCENES_DIR = ROOT / "KAPAL YG TERDETEKSI" / "SENTINEL1_SCENES"
DEFAULT_METADATA = ROOT / "new" / "metadata" / "metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv"
DEFAULT_PREDICTIONS = ROOT / "KAPAL YG TERDETEKSI" / "godark_h5_predictions_by_scene.csv"
DEFAULT_TRAJECTORY = ROOT / "new" / "metadata" / "ais_trajectory_points_raw_vs_kalman.csv"
DEFAULT_OUTPUT_DIR = ROOT / "KAPAL YG TERDETEKSI" / "HASIL_PAPER_STYLE_SINGLE_SCENE"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", default=None, help="Scene name without .zip. Default: scene with most linked vessels.")
    parser.add_argument("--scene-zip", type=Path, default=None)
    parser.add_argument("--scenes-dir", type=Path, default=DEFAULT_SCENES_DIR)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS)
    parser.add_argument("--trajectory", type=Path, default=DEFAULT_TRAJECTORY)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--polarization", choices=["vv", "vh"], default="vv")
    parser.add_argument("--max-size", type=int, default=950)
    parser.add_argument("--dpi", type=int, default=220)
    return parser.parse_args()


def clean_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).strip()


def normalize_scene(value: object) -> str:
    text = Path(clean_text(value)).name
    for suffix in [".zip", ".SAFE", ".safe"]:
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    return text


def normalize_mmsi(value: object) -> str:
    text = clean_text(value)
    return text[:-2] if text.endswith(".0") else text


def choose_scene(metadata_path: Path, scenes_dir: Path) -> str:
    local_scenes = {path.stem for path in scenes_dir.glob("S1*.zip")}
    counts: dict[str, int] = {}
    with metadata_path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            scene = normalize_scene(row.get("scene"))
            if scene in local_scenes:
                counts[scene] = counts.get(scene, 0) + 1
    if not counts:
        raise RuntimeError("No local scenes with metadata rows were found.")
    return max(counts.items(), key=lambda item: item[1])[0]


def find_measurement(zip_path: Path, polarization: str) -> str:
    needle = f"-{polarization.lower()}-"
    with ZipFile(zip_path) as archive:
        matches = [
            name
            for name in archive.namelist()
            if "/measurement/" in name.lower()
            and needle in name.lower()
            and name.lower().endswith((".tif", ".tiff"))
        ]
    if not matches:
        raise FileNotFoundError(f"No {polarization.upper()} measurement TIFF found in {zip_path}")
    return matches[0]


def read_scene_rows(scene: str, metadata_path: Path, predictions_path: Path) -> pd.DataFrame:
    metadata = pd.read_csv(metadata_path, low_memory=False, dtype={"MMSI": str})
    metadata["scene_norm"] = metadata["scene"].map(normalize_scene)
    rows = metadata[metadata["scene_norm"].eq(scene)].copy()
    if rows.empty:
        raise RuntimeError(f"No metadata rows found for {scene}")

    rows["MMSI"] = rows["MMSI"].map(normalize_mmsi)
    rows["pred_label"] = "normal"
    rows["go_dark_probability_calibrated"] = np.nan

    if predictions_path.exists():
        pred = pd.read_csv(predictions_path, low_memory=False, dtype={"MMSI": str})
        pred["scene_norm"] = pred["scene"].map(normalize_scene)
        pred["MMSI"] = pred["MMSI"].map(normalize_mmsi)
        pred = pred[pred["scene_norm"].eq(scene)].copy()
        if not pred.empty:
            keep = [
                col
                for col in ["scene_norm", "MMSI", "pred_label", "go_dark_probability_calibrated"]
                if col in pred.columns
            ]
            pred = pred[keep].drop_duplicates(["scene_norm", "MMSI"], keep="last")
            rows = rows.merge(pred, on=["scene_norm", "MMSI"], how="left", suffixes=("", "_pred"))
            for col in ["pred_label", "go_dark_probability_calibrated"]:
                pred_col = f"{col}_pred"
                if pred_col in rows.columns:
                    rows[col] = rows[pred_col].combine_first(rows[col])
                    rows = rows.drop(columns=[pred_col])
    rows["pred_label"] = rows["pred_label"].fillna("normal").astype(str)
    return rows


def read_trajectory(scene: str, trajectory_path: Path) -> pd.DataFrame:
    if not trajectory_path.exists():
        return pd.DataFrame()
    df = pd.read_csv(trajectory_path, low_memory=False, dtype={"MMSI": str})
    if "scene" not in df.columns:
        return pd.DataFrame()
    df["scene_norm"] = df["scene"].map(normalize_scene)
    df = df[df["scene_norm"].eq(scene)].copy()
    if "MMSI" in df.columns:
        df["MMSI"] = df["MMSI"].map(normalize_mmsi)
    return df


def display_image(src: rasterio.io.DatasetReader, max_size: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[tuple[float, float]]]:
    scale = max(src.width, src.height) / max_size
    out_width = max(2, int(round(src.width / scale)))
    out_height = max(2, int(round(src.height / scale)))
    raw = src.read(
        1,
        out_shape=(out_height, out_width),
        resampling=Resampling.bilinear,
        masked=True,
    ).astype("float32")
    arr = np.ma.filled(raw, np.nan)
    arr[arr <= 0] = np.nan
    arr = np.log1p(arr)
    valid = arr[np.isfinite(arr)]
    if valid.size:
        lo, hi = np.nanpercentile(valid, [2, 99.6])
        arr = np.clip((arr - lo) / max(hi - lo, 1e-6), 0, 1)
        arr = arr ** 0.82
    else:
        arr = np.zeros_like(arr)
    arr = np.nan_to_num(arr, nan=0.0)

    transformer = GCPTransformer(src.gcps[0])
    row_edges = np.linspace(0, src.height, out_height + 1)
    col_edges = np.linspace(0, src.width, out_width + 1)
    cc, rr = np.meshgrid(col_edges, row_edges)
    xs, ys = transformer.xy(rr.ravel(), cc.ravel())
    lon_grid = np.asarray(xs).reshape(rr.shape)
    lat_grid = np.asarray(ys).reshape(rr.shape)

    corner_cols = [0, src.width, src.width, 0]
    corner_rows = [0, 0, src.height, src.height]
    cxs, cys = transformer.xy(corner_rows, corner_cols)
    footprint = list(zip(map(float, cxs), map(float, cys)))
    return arr, lon_grid, lat_grid, footprint


def deg_label(value: float, axis: str) -> str:
    hemi = "E" if axis == "lon" and value >= 0 else "W" if axis == "lon" else "N" if value >= 0 else "S"
    value = abs(value)
    return f"{value:.1f} deg {hemi}"


def add_scale_bar(ax: plt.Axes, x0: float, y0: float, km: int, segments: int = 4) -> None:
    lat = y0
    deg = km / (111.32 * max(math.cos(math.radians(lat)), 0.2))
    seg = deg / segments
    height = (ax.get_ylim()[1] - ax.get_ylim()[0]) * 0.008
    for i in range(segments):
        color = "black" if i % 2 == 0 else "white"
        ax.add_patch(Rectangle((x0 + i * seg, y0), seg, height, facecolor=color, edgecolor="black", linewidth=0.5, zorder=20))
    ax.text(x0, y0 + height * 2.0, "0", fontsize=7, ha="center", va="bottom")
    ax.text(x0 + deg / 2, y0 + height * 2.0, f"{km // 2}", fontsize=7, ha="center", va="bottom")
    ax.text(x0 + deg, y0 + height * 2.0, f"{km} km", fontsize=7, ha="center", va="bottom")


def add_north_arrow(ax: plt.Axes, x: float, y: float, size: float) -> None:
    ax.annotate(
        "N",
        xy=(x, y + size),
        xytext=(x, y),
        ha="center",
        va="center",
        fontsize=11,
        fontweight="bold",
        arrowprops={"arrowstyle": "-|>", "facecolor": "black", "edgecolor": "black", "lw": 1.2},
        zorder=30,
    )


def plot_points(ax: plt.Axes, rows: pd.DataFrame, traj: pd.DataFrame) -> None:
    sar_lon = pd.to_numeric(rows["Center_longitude"], errors="coerce")
    sar_lat = pd.to_numeric(rows["Center_latitude"], errors="coerce")
    ais_lon = pd.to_numeric(rows["AIS_Longitude"], errors="coerce")
    ais_lat = pd.to_numeric(rows["AIS_Latitude"], errors="coerce")
    kal_lon = pd.to_numeric(rows.get("kalman_est_lon"), errors="coerce")
    kal_lat = pd.to_numeric(rows.get("kalman_est_lat"), errors="coerce")

    if not traj.empty and {"ais_lon", "ais_lat"}.issubset(traj.columns):
        ax.scatter(
            pd.to_numeric(traj["ais_lon"], errors="coerce"),
            pd.to_numeric(traj["ais_lat"], errors="coerce"),
            s=10,
            c="#00f020",
            edgecolors="none",
            alpha=0.72,
            zorder=7,
        )

    ax.scatter(ais_lon, ais_lat, s=22, c="#00f020", edgecolors="black", linewidths=0.25, alpha=0.95, zorder=9)
    ax.scatter(kal_lon, kal_lat, s=24, c="#ffd21a", marker="^", edgecolors="black", linewidths=0.3, alpha=0.95, zorder=9)
    ax.scatter(sar_lon, sar_lat, s=38, facecolors="none", edgecolors="#ff1a1a", marker="s", linewidths=1.15, zorder=11)

    dark = rows["pred_label"].eq("go_dark")
    if dark.any():
        ax.scatter(
            sar_lon[dark],
            sar_lat[dark],
            s=44,
            c="#0b63ff",
            marker="v",
            edgecolors="black",
            linewidths=0.35,
            alpha=0.98,
            zorder=12,
        )


def render(args: argparse.Namespace) -> Path:
    scene = normalize_scene(args.scene_zip) if args.scene_zip else normalize_scene(args.scene) if args.scene else choose_scene(args.metadata, args.scenes_dir)
    zip_path = args.scene_zip or (args.scenes_dir / f"{scene}.zip")
    if not zip_path.exists():
        raise FileNotFoundError(zip_path)

    rows = read_scene_rows(scene, args.metadata, args.predictions)
    traj = read_trajectory(scene, args.trajectory)
    measurement = find_measurement(zip_path, args.polarization)
    raster_path = f"/vsizip/{zip_path.resolve().as_posix()}/{measurement}"

    with rasterio.open(raster_path) as src:
        if not src.gcps[0]:
            raise RuntimeError(f"{zip_path.name} has no GCP geolocation.")
        image, lon_grid, lat_grid, footprint = display_image(src, args.max_size)

    xs = [p[0] for p in footprint]
    ys = [p[1] for p in footprint]
    all_lon = list(xs) + pd.to_numeric(rows["Center_longitude"], errors="coerce").dropna().tolist()
    all_lat = list(ys) + pd.to_numeric(rows["Center_latitude"], errors="coerce").dropna().tolist()
    pad_lon = max((max(all_lon) - min(all_lon)) * 0.12, 0.12)
    pad_lat = max((max(all_lat) - min(all_lat)) * 0.12, 0.12)
    xmin, xmax = min(all_lon) - pad_lon, max(all_lon) + pad_lon
    ymin, ymax = min(all_lat) - pad_lat, max(all_lat) + pad_lat

    fig, ax = plt.subplots(figsize=(12.2, 8.2), dpi=args.dpi)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#a9e4f4")

    # Light decorative land blocks for context when no coastline dataset is available.
    land_color = "#f7e6b4"
    ax.add_patch(Polygon([(xmin, ymax), (xmin + 0.52 * (xmax - xmin), ymax), (xmin + 0.38 * (xmax - xmin), ymax - 0.16 * (ymax - ymin)), (xmin, ymax - 0.13 * (ymax - ymin))], closed=True, facecolor=land_color, edgecolor="#9b8c65", linewidth=0.6, zorder=0))
    ax.add_patch(Polygon([(xmax - 0.20 * (xmax - xmin), ymin), (xmax, ymin), (xmax, ymin + 0.18 * (ymax - ymin)), (xmax - 0.10 * (xmax - xmin), ymin + 0.10 * (ymax - ymin))], closed=True, facecolor=land_color, edgecolor="#9b8c65", linewidth=0.6, zorder=0))

    ax.pcolormesh(lon_grid, lat_grid, image, cmap="gray", shading="auto", zorder=3)
    ax.add_patch(Polygon(footprint, closed=True, facecolor="none", edgecolor="#303030", linewidth=1.05, zorder=6))
    plot_points(ax, rows, traj)

    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_aspect("equal", adjustable="box")
    ax.grid(True, color="#5d95a3", alpha=0.45, linewidth=0.55)
    ax.tick_params(top=True, right=True, direction="inout", length=4, labelsize=8)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _pos: deg_label(value, "lon")))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _pos: deg_label(value, "lat")))

    scale_km = 50 if (xmax - xmin) < 3.5 else 100
    add_scale_bar(ax, xmin + 0.05 * (xmax - xmin), ymin + 0.05 * (ymax - ymin), scale_km)
    add_north_arrow(ax, xmax - 0.08 * (xmax - xmin), ymax - 0.13 * (ymax - ymin), 0.09 * (ymax - ymin))

    total_sar = len(rows)
    total_ais = len(traj) if not traj.empty else int(rows["AIS_Latitude"].notna().sum())
    total_dark = int(rows["pred_label"].eq("go_dark").sum())
    total_kalman = int(rows.get("kalman_est_lat", pd.Series(dtype=float)).notna().sum())
    handles = [
        Line2D([0], [0], marker="s", color="none", markerfacecolor="none", markeredgecolor="#ff1a1a", markeredgewidth=1.4, markersize=8, label=f"Assigned SAR: {total_sar}"),
        Line2D([0], [0], marker="o", color="none", markerfacecolor="#00f020", markeredgecolor="black", markersize=8, label=f"AIS: {total_ais}"),
        Line2D([0], [0], marker="^", color="none", markerfacecolor="#ffd21a", markeredgecolor="black", markersize=8, label=f"Kalman: {total_kalman}"),
        Line2D([0], [0], marker="v", color="none", markerfacecolor="#0b63ff", markeredgecolor="black", markersize=8, label=f"Go-dark ships: {total_dark}"),
    ]
    legend = ax.legend(handles=handles, loc="lower right", frameon=True, facecolor="white", edgecolor="#333333", framealpha=0.94, fontsize=9, borderpad=0.9)
    legend.get_frame().set_linewidth(0.8)

    inset = ax.inset_axes([0.045, 0.755, 0.25, 0.19])
    inset.set_facecolor("#a9e4f4")
    inset.add_patch(Rectangle((108, -8), 22, 12, facecolor=land_color, edgecolor="#9b8c65", linewidth=0.55))
    inset.add_patch(Polygon(footprint, closed=True, facecolor="none", edgecolor="#e24a5a", linewidth=1.1))
    inset.set_xlim(min(108, xmin - 2), max(124, xmax + 2))
    inset.set_ylim(min(-8, ymin - 2), max(5, ymax + 2))
    inset.set_xticks([])
    inset.set_yticks([])
    for spine in inset.spines.values():
        spine.set_edgecolor("#6b7280")
        spine.set_linewidth(0.65)
    inset.text(0.03, 0.05, "Inset lokasi scene", transform=inset.transAxes, fontsize=7, color="#374151")

    ax.set_title(
        f"{scene} | Sentinel-1 {args.polarization.upper()} | one-scene SAR/AIS/Kalman overview",
        fontsize=11,
        pad=12,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    out = args.output_dir / f"{scene}_{args.polarization.lower()}_paper_style_single_scene.png"
    fig.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return out


def main() -> None:
    out = render(parse_args())
    print(out)


if __name__ == "__main__":
    main()
