#!/usr/bin/env python3
"""Render downloaded Sentinel-1 ZIP scenes into presentation PNGs.

This is a batch wrapper around ``export-sentinel1-scene-map.py``. It keeps the
heavy ASF ZIP downloads separate from the rendered PNG outputs, skips rendered
scenes, and writes a CSV log so a long run can be resumed safely.
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCENES_DIR = ROOT / "KAPAL YG TERDETEKSI" / "SENTINEL1_SCENES"
DEFAULT_SIMPLE_OUT = ROOT / "KAPAL YG TERDETEKSI" / "HASIL_TRAJECTORY_AIS_KALMAN_SIMPLE"
DEFAULT_MAPS_OUT = ROOT / "KAPAL YG TERDETEKSI" / "SENTINEL1_SCENE_MAPS"
DEFAULT_TRAJECTORY_POINTS = ROOT / "new" / "metadata" / "ais_trajectory_points_raw_vs_kalman.csv"
DEFAULT_PRIORITY_CSV = (
    ROOT
    / "KAPAL YG TERDETEKSI"
    / "DAFTAR_SCENE_UNTUK_DOWNLOAD_FULL_SCENE"
    / "scene_download_priority_all_candidates.csv"
)
DEFAULT_LOG_DIR = ROOT / "KAPAL YG TERDETEKSI" / "RENDER_LOGS"
EXPORT_SCRIPT = ROOT / "scripts" / "export-sentinel1-scene-map.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes-dir", type=Path, default=DEFAULT_SCENES_DIR)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--trajectory-points", type=Path, default=DEFAULT_TRAJECTORY_POINTS)
    parser.add_argument("--priority-csv", type=Path, default=DEFAULT_PRIORITY_CSV)
    parser.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR)
    parser.add_argument("--mode", choices=["simple", "maps"], default="simple")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--start", type=int, default=0, help="Zero-based offset after ordering.")
    parser.add_argument("--max-size", type=int, default=1800)
    parser.add_argument("--margin-px", type=int, default=900)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def scene_name(zip_path: Path) -> str:
    return zip_path.stem


def load_priority(path: Path) -> list[str]:
    if not path.exists():
        return []

    scenes: list[str] = []
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if "scene" not in (reader.fieldnames or []):
            return []
        for row in reader:
            scene = (row.get("scene") or "").strip()
            if scene:
                scenes.append(Path(scene).stem)
    return scenes


def ordered_zips(scenes_dir: Path, priority_csv: Path) -> list[Path]:
    zips = {scene_name(path): path for path in scenes_dir.glob("S1*.zip")}
    priority = load_priority(priority_csv)

    ordered: list[Path] = []
    seen: set[str] = set()
    for scene in priority:
        path = zips.get(scene)
        if path is not None and scene not in seen:
            ordered.append(path)
            seen.add(scene)

    for scene, path in sorted(zips.items()):
        if scene not in seen:
            ordered.append(path)
    return ordered


def expected_output(output_dir: Path, scene: str, mode: str) -> Path:
    if mode == "simple":
        return output_dir / f"{scene}_vv_ais_kalman_simple.png"
    return output_dir / f"{scene}_vv_detection_kalman.png"


def open_log(log_dir: Path) -> tuple[Path, object, csv.DictWriter]:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"sentinel1_render_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    handle = path.open("w", newline="", encoding="utf-8")
    writer = csv.DictWriter(
        handle,
        fieldnames=["time", "scene", "status", "output", "message"],
    )
    writer.writeheader()
    return path, handle, writer


def log_row(writer: csv.DictWriter, scene: str, status: str, output: Path | str = "", message: str = "") -> None:
    writer.writerow(
        {
            "time": datetime.now().isoformat(timespec="seconds"),
            "scene": scene,
            "status": status,
            "output": str(output),
            "message": message,
        }
    )


def render_one(zip_path: Path, args: argparse.Namespace, output_dir: Path) -> subprocess.CompletedProcess[str]:
    cmd = [
        sys.executable,
        "-B",
        str(EXPORT_SCRIPT),
        "--scene-zip",
        str(zip_path),
        "--output-dir",
        str(output_dir),
        "--trajectory-points",
        str(args.trajectory_points),
        "--max-size",
        str(args.max_size),
        "--margin-px",
        str(args.margin_px),
    ]
    if args.mode == "simple":
        cmd.append("--simple-trajectory-only")
    else:
        cmd.append("--png-only")

    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir or (DEFAULT_SIMPLE_OUT if args.mode == "simple" else DEFAULT_MAPS_OUT)
    output_dir.mkdir(parents=True, exist_ok=True)

    zips = ordered_zips(args.scenes_dir, args.priority_csv)
    if args.start:
        zips = zips[args.start :]
    if args.limit is not None:
        zips = zips[: args.limit]

    print(f"Scenes dir: {args.scenes_dir}")
    print(f"Output dir: {output_dir}")
    print(f"Mode: {args.mode}")
    print(f"Selected ZIPs: {len(zips)}")
    if args.dry_run:
        for zip_path in zips[:20]:
            scene = scene_name(zip_path)
            status = "render" if args.overwrite or not expected_output(output_dir, scene, args.mode).exists() else "skip"
            print(f"{status}: {zip_path.name}")
        if len(zips) > 20:
            print(f"... {len(zips) - 20} more")
        return 0

    log_path, handle, writer = open_log(args.log_dir)
    print(f"Log: {log_path}")

    rendered = 0
    skipped = 0
    failed = 0
    try:
        for index, zip_path in enumerate(zips, start=1):
            scene = scene_name(zip_path)
            out = expected_output(output_dir, scene, args.mode)
            print(f"[{index}/{len(zips)}] {scene}", flush=True)

            if out.exists() and not args.overwrite:
                skipped += 1
                print(f"  skip existing: {out.name}", flush=True)
                log_row(writer, scene, "skipped", out)
                handle.flush()
                continue

            result = render_one(zip_path, args, output_dir)
            if result.returncode == 0 and out.exists():
                rendered += 1
                print(f"  rendered: {out.name}", flush=True)
                log_row(writer, scene, "rendered", out, result.stdout.strip())
            else:
                failed += 1
                message = (result.stderr or result.stdout).strip()
                print(f"  failed: {message[:500]}", flush=True)
                log_row(writer, scene, "failed", out, message)
            handle.flush()
    finally:
        handle.close()

    print(f"Done. rendered={rendered}, skipped={skipped}, failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
