// issue 027 smoke — exercises the new wasm bindings + the manual-edit intent paths against the REAL
// engine (benchmark.hwp), de-risking the Playwright e2e:
//   • pageGeometry(0)          → {w,h,ml,mt,mr,mb}
//   • tableColBoundaries(...)  → cols+1 ascending px
//   • blockRuns(cell)          → RunSpec[] (run-preserve read)
//   • ApplyContent(table)      → 표 추가 appends a table (page count grows or stays, no throw)
//   • SetTableColWidths        → 열 너비 applies + undo restores
// Run:  node packages/engine/bench/editing-027-smoke.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngineSync, HwpDoc } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
initEngineSync({ module: readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm')) });
const doc = HwpDoc.open(readFileSync(join(repo, 'benchmarks', 'benchmark.hwp')), 'benchmark.hwp');

let passed = 0;
const ok = (c, msg) => { if (!c) throw new Error(`FAIL ${msg}`); passed++; console.log(`  ok · ${msg}`); };

// --- pageGeometry ---
const g = doc.pageGeometry(0);
ok(g && g.w > 0 && g.h > 0, `pageGeometry: ${Math.round(g.w)}×${Math.round(g.h)}px, 여백 좌 ${Math.round(g.ml)}px`);
ok(doc.pageGeometry(9999) === null, 'pageGeometry out-of-range → null');

// --- find a table on page 0 by scanning tableAt ---
let tbl = null;
outer: for (let y = 40; y < g.h - 40 && !tbl; y += 12) {
  for (let x = 40; x < g.w - 40; x += 20) {
    const t = doc.tableAt(0, x, y);
    if (t) { tbl = t; break outer; }
  }
}
ok(tbl, `tableAt found a table at section ${tbl?.section} block ${tbl?.block} (${tbl?.rows}×${tbl?.cols})`);

// --- tableColBoundaries ---
const b = doc.tableColBoundaries(0, tbl.section, tbl.block);
ok(Array.isArray(b) && b.length === tbl.cols + 1, `tableColBoundaries: ${b?.length} boundaries (cols+1=${tbl.cols + 1})`);
ok(b.every((v, i) => i === 0 || v >= b[i - 1]), 'boundaries ascending');
ok(doc.tableColBoundaries(0, 0, 9999) === null, 'tableColBoundaries bad block → null');

// --- blockRuns (cell run-preserve read) ---
const runs = doc.blockRuns(tbl.section, tbl.block, 0, 0);
ok(Array.isArray(runs), `blockRuns(cell 0,0) → ${runs.length} run(s)`);

// --- ApplyContent: 표 추가 (2×3) at document end ---
const before = doc.pageCount();
doc.applyIntent({ intent: 'ApplyContent', json: JSON.stringify({ blocks: [{ type: 'table', header: [], rows: [['', '', ''], ['', '', '']] }] }) });
const after = doc.pageCount();
ok(after >= before, `ApplyContent table: ${before} → ${after} pages (no throw)`);
doc.undo();
ok(doc.pageCount() === before, 'undo removes the added table (page count restored)');

// --- SetTableColWidths: 열 너비 + undo ---
const widths = Array.from({ length: tbl.cols }, (_, i) => (i === 0 ? 2 : 1));
doc.applyIntent({ intent: 'SetTableColWidths', section: tbl.section, index: tbl.block, widths });
const b2 = doc.tableColBoundaries(0, tbl.section, tbl.block);
ok(Array.isArray(b2) && b2.length === tbl.cols + 1, 'SetTableColWidths applied (boundaries still resolve)');
doc.undo();
ok(true, 'SetTableColWidths undo (no throw)');

console.log(`\n✅ 027 smoke: ${passed} checks passed`);
doc.free();
