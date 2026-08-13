// prepare-deps.mjs — 이 예제의 의존 소스를 고른다 (W6.4).
//
// 기본값은 **레지스트리**(`@auto-hwp/* ^0.0.5`)다: fresh clone → `npm install` → `npm run dev` 만으로
// 외부 사용자와 완전히 같은 경로가 재현된다(레포 빌드 산출물이 끼어들 여지 0).
//
// REPO_DEV=1 이면 **로컬 tarball 이 레지스트리본을 덮어쓴다**: packages/* 를 `npm pack` 해
// `npm install --no-save` 로 얹는다. package.json 은 건드리지 않으므로(--no-save) 예제의 선언은
// 레지스트리 그대로 남고, 원복은 `npm install` 한 번이다. 미발행 변경(예: 0.0.3 예정 CDN 기본값)을
// 이 예제에서 미리 확인할 때 쓴다.
//
//   npm run dev                 # 레지스트리 ^0.0.5
//   REPO_DEV=1 npm run dev      # 로컬 packages/* 빌드본
//   npm run use-local           # REPO_DEV 없이 강제로 로컬 tarball 얹기
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const vendor = path.join(appRoot, "vendor");
const force = process.argv.includes("--force");

if (!force && process.env.REPO_DEV !== "1") {
  console.log("[prepare-deps] 레지스트리 의존 사용(@auto-hwp/* ^0.0.5). 로컬 빌드본을 쓰려면 REPO_DEV=1.");
  process.exit(0);
}

const packagesRoot = path.join(appRoot, "..", "..", "packages");
if (!existsSync(packagesRoot)) {
  console.error(
    `[prepare-deps] REPO_DEV 는 auto-hwp 레포 안에서만 동작합니다 — ${packagesRoot} 가 없습니다.\n` +
      "예제만 복사해 쓰는 경우 REPO_DEV 없이(레지스트리 의존으로) 실행하세요.",
  );
  process.exit(1);
}
console.log("[prepare-deps] REPO_DEV — 로컬 packages/* 를 pack 해서 설치본 위에 얹습니다.");
execFileSync("node", [path.join(__dirname, "pack-deps.mjs")], { cwd: appRoot, stdio: "inherit" });

if (!existsSync(vendor)) {
  console.error("[prepare-deps] vendor/ 가 없습니다 — pack-deps 가 실패했습니다.");
  process.exit(1);
}
// ⚠️ 절대경로로 넘긴다: "vendor/x.tgz" 같은 상대경로는 npm 이 **git 스펙**으로 해석해
// `git ls-remote ssh://git@github.com/vendor/x.tgz.git` 를 시도하다 실패한다(실측).
const tarballs = readdirSync(vendor)
  .filter((f) => f.startsWith("auto-hwp-") && f.endsWith(".tgz"))
  .map((f) => path.join(vendor, f));
if (tarballs.length === 0) {
  console.error("[prepare-deps] vendor/*.tgz 가 없습니다 — pack-deps 가 아무것도 만들지 않았습니다.");
  process.exit(1);
}
// --no-save: package.json 의 레지스트리 선언은 그대로 두고 node_modules 만 로컬본으로 교체한다.
execFileSync("npm", ["install", "--no-save", ...tarballs], { cwd: appRoot, stdio: "inherit" });
console.log(`[prepare-deps] 로컬 tarball ${tarballs.length}개 적용 완료 (원복: npm install).`);
