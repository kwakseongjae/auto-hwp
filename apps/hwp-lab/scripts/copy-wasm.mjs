// copy-wasm.mjs — prebuild/predev 훅 (issue 019 §함정, issue 055 워커 자산 추가).
// `packages/engine/pkg/hwp_wasm_bg.wasm`(015 레시피로 생성) → `apps/hwp-lab/public/hwp/` 로 복사한다.
// issue 055(FG-14): 엔진은 이제 Web Worker 안에서 돈다 — 워커는 번들러 마법 없이 "정적 에셋 모듈
// 워커"로 배포한다(명시적 public wasm URL과 같은 철학). 따라서 wasm 바이너리에 더해 워커 스크립트와
// 그 상대 import 체인(index.js → pkg/hwp_wasm.js)도 함께 복사한다:
//   public/hwp/worker.js          ← packages/engine/worker.js   (모듈 워커 엔트리)
//   public/hwp/index.js           ← packages/engine/index.js    (안전 래퍼 — worker.js 가 import)
//   public/hwp/pkg/hwp_wasm.js    ← packages/engine/pkg/hwp_wasm.js (wasm-bindgen 글루)
//   public/hwp/hwp_wasm_bg.wasm   ← 런타임에 명시적 URL 로 fetch (워커 init 에 그대로 전달)
// pkg 부재 시 "015 레시피로 먼저 빌드하라"는 명확한 에러로 종료한다(조용한 빈 번들 금지).
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const engineRoot = path.join(repoRoot, "packages", "engine");
const wasmSrc = path.join(engineRoot, "pkg", "hwp_wasm_bg.wasm");
const destDir = path.join(appRoot, "public", "hwp");

if (!existsSync(wasmSrc)) {
  console.error(
    `\n[copy-wasm] 엔진 wasm이 없습니다:\n  ${wasmSrc}\n\n` +
      `먼저 015 레시피로 엔진 pkg를 재생성하세요 (레포 루트에서 실행):\n` +
      `  export PATH="$HOME/.cargo/bin:$PATH"\n` +
      `  cargo build -q -p hwp-wasm --release --target wasm32-unknown-unknown\n` +
      `  wasm-bindgen --target web --out-dir packages/engine/pkg \\\n` +
      `    target/wasm32-unknown-unknown/release/hwp_wasm.wasm\n`,
  );
  process.exit(1);
}

mkdirSync(path.join(destDir, "pkg"), { recursive: true });
// [상대경로 유지] worker.js → ./index.js → ./pkg/hwp_wasm.js 의 import 체인이 public에서 그대로 성립.
const copies = [
  [wasmSrc, path.join(destDir, "hwp_wasm_bg.wasm")],
  [path.join(engineRoot, "worker.js"), path.join(destDir, "worker.js")],
  [path.join(engineRoot, "index.js"), path.join(destDir, "index.js")],
  [path.join(engineRoot, "pkg", "hwp_wasm.js"), path.join(destDir, "pkg", "hwp_wasm.js")],
];
for (const [src, dest] of copies) {
  cpSync(src, dest);
}
const kb = Math.round(statSync(path.join(destDir, "hwp_wasm_bg.wasm")).size / 1024);
console.log(`[copy-wasm] engine pkg + worker assets → ${path.relative(repoRoot, destDir)} (wasm ${kb} KB)`);
