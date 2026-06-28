#!/usr/bin/env python3
"""Download missing Sentinel-1 GRD scenes listed by the scene-priority CSV.

The script uses ASF Search to resolve official product URLs, then downloads ZIP
files into the local Sentinel-1 scene folder. It is deliberately conservative:
existing ZIP files are skipped, partial downloads use ``.part`` files, and
Earthdata credentials are required before any large download starts.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from getpass import getpass
from pathlib import Path
from typing import Iterable

import asf_search as asf
from asf_search import ASFSession


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MISSING_CSV = (
    ROOT
    / "KAPAL YG TERDETEKSI"
    / "DAFTAR_SCENE_UNTUK_DOWNLOAD_FULL_SCENE"
    / "scene_belum_terdownload.csv"
)
DEFAULT_DEST = ROOT / "KAPAL YG TERDETEKSI" / "SENTINEL1_SCENES"
DEFAULT_LOG_DIR = ROOT / "KAPAL YG TERDETEKSI" / "DOWNLOAD_LOGS"

ZIP_SUFFIX = ".zip"
PART_SUFFIX = ".zip.part"
CHUNK_SIZE = 1024 * 1024
PROGRESS_EVERY_SECONDS = 20
ALLOWED_ENV_KEYS = {
    "EARTHDATA_USERNAME",
    "EARTHDATA_PASSWORD",
    "EARTHDATA_TOKEN",
    "EDL_USERNAME",
    "EDL_PASSWORD",
    "EDL_TOKEN",
    "NASA_USERNAME",
    "NASA_PASSWORD",
    "ASF_USERNAME",
    "ASF_PASSWORD",
    "ASF_TOKEN",
}


class CredentialError(RuntimeError):
    """Raised when Earthdata credentials are missing."""


class ProductError(RuntimeError):
    """Raised when a scene cannot be resolved or downloaded."""


@dataclass
class SceneRow:
    scene: str
    candidate_rows: str = ""
    unique_mmsi: str = ""
    scene_time_utc: str = ""


@dataclass
class Product:
    scene: str
    filename: str
    url: str
    expected_bytes: int | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download missing Sentinel-1 GRD_HD scene ZIPs from ASF."
    )
    parser.add_argument("--missing-csv", type=Path, default=DEFAULT_MISSING_CSV)
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    parser.add_argument("--log-dir", type=Path, default=DEFAULT_LOG_DIR)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Optional local env file. Only Earthdata/ASF credential keys are read.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Download only N scenes.")
    parser.add_argument(
        "--start",
        type=int,
        default=0,
        help="Zero-based row offset in the missing-scene CSV.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve ASF products and estimate size, but do not download.",
    )
    parser.add_argument(
        "--allow-anonymous",
        action="store_true",
        help="Try without Earthdata credentials. Sentinel-1 ASF ZIPs usually reject this.",
    )
    parser.add_argument(
        "--username",
        default=None,
        help="Earthdata username. Prefer env EARTHDATA_USERNAME instead.",
    )
    parser.add_argument(
        "--password",
        default=None,
        help="Earthdata password. Prefer env EARTHDATA_PASSWORD instead.",
    )
    parser.add_argument(
        "--prompt-password",
        action="store_true",
        help="Prompt for Earthdata password instead of reading it from env/CLI.",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Earthdata bearer token. Prefer env EARTHDATA_TOKEN instead.",
    )
    parser.add_argument(
        "--connect-timeout",
        type=int,
        default=30,
        help="HTTP connect timeout in seconds.",
    )
    parser.add_argument(
        "--read-timeout",
        type=int,
        default=180,
        help="HTTP read timeout in seconds.",
    )
    return parser.parse_args()


def load_env_file(path: Path | None) -> None:
    if path is None:
        return
    if not path.exists():
        raise FileNotFoundError(f"Env file not found: {path}")

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if key not in ALLOWED_ENV_KEYS or os.environ.get(key):
            continue

        value = value.strip().strip('"').strip("'")
        if value:
            os.environ[key] = value


def env_first(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            value = value.strip()
            if value:
                return value
    return None


def load_rows(path: Path) -> list[SceneRow]:
    if not path.exists():
        raise FileNotFoundError(f"Missing CSV not found: {path}")

    rows: list[SceneRow] = []
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if "scene" not in (reader.fieldnames or []):
            raise ValueError(f"CSV has no 'scene' column: {path}")

        for raw in reader:
            scene = (raw.get("scene") or "").strip()
            if not scene:
                continue
            rows.append(
                SceneRow(
                    scene=scene,
                    candidate_rows=(raw.get("candidate_rows") or "").strip(),
                    unique_mmsi=(raw.get("unique_mmsi") or "").strip(),
                    scene_time_utc=(raw.get("scene_time_utc") or "").strip(),
                )
            )
    return rows


def build_session(args: argparse.Namespace) -> tuple[ASFSession, str]:
    session = ASFSession()

    token = args.token or env_first("EARTHDATA_TOKEN", "EDL_TOKEN", "ASF_TOKEN")
    if token:
        session.auth_with_token(token)
        return session, "earthdata-token"

    username = args.username or env_first(
        "EARTHDATA_USERNAME", "EDL_USERNAME", "NASA_USERNAME", "ASF_USERNAME"
    )
    password = args.password or env_first(
        "EARTHDATA_PASSWORD", "EDL_PASSWORD", "NASA_PASSWORD", "ASF_PASSWORD"
    )

    if username and args.prompt_password and not password:
        password = getpass("Earthdata password: ")

    if username and password:
        session.auth_with_creds(username=username, password=password)
        return session, "earthdata-username-password"

    if args.allow_anonymous:
        return session, "anonymous"

    raise CredentialError(
        "Earthdata login belum ditemukan. Set EARTHDATA_USERNAME dan "
        "EARTHDATA_PASSWORD, atau EARTHDATA_TOKEN, lalu jalankan lagi."
    )


def pick_zip_product(scene: str, results: Iterable[object]) -> Product:
    candidates: list[Product] = []
    for result in results:
        props = getattr(result, "properties", {}) or {}
        filename = str(props.get("fileName") or "")
        url = str(props.get("url") or "")
        if not filename.endswith(ZIP_SUFFIX) or not url.endswith(ZIP_SUFFIX):
            continue
        if not filename.startswith(scene):
            continue

        raw_bytes = props.get("bytes")
        try:
            expected_bytes = int(raw_bytes) if raw_bytes is not None else None
        except (TypeError, ValueError):
            expected_bytes = None

        candidates.append(
            Product(
                scene=scene,
                filename=filename,
                url=url,
                expected_bytes=expected_bytes,
            )
        )

    if not candidates:
        raise ProductError(f"ASF ZIP product not found for scene: {scene}")

    # Prefer the exact product name, otherwise use the largest ZIP ASF returned.
    exact_name = f"{scene}{ZIP_SUFFIX}"
    for product in candidates:
        if product.filename == exact_name:
            return product

    return max(candidates, key=lambda product: product.expected_bytes or 0)


def resolve_product(scene: str) -> Product:
    results = asf.granule_search([scene])
    return pick_zip_product(scene, results)


def human_size(num_bytes: int | None) -> str:
    if num_bytes is None:
        return "unknown"
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{num_bytes} B"


def download_product(
    product: Product,
    dest: Path,
    session: ASFSession,
    connect_timeout: int,
    read_timeout: int,
) -> tuple[str, int]:
    dest.mkdir(parents=True, exist_ok=True)
    final_path = dest / product.filename
    part_path = dest / f"{product.filename}.part"

    if final_path.exists():
        local_size = final_path.stat().st_size
        if product.expected_bytes is None or local_size == product.expected_bytes:
            return "skipped-existing", local_size
        raise ProductError(
            f"Existing ZIP size mismatch for {final_path.name}: "
            f"{local_size} != {product.expected_bytes}"
        )

    resume_from = part_path.stat().st_size if part_path.exists() else 0
    headers = {}
    mode = "wb"
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"
        mode = "ab"

    response = session.get(
        product.url,
        stream=True,
        headers=headers,
        timeout=(connect_timeout, read_timeout),
    )

    if response.status_code in (401, 403):
        response.close()
        raise CredentialError(
            "ASF menolak download (401/403). Login Earthdata belum valid "
            "atau akun belum diotorisasi untuk ASF."
        )

    if resume_from > 0 and response.status_code == 200:
        # Server ignored Range; restart cleanly instead of appending duplicate bytes.
        resume_from = 0
        mode = "wb"

    if response.status_code not in (200, 206):
        text = ""
        try:
            text = response.text[:300]
        except Exception:
            text = ""
        finally:
            response.close()
        raise ProductError(f"HTTP {response.status_code} for {product.filename}: {text}")

    downloaded = resume_from
    started_at = time.time()
    last_report = started_at
    with part_path.open(mode + "") as handle:
        for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
            if not chunk:
                continue
            handle.write(chunk)
            downloaded += len(chunk)

            now = time.time()
            if now - last_report >= PROGRESS_EVERY_SECONDS:
                speed = (downloaded - resume_from) / max(now - started_at, 1)
                print(
                    f"  progress {product.filename}: {human_size(downloaded)}"
                    f" / {human_size(product.expected_bytes)}"
                    f" at {human_size(int(speed))}/s",
                    flush=True,
                )
                last_report = now

    response.close()

    local_size = part_path.stat().st_size
    if product.expected_bytes is not None and local_size != product.expected_bytes:
        raise ProductError(
            f"Partial size mismatch for {product.filename}: "
            f"{local_size} != {product.expected_bytes}"
        )

    part_path.replace(final_path)
    return "downloaded", final_path.stat().st_size


def open_log(log_dir: Path) -> tuple[Path, object, csv.DictWriter]:
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = log_dir / f"sentinel1_download_log_{stamp}.csv"
    handle = path.open("w", newline="", encoding="utf-8")
    writer = csv.DictWriter(
        handle,
        fieldnames=[
            "time",
            "scene",
            "status",
            "filename",
            "expected_bytes",
            "local_bytes",
            "message",
        ],
    )
    writer.writeheader()
    return path, handle, writer


def log_row(
    writer: csv.DictWriter,
    scene: str,
    status: str,
    filename: str = "",
    expected_bytes: int | None = None,
    local_bytes: int | None = None,
    message: str = "",
) -> None:
    writer.writerow(
        {
            "time": datetime.now().isoformat(timespec="seconds"),
            "scene": scene,
            "status": status,
            "filename": filename,
            "expected_bytes": expected_bytes if expected_bytes is not None else "",
            "local_bytes": local_bytes if local_bytes is not None else "",
            "message": message,
        }
    )


def main() -> int:
    args = parse_args()
    rows = load_rows(args.missing_csv)
    if args.start:
        rows = rows[args.start :]
    if args.limit is not None:
        rows = rows[: args.limit]

    print(f"Missing CSV: {args.missing_csv}")
    print(f"Destination: {args.dest}")
    print(f"Rows selected: {len(rows)}")
    print(f"Mode: {'dry-run' if args.dry_run else 'download'}")

    if not rows:
        return 0

    load_env_file(args.env_file)

    session: ASFSession | None = None
    auth_mode = "not-needed-dry-run"
    if not args.dry_run:
        session, auth_mode = build_session(args)
    print(f"Auth mode: {auth_mode}")

    log_path, log_handle, writer = open_log(args.log_dir)
    print(f"Log: {log_path}")

    ok = 0
    failed = 0
    skipped = 0
    total_expected = 0
    try:
        for index, row in enumerate(rows, start=1):
            print(f"[{index}/{len(rows)}] {row.scene}", flush=True)
            try:
                product = resolve_product(row.scene)
                if product.expected_bytes:
                    total_expected += product.expected_bytes

                if args.dry_run:
                    status = "dry-run"
                    local_bytes = 0
                    print(
                        f"  {product.filename} | {human_size(product.expected_bytes)}"
                    )
                else:
                    assert session is not None
                    status, local_bytes = download_product(
                        product=product,
                        dest=args.dest,
                        session=session,
                        connect_timeout=args.connect_timeout,
                        read_timeout=args.read_timeout,
                    )
                    print(
                        f"  {status}: {product.filename}"
                        f" | {human_size(local_bytes)}",
                        flush=True,
                    )

                if status.startswith("skipped"):
                    skipped += 1
                else:
                    ok += 1
                log_row(
                    writer,
                    scene=row.scene,
                    status=status,
                    filename=product.filename,
                    expected_bytes=product.expected_bytes,
                    local_bytes=local_bytes,
                )
                log_handle.flush()
            except Exception as exc:
                failed += 1
                print(f"  FAILED: {exc}", file=sys.stderr, flush=True)
                log_row(writer, row.scene, "failed", message=str(exc))
                log_handle.flush()
                if isinstance(exc, CredentialError):
                    break
    finally:
        log_handle.close()

    print(
        f"Done. ok={ok}, skipped={skipped}, failed={failed}, "
        f"estimated_selected_size={human_size(total_expected)}"
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CredentialError as exc:
        print(f"Credential error: {exc}", file=sys.stderr)
        raise SystemExit(2)
