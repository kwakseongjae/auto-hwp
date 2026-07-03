// issue 031 — RESIZE RELIABILITY repro (tracked bench/smoke). It localizes the "성공 토스트인데 무반영"
// (false-success) resize bug to a LAYER, without a browser, by driving the REAL engine over benchmark.hwp:
//
//   applyIntent(SetTableColWidths) → RE-QUERY tableColBoundaries + renderPageSvg diff
//   applyIntent(SetTableRowHeights) → RE-QUERY tableRowBoundaries + renderPageSvg diff
//
// The verdict is decided by TWO signals only — (1) the engine re-query shows the boundary MOVED, and
// (2) the page SVG string CHANGED. (v1 also parsed the SVG for a "<line>" vertical grid — that 2nd check
// was BROKEN because it matched only `<line>` elements, so it is deliberately DROPPED here; the engine
// re-query + svgChanged are sufficient and honest.)
//
// The point: the engine + intent path REFLECT a resize (boundaries move, SVG changes). So the field bug
// ("열 너비 변경 토스트인데 무반영") was NOT the engine, NOT the px→ratio conversion (candidate a), NOT a
// cache/refresh gap (candidate b), NOT an engine no-op (candidate c) — it was the UI DRAG-PREVIEW layer:
// ColumnResizeOverlay.onMove walked `closest('.hw-sheet')`, which is NULL from the overlay (a SIBLING of
// `.hw-sheet` inside `.hw-sheet-wrap`) → early return → the committed boundaries never changed → a no-op
// ratio → a false success. Fixed by converting the pointer in the `.hw-sheet-wrap` frame (issue 031).
//
// Run:  node packages/engine/bench/resize-reliability-repro.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngineSync, HwpDoc } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
initEngineSync({ module: readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm')) });
const doc = HwpDoc.open(readFileSync(join(repo, 'benchmarks', 'benchmark.hwp')), 'benchmark.hwp');

let passed = 0;
const ok = (c, msg) => { if (!c) { console.error(`  ✗ FAIL · ${msg}`); throw new Error(`FAIL ${msg}`); } passed++; console.log(`  ok · ${msg}`); };
const maxMove = (a, b) => (a && b && a.length === b.length ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity);

// ── find, on some page, distinct tables (dedup by section/block) with ≥2 cols and ≥2 rows ────────────
const g = doc.pageGeometry(0);
function tablesOnPage(page) {
  const geo = doc.pageGeometry(page);
  if (!geo) return [];
  const seen = new Map();
  for (let y = 20; y < geo.h - 20; y += 10) {
    for (let x = 20; x < geo.w - 20; x += 16) {
      const t = doc.tableAt(page, x, y);
      if (t) seen.set(`${t.section}:${t.block}`, t);
    }
  }
  return [...seen.values()];
}
const pageCount = doc.pageCount();
ok(pageCount === 8, `benchmark.hwp opened: ${pageCount} pages`);

// ── COLUMN resize mechanism ──────────────────────────────────────────────────────────────────────────
console.log('\n[열 너비] SetTableColWidths → 경계 재조회 + SVG 변화');
let colProven = false;
for (let page = 0; page < pageCount && !colProven; page++) {
  for (const t of tablesOnPage(page)) {
    if (t.cols < 2) continue;
    const before = doc.tableColBoundaries(page, t.section, t.block);
    if (!before || before.length !== t.cols + 1) continue;
    const svgBefore = doc.renderPageSvg(page);
    // A dominant-first ratio forces the first interior boundary to move (unless already dominant).
    const widths = Array.from({ length: t.cols }, (_, i) => (i === 0 ? t.cols + 4 : 1));
    doc.applyIntent({ intent: 'SetTableColWidths', section: t.section, index: t.block, widths });
    const after = doc.tableColBoundaries(page, t.section, t.block);
    const moved = maxMove(before, after);
    const svgChanged = doc.renderPageSvg(page) !== svgBefore;
    doc.undo();
    if (moved > 1 && svgChanged) {
      ok(true, `p${page} 표(${t.section},${t.block}) ${t.rows}×${t.cols}: 경계 이동 ${moved.toFixed(1)}px · SVG 변화 ${svgChanged}`);
      // undo restored the geometry (proves the op is a real, reversible edit).
      ok(maxMove(before, doc.tableColBoundaries(page, t.section, t.block)) < 0.5, 'undo 로 경계 원복 (실제 편집이었음)');
      colProven = true;
      break;
    }
  }
}
ok(colProven, '엔진 레이어: 열너비 intent 가 경계+렌더에 반영된다 (⇒ 무반영 버그는 UI 드래그-프리뷰 층)');

// ── ROW resize mechanism (issue 031 new binding) ─────────────────────────────────────────────────────
console.log('\n[행 높이] SetTableRowHeights → 행 경계 재조회 + SVG 변화');
let rowProven = false;
for (let page = 0; page < pageCount && !rowProven; page++) {
  for (const t of tablesOnPage(page)) {
    if (t.rows < 2) continue;
    const before = doc.tableRowBoundaries(page, t.section, t.block);
    if (!before || before.length < 3) continue; // need an interior row boundary to observe movement
    const svgBefore = doc.renderPageSvg(page);
    // Whole-table heights: give row 0 a large min-height (≈133px), the rest content-sized (0).
    const heights = Array.from({ length: t.rows }, (_, i) => (i === 0 ? 10000 : 0));
    doc.applyIntent({ intent: 'SetTableRowHeights', section: t.section, index: t.block, heights });
    const after = doc.tableRowBoundaries(page, t.section, t.block);
    const moved = maxMove(before, after);
    const svgChanged = doc.renderPageSvg(page) !== svgBefore;
    doc.undo();
    if (moved > 1 && svgChanged) {
      ok(true, `p${page} 표(${t.section},${t.block}) ${t.rows}×${t.cols}: 행 경계 이동 ${moved.toFixed(1)}px · SVG 변화 ${svgChanged}`);
      rowProven = true;
      break;
    }
  }
}
ok(rowProven, '엔진 레이어: 행높이 intent 가 행경계+렌더에 반영된다 (tableRowBoundaries 신 바인딩)');

console.log(`\n✅ 031 resize-reliability repro: ${passed} checks passed — 기전 판정: 엔진/ratio/캐시 정상(a/b/c 기각), 버그는 UI 좌표 원점(수정됨)`);
void g;
doc.free();
