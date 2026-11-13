#!/usr/bin/env python3
"""Hancom-PDF parity sweep (report-only): own `export-pdf` vs PDFs that Hancom produced.

    python3 scripts/hancom-parity/sweep.py --pairs PAIRS.json --out NEW_DIR \
        --cli target/release/auto-hwp [--jobs 4] [--skip-visual]

For every pair it exports the source through the own-IR PDF path, then measures, per document:
page count, the first page whose text lands on a different page, Hangul text missing from our IR
and from our PDF, page numbers, line positions, table rules, raster images, font realization, and
(on text-aligned pages) the repository comparator `scripts/pdf-visual-check.py`.  It writes
`NEW_DIR/summary.json`, `NEW_DIR/summary.md` and per-pair evidence under `NEW_DIR/<label>/`.

Report-only: there is no pass/fail.  The process exits non-zero only for tool or input errors
(missing Poppler, malformed pairs file, existing output dir).  A failed export is a recorded result.
Metric definitions and the baseline live in docs/HANCOM-PDF-PARITY-ROADMAP.md.  Standard library only;
needs Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfseparate`, `pdfimages`, `pdffonts`) on PATH.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
POPPLER = ("pdfinfo", "pdftotext", "pdftoppm", "pdfseparate", "pdfimages", "pdffonts")
PAIR_FIELDS = {"label", "group", "source", "reference", "note", "page_comparable"}
ALIGN_MIN_CHARS = 20  # a page with fewer Hangul chars cannot anchor page alignment
ALIGN_MIN_OVERLAP = 0.9  # char-bag overlap that counts as "same page content"
BAND = 0.08  # header/footer band (fraction of page height) for page numbers
RULE_DPI = 72
RULE_MIN_PX = 30  # ~10.6 mm at 72 dpi
RULE_DARK = 140
PAGE_NUMBER = re.compile(r"^[-–—\s]*\d{1,3}[-–—\s]*$|^\d{1,3}\s*/\s*\d{1,3}$")


# ---------------------------------------------------------------------------------------------
# small helpers


def run(cmd, cwd=None, timeout=900):
    """Run a subprocess; never raises for a non-zero exit (the caller records it)."""
    started = time.time()
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr, time.time() - started
    except subprocess.TimeoutExpired as exc:
        return "timeout", exc.stdout or b"", exc.stderr or b"", time.time() - started


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def hangul_key(text: str) -> str:
    """Hangul syllables + CJK ideographs only.

    Hancom Docs PDFs often draw Latin/ASCII with Type1C faces whose text does not extract, so
    comparing ASCII would report false "missing" text.  Page numbers are measured separately.
    """
    text = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in text if "가" <= ch <= "힣" or "一" <= ch <= "鿿")


def multiset_overlap(a: collections.Counter, b: collections.Counter) -> int:
    return sum((a & b).values())


# ---------------------------------------------------------------------------------------------
# pairs file


def load_pairs(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("pairs"), list):
        raise ValueError("pairs file must be {schema_version: 1, pairs: [...]}")
    unknown_top = set(data) - {"schema_version", "pairs"}
    if unknown_top:
        raise ValueError(f"unknown top-level fields: {sorted(unknown_top)}")
    labels, pairs = set(), []
    for index, pair in enumerate(data["pairs"]):
        if not isinstance(pair, dict):
            raise ValueError(f"pair {index} is not an object")
        unknown = set(pair) - PAIR_FIELDS
        missing = {"label", "group", "source", "reference"} - set(pair)
        if unknown or missing:
            raise ValueError(f"pair {index}: unknown {sorted(unknown)} missing {sorted(missing)}")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,40}", pair["label"]):
            raise ValueError(f"pair {index}: label must be a short [A-Za-z0-9_.-] name")
        if "page_comparable" in pair and not isinstance(pair["page_comparable"], bool):
            raise ValueError(f"pair {index}: page_comparable must be true/false")
        if pair["label"] in labels:
            raise ValueError(f"duplicate label {pair['label']}")
        labels.add(pair["label"])
        resolved = dict(pair)
        for key in ("source", "reference"):
            candidate = Path(os.path.expanduser(pair[key]))
            if not candidate.is_absolute():
                candidate = (path.parent / candidate).resolve()
            if not candidate.is_file():
                raise ValueError(f"{pair['label']}: {key} not found")
            resolved[key] = str(candidate)
        pairs.append(resolved)
    return pairs


# ---------------------------------------------------------------------------------------------
# PDF text model (pdftotext -bbox-layout)

RE_PAGE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
RE_LINE = re.compile(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">')
RE_WORD = re.compile(r'<word xMin="[\d.]+" yMin="[\d.]+" xMax="[\d.]+" yMax="[\d.]+">(.*?)</word>')


def _unescape(text: str) -> str:
    return (text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
            .replace("&apos;", "'").replace("&amp;", "&"))


def parse_bbox_layout(xhtml: str) -> list[dict]:
    pages, page, line = [], None, None
    for raw in xhtml.splitlines():
        match = RE_PAGE.search(raw)
        if match:
            page = {"w": float(match.group(1)), "h": float(match.group(2)), "lines": []}
            pages.append(page)
            line = None
            continue
        match = RE_LINE.search(raw)
        if match and page is not None:
            line = {"x0": float(match.group(1)), "y0": float(match.group(2)), "x1": float(match.group(3)),
                    "y1": float(match.group(4)), "words": []}
            page["lines"].append(line)
            continue
        if line is not None:
            line["words"].extend(_unescape(w) for w in RE_WORD.findall(raw))
    for page in pages:
        for line in page["lines"]:
            line["text"] = " ".join(line["words"])
            line["key"] = hangul_key(line["text"])
    return pages


def pdf_pages_text(pdf: str) -> tuple[object, list[dict]]:
    rc, out, _err, _ = run(["pdftotext", "-bbox-layout", pdf, "-"], timeout=300)
    return rc, parse_bbox_layout(out.decode("utf-8", "replace"))


def char_bag(page: dict) -> collections.Counter:
    return collections.Counter(ch for line in page["lines"] for ch in line["key"])


# ---------------------------------------------------------------------------------------------
# metrics (pure functions — unit tested)


def page_alignment(ref_pages: list[dict], cand_pages: list[dict]) -> dict:
    """Map each reference page to the candidate page with the largest Hangul char-bag overlap."""
    cand_bags = [char_bag(p) for p in cand_pages]
    rows = []
    for k, page in enumerate(ref_pages):
        bag = char_bag(page)
        total = sum(bag.values())
        best_j, best = None, 0
        for j, cand in enumerate(cand_bags):
            overlap = multiset_overlap(bag, cand)
            if overlap > best:
                best_j, best = j, overlap
        same = multiset_overlap(bag, cand_bags[k]) if k < len(cand_bags) else 0
        rows.append({"page": k + 1, "chars": total, "same_page": (same / total) if total else None,
                     "best_page": None if best_j is None else best_j + 1, "best": (best / total) if total else None})
    aligned = [r["page"] for r in rows if r["chars"] >= ALIGN_MIN_CHARS and r["best_page"] == r["page"]
               and (r["same_page"] or 0) >= ALIGN_MIN_OVERLAP]
    first = next((r["page"] for r in rows if r["chars"] >= ALIGN_MIN_CHARS
                  and (r["best_page"] != r["page"] or (r["same_page"] or 0) < ALIGN_MIN_OVERLAP)), None)
    return {"pages": rows, "aligned_pages": aligned, "first_divergent_page": first}


def text_loss(ref_pages: list[dict], cand_pages: list[dict], ir_text: str | None) -> dict:
    ref = collections.Counter(ch for p in ref_pages for l in p["lines"] for ch in l["key"])
    cand = collections.Counter(ch for p in cand_pages for l in p["lines"] for ch in l["key"])
    total = sum(ref.values())
    out = {"ref_chars": total, "cand_chars": sum(cand.values()),
           "missing_total": (sum((ref - cand).values()) / total) if total else None,
           "cand_replacement_chars": cand.get("�", 0),
           "cand_private_use_chars": sum(v for c, v in cand.items() if 0xE000 <= ord(c) <= 0xF8FF)}
    if ir_text is not None and total:
        ir = collections.Counter(hangul_key(ir_text))
        out["missing_ir"] = sum((ref - ir).values()) / total  # Hancom shows it, our IR never had it
        out["missing_pdf"] = sum(((ref & ir) - cand).values()) / total  # IR had it, our PDF does not
    return out


def page_numbers(pages: list[dict]) -> int:
    count = 0
    for page in pages:
        band = [l["text"].strip() for l in page["lines"]
                if (l["y0"] + l["y1"]) / 2 < BAND * page["h"] or (l["y0"] + l["y1"]) / 2 > (1 - BAND) * page["h"]]
        if any(PAGE_NUMBER.match(t) for t in band):
            count += 1
    return count


def line_geometry(ref_pages: list[dict], cand_pages: list[dict], pages: list[int]) -> dict:
    """Pair lines whose Hangul key occurs exactly once on both sides of the same page."""
    dys, dxs = [], []
    for k in pages:
        if k > len(cand_pages) or k > len(ref_pages):
            continue
        ref_count = collections.Counter(l["key"] for l in ref_pages[k - 1]["lines"] if len(l["key"]) >= 4)
        cand_count = collections.Counter(l["key"] for l in cand_pages[k - 1]["lines"] if len(l["key"]) >= 4)
        cand_lines = {l["key"]: l for l in cand_pages[k - 1]["lines"] if cand_count.get(l["key"]) == 1}
        for line in ref_pages[k - 1]["lines"]:
            if ref_count.get(line["key"]) != 1 or line["key"] not in cand_lines:
                continue
            other = cand_lines[line["key"]]
            dys.append(other["y0"] - line["y0"])
            dxs.append(other["x0"] - line["x0"])
    if not dys:
        return {"matched_lines": 0}
    ady, adx = [abs(v) for v in dys], [abs(v) for v in dxs]
    return {"matched_lines": len(dys), "dy_abs_median_pt": statistics.median(ady),
            "dy_signed_median_pt": statistics.median(dys), "dy_within_2pt": sum(v <= 2 for v in ady) / len(ady),
            "dy_within_6pt": sum(v <= 6 for v in ady) / len(ady), "dx_abs_median_pt": statistics.median(adx),
            "dx_within_2pt": sum(v <= 2 for v in adx) / len(adx), "dy_abs": ady, "dx_abs": adx}


def read_pgm(data: bytes) -> tuple[int, int, bytes]:
    """Minimal binary PGM (P5, maxval <= 255) reader for pdftoppm -gray output."""
    tokens, pos = [], 0
    while len(tokens) < 4:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b"#":
            pos = data.index(b"\n", pos) + 1
            continue
        start = pos
        while not data[pos:pos + 1].isspace():
            pos += 1
        tokens.append(data[start:pos])
    if tokens[0] != b"P5" or int(tokens[3]) > 255:
        raise ValueError("expected 8-bit binary PGM")
    width, height = int(tokens[1]), int(tokens[2])
    pixels = data[pos + 1:pos + 1 + width * height]
    if len(pixels) != width * height:
        raise ValueError("truncated PGM")
    return width, height, pixels


def rule_positions(width: int, height: int, pixels: bytes, min_len: int = RULE_MIN_PX) -> tuple[list[float], list[float]]:
    """Centres of vertical / horizontal dark runs at least `min_len` px long (table rules)."""
    dark = bytes(1 if p < RULE_DARK else 0 for p in pixels)
    col_best = [0] * width
    col_cur = [0] * width
    row_hits = []
    for y in range(height):
        row = dark[y * width:(y + 1) * width]
        run_len = best_row = 0
        for x, value in enumerate(row):
            if value:
                col_cur[x] += 1
                if col_cur[x] > col_best[x]:
                    col_best[x] = col_cur[x]
                run_len += 1
                if run_len > best_row:
                    best_row = run_len
            else:
                col_cur[x] = 0
                run_len = 0
        if best_row >= min_len:
            row_hits.append(y)

    def cluster(indices):
        out, start, prev = [], None, None
        for i in indices:
            if start is None:
                start = prev = i
            elif i == prev + 1:
                prev = i
            else:
                out.append((start + prev) / 2)
                start = prev = i
        if start is not None:
            out.append((start + prev) / 2)
        return out

    return cluster([x for x in range(width) if col_best[x] >= min_len]), cluster(row_hits)


def rule_recall(ref: list[float], cand: list[float], tolerance: float) -> float | None:
    if not ref:
        return None
    return sum(1 for r in ref if any(abs(r - c) <= tolerance for c in cand)) / len(ref)


# ---------------------------------------------------------------------------------------------
# per pair


def pdfinfo_pages(pdf: str):
    rc, out, _err, _ = run(["pdfinfo", pdf], timeout=120)
    pages = None
    for line in out.decode("utf-8", "replace").splitlines():
        if line.startswith("Pages:"):
            pages = int(line.split()[1])
    return rc, pages


def images_by_page(pdf: str) -> int:
    _rc, out, _err, _ = run(["pdfimages", "-list", pdf], timeout=120)
    total = 0
    for line in out.decode("utf-8", "replace").splitlines()[2:]:
        parts = line.split()
        if len(parts) > 2 and parts[0].isdigit() and parts[2] == "image":  # stencil masks are fills
            total += 1
    return total


def font_fingerprint(pdf: str) -> str:
    _rc, out, _err, _ = run(["pdffonts", pdf], timeout=60)
    lines = sorted(l for l in out.decode("utf-8", "replace").splitlines()[2:] if l.strip())
    return "pdffonts-normalized-sha256:" + hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def reference_font_families(pdf: str) -> list[str]:
    _rc, out, _err, _ = run(["pdffonts", pdf], timeout=60)
    names = set()
    for line in out.decode("utf-8", "replace").splitlines()[2:]:
        if line.strip():
            name = line.split()[0].split("+", 1)[-1]
            if not name.startswith("CairoFont"):
                names.add(name.split("-")[0])
    return sorted(names)


def visual_page(pair_dir: Path, k: int, ref: str, cand: str, provenance: dict) -> dict:
    page_dir = pair_dir / "pages" / f"p{k:03d}"
    page_dir.mkdir(parents=True, exist_ok=True)
    ref_k, cand_k = page_dir / "ref.pdf", page_dir / "cand.pdf"
    for src, dst in ((ref, ref_k), (cand, cand_k)):
        rc, *_ = run(["pdfseparate", "-f", str(k), "-l", str(k), src, str(dst)])
        if rc != 0 or not dst.is_file():
            return {"page": k, "error": "pdfseparate failed"}
    result = {"page": k}
    report_dir = page_dir / "report"
    cmd = [sys.executable, str(REPO / "scripts" / "pdf-visual-check.py"), str(cand_k), "--reference", str(ref_k),
           "--reference-tier", "T1", "--output-dir", str(report_dir),
           "--reference-product", provenance["product"], "--reference-build", provenance["build"],
           "--reference-os", "not disclosed", "--font-fingerprint", font_fingerprint(str(ref_k)),
           "--candidate-font-fingerprint", provenance["candidate_fp"], "--reference-note", provenance["note"],
           # dense form pages exceed the 600k default; raise to the comparator's hard ceilings
           "--max-ink-pixels", "1000000", "--max-alignment-work", "50000000", "--max-edge-work", "30000000"]
    rc, _out, err, _ = run(cmd)
    if rc != 0:
        result["comparator_error"] = err.decode("utf-8", "replace")[-300:]
    else:
        report = json.loads((report_dir / "report.json").read_text())
        metrics = report["pages"][0]["metrics"]
        result.update({"status": report.get("status"), "ink_f1": metrics["ink"].get("f1"),
                       "edge_f1": metrics["edge"].get("f1"), "worst_tile_recall": metrics["worst_tile_recall"].get("recall")})
    try:
        rules = {}
        for side, pdf in (("ref", ref_k), ("cand", cand_k)):
            stem = page_dir / f"{side}{RULE_DPI}"
            rc, *_ = run(["pdftoppm", "-r", str(RULE_DPI), "-gray", "-singlefile", "-cropbox", str(pdf), str(stem)])
            rules[side] = rule_positions(*read_pgm(Path(f"{stem}.pgm").read_bytes()))
        result["v_rule_recall_2px"] = rule_recall(rules["ref"][0], rules["cand"][0], 2.0)
        result["h_rule_recall_2px"] = rule_recall(rules["ref"][1], rules["cand"][1], 2.0)
        result["v_rule_recall_6px"] = rule_recall(rules["ref"][0], rules["cand"][0], 6.0)
        result["h_rule_recall_6px"] = rule_recall(rules["ref"][1], rules["cand"][1], 6.0)
        result["rule_counts"] = {"v_ref": len(rules["ref"][0]), "v_cand": len(rules["cand"][0]),
                                 "h_ref": len(rules["ref"][1]), "h_cand": len(rules["cand"][1])}
    except (OSError, ValueError) as exc:
        result["rules_error"] = str(exc)
    return result


def measure_pair(pair: dict, out: Path, cli: str, registry: str, skip_visual: bool, jobs: int) -> dict:
    pair_dir = out / pair["label"]
    pair_dir.mkdir(parents=True)
    cand = pair_dir / "cand.pdf"
    res = {"label": pair["label"], "group": pair["group"], "page_comparable": pair.get("page_comparable", True),
           "source_sha256": sha256_file(pair["source"]),
           "reference_sha256": sha256_file(pair["reference"]), "source_ext": Path(pair["source"]).suffix.lower()}
    rc, _o, err, seconds = run([cli, "export-pdf", pair["source"], "-o", str(cand), "--visual-regions",
                                str(pair_dir / "cand.regions.json"), "--font-registry", registry,
                                "--font-report", str(pair_dir / "font-report.json")], cwd=str(REPO))
    res["export"] = {"rc": rc, "seconds": round(seconds, 2), "bytes": cand.stat().st_size if cand.is_file() else 0}
    ref_rc, res["ref_pages"] = pdfinfo_pages(pair["reference"])
    if rc != 0 or res["export"]["bytes"] == 0:
        res["status"] = "export_failed"
        res["export"]["stderr_tail"] = err.decode("utf-8", "replace")[-300:]
        return res
    _crc, res["cand_pages"] = pdfinfo_pages(str(cand))
    if ref_rc != 0 or not res["ref_pages"]:
        res["status"] = "reference_unreadable"
        return res
    lrc, lout, _lerr, _ = run([cli, "layout-check", "--json", pair["source"]], cwd=str(REPO))
    try:
        parsed = json.loads(lout) if lrc == 0 else None
        entry = parsed[0] if isinstance(parsed, list) and parsed else {}
        res["layout_check"] = {k: v for k, v in entry.items() if k != "file"} if entry else {"rc": lrc}
    except json.JSONDecodeError:
        res["layout_check"] = {"rc": lrc, "error": "non-json output"}
    irc, iout, _ierr, _ = run([cli, "extract-text", pair["source"]], cwd=str(REPO))
    ir_text = iout.decode("utf-8", "replace") if irc == 0 else None
    _r, ref_pages = pdf_pages_text(pair["reference"])
    _c, cand_pages = pdf_pages_text(str(cand))
    res["text"] = text_loss(ref_pages, cand_pages, ir_text)
    if not res["text"]["ref_chars"] or not res["text"]["cand_chars"]:
        res["status"] = "no_extractable_text"
        return res
    align = page_alignment(ref_pages, cand_pages)
    res["alignment"] = align
    scored_pages = (list(range(1, res["ref_pages"] + 1)) if res["cand_pages"] == res["ref_pages"]
                    else align["aligned_pages"])
    res["page_numbers"] = {"ref": page_numbers(ref_pages), "cand": page_numbers(cand_pages)}
    geometry = line_geometry(ref_pages, cand_pages, scored_pages)
    res["line_geometry"] = {k: v for k, v in geometry.items() if k not in ("dy_abs", "dx_abs")}
    res["_dy_abs"], res["_dx_abs"] = geometry.get("dy_abs", []), geometry.get("dx_abs", [])
    res["images"] = {"ref": images_by_page(pair["reference"]), "cand": images_by_page(str(cand))}
    res["reference_fonts"] = reference_font_families(pair["reference"])
    try:
        report = json.loads((pair_dir / "font-report.json").read_text())
        lanes = collections.Counter()
        for lane in report.get("lanes", []):
            lanes[lane["status"]] += lane["glyph_count"]
        res["font_glyphs"] = dict(lanes)
        candidate_fp = report.get("registry_fingerprint", "unknown")
    except (OSError, ValueError):
        res["font_glyphs"], candidate_fp = {}, "unknown"
    try:
        regions = json.loads((pair_dir / "cand.regions.json").read_text())
        res["clipped_regions"] = sum(1 for p in regions["pages"] for r in p["regions"] if r.get("clipped"))
    except (OSError, ValueError, KeyError):
        res["clipped_regions"] = None
    if not skip_visual and scored_pages:
        _p, info, _e, _ = run(["pdfinfo", pair["reference"]], timeout=60)
        meta = dict(line.split(":", 1) for line in info.decode("utf-8", "replace").splitlines() if ":" in line)
        provenance = {"product": meta.get("Producer", "unknown").strip() or "unknown",
                      "build": (meta.get("Creator") or meta.get("Producer") or "unknown").strip() or "unknown",
                      "note": f"{pair['group']} reference, self-attested by operator", "candidate_fp": candidate_fp}
        with cf.ThreadPoolExecutor(jobs) as pool:
            res["visual_pages"] = list(pool.map(
                lambda k: visual_page(pair_dir, k, pair["reference"], str(cand), provenance), scored_pages))
    res["status"] = "ok"
    return res


# ---------------------------------------------------------------------------------------------
# summary


def _fmt(value, digits=2, pct=False):
    if value is None:
        return "–"
    if pct:
        return f"{100 * value:.1f}%"
    return f"{value:.{digits}f}" if isinstance(value, float) else str(value)


def quantiles(values, qs=(0.1, 0.25, 0.5, 0.75, 0.9)):
    if not values:
        return None
    xs = sorted(values)
    out = []
    for q in qs:
        pos = (len(xs) - 1) * q
        lo = int(pos)
        hi = min(lo + 1, len(xs) - 1)
        out.append(round(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo), 3))
    return out


def table_structure(visual_pages: list[dict]) -> dict:
    """Table-structure proxy on scored pages: column rules within 6 px, and pages whose long horizontal
    rule count matches within 10 % (same row structure even when rows sit a few points apart)."""
    v6 = [p["v_rule_recall_6px"] for p in visual_pages if p.get("v_rule_recall_6px") is not None]
    counted = [p["rule_counts"] for p in visual_pages if p.get("rule_counts") and p["rule_counts"]["h_ref"] > 0]
    same = sum(1 for c in counted if abs(c["h_cand"] - c["h_ref"]) <= max(1, 0.1 * c["h_ref"]))
    return {"v_rule_recall_6px_mean": statistics.mean(v6) if v6 else None,
            "h_rule_count_same_pages": same, "h_rule_count_pages": len(counted)}


def summarize(results: list[dict]) -> tuple[dict, str]:
    # a reference that cannot be compared page-for-page (e.g. a 2-up print) stays in the table but out of totals
    ok = [r for r in results if r.get("status") == "ok" and r.get("page_comparable", True)]
    inks = [p["ink_f1"] for r in ok for p in r.get("visual_pages", []) if p.get("ink_f1") is not None]
    dy = [v for r in ok for v in r.get("_dy_abs", [])]
    dx = [v for r in ok for v in r.get("_dx_abs", [])]
    totals = {
        "pairs": len(results),
        "export_failed": sum(r.get("status") == "export_failed" for r in results),
        "reference_unreadable": sum(r.get("status") == "reference_unreadable" for r in results),
        "comparable": len(ok),
        "excluded_not_page_comparable": sum(r.get("status") == "ok" and not r.get("page_comparable", True)
                                            for r in results),
        "page_count_match": sum(r["cand_pages"] == r["ref_pages"] for r in ok),
        "page_breaks_all_match": sum(r["alignment"]["first_divergent_page"] is None for r in ok),
        "docs_pdf_missing_over_1pct": sum((r["text"].get("missing_pdf") or 0) > 0.01 for r in ok),
        "docs_ir_missing_over_0_5pct": sum((r["text"].get("missing_ir") or 0) > 0.005 for r in ok),
        "broken_glyph_docs": sum((r["text"]["cand_replacement_chars"] + r["text"]["cand_private_use_chars"]) > 0 for r in ok),
        "page_number_docs_ref": sum(r["page_numbers"]["ref"] > 0 for r in ok),
        "page_number_docs_both": sum(r["page_numbers"]["ref"] > 0 and r["page_numbers"]["cand"] > 0 for r in ok),
        "matched_lines": len(dy),
        "dy_abs_median_pt": statistics.median(dy) if dy else None,
        "dy_within_2pt": (sum(v <= 2 for v in dy) / len(dy)) if dy else None,
        "dx_abs_median_pt": statistics.median(dx) if dx else None,
        "scored_pages": len(inks),
        "ink_f1_p10_p25_p50_p75_p90": quantiles(inks),
    }
    lines = ["| label | group | pages ours/ref | typeset/lineseg pages · body/cell lines exact | first divergent page | "
             "Hangul missing IR · PDF | page numbers ref/ours | line dy median | lines within 2pt | "
             "ink F1 median (min) · pages | v/h rules 2px | v rules 6px · h-rule count same | clipped |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        if r.get("status") != "ok":
            lines.append(f"| {r['label']} | {r['group']} | {r.get('cand_pages', '–')}/{r.get('ref_pages', '–')} | "
                         f"– | {r.get('status')} | – | – | – | – | – | – | – | – |")
            continue
        vis = [p for p in r.get("visual_pages", []) if p.get("ink_f1") is not None]
        ink = (f"{statistics.median(p['ink_f1'] for p in vis):.2f} ({min(p['ink_f1'] for p in vis):.2f}) · {len(vis)}"
               if vis else "–")
        vr = [p["v_rule_recall_2px"] for p in r.get("visual_pages", []) if p.get("v_rule_recall_2px") is not None]
        hr = [p["h_rule_recall_2px"] for p in r.get("visual_pages", []) if p.get("h_rule_recall_2px") is not None]
        geo, text = r["line_geometry"], r["text"]
        ts = table_structure(r.get("visual_pages", []))
        mark = "" if r["cand_pages"] == r["ref_pages"] else (" ▲" if r["cand_pages"] > r["ref_pages"] else " ▼")
        lc = r.get("layout_check") or {}
        lc_cell = (f"{lc.get('our_pages', '–')}/{lc.get('oracle_pages', '–')} · "
                   f"{_fmt(lc.get('line_exact_pct'), 1)}/{_fmt(lc.get('cell_exact_pct'), 1)}"
                   if lc.get("score_kind") == "scorable" or "our_pages" in lc else "–")
        lines.append(
            f"| {r['label']} | {r['group']} | {r['cand_pages']}/{r['ref_pages']}{mark} | {lc_cell} | "
            f"{r['alignment']['first_divergent_page'] or '–'} | {_fmt(text.get('missing_ir'), pct=True)} · "
            f"{_fmt(text.get('missing_pdf'), pct=True)} | {r['page_numbers']['ref']}/{r['page_numbers']['cand']} | "
            f"{_fmt(geo.get('dy_abs_median_pt'), 1)}pt | {_fmt(geo.get('dy_within_2pt'), pct=True)} | {ink} | "
            f"{_fmt(statistics.mean(vr) if vr else None)}/{_fmt(statistics.mean(hr) if hr else None)} | "
            f"{_fmt(ts['v_rule_recall_6px_mean'])} · {ts['h_rule_count_same_pages']}/{ts['h_rule_count_pages']} | "
            f"{_fmt(r.get('clipped_regions'))} |")
    head = [f"- {k}: {_fmt(v, 3) if isinstance(v, float) else v}" for k, v in totals.items()]
    return totals, "\n".join(["# Hancom-PDF parity sweep (report-only)", "", *head, "", *lines, ""])


def public_view(result: dict) -> dict:
    """summary.json view: drop private series and subprocess error text (it can carry local paths)."""
    out = {k: v for k, v in result.items() if not k.startswith("_")}
    if "export" in out:
        out["export"] = {k: v for k, v in out["export"].items() if k != "stderr_tail"}
    if "visual_pages" in out:
        out["visual_pages"] = [{k: v for k, v in p.items() if k != "comparator_error"} for p in out["visual_pages"]]
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--pairs", required=True, type=Path, help="pairs file (schema_version 1)")
    parser.add_argument("--out", required=True, type=Path, help="new output directory (must not exist)")
    parser.add_argument("--cli", default=str(REPO / "target" / "release" / "auto-hwp"),
                        help="auto-hwp built with --features 'pdf shaper rhwp'")
    parser.add_argument("--font-registry", default=str(REPO / "corpus" / "font-registry" / "ofl-registry-v1.json"))
    parser.add_argument("--labels", help="comma-separated subset of labels")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--skip-visual", action="store_true", help="skip the per-page comparator and rules")
    args = parser.parse_args(argv)
    missing = [tool for tool in POPPLER if shutil.which(tool) is None]
    if missing:
        print(f"error: Poppler tools missing on PATH: {missing}", file=sys.stderr)
        return 2
    if not Path(args.cli).is_file():
        print("error: --cli binary not found (cargo build --release -p auto-hwp-cli --features 'pdf shaper rhwp')",
              file=sys.stderr)
        return 2
    try:
        pairs = load_pairs(args.pairs)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.labels:
        wanted = set(args.labels.split(","))
        pairs = [p for p in pairs if p["label"] in wanted]
    if args.out.exists():
        print("error: --out must not exist", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True)
    results = []
    for pair in pairs:
        result = measure_pair(pair, args.out, args.cli, args.font_registry, args.skip_visual, max(1, args.jobs))
        (args.out / pair["label"] / "pair.json").write_text(
            json.dumps({k: v for k, v in result.items() if not k.startswith("_")}, ensure_ascii=False, indent=1))
        geo = result.get("line_geometry") or {}
        print(f"{pair['label']}: {result['status']} pages {result.get('cand_pages')}/{result.get('ref_pages')} "
              f"missing-pdf {_fmt((result.get('text') or {}).get('missing_pdf'), pct=True)} "
              f"dy {_fmt(geo.get('dy_abs_median_pt'), 1)}pt", flush=True)
        results.append(result)
    totals, markdown = summarize(results)
    (args.out / "summary.json").write_text(json.dumps(
        {"totals": totals, "pairs": [public_view(r) for r in results]}, ensure_ascii=False, indent=1))
    (args.out / "summary.md").write_text(markdown)
    print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
