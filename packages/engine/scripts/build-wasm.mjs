// build-wasm.mjs — @auto-hwp/engine 발행 빌드 훅 (issue 063 블로커 2).
//
// pkg/ 는 gitignore 이므로 `npm pack`/`npm publish` 직전 이 스크립트가 wasm 아티팩트를 재생성해야
// tarball 이 "빈 채" 발행되지 않는다(빈 tarball 위험). 레시피는 AGENTS.md 함정 top6 + verify-local.sh
// --full 의 wasm 재빌드 블록을 **그대로** 재현한다:
//   1) cargo build -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown  (크기 전용 프로필)
//   2) wasm-bindgen --target web --out-dir packages/engine/pkg  <release>/hwp_wasm.wasm
//   3) wasm-opt -Oz (있으면; 다이어트는 게이트가 아니라 최적화 — 실패 시 미적용 경고만)
//   4) pkg/hwp_wasm_bg.wasm 가 존재하고 자명하지 않은 크기(>1MiB)인지 검증(빈 tarball 방지)
//
// 툴체인(cargo/wasm-bindgen)이 없는 JS 전용 환경에서는: 이미 유효한 pkg 가 있으면 그것을 쓰고(발행이
// 아닌 로컬 pack 검증을 막지 않음), 없으면 레시피를 안내하며 하드 실패한다(조용한 빈 번들 금지).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.join(__dirname, "..");
const repoRoot = path.join(engineRoot, "..", "..");
const pkgWasm = path.join(engineRoot, "pkg", "hwp_wasm_bg.wasm");
const MIN_WASM_BYTES = 1024 * 1024; // 1MiB — 실제 엔진은 ~9MiB. 이보다 작으면 빌드 실패로 간주.

function have(bin) {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  console.log(`[build-wasm] $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

function assertWasm() {
  if (!existsSync(pkgWasm)) {
    console.error(`\n[build-wasm] 산출물이 없습니다: ${pkgWasm}\n빌드가 실패했거나 실행되지 않았습니다.\n`);
    process.exit(1);
  }
  const bytes = statSync(pkgWasm).size;
  if (bytes < MIN_WASM_BYTES) {
    console.error(`\n[build-wasm] wasm 이 비정상적으로 작습니다(${bytes} bytes < ${MIN_WASM_BYTES}). 빈 tarball 위험 — 중단.\n`);
    process.exit(1);
  }
  console.log(`[build-wasm] pkg/hwp_wasm_bg.wasm OK (${Math.round(bytes / 1024)} KB)`);
}

const toolchain = have("cargo") && have("wasm-bindgen");

if (!toolchain) {
  if (existsSync(pkgWasm) && statSync(pkgWasm).size >= MIN_WASM_BYTES) {
    console.warn("[build-wasm] cargo/wasm-bindgen 미설치 — 기존 pkg 로 진행합니다(재빌드 생략).");
    assertWasm();
    process.exit(0);
  }
  console.error(
    "\n[build-wasm] cargo 또는 wasm-bindgen 이 없고 유효한 pkg 도 없습니다. 레시피(레포 루트에서):\n" +
      '  export PATH="$HOME/.cargo/bin:$PATH"\n' +
      "  cargo build -q -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown\n" +
      "  wasm-bindgen --target web --out-dir packages/engine/pkg \\\n" +
      "    target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm\n" +
      "  # (선택) wasm-opt -Oz packages/engine/pkg/hwp_wasm_bg.wasm -o packages/engine/pkg/hwp_wasm_bg.wasm\n" +
      "  # wasm-bindgen CLI 버전은 crates/hwp-wasm/Cargo.toml 의 =0.2.125 와 정확히 일치해야 합니다.\n",
  );
  process.exit(1);
}

// 1) release wasm
run("cargo", ["build", "-q", "-p", "hwp-wasm", "--profile", "wasm-size", "--target", "wasm32-unknown-unknown"]);
// 2) wasm-bindgen glue (--target web)
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  "packages/engine/pkg",
  "target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm",
]);
// 3) wasm-opt -Oz — 동작하는 binaryen 후보만 채택, 전부 실패하면 미적용(기능 동일).
let opted = false;
for (const wo of ["wasm-opt", "/opt/homebrew/bin/wasm-opt", "/usr/local/bin/wasm-opt"]) {
  try {
    execFileSync(wo, ["-Oz", "--all-features", pkgWasm, "-o", `${pkgWasm}.opt`], { stdio: "ignore" });
    renameSync(`${pkgWasm}.opt`, pkgWasm);
    console.log(`[build-wasm] wasm-opt -Oz 적용 → ${Math.round(statSync(pkgWasm).size / 1024)} KB`);
    opted = true;
    break;
  } catch {
    try {
      rmSync(`${pkgWasm}.opt`, { force: true });
    } catch {
      /* noop */
    }
  }
}
if (!opted) console.warn("[build-wasm] wasm-opt 미적용(동작하는 binaryen 없음) — 기능은 동일, 크기만 큼.");

// 4) 빈 tarball 방지 검증
assertWasm();
