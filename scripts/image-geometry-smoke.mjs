// image-geometry-smoke.mjs — issue 049 image move/resize SDK: prove the ADDITIVE wasm bindings
// `imageAt` / `imageBbox` are LIVE at runtime on the SAME @tf-hwp/engine the web shell runs, and honour
// the 018 null policy (a miss is `null`, never a throw) — the exact contract the WasmAdapter + editor-core
// + the react ImageOverlay vitest all assume. This is the real-engine cross-check that cargo-check-wasm32
// (compile) can't give.
//
// The benchmark corpus carries ZERO images (layout-check reports "이미지 0"), so a REAL bbox is not
// asserted here — the bbox-CHANGE apply-verify (SetImageSize → re-query → size grew / frozen = fail) is
// pinned by the editor-core `image.test.ts` + react `workspace.image.test.tsx` against a mock that mirrors
// both backends. What this smoke PROVES on wasm: the bindings EXIST, are CALLABLE across a full grid, and
// return `null` on a miss WITHOUT throwing (homomorphic with the desktop `image_at`/`image_bbox` commands).
//
// Reproduce (repo root — needs the wasm built + wasm-bindgen'd into packages/engine/pkg):
//   cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
//   wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
//   node scripts/image-geometry-smoke.mjs
//
// Exits non-zero if any invariant fails.

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

const docs = ["benchmarks/benchmark1.hwpx", "benchmarks/benchmark.hwp"];

for (const rel of docs) {
  const bytes = new Uint8Array(readFileSync(join(repo, rel)));
  const doc = HwpDoc.open(bytes, rel);
  const pages = doc.pageCount();
  console.log(`\n=== ${rel} (${pages}p) ===`);
  check(typeof doc.imageAt === "function", "HwpDoc.imageAt is a live binding");
  check(typeof doc.imageBbox === "function", "HwpDoc.imageBbox is a live binding");

  // Grid-scan imageAt over every page: it must be callable everywhere and never throw. Count hits (the
  // corpus has none → 0 expected, but a NON-null result would still have to be well-shaped).
  let probes = 0;
  let hits = 0;
  let badShape = 0;
  for (let p = 0; p < pages; p++) {
    const g = doc.pageGeometry(p);
    const W = g ? g.w : 794;
    const H = g ? g.h : 1123;
    for (let y = 0; y < H; y += 24) {
      for (let x = 0; x < W; x += 24) {
        probes++;
        let r;
        try {
          r = doc.imageAt(p, x, y);
        } catch (e) {
          check(false, `imageAt(${p},${x},${y}) threw (must return null on a miss): ${e && e.message}`);
          continue;
        }
        if (r != null) {
          hits++;
          const ok = ["x", "y", "w", "h", "section", "block"].every((k) => typeof r[k] === "number");
          if (!ok) badShape++;
          // a real image round-trips through imageBbox by its own anchor.
          const bb = doc.imageBbox(p, r.section, r.block);
          check(bb != null && bb.section === r.section && bb.block === r.block, "imageBbox re-queries the same anchor imageAt returned");
        }
      }
    }
  }
  console.log(`  imageAt: ${probes} probes · ${hits} image hits · ${badShape} bad-shape`);
  check(badShape === 0, "every non-null imageAt result is a well-shaped ImageBox");

  // imageBbox null policy: a query for a definitely-non-image anchor returns null, never throws.
  let bogus = "threw";
  try {
    bogus = doc.imageBbox(0, 99999, 99999);
  } catch (e) {
    check(false, `imageBbox for an unknown anchor should return null, threw: ${e && e.message}`);
  }
  check(bogus == null, "imageBbox for a non-image / out-of-range anchor returns null (018 null policy — no throw)");
  doc.free();
}

if (failures) {
  console.error(`\n✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✓ image-geometry smoke passed (imageAt/imageBbox live on wasm + null policy homomorphic)");
