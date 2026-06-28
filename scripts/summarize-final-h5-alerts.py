#!/usr/bin/env python3
"""Summarize final H5 alert predictions and compare them with rule-based output."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_INPUT = Path("KAPAL YG TERDETEKSI/final_h5_alert_predictions.csv")
DEFAULT_OUTPUT = Path("KAPAL YG TERDETEKSI/final_h5_alert_summary.csv")
DEFAULT_RULE_SUMMARY = Path("KAPAL YG TERDETEKSI/scene_candidates_summary.csv")
DEFAULT_COMPARISON_OUTPUT = Path("KAPAL YG TERDETEKSI/h5_vs_rule_based_comparison.csv")
DEFAULT_REPORT = Path("KAPAL YG TERDETEKSI/h5_inference_report.json")

ALERT_ORDER = ["go_dark", "spoofing", "transshipment", "normal", "not_available"]
ALERT_TO_PIPELINE = {
    "go_dark": "godark",
    "spoofing": "spoofing",
    "transshipment": "transshipment",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="H5 prediction CSV.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="H5 summary CSV.")
    parser.add_argument("--rule-summary", type=Path, default=DEFAULT_RULE_SUMMARY, help="Rule-based summary CSV.")
    parser.add_argument(
        "--comparison-output",
        type=Path,
        default=DEFAULT_COMPARISON_OUTPUT,
        help="H5 vs rule-based comparison CSV.",
    )
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="H5 inference report JSON.")
    return parser.parse_args()


def normalize_alert(value: object) -> str:
    text = "" if pd.isna(value) else str(value).strip().lower()
    return {
        "godark": "go_dark",
        "go-dark": "go_dark",
        "go dark": "go_dark",
        "potential_transshipment": "transshipment",
    }.get(text, text or "not_available")


def summarize_predictions(path: Path) -> tuple[pd.DataFrame, Counter[str], int]:
    if not path.exists():
        raise FileNotFoundError(f"H5 prediction CSV not found: {path}")
    df = pd.read_csv(path, low_memory=False)
    if "alert_type" not in df.columns:
        columns = ", ".join(df.columns)
        raise ValueError(f"Column alert_type not found in {path}. Available columns: {columns}")

    labels = df["alert_type"].map(normalize_alert)
    counts: Counter[str] = Counter(labels)
    total = int(len(df))

    ordered = list(ALERT_ORDER)
    for label in sorted(counts):
        if label not in ordered:
            ordered.append(label)

    rows = []
    for label in ordered:
        count = int(counts.get(label, 0))
        percentage = (count / total * 100.0) if total else 0.0
        rows.append({"alert_type": label, "jumlah": count, "persentase": f"{percentage:.2f}"})
    return pd.DataFrame(rows), counts, total


def read_rule_counts(path: Path) -> tuple[dict[str, int], int]:
    if not path.exists():
        raise FileNotFoundError(f"Rule-based summary CSV not found: {path}")
    df = pd.read_csv(path, low_memory=False)
    label_col = "candidate_type" if "candidate_type" in df.columns else "alert_type"
    count_col = "count" if "count" in df.columns else "jumlah"
    if label_col not in df.columns or count_col not in df.columns:
        columns = ", ".join(df.columns)
        raise ValueError(f"Rule summary has no candidate/count columns. Available columns: {columns}")

    counts = {"go_dark": 0, "spoofing": 0, "transshipment": 0}
    for _, row in df.iterrows():
        label = normalize_alert(row.get(label_col))
        if label in counts:
            counts[label] += int(float(row.get(count_col, 0)))
    return counts, int(sum(counts.values()))


def read_pipeline_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    status = {}
    for pipeline, item in data.get("feature_status", {}).items():
        status[pipeline] = {
            "status": item.get("status"),
            "missing_features": item.get("missing_features", []),
        }
    return status


def h5_count_value(label: str, counts: Counter[str], pipeline_status: dict[str, Any]) -> int | str:
    pipeline = ALERT_TO_PIPELINE[label]
    status = pipeline_status.get(pipeline, {}).get("status")
    if status != "ran":
        return "not_available"
    return int(counts.get(label, 0))


def numeric_sum(values: list[int | str]) -> int:
    total = 0
    for value in values:
        if isinstance(value, int):
            total += value
    return total


def write_comparison(
    path: Path,
    rule_summary: Path,
    h5_summary: Path,
    h5_counts: Counter[str],
    pipeline_status: dict[str, Any],
) -> pd.DataFrame:
    rule_counts, rule_total = read_rule_counts(rule_summary)

    h5_values = [
        h5_count_value("go_dark", h5_counts, pipeline_status),
        h5_count_value("spoofing", h5_counts, pipeline_status),
        h5_count_value("transshipment", h5_counts, pipeline_status),
    ]
    notes = []
    for pipeline in ["godark", "spoofing", "transshipment"]:
        status = pipeline_status.get(pipeline, {}).get("status")
        if status != "ran":
            missing = pipeline_status.get(pipeline, {}).get("missing_features", [])
            if missing:
                notes.append(f"{pipeline} not run: missing {', '.join(missing)}")
            else:
                notes.append(f"{pipeline} not run")

    rows = [
        {
            "method": "rule_based",
            "go_dark_count": rule_counts["go_dark"],
            "spoofing_count": rule_counts["spoofing"],
            "transshipment_count": rule_counts["transshipment"],
            "total_alert": rule_total,
            "source_file": str(rule_summary),
            "notes": "",
        },
        {
            "method": "h5",
            "go_dark_count": h5_values[0],
            "spoofing_count": h5_values[1],
            "transshipment_count": h5_values[2],
            "total_alert": numeric_sum(h5_values),
            "source_file": str(h5_summary),
            "notes": "; ".join(notes),
        },
    ]
    out = pd.DataFrame(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False)
    return out


def main() -> None:
    args = parse_args()
    summary, counts, total = summarize_predictions(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    summary.to_csv(args.output, index=False)

    pipeline_status = read_pipeline_status(args.report)
    comparison = write_comparison(args.comparison_output, args.rule_summary, args.output, counts, pipeline_status)

    print(f"Prediction rows: {total}")
    print(f"H5 summary CSV: {args.output}")
    print(summary.to_string(index=False))
    print(f"Comparison CSV: {args.comparison_output}")
    print(comparison.to_string(index=False))


if __name__ == "__main__":
    main()
