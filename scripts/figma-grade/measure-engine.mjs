// measure-engine.mjs — issue 033 (docs-only research) latency + SVG-DOM measurement harness.
//
// Measures, through the SAME wasm engine the web shell runs (@tf-hwp/engine), the numbers behind
// docs/FIGMA-GRADE-UX.md §1 (latency budget) and §2/§4 (render/open gaps):
//   • document OPEN time (parse → IR)                          — §4 파싱/열기
//   • registerFont RE-LAYOUT time (the lab auto-registers a face on open → re-typeset)
//   • SVG-DOM node counts per page + total (grep '<tag')       — §2(a) SVG DOM 한계 실측
//   • FULL-DOC renderPageSvg sum = the exact cost HwpPageView.tsx:61-80 pays on every refreshToken
//     bump (it re-fetches EVERY page, not just the edited one) — §2(b) 부분 갱신 실측
//   • single-page re-render (post-edit) vs. sum → the "edit→screen" gap
//
// Reproduce (repo root):
//   cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
//   wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
//   node scripts/figma-grade/measure-engine.mjs
//
// No app/npm build chain needed — this loads packages/engine/pkg/hwp_wasm_bg.wasm directly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngineSync, HwpDoc } from '../../packages/engine/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

initEngineSync({ module: readFileSync(join(repo, 'packages', 'engine', 'pkg', 'hwp_wasm_bg.wasm')) });
const fontBytes = new Uint8Array(readFileSync(join(repo, 'assets', 'fonts', 'NanumGothic-Regular.ttf')));

const nodeCount = (svg) => (svg.match(/<[a-zA-Z]/g) || []).length;
const tagHist = (svg) => {
  const h = {};
  for (const m of svg.matchAll(/<([a-zA-Z]+)/g)) h[m[1]] = (h[m[1]] || 0) + 1;
  return h;
};
const ms = (n) => `${n.toFixed(1)}ms`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function measure(file, { withFont }) {
  const bytes = readFileSync(join(repo, 'benchmarks', file));

  // --- OPEN (parse → IR) : best of 3 (first call warms wasm) --------------------------------------
  const opens = [];
  let doc = null;
  for (let i = 0; i < 3; i++) {
    if (doc) doc.free();
    const t0 = performance.now();
    doc = HwpDoc.open(bytes, file);
    opens.push(performance.now() - t0);
  }
  const openMs = Math.min(...opens);
  const pages = doc.pageCount();

  // --- registerFont RE-LAYOUT (metrics change → full re-typeset, per 022/025 contract) -----------
  const tF0 = performance.now();
  doc.registerFont('bench', fontBytes);
  const relayoutMs = performance.now() - tF0;

  // --- FULL-DOC render (HwpPageView re-fetches ALL pages on refreshToken) -------------------------
  let totalNodes = 0, maxNodes = 0, maxPage = -1, totalBytes = 0;
  const perPageNodes = [];
  const hist = {};
  const tR0 = performance.now();
  for (let p = 0; p < pages; p++) {
    const svg = doc.renderPageSvg(p);       // revision-keyed svg cache is COLD on the first pass
    const n = nodeCount(svg);
    perPageNodes.push(n);
    totalNodes += n; totalBytes += svg.length;
    if (n > maxNodes) { maxNodes = n; maxPage = p; }
    if (withFont) { const h = tagHist(svg); for (const k in h) hist[k] = (hist[k] || 0) + h[k]; }
  }
  const fullRenderMs = performance.now() - tR0;

  // --- single-page re-render (post-edit page-only cost, if the shell were selective) --------------
  const single = [];
  for (let i = 0; i < 5; i++) { const s = performance.now(); doc.renderPageSvg(maxPage); single.push(performance.now() - s); }
  const singlePageMs = median(single);

  // --- hitTest latency (cached placement, cf. issue 025) -----------------------------------------
  const hits = [];
  for (let i = 0; i < 100; i++) { const s = performance.now(); doc.hitTest(0, 120, 220); hits.push(performance.now() - s); }
  const hitMs = median(hits);

  doc.free();
  return { file, pages, openMs, relayoutMs, totalNodes, maxNodes, maxPage, avgNodes: Math.round(totalNodes / pages), totalBytes, fullRenderMs, singlePageMs, hitMs, perPageNodes, hist };
}

console.log('=== issue 033 · figma-grade engine measurement (wasm @tf-hwp/engine, NanumGothic registered) ===\n');
const results = [];
for (const f of ['benchmark.hwp', 'benchmark1.hwp', 'benchmark2.hwp']) {
  const r = measure(f, { withFont: true });
  results.push(r);
  console.log(`${f}  (${r.pages}p)`);
  console.log(`  open (parse→IR):        ${ms(r.openMs)}   (min of 3)`);
  console.log(`  registerFont re-layout: ${ms(r.relayoutMs)}`);
  console.log(`  SVG-DOM nodes:          total ${r.totalNodes}  ·  max/page ${r.maxNodes} (p${r.maxPage})  ·  avg/page ${r.avgNodes}`);
  console.log(`  SVG bytes total:        ${(r.totalBytes / 1024).toFixed(0)} KiB`);
  console.log(`  full-doc render (ALL ${r.pages} pages, cold): ${ms(r.fullRenderMs)}   ← HwpPageView pays this on every refreshToken`);
  console.log(`  single-page re-render:  ${ms(r.singlePageMs)}   (edit→screen if the shell were page-selective)`);
  console.log(`  hitTest (cached):       ${ms(r.hitMs)}/call`);
  console.log('');
}
const b2 = results.find((r) => r.file === 'benchmark2.hwp');
console.log('benchmark2 tag histogram (all pages):', JSON.stringify(b2.hist));
console.log('benchmark2 per-page nodes:', JSON.stringify(b2.perPageNodes));
console.log('\nBENCH_JSON ' + JSON.stringify(results.map(({ perPageNodes, hist, ...r }) => r)));
