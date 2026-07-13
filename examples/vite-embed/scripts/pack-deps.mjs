// pack-deps.mjs — 4개 패키지를 `npm pack` 해서 vendor/ 에 tarball 로 떨군다 (issue 063 블로커 6).
//
// 이 예제는 소스경로가 아니라 **발행 tarball 을 설치**해 이식을 증명한다. 각 패키지의 prepack 훅이
// 빌드(engine=wasm 레시피, react=vite+tsc+file:→실버전 치환, editor-core/ai-protocol=tsc)를 수행하므로,
// pack 결과 tarball 은 pkg/dist 를 담고 file: 의존이 0인 "발행본"이다. 이후 `npm install` 이 vendor/ 의
// tarball 을 소비한다(package.json 의 file:./vendor/*.tgz + overrides).
//
// 사용: npm run pack-deps  (그 뒤 npm install)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const vendor = path.join(appRoot, "vendor");
const packagesRoot = path.join(appRoot, "..", "..", "packages");

// 발행 순서와 동일(engine → editor-core → ai-protocol → react) — 의미상 문서화(pack 자체는 순서 무관).
const pkgs = ["engine", "editor-core", "ai-protocol", "react"];

for (const p of pkgs) {
  const dir = path.join(packagesRoot, p);
  console.log(`\n[pack-deps] npm pack ${p} → vendor/`);
  execFileSync("npm", ["pack", "--pack-destination", vendor], { cwd: dir, stdio: "inherit" });
}
console.log(`\n[pack-deps] 완료 → ${path.relative(appRoot, vendor)}/tf-hwp-*-*.tgz (다음: npm install)`);
