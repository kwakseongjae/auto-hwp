// caret-geometry-smoke.mjs — issue 041 (FG-12 前半) glyph-caret exposure smoke, through the SAME wasm
// engine the web shell runs (@auto-hwp/engine).
//
// WHAT IT PROVES (all via the applyIntent JSON seam — NO crate changes; the intents already exist):
//   1) HitTest(page,x,y) returns a char-precise HitResult { offset, para_len, node?, in_cell, ... } at
//      runtime on wasm (the rhwp glyph-box path is NOT a std::fs-font trap — it works).
//   2) Where a hit carries an editable `node` (a body paragraph), CaretRect(page,node,offset) round-trips:
//      the returned rect lands on the clicked line, and a PAST-END offset is CLAMPED (a rect, never null).
//   3) THE GAP (docs/CARET-GAP.md): a grid scan of every benchmark reports the node-present vs.
//      node-null (in_cell / unanchored) distribution — the input to FG-12 後半 (issue 042) caret UI.
//
// Reproduce (repo root — needs the wasm built + wasm-bindgen'd into packages/engine/pkg, like
// scripts/figma-grade/measure-engine.mjs):
//   cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
//   wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
//   node scripts/caret-geometry-smoke.mjs
//
// Exits non-zero if any invariant assertion fails. The GAP distribution is REPORTED, not asserted to a
// fixed value (a future engine that anchors cell text would only shrink the gap — that must not fail).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const wasm = join(repo, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
if (!existsSync(wasm)) {
  console.error(`!! ${wasm} missing — build the wasm first (see this file's header).`);
  process.exit(2);
}
const { initEngineSync, HwpDoc } = await import(join(repo, "packages", "engine", "index.js"));
initEngineSync({ module: readFileSync(wasm) });

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
};

const hitTest = (doc, page, x, y) => doc.applyIntent({ intent: "HitTest", page, x, y }).hit ?? null;
const caretRect = (doc, page, node, offset) => doc.applyIntent({ intent: "CaretRect", page, node, offset }).caret ?? null;
// issue 053 — the CELL-ADDRESSED caret surface (own-render placement, no rhwp gate). Direct engine
// bindings (the placed-cache lane the WasmAdapter uses); the Intent lane (HitTestCell/CaretRectCell)
// is exercised by crates/hwp-mcp/tests/schema_v0.rs.
const cellTextHit = (doc, page, x, y) => doc.cellTextHit(page, x, y);
const cellCaretRect = (doc, s, b, r, c, para, off) => doc.cellCaretRect(s, b, r, c, para, off);

const isPageNotFound = (e) => !!e && typeof e.message === "string" && /찾을 수 없|not found|out of range/.test(e.message);

/** Scan a grid over every page; classify each glyph hit into the three buckets that define the gap.
 *  HitTest renders via rhwp's glyph boxes, whose page count can be LOWER than own-render `pageCount()`
 *  (a real own-render↔rhwp pagination divergence on some HWPX — see docs/CARET-GAP.md); when rhwp can't
 *  render a page we stop the scan there rather than crash, and report how many pages we actually scanned. */
function scan(doc, pages, step) {
  const b = {
    probes: 0,
    hits: 0,
    nulls: 0,
    inCell: 0,
    bodyAnchored: 0,
    bodyUnanchored: 0,
    // issue 053 — the cell-addressed caret closes the in_cell/unanchored gap. Per rhwp glyph hit:
    //   cellResolved = the SAME point resolves through `cellTextHit` (own-render cell caret), and
    //   editable     = bodyAnchored OR cellResolved — "a click here yields a WORKING caret".
    cellResolved: 0,
    editable: 0,
  };
  let firstAnchored = null;
  let firstCell = null; // first cell-resolved probe — the 053 round-trip witness
  let badShape = 0;
  let scanned = 0;
  pageLoop: for (let p = 0; p < pages; p++) {
    const g = doc.pageGeometry(p);
    const W = g ? g.w : 794;
    const H = g ? g.h : 1123;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        b.probes++;
        let h;
        try {
          h = hitTest(doc, p, x, y);
        } catch (e) {
          if (isPageNotFound(e)) {
            b.probes--; // rhwp has fewer pages than own-render: stop, don't count this probe
            break pageLoop;
          }
          throw e;
        }
        if (!h) {
          b.nulls++;
          continue;
        }
        b.hits++;
        // Contract: a hit ALWAYS carries a numeric offset + para_len (para_len clamp target), never null.
        if (!Number.isInteger(h.offset) || !Number.isInteger(h.para_len)) badShape++;
        const anchored = !h.in_cell && h.node != null;
        // issue 053: only a NON-anchored glyph needs the cell-addressed fallback (an anchored body
        // paragraph already has its NodeId caret); probing just those keeps the scan fast + honest.
        let cell = null;
        if (!anchored) {
          cell = cellTextHit(doc, p, x, y);
          if (cell) {
            b.cellResolved++;
            if (!firstCell) firstCell = { p, x, y, cell };
          }
        }
        if (anchored || cell) b.editable++;
        if (h.in_cell) b.inCell++;
        else if (h.node != null) {
          b.bodyAnchored++;
          // Prefer a NON-empty paragraph with an interior offset so the round-trip's "near click" +
          // past-end clamp checks are meaningful (an empty para at the margin is a weak witness).
          const better = h.para_len > 0 && h.offset > 0;
          if (!firstAnchored || (better && !(firstAnchored.h.para_len > 0 && firstAnchored.h.offset > 0))) {
            firstAnchored = { p, x, y, h };
          }
        } else b.bodyUnanchored++;
      }
    }
    scanned = p + 1;
  }
  return { b, firstAnchored, firstCell, badShape, scanned };
}

/** issue 053 — the NATIVE own-render cell resolution: scan the SAME grid, but classify against the
 *  OWN-RENDER surface (the one the user actually clicks): a point inside a placed table CELL that has
 *  TEXT must resolve through `cellTextHit`. This is the honest resolution number for the display
 *  surface — the rhwp-hit-based `cellResolved` above under-counts because it probes own-render
 *  geometry with RHWP coordinates (two layout engines place tables at different y even at equal page
 *  counts; on benchmark1.hwpx rhwp diverges to 14p vs own 25p). Own-render clicks are what the UI
 *  sends, and they never leave the surface they were measured on. */
function scanOwn(doc, pages, step) {
  const o = { cellTextProbes: 0, cellTextResolved: 0 };
  for (let p = 0; p < pages; p++) {
    const g = doc.pageGeometry(p);
    const W = g ? g.w : 794;
    const H = g ? g.h : 1123;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const cell = doc.tableCellAt(p, x, y);
        if (!cell || !(cell.text || "").trim()) continue; // only TEXT cells promise a caret
        o.cellTextProbes++;
        if (cellTextHit(doc, p, x, y)) o.cellTextResolved++;
      }
    }
  }
  return o;
}

/** issue 053 — the cell-addressed round-trip: a cellTextHit's `(section, block, row, col, para,
 *  offset)` must re-resolve through CellCaretRect to the SAME geometry, a past-end offset must CLAMP
 *  (a rect, never null), and an unresolvable address must be null (018). */
function cellRoundTrip(doc, fixture) {
  const { p, x, y, cell } = fixture;
  console.log(
    `  cell round-trip @p${p} (${x},${y}) → (s${cell.section} b${cell.block} r${cell.row} c${cell.col} para${cell.para} off${cell.offset}/${cell.para_len})`,
  );
  const rect = cellCaretRect(doc, cell.section, cell.block, cell.row, cell.col, cell.para, cell.offset);
  check(rect != null, "CellCaretRect(address) returns a rect for a cellTextHit's own address");
  if (rect) {
    check(rect.page === cell.caret.page, `owning page round-trips (${rect.page} == ${cell.caret.page})`);
    check(Math.abs(rect.x - cell.caret.x) < 0.01, `caret x round-trips (${rect.x} ≈ ${cell.caret.x})`);
    check(Math.abs(rect.top - cell.caret.top) < 0.01, `caret top round-trips (${rect.top} ≈ ${cell.caret.top})`);
    check(rect.height > 0, `cell caret height > 0 (got ${rect.height})`);
  }
  const clamped = cellCaretRect(doc, cell.section, cell.block, cell.row, cell.col, cell.para, cell.para_len + 50);
  check(clamped != null, "CellCaretRect clamps a past-end offset to a rect (not null) — para_len contract");
  let bogus = "threw";
  try {
    bogus = cellCaretRect(doc, cell.section, cell.block, 9999, 9999, 0, 0);
  } catch (e) {
    check(false, `CellCaretRect for an unknown cell should return null, threw: ${e && e.message}`);
  }
  check(bogus == null, "CellCaretRect for an unresolvable cell returns null (018 null policy — no throw)");
}

/** The CaretRect round-trip + para_len clamp + null-policy checks, run on a doc that HAS a body anchor. */
function roundTrip(doc, pages, fixture) {
  const { p, x, y, h } = fixture;
  console.log(`  round-trip @p${p} (${x},${y}) node=${h.node} offset=${h.offset} para_len=${h.para_len}`);
  const rect = caretRect(doc, p, h.node, h.offset);
  check(rect != null, "CaretRect(node, offset) returns a rect on the hit's own page");
  if (rect) {
    check(rect.height > 0, `caret height > 0 (got ${rect.height})`);
    const g = doc.pageGeometry(p);
    const W = g ? g.w : 794;
    check(rect.x >= 0 && rect.x <= W, `caret x within page [0, ${W}] (got ${rect.x})`);
    // "near the click": the click y sits within the caret's vertical band (± one line height of slack).
    check(
      y >= rect.top - rect.height && y <= rect.top + 2 * rect.height,
      `caret line band brackets the click y=${y} (top=${rect.top} h=${rect.height})`,
    );
  }
  // para_len CLAMP: a PAST-END offset must still return a rect (never null) on the valid page.
  const clamped = caretRect(doc, p, h.node, h.para_len + 50);
  check(clamped != null, "CaretRect clamps a past-end offset to a rect (not null) — para_len contract");
  // 018 null policy: an UNRESOLVABLE target (a node id that maps to no paragraph) → null, not a throw.
  let bogus = "threw";
  try {
    bogus = caretRect(doc, p, 9_000_000, 0);
  } catch (e) {
    check(false, `CaretRect for an unknown node should return null, threw: ${e && e.message}`);
  }
  check(bogus == null, "CaretRect for an unresolvable node returns null (018 null policy — no throw)");
}

const results = [];
// benchmark.hwp / benchmark1.hwp are the issue's required smoke docs (binary .hwp — the gap corpus).
// benchmark1.hwpx is added to EXERCISE the node-present round-trip (HWPX carries NodeIds; .hwp doesn't).
const docs = [
  { rel: "benchmarks/benchmark.hwp", step: 20 },
  { rel: "benchmarks/benchmark1.hwp", step: 20 },
  { rel: "benchmarks/benchmark1.hwpx", step: 20 },
];

for (const { rel, step } of docs) {
  const bytes = new Uint8Array(readFileSync(join(repo, rel)));
  const doc = HwpDoc.open(bytes, rel);
  const pages = doc.pageCount();
  console.log(`\n=== ${rel} (${pages}p, grid step ${step}px) ===`);
  const { b, firstAnchored, firstCell, badShape, scanned } = scan(doc, pages, step);
  if (scanned < pages) {
    console.log(`  ⚠ rhwp glyph render stops at p${scanned - 1} while own-render pageCount=${pages} (pagination divergence — scanned ${scanned}p)`);
  }
  const pct = (n) => (b.hits ? ((100 * n) / b.hits).toFixed(1) : "0.0");
  console.log(
    `  glyph hits ${b.hits} / ${b.probes} probes  (nulls ${b.nulls})` +
      `  |  in_cell ${b.inCell} (${pct(b.inCell)}%)  bodyAnchored ${b.bodyAnchored} (${pct(b.bodyAnchored)}%)` +
      `  bodyUnanchored ${b.bodyUnanchored} (${pct(b.bodyUnanchored)}%)`,
  );
  // issue 053 — the cell-addressed caret's effect on the SAME buckets: editable = a working caret.
  console.log(
    `  053 editable ${b.editable} (${pct(b.editable)}%)  =  bodyAnchored ${b.bodyAnchored} + cellResolved ${b.cellResolved}` +
      `  (rhwp-coordinate denominator — see the own-render native line below)`,
  );
  // issue 053 — the NATIVE own-render denominator: the surface the UI actually clicks.
  const o = scanOwn(doc, pages, step);
  const opct = o.cellTextProbes ? ((100 * o.cellTextResolved) / o.cellTextProbes).toFixed(1) : "0.0";
  console.log(`  053 own-render cell-text resolution ${o.cellTextResolved} / ${o.cellTextProbes} (${opct}%)`);
  check(b.hits > 0, "at least one glyph hit on the document");
  check(badShape === 0, `every hit carries integer offset + para_len (bad ${badShape})`);
  check(b.editable > 0, "issue 053: at least one probe resolves to a WORKING caret on every benchmark");
  if (firstAnchored) roundTrip(doc, pages, firstAnchored);
  else console.log("  (no body-anchored hit — every glyph is in_cell or unanchored: NodeId round-trip N/A)");
  if (firstCell) cellRoundTrip(doc, firstCell);
  results.push({ rel, pages, scanned, ...b, ...o, anchored: !!firstAnchored });
  doc.free();
}

console.log("\nCARET_GAP_JSON " + JSON.stringify(results));
if (failures) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✓ caret-geometry smoke passed");
