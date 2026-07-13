// copy-assets.mjs — 비-Next(Vite) 호스트용 wasm/워커 정적 서빙 레시피 (issue 063 블로커 4).
//
// 엔진은 "번들러 마법"이 아니라 **public 정적 에셋**으로 서빙한다(apps/hwp-lab/scripts/copy-wasm.mjs 와
// 같은 철학). 다른 점: 여기서는 소스 트리(packages/engine)가 아니라 **설치된 발행본**
// (node_modules/@tf-hwp/engine — npm pack tarball)에서 복사한다. 즉 이 스크립트가 성공한다는 것 자체가
// "발행 tarball 이 워커 자산(worker.js + index.js + pkg/hwp_wasm.js + wasm)을 실제로 담고 있다"는 증명이다.
//
// worker.js → ./index.js → ./pkg/hwp_wasm.js 의 상대 import 체인이 public/hwp/ 안에서 그대로 성립하도록
// 디렉토리 구조를 보존해 복사한다. wasm 바이너리는 런타임에 명시적 URL(/hwp/hwp_wasm_bg.wasm)로 fetch.
//
// 폰트는 R8(폰트는 번들이 아니라 주입) — 엔진은 폰트를 하나도 담지 않는다. 이 예제는 데모 편의를 위해
// 레포 자산(assets/fonts, OFL NanumGothic)을 복사한다. 실제 외부 호스트는 자신의 OFL 폰트를 public/fonts 에
// 두면 된다(재배포 가능 폰트만 — 한컴/함초롬 계열은 재배포 불가).
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");

// 설치된 @tf-hwp/engine 발행본의 루트를 안정적으로 찾는다(호이스팅 무관).
const engineRoot = path.dirname(require.resolve("@tf-hwp/engine/package.json"));

const hwpDir = path.join(appRoot, "public", "hwp");
mkdirSync(path.join(hwpDir, "pkg"), { recursive: true });

const wasm = path.join(engineRoot, "pkg", "hwp_wasm_bg.wasm");
if (!existsSync(wasm)) {
  console.error(
    `\n[copy-assets] 발행본에 wasm 이 없습니다: ${wasm}\n` +
      `@tf-hwp/engine tarball 이 pkg/hwp_wasm_bg.wasm 을 담지 않았습니다 — 'npm run pack-deps' 로 재생성 후 재설치하세요.\n`,
  );
  process.exit(1);
}

const copies = [
  [wasm, path.join(hwpDir, "hwp_wasm_bg.wasm")],
  [path.join(engineRoot, "worker.js"), path.join(hwpDir, "worker.js")],
  [path.join(engineRoot, "index.js"), path.join(hwpDir, "index.js")],
  [path.join(engineRoot, "pkg", "hwp_wasm.js"), path.join(hwpDir, "pkg", "hwp_wasm.js")],
];
for (const [src, dest] of copies) {
  cpSync(src, dest);
}
const kb = Math.round(statSync(path.join(hwpDir, "hwp_wasm_bg.wasm")).size / 1024);
console.log(`[copy-assets] engine 발행본 → public/hwp (wasm ${kb} KB + worker.js + index.js + pkg/hwp_wasm.js)`);

// 폰트(R8 — 호스트 책임). 데모 편의: 레포 OFL 자산을 복사. 없으면 경고만(외부 호스트는 자신의 폰트를 둔다).
const fontsSrc = path.join(repoRoot, "assets", "fonts");
const fontsDest = path.join(appRoot, "public", "fonts");
const fontFiles = ["NanumGothic-Regular.ttf", "OFL.txt"];
if (existsSync(path.join(fontsSrc, fontFiles[0]))) {
  mkdirSync(fontsDest, { recursive: true });
  for (const f of fontFiles) {
    const s = path.join(fontsSrc, f);
    if (existsSync(s)) cpSync(s, path.join(fontsDest, f));
  }
  console.log(`[copy-assets] OFL NanumGothic → public/fonts (데모용 — 외부 호스트는 자신의 폰트를 둔다)`);
} else {
  console.warn(`[copy-assets] 레포 폰트 자산 없음(${fontsSrc}) — public/fonts 를 직접 채우세요(R8: 재배포 가능 폰트만).`);
}
