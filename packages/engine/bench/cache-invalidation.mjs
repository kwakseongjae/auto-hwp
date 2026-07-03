// Cache correctness (issue 025) — asserts the wasm `HwpDoc` placed-cache:
//   • is built ONCE for an unchanged document (many queries → placeBuilds stays 1),
//   • is NOT invalidated by a read-only intent (Outcome-branching, not intent-kind),
//   • IS invalidated at the five mutation points: applyIntent(edit) / undo / redo / registerFont / open,
//   • returns the SAME result cached vs cold (identity: warm query == a fresh cold query).
// Run:  node packages/engine/bench/cache-invalidation.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngineSync, HwpDoc } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
initEngineSync({ module: readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm')) });
const docBytes = readFileSync(join(repo, 'benchmark1.hwp'));
const fontBytes = new Uint8Array(readFileSync(join(repo, 'assets', 'fonts', 'NanumGothic-Regular.ttf')));

let passed = 0;
const eq = (a, b, msg) => { if (a !== b) throw new Error(`FAIL ${msg}: ${a} !== ${b}`); passed++; console.log(`  ok · ${msg}`); };
const builds = (d) => d.placedStats().placeBuilds;

const doc = HwpDoc.open(docBytes, 'benchmark1.hwp');
doc.registerFont('bench', fontBytes);
const P = { page: 0, x: 120, y: 220 };

// --- unchanged document → placed ONCE across many queries ---------------------------------------
eq(builds(doc), 0, 'fresh open: 0 builds');
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), 1, 'first geometry query → 1 build');
for (let i = 0; i < 50; i++) { doc.hitTest(P.page, P.x, P.y); doc.tableAt(P.page, P.x, P.y); doc.blocksInRect(P.page, 0, 0, 400, 400); }
eq(builds(doc), 1, 'unchanged doc after 150 mixed queries → STILL 1 build');

// --- read-only intent must NOT invalidate (Outcome branch, not intent kind) ---------------------
doc.applyIntent({ intent: 'PageCount' }); // read-only → Outcome=pageCount, revision unchanged
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), 1, 'read-only intent (PageCount) → no rebuild');
doc.applyIntent({ intent: 'HitTest', page: 0, x: 120, y: 220 }); // read-only caret hit
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), 1, 'read-only intent (HitTest) → no rebuild');

// --- find an editable paragraph so the edit-invalidation is a real content mutation --------------
let target = null;
outer: for (let py = 60; py < 1000 && !target; py += 20) {
  for (let px = 60; px < 500; px += 40) {
    const h = doc.hitTest(0, px, py);
    if (h && h.editable && h.kind === 'paragraph') { target = h; break outer; }
  }
}
if (!target) throw new Error('no editable paragraph found on page 0 to exercise the edit path');

// --- edit → rebuild -----------------------------------------------------------------------------
const b1 = builds(doc);
const outcome = doc.applyIntent({ intent: 'SetParagraphText', section: target.section, block: target.block, text: '캐시 무효화 편집' });
if (outcome.kind !== 'edited' && outcome.kind !== 'applied') throw new Error('edit intent did not report an edit: ' + JSON.stringify(outcome));
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), b1 + 1, 'applyIntent(edit) → rebuild');

// --- undo → rebuild -----------------------------------------------------------------------------
const b2 = builds(doc);
eq(doc.undo(), true, 'undo returns true');
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), b2 + 1, 'undo → rebuild');

// --- redo → rebuild -----------------------------------------------------------------------------
const b3 = builds(doc);
eq(doc.redo(), true, 'redo returns true');
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), b3 + 1, 'redo → rebuild');

// --- a no-op undo/redo does NOT bump (kept cache) -----------------------------------------------
doc.undo(); doc.hitTest(P.page, P.x, P.y); // settle to base, one rebuild
const b4 = builds(doc);
eq(doc.undo(), false, 'second undo is a no-op (nothing left)');
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), b4, 'no-op undo → cache kept (no rebuild)');

// --- registerFont → rebuild ---------------------------------------------------------------------
const b5 = builds(doc);
doc.registerFont('bench2', fontBytes); // different family → fingerprint change
doc.hitTest(P.page, P.x, P.y);
eq(builds(doc), b5 + 1, 'registerFont → rebuild');

// --- identity: cached (warm) result == a fresh cold result on a clean reopen ---------------------
doc.registerFont('bench', fontBytes);
const warm = JSON.stringify(doc.hitTest(P.page, P.x, P.y)); // warm (cache built above, then hit)
doc.hitTest(P.page, P.x, P.y);
const cold = (() => {
  const d2 = HwpDoc.open(docBytes, 'benchmark1.hwp');
  d2.registerFont('bench', fontBytes);
  const r = JSON.stringify(d2.hitTest(P.page, P.x, P.y)); // d2's FIRST query = cold placement
  d2.free();
  return r;
})();
eq(warm, cold, 'cached result == cold result (byte-identical JSON)');
// And the same for a marquee query + a table cell query.
const warmRect = JSON.stringify(doc.blocksInRect(0, 0, 0, 400, 400));
const coldRect = (() => {
  const d2 = HwpDoc.open(docBytes, 'benchmark1.hwp');
  d2.registerFont('bench', fontBytes);
  const r = JSON.stringify(d2.blocksInRect(0, 0, 0, 400, 400));
  d2.free();
  return r;
})();
eq(warmRect, coldRect, 'cached blocksInRect == cold blocksInRect');

doc.free();
console.log(`\nALL ${passed} cache-invariant checks passed (issue 025 무효화 5지점 + 동일성).`);
