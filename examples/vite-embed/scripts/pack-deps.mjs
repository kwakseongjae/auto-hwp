// pack-deps.mjs — 4개 패키지를 `npm pack` 해서 vendor/ 에 tarball 로 떨군다 (issue 063 블로커 6).
//
// 이 예제는 소스경로가 아니라 **발행 tarball 을 설치**해 이식을 증명한다. 세 패키지의 prepack과
// React safe wrapper가 빌드+file:→실버전 치환을 수행하므로,
// pack 결과 tarball 은 pkg/dist 를 담고 file: 의존이 0인 "발행본"이다. 이후 `npm install` 이 vendor/ 의
// tarball 을 소비한다(package.json 의 file:./vendor/*.tgz + overrides).
//
// 사용: npm run pack-deps  (그 뒤 npm install)
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const vendor = path.join(appRoot, "vendor");
const packagesRoot = path.join(appRoot, "..", "..", "packages");

// vendor/ 는 gitignore 대상이므로 fresh clone 에는 없다. npm pack 의 --pack-destination 은
// 목적 디렉터리를 만들지 않으므로 스크립트가 직접 준비해야 첫 실행부터 동작한다.
mkdirSync(vendor, { recursive: true });

// 발행 순서와 동일(engine → editor-core → ai-protocol → react) — 의미상 문서화(pack 자체는 순서 무관).
const pkgs = ["engine", "editor-core", "ai-protocol", "react"];

for (const p of pkgs) {
  const dir = path.join(packagesRoot, p);
  console.log(`\n[pack-deps] npm pack ${p} → vendor/`);
  const args =
    p === "react"
      ? ["run", "pack:safe", "--", "--pack-destination", vendor]
      : ["pack", "--pack-destination", vendor];
  execFileSync("npm", args, { cwd: dir, stdio: "inherit" });
}
console.log(`\n[pack-deps] 완료 → ${path.relative(appRoot, vendor)}/auto-hwp-*-*.tgz (다음: npm install)`);
