#!/usr/bin/env python3
"""Dependency-free tests for scripts/pdf-visual-check.py metrics.

The Poppler self-compare is skipped when pdfinfo/pdftoppm or the repository
benchmark fixture is unavailable.  All metric tests use synthetic byte arrays.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "pdf-visual-check.py"
SPEC = importlib.util.spec_from_file_location("pdf_visual_check", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import machinery failure
    raise RuntimeError(f"could not import {SCRIPT_PATH}")
pdf_visual_check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pdf_visual_check
SPEC.loader.exec_module(pdf_visual_check)


def gray_image(width: int, height: int, ink_points=()):
    pixels = bytearray([255]) * (width * height)
    for point in ink_points:
        if len(point) == 2:
            x, y = point
            value = 0
        else:
            x, y, value = point
        pixels[y * width + x] = value
    return pdf_visual_check.GrayImage(width, height, bytes(pixels))


def rectangle(left: int, top: int, right: int, bottom: int):
    return [
        (x, y)
        for y in range(top, bottom + 1)
        for x in range(left, right + 1)
    ]


def default_limits(**overrides):
    values = {
        "max_input_bytes": pdf_visual_check.DEFAULT_MAX_INPUT_BYTES,
        "max_pages": pdf_visual_check.DEFAULT_MAX_PAGES,
        "max_page_pixels": pdf_visual_check.DEFAULT_MAX_PAGE_PIXELS,
        "max_total_pixels": pdf_visual_check.DEFAULT_MAX_TOTAL_PIXELS,
        "max_raster_bytes": pdf_visual_check.DEFAULT_MAX_RASTER_BYTES,
        "max_total_raster_bytes": pdf_visual_check.DEFAULT_MAX_TOTAL_RASTER_BYTES,
        "max_png_decompressed_bytes": pdf_visual_check.DEFAULT_MAX_PNG_DECOMPRESSED_BYTES,
        "max_ink_pixels": pdf_visual_check.DEFAULT_MAX_INK_PIXELS,
        "max_alignment_work": pdf_visual_check.DEFAULT_MAX_ALIGNMENT_WORK,
        "max_edge_work": pdf_visual_check.DEFAULT_MAX_EDGE_WORK,
        "max_report_asset_bytes": pdf_visual_check.DEFAULT_MAX_REPORT_ASSET_BYTES,
        "max_report_bytes": pdf_visual_check.DEFAULT_MAX_REPORT_BYTES,
        "max_subprocess_output_bytes": (
            pdf_visual_check.DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES
        ),
        "subprocess_timeout_seconds": pdf_visual_check.DEFAULT_SUBPROCESS_TIMEOUT_SECONDS,
    }
    values.update(overrides)
    return pdf_visual_check.ResourceLimits(**values)


class MetricTests(unittest.TestCase):
    def test_identical_images_are_exact_without_translation(self):
        image = gray_image(16, 16, rectangle(4, 4, 9, 9))

        aligned, metrics = pdf_visual_check._compare_images(image, image)

        self.assertEqual(aligned, image)
        self.assertEqual(
            metrics["alignment"]["candidate_translation_px"], {"dx": 0, "dy": 0}
        )
        self.assertEqual(metrics["ssim_like"]["global"], 1.0)
        self.assertEqual(metrics["ssim_like"]["local"]["mean"], 1.0)
        self.assertEqual(metrics["ssim_like"]["local"]["worst"], 1.0)
        self.assertEqual(metrics["union_foreground_mae"], 0.0)
        self.assertEqual(metrics["ink"]["precision"], 1.0)
        self.assertEqual(metrics["ink"]["recall"], 1.0)
        self.assertEqual(metrics["ink"]["f1"], 1.0)
        self.assertEqual(metrics["ink"]["iou"], 1.0)
        self.assertEqual(metrics["edge"]["f1"], 1.0)
        self.assertEqual(metrics["ink"]["candidate_to_reference_ratio"], 1.0)
        self.assertEqual(metrics["content_bbox"]["max_abs_edge_delta_px"], 0)
        self.assertEqual(metrics["worst_tile_recall"]["recall"], 1.0)
        self.assertEqual(metrics["unscorable_metrics"], {})


class VisualRegionTests(unittest.TestCase):
    def page_info(self):
        return pdf_visual_check.PdfInfo(
            1,
            (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
        )

    def manifest(self, candidate_sha256: str):
        return {
            "schema_version": 2,
            "coordinate_space": "HWPUNIT",
            "candidate_pdf_sha256": candidate_sha256,
            "pages": [
                {
                    "page": 1,
                    "width": 59500.0,
                    "height": 84200.0,
                    "intentional_blank_text_regions": 2,
                    "regions": [
                        {
                            "id": "text-0001",
                            "category": "text",
                            "paint_status": "painted",
                            "x": 1000.0,
                            "y": 2000.0,
                            "w": 10000.0,
                            "h": 3000.0,
                            "clipped": False,
                        }
                    ],
                }
            ],
        }

    def load(self, document, candidate_sha256):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "regions.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            return pdf_visual_check._load_visual_regions(
                path, candidate_sha256, self.page_info()
            )

    def test_manifest_is_sha_bound_strict_and_content_free(self):
        candidate_sha256 = "a" * 64
        loaded = self.load(self.manifest(candidate_sha256), candidate_sha256)
        self.assertEqual(loaded["total_regions"], 1)
        self.assertEqual(loaded["category_counts"]["text"], 1)
        self.assertEqual(loaded["intentional_blank_text_regions"], 2)
        self.assertNotIn("text", loaded["document"]["pages"][0]["regions"][0])

        for mutation, pattern in (
            (lambda doc: doc.update({"unknown": True}), "fields differ"),
            (lambda doc: doc.update({"candidate_pdf_sha256": "b" * 64}), "SHA-256 mismatch"),
            (lambda doc: doc["pages"][0].update({"width": 59400}), "dimensions do not match"),
            (lambda doc: doc["pages"][0]["regions"][0].update({"category": "secret"}), "category"),
            (
                lambda doc: doc["pages"][0]["regions"][0].update(
                    {"paint_status": "not-applicable"}
                ),
                "paint_status",
            ),
            (
                lambda doc: doc["pages"][0].update(
                    {"intentional_blank_text_regions": -1}
                ),
                "intentional_blank_text_regions",
            ),
            (lambda doc: doc["pages"][0]["regions"][0].update({"x": -1}), "outside its page"),
            (lambda doc: doc["pages"][0]["regions"][0].update({"w": float("nan")}), "non-finite"),
        ):
            with self.subTest(pattern=pattern):
                document = self.manifest(candidate_sha256)
                mutation(document)
                with self.assertRaisesRegex(pdf_visual_check.VisualCheckError, pattern):
                    self.load(document, candidate_sha256)

    def test_manifest_rejects_overlapping_regions_that_exhaust_scoring_work(self):
        candidate_sha256 = "a" * 64
        document = self.manifest(candidate_sha256)
        document["pages"][0]["regions"] = [
            {
                "id": f"text-{index:04d}",
                "category": "text",
                "paint_status": "painted",
                "x": 0.0,
                "y": 0.0,
                "w": 59500.0,
                "h": 84200.0,
                "clipped": False,
            }
            for index in range(
                1, pdf_visual_check.MAX_VISUAL_REGION_PAGE_AREA_MULTIPLIER + 2
            )
        ]

        with self.assertRaisesRegex(pdf_visual_check.VisualCheckError, "scoring budget"):
            self.load(document, candidate_sha256)

    def test_manifest_rejects_page_mismatch_and_duplicate_region_ids(self):
        candidate_sha256 = "a" * 64
        no_pages = self.manifest(candidate_sha256)
        no_pages["pages"] = []
        with self.assertRaisesRegex(pdf_visual_check.VisualCheckError, "page count"):
            self.load(no_pages, candidate_sha256)

        duplicate = self.manifest(candidate_sha256)
        duplicate["pages"][0]["regions"].append(
            dict(duplicate["pages"][0]["regions"][0])
        )
        with self.assertRaisesRegex(pdf_visual_check.VisualCheckError, "duplicate"):
            self.load(duplicate, candidate_sha256)

    def test_semantic_region_uses_global_alignment_without_a_second_search(self):
        ink = rectangle(2, 2, 5, 5)
        reference = gray_image(10, 10, ink)
        candidate = gray_image(10, 10, ink)
        page = {
            "width": 100.0,
            "height": 100.0,
            "regions": [
                {
                    "id": "table-0001",
                    "category": "table",
                    "paint_status": "not-applicable",
                    "x": 20.0,
                    "y": 20.0,
                    "w": 40.0,
                    "h": 40.0,
                    "clipped": False,
                }
            ],
        }
        regions = pdf_visual_check._score_visual_regions(
            page, reference, candidate, 10, 10, {"dx": 0, "dy": 0}, 100_000
        )
        self.assertEqual(regions[0]["metrics"]["ink"]["f1"], 1.0)
        self.assertEqual(regions[0]["metrics"]["global_ssim_like"], 1.0)

        missing = pdf_visual_check._score_visual_regions(
            page,
            reference,
            gray_image(10, 10),
            10,
            10,
            {"dx": 0, "dy": 0},
            100_000,
        )
        self.assertEqual(missing[0]["metrics"]["ink"]["f1"], 0.0)

        page["regions"][0]["category"] = "text"
        page["regions"][0]["id"] = "text-0001"
        page["regions"][0]["paint_status"] = "expected-missing"
        explicit_missing = pdf_visual_check._score_visual_regions(
            page, reference, candidate, 10, 10, {"dx": 0, "dy": 0}, 100_000
        )
        self.assertEqual(explicit_missing[0]["status"], "unscorable")
        self.assertIsNone(explicit_missing[0]["metrics"])
        self.assertIn("no placed glyph", explicit_missing[0]["reason"])
        self.assertEqual(missing[0]["status"], "partially_unscorable")
        summary = pdf_visual_check._summarize_pages(
            [{"page": 1, "metrics": None, "semantic_regions": missing}]
        )
        self.assertEqual(summary["scored_regions"], 1)
        self.assertEqual(summary["partially_unscorable_regions"], 1)
        self.assertEqual(
            summary["region_category_counts"]["table"]["partially_unscorable"], 1
        )


class VerticalTraceTests(unittest.TestCase):
    def bounds(self, left=0, top=0, width=3, height=6):
        return {"left": left, "top": top, "width": width, "height": height}

    def test_exact_and_constant_offset_are_report_only_hypotheses(self):
        candidate = gray_image(8, 24, [(1, 6), (2, 7)])
        exact = pdf_visual_check._vertical_trace(
            "text", "painted", self.bounds(top=4), candidate, candidate
        )
        reference = gray_image(8, 24, [(1, 9), (2, 10)])
        shifted = pdf_visual_check._vertical_trace(
            "text", "painted", self.bounds(top=4), reference, candidate
        )

        self.assertEqual(exact["status"], "hypothesis")
        self.assertEqual(exact["offset_px"], 0)
        self.assertEqual(shifted["status"], "hypothesis")
        self.assertEqual(shifted["offset_px"], 3)
        self.assertEqual(shifted["policy"]["role"], "report_only_hypothesis")
        self.assertNotIn("passed", shifted)

    def test_two_transition_offsets_expose_cumulative_increment_and_blank_gap(self):
        candidate = gray_image(12, 48, [(1, 11), (6, 27)])
        reference = gray_image(12, 48, [(1, 13), (6, 32)])
        first_bounds = self.bounds(left=0, top=9, width=3, height=5)
        second_bounds = self.bounds(left=5, top=25, width=3, height=5)
        regions = [
            {
                "id": "text-0001",
                "category": "text",
                "aligned_bounds_px": first_bounds,
                "vertical_trace": pdf_visual_check._vertical_trace(
                    "text", "painted", first_bounds, reference, candidate
                ),
            },
            {
                "id": "table-0002",
                "category": "table",
                "aligned_bounds_px": second_bounds,
                "vertical_trace": pdf_visual_check._vertical_trace(
                    "table", "not-applicable", second_bounds, reference, candidate
                ),
            },
        ]

        transitions = pdf_visual_check._vertical_transitions(regions)

        self.assertEqual(regions[0]["vertical_trace"]["offset_px"], 2)
        self.assertEqual(regions[1]["vertical_trace"]["offset_px"], 5)
        self.assertEqual(transitions[0]["status"], "hypothesis")
        self.assertEqual(transitions[0]["candidate_gap_px"], 11)
        self.assertEqual(transitions[0]["offset_increment_px"], 3)
        self.assertEqual(transitions[0]["reference_gap_hypothesis_px"], 14)

    def test_repeated_row_pattern_is_explicitly_ambiguous(self):
        candidate = gray_image(4, 16, [(1, 3)])
        reference = gray_image(4, 16, [(1, 3), (1, 9)])
        trace = pdf_visual_check._vertical_trace(
            "text", "painted", self.bounds(top=2, width=3, height=3), reference, candidate
        )

        self.assertEqual(trace["status"], "ambiguous")
        self.assertEqual(trace["best_offsets_px"], [0, 6])
        self.assertIn("same best", trace["reason"])

    def test_page_edge_clips_search_window_without_moving_the_region(self):
        candidate = gray_image(5, 12, [(1, 1)])
        reference = gray_image(5, 12, [(1, 2)])
        trace = pdf_visual_check._vertical_trace(
            "text", "painted", self.bounds(top=0, height=4), reference, candidate
        )

        self.assertEqual(trace["status"], "hypothesis")
        self.assertEqual(trace["offset_px"], 1)
        self.assertEqual(trace["considered_offsets_px"], {"min": 0, "max": 8, "count": 9})

    def test_missing_blank_and_nontext_evidence_never_become_zero_score(self):
        blank = gray_image(6, 12)
        reference = gray_image(6, 12, [(1, 4)])
        bounds = self.bounds(top=2)

        missing = pdf_visual_check._vertical_trace(
            "text", "painted", bounds, reference, blank
        )
        expected_missing = pdf_visual_check._vertical_trace(
            "text", "expected-missing", None, reference, blank
        )
        nontext = pdf_visual_check._vertical_trace(
            "image", "not-applicable", bounds, reference, blank
        )

        self.assertEqual(missing["status"], "unscorable")
        self.assertEqual(expected_missing["status"], "unscorable")
        self.assertEqual(nontext["status"], "not-applicable")
        self.assertNotIn("offset_px", missing)

    def test_trace_work_is_bounded_and_reported_unscorable(self):
        image = gray_image(10, 20, [(1, 4)])
        trace = pdf_visual_check._vertical_trace(
            "text", "painted", self.bounds(top=2), image, image, max_work=1
        )

        self.assertEqual(trace["status"], "unscorable")
        self.assertIn("work budget", trace["reason"])
        self.assertEqual(trace["work_units"], 0)

    def test_overlapping_regions_are_not_claimed_as_sequential_transitions(self):
        trace = {"status": "hypothesis", "offset_px": 0}
        transitions = pdf_visual_check._vertical_transitions(
            [
                {
                    "id": "table-0001",
                    "category": "table",
                    "aligned_bounds_px": self.bounds(top=2, height=8),
                    "vertical_trace": trace,
                },
                {
                    "id": "text-0002",
                    "category": "text",
                    "aligned_bounds_px": self.bounds(top=5, height=2),
                    "vertical_trace": trace,
                },
            ]
        )

        self.assertEqual(transitions[0]["status"], "ambiguous")
        self.assertIn("overlap", transitions[0]["reason"])


class TextResidualTraceTests(unittest.TestCase):
    def bounds(self, left=10, top=10, width=10, height=10):
        return {"left": left, "top": top, "width": width, "height": height}

    def trace(self, reference, candidate, bounds=None, **kwargs):
        return pdf_visual_check._text_residual_trace(
            "text",
            "painted",
            bounds or self.bounds(),
            reference,
            candidate,
            max_translation=kwargs.pop("max_translation", 4),
            **kwargs,
        )

    def test_pure_local_translation_is_geometry_dominant(self):
        candidate = gray_image(32, 32, rectangle(12, 12, 15, 15))
        reference = gray_image(32, 32, rectangle(15, 14, 18, 17))

        trace = self.trace(reference, candidate)

        self.assertEqual(trace["status"], "hypothesis")
        self.assertEqual(trace["classification"], "geometry-dominant")
        self.assertEqual(trace["best_offset_px"], {"dx": 3, "dy": 2})
        self.assertEqual(trace["best_local_ink_f1"], 1.0)
        self.assertGreaterEqual(trace["local_gain"], 0.15)

    def test_same_position_with_different_stroke_is_glyph_style_dominant(self):
        candidate_points = [(12, 12), (13, 12), (12, 13)]
        reference_points = candidate_points + [(13, 13)]
        candidate = gray_image(32, 32, candidate_points)
        reference = gray_image(32, 32, reference_points)

        trace = self.trace(reference, candidate)

        self.assertEqual(trace["status"], "hypothesis")
        self.assertEqual(trace["classification"], "glyph-style-dominant")
        self.assertEqual(trace["best_offset_px"], {"dx": 0, "dy": 0})
        self.assertLess(trace["best_local_ink_f1"], 1.0)

    def test_translation_plus_shape_change_is_mixed(self):
        candidate_points = [(12, 12), (13, 12), (12, 13)]
        reference_points = [(16, 12), (17, 12), (16, 13), (17, 13), (18, 12)]
        candidate = gray_image(32, 32, candidate_points)
        reference = gray_image(32, 32, reference_points)

        trace = self.trace(reference, candidate)

        self.assertEqual(trace["status"], "hypothesis")
        self.assertEqual(trace["classification"], "mixed")
        self.assertEqual(trace["best_offset_px"], {"dx": 4, "dy": 0})
        self.assertLess(trace["best_local_ink_f1"], 0.9)

    def test_repeated_shape_is_ambiguous_instead_of_inventing_a_class(self):
        points = [(12, 12), (13, 12), (12, 13)]
        candidate = gray_image(40, 40, points)
        reference = gray_image(40, 40, points + [(x + 8, y) for x, y in points])
        bounds = self.bounds(left=10, top=10, width=5, height=5)

        trace = self.trace(
            reference, candidate, bounds=bounds, max_translation=8
        )

        self.assertEqual(trace["status"], "ambiguous")
        self.assertEqual(trace["classification"], "ambiguous")
        self.assertEqual(
            trace["best_offsets_px"],
            [{"dx": 0, "dy": 0}, {"dx": 8, "dy": 0}],
        )

    def test_blank_clipping_and_budget_are_explicitly_unscorable(self):
        blank = gray_image(32, 32)
        ink = gray_image(32, 32, [(12, 12)])

        no_candidate = self.trace(ink, blank)
        clipped = self.trace(
            ink,
            ink,
            bounds=self.bounds(left=2, top=2),
        )
        exhausted = self.trace(ink, ink, max_work=1)

        self.assertEqual(no_candidate["classification"], "unscorable")
        self.assertIn("no ink", no_candidate["reason"])
        self.assertEqual(clipped["classification"], "unscorable")
        self.assertIn("page edge", clipped["reason"])
        self.assertEqual(exhausted["classification"], "unscorable")
        self.assertIn("work budget", exhausted["reason"])
        self.assertEqual(exhausted["work_units"], 0)

    def test_nontext_and_expected_missing_never_receive_a_hypothesis(self):
        image = gray_image(32, 32, [(12, 12)])
        nontext = pdf_visual_check._text_residual_trace(
            "table", "not-applicable", self.bounds(), image, image
        )
        missing = pdf_visual_check._text_residual_trace(
            "text", "expected-missing", None, image, image
        )

        self.assertEqual(nontext["status"], "not-applicable")
        self.assertIsNone(nontext["classification"])
        self.assertEqual(missing["classification"], "unscorable")

    def test_summary_counts_classes_and_keeps_only_content_free_hypotheses(self):
        residual = {
            "status": "hypothesis",
            "classification": "geometry-dominant",
            "best_offset_px": {"dx": 3, "dy": 2},
            "positioned_ink_f1": 0.1,
            "best_local_ink_f1": 0.95,
            "local_gain": 0.85,
            "candidate_to_reference_ink_ratio": 1.0,
        }
        summary = pdf_visual_check._summarize_pages(
            [
                {
                    "page": 1,
                    "metrics": None,
                    "semantic_regions": [
                        {
                            "id": "text-0001",
                            "category": "text",
                            "metrics": None,
                            "text_residual": residual,
                        },
                        {
                            "id": "text-0002",
                            "category": "text",
                            "metrics": None,
                            "text_residual": {
                                "status": "ambiguous",
                                "classification": "ambiguous",
                            },
                        },
                    ],
                }
            ]
        )

        self.assertEqual(
            summary["text_residual_classification_counts"],
            {"geometry-dominant": 1, "ambiguous": 1},
        )
        self.assertEqual(
            summary["text_residual_hypotheses"],
            [
                {
                    "page": 1,
                    "id": "text-0001",
                    "classification": "geometry-dominant",
                    "best_offset_px": {"dx": 3, "dy": 2},
                    "positioned_ink_f1": 0.1,
                    "best_local_ink_f1": 0.95,
                    "local_gain": 0.85,
                    "candidate_to_reference_ink_ratio": 1.0,
                }
            ],
        )


class MetricRegressionTests(unittest.TestCase):
    def test_bounded_translation_is_detected_and_reported(self):
        reference = gray_image(16, 16, rectangle(2, 2, 5, 5))
        candidate = gray_image(16, 16, rectangle(4, 3, 7, 6))

        aligned, metrics = pdf_visual_check._compare_images(reference, candidate)

        self.assertEqual(
            metrics["alignment"]["candidate_translation_px"], {"dx": -2, "dy": -1}
        )
        self.assertEqual(metrics["alignment"]["scale"], 1.0)
        self.assertEqual(metrics["alignment"]["rotation_degrees"], 0)
        self.assertFalse(metrics["alignment"]["crop"])
        self.assertEqual(aligned, reference)
        self.assertEqual(metrics["ink"]["f1"], 1.0)

    def test_translation_search_never_exceeds_three_pixels(self):
        reference = gray_image(16, 16, rectangle(2, 2, 4, 4))
        candidate = gray_image(16, 16, rectangle(7, 2, 9, 4))

        _, metrics = pdf_visual_check._compare_images(reference, candidate)

        offset = metrics["alignment"]["candidate_translation_px"]
        self.assertLessEqual(abs(offset["dx"]), 3)
        self.assertLessEqual(abs(offset["dy"]), 3)
        self.assertLess(metrics["ink"]["f1"], 1.0)
        with self.assertRaises(ValueError):
            pdf_visual_check._compare_images(reference, candidate, max_translation=4)

    def test_alignment_cannot_hide_candidate_ink_off_canvas(self):
        reference = gray_image(5, 2, [(0, 0), (1, 0)])
        candidate = gray_image(5, 2, [(0, 0), (2, 0), (3, 0)])

        _, metrics = pdf_visual_check._compare_images(reference, candidate)

        self.assertEqual(
            metrics["alignment"]["candidate_translation_px"], {"dx": -2, "dy": 0}
        )
        self.assertEqual(metrics["alignment"]["clipped_candidate_ink_pixels"], 1)
        self.assertEqual(metrics["ink"]["candidate_pixels"], 3)
        self.assertEqual(metrics["ink"]["candidate_visible_pixels_after_translation"], 2)
        self.assertEqual(metrics["ink"]["candidate_clipped_pixels"], 1)
        self.assertAlmostEqual(metrics["ink"]["precision"], 2 / 3, places=6)
        self.assertEqual(metrics["ink"]["recall"], 1.0)
        self.assertEqual(metrics["ink"]["f1"], 0.8)
        self.assertAlmostEqual(metrics["ink"]["iou"], 2 / 3, places=6)
        self.assertEqual(metrics["ink"]["candidate_to_reference_ratio"], 1.5)
        self.assertGreater(metrics["union_foreground_mae"], 0.0)
        self.assertLess(metrics["ssim_like"]["raw_global"], 1.0)
        self.assertEqual(metrics["ssim_like"]["global"], 1.0)
        self.assertGreater(
            metrics["raw_content_bbox"]["max_abs_edge_delta_px"], 0
        )
        self.assertEqual(metrics["content_bbox"]["max_abs_edge_delta_px"], 0)

    def test_worst_tile_exposes_a_tiny_missing_object(self):
        main_content = rectangle(10, 10, 19, 19)
        tiny_object = [(200, 20)]
        reference = gray_image(256, 64, main_content + tiny_object)
        candidate = gray_image(256, 64, main_content)

        _, metrics = pdf_visual_check._compare_images(
            reference, candidate, max_translation=0
        )

        self.assertGreater(metrics["ssim_like"]["global"], 0.99)
        self.assertGreater(metrics["ink"]["recall"], 0.98)
        self.assertEqual(metrics["worst_tile_recall"]["recall"], 0.0)
        self.assertEqual(metrics["worst_tile_recall"]["tile"]["left"], 128)
        self.assertGreater(metrics["union_foreground_mae"], 0.0)

    def test_blank_foreground_metrics_are_null_not_zero(self):
        blank = gray_image(8, 8)

        _, metrics = pdf_visual_check._compare_images(blank, blank)

        self.assertEqual(metrics["status"], "partially_unscorable")
        self.assertEqual(metrics["ssim_like"]["global"], 1.0)
        self.assertIsNone(metrics["union_foreground_mae"])
        self.assertIsNone(metrics["ink"]["precision"])
        self.assertIsNone(metrics["ink"]["recall"])
        self.assertIsNone(metrics["ink"]["f1"])
        self.assertIsNone(metrics["ink"]["iou"])
        self.assertIsNone(metrics["edge"]["f1"])
        self.assertIsNone(metrics["content_bbox"])
        self.assertIsNone(metrics["worst_tile_recall"])
        self.assertIn("ink_f1", metrics["unscorable_metrics"])

    def test_edge_f1_uses_two_pixel_tolerance(self):
        reference = gray_image(12, 12, [(4, y) for y in range(2, 9)])
        candidate = gray_image(12, 12, [(5, y) for y in range(2, 9)])

        _, metrics = pdf_visual_check._compare_images(
            reference, candidate, max_translation=0
        )

        self.assertEqual(metrics["ink"]["f1"], 0.0)
        self.assertEqual(metrics["edge"]["tolerance_px"], 2)
        self.assertEqual(metrics["edge"]["f1"], 1.0)
        self.assertEqual(metrics["content_bbox"]["delta_px"]["left"], 1)

    def test_candidate_missing_all_ink_is_scorable_as_loss(self):
        reference = gray_image(8, 8, [(3, 3)])
        candidate = gray_image(8, 8)

        _, metrics = pdf_visual_check._compare_images(
            reference, candidate, max_translation=0
        )

        self.assertEqual(metrics["ink"]["recall"], 0.0)
        self.assertEqual(metrics["ink"]["f1"], 0.0)
        self.assertEqual(metrics["ink"]["iou"], 0.0)
        self.assertIsNone(metrics["ink"]["precision"])
        self.assertEqual(metrics["worst_tile_recall"]["recall"], 0.0)

    def test_dimension_mismatch_is_not_resized(self):
        reference = gray_image(8, 8)
        candidate = gray_image(9, 8)

        with self.assertRaisesRegex(ValueError, "resizing is forbidden"):
            pdf_visual_check._compare_images(reference, candidate)

    def test_padding_adds_white_right_and_bottom_without_resampling(self):
        image = gray_image(2, 2, [(0, 0), (1, 1, 128)])

        padded = pdf_visual_check._pad_image(image, 3, 4)

        self.assertEqual((padded.width, padded.height), (3, 4))
        self.assertEqual(padded.pixels[0], 0)
        self.assertEqual(padded.pixels[1], 255)
        self.assertEqual(padded.pixels[3], 255)
        self.assertEqual(padded.pixels[4], 128)
        self.assertTrue(all(value == 255 for value in padded.pixels[6:]))
        with self.assertRaises(ValueError):
            pdf_visual_check._pad_image(image, 1, 2)

    def test_partial_local_ssim_windows_are_weighted_by_pixel_count(self):
        reference = gray_image(65, 64)
        candidate = gray_image(65, 64, [(64, y) for y in range(64)])

        result = pdf_visual_check._local_ssim_like(reference, candidate)

        self.assertEqual(result["window_count"], 2)
        self.assertEqual(result["mean_weighting"], "window_pixel_count")
        self.assertEqual(result["total_pixels"], 65 * 64)
        self.assertGreater(result["mean"], 0.95)
        self.assertLess(result["worst"], 0.1)


class PngCodecTests(unittest.TestCase):
    def test_grayscale_png_round_trip_is_exact(self):
        image = gray_image(
            4,
            3,
            [(0, 0, 0), (1, 0, 64), (2, 1, 128), (3, 2, 240)],
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "gray.png"
            pdf_visual_check._write_gray_png(path, image)
            decoded = pdf_visual_check._read_png_gray(path)
        self.assertEqual(decoded, image)

    def test_rgb_png_is_flattened_to_deterministic_gray(self):
        rgb = bytes(
            [
                0,
                0,
                0,
                255,
                255,
                255,
                255,
                0,
                0,
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rgb.png"
            pdf_visual_check._write_rgb_png(path, 3, 1, rgb)
            decoded = pdf_visual_check._read_png_gray(path)
        self.assertEqual(decoded.pixels[0], 0)
        self.assertEqual(decoded.pixels[1], 255)
        self.assertEqual(decoded.pixels[2], 77)

    def test_png_file_pixel_and_decompressed_limits_are_enforced(self):
        image = gray_image(8, 8, [(1, 1)])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bounded.png"
            pdf_visual_check._write_gray_png(path, image)
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "PNG size"
            ):
                pdf_visual_check._read_png_gray(
                    path, max_file_bytes=path.stat().st_size - 1
                )
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "pixel count"
            ):
                pdf_visual_check._read_png_gray(path, max_pixels=63)
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "decompressed scanlines"
            ):
                pdf_visual_check._read_png_gray(
                    path, max_decompressed_bytes=8 * 9 - 1
                )


class StructuralTests(unittest.TestCase):
    def page(
        self,
        number,
        box=(0.0, 0.0, 595.0, 842.0),
        rotation=0,
        crop=None,
    ):
        return pdf_visual_check.PdfPageInfo(number, box, rotation, crop)

    def test_matching_structure_is_explicit(self):
        candidate = pdf_visual_check.PdfInfo(1, (self.page(1),))
        reference = pdf_visual_check.PdfInfo(1, (self.page(1),))

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        self.assertEqual(result["status"], "match")
        self.assertEqual(result["mismatches"], [])

    def test_page_count_media_box_and_orientation_mismatch_are_separate(self):
        candidate = pdf_visual_check.PdfInfo(
            2,
            (
                self.page(1, (0.0, 0.0, 842.0, 595.0)),
                self.page(2),
            ),
        )
        reference = pdf_visual_check.PdfInfo(1, (self.page(1),))

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        self.assertEqual(result["status"], "mismatch")
        kinds = [mismatch["kind"] for mismatch in result["mismatches"]]
        self.assertIn("page_count", kinds)
        self.assertIn("media_box_size", kinds)
        self.assertIn("orientation", kinds)

    def test_standard_a4_rounding_within_one_point_matches(self):
        candidate = pdf_visual_check.PdfInfo(
            1, (self.page(1, (0.0, 0.0, 595.28, 841.88)),)
        )
        reference = pdf_visual_check.PdfInfo(
            1, (self.page(1, (0.0, 0.0, 595.0, 841.0)),)
        )

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        self.assertEqual(result["status"], "match")

    def test_physical_page_difference_over_one_point_is_rejected(self):
        candidate = pdf_visual_check.PdfInfo(
            1, (self.page(1, (0.0, 0.0, 596.01, 842.0)),)
        )
        reference = pdf_visual_check.PdfInfo(1, (self.page(1),))

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        kinds = [mismatch["kind"] for mismatch in result["mismatches"]]
        self.assertIn("media_box_size", kinds)

    def test_rotation_mismatch_is_not_auto_corrected(self):
        candidate = pdf_visual_check.PdfInfo(1, (self.page(1, rotation=90),))
        reference = pdf_visual_check.PdfInfo(1, (self.page(1, rotation=0),))

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        kinds = [mismatch["kind"] for mismatch in result["mismatches"]]
        self.assertIn("rotation", kinds)
        self.assertIn("orientation", kinds)

    def test_crop_box_offset_or_size_mismatch_is_structural(self):
        candidate = pdf_visual_check.PdfInfo(
            1, (self.page(1, crop=(10.0, 20.0, 585.0, 822.0)),)
        )
        reference = pdf_visual_check.PdfInfo(
            1, (self.page(1, crop=(12.0, 20.0, 585.0, 822.0)),)
        )

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        kinds = [mismatch["kind"] for mismatch in result["mismatches"]]
        self.assertIn("crop_box", kinds)
        self.assertEqual(
            result["candidate"]["pages"][0]["crop_box_pt"],
            [10.0, 20.0, 585.0, 822.0],
        )

    def test_invalid_crop_box_is_rejected_before_pixels(self):
        candidate = pdf_visual_check.PdfInfo(
            1, (self.page(1, crop=(-2.0, 0.0, 595.0, 842.0)),)
        )
        reference = pdf_visual_check.PdfInfo(1, (self.page(1),))

        result = pdf_visual_check._compare_pdf_structure(candidate, reference)

        kinds = [mismatch["kind"] for mismatch in result["mismatches"]]
        self.assertIn("invalid_candidate_boxes", kinds)

    def test_crop_box_drives_orientation(self):
        page = self.page(1, crop=(0.0, 0.0, 595.0, 300.0))

        self.assertEqual(page.orientation, "landscape")


class ReportOrchestrationTests(unittest.TestCase):
    def parse_args(self, candidate: Path, reference: Path, output: Path, extra=()):
        return pdf_visual_check._build_parser().parse_args(
            [
                str(candidate),
                "--reference",
                str(reference),
                "--reference-tier",
                "T3",
                "--output-dir",
                str(output),
            ]
            + list(extra)
        )

    def test_structure_mismatch_writes_report_without_rasterizing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            output = root / "report"
            args = self.parse_args(candidate, reference, output)
            candidate_info = pdf_visual_check.PdfInfo(
                2,
                (
                    pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),
                    pdf_visual_check.PdfPageInfo(2, (0.0, 0.0, 595.0, 842.0), 0),
                ),
            )
            reference_info = pdf_visual_check.PdfInfo(
                1,
                (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check,
                    "_inspect_pdf",
                    side_effect=[candidate_info, reference_info],
                ),
                mock.patch.object(
                    pdf_visual_check, "_rasterize_pdf_page"
                ) as rasterize,
            ):
                report = pdf_visual_check._run_visual_check(args)

            rasterize.assert_not_called()
            self.assertEqual(report["status"], "structural_mismatch")
            self.assertFalse(report["summary"]["pixel_comparison_attempted"])
            self.assertIsNone(report["policy"]["pass"])
            self.assertTrue((output / "report.json").is_file())
            self.assertTrue((output / "index.html").is_file())
            written = json.loads((output / "report.json").read_text())
            self.assertEqual(
                written["inputs"]["candidate"]["sha256"],
                pdf_visual_check._sha256(candidate),
            )
            self.assertEqual(
                written["inputs"]["reference"]["sha256"],
                pdf_visual_check._sha256(reference),
            )
            self.assertEqual(written["inputs"]["candidate"]["path"], "candidate.pdf")
            self.assertTrue(written["inputs"]["candidate"]["path_redacted"])
            self.assertEqual(
                written["resource_usage"]["raster_mode"],
                "not_started_due_to_structural_mismatch",
            )

    def test_large_raster_dimension_mismatch_is_a_complete_unscorable_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            candidate_png = root / "candidate.png"
            reference_png = root / "reference.png"
            pdf_visual_check._write_gray_png(candidate_png, gray_image(12, 8, [(1, 1)]))
            pdf_visual_check._write_gray_png(reference_png, gray_image(8, 8, [(1, 1)]))
            output = root / "report"
            args = self.parse_args(candidate, reference, output)
            page_info = pdf_visual_check.PdfInfo(
                1,
                (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check, "_inspect_pdf", side_effect=[page_info, page_info]
                ),
                mock.patch.object(
                    pdf_visual_check,
                    "_rasterize_pdf_page",
                    side_effect=[
                        (candidate_png, candidate_png.stat().st_size),
                        (reference_png, reference_png.stat().st_size),
                    ],
                ),
            ):
                report = pdf_visual_check._run_visual_check(args)

            self.assertEqual(report["status"], "partially_unscorable")
            self.assertIsNone(report["pages"][0]["alignment"])
            self.assertIsNone(report["pages"][0]["metrics"])
            self.assertTrue((output / "report.json").is_file())
            html_text = (output / "index.html").read_text()
            self.assertIn("Pixel metrics are unscorable", html_text)

    def test_crop_box_mismatch_never_calls_rasterizer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            output = root / "report"
            args = self.parse_args(candidate, reference, output)
            candidate_info = pdf_visual_check.PdfInfo(
                1,
                (
                    pdf_visual_check.PdfPageInfo(
                        1,
                        (0.0, 0.0, 595.0, 842.0),
                        0,
                        (10.0, 10.0, 585.0, 832.0),
                    ),
                ),
            )
            reference_info = pdf_visual_check.PdfInfo(
                1,
                (
                    pdf_visual_check.PdfPageInfo(
                        1,
                        (0.0, 0.0, 595.0, 842.0),
                        0,
                        (12.0, 10.0, 585.0, 832.0),
                    ),
                ),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check,
                    "_inspect_pdf",
                    side_effect=[candidate_info, reference_info],
                ),
                mock.patch.object(
                    pdf_visual_check, "_rasterize_pdf_page"
                ) as rasterize,
            ):
                report = pdf_visual_check._run_visual_check(args)

            rasterize.assert_not_called()
            self.assertEqual(report["status"], "structural_mismatch")
            self.assertIn(
                "crop_box",
                [item["kind"] for item in report["structural"]["mismatches"]],
            )

    def test_small_raster_rounding_difference_is_white_padded_and_scored(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            candidate_png = root / "candidate.png"
            reference_png = root / "reference.png"
            pdf_visual_check._write_gray_png(candidate_png, gray_image(9, 10, [(1, 1)]))
            pdf_visual_check._write_gray_png(reference_png, gray_image(8, 8, [(1, 1)]))
            output = root / "report"
            args = self.parse_args(candidate, reference, output)
            page_info = pdf_visual_check.PdfInfo(
                1,
                (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check, "_inspect_pdf", side_effect=[page_info, page_info]
                ),
                mock.patch.object(
                    pdf_visual_check,
                    "_rasterize_pdf_page",
                    side_effect=[
                        (candidate_png, candidate_png.stat().st_size),
                        (reference_png, reference_png.stat().st_size),
                    ],
                ),
            ):
                report = pdf_visual_check._run_visual_check(args)

            self.assertEqual(report["status"], "scored_report")
            page = report["pages"][0]
            self.assertEqual(
                page["raster_canvas"]["canvas_dimensions_px"],
                {"width": 9, "height": 10},
            )
            self.assertEqual(
                page["raster_canvas"]["reference_padding_px"],
                {"right": 1, "bottom": 2},
            )
            self.assertFalse(page["raster_canvas"]["resize"])
            self.assertEqual(page["metrics"]["ink"]["f1"], 1.0)

    def test_full_run_is_byte_deterministic_for_identical_inputs(self):
        """The complete report tree is stable, not only its parsed metrics."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raster_root = root / "rasters"
            raster_root.mkdir()
            candidate_raster = raster_root / "candidate.png"
            reference_raster = raster_root / "reference.png"
            pdf_visual_check._write_gray_png(
                candidate_raster,
                gray_image(32, 24, rectangle(5, 5, 13, 13) + [(25, 8)]),
            )
            pdf_visual_check._write_gray_png(
                reference_raster,
                gray_image(32, 24, rectangle(4, 5, 12, 13) + [(24, 8)]),
            )
            page_info = pdf_visual_check.PdfInfo(
                1,
                (
                    pdf_visual_check.PdfPageInfo(
                        1, (0.0, 0.0, 595.0, 842.0), 0
                    ),
                ),
            )

            args_by_run = []
            for run_name in ("run-a", "run-b"):
                input_root = root / run_name / "inputs"
                input_root.mkdir(parents=True)
                candidate = input_root / "candidate.pdf"
                reference = input_root / "reference.pdf"
                candidate.write_bytes(b"identical-candidate-pdf")
                reference.write_bytes(b"identical-reference-pdf")
                args_by_run.append(
                    self.parse_args(
                        candidate,
                        reference,
                        root / run_name / "report",
                    )
                )

            def rasterize(_pdf, _destination, label, _page, _limits):
                source = (
                    candidate_raster if label == "candidate" else reference_raster
                )
                return source, source.stat().st_size

            reports = []
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(
                    pdf_visual_check, "_tool_version", return_value="mock-poppler 1"
                ),
                mock.patch.object(
                    pdf_visual_check, "_inspect_pdf", return_value=page_info
                ),
                mock.patch.object(
                    pdf_visual_check,
                    "_rasterize_pdf_page",
                    side_effect=rasterize,
                ),
            ):
                for args in args_by_run:
                    reports.append(pdf_visual_check._run_visual_check(args))

            def output_bytes(output: Path):
                return {
                    path.relative_to(output).as_posix(): path.read_bytes()
                    for path in sorted(output.rglob("*"))
                    if path.is_file()
                }

            first_output = Path(args_by_run[0].output_dir)
            second_output = Path(args_by_run[1].output_dir)
            first_bytes = output_bytes(first_output)
            second_bytes = output_bytes(second_output)

            # Default path redaction is part of the determinism contract. The
            # product emits no clock-derived field, so no test-only normalization
            # or ignored metadata is needed here.
            self.assertEqual(reports[0], reports[1])
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(
                set(first_bytes),
                {
                    "assets/page-0001-candidate-aligned.png",
                    "assets/page-0001-candidate-raw.png",
                    "assets/page-0001-heatmap.png",
                    "assets/page-0001-overlay.png",
                    "assets/page-0001-reference.png",
                    "index.html",
                    "report.json",
                },
            )
            self.assertEqual(
                json.loads(first_bytes["report.json"]),
                reports[0],
            )

    def test_failed_html_render_leaves_no_partial_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report"
            with self.assertRaises(KeyError):
                pdf_visual_check._write_report(
                    output, {"invalid": True}, {}, default_limits()
                )
            self.assertFalse(output.exists())

    def test_output_directory_must_not_preexist(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report"
            output.mkdir()
            with self.assertRaises(pdf_visual_check.VisualCheckError):
                pdf_visual_check._ensure_output_target(output)

    def test_t0_t1_require_self_attested_provenance_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            args = pdf_visual_check._build_parser().parse_args(
                [
                    str(candidate),
                    "--reference",
                    str(reference),
                    "--reference-tier",
                    "T1",
                    "--output-dir",
                    str(root / "report"),
                ]
            )

            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "requires provenance fields"
            ):
                pdf_visual_check._run_visual_check(args)

    def test_self_attested_t1_provenance_and_environment_reach_html(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            output = root / "report"
            args = pdf_visual_check._build_parser().parse_args(
                [
                    str(candidate),
                    "--reference",
                    str(reference),
                    "--reference-tier",
                    "T1",
                    "--reference-product",
                    "Official publisher PDF",
                    "--reference-build",
                    "producer-1",
                    "--reference-os",
                    "publisher-system",
                    "--font-fingerprint",
                    "sha256:fontset",
                    "--reference-note",
                    "same-post attachment",
                    "--candidate-font-fingerprint",
                    "sha256:candidate-fontset",
                    "--output-dir",
                    str(output),
                ]
            )
            candidate_info = pdf_visual_check.PdfInfo(
                2,
                (
                    pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),
                    pdf_visual_check.PdfPageInfo(2, (0.0, 0.0, 595.0, 842.0), 0),
                ),
            )
            reference_info = pdf_visual_check.PdfInfo(
                1,
                (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check,
                    "_inspect_pdf",
                    side_effect=[candidate_info, reference_info],
                ),
            ):
                report = pdf_visual_check._run_visual_check(args)

            self.assertEqual(
                report["inputs"]["reference"]["provenance_validation"]["status"],
                "self_attested",
            )
            self.assertRegex(
                report["environment"]["fingerprint_sha256"], r"^[0-9a-f]{64}$"
            )
            html_text = (output / "index.html").read_text()
            self.assertIn("self_attested", html_text)
            self.assertIn("Official publisher PDF", html_text)
            self.assertIn("producer-1", html_text)
            self.assertIn("sha256:fontset", html_text)


class ResourceLimitTests(unittest.TestCase):
    def test_snapshot_input_byte_limit_is_streaming_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            destination = root / "snapshot.pdf"
            source.write_bytes(b"0123456789")

            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "max-input-bytes"
            ):
                pdf_visual_check._snapshot_file(source, destination, 9)

    def test_pdf_page_limit_stops_before_detailed_pdfinfo(self):
        limits = default_limits(max_pages=1)
        with mock.patch.object(
            pdf_visual_check, "_run_command", return_value="Pages:          2\n"
        ) as run:
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "exceeds --max-pages"
            ):
                pdf_visual_check._inspect_pdf(Path("too-many.pdf"), limits)
        self.assertEqual(run.call_count, 1)

    def test_preflight_enforces_per_page_and_total_pixel_limits(self):
        info = pdf_visual_check.PdfInfo(
            1,
            (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
        )
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError, "max-page-pixels"
        ):
            pdf_visual_check._preflight_pixels(
                info, info, default_limits(max_page_pixels=100)
            )
        one_page_pixels = 1190 * 1684
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError, "max-total-pixels"
        ):
            pdf_visual_check._preflight_pixels(
                info,
                info,
                default_limits(
                    max_page_pixels=3_000_000,
                    max_total_pixels=one_page_pixels,
                ),
            )

    def test_subprocess_timeout_is_reported(self):
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError, "timed out"
        ):
            pdf_visual_check._run_command(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                0.01,
            )

    def test_subprocess_stdout_and_stderr_share_a_hard_byte_cap(self):
        programs = {
            "stdout": "import os; os.write(1, b'x' * 1000000)",
            "stderr": "import os; os.write(2, b'x' * 1000000)",
            "combined": (
                "import os; os.write(1, b'x' * 700); "
                "os.write(2, b'y' * 700)"
            ),
        }
        for case, program in programs.items():
            with self.subTest(case=case):
                with self.assertRaisesRegex(
                    pdf_visual_check.VisualCheckError,
                    "stdout/stderr exceeded --max-subprocess-output-bytes 1024",
                ):
                    pdf_visual_check._run_command(
                        [sys.executable, "-c", program],
                        10,
                        output_limit_bytes=1024,
                    )

    def test_subprocess_output_overflow_kills_child_without_waiting_for_timeout(self):
        program = (
            "import os, time; "
            "os.write(1, b'x' * 1000000); "
            "time.sleep(10)"
        )
        started = time.monotonic()
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError,
            "stdout/stderr exceeded --max-subprocess-output-bytes 1024",
        ):
            pdf_visual_check._run_command(
                [sys.executable, "-c", program],
                10,
                output_limit_bytes=1024,
            )
        self.assertLess(time.monotonic() - started, 5.0)

    def test_tool_version_uses_the_same_bounded_capture_path(self):
        capture_result = pdf_visual_check._CommandCapture(
            returncode=0,
            stdout="",
            stderr="pdfinfo version fixture\nignored\n",
        )
        with mock.patch.object(
            pdf_visual_check,
            "_capture_command",
            return_value=capture_result,
        ) as capture:
            version = pdf_visual_check._tool_version(
                "pdfinfo",
                7.5,
                output_limit_bytes=321,
            )

        self.assertEqual(version, "pdfinfo version fixture")
        capture.assert_called_once_with(["pdfinfo", "-v"], 7.5, 321)

    def test_page_raster_uses_cropbox_and_enforces_output_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf = root / "fixture.pdf"
            pdf.write_bytes(b"fixture")
            commands = []

            def fake_run(
                command,
                timeout_seconds,
                file_size_limit_bytes=None,
                output_limit_bytes=pdf_visual_check.DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES,
            ):
                commands.append(
                    (
                        command,
                        timeout_seconds,
                        file_size_limit_bytes,
                        output_limit_bytes,
                    )
                )
                output = Path(command[-1]).with_suffix(".png")
                pdf_visual_check._write_gray_png(output, gray_image(4, 4, [(1, 1)]))
                return ""

            with mock.patch.object(
                pdf_visual_check, "_run_command", side_effect=fake_run
            ):
                output, output_bytes = pdf_visual_check._rasterize_pdf_page(
                    pdf, root, "candidate", 3, default_limits()
                )

            self.assertTrue(output.is_file())
            self.assertEqual(output_bytes, output.stat().st_size)
            command = commands[0][0]
            self.assertIn("-cropbox", command)
            self.assertIn("-singlefile", command)
            self.assertEqual(command[command.index("-f") + 1], "3")
            self.assertEqual(command[command.index("-l") + 1], "3")
            self.assertEqual(
                commands[0][2], pdf_visual_check.DEFAULT_MAX_RASTER_BYTES
            )
            self.assertEqual(
                commands[0][3],
                pdf_visual_check.DEFAULT_MAX_SUBPROCESS_OUTPUT_BYTES,
            )
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

            with mock.patch.object(
                pdf_visual_check, "_run_command", side_effect=fake_run
            ):
                with self.assertRaisesRegex(
                    pdf_visual_check.VisualCheckError, "raster page"
                ):
                    pdf_visual_check._rasterize_pdf_page(
                        pdf,
                        root,
                        "reference",
                        1,
                        default_limits(max_raster_bytes=1),
                    )

    def test_total_raster_byte_limit_aborts_without_partial_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / "candidate.pdf"
            reference = root / "reference.pdf"
            raster = root / "page.png"
            candidate.write_bytes(b"candidate")
            reference.write_bytes(b"reference")
            pdf_visual_check._write_gray_png(raster, gray_image(4, 4, [(1, 1)]))
            output = root / "report"
            args = pdf_visual_check._build_parser().parse_args(
                [
                    str(candidate),
                    "--reference",
                    str(reference),
                    "--reference-tier",
                    "T3",
                    "--max-total-raster-bytes",
                    "15",
                    "--output-dir",
                    str(output),
                ]
            )
            info = pdf_visual_check.PdfInfo(
                1,
                (pdf_visual_check.PdfPageInfo(1, (0.0, 0.0, 595.0, 842.0), 0),),
            )
            with (
                mock.patch.object(pdf_visual_check.shutil, "which", return_value="/mock"),
                mock.patch.object(pdf_visual_check, "_tool_version", return_value="mock 1"),
                mock.patch.object(
                    pdf_visual_check, "_inspect_pdf", side_effect=[info, info]
                ),
                mock.patch.object(
                    pdf_visual_check,
                    "_rasterize_pdf_page",
                    side_effect=[(raster, 10), (raster, 10)],
                ),
            ):
                with self.assertRaisesRegex(
                    pdf_visual_check.VisualCheckError, "max-total-raster-bytes"
                ):
                    pdf_visual_check._run_visual_check(args)

            self.assertFalse(output.exists())

    def test_metric_preflight_caps_ink_sets_and_alignment_work(self):
        full_ink = gray_image(
            10,
            10,
            rectangle(0, 0, 9, 9),
        )
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError, "before set allocation"
        ):
            pdf_visual_check._preflight_metric_work(
                full_ink,
                full_ink,
                3,
                default_limits(max_ink_pixels=99),
            )

        sparse = gray_image(10, 10, rectangle(0, 0, 4, 1))
        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError, "alignment work"
        ):
            pdf_visual_check._preflight_metric_work(
                sparse,
                sparse,
                3,
                default_limits(max_ink_pixels=100, max_alignment_work=489),
            )

        with self.assertRaisesRegex(
            pdf_visual_check.VisualCheckError,
            "edge work upper bound .* before set allocation",
        ):
            pdf_visual_check._preflight_metric_work(
                sparse,
                sparse,
                0,
                default_limits(
                    max_ink_pixels=100,
                    max_alignment_work=100,
                    max_edge_work=259,
                ),
            )

    def test_edge_matching_checks_exact_work_before_neighbor_scan(self):
        reference = gray_image(10, 10, [(3, 3), (3, 4)])
        candidate = gray_image(10, 10, [(4, 3), (4, 4)])
        with mock.patch.object(
            pdf_visual_check, "_disk_offsets", wraps=pdf_visual_check._disk_offsets
        ) as offsets:
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "edge match work"
            ):
                pdf_visual_check._compare_images(
                    reference,
                    candidate,
                    max_translation=0,
                    max_edge_work=1,
                )
        self.assertEqual(offsets.call_count, 1)

    def test_resource_limits_reject_hard_ceiling_and_nonfinite_timeout(self):
        self.assertLess(
            pdf_visual_check.DEFAULT_MAX_PAGE_PIXELS,
            pdf_visual_check.HARD_MAX_PAGE_PIXELS,
        )
        with self.assertRaisesRegex(ValueError, "hard ceiling"):
            default_limits(
                max_page_pixels=pdf_visual_check.HARD_MAX_PAGE_PIXELS + 1
            )
        with self.assertRaisesRegex(ValueError, "hard ceiling"):
            default_limits(
                max_subprocess_output_bytes=(
                    pdf_visual_check.HARD_MAX_SUBPROCESS_OUTPUT_BYTES + 1
                )
            )
        with self.assertRaisesRegex(ValueError, "positive and finite"):
            default_limits(subprocess_timeout_seconds=float("nan"))

    @unittest.skipUnless(
        pdf_visual_check._file_size_limit_preexec(1024) is not None,
        "POSIX RLIMIT_FSIZE unavailable",
    )
    def test_runtime_file_size_cap_stops_writer_before_unbounded_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "oversize.bin"
            program = (
                "from pathlib import Path; "
                f"Path({str(output)!r}).write_bytes(b'x' * 1000000)"
            )
            with self.assertRaises(pdf_visual_check.VisualCheckError):
                pdf_visual_check._run_command(
                    [sys.executable, "-c", program],
                    10,
                    file_size_limit_bytes=1024,
                )
            if output.exists():
                self.assertLessEqual(output.stat().st_size, 1024)

    def test_memory_and_overflow_errors_become_visual_check_errors(self):
        for error in (MemoryError(), OverflowError()):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(
                    pdf_visual_check,
                    "_run_visual_check_impl",
                    side_effect=error,
                ):
                    with self.assertRaisesRegex(
                        pdf_visual_check.VisualCheckError,
                        "resource exhaustion",
                    ):
                        pdf_visual_check._run_visual_check(mock.sentinel.args)


class OutputSecurityTests(unittest.TestCase):
    def test_private_modes_are_forced_under_permissive_umasks(self):
        for mask in (0o000, 0o022):
            with self.subTest(umask=oct(mask)):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    source_asset = root / "source.png"
                    output = root / "report"
                    previous_umask = os.umask(mask)
                    try:
                        pdf_visual_check._write_gray_png(
                            source_asset,
                            gray_image(4, 4, [(1, 1)]),
                        )
                        observed_directory_modes = []
                        original_make_directory = (
                            pdf_visual_check._make_private_directory
                        )

                        def make_and_record(path, **kwargs):
                            original_make_directory(path, **kwargs)
                            observed_directory_modes.append(
                                stat.S_IMODE(path.stat().st_mode)
                            )

                        with (
                            mock.patch.object(
                                pdf_visual_check,
                                "_render_html",
                                return_value="<!doctype html><title>fixture</title>",
                            ),
                            mock.patch.object(
                                pdf_visual_check,
                                "_make_private_directory",
                                side_effect=make_and_record,
                            ),
                        ):
                            pdf_visual_check._write_report(
                                output,
                                {"status": "fixture"},
                                {"source.png": source_asset},
                                default_limits(),
                            )
                    finally:
                        os.umask(previous_umask)

                    self.assertGreaterEqual(len(observed_directory_modes), 3)
                    self.assertEqual(set(observed_directory_modes), {0o700})
                    self.assertEqual(
                        stat.S_IMODE(source_asset.stat().st_mode), 0o600
                    )
                    self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
                    self.assertEqual(
                        stat.S_IMODE((output / "assets").stat().st_mode), 0o700
                    )
                    for path in (
                        output / "report.json",
                        output / "index.html",
                        output / "assets" / "source.png",
                    ):
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_report_asset_and_total_byte_caps_fail_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            asset = root / "asset.png"
            pdf_visual_check._write_gray_png(
                asset,
                gray_image(8, 8, rectangle(0, 0, 7, 7)),
            )
            asset_bytes = asset.stat().st_size
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "report asset"
            ):
                pdf_visual_check._register_report_asset(
                    {},
                    "asset.png",
                    asset,
                    default_limits(max_report_asset_bytes=asset_bytes - 1),
                    0,
                )

            output = root / "report"
            with mock.patch.object(
                pdf_visual_check,
                "_render_html",
                return_value="<!doctype html><title>fixture</title>",
            ):
                with self.assertRaisesRegex(
                    pdf_visual_check.VisualCheckError, "final report would be"
                ):
                    pdf_visual_check._write_report(
                        output,
                        {"status": "fixture"},
                        {"asset.png": asset},
                        default_limits(max_report_bytes=asset_bytes),
                    )
            self.assertFalse(output.exists())

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "O_NOFOLLOW unavailable")
    def test_snapshot_rejects_symlink_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            link = root / "link.pdf"
            destination = root / "snapshot.pdf"
            source.write_bytes(b"fixture")
            link.symlink_to(source)

            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "non-symlink regular file"
            ):
                pdf_visual_check._snapshot_file(link, destination, 100)

    def test_nonfinite_boxes_and_invalid_rotation_are_structural(self):
        invalid = pdf_visual_check.PdfInfo(
            1,
            (
                pdf_visual_check.PdfPageInfo(
                    1,
                    (0.0, 0.0, float("nan"), 842.0),
                    45,
                ),
            ),
        )
        reference = pdf_visual_check.PdfInfo(
            1,
            (
                pdf_visual_check.PdfPageInfo(
                    1,
                    (0.0, 0.0, 595.0, 842.0),
                    0,
                ),
            ),
        )

        result = pdf_visual_check._compare_pdf_structure(invalid, reference)

        self.assertEqual(result["status"], "mismatch")
        errors = result["mismatches"][0]["errors"]
        self.assertIn("MediaBox and CropBox coordinates must be finite", errors)
        rotation_errors = pdf_visual_check.PdfPageInfo(
            1,
            (0.0, 0.0, 595.0, 842.0),
            45,
        ).validation_errors()
        self.assertIn(
            "page rotation must be a finite 0/90/180/270 degree integer",
            rotation_errors,
        )

    def test_nonfinite_values_cannot_escape_into_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report"
            with self.assertRaisesRegex(
                pdf_visual_check.VisualCheckError, "invalid JSON value"
            ):
                pdf_visual_check._write_report(
                    output,
                    {"invalid": float("nan")},
                    {},
                    default_limits(),
                )
            self.assertFalse(output.exists())


REPOSITORY_ROOT = SCRIPT_PATH.parents[1]
BENCHMARK_PDF = REPOSITORY_ROOT / "benchmarks" / "benchmark.pdf"
HAS_POPPLER_FIXTURE = bool(
    shutil.which("pdfinfo")
    and shutil.which("pdftoppm")
    and BENCHMARK_PDF.is_file()
)


@unittest.skipUnless(HAS_POPPLER_FIXTURE, "Poppler or benchmarks/benchmark.pdf unavailable")
class PopplerIntegrationTests(unittest.TestCase):
    def test_existing_benchmark_first_page_self_compare(self):
        limits = default_limits()
        info = pdf_visual_check._inspect_pdf(BENCHMARK_PDF, limits)
        self.assertGreater(info.page_count, 0)
        self.assertEqual(
            info.pages[0].effective_crop_box, info.pages[0].media_box
        )
        with tempfile.TemporaryDirectory() as temporary:
            page, _ = pdf_visual_check._rasterize_pdf_page(
                BENCHMARK_PDF,
                Path(temporary),
                "self",
                page=1,
                limits=limits,
            )
            image = pdf_visual_check._read_png_gray(page)
            _, metrics = pdf_visual_check._compare_images(image, image)
        self.assertEqual(metrics["ssim_like"]["global"], 1.0)
        self.assertEqual(metrics["ink"]["f1"], 1.0)
        self.assertEqual(metrics["edge"]["f1"], 1.0)


if __name__ == "__main__":
    unittest.main()
