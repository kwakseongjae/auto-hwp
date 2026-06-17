#!/usr/bin/env python3
"""Visual cross-validation harness: render every page of a .hwp with OUR engine (rhwp) and place
it beside the ground-truth PDF page, into a self-contained HTML report + per-page side-by-side PNGs.
This is the standing self-verification loop for "원본 그대로" rendering fidelity.

Usage: python3 scripts/bench-compare.py [benchmark.hwp] [benchmark.pdf]
Requires: cargo (tf-hwp-cli --features rhwp), pdftoppm, rsvg-convert, pdfinfo.
"""
import base64, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HWP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "benchmark.hwp")
PDF = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "benchmark.pdf")
OUT = os.path.join(ROOT, "out", "bench-compare")
os.makedirs(OUT, exist_ok=True)


def run(*a, **k):
    return subprocess.run(a, cwd=ROOT, capture_output=True, text=True, **k)


def pdf_pages(pdf):
    m = re.search(r"Pages:\s*(\d+)", run("pdfinfo", pdf).stdout)
    return int(m.group(1)) if m else 0


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def main():
    n = pdf_pages(PDF)
    print(f"{os.path.basename(HWP)} — {n} pages vs ground-truth PDF")
    rows = []
    for p in range(n):
        ours_svg = os.path.join(OUT, f"ours-{p}.svg")
        ours_png = os.path.join(OUT, f"ours-{p}.png")
        pdf_png = os.path.join(OUT, f"pdf-{p}.png")
        # OUR render (rhwp) → SVG → PNG
        run("cargo", "run", "-q", "-p", "tf-hwp-cli", "--features", "rhwp", "--",
            "render", HWP, "--page", str(p), "--out", ours_svg)
        run("rsvg-convert", "-b", "white", ours_svg, "-o", ours_png)
        # ground-truth PDF page → PNG
        run("pdftoppm", "-png", "-r", "96", "-f", str(p + 1), "-l", str(p + 1), PDF,
            os.path.join(OUT, f"pdf-{p}-tmp"))
        tmp = os.path.join(OUT, f"pdf-{p}-tmp-{p+1}.png")
        if os.path.exists(tmp):
            os.replace(tmp, pdf_png)
        ok = os.path.exists(ours_png) and os.path.exists(pdf_png)
        print(f"  page {p+1}: {'rendered' if ok else 'MISSING'}")
        if ok:
            rows.append((p + 1, b64(ours_png), b64(pdf_png)))

    cells = "\n".join(
        f'<tr><td class=n>p{pg}</td>'
        f'<td><div class=lbl>OURS (tf-hwp / rhwp)</div><img src="data:image/png;base64,{a}"></td>'
        f'<td><div class=lbl>GROUND TRUTH (benchmark.pdf)</div><img src="data:image/png;base64,{b}"></td></tr>'
        for pg, a, b in rows
    )
    html = f"""<!doctype html><meta charset=utf-8><title>tf-hwp 렌더 교차검증</title>
<style>body{{font-family:sans-serif;background:#222;color:#eee;margin:0;padding:16px}}
h1{{font-size:18px}} table{{border-collapse:collapse;width:100%}}
td{{vertical-align:top;padding:8px;border-bottom:1px solid #444}} td.n{{color:#9cf;font-weight:bold}}
img{{width:100%;max-width:460px;background:#fff;box-shadow:0 1px 6px #000}}
.lbl{{font-size:11px;color:#9cf;margin-bottom:4px}}</style>
<h1>원본 그대로 렌더 교차검증 — {os.path.basename(HWP)} vs benchmark.pdf ({len(rows)} pages)</h1>
<table>{cells}</table>"""
    report = os.path.join(ROOT, "out", "bench-compare.html")
    with open(report, "w") as f:
        f.write(html)
    print(f"report → {report}")


if __name__ == "__main__":
    main()
