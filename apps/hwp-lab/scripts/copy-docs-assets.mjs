// copy-docs-assets.mjs — prebuild/predev 훅 (사이트화: /docs 본문 이미지 + 랜딩 기능 GIF).
//
// docs/assets/ 의 **실제로 참조되는 파일만** public/docs-assets/ 로 복사한다. public/docs-assets 는
// git-ignore — 이 스크립트가 매 dev/build 마다 채운다(레포에 같은 바이너리를 두 벌 두지 않는다).
// 링크 재작성(src/app/docs/docsRegistry.ts rewriteDocLink)이 `docs/assets/x.png` → `/docs-assets/x.png`
// 로 보내므로 파일명은 그대로 유지해야 한다.
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const srcDir = path.join(repoRoot, "docs", "assets");
const destDir = path.join(appRoot, "public", "docs-assets");

// 사이트가 실제로 쓰는 것만. (docs/assets 전체는 6MB+ 라 정적 export 산출물이 불필요하게 부푼다.)
const ASSETS = [
  "composable-editor-shells.png", // docs/WHY.md 본문 이미지
  "guide-engine.gif", // 랜딩 기능 섹션 — 열기·렌더
  "guide-vibe.gif", //  랜딩 기능 섹션 — 말로 고치기
  "guide-bulk.gif", //  랜딩 기능 섹션 — 양식 일괄 작성
];

mkdirSync(destDir, { recursive: true });
let total = 0;
for (const name of ASSETS) {
  const from = path.join(srcDir, name);
  if (!existsSync(from)) {
    console.warn(`[copy-docs-assets] 원본 없음 — 건너뜀: docs/assets/${name}`);
    continue;
  }
  const to = path.join(destDir, name);
  cpSync(from, to);
  const kb = Math.round(statSync(to).size / 1024);
  total += kb;
  console.log(`[copy-docs-assets] docs/assets/${name} → public/docs-assets/${name} (${kb} KB)`);
}
console.log(`[copy-docs-assets] 합계 ${total} KB`);
