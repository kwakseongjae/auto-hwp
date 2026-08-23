#!/usr/bin/env python3
"""Bounded #102 SVG-sink ↔ PDF-sink parity integration check.

The comparison stays report-only for visual quality. Its only pass/fail assertion is narrower: the
known equation/chart object interiors must contain real ink in both the SVG-derived T3 reference and
the own PDF export. That catches the historical whole-object placeholder without inventing a document
quality threshold.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Dict, Iterable, List, Tuple


REPO = Path(__file__).resolve().parents[1]
DPI = 144
PX_SCALE = DPI / 96.0
INK_THRESHOLD = 200
MIN_INTERIOR_INK = 12
MAX_OUTPUT_BYTES = 2 * 1024 * 1024


class CheckError(RuntimeError):
    pass


def run(args: List[str], *, cwd: Path = REPO, timeout: int = 180) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    output = result.stdout[:MAX_OUTPUT_BYTES].decode("utf-8", "replace")
    if result.returncode != 0:
        raise CheckError(f"{' '.join(args[:3])} exited {result.returncode}:\n{output}")
    return output


def require_tools(names: Iterable[str]) -> None:
    missing = [name for name in names if shutil.which(name) is None]
    if missing:
        raise CheckError("required tools unavailable: " + ", ".join(missing))


def read_pgm(path: Path) -> Tuple[int, int, bytes]:
    data = path.read_bytes()
    if not data.startswith(b"P5"):
        raise CheckError(f"not a binary PGM: {path}")
    index = 2

    def token() -> bytes:
        nonlocal index
        while index < len(data):
            if data[index] == ord("#"):
                end = data.find(b"\n", index)
                index = len(data) if end < 0 else end + 1
            elif chr(data[index]).isspace():
                index += 1
            else:
                break
        start = index
        while index < len(data) and not chr(data[index]).isspace():
            index += 1
        if start == index:
            raise CheckError(f"truncated PGM header: {path}")
        return data[start:index]

    width = int(token())
    height = int(token())
    maximum = int(token())
    if maximum != 255 or width <= 0 or height <= 0:
        raise CheckError(f"unsupported PGM dimensions/range: {path}")
    if index >= len(data) or not chr(data[index]).isspace():
        raise CheckError(f"PGM raster separator missing: {path}")
    # Consume the header separator, not arbitrary whitespace-valued raster bytes.
    index += 2 if data[index : index + 2] == b"\r\n" else 1
    pixels = data[index:]
    if len(pixels) != width * height:
        raise CheckError(f"PGM byte count mismatch: {path}")
    return width, height, pixels


def raster(pdf: Path, prefix: Path) -> Tuple[int, int, bytes]:
    run(
        [
            "pdftoppm",
            "-f",
            "1",
            "-l",
            "1",
            "-singlefile",
            "-gray",
            "-r",
            str(DPI),
            str(pdf),
            str(prefix),
        ],
        timeout=60,
    )
    return read_pgm(prefix.with_suffix(".pgm"))


def boxes(path: Path) -> List[Dict[str, float | str]]:
    with path.open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream, delimiter="\t"))
    if sorted(row["kind"] for row in rows) != ["chart", "equation"]:
        raise CheckError("fixture must contain exactly one equation and one chart box")
    parsed: List[Dict[str, float | str]] = []
    for row in rows:
        values = {key: float(row[key]) for key in ("x_px", "y_px", "w_px", "h_px")}
        if not all(math.isfinite(value) and value >= 0 for value in values.values()):
            raise CheckError("box coordinates must be finite and non-negative")
        parsed.append({"kind": row["kind"], **values})
    return parsed


def interior_ink(
    image: Tuple[int, int, bytes], box: Dict[str, float | str]
) -> int:
    width, height, pixels = image
    x = int(round(float(box["x_px"]) * PX_SCALE))
    y = int(round(float(box["y_px"]) * PX_SCALE))
    w = int(round(float(box["w_px"]) * PX_SCALE))
    h = int(round(float(box["h_px"]) * PX_SCALE))
    # Ignore the placeholder's outline. Its #f0f0f0 fill is also above INK_THRESHOLD, whereas actual
    # equation/chart marks are darker and remain inside this inset.
    inset = max(3, min(w, h) // 20)
    x0, y0 = max(0, x + inset), max(0, y + inset)
    x1, y1 = min(width, x + w - inset), min(height, y + h - inset)
    if x1 <= x0 or y1 <= y0:
        raise CheckError(f"degenerate clipped {box['kind']} box")
    return sum(
        1
        for yy in range(y0, y1)
        for value in pixels[yy * width + x0 : yy * width + x1]
        if value <= INK_THRESHOLD
    )


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parsed = parser.parse_args(argv)
    output = Path(parsed.output_dir).resolve()
    if output.exists():
        raise CheckError(f"refusing to overwrite output directory: {output}")
    output.mkdir(parents=True, mode=0o700)

    require_tools(("cargo", "rsvg-convert", "pdfinfo", "pdftoppm"))
    run(
        [
            "cargo",
            "run",
            "-q",
            "-p",
            "hwp-export",
            "--features",
            "pdf",
            "--example",
            "svg_pdf_parity",
            "--",
            str(output),
        ]
    )
    reference = output / "svg-reference.pdf"
    run(
        [
            "rsvg-convert",
            "--format",
            "pdf",
            "--output",
            str(reference),
            str(output / "own.svg"),
        ],
        timeout=60,
    )

    report_dir = output / "visual-report"
    run(
        [
            sys.executable,
            str(REPO / "scripts/pdf-visual-check.py"),
            str(output / "own.pdf"),
            "--reference",
            str(reference),
            "--reference-tier",
            "T3",
            "--reference-product",
            "librsvg",
            "--reference-note",
            "Controlled own-SVG debug rendering; not ground truth and no quality threshold.",
            "--output-dir",
            str(report_dir),
        ],
        timeout=180,
    )
    report = json.loads((report_dir / "report.json").read_text(encoding="utf-8"))
    if report.get("status") != "scored_report" or report.get("policy", {}).get("pass") is not None:
        raise CheckError("visual oracle must produce one report-only scored page")

    own_image = raster(output / "own.pdf", output / "own-page")
    reference_image = raster(reference, output / "reference-page")
    if own_image[:2] != reference_image[:2]:
        raise CheckError(f"raster dimensions differ: {own_image[:2]} vs {reference_image[:2]}")

    results = []
    for box in boxes(output / "boxes.tsv"):
        own_ink = interior_ink(own_image, box)
        reference_ink = interior_ink(reference_image, box)
        if own_ink < MIN_INTERIOR_INK or reference_ink < MIN_INTERIOR_INK:
            raise CheckError(
                f"{box['kind']} lost interior ink: own={own_ink}, reference={reference_ink}"
            )
        ratio = own_ink / reference_ink
        if not 0.05 <= ratio <= 20.0:
            raise CheckError(f"{box['kind']} gross ink mismatch: ratio={ratio:.4f}")
        results.append(
            {
                "kind": box["kind"],
                "own_interior_ink_pixels": own_ink,
                "reference_interior_ink_pixels": reference_ink,
                "ratio": round(ratio, 6),
            }
        )

    summary = {
        "schema_version": 1,
        "policy": "presence-only; visual quality remains report-only",
        "dpi": DPI,
        "ink_threshold": INK_THRESHOLD,
        "objects": results,
        "visual_report_status": report["status"],
    }
    (output / "parity-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        "PDF SVG parity OK: "
        + ", ".join(
            f"{item['kind']} own/ref ink={item['own_interior_ink_pixels']}/"
            f"{item['reference_interior_ink_pixels']}"
            for item in results
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CheckError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"pdf-svg-parity-check: {error}", file=sys.stderr)
        raise SystemExit(1)
