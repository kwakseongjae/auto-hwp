#!/usr/bin/env python3
"""Report-only visual comparison for a candidate PDF and an explicit reference.

This is intentionally independent from hwp-fidelity.  The candidate is expected
to be a PDF already exported by auto-hwp's own engine.  This script never
renders HWP/HWPX itself, never assigns a pass/fail verdict, and never promotes a
reference to ground truth without the caller supplying a T0/T1/T2/T3 tier.

Only Python's standard library and Poppler's ``pdfinfo``/``pdftoppm`` are used.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import platform
import re
import signal
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

try:
    import resource as posix_resource
except ImportError:  # pragma: no cover - exercised only on non-POSIX Python.
    posix_resource = None  # type: ignore[assignment]


SCHEMA_VERSION = 4
DPI = 144
MAX_TRANSLATION_PX = 3
INK_THRESHOLD = 245
EDGE_TOLERANCE_PX = 2
LOCAL_SSIM_WINDOW_PX = 64
TILE_SIZE_PX = 128
PAGE_SIZE_TOLERANCE_PT = 1.0
# One point is two pixels at 144 DPI. The extra pixel covers independent
# rasterizer rounding at the page boundary; accepted pages are never scaled.
MAX_RASTER_PADDING_PX = math.ceil(PAGE_SIZE_TOLERANCE_PT * DPI / 72.0) + 1
PDF_BOX_VALIDATION_TOLERANCE_PT = 0.01

MIB = 1024 * 1024
GIB = 1024 * MIB

DEFAULT_MAX_INPUT_BYTES = 100 * MIB
DEFAULT_MAX_PAGES = 200
DEFAULT_MAX_PAGE_PIXELS = 4_500_000
DEFAULT_MAX_TOTAL_PIXELS = 250_000_000
DEFAULT_MAX_RASTER_BYTES = 64 * MIB
DEFAULT_MAX_TOTAL_RASTER_BYTES = 512 * MIB
DEFAULT_MAX_PNG_DECOMPRESSED_BYTES = 128 * MIB
DEFAULT_MAX_INK_PIXELS = 600_000
DEFAULT_MAX_ALIGNMENT_WORK = 30_000_000
DEFAULT_MAX_EDGE_WORK = 16_000_000
DEFAULT_MAX_REPORT_ASSET_BYTES = 64 * MIB
DEFAULT_MAX_REPORT_BYTES = 512 * MIB
DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES = MIB
DEFAULT_SUBPROCESS_TIMEOUT_SECONDS = 60.0

HARD_MAX_INPUT_BYTES = GIB
HARD_MAX_PAGES = 1_000
HARD_MAX_PAGE_PIXELS = 8_000_000
HARD_MAX_TOTAL_PIXELS = 1_000_000_000
HARD_MAX_RASTER_BYTES = 256 * MIB
HARD_MAX_TOTAL_RASTER_BYTES = 2 * GIB
HARD_MAX_PNG_DECOMPRESSED_BYTES = 512 * MIB
HARD_MAX_INK_PIXELS = 1_000_000
HARD_MAX_ALIGNMENT_WORK = 50_000_000
HARD_MAX_EDGE_WORK = 30_000_000
HARD_MAX_REPORT_ASSET_BYTES = 128 * MIB
HARD_MAX_REPORT_BYTES = 2 * GIB
HARD_MAX_SUBPROCESS_OUTPUT_BYTES = 4 * MIB
HARD_SUBPROCESS_TIMEOUT_SECONDS = 300.0

VISUAL_REGION_SCHEMA_VERSION = 3
MAX_VISUAL_REGION_MANIFEST_BYTES = 8 * MIB
MAX_VISUAL_REGIONS_TOTAL = 10_000
MAX_VISUAL_REGIONS_PER_PAGE = 2_000
MAX_VISUAL_REGION_PAGE_AREA_MULTIPLIER = 16
VISUAL_REGION_CATEGORIES = frozenset({"text", "table", "image", "object"})
MAX_VERTICAL_TRACE_PX = 128
HARD_MAX_VERTICAL_TRACE_WORK_PER_PAGE = 50_000_000
VERTICAL_TRACE_PROFILE_ROW_COST = 6
MAX_TEXT_RESIDUAL_TRANSLATION_PX = 32
HARD_MAX_TEXT_RESIDUAL_WORK_PER_PAGE = 50_000_000
TEXT_RESIDUAL_GEOMETRY_MIN_F1 = 0.90
TEXT_RESIDUAL_MATERIAL_GAIN = 0.15
TEXT_RESIDUAL_MIXED_GAIN = 0.05
TEXT_RESIDUAL_INK_RATIO_MIN = 0.80
TEXT_RESIDUAL_INK_RATIO_MAX = 1.25

REFERENCE_TIERS: Mapping[str, str] = {
    "T0": "Licensed Hancom Windows/WebHWP rendering with product, build, and font provenance.",
    "T1": "Official PDF confirmed to represent the same published document.",
    "T2": "HWP/HWPX pair plus stored-lineseg three-way diagnostic; not absolute visual truth.",
    "T3": "rhwp/LibreOffice or another debugging aid; never treated as ground truth.",
}


class VisualCheckError(RuntimeError):
    """Expected input, dependency, or report-generation failure."""


@dataclass(frozen=True)
class ResourceLimits:
    max_input_bytes: int
    max_pages: int
    max_page_pixels: int
    max_total_pixels: int
    max_raster_bytes: int
    max_total_raster_bytes: int
    max_png_decompressed_bytes: int
    max_ink_pixels: int
    max_alignment_work: int
    max_edge_work: int
    max_report_asset_bytes: int
    max_report_bytes: int
    max_subprocess_output_bytes: int
    subprocess_timeout_seconds: float

    def __post_init__(self) -> None:
        integer_limits = {
            "max_input_bytes": (self.max_input_bytes, HARD_MAX_INPUT_BYTES),
            "max_pages": (self.max_pages, HARD_MAX_PAGES),
            "max_page_pixels": (self.max_page_pixels, HARD_MAX_PAGE_PIXELS),
            "max_total_pixels": (self.max_total_pixels, HARD_MAX_TOTAL_PIXELS),
            "max_raster_bytes": (self.max_raster_bytes, HARD_MAX_RASTER_BYTES),
            "max_total_raster_bytes": (
                self.max_total_raster_bytes,
                HARD_MAX_TOTAL_RASTER_BYTES,
            ),
            "max_png_decompressed_bytes": (
                self.max_png_decompressed_bytes,
                HARD_MAX_PNG_DECOMPRESSED_BYTES,
            ),
            "max_ink_pixels": (self.max_ink_pixels, HARD_MAX_INK_PIXELS),
            "max_alignment_work": (
                self.max_alignment_work,
                HARD_MAX_ALIGNMENT_WORK,
            ),
            "max_edge_work": (self.max_edge_work, HARD_MAX_EDGE_WORK),
            "max_report_asset_bytes": (
                self.max_report_asset_bytes,
                HARD_MAX_REPORT_ASSET_BYTES,
            ),
            "max_report_bytes": (self.max_report_bytes, HARD_MAX_REPORT_BYTES),
            "max_subprocess_output_bytes": (
                self.max_subprocess_output_bytes,
                HARD_MAX_SUBPROCESS_OUTPUT_BYTES,
            ),
        }
        for name, (value, hard_ceiling) in integer_limits.items():
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
            if value > hard_ceiling:
                raise ValueError(
                    f"{name} {value} exceeds hard ceiling {hard_ceiling}"
                )
        timeout = self.subprocess_timeout_seconds
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("subprocess_timeout_seconds must be positive and finite")
        if timeout > HARD_SUBPROCESS_TIMEOUT_SECONDS:
            raise ValueError(
                "subprocess_timeout_seconds "
                f"{timeout:g} exceeds hard ceiling {HARD_SUBPROCESS_TIMEOUT_SECONDS:g}"
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "max_input_bytes_per_pdf": self.max_input_bytes,
            "max_pages_per_pdf": self.max_pages,
            "max_pixels_per_page": self.max_page_pixels,
            "max_total_pixels_both_pdfs": self.max_total_pixels,
            "max_raster_bytes_per_page": self.max_raster_bytes,
            "max_total_raster_bytes_both_pdfs": self.max_total_raster_bytes,
            "max_png_decompressed_bytes_per_page": self.max_png_decompressed_bytes,
            "max_ink_pixels_per_image": self.max_ink_pixels,
            "max_alignment_work_per_page": self.max_alignment_work,
            "max_edge_work_per_page": self.max_edge_work,
            "max_report_asset_bytes": self.max_report_asset_bytes,
            "max_report_bytes": self.max_report_bytes,
            "max_subprocess_output_bytes_per_command": (
                self.max_subprocess_output_bytes
            ),
            "subprocess_timeout_seconds": self.subprocess_timeout_seconds,
            "hard_ceilings": {
                "max_input_bytes_per_pdf": HARD_MAX_INPUT_BYTES,
                "max_pages_per_pdf": HARD_MAX_PAGES,
                "max_pixels_per_page": HARD_MAX_PAGE_PIXELS,
                "max_total_pixels_both_pdfs": HARD_MAX_TOTAL_PIXELS,
                "max_raster_bytes_per_page": HARD_MAX_RASTER_BYTES,
                "max_total_raster_bytes_both_pdfs": HARD_MAX_TOTAL_RASTER_BYTES,
                "max_png_decompressed_bytes_per_page": HARD_MAX_PNG_DECOMPRESSED_BYTES,
                "max_ink_pixels_per_image": HARD_MAX_INK_PIXELS,
                "max_alignment_work_per_page": HARD_MAX_ALIGNMENT_WORK,
                "max_edge_work_per_page": HARD_MAX_EDGE_WORK,
                "max_report_asset_bytes": HARD_MAX_REPORT_ASSET_BYTES,
                "max_report_bytes": HARD_MAX_REPORT_BYTES,
                "max_subprocess_output_bytes_per_command": (
                    HARD_MAX_SUBPROCESS_OUTPUT_BYTES
                ),
                "subprocess_timeout_seconds": HARD_SUBPROCESS_TIMEOUT_SECONDS,
            },
        }


@dataclass(frozen=True)
class GrayImage:
    width: int
    height: int
    pixels: bytes

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("image dimensions must be positive")
        if len(self.pixels) != self.width * self.height:
            raise ValueError("pixel byte count does not match image dimensions")


@dataclass(frozen=True)
class PdfPageInfo:
    page: int
    media_box: Tuple[float, float, float, float]
    rotation: int
    crop_box: Optional[Tuple[float, float, float, float]] = None

    @property
    def effective_crop_box(self) -> Tuple[float, float, float, float]:
        return self.media_box if self.crop_box is None else self.crop_box

    @property
    def width_pt(self) -> float:
        return abs(self.media_box[2] - self.media_box[0])

    @property
    def height_pt(self) -> float:
        return abs(self.media_box[3] - self.media_box[1])

    @property
    def crop_width_pt(self) -> float:
        crop = self.effective_crop_box
        return abs(crop[2] - crop[0])

    @property
    def crop_height_pt(self) -> float:
        crop = self.effective_crop_box
        return abs(crop[3] - crop[1])

    @property
    def crop_offset_pt(self) -> Tuple[float, float]:
        crop = self.effective_crop_box
        return (crop[0] - self.media_box[0], crop[1] - self.media_box[1])

    @property
    def orientation(self) -> str:
        width = self.crop_width_pt
        height = self.crop_height_pt
        if self.rotation % 180:
            width, height = height, width
        if math.isclose(width, height, abs_tol=PAGE_SIZE_TOLERANCE_PT):
            return "square"
        return "landscape" if width > height else "portrait"

    def validation_errors(self) -> List[str]:
        errors: List[str] = []
        media = self.media_box
        crop = self.effective_crop_box
        coordinates = media + crop
        if not all(math.isfinite(value) for value in coordinates):
            errors.append("MediaBox and CropBox coordinates must be finite")
            return errors
        if (
            isinstance(self.rotation, bool)
            or not isinstance(self.rotation, int)
            or self.rotation < 0
            or self.rotation >= 360
            or self.rotation % 90 != 0
        ):
            errors.append("page rotation must be a finite 0/90/180/270 degree integer")
        if media[2] <= media[0] or media[3] <= media[1]:
            errors.append("MediaBox must have positive width and height")
        if crop[2] <= crop[0] or crop[3] <= crop[1]:
            errors.append("CropBox must have positive width and height")
        tolerance = PDF_BOX_VALIDATION_TOLERANCE_PT
        if (
            crop[0] < media[0] - tolerance
            or crop[1] < media[1] - tolerance
            or crop[2] > media[2] + tolerance
            or crop[3] > media[3] + tolerance
        ):
            errors.append("CropBox must be contained within MediaBox")
        return errors

    def as_dict(self) -> Dict[str, Any]:
        return {
            "page": self.page,
            "media_box_pt": list(self.media_box),
            "width_pt": self.width_pt,
            "height_pt": self.height_pt,
            "crop_box_pt": list(self.effective_crop_box),
            "crop_width_pt": self.crop_width_pt,
            "crop_height_pt": self.crop_height_pt,
            "crop_offset_pt": list(self.crop_offset_pt),
            "rotation_degrees": self.rotation,
            "orientation": self.orientation,
            "validation_errors": self.validation_errors(),
        }


@dataclass(frozen=True)
class PdfInfo:
    page_count: int
    pages: Tuple[PdfPageInfo, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "page_count": self.page_count,
            "pages": [page.as_dict() for page in self.pages],
        }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot_file(source: Path, destination: Path, max_bytes: int) -> int:
    """Securely copy one regular file, bounded even if the input grows."""
    total = 0
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        input_fd = os.open(source, flags)
    except OSError as error:
        raise VisualCheckError(
            f"could not securely open input as a non-symlink regular file: {source.name}"
        ) from error
    try:
        source_stat = os.fstat(input_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise VisualCheckError(f"input is not a regular file: {source.name}")
        output_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            with (
                os.fdopen(input_fd, "rb", closefd=False) as input_stream,
                os.fdopen(output_fd, "wb", closefd=False) as output_stream,
            ):
                while True:
                    chunk = input_stream.read(min(MIB, max_bytes - total + 1))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise VisualCheckError(
                            "input exceeds --max-input-bytes "
                            f"({max_bytes} bytes): {source.name}"
                        )
                    output_stream.write(chunk)
            os.chmod(destination, 0o600)
        finally:
            os.close(output_fd)
    finally:
        os.close(input_fd)
    return total


def _reject_json_constant(value: str) -> Any:
    raise VisualCheckError(f"visual region manifest contains non-finite JSON value: {value}")


def _exact_object_keys(value: Any, expected: Set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise VisualCheckError(f"{label} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise VisualCheckError(
            f"{label} fields differ; missing={missing}, unknown={unknown}"
        )
    return value


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise VisualCheckError(f"{label} must be a finite number")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise VisualCheckError(f"{label} must be a finite number")
    return parsed


def _load_visual_regions(
    snapshot: Path,
    candidate_sha256: str,
    candidate_info: PdfInfo,
) -> Dict[str, Any]:
    try:
        document = json.loads(
            snapshot.read_text("utf-8"), parse_constant=_reject_json_constant
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VisualCheckError(f"visual region manifest is not strict UTF-8 JSON: {error}") from error
    root = _exact_object_keys(
        document,
        {"schema_version", "coordinate_space", "candidate_pdf_sha256", "pages"},
        "visual region manifest",
    )
    if root["schema_version"] != VISUAL_REGION_SCHEMA_VERSION:
        raise VisualCheckError(
            f"visual region manifest schema_version must be {VISUAL_REGION_SCHEMA_VERSION}"
        )
    if root["coordinate_space"] != "HWPUNIT":
        raise VisualCheckError("visual region manifest coordinate_space must be HWPUNIT")
    if root["candidate_pdf_sha256"] != candidate_sha256:
        raise VisualCheckError("visual region manifest candidate PDF SHA-256 mismatch")
    pages = root["pages"]
    if not isinstance(pages, list) or len(pages) != candidate_info.page_count:
        raise VisualCheckError("visual region manifest page count does not match candidate PDF")

    ids: Set[str] = set()
    total_regions = 0
    intentional_blank_text_regions = 0
    category_counts = {category: 0 for category in sorted(VISUAL_REGION_CATEGORIES)}
    for index, (page, pdf_page) in enumerate(zip(pages, candidate_info.pages), start=1):
        page = _exact_object_keys(
            page,
            {"page", "width", "height", "intentional_blank_text_regions", "regions"},
            f"visual regions page {index}",
        )
        if page["page"] != index:
            raise VisualCheckError("visual region manifest pages must be ordered and one-based")
        page_blank_regions = page["intentional_blank_text_regions"]
        if (
            isinstance(page_blank_regions, bool)
            or not isinstance(page_blank_regions, int)
            or page_blank_regions < 0
            or page_blank_regions > MAX_VISUAL_REGIONS_PER_PAGE
        ):
            raise VisualCheckError(
                "visual region intentional_blank_text_regions must be a bounded non-negative integer"
            )
        intentional_blank_text_regions += page_blank_regions
        page_width = _finite_number(page["width"], f"visual regions page {index}.width")
        page_height = _finite_number(page["height"], f"visual regions page {index}.height")
        if page_width <= 0 or page_height <= 0:
            raise VisualCheckError("visual region page dimensions must be positive")
        if (
            abs(page_width / 100.0 - pdf_page.width_pt) > PDF_BOX_VALIDATION_TOLERANCE_PT
            or abs(page_height / 100.0 - pdf_page.height_pt) > PDF_BOX_VALIDATION_TOLERANCE_PT
        ):
            raise VisualCheckError(
                f"visual regions page {index} dimensions do not match candidate PDF MediaBox"
            )
        regions = page["regions"]
        if not isinstance(regions, list) or len(regions) > MAX_VISUAL_REGIONS_PER_PAGE:
            raise VisualCheckError(
                f"visual regions page {index} exceeds {MAX_VISUAL_REGIONS_PER_PAGE} entries"
            )
        total_regions += len(regions)
        if total_regions > MAX_VISUAL_REGIONS_TOTAL:
            raise VisualCheckError(
                f"visual region manifest exceeds {MAX_VISUAL_REGIONS_TOTAL} entries"
            )
        page_region_area = 0.0
        for region_index, region in enumerate(regions):
            label = f"visual regions page {index}.regions[{region_index}]"
            region = _exact_object_keys(
                region,
                {
                    "id",
                    "category",
                    "paint_status",
                    "x",
                    "y",
                    "w",
                    "h",
                    "clipped",
                    "glyph_provenance",
                    "placed_em_bounds_hwpunit",
                },
                label,
            )
            region_id = region["id"]
            if not isinstance(region_id, str) or not re.fullmatch(
                r"(?:text|table|image|object)-[0-9]{4}", region_id
            ):
                raise VisualCheckError(f"{label}.id is invalid")
            global_id = f"{index}:{region_id}"
            if global_id in ids:
                raise VisualCheckError(f"duplicate visual region id: {global_id}")
            ids.add(global_id)
            category = region["category"]
            if category not in VISUAL_REGION_CATEGORIES or not region_id.startswith(f"{category}-"):
                raise VisualCheckError(f"{label}.category is invalid or disagrees with id")
            paint_status = region["paint_status"]
            if category == "text":
                if paint_status not in {"painted", "expected-missing"}:
                    raise VisualCheckError(f"{label}.paint_status is invalid for text")
            elif paint_status != "not-applicable":
                raise VisualCheckError(f"{label}.paint_status must be not-applicable")
            glyph_provenance = region["glyph_provenance"]
            placed_em_bounds = region["placed_em_bounds_hwpunit"]
            if category == "text":
                if glyph_provenance not in {
                    "source-text",
                    "generated-marker",
                    "page-decoration",
                    "mixed",
                    "unknown",
                }:
                    raise VisualCheckError(f"{label}.glyph_provenance is invalid for text")
                if paint_status == "expected-missing" and (
                    glyph_provenance != "unknown" or placed_em_bounds is not None
                ):
                    raise VisualCheckError(
                        f"{label} expected-missing text cannot claim placed glyph provenance"
                    )
                if paint_status == "painted" and placed_em_bounds is None:
                    raise VisualCheckError(
                        f"{label} painted text must carry placed glyph bounds"
                    )
            elif glyph_provenance != "not-applicable" or placed_em_bounds is not None:
                raise VisualCheckError(
                    f"{label} non-text region cannot claim placed glyph provenance"
                )
            if not isinstance(region["clipped"], bool):
                raise VisualCheckError(f"{label}.clipped must be boolean")
            x = _finite_number(region["x"], f"{label}.x")
            y = _finite_number(region["y"], f"{label}.y")
            width = _finite_number(region["w"], f"{label}.w")
            height = _finite_number(region["h"], f"{label}.h")
            epsilon = 1e-6
            if (
                x < -epsilon
                or y < -epsilon
                or width <= 0
                or height <= 0
                or x + width > page_width + epsilon
                or y + height > page_height + epsilon
            ):
                raise VisualCheckError(f"{label} is outside its page or has empty geometry")
            if placed_em_bounds is not None:
                placed_em_bounds = _exact_object_keys(
                    placed_em_bounds, {"x", "y", "w", "h"}, f"{label}.placed_em_bounds_hwpunit"
                )
                em_x = _finite_number(
                    placed_em_bounds["x"], f"{label}.placed_em_bounds_hwpunit.x"
                )
                em_y = _finite_number(
                    placed_em_bounds["y"], f"{label}.placed_em_bounds_hwpunit.y"
                )
                em_width = _finite_number(
                    placed_em_bounds["w"], f"{label}.placed_em_bounds_hwpunit.w"
                )
                em_height = _finite_number(
                    placed_em_bounds["h"], f"{label}.placed_em_bounds_hwpunit.h"
                )
                if (
                    em_x < -epsilon
                    or em_y < -epsilon
                    or em_width <= 0
                    or em_height <= 0
                    or em_x + em_width > page_width + epsilon
                    or em_y + em_height > page_height + epsilon
                ):
                    raise VisualCheckError(
                        f"{label}.placed_em_bounds_hwpunit is outside its page or empty"
                    )
            page_region_area += width * height
            if (
                page_region_area
                > page_width * page_height * MAX_VISUAL_REGION_PAGE_AREA_MULTIPLIER
            ):
                raise VisualCheckError(
                    f"visual regions page {index} overlap area exceeds the bounded scoring budget"
                )
            category_counts[category] += 1
    return {
        "document": document,
        "sha256": _sha256(snapshot),
        "bytes": snapshot.stat().st_size,
        "total_regions": total_regions,
        "category_counts": category_counts,
        "intentional_blank_text_regions": intentional_blank_text_regions,
    }


def _command_env() -> Dict[str, str]:
    env = os.environ.copy()
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    return env


def _file_size_limit_preexec(max_bytes: int) -> Optional[Any]:
    if posix_resource is None or not hasattr(posix_resource, "RLIMIT_FSIZE"):
        return None
    try:
        _, current_hard = posix_resource.getrlimit(posix_resource.RLIMIT_FSIZE)
    except (OSError, ValueError):
        return None
    infinity = posix_resource.RLIM_INFINITY
    effective_limit = (
        max_bytes
        if current_hard == infinity
        else min(max_bytes, int(current_hard))
    )

    def apply_limit() -> None:
        assert posix_resource is not None
        posix_resource.setrlimit(
            posix_resource.RLIMIT_FSIZE,
            (effective_limit, effective_limit),
        )

    return apply_limit


def _raster_file_size_cap_mode() -> str:
    return (
        "posix_rlimit_fsize_plus_post_write_stat"
        if _file_size_limit_preexec(DEFAULT_MAX_RASTER_BYTES) is not None
        else "post_write_stat_only_platform_fallback"
    )


@dataclass(frozen=True)
class _CommandCapture:
    returncode: int
    stdout: str
    stderr: str


def _capture_command(
    command: Sequence[str],
    timeout_seconds: float,
    output_limit_bytes: int,
    file_size_limit_bytes: Optional[int] = None,
) -> _CommandCapture:
    if (
        isinstance(output_limit_bytes, bool)
        or not isinstance(output_limit_bytes, int)
        or output_limit_bytes <= 0
    ):
        raise ValueError("subprocess output byte limit must be a positive integer")
    if output_limit_bytes > HARD_MAX_SUBPROCESS_OUTPUT_BYTES:
        raise ValueError(
            "subprocess output byte limit "
            f"{output_limit_bytes} exceeds hard ceiling "
            f"{HARD_MAX_SUBPROCESS_OUTPUT_BYTES}"
        )
    popen_options: Dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "env": _command_env(),
        "text": False,
    }
    file_size_preexec = (
        None
        if file_size_limit_bytes is None
        else _file_size_limit_preexec(file_size_limit_bytes)
    )
    if file_size_preexec is not None:
        popen_options["preexec_fn"] = file_size_preexec
    try:
        process = subprocess.Popen(list(command), **popen_options)
    except subprocess.SubprocessError as error:
        raise VisualCheckError(
            f"could not start command with configured process limits: {command[0]}"
        ) from error

    if process.stdout is None or process.stderr is None:  # pragma: no cover
        process.kill()
        process.wait()
        raise VisualCheckError(f"could not capture command output: {command[0]}")

    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    byte_count = 0
    lock = threading.Lock()
    output_limit_exceeded = threading.Event()
    read_failures: List[OSError] = []

    def drain(stream: Any, destination: bytearray) -> None:
        nonlocal byte_count
        read_chunk = getattr(stream, "read1", stream.read)
        try:
            while not output_limit_exceeded.is_set():
                chunk = read_chunk(64 * 1024)
                if not chunk:
                    return
                with lock:
                    remaining = output_limit_bytes - byte_count
                    if len(chunk) > remaining:
                        if remaining > 0:
                            destination.extend(chunk[:remaining])
                            byte_count += remaining
                        output_limit_exceeded.set()
                        return
                    destination.extend(chunk)
                    byte_count += len(chunk)
        except OSError as error:
            with lock:
                read_failures.append(error)
        finally:
            stream.close()

    readers = [
        threading.Thread(
            target=drain,
            args=(process.stdout, buffers["stdout"]),
            name=f"{command[0]}-stdout",
            daemon=True,
        ),
        threading.Thread(
            target=drain,
            args=(process.stderr, buffers["stderr"]),
            name=f"{command[0]}-stderr",
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()

    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    while process.poll() is None:
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            timed_out = True
            break
        if output_limit_exceeded.wait(timeout=min(0.05, remaining_seconds)):
            break

    if timed_out or output_limit_exceeded.is_set():
        try:
            process.kill()
        except OSError:
            pass
    try:
        returncode = process.wait(timeout=5.0)
    except subprocess.TimeoutExpired as error:  # pragma: no cover - kill should win.
        try:
            process.kill()
        except OSError:
            pass
        raise VisualCheckError(f"could not terminate command: {command[0]}") from error

    for reader in readers:
        reader.join(timeout=5.0)
    if any(reader.is_alive() for reader in readers):  # pragma: no cover
        raise VisualCheckError(f"could not finish reading command output: {command[0]}")
    if timed_out:
        raise VisualCheckError(
            f"command timed out after {timeout_seconds:g}s: {command[0]}"
        )
    if output_limit_exceeded.is_set():
        raise VisualCheckError(
            "command stdout/stderr exceeded --max-subprocess-output-bytes "
            f"{output_limit_bytes}: {command[0]}"
        )
    if read_failures:
        raise VisualCheckError(f"could not read command output: {command[0]}")
    return _CommandCapture(
        returncode=returncode,
        stdout=bytes(buffers["stdout"]).decode("utf-8", errors="replace"),
        stderr=bytes(buffers["stderr"]).decode("utf-8", errors="replace"),
    )


def _run_command(
    command: Sequence[str],
    timeout_seconds: float,
    file_size_limit_bytes: Optional[int] = None,
    output_limit_bytes: int = DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES,
) -> str:
    result = _capture_command(
        command,
        timeout_seconds,
        output_limit_bytes,
        file_size_limit_bytes=file_size_limit_bytes,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        size_signal = getattr(signal, "SIGXFSZ", None)
        if file_size_limit_bytes is not None and (
            (size_signal is not None and result.returncode == -size_signal)
            or "file size limit" in detail.lower()
        ):
            raise VisualCheckError(
                f"command exceeded runtime file-size cap {file_size_limit_bytes}: "
                f"{command[0]}"
            )
        raise VisualCheckError(f"command failed ({result.returncode}): {' '.join(command)}\n{detail}")
    return result.stdout


def _tool_version(
    command: str,
    timeout_seconds: float,
    output_limit_bytes: int = DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES,
) -> str:
    result = _capture_command(
        [command, "-v"], timeout_seconds, output_limit_bytes
    )
    output = (result.stdout + "\n" + result.stderr).strip()
    first_line = output.splitlines()[0] if output else "unknown"
    return first_line.strip()


_NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)"


def _inspect_pdf(path: Path, limits: ResourceLimits) -> PdfInfo:
    summary = _run_command(
        ["pdfinfo", str(path)],
        limits.subprocess_timeout_seconds,
        output_limit_bytes=limits.max_subprocess_output_bytes,
    )
    match = re.search(r"^Pages:\s+(\d+)\s*$", summary, re.MULTILINE)
    if not match:
        raise VisualCheckError(f"pdfinfo did not report a page count for {path}")
    page_count = int(match.group(1))
    if page_count <= 0:
        raise VisualCheckError(f"PDF has no pages: {path}")
    if page_count > limits.max_pages:
        raise VisualCheckError(
            f"PDF page count {page_count} exceeds --max-pages {limits.max_pages}: {path.name}"
        )

    details = _run_command(
        ["pdfinfo", "-f", "1", "-l", str(page_count), "-box", str(path)],
        limits.subprocess_timeout_seconds,
        output_limit_bytes=limits.max_subprocess_output_bytes,
    )
    media_boxes: Dict[int, Tuple[float, float, float, float]] = {}
    crop_boxes: Dict[int, Tuple[float, float, float, float]] = {}
    rotations: Dict[int, int] = {}

    box_pattern = re.compile(
        rf"^Page\s+(\d+)\s+MediaBox:\s+({_NUMBER})\s+({_NUMBER})\s+({_NUMBER})\s+({_NUMBER})\s*$",
        re.MULTILINE,
    )
    rotation_pattern = re.compile(
        r"^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$", re.MULTILINE
    )
    crop_pattern = re.compile(
        rf"^Page\s+(\d+)\s+CropBox:\s+({_NUMBER})\s+({_NUMBER})\s+({_NUMBER})\s+({_NUMBER})\s*$",
        re.MULTILINE,
    )
    for box_match in box_pattern.finditer(details):
        page = int(box_match.group(1))
        media_boxes[page] = tuple(float(box_match.group(index)) for index in range(2, 6))  # type: ignore[assignment]
    for crop_match in crop_pattern.finditer(details):
        page = int(crop_match.group(1))
        crop_boxes[page] = tuple(float(crop_match.group(index)) for index in range(2, 6))  # type: ignore[assignment]
    for rotation_match in rotation_pattern.finditer(details):
        page = int(rotation_match.group(1))
        rotations[page] = int(rotation_match.group(2)) % 360

    pages: List[PdfPageInfo] = []
    for page in range(1, page_count + 1):
        if page not in media_boxes:
            raise VisualCheckError(f"pdfinfo did not report page {page} MediaBox for {path}")
        if page not in rotations:
            raise VisualCheckError(f"pdfinfo did not report page {page} rotation for {path}")
        if page not in crop_boxes:
            raise VisualCheckError(f"pdfinfo did not report page {page} CropBox for {path}")
        pages.append(
            PdfPageInfo(page, media_boxes[page], rotations[page], crop_boxes[page])
        )
    return PdfInfo(page_count=page_count, pages=tuple(pages))


def _compare_pdf_structure(candidate: PdfInfo, reference: PdfInfo) -> Dict[str, Any]:
    mismatches: List[Dict[str, Any]] = []
    if candidate.page_count != reference.page_count:
        mismatches.append(
            {
                "kind": "page_count",
                "candidate": candidate.page_count,
                "reference": reference.page_count,
            }
        )

    for candidate_page, reference_page in zip(candidate.pages, reference.pages):
        candidate_validation = candidate_page.validation_errors()
        reference_validation = reference_page.validation_errors()
        if candidate_validation:
            mismatches.append(
                {
                    "kind": "invalid_candidate_boxes",
                    "page": candidate_page.page,
                    "errors": candidate_validation,
                    "media_box_pt": list(candidate_page.media_box),
                    "crop_box_pt": list(candidate_page.effective_crop_box),
                }
            )
        if reference_validation:
            mismatches.append(
                {
                    "kind": "invalid_reference_boxes",
                    "page": reference_page.page,
                    "errors": reference_validation,
                    "media_box_pt": list(reference_page.media_box),
                    "crop_box_pt": list(reference_page.effective_crop_box),
                }
            )
        size_matches = (
            math.isclose(
                candidate_page.width_pt,
                reference_page.width_pt,
                rel_tol=0.0,
                abs_tol=PAGE_SIZE_TOLERANCE_PT,
            )
            and math.isclose(
                candidate_page.height_pt,
                reference_page.height_pt,
                rel_tol=0.0,
                abs_tol=PAGE_SIZE_TOLERANCE_PT,
            )
        )
        if not size_matches:
            mismatches.append(
                {
                    "kind": "media_box_size",
                    "page": candidate_page.page,
                    "candidate_pt": list(candidate_page.media_box),
                    "reference_pt": list(reference_page.media_box),
                    "candidate_size_pt": [
                        candidate_page.width_pt,
                        candidate_page.height_pt,
                    ],
                    "reference_size_pt": [
                        reference_page.width_pt,
                        reference_page.height_pt,
                    ],
                    "comparison_tolerance_pt": PAGE_SIZE_TOLERANCE_PT,
                }
            )
        crop_values_candidate = (
            candidate_page.crop_offset_pt[0],
            candidate_page.crop_offset_pt[1],
            candidate_page.crop_width_pt,
            candidate_page.crop_height_pt,
        )
        crop_values_reference = (
            reference_page.crop_offset_pt[0],
            reference_page.crop_offset_pt[1],
            reference_page.crop_width_pt,
            reference_page.crop_height_pt,
        )
        crop_matches = all(
            math.isclose(
                candidate_value,
                reference_value,
                rel_tol=0.0,
                abs_tol=PAGE_SIZE_TOLERANCE_PT,
            )
            for candidate_value, reference_value in zip(
                crop_values_candidate, crop_values_reference
            )
        )
        if not crop_matches:
            mismatches.append(
                {
                    "kind": "crop_box",
                    "page": candidate_page.page,
                    "candidate_pt": list(candidate_page.effective_crop_box),
                    "reference_pt": list(reference_page.effective_crop_box),
                    "candidate_offset_and_size_pt": list(crop_values_candidate),
                    "reference_offset_and_size_pt": list(crop_values_reference),
                    "comparison_tolerance_pt": PAGE_SIZE_TOLERANCE_PT,
                }
            )
        if candidate_page.rotation != reference_page.rotation:
            mismatches.append(
                {
                    "kind": "rotation",
                    "page": candidate_page.page,
                    "candidate_degrees": candidate_page.rotation,
                    "reference_degrees": reference_page.rotation,
                }
            )
        if candidate_page.orientation != reference_page.orientation:
            mismatches.append(
                {
                    "kind": "orientation",
                    "page": candidate_page.page,
                    "candidate": candidate_page.orientation,
                    "reference": reference_page.orientation,
                }
            )

    return {
        "status": "match" if not mismatches else "mismatch",
        "mismatches": mismatches,
        "candidate": candidate.as_dict(),
        "reference": reference.as_dict(),
    }


def _estimated_raster_dimensions(page: PdfPageInfo) -> Tuple[int, int]:
    width = max(1, math.floor(page.crop_width_pt * DPI / 72.0 + 0.5))
    height = max(1, math.floor(page.crop_height_pt * DPI / 72.0 + 0.5))
    if page.rotation % 180:
        width, height = height, width
    return width, height


def _preflight_pixels(
    candidate: PdfInfo, reference: PdfInfo, limits: ResourceLimits
) -> Dict[str, Any]:
    per_page: List[Dict[str, Any]] = []
    total_pixels = 0
    for side, info in (("candidate", candidate), ("reference", reference)):
        for page in info.pages:
            width, height = _estimated_raster_dimensions(page)
            pixels = width * height
            if pixels > limits.max_page_pixels:
                raise VisualCheckError(
                    f"estimated {side} page {page.page} pixels {pixels} exceed "
                    f"--max-page-pixels {limits.max_page_pixels}"
                )
            total_pixels += pixels
            if total_pixels > limits.max_total_pixels:
                raise VisualCheckError(
                    f"estimated total pixels {total_pixels} exceed "
                    f"--max-total-pixels {limits.max_total_pixels}"
                )
            per_page.append(
                {
                    "side": side,
                    "page": page.page,
                    "estimated_width": width,
                    "estimated_height": height,
                    "estimated_pixels": pixels,
                }
            )
    return {"estimated_total_pixels": total_pixels, "pages": per_page}


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind)
    checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def _paeth_predictor(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def _read_png_gray(
    path: Path,
    max_file_bytes: int = DEFAULT_MAX_RASTER_BYTES,
    max_pixels: int = DEFAULT_MAX_PAGE_PIXELS,
    max_decompressed_bytes: int = DEFAULT_MAX_PNG_DECOMPRESSED_BYTES,
) -> GrayImage:
    file_size = path.stat().st_size
    if file_size > max_file_bytes:
        raise VisualCheckError(
            f"PNG size {file_size} exceeds limit {max_file_bytes}: {path.name}"
        )
    data = path.read_bytes()
    if len(data) > max_file_bytes:
        raise VisualCheckError(
            f"PNG size {len(data)} exceeds limit {max_file_bytes}: {path.name}"
        )
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VisualCheckError(f"not a PNG file: {path}")

    position = 8
    width = height = bit_depth = color_type = interlace = None
    compressed = bytearray()
    while position < len(data):
        if position + 12 > len(data):
            raise VisualCheckError(f"truncated PNG chunk in {path}")
        length = struct.unpack(">I", data[position : position + 4])[0]
        kind = data[position + 4 : position + 8]
        payload_start = position + 8
        payload_end = payload_start + length
        crc_end = payload_end + 4
        if crc_end > len(data):
            raise VisualCheckError(f"truncated PNG payload in {path}")
        payload = data[payload_start:payload_end]
        expected_crc = struct.unpack(">I", data[payload_end:crc_end])[0]
        actual_crc = zlib.crc32(kind)
        actual_crc = zlib.crc32(payload, actual_crc) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise VisualCheckError(f"PNG CRC mismatch in {path}")
        position = crc_end

        if kind == b"IHDR":
            if len(payload) != 13:
                raise VisualCheckError(f"invalid PNG IHDR in {path}")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if compression != 0 or filtering != 0:
                raise VisualCheckError(f"unsupported PNG compression/filter method in {path}")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break

    if None in (width, height, bit_depth, color_type, interlace):
        raise VisualCheckError(f"PNG is missing IHDR: {path}")
    assert width is not None and height is not None
    assert bit_depth is not None and color_type is not None and interlace is not None
    if bit_depth != 8 or interlace != 0:
        raise VisualCheckError(
            f"unsupported PNG format in {path}: bit_depth={bit_depth}, interlace={interlace}"
        )
    bytes_per_pixel = {0: 1, 2: 3, 4: 2, 6: 4}.get(color_type)
    if bytes_per_pixel is None:
        raise VisualCheckError(f"unsupported PNG color type {color_type} in {path}")

    pixel_count = width * height
    if pixel_count > max_pixels:
        raise VisualCheckError(
            f"PNG pixel count {pixel_count} exceeds limit {max_pixels}: {path.name}"
        )
    row_bytes = width * bytes_per_pixel
    expected_size = height * (row_bytes + 1)
    if expected_size > max_decompressed_bytes:
        raise VisualCheckError(
            "PNG decompressed scanlines exceed limit "
            f"{max_decompressed_bytes}: {expected_size} bytes in {path.name}"
        )
    try:
        decompressor = zlib.decompressobj()
        filtered = decompressor.decompress(bytes(compressed), expected_size + 1)
    except zlib.error as error:
        raise VisualCheckError(f"could not decompress PNG {path}: {error}") from error
    if decompressor.unconsumed_tail or not decompressor.eof:
        raise VisualCheckError(
            f"PNG decompressed data exceeds its declared bounded size or is truncated: {path.name}"
        )
    if decompressor.unused_data:
        raise VisualCheckError(f"PNG has trailing compressed data: {path.name}")
    if len(filtered) != expected_size:
        raise VisualCheckError(
            f"unexpected PNG data length in {path}: {len(filtered)} != {expected_size}"
        )

    decoded = bytearray()
    previous = bytearray(row_bytes)
    cursor = 0
    for _ in range(height):
        filter_type = filtered[cursor]
        cursor += 1
        row = bytearray(filtered[cursor : cursor + row_bytes])
        cursor += row_bytes
        if filter_type not in (0, 1, 2, 3, 4):
            raise VisualCheckError(f"unsupported PNG row filter {filter_type} in {path}")
        for index in range(row_bytes):
            left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            above = previous[index]
            upper_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            if filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                predictor = _paeth_predictor(left, above, upper_left)
            else:
                predictor = 0
            row[index] = (row[index] + predictor) & 0xFF
        decoded.extend(row)
        previous = row

    grayscale = bytearray(width * height)
    if color_type == 0:
        grayscale[:] = decoded
    elif color_type == 2:
        for pixel in range(width * height):
            offset = pixel * 3
            red, green, blue = decoded[offset : offset + 3]
            grayscale[pixel] = (77 * red + 150 * green + 29 * blue + 128) >> 8
    elif color_type == 4:
        for pixel in range(width * height):
            offset = pixel * 2
            gray, alpha = decoded[offset : offset + 2]
            grayscale[pixel] = (gray * alpha + 255 * (255 - alpha) + 127) // 255
    else:  # RGBA
        for pixel in range(width * height):
            offset = pixel * 4
            red, green, blue, alpha = decoded[offset : offset + 4]
            gray = (77 * red + 150 * green + 29 * blue + 128) >> 8
            grayscale[pixel] = (gray * alpha + 255 * (255 - alpha) + 127) // 255
    return GrayImage(width=width, height=height, pixels=bytes(grayscale))


def _write_png(path: Path, width: int, height: int, pixels: bytes, color_type: int) -> None:
    bytes_per_pixel = {0: 1, 2: 3}.get(color_type)
    if bytes_per_pixel is None:
        raise ValueError("writer supports grayscale or RGB only")
    expected = width * height * bytes_per_pixel
    if len(pixels) != expected:
        raise ValueError(f"pixel byte count {len(pixels)} does not match expected {expected}")
    row_bytes = width * bytes_per_pixel
    filtered = bytearray()
    for row in range(height):
        filtered.append(0)
        start = row * row_bytes
        filtered.extend(pixels[start : start + row_bytes])
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    payload = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(filtered), level=9))
        + _png_chunk(b"IEND", b"")
    )
    path.write_bytes(payload)
    _force_private_regular_file(path)


def _write_gray_png(path: Path, image: GrayImage) -> None:
    _write_png(path, image.width, image.height, image.pixels, color_type=0)


def _write_rgb_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    _write_png(path, width, height, pixels, color_type=2)


def _force_private_regular_file(path: Path) -> int:
    file_status = path.lstat()
    if stat.S_ISLNK(file_status.st_mode) or not stat.S_ISREG(file_status.st_mode):
        raise VisualCheckError(f"expected a regular output file: {path.name}")
    os.chmod(path, 0o600)
    return path.stat().st_size


def _make_private_directory(
    path: Path, *, parents: bool = False, exist_ok: bool = False
) -> None:
    path.mkdir(mode=0o700, parents=parents, exist_ok=exist_ok)
    directory_status = path.lstat()
    if stat.S_ISLNK(directory_status.st_mode) or not stat.S_ISDIR(
        directory_status.st_mode
    ):
        raise VisualCheckError(f"expected a private output directory: {path}")
    os.chmod(path, 0o700)


def _copy_private_regular_file(source: Path, destination: Path) -> int:
    shutil.copyfile(source, destination)
    return _force_private_regular_file(destination)


def _write_private_text(path: Path, value: str) -> int:
    path.write_text(value, encoding="utf-8")
    return _force_private_regular_file(path)


def _rasterize_pdf_page(
    pdf_path: Path,
    destination: Path,
    label: str,
    page: int,
    limits: ResourceLimits,
) -> Tuple[Path, int]:
    _make_private_directory(destination, parents=True, exist_ok=True)
    prefix = destination / f"{label}-page-{page:04d}"
    command = [
        "pdftoppm",
        "-png",
        "-r",
        str(DPI),
        "-f",
        str(page),
        "-l",
        str(page),
        "-singlefile",
        "-cropbox",
        "-aa",
        "yes",
        "-aaVector",
        "yes",
        "-q",
        str(pdf_path),
        str(prefix),
    ]
    _run_command(
        command,
        limits.subprocess_timeout_seconds,
        file_size_limit_bytes=limits.max_raster_bytes,
        output_limit_bytes=limits.max_subprocess_output_bytes,
    )

    output = prefix.with_suffix(".png")
    if not output.is_file():
        raise VisualCheckError(
            f"pdftoppm produced no PNG for page {page}: {pdf_path.name}"
        )
    output_bytes = _force_private_regular_file(output)
    if output_bytes > limits.max_raster_bytes:
        raise VisualCheckError(
            f"raster page {page} is {output_bytes} bytes; limit is {limits.max_raster_bytes}"
        )
    return output, output_bytes


def _ink_set(image: GrayImage) -> Set[int]:
    return {index for index, value in enumerate(image.pixels) if value < INK_THRESHOLD}


def _translation_order(max_translation: int) -> Iterable[Tuple[int, int]]:
    offsets = [
        (dx, dy)
        for dy in range(-max_translation, max_translation + 1)
        for dx in range(-max_translation, max_translation + 1)
    ]
    return sorted(
        offsets,
        key=lambda offset: (
            abs(offset[0]) + abs(offset[1]),
            abs(offset[1]),
            abs(offset[0]),
            offset[1],
            offset[0],
        ),
    )


def _shift_set(mask: Set[int], width: int, height: int, dx: int, dy: int) -> Set[int]:
    shifted: Set[int] = set()
    for index in mask:
        y, x = divmod(index, width)
        new_x = x + dx
        new_y = y + dy
        if 0 <= new_x < width and 0 <= new_y < height:
            shifted.add(new_y * width + new_x)
    return shifted


def _estimate_translation(
    reference_ink: Set[int],
    candidate_ink: Set[int],
    width: int,
    height: int,
    max_translation: int = MAX_TRANSLATION_PX,
) -> Tuple[int, int, Optional[float]]:
    if not reference_ink and not candidate_ink:
        return 0, 0, None
    if reference_ink == candidate_ink:
        return 0, 0, 1.0
    denominator = len(reference_ink) + len(candidate_ink)
    best_dx = best_dy = 0
    best_intersection = -1
    for dx, dy in _translation_order(max_translation):
        intersection = 0
        for index in candidate_ink:
            y, x = divmod(index, width)
            new_x = x + dx
            new_y = y + dy
            if (
                0 <= new_x < width
                and 0 <= new_y < height
                and new_y * width + new_x in reference_ink
            ):
                intersection += 1
        if intersection > best_intersection:
            best_dx, best_dy = dx, dy
            best_intersection = intersection
    score = (2.0 * best_intersection / denominator) if denominator else None
    return best_dx, best_dy, score


def _shift_image(image: GrayImage, dx: int, dy: int) -> GrayImage:
    output = bytearray([255]) * (image.width * image.height)
    source_x = max(0, -dx)
    destination_x = max(0, dx)
    copy_width = image.width - abs(dx)
    source_y = max(0, -dy)
    destination_y = max(0, dy)
    copy_height = image.height - abs(dy)
    if copy_width <= 0 or copy_height <= 0:
        return GrayImage(image.width, image.height, bytes(output))
    for row in range(copy_height):
        source_start = (source_y + row) * image.width + source_x
        destination_start = (destination_y + row) * image.width + destination_x
        output[destination_start : destination_start + copy_width] = image.pixels[
            source_start : source_start + copy_width
        ]
    return GrayImage(image.width, image.height, bytes(output))


def _pad_image(image: GrayImage, width: int, height: int) -> GrayImage:
    """Pad the right/bottom edges with white without resampling or cropping."""
    if width < image.width or height < image.height:
        raise ValueError("padding canvas cannot be smaller than the image")
    if width == image.width and height == image.height:
        return image
    output = bytearray([255]) * (width * height)
    for row in range(image.height):
        source_start = row * image.width
        destination_start = row * width
        output[destination_start : destination_start + image.width] = image.pixels[
            source_start : source_start + image.width
        ]
    return GrayImage(width, height, bytes(output))


def _ssim_from_sums(
    count: int,
    sum_reference: int,
    sum_candidate: int,
    sum_reference_squared: int,
    sum_candidate_squared: int,
    sum_cross: int,
) -> float:
    if count <= 0:
        raise ValueError("SSIM-like statistics require at least one pixel")
    reference_mean = sum_reference / count
    candidate_mean = sum_candidate / count
    reference_variance = max(0.0, sum_reference_squared / count - reference_mean**2)
    candidate_variance = max(0.0, sum_candidate_squared / count - candidate_mean**2)
    covariance = sum_cross / count - reference_mean * candidate_mean
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    numerator = (2 * reference_mean * candidate_mean + c1) * (2 * covariance + c2)
    denominator = (
        reference_mean**2 + candidate_mean**2 + c1
    ) * (reference_variance + candidate_variance + c2)
    if denominator == 0:
        return 1.0 if numerator == 0 else 0.0
    return max(-1.0, min(1.0, numerator / denominator))


def _global_ssim_like(reference: GrayImage, candidate: GrayImage) -> float:
    count = len(reference.pixels)
    sum_reference = sum(reference.pixels)
    sum_candidate = sum(candidate.pixels)
    sum_reference_squared = sum(value * value for value in reference.pixels)
    sum_candidate_squared = sum(value * value for value in candidate.pixels)
    sum_cross = sum(
        reference_value * candidate_value
        for reference_value, candidate_value in zip(reference.pixels, candidate.pixels)
    )
    return _ssim_from_sums(
        count,
        sum_reference,
        sum_candidate,
        sum_reference_squared,
        sum_candidate_squared,
        sum_cross,
    )


def _local_ssim_like(reference: GrayImage, candidate: GrayImage) -> Dict[str, Any]:
    values: List[float] = []
    weighted_sum = 0.0
    total_pixels = 0
    for top in range(0, reference.height, LOCAL_SSIM_WINDOW_PX):
        bottom = min(reference.height, top + LOCAL_SSIM_WINDOW_PX)
        for left in range(0, reference.width, LOCAL_SSIM_WINDOW_PX):
            right = min(reference.width, left + LOCAL_SSIM_WINDOW_PX)
            count = 0
            sum_reference = sum_candidate = 0
            sum_reference_squared = sum_candidate_squared = sum_cross = 0
            for y in range(top, bottom):
                start = y * reference.width + left
                end = y * reference.width + right
                for reference_value, candidate_value in zip(
                    reference.pixels[start:end], candidate.pixels[start:end]
                ):
                    count += 1
                    sum_reference += reference_value
                    sum_candidate += candidate_value
                    sum_reference_squared += reference_value * reference_value
                    sum_candidate_squared += candidate_value * candidate_value
                    sum_cross += reference_value * candidate_value
            value = _ssim_from_sums(
                count,
                sum_reference,
                sum_candidate,
                sum_reference_squared,
                sum_candidate_squared,
                sum_cross,
            )
            values.append(value)
            weighted_sum += value * count
            total_pixels += count
    return {
        "window_px": LOCAL_SSIM_WINDOW_PX,
        "mean": weighted_sum / total_pixels,
        "worst": min(values),
        "window_count": len(values),
        "mean_weighting": "window_pixel_count",
        "total_pixels": total_pixels,
    }


def _edge_set(mask: Set[int], width: int, height: int) -> Set[int]:
    edges: Set[int] = set()
    for index in mask:
        y, x = divmod(index, width)
        if (
            x == 0
            or x == width - 1
            or y == 0
            or y == height - 1
            or index - 1 not in mask
            or index + 1 not in mask
            or index - width not in mask
            or index + width not in mask
        ):
            edges.add(index)
    return edges


def _disk_offsets(radius: int) -> Tuple[Tuple[int, int], ...]:
    if radius < 0:
        raise ValueError("dilation radius cannot be negative")
    return tuple(
        (dx, dy)
        for dy in range(-radius, radius + 1)
        for dx in range(-radius, radius + 1)
        if dx * dx + dy * dy <= radius * radius
    )


def _edge_match_counts(
    reference_edges: Set[int],
    candidate_edges: Set[int],
    width: int,
    height: int,
    radius: int,
    max_edge_work: int,
) -> Tuple[int, int, int, int]:
    if (
        isinstance(max_edge_work, bool)
        or not isinstance(max_edge_work, int)
        or max_edge_work <= 0
    ):
        raise ValueError("edge work limit must be a positive integer")
    if max_edge_work > HARD_MAX_EDGE_WORK:
        raise ValueError(
            f"edge work limit {max_edge_work} exceeds hard ceiling "
            f"{HARD_MAX_EDGE_WORK}"
        )
    offsets = _disk_offsets(radius)
    work_units = (len(reference_edges) + len(candidate_edges)) * len(offsets)
    if work_units > max_edge_work:
        raise VisualCheckError(
            f"edge match work {work_units} exceeds --max-edge-work "
            f"{max_edge_work}"
        )

    def count_matches(probes: Set[int], targets: Set[int]) -> int:
        matches = 0
        for index in probes:
            y, x = divmod(index, width)
            for dx, dy in offsets:
                new_x = x + dx
                new_y = y + dy
                if (
                    0 <= new_x < width
                    and 0 <= new_y < height
                    and new_y * width + new_x in targets
                ):
                    matches += 1
                    break
        return matches

    candidate_matches = count_matches(candidate_edges, reference_edges)
    reference_matches = count_matches(reference_edges, candidate_edges)
    return candidate_matches, reference_matches, work_units, len(offsets)


def _bbox(mask: Set[int], width: int) -> Optional[Dict[str, int]]:
    if not mask:
        return None
    coordinates = [divmod(index, width) for index in mask]
    top = min(y for y, _ in coordinates)
    bottom = max(y for y, _ in coordinates)
    left = min(x for _, x in coordinates)
    right = max(x for _, x in coordinates)
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": right - left + 1,
        "height": bottom - top + 1,
    }


def _bbox_comparison(
    reference_ink: Set[int], candidate_ink: Set[int], width: int
) -> Optional[Dict[str, Any]]:
    reference_bbox = _bbox(reference_ink, width)
    candidate_bbox = _bbox(candidate_ink, width)
    if reference_bbox is None or candidate_bbox is None:
        return None
    delta = {
        key: candidate_bbox[key] - reference_bbox[key]
        for key in ("left", "top", "right", "bottom", "width", "height")
    }
    return {
        "reference": reference_bbox,
        "candidate": candidate_bbox,
        "delta_px": delta,
        "max_abs_edge_delta_px": max(
            abs(delta[key]) for key in ("left", "top", "right", "bottom")
        ),
    }


def _worst_tile_recall(
    reference_ink: Set[int],
    candidate_ink: Set[int],
    width: int,
    height: int,
) -> Optional[Dict[str, Any]]:
    if not reference_ink:
        return None
    reference_counts: Dict[Tuple[int, int], int] = {}
    matched_counts: Dict[Tuple[int, int], int] = {}
    for index in reference_ink:
        y, x = divmod(index, width)
        tile = (x // TILE_SIZE_PX, y // TILE_SIZE_PX)
        reference_counts[tile] = reference_counts.get(tile, 0) + 1
        if index in candidate_ink:
            matched_counts[tile] = matched_counts.get(tile, 0) + 1
    worst_tile = min(
        reference_counts,
        key=lambda tile: (
            matched_counts.get(tile, 0) / reference_counts[tile],
            tile[1],
            tile[0],
        ),
    )
    tile_x, tile_y = worst_tile
    reference_count = reference_counts[worst_tile]
    matched_count = matched_counts.get(worst_tile, 0)
    return {
        "recall": matched_count / reference_count,
        "tile_size_px": TILE_SIZE_PX,
        "tile": {
            "left": tile_x * TILE_SIZE_PX,
            "top": tile_y * TILE_SIZE_PX,
            "width": min(TILE_SIZE_PX, width - tile_x * TILE_SIZE_PX),
            "height": min(TILE_SIZE_PX, height - tile_y * TILE_SIZE_PX),
            "reference_ink_pixels": reference_count,
            "matched_ink_pixels": matched_count,
        },
    }


def _round_numbers(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, list):
        return [_round_numbers(item) for item in value]
    if isinstance(value, tuple):
        return [_round_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _round_numbers(item) for key, item in value.items()}
    return value


def _preflight_metric_work(
    reference: GrayImage,
    candidate: GrayImage,
    max_translation: int,
    limits: ResourceLimits,
) -> Dict[str, int]:
    if reference.width != candidate.width or reference.height != candidate.height:
        raise VisualCheckError("metric preflight requires equal raster dimensions")
    if max_translation < 0 or max_translation > MAX_TRANSLATION_PX:
        raise VisualCheckError(
            f"translation bound must be between 0 and {MAX_TRANSLATION_PX}px"
        )
    reference_ink_pixels = sum(
        1 for value in reference.pixels if value < INK_THRESHOLD
    )
    candidate_ink_pixels = sum(
        1 for value in candidate.pixels if value < INK_THRESHOLD
    )
    for side, ink_pixels in (
        ("reference", reference_ink_pixels),
        ("candidate", candidate_ink_pixels),
    ):
        if ink_pixels > limits.max_ink_pixels:
            raise VisualCheckError(
                f"{side} ink pixels {ink_pixels} exceed "
                f"--max-ink-pixels {limits.max_ink_pixels} before set allocation"
            )
    alignment_candidates = (2 * max_translation + 1) ** 2
    alignment_work = candidate_ink_pixels * alignment_candidates
    if alignment_work > limits.max_alignment_work:
        raise VisualCheckError(
            f"alignment work {alignment_work} exceeds "
            f"--max-alignment-work {limits.max_alignment_work}"
        )
    edge_neighbor_probes = len(_disk_offsets(EDGE_TOLERANCE_PX))
    edge_work_upper_bound = (
        reference_ink_pixels + candidate_ink_pixels
    ) * edge_neighbor_probes
    if edge_work_upper_bound > limits.max_edge_work:
        raise VisualCheckError(
            f"edge work upper bound {edge_work_upper_bound} exceeds "
            f"--max-edge-work {limits.max_edge_work} before set allocation"
        )
    return {
        "reference_ink_pixels": reference_ink_pixels,
        "candidate_ink_pixels": candidate_ink_pixels,
        "alignment_candidate_offsets": alignment_candidates,
        "alignment_work_units": alignment_work,
        "edge_neighbor_probes": edge_neighbor_probes,
        "edge_work_upper_bound": edge_work_upper_bound,
    }


def _compare_images(
    reference: GrayImage,
    candidate: GrayImage,
    max_translation: int = MAX_TRANSLATION_PX,
    max_edge_work: int = DEFAULT_MAX_EDGE_WORK,
) -> Tuple[GrayImage, Dict[str, Any]]:
    if reference.width != candidate.width or reference.height != candidate.height:
        raise ValueError("raster dimensions differ; resizing is forbidden")
    if max_translation < 0 or max_translation > MAX_TRANSLATION_PX:
        raise ValueError(f"translation bound must be between 0 and {MAX_TRANSLATION_PX}px")

    reference_ink = _ink_set(reference)
    raw_candidate_ink = _ink_set(candidate)
    raw_ssim_global = _global_ssim_like(reference, candidate)
    raw_ssim_local = _local_ssim_like(reference, candidate)
    raw_content_bbox = _bbox_comparison(
        reference_ink, raw_candidate_ink, reference.width
    )
    dx, dy, search_score = _estimate_translation(
        reference_ink,
        raw_candidate_ink,
        reference.width,
        reference.height,
        max_translation=max_translation,
    )
    aligned_candidate = _shift_image(candidate, dx, dy)
    candidate_ink = _shift_set(
        raw_candidate_ink, reference.width, reference.height, dx, dy
    )
    clipped_candidate_ink: Set[int] = set()
    for index in raw_candidate_ink:
        y, x = divmod(index, reference.width)
        if not (0 <= x + dx < reference.width and 0 <= y + dy < reference.height):
            clipped_candidate_ink.add(index)

    intersection = reference_ink & candidate_ink
    union = reference_ink | candidate_ink
    reference_count = len(reference_ink)
    # Alignment is registration, not cropping. Candidate ink translated outside
    # the fixed canvas remains in all metric denominators as unmatched ink.
    candidate_count = len(raw_candidate_ink)
    visible_candidate_count = len(candidate_ink)
    clipped_candidate_count = len(clipped_candidate_ink)
    true_positive_count = len(intersection)

    ink_precision = true_positive_count / candidate_count if candidate_count else None
    ink_recall = true_positive_count / reference_count if reference_count else None
    ink_f1 = (
        2.0 * true_positive_count / (candidate_count + reference_count)
        if candidate_count + reference_count
        else None
    )
    logical_union_count = len(union) + clipped_candidate_count
    ink_iou = true_positive_count / logical_union_count if logical_union_count else None
    ink_ratio = candidate_count / reference_count if reference_count else None

    union_foreground_mae = None
    if logical_union_count:
        visible_error = sum(
            abs(reference.pixels[index] - aligned_candidate.pixels[index])
            for index in union
        )
        clipped_error = sum(
            255 - candidate.pixels[index] for index in clipped_candidate_ink
        )
        union_foreground_mae = (visible_error + clipped_error) / (
            255.0 * logical_union_count
        )

    reference_edges = _edge_set(reference_ink, reference.width, reference.height)
    raw_candidate_edges = _edge_set(
        raw_candidate_ink, reference.width, reference.height
    )
    candidate_edges = _shift_set(
        raw_candidate_edges, reference.width, reference.height, dx, dy
    )
    clipped_candidate_edge_count = len(raw_candidate_edges) - len(candidate_edges)
    (
        candidate_edge_matches,
        reference_edge_matches,
        edge_work_units,
        edge_neighbor_probes,
    ) = _edge_match_counts(
        reference_edges,
        candidate_edges,
        reference.width,
        reference.height,
        EDGE_TOLERANCE_PX,
        max_edge_work,
    )
    edge_precision = (
        candidate_edge_matches / len(raw_candidate_edges)
        if raw_candidate_edges
        else None
    )
    edge_recall = (
        reference_edge_matches / len(reference_edges)
        if reference_edges
        else None
    )
    if not reference_edges and not raw_candidate_edges:
        edge_f1 = None
    elif edge_precision is None or edge_recall is None:
        edge_f1 = 0.0
    elif edge_precision + edge_recall == 0:
        edge_f1 = 0.0
    else:
        edge_f1 = 2 * edge_precision * edge_recall / (edge_precision + edge_recall)

    unscorable: Dict[str, str] = {}
    if not logical_union_count:
        unscorable["union_foreground_mae"] = "both rasters contain no foreground ink"
        unscorable["ink_iou"] = "both rasters contain no foreground ink"
        unscorable["ink_f1"] = "both rasters contain no foreground ink"
    if candidate_count == 0:
        unscorable["ink_precision"] = "candidate contains no foreground ink"
    if reference_count == 0:
        unscorable["ink_recall"] = "reference contains no foreground ink"
        unscorable["ink_ratio"] = "reference contains no foreground ink"
        unscorable["worst_tile_recall"] = "reference contains no foreground ink"
    if not reference_edges:
        unscorable["edge_recall"] = "reference contains no foreground edges"
    if not raw_candidate_edges:
        unscorable["edge_precision"] = "candidate contains no foreground edges"
    if not reference_edges and not raw_candidate_edges:
        unscorable["edge_f1"] = "both rasters contain no foreground edges"
    if not reference_ink or not candidate_ink:
        unscorable["content_bbox_delta"] = "one or both rasters contain no foreground ink"

    metrics = {
        "status": "partially_unscorable" if unscorable else "scored",
        "dimensions_px": {"width": reference.width, "height": reference.height},
        "blankness": {
            "reference_blank": reference_count == 0,
            "candidate_blank": candidate_count == 0,
            "matches": (reference_count == 0) == (candidate_count == 0),
        },
        "alignment": {
            "method": "bounded_integer_translation",
            "candidate_translation_px": {"dx": dx, "dy": dy},
            "max_abs_translation_px": max_translation,
            "search_objective": "exact_binary_ink_f1",
            "search_score": search_score,
            "scale": 1.0,
            "rotation_degrees": 0,
            "crop": False,
            "clipped_candidate_ink_pixels": clipped_candidate_count,
            "clipped_candidate_edge_pixels": clipped_candidate_edge_count,
        },
        "ssim_like": {
            "raw_global": raw_ssim_global,
            "raw_local": raw_ssim_local,
            "global": _global_ssim_like(reference, aligned_candidate),
            "local": _local_ssim_like(reference, aligned_candidate),
            "aligned_fields": ["global", "local"],
        },
        "union_foreground_mae": union_foreground_mae,
        "ink": {
            "threshold_gray_lt": INK_THRESHOLD,
            "reference_pixels": reference_count,
            "candidate_pixels": candidate_count,
            "candidate_visible_pixels_after_translation": visible_candidate_count,
            "candidate_clipped_pixels": clipped_candidate_count,
            "matched_pixels": true_positive_count,
            "precision": ink_precision,
            "recall": ink_recall,
            "f1": ink_f1,
            "iou": ink_iou,
            "candidate_to_reference_ratio": ink_ratio,
        },
        "edge": {
            "tolerance_px": EDGE_TOLERANCE_PX,
            "neighbor_probes_per_edge": edge_neighbor_probes,
            "match_work_units": edge_work_units,
            "reference_pixels": len(reference_edges),
            "candidate_pixels": len(raw_candidate_edges),
            "candidate_visible_pixels_after_translation": len(candidate_edges),
            "candidate_clipped_pixels": clipped_candidate_edge_count,
            "precision": edge_precision,
            "recall": edge_recall,
            "f1": edge_f1,
        },
        "content_bbox": _bbox_comparison(reference_ink, candidate_ink, reference.width),
        "raw_content_bbox": raw_content_bbox,
        "worst_tile_recall": _worst_tile_recall(
            reference_ink,
            candidate_ink,
            reference.width,
            reference.height,
        ),
        "unscorable_metrics": unscorable,
    }
    return aligned_candidate, _round_numbers(metrics)


def _overlay_pixels(reference: GrayImage, candidate: GrayImage) -> bytes:
    output = bytearray(reference.width * reference.height * 3)
    for index, (reference_gray, candidate_gray) in enumerate(
        zip(reference.pixels, candidate.pixels)
    ):
        reference_ink = 255 - reference_gray
        candidate_ink = 255 - candidate_gray
        offset = index * 3
        # Reference-only differences are red; candidate-only differences are blue;
        # matching dark content remains neutral/black.
        output[offset] = 255 - candidate_ink
        output[offset + 1] = 255 - max(reference_ink, candidate_ink)
        output[offset + 2] = 255 - reference_ink
    return bytes(output)


def _heatmap_pixels(reference: GrayImage, candidate: GrayImage) -> bytes:
    output = bytearray(reference.width * reference.height * 3)
    for index, (reference_gray, candidate_gray) in enumerate(
        zip(reference.pixels, candidate.pixels)
    ):
        difference = abs(reference_gray - candidate_gray)
        offset = index * 3
        output[offset] = 255
        output[offset + 1] = 255 - difference
        output[offset + 2] = 255 - difference
    return bytes(output)


def _crop_image(image: GrayImage, left: int, top: int, right: int, bottom: int) -> GrayImage:
    if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
        raise VisualCheckError("semantic region crop is empty or outside the raster canvas")
    width = right - left
    pixels = bytearray(width * (bottom - top))
    target = 0
    for row in range(top, bottom):
        start = row * image.width + left
        pixels[target : target + width] = image.pixels[start : start + width]
        target += width
    return GrayImage(width, bottom - top, bytes(pixels))


def _row_ink_counts(
    image: GrayImage, left: int, top: int, right: int, bottom: int
) -> List[int]:
    counts: List[int] = []
    for row in range(top, bottom):
        start = row * image.width + left
        counts.append(
            sum(
                1
                for value in image.pixels[start : start + (right - left)]
                if value < INK_THRESHOLD
            )
        )
    return counts


def _row_profile_similarity(
    candidate_counts: Sequence[int], reference_counts: Sequence[int]
) -> Tuple[float, float, int]:
    candidate_active = {index for index, count in enumerate(candidate_counts) if count}
    reference_active = {index for index, count in enumerate(reference_counts) if count}
    overlap = len(candidate_active & reference_active)
    active_total = len(candidate_active) + len(reference_active)
    row_f1 = 0.0 if active_total == 0 else (2.0 * overlap / active_total)
    dot = sum(left * right for left, right in zip(candidate_counts, reference_counts))
    candidate_norm = sum(value * value for value in candidate_counts)
    reference_norm = sum(value * value for value in reference_counts)
    cosine = (
        0.0
        if candidate_norm == 0 or reference_norm == 0
        else dot / math.sqrt(candidate_norm * reference_norm)
    )
    return row_f1, cosine, overlap


def _vertical_trace(
    category: str,
    paint_status: str,
    bounds: Optional[Mapping[str, int]],
    reference: GrayImage,
    aligned_candidate: GrayImage,
    max_work: int = HARD_MAX_VERTICAL_TRACE_WORK_PER_PAGE,
) -> Dict[str, Any]:
    policy = {
        "role": "report_only_hypothesis",
        "search_axis": "vertical_only",
        "max_abs_offset_px": MAX_VERTICAL_TRACE_PX,
        "ink_threshold_gray_lt": INK_THRESHOLD,
        "ranking": ["active_row_f1", "row_ink_count_cosine"],
    }
    if category not in {"text", "table"}:
        return {
            "status": "not-applicable",
            "reason": "category has no vertical text/table transition",
            "policy": policy,
        }
    if paint_status == "expected-missing":
        return {
            "status": "unscorable",
            "reason": "source-visible text produced no placed glyph",
            "policy": policy,
        }
    if bounds is None:
        return {
            "status": "unscorable",
            "reason": "aligned region bounds are unavailable",
            "policy": policy,
        }

    left = int(bounds["left"])
    top = int(bounds["top"])
    right = left + int(bounds["width"])
    bottom = top + int(bounds["height"])
    minimum_offset = max(-MAX_VERTICAL_TRACE_PX, -top)
    maximum_offset = min(MAX_VERTICAL_TRACE_PX, reference.height - bottom)
    considered = {
        "min": minimum_offset,
        "max": maximum_offset,
        "count": max(0, maximum_offset - minimum_offset + 1),
    }
    width = right - left
    height = bottom - top
    work_units = (
        width * height
        + width * (height + maximum_offset - minimum_offset)
        + height * considered["count"] * VERTICAL_TRACE_PROFILE_ROW_COST
    )
    if work_units > max_work:
        return {
            "status": "unscorable",
            "reason": "bounded per-page vertical trace work budget is exhausted",
            "policy": policy,
            "considered_offsets_px": considered,
            "work_units": 0,
        }

    candidate_counts = _row_ink_counts(aligned_candidate, left, top, right, bottom)
    candidate_active_rows = sum(1 for count in candidate_counts if count)
    if candidate_active_rows == 0:
        return {
            "status": "unscorable",
            "reason": "candidate region has no ink rows",
            "policy": policy,
            "candidate_active_rows": 0,
            "work_units": width * height,
        }
    reference_window = _row_ink_counts(
        reference,
        left,
        top + minimum_offset,
        right,
        bottom + maximum_offset,
    )
    rankings: List[Dict[str, Any]] = []
    for offset in range(minimum_offset, maximum_offset + 1):
        start = offset - minimum_offset
        reference_counts = reference_window[start : start + height]
        row_f1, cosine, overlap = _row_profile_similarity(
            candidate_counts, reference_counts
        )
        rankings.append(
            {
                "offset_px": offset,
                "active_row_f1": row_f1,
                "row_ink_count_cosine": cosine,
                "overlapping_active_rows": overlap,
                "reference_active_rows": sum(1 for count in reference_counts if count),
            }
        )
    if not rankings or max(item["reference_active_rows"] for item in rankings) == 0:
        return {
            "status": "unscorable",
            "reason": "reference search window has no ink rows",
            "policy": policy,
            "candidate_active_rows": candidate_active_rows,
            "considered_offsets_px": considered,
            "work_units": work_units,
        }

    def rank(item: Mapping[str, Any]) -> Tuple[float, float]:
        return (item["active_row_f1"], item["row_ink_count_cosine"])

    best_rank = max(rank(item) for item in rankings)
    best = [item for item in rankings if rank(item) == best_rank]
    lower = [item for item in rankings if rank(item) < best_rank]
    lower.sort(
        key=lambda item: (
            -item["active_row_f1"],
            -item["row_ink_count_cosine"],
            abs(item["offset_px"]),
            item["offset_px"],
        )
    )
    runner_up = lower[0] if lower else None
    common = {
        "policy": policy,
        "candidate_active_rows": candidate_active_rows,
        "considered_offsets_px": considered,
        "best_score": {
            "active_row_f1": best_rank[0],
            "row_ink_count_cosine": best_rank[1],
        },
        "runner_up": runner_up,
        "work_units": work_units,
    }
    if best_rank[0] == 0.0:
        return {
            **common,
            "status": "unscorable",
            "reason": "candidate and reference have no overlapping active rows in the bounded search window",
        }
    if len(best) != 1:
        return {
            **common,
            "status": "ambiguous",
            "reason": "multiple offsets have the same best row-profile rank",
            "best_offsets_px": [item["offset_px"] for item in best],
        }
    return {
        **common,
        "status": "hypothesis",
        "reason": None,
        "offset_px": best[0]["offset_px"],
        "reference_active_rows": best[0]["reference_active_rows"],
        "overlapping_active_rows": best[0]["overlapping_active_rows"],
    }


def _binary_integral(image: GrayImage) -> List[int]:
    """Return a one-cell-padded summed-area table for thresholded foreground ink."""
    stride = image.width + 1
    integral = [0] * (stride * (image.height + 1))
    for y in range(image.height):
        row_sum = 0
        source = y * image.width
        target = (y + 1) * stride
        previous = y * stride
        for x in range(image.width):
            row_sum += int(image.pixels[source + x] < INK_THRESHOLD)
            integral[target + x + 1] = integral[previous + x + 1] + row_sum
    return integral


def _integral_rect_count(
    integral: Sequence[int], stride: int, left: int, top: int, right: int, bottom: int
) -> int:
    return (
        integral[bottom * stride + right]
        - integral[top * stride + right]
        - integral[bottom * stride + left]
        + integral[top * stride + left]
    )


def _text_residual_trace(
    category: str,
    paint_status: str,
    bounds: Optional[Mapping[str, int]],
    reference: GrayImage,
    aligned_candidate: GrayImage,
    alignment_clipped: bool = False,
    max_work: int = HARD_MAX_TEXT_RESIDUAL_WORK_PER_PAGE,
    max_translation: int = MAX_TEXT_RESIDUAL_TRANSLATION_PX,
) -> Dict[str, Any]:
    """Classify text residuals without changing any scored metric or page alignment."""
    policy = {
        "role": "report_only_hypothesis",
        "search_axis": "bounded_local_xy_translation",
        "max_abs_offset_px": max_translation,
        "ink_threshold_gray_lt": INK_THRESHOLD,
        "geometry_min_local_ink_f1": TEXT_RESIDUAL_GEOMETRY_MIN_F1,
        "material_local_gain": TEXT_RESIDUAL_MATERIAL_GAIN,
        "mixed_local_gain": TEXT_RESIDUAL_MIXED_GAIN,
        "similar_ink_ratio": [
            TEXT_RESIDUAL_INK_RATIO_MIN,
            TEXT_RESIDUAL_INK_RATIO_MAX,
        ],
    }
    if category != "text":
        return {
            "status": "not-applicable",
            "classification": None,
            "reason": "category is not a paint-backed text region",
            "policy": policy,
        }
    if paint_status == "expected-missing":
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "source-visible text produced no placed glyph",
            "policy": policy,
        }
    if bounds is None:
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "aligned region bounds are unavailable",
            "policy": policy,
        }
    if alignment_clipped:
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "global alignment clipped the text region",
            "policy": policy,
        }

    if max_translation < 0 or max_translation > MAX_TEXT_RESIDUAL_TRANSLATION_PX:
        raise ValueError(
            f"text residual translation bound must be between 0 and {MAX_TEXT_RESIDUAL_TRANSLATION_PX}px"
        )
    left = int(bounds["left"])
    top = int(bounds["top"])
    width = int(bounds["width"])
    height = int(bounds["height"])
    radius = max_translation
    if (
        left - radius < 0
        or top - radius < 0
        or left + width + radius > reference.width
        or top + height + radius > reference.height
    ):
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "bounded local search window is clipped by the page edge",
            "policy": policy,
            "work_units": 0,
        }

    reference_window = _crop_image(
        reference,
        left - radius,
        top - radius,
        left + width + radius,
        top + height + radius,
    )
    candidate_crop = _crop_image(
        aligned_candidate,
        left,
        top,
        left + width,
        top + height,
    )
    candidate_points = [
        divmod(index, width)
        for index, value in enumerate(candidate_crop.pixels)
        if value < INK_THRESHOLD
    ]
    if not candidate_points:
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "candidate text region has no ink",
            "policy": policy,
            "work_units": width * height,
        }

    offsets = list(_translation_order(radius))
    work_units = (
        width * height
        + reference_window.width * reference_window.height
        + len(candidate_points) * len(offsets)
        + len(offsets)
    )
    if work_units > max_work:
        return {
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "bounded per-page text residual work budget is exhausted",
            "policy": policy,
            "work_units": 0,
        }

    integral = _binary_integral(reference_window)
    stride = reference_window.width + 1
    candidate_count = len(candidate_points)
    rankings: List[Dict[str, Any]] = []
    for dx, dy in offsets:
        origin_x = radius + dx
        origin_y = radius + dy
        reference_count = _integral_rect_count(
            integral,
            stride,
            origin_x,
            origin_y,
            origin_x + width,
            origin_y + height,
        )
        intersection = sum(
            reference_window.pixels[(origin_y + y) * reference_window.width + origin_x + x]
            < INK_THRESHOLD
            for y, x in candidate_points
        )
        denominator = candidate_count + reference_count
        rankings.append(
            {
                "offset_px": {"dx": dx, "dy": dy},
                "ink_f1": 0.0 if denominator == 0 else 2.0 * intersection / denominator,
                "candidate_to_reference_ink_ratio": (
                    None if reference_count == 0 else candidate_count / reference_count
                ),
                "overlap_ink_pixels": intersection,
                "reference_ink_pixels": reference_count,
            }
        )

    positioned = next(
        item
        for item in rankings
        if item["offset_px"] == {"dx": 0, "dy": 0}
    )
    best_f1 = max(item["ink_f1"] for item in rankings)
    best = [item for item in rankings if item["ink_f1"] == best_f1]
    lower = sorted(
        (item for item in rankings if item["ink_f1"] < best_f1),
        key=lambda item: (
            -item["ink_f1"],
            abs(item["offset_px"]["dx"]) + abs(item["offset_px"]["dy"]),
            item["offset_px"]["dy"],
            item["offset_px"]["dx"],
        ),
    )
    common = {
        "policy": policy,
        "positioned_ink_f1": positioned["ink_f1"],
        "best_local_ink_f1": best_f1,
        "local_gain": best_f1 - positioned["ink_f1"],
        "runner_up": lower[0] if lower else None,
        "work_units": work_units,
    }
    if best_f1 == 0.0:
        return {
            **common,
            "status": "unscorable",
            "classification": "unscorable",
            "reason": "candidate and reference have no overlapping ink in the bounded search window",
        }
    if len(best) != 1:
        return {
            **common,
            "status": "ambiguous",
            "classification": "ambiguous",
            "reason": "multiple local translations have the same best ink F1",
            "best_offsets_px": [item["offset_px"] for item in best],
        }

    winner = best[0]
    offset = winner["offset_px"]
    nonzero_offset = offset != {"dx": 0, "dy": 0}
    ratio = winner["candidate_to_reference_ink_ratio"]
    similar_ink = (
        ratio is not None
        and TEXT_RESIDUAL_INK_RATIO_MIN <= ratio <= TEXT_RESIDUAL_INK_RATIO_MAX
    )
    gain = common["local_gain"]
    if (
        nonzero_offset
        and gain >= TEXT_RESIDUAL_MATERIAL_GAIN
        and best_f1 >= TEXT_RESIDUAL_GEOMETRY_MIN_F1
        and similar_ink
    ):
        classification = "geometry-dominant"
        reason = "bounded local translation materially restores high-fidelity ink overlap"
    elif not nonzero_offset and best_f1 < 1.0:
        classification = "glyph-style-dominant"
        reason = "position is already optimal while glyph ink shape or density remains different"
    elif nonzero_offset and gain >= TEXT_RESIDUAL_MIXED_GAIN:
        classification = "mixed"
        reason = "local translation helps, but glyph ink shape or density remains different"
    else:
        classification = "ambiguous"
        reason = "bounded evidence does not uniquely separate geometry from glyph style"
    return {
        **common,
        "status": "hypothesis" if classification != "ambiguous" else "ambiguous",
        "classification": classification,
        "reason": reason,
        "best_offset_px": offset,
        "candidate_to_reference_ink_ratio": ratio,
        "overlap_ink_pixels": winner["overlap_ink_pixels"],
        "reference_ink_pixels": winner["reference_ink_pixels"],
        "candidate_ink_pixels": candidate_count,
    }


def _vertical_transitions(regions: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    ordered = sorted(
        (
            region
            for region in regions
            if region.get("category") in {"text", "table"}
            and region.get("aligned_bounds_px") is not None
        ),
        key=lambda region: (
            region["aligned_bounds_px"]["top"],
            region["aligned_bounds_px"]["left"],
            region["id"],
        ),
    )
    transitions: List[Dict[str, Any]] = []
    for previous, current in zip(ordered, ordered[1:]):
        previous_bounds = previous["aligned_bounds_px"]
        current_bounds = current["aligned_bounds_px"]
        previous_trace = previous["vertical_trace"]
        current_trace = current["vertical_trace"]
        item: Dict[str, Any] = {
            "from_region_id": previous["id"],
            "from_category": previous["category"],
            "to_region_id": current["id"],
            "to_category": current["category"],
            "candidate_gap_px": current_bounds["top"]
            - (previous_bounds["top"] + previous_bounds["height"]),
        }
        if item["candidate_gap_px"] < 0:
            item.update(
                status="ambiguous",
                reason="aligned source regions overlap, so they are not a sequential vertical transition",
            )
            transitions.append(item)
            continue
        statuses = {previous_trace["status"], current_trace["status"]}
        if "unscorable" in statuses:
            item.update(
                status="unscorable",
                reason="one or both endpoint traces are unscorable",
            )
        elif "ambiguous" in statuses:
            item.update(
                status="ambiguous",
                reason="one or both endpoint traces have tied best offsets",
            )
        elif statuses != {"hypothesis"}:
            item.update(
                status="not-applicable",
                reason="one or both endpoint categories are not traceable",
            )
        else:
            previous_reference_top = previous_bounds["top"] + previous_trace["offset_px"]
            current_reference_top = current_bounds["top"] + current_trace["offset_px"]
            if current_reference_top < previous_reference_top:
                item.update(
                    status="ambiguous",
                    reason="best-offset hypotheses reverse region top order",
                )
            else:
                reference_gap = current_reference_top - (
                    previous_reference_top + previous_bounds["height"]
                )
                if reference_gap < 0:
                    item.update(
                        status="ambiguous",
                        reason="best-offset hypotheses make non-overlapping source regions overlap",
                        reference_gap_hypothesis_px=reference_gap,
                    )
                else:
                    item.update(
                        status="hypothesis",
                        reason=None,
                        from_offset_px=previous_trace["offset_px"],
                        to_offset_px=current_trace["offset_px"],
                        offset_increment_px=(
                            current_trace["offset_px"]
                            - previous_trace["offset_px"]
                        ),
                        reference_gap_hypothesis_px=reference_gap,
                    )
        transitions.append(item)
    return transitions


def _score_visual_regions(
    page_contract: Mapping[str, Any],
    reference: GrayImage,
    aligned_candidate: GrayImage,
    candidate_raw_width: int,
    candidate_raw_height: int,
    translation: Mapping[str, int],
    max_edge_work: int,
) -> List[Dict[str, Any]]:
    page_width = float(page_contract["width"])
    page_height = float(page_contract["height"])
    dx = int(translation["dx"])
    dy = int(translation["dy"])
    results: List[Dict[str, Any]] = []
    vertical_trace_work = 0
    text_residual_work = 0

    def trace(
        category: str,
        paint_status: str,
        bounds: Optional[Mapping[str, int]],
    ) -> Dict[str, Any]:
        nonlocal vertical_trace_work
        result = _vertical_trace(
            category,
            paint_status,
            bounds,
            reference,
            aligned_candidate,
            HARD_MAX_VERTICAL_TRACE_WORK_PER_PAGE - vertical_trace_work,
        )
        vertical_trace_work += int(result.get("work_units", 0))
        return result

    def text_residual(
        category: str,
        paint_status: str,
        bounds: Optional[Mapping[str, int]],
        alignment_clipped: bool,
    ) -> Dict[str, Any]:
        nonlocal text_residual_work
        result = _text_residual_trace(
            category,
            paint_status,
            bounds,
            reference,
            aligned_candidate,
            alignment_clipped,
            HARD_MAX_TEXT_RESIDUAL_WORK_PER_PAGE - text_residual_work,
        )
        text_residual_work += int(result.get("work_units", 0))
        return result

    for region in page_contract["regions"]:
        raw_left = math.floor(float(region["x"]) * candidate_raw_width / page_width)
        raw_top = math.floor(float(region["y"]) * candidate_raw_height / page_height)
        raw_right = math.ceil(
            (float(region["x"]) + float(region["w"]))
            * candidate_raw_width
            / page_width
        )
        raw_bottom = math.ceil(
            (float(region["y"]) + float(region["h"]))
            * candidate_raw_height
            / page_height
        )
        left = max(0, raw_left + dx)
        top = max(0, raw_top + dy)
        right = min(reference.width, raw_right + dx)
        bottom = min(reference.height, raw_bottom + dy)
        base = {
            "id": region["id"],
            "category": region["category"],
            "paint_status": region["paint_status"],
            "glyph_provenance": region["glyph_provenance"],
            "placed_em_bounds_hwpunit": region["placed_em_bounds_hwpunit"],
            "source_bounds_hwpunit": {
                "x": region["x"],
                "y": region["y"],
                "w": region["w"],
                "h": region["h"],
            },
            "source_clipped_to_page": region["clipped"],
            "alignment_clipped": (
                left != raw_left + dx
                or top != raw_top + dy
                or right != raw_right + dx
                or bottom != raw_bottom + dy
            ),
        }
        if region["paint_status"] == "expected-missing":
            base.update(
                {
                    "status": "unscorable",
                    "reason": "source-visible paragraph produced no placed glyph in its page band",
                    "aligned_bounds_px": None,
                    "metrics": None,
                }
            )
            base["vertical_trace"] = trace(
                region["category"],
                region["paint_status"],
                None,
            )
            base["text_residual"] = text_residual(
                region["category"], region["paint_status"], None, False
            )
            results.append(base)
            continue
        if right <= left or bottom <= top:
            base.update(
                {
                    "status": "unscorable",
                    "reason": "region moved outside the fixed page canvas by global alignment",
                    "aligned_bounds_px": None,
                    "metrics": None,
                }
            )
            base["vertical_trace"] = trace(
                region["category"],
                region["paint_status"],
                None,
            )
            base["text_residual"] = text_residual(
                region["category"], region["paint_status"], None, False
            )
            results.append(base)
            continue
        aligned_bounds = {
            "left": left,
            "top": top,
            "width": right - left,
            "height": bottom - top,
        }
        reference_crop = _crop_image(reference, left, top, right, bottom)
        candidate_crop = _crop_image(aligned_candidate, left, top, right, bottom)
        _, metrics = _compare_images(
            reference_crop,
            candidate_crop,
            max_translation=0,
            max_edge_work=max_edge_work,
        )
        base.update(
            {
                "status": metrics["status"],
                "reason": None,
                "aligned_bounds_px": aligned_bounds,
                "metrics": {
                    "global_ssim_like": metrics["ssim_like"]["global"],
                    "local_ssim_like_mean": metrics["ssim_like"]["local"]["mean"],
                    "union_foreground_mae": metrics["union_foreground_mae"],
                    "ink": metrics["ink"],
                    "edge_f1": metrics["edge"]["f1"],
                    "unscorable_metrics": metrics["unscorable_metrics"],
                },
                "vertical_trace": trace(
                    region["category"],
                    region["paint_status"],
                    aligned_bounds,
                ),
                "text_residual": text_residual(
                    region["category"],
                    region["paint_status"],
                    aligned_bounds,
                    base["alignment_clipped"],
                ),
            }
        )
        results.append(base)
    return results


def _format_metric(value: Any) -> str:
    if value is None:
        return "unscorable"
    if isinstance(value, float):
        return f"{value:.6f}"
    return html.escape(str(value))


def _render_html(report: Mapping[str, Any]) -> str:
    candidate = report["inputs"]["candidate"]
    reference = report["inputs"]["reference"]
    structural = report["structural"]
    page_sections: List[str] = []
    for page in report.get("pages", []):
        metrics = page.get("metrics")
        if metrics is None:
            metric_rows = (
                f"<p class=warning>Pixel metrics are unscorable: "
                f"{html.escape(page.get('reason', 'unknown reason'))}</p>"
            )
        else:
            worst_tile = metrics.get("worst_tile_recall")
            raw_bbox = metrics.get("raw_content_bbox")
            aligned_bbox = metrics.get("content_bbox")
            metric_rows = f"""
            <table>
              <tr><th>Metric</th><th>Value</th></tr>
              <tr><td>Raw / aligned global SSIM-like</td><td>{_format_metric(metrics['ssim_like']['raw_global'])} / {_format_metric(metrics['ssim_like']['global'])}</td></tr>
              <tr><td>Raw local mean / worst</td><td>{_format_metric(metrics['ssim_like']['raw_local']['mean'])} / {_format_metric(metrics['ssim_like']['raw_local']['worst'])}</td></tr>
              <tr><td>Aligned local mean / worst</td><td>{_format_metric(metrics['ssim_like']['local']['mean'])} / {_format_metric(metrics['ssim_like']['local']['worst'])}</td></tr>
              <tr><td>Union-foreground MAE</td><td>{_format_metric(metrics['union_foreground_mae'])}</td></tr>
              <tr><td>Ink precision / recall / F1 / IoU</td><td>{_format_metric(metrics['ink']['precision'])} / {_format_metric(metrics['ink']['recall'])} / {_format_metric(metrics['ink']['f1'])} / {_format_metric(metrics['ink']['iou'])}</td></tr>
              <tr><td>Edge F1 (≤ {metrics['edge']['tolerance_px']} px)</td><td>{_format_metric(metrics['edge']['f1'])}</td></tr>
              <tr><td>Ink ratio</td><td>{_format_metric(metrics['ink']['candidate_to_reference_ratio'])}</td></tr>
              <tr><td>Raw / aligned bbox max edge delta</td><td>{_format_metric(None if raw_bbox is None else raw_bbox['max_abs_edge_delta_px'])} / {_format_metric(None if aligned_bbox is None else aligned_bbox['max_abs_edge_delta_px'])}</td></tr>
              <tr><td>Worst-tile recall</td><td>{_format_metric(None if worst_tile is None else worst_tile['recall'])}</td></tr>
            </table>
            """
        semantic_regions = page.get("semantic_regions", [])
        if semantic_regions:
            region_rows = "".join(
                "<tr>"
                f"<td>{html.escape(region['id'])}</td>"
                f"<td>{html.escape(region['category'])}</td>"
                f"<td>{html.escape(region['status'])}</td>"
                f"<td>{_format_metric(None if region.get('metrics') is None else region['metrics']['ink']['f1'])}</td>"
                f"<td>{_format_metric(None if region.get('metrics') is None else region['metrics']['edge_f1'])}</td>"
                f"<td>{html.escape(region.get('vertical_trace', {}).get('status', 'unavailable'))}</td>"
                f"<td>{_format_metric(region.get('vertical_trace', {}).get('offset_px'))}</td>"
                f"<td>{html.escape(str(region.get('text_residual', {}).get('classification') or 'not-applicable'))}</td>"
                f"<td>{html.escape(str(region.get('glyph_provenance', 'not-applicable')))}</td>"
                f"<td>{_format_metric(region.get('placed_em_bounds_hwpunit'))}</td>"
                f"<td>{_format_metric(region.get('text_residual', {}).get('best_local_ink_f1'))}</td>"
                f"<td>{_format_metric(region.get('text_residual', {}).get('local_gain'))}</td>"
                "</tr>"
                for region in semantic_regions
            )
            region_table = (
                "<h3>Semantic regions (additive, report-only)</h3>"
                "<table><tr><th>ID</th><th>Category</th><th>Status</th>"
                "<th>Ink F1</th><th>Edge F1</th><th>Vertical trace</th>"
                "<th>Offset hypothesis (px)</th><th>Text residual</th>"
                "<th>Glyph provenance</th><th>Placed EM bounds (HWPUNIT)</th>"
                "<th>Best local ink F1</th><th>Local gain</th></tr>"
                f"{region_rows}</table>"
            )
        else:
            region_table = "<p class=muted>No first-party semantic region manifest was provided.</p>"
        vertical_transitions = page.get("vertical_transitions", [])
        if vertical_transitions:
            transition_rows = "".join(
                "<tr>"
                f"<td>{html.escape(item['from_region_id'])}</td>"
                f"<td>{html.escape(item['to_region_id'])}</td>"
                f"<td>{html.escape(item['status'])}</td>"
                f"<td>{_format_metric(item.get('candidate_gap_px'))}</td>"
                f"<td>{_format_metric(item.get('offset_increment_px'))}</td>"
                f"<td>{html.escape(str(item.get('reason') or ''))}</td>"
                "</tr>"
                for item in vertical_transitions
            )
            transition_table = (
                "<h3>Vertical transitions (report-only hypotheses)</h3>"
                "<table><tr><th>From</th><th>To</th><th>Status</th>"
                "<th>Candidate gap (px)</th><th>Offset increment (px)</th>"
                "<th>Evidence note</th></tr>"
                f"{transition_rows}</table>"
            )
        else:
            transition_table = ""
        artifacts = page.get("artifacts", {})
        image_cards: List[str] = []
        for key, label in (
            ("reference", "Reference"),
            ("candidate_raw", "Candidate (raw)"),
            ("candidate_aligned", "Candidate (translated only)"),
            ("overlay", "Overlay: reference red, candidate blue"),
            ("heatmap", "Absolute-difference heatmap"),
        ):
            if key in artifacts:
                image_cards.append(
                    f'<figure><figcaption>{html.escape(label)}</figcaption>'
                    f'<img src="{html.escape(artifacts[key])}" alt="{html.escape(label)} page {page["page"]}"></figure>'
                )
        offset = (page.get("alignment") or {}).get("candidate_translation_px")
        offset_text = (
            f"Candidate translation: dx={offset['dx']} px, dy={offset['dy']} px. "
            "Scale=1, rotation=0, crop=false."
            if offset
            else "No alignment was scored."
        )
        page_sections.append(
            f"""
            <section>
              <h2>Page {page['page']} - {html.escape(page['status'])}</h2>
              <p>{html.escape(offset_text)}</p>
              {metric_rows}
              {region_table}
              {transition_table}
              <div class=images>{''.join(image_cards)}</div>
              <details><summary>Page JSON</summary><pre>{html.escape(json.dumps(page, ensure_ascii=False, indent=2, sort_keys=True))}</pre></details>
            </section>
            """
        )

    mismatch_items = "".join(
        f"<li><code>{html.escape(json.dumps(item, ensure_ascii=False, sort_keys=True))}</code></li>"
        for item in structural["mismatches"]
    )
    if mismatch_items:
        structure_notice = (
            "<p class=warning>Structural mismatch: pixel comparison was not attempted.</p>"
            f"<ul>{mismatch_items}</ul>"
        )
    else:
        structure_notice = (
            "<p class=ok>Page count, physical MediaBox size, CropBox coordinates/size "
            "(within 1 pt), rotation, and CropBox orientation match.</p>"
        )

    worst_pages = report.get("summary", {}).get("worst_pages", [])
    worst_tiles = report.get("summary", {}).get("worst_tiles", [])
    worst_regions = report.get("summary", {}).get("worst_regions", [])
    return f"""<!doctype html>
<html lang=en>
<head>
  <meta charset=utf-8>
  <meta name=viewport content="width=device-width, initial-scale=1">
  <title>auto-hwp PDF visual check</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0 auto; max-width: 1500px; padding: 24px; color: #172033; background: #f5f7fb; }}
    header, section {{ background: white; border: 1px solid #d8deea; border-radius: 10px; padding: 20px; margin-bottom: 20px; }}
    h1, h2 {{ margin-top: 0; }}
    code, pre {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
    pre {{ white-space: pre-wrap; overflow-wrap: anywhere; }}
    table {{ border-collapse: collapse; width: 100%; margin: 12px 0; }}
    th, td {{ border: 1px solid #d8deea; padding: 7px 9px; text-align: left; }}
    th {{ background: #eef2f8; }}
    .images {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
    figure {{ margin: 0; min-width: 0; }}
    figcaption {{ font-weight: 600; margin-bottom: 5px; }}
    img {{ display: block; width: 100%; height: auto; border: 1px solid #cbd3e1; background: white; }}
    .warning {{ color: #8a2c0d; font-weight: 700; }}
    .ok {{ color: #17643a; font-weight: 700; }}
    .muted {{ color: #5c667a; }}
    @media (max-width: 800px) {{ .images {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <header>
    <h1>auto-hwp PDF visual check</h1>
    <p class=warning>Report-only. This report intentionally contains no pass/fail verdict.</p>
    <table>
      <tr><th>Candidate</th><td>{html.escape(candidate['path'])}<br><code>{candidate['sha256']}</code></td></tr>
      <tr><th>Reference</th><td>{html.escape(reference['path'])}<br><code>{reference['sha256']}</code></td></tr>
      <tr><th>Reference tier</th><td>{reference['tier']}: {html.escape(reference['tier_description'])}</td></tr>
      <tr><th>Reference product/build</th><td>{html.escape(str(reference.get('product')))} / {html.escape(str(reference.get('build')))}</td></tr>
      <tr><th>Reference OS/font</th><td>{html.escape(str(reference.get('os')))} / {html.escape(str(reference.get('font_fingerprint')))}</td></tr>
      <tr><th>Reference provenance</th><td>{html.escape(str(reference.get('provenance_validation', {}).get('status')))} - {html.escape(str(reference.get('note')))}</td></tr>
      <tr><th>Environment fingerprint</th><td><code>{report['environment']['fingerprint_sha256']}</code></td></tr>
      <tr><th>DPI</th><td>{report['environment']['dpi']}</td></tr>
      <tr><th>Overall status</th><td>{html.escape(report['status'])}</td></tr>
    </table>
    <p class=muted>Full machine-readable data: <a href="report.json">report.json</a></p>
  </header>
  <section>
    <h2>Structural stage</h2>
    {structure_notice}
  </section>
  <section>
    <h2>Worst-page diagnostics</h2>
    <p>Worst pages: <code>{html.escape(json.dumps(worst_pages, ensure_ascii=False, sort_keys=True))}</code></p>
    <p>Worst tiles: <code>{html.escape(json.dumps(worst_tiles, ensure_ascii=False, sort_keys=True))}</code></p>
    <p>Worst semantic regions: <code>{html.escape(json.dumps(worst_regions, ensure_ascii=False, sort_keys=True))}</code></p>
  </section>
  {''.join(page_sections)}
</body>
</html>
"""


def _summarize_pages(pages: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    scored = [page for page in pages if page.get("metrics") is not None]
    unscorable = [page for page in pages if page.get("metrics") is None]
    partially_unscorable = [
        page
        for page in scored
        if page["metrics"].get("status") == "partially_unscorable"
    ]

    def page_key(page: Mapping[str, Any]) -> Tuple[float, float, int]:
        metrics = page["metrics"]
        ink_f1 = metrics["ink"]["f1"]
        local_mean = metrics["ssim_like"]["local"]["mean"]
        return (
            float("inf") if ink_f1 is None else ink_f1,
            float("inf") if local_mean is None else local_mean,
            page["page"],
        )

    worst_pages = []
    for page in sorted(scored, key=page_key)[:5]:
        metrics = page["metrics"]
        worst_tile = metrics["worst_tile_recall"]
        worst_pages.append(
            {
                "page": page["page"],
                "ink_f1": metrics["ink"]["f1"],
                "local_ssim_like_mean": metrics["ssim_like"]["local"]["mean"],
                "worst_tile_recall": None if worst_tile is None else worst_tile["recall"],
            }
        )

    tile_entries = []
    for page in scored:
        worst_tile = page["metrics"]["worst_tile_recall"]
        if worst_tile is not None:
            tile_entries.append(
                {
                    "page": page["page"],
                    "recall": worst_tile["recall"],
                    "tile": worst_tile["tile"],
                }
            )
    tile_entries.sort(key=lambda item: (item["recall"], item["page"]))

    region_entries = []
    unscorable_regions = 0
    partially_unscorable_regions = 0
    category_counts: Dict[str, Dict[str, int]] = {}
    trace_status_counts: Dict[str, int] = {}
    transition_status_counts: Dict[str, int] = {}
    transition_hypotheses: List[Dict[str, Any]] = []
    text_residual_classification_counts: Dict[str, int] = {}
    text_residual_hypotheses: List[Dict[str, Any]] = []
    glyph_provenance_counts: Dict[str, int] = {}
    text_residual_by_glyph_provenance: Dict[str, Dict[str, int]] = {}
    for page in pages:
        for region in page.get("semantic_regions", []):
            trace_status = region.get("vertical_trace", {}).get("status")
            if trace_status is not None:
                trace_status_counts[trace_status] = trace_status_counts.get(trace_status, 0) + 1
            text_residual = region.get("text_residual", {})
            residual_classification = text_residual.get("classification")
            glyph_provenance = region.get("glyph_provenance")
            if region.get("category") == "text" and glyph_provenance is not None:
                glyph_provenance_counts[glyph_provenance] = (
                    glyph_provenance_counts.get(glyph_provenance, 0) + 1
                )
            if residual_classification is not None:
                text_residual_classification_counts[residual_classification] = (
                    text_residual_classification_counts.get(residual_classification, 0) + 1
                )
                if text_residual.get("status") == "hypothesis":
                    provenance_counts = text_residual_by_glyph_provenance.setdefault(
                        str(glyph_provenance), {}
                    )
                    provenance_counts[residual_classification] = (
                        provenance_counts.get(residual_classification, 0) + 1
                    )
                    text_residual_hypotheses.append(
                        {
                            "page": page["page"],
                            "id": region["id"],
                            "classification": residual_classification,
                            "glyph_provenance": glyph_provenance,
                            "placed_em_bounds_hwpunit": region.get(
                                "placed_em_bounds_hwpunit"
                            ),
                            "best_offset_px": text_residual.get("best_offset_px"),
                            "positioned_ink_f1": text_residual.get("positioned_ink_f1"),
                            "best_local_ink_f1": text_residual.get("best_local_ink_f1"),
                            "local_gain": text_residual.get("local_gain"),
                            "candidate_to_reference_ink_ratio": text_residual.get(
                                "candidate_to_reference_ink_ratio"
                            ),
                        }
                    )
            category = region["category"]
            counts = category_counts.setdefault(
                category,
                {"total": 0, "scored": 0, "partially_unscorable": 0, "unscorable": 0},
            )
            counts["total"] += 1
            metrics = region.get("metrics")
            if metrics is None:
                counts["unscorable"] += 1
                unscorable_regions += 1
                continue
            counts["scored"] += 1
            if region.get("status") == "partially_unscorable":
                counts["partially_unscorable"] += 1
                partially_unscorable_regions += 1
            region_entries.append(
                {
                    "page": page["page"],
                    "id": region["id"],
                    "category": category,
                    "ink_f1": metrics["ink"]["f1"],
                    "local_ssim_like_mean": metrics["local_ssim_like_mean"],
                    "edge_f1": metrics["edge_f1"],
                    "aligned_bounds_px": region["aligned_bounds_px"],
                }
            )
        for transition in page.get("vertical_transitions", []):
            transition_status = transition["status"]
            transition_status_counts[transition_status] = (
                transition_status_counts.get(transition_status, 0) + 1
            )
            if transition_status == "hypothesis":
                transition_hypotheses.append(
                    {
                        "page": page["page"],
                        **transition,
                    }
                )

    def region_key(region: Mapping[str, Any]) -> Tuple[float, float, int, str]:
        return (
            float("inf") if region["ink_f1"] is None else region["ink_f1"],
            float("inf")
            if region["local_ssim_like_mean"] is None
            else region["local_ssim_like_mean"],
            region["page"],
            region["id"],
        )
    region_entries.sort(key=region_key)

    return {
        "total_pages": len(pages),
        "scored_pages": len(scored),
        "unscorable_pages": len(unscorable),
        "partially_unscorable_pages": len(partially_unscorable),
        "worst_pages": worst_pages,
        "worst_tiles": tile_entries[:5],
        "worst_regions": region_entries[:5],
        "scored_regions": len(region_entries),
        "partially_unscorable_regions": partially_unscorable_regions,
        "unscorable_regions": unscorable_regions,
        "region_category_counts": category_counts,
        "vertical_trace_status_counts": trace_status_counts,
        "vertical_transition_status_counts": transition_status_counts,
        "vertical_transition_hypotheses": transition_hypotheses,
        "text_residual_classification_counts": text_residual_classification_counts,
        "text_residual_hypotheses": text_residual_hypotheses,
        "glyph_provenance_counts": glyph_provenance_counts,
        "text_residual_by_glyph_provenance": text_residual_by_glyph_provenance,
    }


def _ensure_output_target(output_dir: Path) -> None:
    if output_dir.exists() or output_dir.is_symlink():
        raise VisualCheckError(f"output path already exists; choose a new directory: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)


def _register_report_asset(
    generated_assets: Dict[str, Path],
    relative_name: str,
    source: Path,
    limits: ResourceLimits,
    current_asset_bytes: int,
) -> int:
    if Path(relative_name).name != relative_name or not relative_name.endswith(".png"):
        raise VisualCheckError(f"invalid generated PNG asset name: {relative_name}")
    asset_bytes = _force_private_regular_file(source)
    if asset_bytes > limits.max_report_asset_bytes:
        raise VisualCheckError(
            f"report asset {relative_name} is {asset_bytes} bytes; "
            f"limit is {limits.max_report_asset_bytes}"
        )
    next_total = current_asset_bytes + asset_bytes
    if next_total > limits.max_report_bytes:
        raise VisualCheckError(
            f"report assets total {next_total} bytes exceeds "
            f"--max-report-bytes {limits.max_report_bytes}"
        )
    generated_assets[relative_name] = source
    return next_total


def _write_report(
    output_dir: Path,
    report: Dict[str, Any],
    generated_assets: Mapping[str, Path],
    limits: ResourceLimits,
) -> None:
    normalized_report = _round_numbers(report)
    try:
        report_json = json.dumps(
            normalized_report,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        ) + "\n"
    except ValueError as error:
        raise VisualCheckError(
            "report contains a non-finite or otherwise invalid JSON value"
        ) from error
    # Render first, then stage every output beside the final directory. A
    # rendering/copy failure leaves no partial report that blocks a retry.
    report_html = _render_html(normalized_report)
    report_json_bytes = len(report_json.encode("utf-8"))
    report_html_bytes = len(report_html.encode("utf-8"))
    source_asset_bytes = 0
    for relative_name, source in sorted(generated_assets.items()):
        if Path(relative_name).name != relative_name or not relative_name.endswith(".png"):
            raise VisualCheckError(f"invalid generated PNG asset name: {relative_name}")
        asset_bytes = _force_private_regular_file(source)
        if asset_bytes > limits.max_report_asset_bytes:
            raise VisualCheckError(
                f"report asset {relative_name} is {asset_bytes} bytes; "
                f"limit is {limits.max_report_asset_bytes}"
            )
        source_asset_bytes += asset_bytes
    projected_total = report_json_bytes + report_html_bytes + source_asset_bytes
    if projected_total > limits.max_report_bytes:
        raise VisualCheckError(
            f"final report would be {projected_total} bytes; "
            f"limit is {limits.max_report_bytes}"
        )

    with tempfile.TemporaryDirectory(
        prefix=".auto-hwp-pdf-report-", dir=str(output_dir.parent)
    ) as staging_parent:
        _make_private_directory(Path(staging_parent), exist_ok=True)
        staging_dir = Path(staging_parent) / "report"
        _make_private_directory(staging_dir)
        assets_dir = staging_dir / "assets"
        _make_private_directory(assets_dir)
        copied_total = 0
        for relative_name, source in sorted(generated_assets.items()):
            copied_bytes = _copy_private_regular_file(
                source, assets_dir / relative_name
            )
            if copied_bytes > limits.max_report_asset_bytes:
                raise VisualCheckError(
                    f"copied report asset {relative_name} is {copied_bytes} bytes; "
                    f"limit is {limits.max_report_asset_bytes}"
                )
            copied_total += copied_bytes
            if copied_total > limits.max_report_bytes:
                raise VisualCheckError(
                    f"copied report assets total {copied_total} bytes exceeds "
                    f"--max-report-bytes {limits.max_report_bytes}"
                )
        written_total = copied_total
        written_total += _write_private_text(staging_dir / "report.json", report_json)
        if written_total > limits.max_report_bytes:
            raise VisualCheckError(
                f"staged report exceeds --max-report-bytes {limits.max_report_bytes}"
            )
        written_total += _write_private_text(staging_dir / "index.html", report_html)
        if written_total > limits.max_report_bytes:
            raise VisualCheckError(
                f"staged report exceeds --max-report-bytes {limits.max_report_bytes}"
            )
        if output_dir.exists() or output_dir.is_symlink():
            raise VisualCheckError(
                f"output path appeared during report generation: {output_dir}"
            )
        os.chmod(staging_dir, 0o700)
        os.chmod(assets_dir, 0o700)
        staging_dir.rename(output_dir)
        os.chmod(output_dir, 0o700)


def _limits_from_args(args: argparse.Namespace) -> ResourceLimits:
    return ResourceLimits(
        max_input_bytes=args.max_input_bytes,
        max_pages=args.max_pages,
        max_page_pixels=args.max_page_pixels,
        max_total_pixels=args.max_total_pixels,
        max_raster_bytes=args.max_raster_bytes,
        max_total_raster_bytes=args.max_total_raster_bytes,
        max_png_decompressed_bytes=args.max_png_decompressed_bytes,
        max_ink_pixels=args.max_ink_pixels,
        max_alignment_work=args.max_alignment_work,
        max_edge_work=args.max_edge_work,
        max_report_asset_bytes=args.max_report_asset_bytes,
        max_report_bytes=args.max_report_bytes,
        max_subprocess_output_bytes=args.max_subprocess_output_bytes,
        subprocess_timeout_seconds=args.subprocess_timeout_seconds,
    )


def _provenance_validation(args: argparse.Namespace) -> Dict[str, Any]:
    fields = {
        "product": args.reference_product,
        "build": args.reference_build,
        "os": args.reference_os,
        "font_fingerprint": args.font_fingerprint,
        "note": args.reference_note,
    }
    required = list(fields) if args.reference_tier in ("T0", "T1") else []
    missing = [
        name
        for name in required
        if not isinstance(fields[name], str) or not fields[name].strip()
    ]
    if missing:
        status = "incomplete"
    elif required:
        status = "self_attested"
    else:
        status = "optional_unverified"
    return {
        "status": status,
        "required_fields": required,
        "missing_fields": missing,
        "authentication": "caller_assertion_not_cryptographically_verified",
    }


def _environment_details(args: argparse.Namespace, limits: ResourceLimits) -> Dict[str, Any]:
    details = {
        "dpi": DPI,
        "background": "white",
        "input_snapshotting": "copy_before_hash_inspect_and_raster",
        "pdfinfo": _tool_version(
            "pdfinfo",
            limits.subprocess_timeout_seconds,
            limits.max_subprocess_output_bytes,
        ),
        "pdftoppm": _tool_version(
            "pdftoppm",
            limits.subprocess_timeout_seconds,
            limits.max_subprocess_output_bytes,
        ),
        "platform_system": platform.system(),
        "platform_release": platform.release(),
        "platform_machine": platform.machine(),
        "python_implementation": platform.python_implementation(),
        "python_version": platform.python_version(),
        "candidate_font_fingerprint": args.candidate_font_fingerprint,
        "reference_font_fingerprint": args.font_fingerprint,
        "ink_threshold_gray_lt": INK_THRESHOLD,
        "edge_tolerance_px": EDGE_TOLERANCE_PX,
        "local_ssim_window_px": LOCAL_SSIM_WINDOW_PX,
        "worst_tile_size_px": TILE_SIZE_PX,
        "crop_policy": "pdfinfo CropBox contract plus pdftoppm -cropbox",
        "raster_output_file_size_cap": _raster_file_size_cap_mode(),
        "input_open_policy": (
            "regular_file_descriptor_with_o_nofollow"
            if hasattr(os, "O_NOFOLLOW")
            else "regular_file_descriptor_without_platform_o_nofollow"
        ),
        "report_permissions": "directories_0700_files_0600",
    }
    canonical = json.dumps(details, ensure_ascii=False, sort_keys=True).encode("utf-8")
    details["fingerprint_sha256"] = hashlib.sha256(canonical).hexdigest()
    return details


def _reported_path(path_value: str, include_input_paths: bool) -> str:
    path = Path(path_value)
    return str(path) if include_input_paths else path.name


def _base_report(
    args: argparse.Namespace,
    candidate_sha: str,
    reference_sha: str,
    candidate_bytes: int,
    reference_bytes: int,
    limits: ResourceLimits,
) -> Dict[str, Any]:
    provenance = _provenance_validation(args)
    return {
        "schema_version": SCHEMA_VERSION,
        "report_only": True,
        "policy": {
            "mode": "report-only",
            "pass": None,
            "note": "No absolute or regression threshold is applied in this slice.",
        },
        "inputs": {
            "candidate": {
                "path": _reported_path(args.candidate, args.include_input_paths),
                "path_redacted": not args.include_input_paths,
                "sha256": candidate_sha,
                "bytes": candidate_bytes,
            },
            "reference": {
                "path": _reported_path(args.reference, args.include_input_paths),
                "path_redacted": not args.include_input_paths,
                "sha256": reference_sha,
                "bytes": reference_bytes,
                "tier": args.reference_tier,
                "tier_description": REFERENCE_TIERS[args.reference_tier],
                "product": args.reference_product,
                "build": args.reference_build,
                "os": args.reference_os,
                "font_fingerprint": args.font_fingerprint,
                "note": args.reference_note,
                "provenance_validation": provenance,
            },
        },
        "environment": _environment_details(args, limits),
        "resource_limits": limits.as_dict(),
        "alignment_policy": {
            "page_size_tolerance_pt": PAGE_SIZE_TOLERANCE_PT,
            "raster_canvas": "white_pad_right_and_bottom_only",
            "max_raster_padding_px": MAX_RASTER_PADDING_PX,
            "translation_only": True,
            "max_abs_translation_px": args.max_translation_px,
            "scale": 1.0,
            "rotation_degrees": 0,
            "crop": False,
            "resize": False,
        },
    }


def _run_visual_check(args: argparse.Namespace) -> Dict[str, Any]:
    try:
        return _run_visual_check_impl(args)
    except (MemoryError, OverflowError) as error:
        raise VisualCheckError(
            "resource exhaustion while inspecting, rasterizing, or scoring PDFs"
        ) from error


def _run_visual_check_impl(args: argparse.Namespace) -> Dict[str, Any]:
    candidate_path = Path(args.candidate)
    reference_path = Path(args.reference)
    output_dir = Path(args.output_dir)
    limits = _limits_from_args(args)
    provenance = _provenance_validation(args)
    if provenance["missing_fields"]:
        raise VisualCheckError(
            f"{args.reference_tier} reference requires provenance fields: "
            + ", ".join(provenance["missing_fields"])
        )
    for dependency in ("pdfinfo", "pdftoppm"):
        if shutil.which(dependency) is None:
            raise VisualCheckError(f"required Poppler command is unavailable: {dependency}")
    for label, path in (("candidate", candidate_path), ("reference", reference_path)):
        if not path.is_file():
            raise VisualCheckError(f"{label} PDF does not exist: {path}")
    _ensure_output_target(output_dir)

    # Snapshot each input once. Hashing, pdfinfo, and rasterization all consume
    # these exact bytes, so a concurrently replaced source path cannot make the
    # report hash describe different content from the rendered pages.
    with tempfile.TemporaryDirectory(prefix="auto-hwp-pdf-visual-") as temporary:
        temporary_path = Path(temporary)
        candidate_snapshot = temporary_path / "candidate.pdf"
        reference_snapshot = temporary_path / "reference.pdf"
        regions_snapshot = None
        candidate_bytes = _snapshot_file(
            candidate_path, candidate_snapshot, limits.max_input_bytes
        )
        reference_bytes = _snapshot_file(
            reference_path, reference_snapshot, limits.max_input_bytes
        )
        if args.candidate_regions:
            regions_snapshot = temporary_path / "candidate-regions.json"
            _snapshot_file(
                Path(args.candidate_regions),
                regions_snapshot,
                MAX_VISUAL_REGION_MANIFEST_BYTES,
            )
        return _run_visual_check_from_snapshots(
            args,
            candidate_snapshot,
            reference_snapshot,
            output_dir,
            temporary_path,
            candidate_bytes,
            reference_bytes,
            limits,
            regions_snapshot,
        )


def _run_visual_check_from_snapshots(
    args: argparse.Namespace,
    candidate_snapshot: Path,
    reference_snapshot: Path,
    output_dir: Path,
    temporary_path: Path,
    candidate_bytes: int,
    reference_bytes: int,
    limits: ResourceLimits,
    regions_snapshot: Optional[Path] = None,
) -> Dict[str, Any]:
    candidate_sha = _sha256(candidate_snapshot)
    reference_sha = _sha256(reference_snapshot)
    report = _base_report(
        args,
        candidate_sha,
        reference_sha,
        candidate_bytes,
        reference_bytes,
        limits,
    )
    candidate_info = _inspect_pdf(candidate_snapshot, limits)
    reference_info = _inspect_pdf(reference_snapshot, limits)
    visual_regions = (
        _load_visual_regions(regions_snapshot, candidate_sha, candidate_info)
        if regions_snapshot is not None
        else None
    )
    report["inputs"]["candidate"]["visual_regions"] = (
        {
            "provided": True,
            "schema_version": VISUAL_REGION_SCHEMA_VERSION,
            "sha256": visual_regions["sha256"],
            "bytes": visual_regions["bytes"],
            "total_regions": visual_regions["total_regions"],
            "category_counts": visual_regions["category_counts"],
            "intentional_blank_text_regions": visual_regions[
                "intentional_blank_text_regions"
            ],
        }
        if visual_regions is not None
        else {"provided": False}
    )
    structural = _compare_pdf_structure(candidate_info, reference_info)
    report["structural"] = structural
    report["pages"] = []

    if structural["status"] != "match":
        report["status"] = "structural_mismatch"
        report["resource_usage"] = {
            "raster_mode": "not_started_due_to_structural_mismatch",
            "actual_total_pixels": 0,
            "actual_total_raster_bytes": 0,
        }
        report["summary"] = {
            "total_pages": 0,
            "scored_pages": 0,
            "unscorable_pages": 0,
            "partially_unscorable_pages": 0,
            "worst_pages": [],
            "worst_tiles": [],
            "worst_regions": [],
            "scored_regions": 0,
            "unscorable_regions": 0,
            "vertical_trace_status_counts": {},
            "vertical_transition_status_counts": {},
            "vertical_transition_hypotheses": [],
            "text_residual_classification_counts": {},
            "text_residual_hypotheses": [],
            "glyph_provenance_counts": {},
            "text_residual_by_glyph_provenance": {},
            "pixel_comparison_attempted": False,
        }
        _write_report(output_dir, report, {}, limits)
        return report

    generated_assets: Dict[str, Path] = {}
    report_asset_bytes = 0
    preflight = _preflight_pixels(candidate_info, reference_info, limits)
    total_raster_bytes = 0
    total_actual_pixels = 0
    report["resource_usage"] = {
        "raster_mode": "page_by_page",
        "preflight": preflight,
        "actual_total_pixels": 0,
        "actual_total_raster_bytes": 0,
        "generated_asset_bytes": 0,
    }

    for page_number in range(1, candidate_info.page_count + 1):
        candidate_raster, candidate_raster_bytes = _rasterize_pdf_page(
            candidate_snapshot,
            temporary_path,
            "candidate",
            page_number,
            limits,
        )
        total_raster_bytes += candidate_raster_bytes
        if total_raster_bytes > limits.max_total_raster_bytes:
            raise VisualCheckError(
                f"total raster bytes {total_raster_bytes} exceed "
                f"--max-total-raster-bytes {limits.max_total_raster_bytes}"
            )
        reference_raster, reference_raster_bytes = _rasterize_pdf_page(
            reference_snapshot,
            temporary_path,
            "reference",
            page_number,
            limits,
        )
        total_raster_bytes += reference_raster_bytes
        if total_raster_bytes > limits.max_total_raster_bytes:
            raise VisualCheckError(
                f"total raster bytes {total_raster_bytes} exceed "
                f"--max-total-raster-bytes {limits.max_total_raster_bytes}"
            )
        candidate_raw_image = _read_png_gray(
            candidate_raster,
            max_file_bytes=limits.max_raster_bytes,
            max_pixels=limits.max_page_pixels,
            max_decompressed_bytes=limits.max_png_decompressed_bytes,
        )
        reference_raw_image = _read_png_gray(
            reference_raster,
            max_file_bytes=limits.max_raster_bytes,
            max_pixels=limits.max_page_pixels,
            max_decompressed_bytes=limits.max_png_decompressed_bytes,
        )
        page_actual_pixels = (
            candidate_raw_image.width * candidate_raw_image.height
            + reference_raw_image.width * reference_raw_image.height
        )
        total_actual_pixels += page_actual_pixels
        if total_actual_pixels > limits.max_total_pixels:
            raise VisualCheckError(
                f"actual total pixels {total_actual_pixels} exceed "
                f"--max-total-pixels {limits.max_total_pixels}"
            )
        report["resource_usage"]["actual_total_pixels"] = total_actual_pixels
        report["resource_usage"]["actual_total_raster_bytes"] = total_raster_bytes
        prefix = f"page-{page_number:04d}"
        reference_name = f"{prefix}-reference.png"
        candidate_raw_name = f"{prefix}-candidate-raw.png"
        reference_asset = temporary_path / reference_name
        candidate_raw_asset = temporary_path / candidate_raw_name
        _copy_private_regular_file(reference_raster, reference_asset)
        report_asset_bytes = _register_report_asset(
            generated_assets,
            reference_name,
            reference_asset,
            limits,
            report_asset_bytes,
        )
        _copy_private_regular_file(candidate_raster, candidate_raw_asset)
        report_asset_bytes = _register_report_asset(
            generated_assets,
            candidate_raw_name,
            candidate_raw_asset,
            limits,
            report_asset_bytes,
        )
        report["resource_usage"]["generated_asset_bytes"] = report_asset_bytes
        artifacts = {
            "reference": f"assets/{reference_name}",
            "candidate_raw": f"assets/{candidate_raw_name}",
        }

        width_delta = abs(candidate_raw_image.width - reference_raw_image.width)
        height_delta = abs(candidate_raw_image.height - reference_raw_image.height)
        if width_delta > MAX_RASTER_PADDING_PX or height_delta > MAX_RASTER_PADDING_PX:
            semantic_regions = []
            if visual_regions is not None:
                semantic_regions = [
                    {
                        "id": region["id"],
                        "category": region["category"],
                        "paint_status": region["paint_status"],
                        "glyph_provenance": region["glyph_provenance"],
                        "placed_em_bounds_hwpunit": region[
                            "placed_em_bounds_hwpunit"
                        ],
                        "source_bounds_hwpunit": {
                            key: region[key] for key in ("x", "y", "w", "h")
                        },
                        "source_clipped_to_page": region["clipped"],
                        "alignment_clipped": False,
                        "status": "unscorable",
                        "reason": "page raster dimensions are unscorable without forbidden resizing",
                        "aligned_bounds_px": None,
                        "metrics": None,
                        "vertical_trace": _vertical_trace(
                            region["category"],
                            region["paint_status"],
                            None,
                            reference_raw_image,
                            candidate_raw_image,
                        ),
                        "text_residual": _text_residual_trace(
                            region["category"],
                            region["paint_status"],
                            None,
                            reference_raw_image,
                            candidate_raw_image,
                        ),
                    }
                    for region in visual_regions["document"]["pages"][page_number - 1]["regions"]
                ]
            report["pages"].append(
                {
                    "page": page_number,
                    "status": "unscorable",
                    "reason": (
                        "raster dimensions differ beyond the A4 rounding padding bound; "
                        "resize/rotate/crop is forbidden"
                    ),
                    "reference_dimensions_px": {
                        "width": reference_raw_image.width,
                        "height": reference_raw_image.height,
                    },
                    "candidate_dimensions_px": {
                        "width": candidate_raw_image.width,
                        "height": candidate_raw_image.height,
                    },
                    "max_padding_px": MAX_RASTER_PADDING_PX,
                    "resource_usage": {
                        "candidate_raster_bytes": candidate_raster_bytes,
                        "reference_raster_bytes": reference_raster_bytes,
                        "combined_pixels": page_actual_pixels,
                    },
                    "alignment": None,
                    "metrics": None,
                    "semantic_regions": semantic_regions,
                    "vertical_transitions": [],
                    "intentional_blank_text_regions": (
                        visual_regions["document"]["pages"][page_number - 1][
                            "intentional_blank_text_regions"
                        ]
                        if visual_regions is not None
                        else 0
                    ),
                    "artifacts": artifacts,
                }
            )
            continue

        canvas_width = max(candidate_raw_image.width, reference_raw_image.width)
        canvas_height = max(candidate_raw_image.height, reference_raw_image.height)
        candidate_image = _pad_image(
            candidate_raw_image, canvas_width, canvas_height
        )
        reference_image = _pad_image(
            reference_raw_image, canvas_width, canvas_height
        )
        raster_canvas = {
            "policy": "white_pad_right_and_bottom_only",
            "canvas_dimensions_px": {
                "width": canvas_width,
                "height": canvas_height,
            },
            "candidate_original_dimensions_px": {
                "width": candidate_raw_image.width,
                "height": candidate_raw_image.height,
            },
            "reference_original_dimensions_px": {
                "width": reference_raw_image.width,
                "height": reference_raw_image.height,
            },
            "candidate_padding_px": {
                "right": canvas_width - candidate_raw_image.width,
                "bottom": canvas_height - candidate_raw_image.height,
            },
            "reference_padding_px": {
                "right": canvas_width - reference_raw_image.width,
                "bottom": canvas_height - reference_raw_image.height,
            },
            "resize": False,
            "rotation_degrees": 0,
            "crop": False,
        }

        metric_preflight = _preflight_metric_work(
            reference_image,
            candidate_image,
            args.max_translation_px,
            limits,
        )
        aligned_candidate, metrics = _compare_images(
            reference_image,
            candidate_image,
            max_translation=args.max_translation_px,
            max_edge_work=limits.max_edge_work,
        )
        aligned_name = f"{prefix}-candidate-aligned.png"
        overlay_name = f"{prefix}-overlay.png"
        heatmap_name = f"{prefix}-heatmap.png"
        _write_gray_png(temporary_path / aligned_name, aligned_candidate)
        _write_rgb_png(
            temporary_path / overlay_name,
            reference_image.width,
            reference_image.height,
            _overlay_pixels(reference_image, aligned_candidate),
        )
        _write_rgb_png(
            temporary_path / heatmap_name,
            reference_image.width,
            reference_image.height,
            _heatmap_pixels(reference_image, aligned_candidate),
        )
        for name in (aligned_name, overlay_name, heatmap_name):
            report_asset_bytes = _register_report_asset(
                generated_assets,
                name,
                temporary_path / name,
                limits,
                report_asset_bytes,
            )
        report["resource_usage"]["generated_asset_bytes"] = report_asset_bytes
        artifacts.update(
            {
                "candidate_aligned": f"assets/{aligned_name}",
                "overlay": f"assets/{overlay_name}",
                "heatmap": f"assets/{heatmap_name}",
            }
        )
        semantic_regions = []
        if visual_regions is not None:
            semantic_regions = _score_visual_regions(
                visual_regions["document"]["pages"][page_number - 1],
                reference_image,
                aligned_candidate,
                candidate_raw_image.width,
                candidate_raw_image.height,
                metrics["alignment"]["candidate_translation_px"],
                limits.max_edge_work,
            )
        vertical_transitions = _vertical_transitions(semantic_regions)
        report["pages"].append(
            {
                "page": page_number,
                "status": metrics["status"],
                "resource_usage": {
                    "candidate_raster_bytes": candidate_raster_bytes,
                    "reference_raster_bytes": reference_raster_bytes,
                    "combined_pixels": page_actual_pixels,
                    "metric_preflight": metric_preflight,
                },
                "raster_canvas": raster_canvas,
                "alignment": metrics["alignment"],
                "metrics": metrics,
                "semantic_regions": semantic_regions,
                "vertical_transitions": vertical_transitions,
                "intentional_blank_text_regions": (
                    visual_regions["document"]["pages"][page_number - 1][
                        "intentional_blank_text_regions"
                    ]
                    if visual_regions is not None
                    else 0
                ),
                "artifacts": artifacts,
            }
        )

    report["summary"] = _summarize_pages(report["pages"])
    report["summary"]["intentional_blank_text_regions"] = sum(
        page.get("intentional_blank_text_regions", 0) for page in report["pages"]
    )
    report["summary"]["pixel_comparison_attempted"] = True
    if report["summary"]["unscorable_pages"]:
        report["status"] = "partially_unscorable"
    elif report["summary"]["partially_unscorable_pages"]:
        report["status"] = "partially_unscorable"
    else:
        report["status"] = "scored_report"
    _write_report(output_dir, report, generated_assets, limits)
    return report


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return parsed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Create a report-only visual comparison of an own-engine candidate PDF "
            "and an explicitly tiered PDF reference."
        )
    )
    parser.add_argument("candidate", help="candidate PDF exported by auto-hwp")
    parser.add_argument("--reference", required=True, help="reference PDF")
    parser.add_argument(
        "--candidate-regions",
        help=(
            "optional schema-v2 content-free HWPUNIT region manifest emitted from "
            "the same first-party placement as the candidate PDF"
        ),
    )
    parser.add_argument(
        "--reference-tier",
        required=True,
        choices=sorted(REFERENCE_TIERS),
        help="explicit reference authority tier; the script never infers this",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="new directory for report.json, index.html, and assets",
    )
    parser.add_argument("--reference-product", help="reference renderer/product name")
    parser.add_argument("--reference-build", help="reference renderer/product build")
    parser.add_argument("--reference-os", help="reference rendering OS")
    parser.add_argument(
        "--font-fingerprint",
        help="font-set fingerprint or manifest identifier used for the reference",
    )
    parser.add_argument(
        "--candidate-font-fingerprint",
        help="font-set fingerprint used by the own-engine candidate export",
    )
    parser.add_argument("--reference-note", help="provenance note for the reference")
    parser.add_argument(
        "--include-input-paths",
        action="store_true",
        help="include full input paths in the report; default keeps only basenames",
    )
    parser.add_argument(
        "--max-translation-px",
        type=int,
        default=MAX_TRANSLATION_PX,
        choices=range(0, MAX_TRANSLATION_PX + 1),
        metavar="0..3",
        help="integer translation search bound; scaling/rotation/cropping stay forbidden",
    )
    parser.add_argument(
        "--max-input-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_INPUT_BYTES,
        help="maximum bytes per candidate/reference PDF",
    )
    parser.add_argument(
        "--max-pages",
        type=_positive_int,
        default=DEFAULT_MAX_PAGES,
        help="maximum pages per PDF",
    )
    parser.add_argument(
        "--max-page-pixels",
        type=_positive_int,
        default=DEFAULT_MAX_PAGE_PIXELS,
        help="maximum pixels in one 144 DPI raster page",
    )
    parser.add_argument(
        "--max-total-pixels",
        type=_positive_int,
        default=DEFAULT_MAX_TOTAL_PIXELS,
        help="maximum estimated/actual raster pixels across both PDFs",
    )
    parser.add_argument(
        "--max-raster-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_RASTER_BYTES,
        help="maximum compressed PNG bytes per Poppler page",
    )
    parser.add_argument(
        "--max-total-raster-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_TOTAL_RASTER_BYTES,
        help="maximum Poppler PNG bytes across both PDFs",
    )
    parser.add_argument(
        "--max-png-decompressed-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_PNG_DECOMPRESSED_BYTES,
        help="maximum decompressed PNG scanline bytes per page",
    )
    parser.add_argument(
        "--max-ink-pixels",
        type=_positive_int,
        default=DEFAULT_MAX_INK_PIXELS,
        help="maximum foreground ink pixels per candidate/reference page image",
    )
    parser.add_argument(
        "--max-alignment-work",
        type=_positive_int,
        default=DEFAULT_MAX_ALIGNMENT_WORK,
        help="maximum candidate ink pixels multiplied by translation offsets per page",
    )
    parser.add_argument(
        "--max-edge-work",
        type=_positive_int,
        default=DEFAULT_MAX_EDGE_WORK,
        help=(
            "maximum conservative foreground/edge pixels multiplied by "
            "tolerance-neighbor probes per page"
        ),
    )
    parser.add_argument(
        "--max-report-asset-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_REPORT_ASSET_BYTES,
        help="maximum bytes for one final report PNG asset",
    )
    parser.add_argument(
        "--max-report-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_REPORT_BYTES,
        help="maximum combined bytes for final JSON, HTML, and PNG assets",
    )
    parser.add_argument(
        "--max-subprocess-output-bytes",
        type=_positive_int,
        default=DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES,
        help="maximum combined stdout/stderr bytes for each Poppler invocation",
    )
    parser.add_argument(
        "--subprocess-timeout-seconds",
        type=_positive_float,
        default=DEFAULT_SUBPROCESS_TIMEOUT_SECONDS,
        help="timeout for each pdfinfo/pdftoppm invocation",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        report = _run_visual_check(args)
    except (OSError, ValueError, VisualCheckError) as error:
        print(f"pdf-visual-check: error: {error}", file=sys.stderr)
        return 2
    output_dir = Path(args.output_dir)
    print(f"status: {report['status']} (report-only; no pass/fail verdict)")
    print(f"json: {output_dir / 'report.json'}")
    print(f"html: {output_dir / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
