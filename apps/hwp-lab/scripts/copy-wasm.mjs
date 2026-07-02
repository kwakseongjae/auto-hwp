// copy-wasm.mjs — prebuild/predev 훅 (issue 019 §함정).
// `packages/engine/pkg/hwp_wasm_bg.wasm`(015 레시피로 생성) → `apps/hwp-lab/public/hwp/` 로 복사한다.
// 오직 이 바이너리만 런타임에 fetch된다(JS 글루는 @tf-hwp/engine import로 번들됨). pkg 부재 시
// "015 레시피로 먼저 빌드하라"는 명확한 에러로 종료한다(조용한 빈 번들 금지).
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const wasmSrc = path.join(repoRoot, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const destDir = path.join(appRoot, "public", "hwp");
const wasmDest = path.join(destDir, "hwp_wasm_bg.wasm");

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

mkdirSync(destDir, { recursive: true });
cpSync(wasmSrc, wasmDest);
const kb = Math.round(statSync(wasmDest).size / 1024);
console.log(`[copy-wasm] ${path.relative(repoRoot, wasmSrc)} → ${path.relative(repoRoot, wasmDest)} (${kb} KB)`);
