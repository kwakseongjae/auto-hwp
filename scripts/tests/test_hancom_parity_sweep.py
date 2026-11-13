#!/usr/bin/env python3
"""Dependency-free tests for scripts/hancom-parity/sweep.py metric functions (no Poppler, no documents)."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "hancom-parity" / "sweep.py"
SPEC = importlib.util.spec_from_file_location("hancom_parity_sweep", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"could not import {SCRIPT_PATH}")
sweep = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sweep
SPEC.loader.exec_module(sweep)


def page(lines, h=842.0):
    """lines: [(y0, text)] -> page dict shaped like parse_bbox_layout output."""
    out = []
    for y, text in lines:
        out.append({"x0": 50.0, "y0": float(y), "x1": 500.0, "y1": float(y) + 10, "words": text.split(),
                    "text": text, "key": sweep.hangul_key(text)})
    return {"w": 595.0, "h": h, "lines": out}


class HangulKey(unittest.TestCase):
    def test_keeps_hangul_and_hanja_only(self):
        self.assertEqual(sweep.hangul_key("1. 사업 개요 (Problem) 他"), "사업개요他")


class BboxParse(unittest.TestCase):
    def test_parses_pages_lines_words(self):
        xhtml = ('<page width="595.0" height="842.0">\n<line xMin="1" yMin="2" xMax="3" yMax="4">\n'
                 '<word xMin="1" yMin="2" xMax="3" yMax="4">사업&amp;</word>\n'
                 '<word xMin="1" yMin="2" xMax="3" yMax="4">개요</word>\n</line>\n</page>')
        pages = sweep.parse_bbox_layout(xhtml)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["lines"][0]["text"], "사업& 개요")
        self.assertEqual(pages[0]["lines"][0]["key"], "사업개요")


class Alignment(unittest.TestCase):
    A = "가나다라마바사아자차카타파하" * 2
    B = "거너더러머버서어저처커터퍼허" * 2
    C = "고노도로모보소오조초코토포호" * 2

    def test_identical_pagination_has_no_divergence(self):
        ref = [page([(100, self.A)]), page([(100, self.B)])]
        result = sweep.page_alignment(ref, [page([(100, self.A)]), page([(100, self.B)])])
        self.assertIsNone(result["first_divergent_page"])
        self.assertEqual(result["aligned_pages"], [1, 2])

    def test_content_pushed_to_next_page_is_the_first_divergence(self):
        ref = [page([(100, self.A)]), page([(100, self.B)]), page([(100, self.C)])]
        cand = [page([(100, self.A)]), page([]), page([(100, self.B)]), page([(100, self.C)])]
        result = sweep.page_alignment(ref, cand)
        self.assertEqual(result["first_divergent_page"], 2)
        self.assertEqual(result["pages"][1]["best_page"], 3)
        self.assertEqual(result["aligned_pages"], [1])

    def test_page_whose_content_lands_fully_on_a_later_page_diverges(self):
        ref = [page([(100, self.A)]), page([(100, self.B)])]
        cand = [page([(100, self.A)]), page([(100, self.B[:-2])]), page([(100, self.B)])]  # 26/28 here, 28/28 later
        result = sweep.page_alignment(ref, cand)
        self.assertEqual(result["pages"][1]["best_page"], 3)
        self.assertEqual(result["first_divergent_page"], 2)


class TextLoss(unittest.TestCase):
    def test_splits_ir_missing_from_pdf_missing(self):
        ref = [page([(100, "가나다라"), (120, "마바사아")])]
        cand = [page([(100, "가나다라마")])]
        loss = sweep.text_loss(ref, cand, ir_text="가나다라 마바")  # IR lacks 사아; PDF also drops 바
        self.assertAlmostEqual(loss["missing_total"], 3 / 8)
        self.assertAlmostEqual(loss["missing_ir"], 2 / 8)
        self.assertAlmostEqual(loss["missing_pdf"], 1 / 8)

    def test_reports_replacement_and_private_use_glyphs(self):
        loss = sweep.text_loss([page([(1, "가나")])], [page([(1, "가나")])], None)
        self.assertEqual(loss["cand_replacement_chars"], 0)
        self.assertNotIn("missing_ir", loss)


class PageNumbers(unittest.TestCase):
    def test_counts_only_band_page_numbers(self):
        with_number = page([(100, "본문"), (820, "- 3 -")])
        body_number = page([(400, "- 3 -")])
        slash = page([(10, "2 / 9")])
        self.assertEqual(sweep.page_numbers([with_number, body_number, slash]), 2)


class LineGeometry(unittest.TestCase):
    def test_pairs_unique_lines_and_reports_offsets(self):
        ref = [page([(100, "가나다라마"), (200, "바사아자차"), (300, "카타파하가")])]
        cand = [page([(103, "가나다라마"), (201, "바사아자차"), (330, "카타파하가")])]
        geo = sweep.line_geometry(ref, cand, [1])
        self.assertEqual(geo["matched_lines"], 3)
        self.assertEqual(geo["dy_abs_median_pt"], 3.0)
        self.assertAlmostEqual(geo["dy_within_2pt"], 1 / 3)

    def test_repeated_keys_are_not_paired(self):
        ref = [page([(100, "가나다라마"), (200, "가나다라마")])]
        self.assertEqual(sweep.line_geometry(ref, ref, [1])["matched_lines"], 0)


class Summary(unittest.TestCase):
    def test_not_page_comparable_pairs_stay_out_of_totals(self):
        def result(label, comparable, cand, ref):
            return {"label": label, "group": "g", "status": "ok", "page_comparable": comparable,
                    "cand_pages": cand, "ref_pages": ref, "alignment": {"first_divergent_page": None},
                    "text": {"missing_pdf": 0.0, "missing_ir": 0.0, "cand_replacement_chars": 0,
                             "cand_private_use_chars": 0},
                    "page_numbers": {"ref": 0, "cand": 0}, "line_geometry": {}, "visual_pages": []}
        totals, markdown = sweep.summarize([result("A", True, 2, 2), result("B", False, 4, 2)])
        self.assertEqual(totals["comparable"], 1)
        self.assertEqual(totals["page_count_match"], 1)
        self.assertEqual(totals["excluded_not_page_comparable"], 1)
        self.assertIn("| B |", markdown)


class TableStructure(unittest.TestCase):
    def test_counts_pages_with_matching_horizontal_rules(self):
        pages = [
            {"v_rule_recall_6px": 1.0, "rule_counts": {"v_ref": 4, "v_cand": 4, "h_ref": 10, "h_cand": 10}},
            {"v_rule_recall_6px": 0.5, "rule_counts": {"v_ref": 4, "v_cand": 2, "h_ref": 10, "h_cand": 13}},
            {"v_rule_recall_6px": None, "rule_counts": {"v_ref": 0, "v_cand": 0, "h_ref": 0, "h_cand": 3}},
        ]
        ts = sweep.table_structure(pages)
        self.assertEqual(ts["v_rule_recall_6px_mean"], 0.75)
        self.assertEqual((ts["h_rule_count_same_pages"], ts["h_rule_count_pages"]), (1, 2))

    def test_public_view_drops_error_text(self):
        view = sweep.public_view({"label": "A", "_dy_abs": [1.0], "export": {"rc": 1, "stderr_tail": "/secret/path"},
                                  "visual_pages": [{"page": 1, "comparator_error": "/secret/path"}]})
        self.assertNotIn("/secret/path", json.dumps(view))
        self.assertNotIn("_dy_abs", view)


class Rules(unittest.TestCase):
    def test_reads_pgm_and_finds_long_rules_only(self):
        width, height = 100, 100
        pixels = bytearray([255] * width * height)
        for y in range(10, 80):  # vertical rule at x=40 (70 px)
            pixels[y * width + 40] = 0
        for x in range(5, 60):  # horizontal rule at y=20 (55 px)
            pixels[20 * width + x] = 0
        for x in range(70, 80):  # short dash: not a rule
            pixels[90 * width + x] = 0
        data = b"P5\n# comment\n100 100\n255\n" + bytes(pixels)
        w, h, px = sweep.read_pgm(data)
        vertical, horizontal = sweep.rule_positions(w, h, px, min_len=30)
        self.assertEqual(vertical, [40.0])
        self.assertEqual(horizontal, [20.0])

    def test_rule_recall(self):
        self.assertEqual(sweep.rule_recall([10, 50], [11.5, 90], 2.0), 0.5)
        self.assertIsNone(sweep.rule_recall([], [1], 2.0))


class PairsFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "a.hwp").write_bytes(b"x")
        (self.dir / "a.pdf").write_bytes(b"y")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, data):
        path = self.dir / "pairs.json"
        path.write_text(json.dumps(data))
        return path

    def test_resolves_relative_paths(self):
        pairs = sweep.load_pairs(self.write({"schema_version": 1, "pairs": [
            {"label": "P-01", "group": "g", "source": "a.hwp", "reference": "a.pdf"}]}))
        self.assertEqual(Path(pairs[0]["source"]), (self.dir / "a.hwp").resolve())

    def test_rejects_unknown_fields_duplicates_and_missing_files(self):
        base = {"label": "P-01", "group": "g", "source": "a.hwp", "reference": "a.pdf"}
        for bad in ({"schema_version": 2, "pairs": [base]},
                    {"schema_version": 1, "pairs": [dict(base, extra=1)]},
                    {"schema_version": 1, "pairs": [base, base]},
                    {"schema_version": 1, "pairs": [dict(base, reference="nope.pdf")]},
                    {"schema_version": 1, "pairs": [dict(base, label="../x")]},
                    {"schema_version": 1, "pairs": [dict(base, page_comparable="no")]}):
            with self.assertRaises(ValueError):
                sweep.load_pairs(self.write(bad))


if __name__ == "__main__":
    unittest.main()
