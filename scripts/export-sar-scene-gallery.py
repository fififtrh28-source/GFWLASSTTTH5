#!/usr/bin/env python3
"""
Export annotated SAR patch figures for detected/candidate vessels.

The available workspace assets are SAR target patches, not full Sentinel-1
swath rasters. This exporter therefore creates one review image per SAR target
patch and an HTML gallery grouped by godark/spoofing/transshipment.
"""

from __future__ import annotations

import argparse
import html
import math
import shutil
import textwrap
from pathlib import Path

import pandas as pd
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps


DEFAULT_CANDIDATES = Path("KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv")
DEFAULT_METADATA = Path("new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv")
DEFAULT_OUTPUT_DIR = Path("KAPAL YG TERDETEKSI/SAR_SCENE_GALLERY")
DEFAULT_IMAGE_ROOTS = [Path("new/Patch_RGB"), Path("RUNYOLO_FINALBISMILLAH/new/Patch_RGB")]

TYPE_COLORS = {
    "godark": (255, 80, 80),
    "spoofing": (255, 196, 0),
    "transshipment": (60, 220, 120),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, default=DEFAULT_CANDIDATES)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--types", default="godark,spoofing,transshipment")
    parser.add_argument("--max-per-type", type=int, default=999999)
    return parser.parse_args()


def font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    names = [
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/calibrib.ttf" if bold else "C:/Windows/Fonts/calibri.ttf",
    ]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def clean_text(value: object) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value)


def to_float(value: object) -> float | None:
    try:
        x = float(value)
        if math.isnan(x):
            return None
        return x
    except Exception:
        return None


def resolve_image(name: object) -> Path | None:
    text = clean_text(name).strip()
    if not text:
        return None
    path = Path(text)
    if path.exists():
        return path
    for root in DEFAULT_IMAGE_ROOTS:
        candidate = root / path.name
        if candidate.exists():
            return candidate
    return None


def normalize_patch(img: Image.Image, size: int = 256) -> Image.Image:
    img = ImageOps.exif_transpose(img).convert("RGB")
    img = ImageOps.autocontrast(img)
    img = ImageEnhance.Contrast(img).enhance(1.25)
    return img.resize((size, size), Image.Resampling.BILINEAR)


def patch_point(row: pd.Series, x_col: str, y_col: str) -> tuple[float, float] | None:
    x = to_float(row.get(x_col))
    y = to_float(row.get(y_col))
    ulx = to_float(row.get("UpperLeft_x"))
    uly = to_float(row.get("UpperLeft_y"))
    if x is None or y is None or ulx is None or uly is None:
        return None
    return x - ulx, y - uly


def scale_point(point: tuple[float, float] | None, src_size: int, dst_size: int = 256) -> tuple[float, float] | None:
    if point is None:
        return None
    sx = dst_size / max(1, src_size)
    sy = dst_size / max(1, src_size)
    return point[0] * sx, point[1] * sy


def annotate_patch(img: Image.Image, row: pd.Series, color: tuple[int, int, int]) -> Image.Image:
    out = img.copy()
    draw = ImageDraw.Draw(out)
    src_size = 64
    ulx = to_float(row.get("UpperLeft_x"))
    lrx = to_float(row.get("LowerRight_x"))
    if ulx is not None and lrx is not None and lrx > ulx:
        src_size = int(lrx - ulx)

    center = scale_point(patch_point(row, "Center_x", "Center_y"), src_size)
    head = scale_point(patch_point(row, "Head_x", "Head_y"), src_size)
    tail = scale_point(patch_point(row, "Tail_x", "Tail_y"), src_size)

    if head and tail:
        draw.line([tail, head], fill=(255, 255, 255), width=3)
        draw.ellipse((head[0] - 4, head[1] - 4, head[0] + 4, head[1] + 4), fill=(255, 255, 255))
    if center:
        x, y = center
        r = 16
        draw.ellipse((x - r, y - r, x + r, y + r), outline=color, width=4)
        draw.line((x - 8, y, x + 8, y), fill=color, width=2)
        draw.line((x, y - 8, x, y + 8), fill=color, width=2)

    return out


def text_panel(row: pd.Series, candidate_type: str, evidence: str, width: int, height: int) -> Image.Image:
    panel = Image.new("RGB", (width, height), (18, 18, 18))
    draw = ImageDraw.Draw(panel)
    title_font = font(20, True)
    body_font = font(14)
    small_font = font(12)
    color = TYPE_COLORS.get(candidate_type, (255, 255, 255))

    y = 16
    draw.text((18, y), candidate_type.upper(), fill=color, font=title_font)
    y += 32

    fields = [
        ("Scene", clean_text(row.get("scene"))),
        ("MMSI", clean_text(row.get("MMSI"))),
        ("Name", clean_text(row.get("Name")) or clean_text(row.get("gfw_name"))),
        ("Type", clean_text(row.get("Ship_Type")) or clean_text(row.get("gfw_shiptype")) or clean_text(row.get("category"))),
        ("SOG/COG", f"{clean_text(row.get('Sog'))} kn / {clean_text(row.get('Cog'))} deg"),
        ("SAR lat/lon", f"{clean_text(row.get('Center_latitude'))}, {clean_text(row.get('Center_longitude'))}"),
        ("AIS lat/lon", f"{clean_text(row.get('AIS_Latitude'))}, {clean_text(row.get('AIS_Longitude'))}"),
        ("Gap", f"{clean_text(row.get('AIS_update_time_gap_hours'))} hours"),
        ("Score", clean_text(row.get("score"))),
    ]

    for label, value in fields:
        if not value or value == ", ":
            continue
        draw.text((18, y), f"{label}: ", fill=(190, 190, 190), font=body_font)
        wrapped = textwrap.wrap(value, width=42) or [value]
        x = 105
        for i, line in enumerate(wrapped[:3]):
            draw.text((x, y + i * 17), line, fill=(245, 245, 245), font=body_font)
        y += max(20, len(wrapped[:3]) * 17)

    y += 8
    draw.text((18, y), "Evidence:", fill=(190, 190, 190), font=body_font)
    y += 20
    for line in textwrap.wrap(clean_text(evidence), width=54)[:8]:
        draw.text((18, y), line, fill=(230, 230, 230), font=small_font)
        y += 15
    return panel


def make_figure(row: pd.Series, output_path: Path) -> tuple[Path | None, Path | None]:
    vv_path = resolve_image(row.get("patch_rgb_vv_actual_file"))
    vh_path = resolve_image(row.get("patch_rgb_vh_actual_file"))
    if vv_path is None:
        vv_path = resolve_image(row.get("patch_vv_actual_file"))
    if vh_path is None:
        vh_path = resolve_image(row.get("patch_vh_actual_file"))
    if vv_path is None and vh_path is None:
        return None, None

    candidate_type = clean_text(row.get("candidate_type"))
    color = TYPE_COLORS.get(candidate_type, (255, 80, 80))

    vv = normalize_patch(Image.open(vv_path)) if vv_path else Image.new("RGB", (256, 256), (0, 0, 0))
    vh = normalize_patch(Image.open(vh_path)) if vh_path else Image.new("RGB", (256, 256), (0, 0, 0))
    vv = annotate_patch(vv, row, color)
    vh = annotate_patch(vh, row, color)
    panel = text_panel(row, candidate_type, clean_text(row.get("evidence")), 520, 256)

    header_h = 42
    out = Image.new("RGB", (256 + 256 + 520, 256 + header_h), (10, 10, 10))
    draw = ImageDraw.Draw(out)
    title = f"SAR SCENE PATCH | {candidate_type.upper()} | MMSI {clean_text(row.get('MMSI'))}"
    draw.text((14, 10), title, fill=(245, 245, 245), font=font(18, True))
    draw.text((14, 27), "VV / main polarization", fill=(210, 210, 210), font=font(11))
    draw.text((270, 27), "VH polarization", fill=(210, 210, 210), font=font(11))
    out.paste(vv, (0, header_h))
    out.paste(vh, (256, header_h))
    out.paste(panel, (512, header_h))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(output_path)
    return vv_path, vh_path


def safe_name(row: pd.Series, index: int) -> str:
    scene = clean_text(row.get("scene"))[-20:]
    mmsi = clean_text(row.get("MMSI")) or "unknown"
    ctype = clean_text(row.get("candidate_type")) or "scene"
    return f"{index:03d}_{ctype}_{mmsi}_{scene}.png".replace(":", "-").replace("/", "_").replace("\\", "_")


def create_html(manifest: pd.DataFrame, output_dir: Path) -> Path:
    html_path = output_dir / "index.html"
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<title>SAR Scene Gallery</title>",
        "<style>body{font-family:Arial,sans-serif;background:#111;color:#eee;margin:24px}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:18px}",
        ".card{background:#1b1b1b;border:1px solid #333;padding:10px}",
        "img{width:100%;height:auto;display:block}.meta{font-size:12px;color:#ccc;margin-top:8px}",
        "h2{margin-top:28px}</style></head><body>",
        "<h1>SAR Scene Gallery</h1>",
        "<p>Annotated SAR target patches exported from local scene metadata.</p>",
    ]
    for ctype, group in manifest.groupby("candidate_type", sort=False):
        parts.append(f"<h2>{html.escape(str(ctype).upper())} ({len(group)})</h2><div class='grid'>")
        for _, row in group.iterrows():
            rel = Path(row["figure_path"]).name
            parts.append("<div class='card'>")
            parts.append(f"<img src='{html.escape(rel)}' alt='SAR scene patch'>")
            parts.append(
                "<div class='meta'>"
                f"MMSI {html.escape(clean_text(row.get('MMSI')))} | "
                f"Scene {html.escape(clean_text(row.get('scene')))} | "
                f"Score {html.escape(clean_text(row.get('score')))}"
                "</div>"
            )
            parts.append("</div>")
        parts.append("</div>")
    parts.append("</body></html>")
    html_path.write_text("\n".join(parts), encoding="utf-8")
    return html_path


def main() -> None:
    args = parse_args()
    if not args.candidates.exists():
        raise FileNotFoundError(f"Candidate CSV not found: {args.candidates}")
    if not args.metadata.exists():
        raise FileNotFoundError(f"Metadata CSV not found: {args.metadata}")

    selected_types = [x.strip() for x in args.types.split(",") if x.strip()]
    candidates = pd.read_csv(args.candidates, low_memory=False)
    metadata = pd.read_csv(args.metadata, low_memory=False)

    join_cols = ["scene", "MMSI"]
    data = candidates.merge(metadata, on=join_cols, how="left", suffixes=("", "_meta"))
    data = data[data["candidate_type"].isin(selected_types)].copy()
    data = data.drop_duplicates(
        subset=["candidate_type", "scene", "MMSI", "neighbor_mmsi", "patch_rgb_vv_actual_file", "patch_rgb_vh_actual_file"],
        keep="first",
    )
    data["score_num"] = pd.to_numeric(data.get("score"), errors="coerce").fillna(0)
    data = data.sort_values(["candidate_type", "score_num"], ascending=[True, False])
    data = data.groupby("candidate_type", group_keys=False).head(args.max_per_type).copy()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, (_, row) in enumerate(data.iterrows(), start=1):
        out_path = args.output_dir / safe_name(row, index)
        vv_path, vh_path = make_figure(row, out_path)
        if vv_path is None and vh_path is None:
            continue
        item = {k: row.get(k, "") for k in ["candidate_type", "score", "scene", "MMSI", "Name", "evidence"]}
        item["figure_path"] = str(out_path)
        item["vv_patch_path"] = str(vv_path or "")
        item["vh_patch_path"] = str(vh_path or "")
        rows.append(item)

    manifest = pd.DataFrame(rows)
    manifest_path = args.output_dir / "manifest.csv"
    manifest.to_csv(manifest_path, index=False)
    html_path = create_html(manifest, args.output_dir) if not manifest.empty else args.output_dir / "index.html"

    print(f"Figures written: {len(manifest)}")
    print(f"Output dir: {args.output_dir}")
    print(f"Manifest: {manifest_path}")
    print(f"HTML gallery: {html_path}")


if __name__ == "__main__":
    main()
