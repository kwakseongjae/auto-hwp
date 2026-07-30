// prepare-deps.mjs — 의존 소스 선택 (W6.4). vite-embed 의 같은 이름 스크립트와 규칙이 동일하다.
//
// 기본값은 **레지스트리**(`@auto-hwp/ai-protocol ^0.0.2`) — fresh clone 사용자가 겪는 경로 그대로다.
// REPO_DEV=1 이면 로컬 packages/ai-protocol 을 pack 해서 `npm install --no-save` 로 얹는다
// (package.json 선언은 레지스트리 그대로, 원복은 `npm install`).
//
//   npm start                 # 레지스트리 ^0.0.2
//   REPO_DEV=1 npm start      # 로컬 packages/ai-protocol 빌드본
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const vendor = path.join(appRoot, "vendor");
const pkgDir = path.join(appRoot, "..", "..", "packages", "ai-protocol");
const force = process.argv.includes("--force");

if (!force && process.env.REPO_DEV !== "1") {
  console.log("[prepare-deps] 레지스트리 의존 사용(@auto-hwp/ai-protocol ^0.0.2). 로컬 빌드본은 REPO_DEV=1.");
  process.exit(0);
}

if (!existsSync(pkgDir)) {
  console.error(
    `[prepare-deps] REPO_DEV 는 auto-hwp 레포 안에서만 동작합니다 — ${pkgDir} 가 없습니다.\n` +
      "예제만 복사해 쓰는 경우 REPO_DEV 없이(레지스트리 의존으로) 실행하세요.",
  );
  process.exit(1);
}
mkdirSync(vendor, { recursive: true }); // npm pack 은 목적 디렉터리를 만들지 않는다
execFileSync("npm", ["pack", "--pack-destination", vendor], { cwd: pkgDir, stdio: "inherit" });
// ⚠️ 절대경로로 넘긴다: "vendor/x.tgz" 같은 상대경로는 npm 이 **git 스펙**으로 해석해
// `git ls-remote ssh://git@github.com/vendor/x.tgz.git` 를 시도하다 실패한다(실측).
const tarballs = readdirSync(vendor)
  .filter((f) => f.startsWith("auto-hwp-ai-protocol-") && f.endsWith(".tgz"))
  .map((f) => path.join(vendor, f));
if (tarballs.length === 0) {
  console.error("[prepare-deps] vendor/auto-hwp-ai-protocol-*.tgz 가 없습니다 — npm pack 실패.");
  process.exit(1);
}
execFileSync("npm", ["install", "--no-save", ...tarballs], { cwd: appRoot, stdio: "inherit" });
console.log("[prepare-deps] 로컬 ai-protocol tarball 적용 완료 (원복: npm install).");
