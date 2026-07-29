// rewrite-workspace-deps.mjs — file: ↔ 실버전 토글 (issue 063 블로커 1).
//
// 전략: **로컬 개발은 file: 심링크로, 발행 tarball 만 실버전으로.** 이 레포는 루트 pnpm-workspace 가
// 없고(패키지별 독립 package-lock.json = npm), apps/hwp-lab 도 npm+file: 로 소비한다 — pnpm 의
// `workspace:*` 프로토콜을 도입하면 npm 이 이를 해석하지 못해 apps/hwp-lab 설치가 깨진다(무회귀 위반).
// 그래서 on-disk package.json 은 file: 를 그대로 두어 로컬 개발/심링크를 보존하고,
// `with-publish-deps.mjs`가 build → file:을 ^<실버전>으로 치환 → lifecycle을 끈 npm pack/publish →
// finally 복원을 한 프로세스에서 소유한다. npm 자체 prepack/postpack에 복원을 맡기면 npm이 pack 도중
// 실패할 때 postpack이 실행되지 않아 worktree가 publish 모드로 남는 것이 실측됐다.
//
// 대상: @auto-hwp/react 의 dependencies 중 @auto-hwp/editor-core, @auto-hwp/engine (react 만 상호의존을 가짐 —
// editor-core/ai-protocol/engine 은 @auto-hwp 상호의존이 없어 치환 대상이 없다). 실버전은 형제 패키지의
// package.json version 을 그때그때 읽어 `^<version>` 으로 쓴다(버전 범프에도 자동 동기).
//
// 파일 전체를 JSON.parse→stringify 하면 배열 포맷이 뭉개져 디프 노이즈가 크다 — 그래서 해당 dep 라인만
// **텍스트로 치환**해 나머지 포맷(단일 라인 배열 등)을 그대로 보존한다(멱등).
//
// 사용:  node scripts/rewrite-workspace-deps.mjs --publish   # file: → ^ver
//        node scripts/rewrite-workspace-deps.mjs --dev       # ^ver  → file: (finally 복원)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reactRoot = path.join(__dirname, "..");
const pkgPath = path.join(reactRoot, "package.json");

// dep 이름 → { file:(로컬 상대경로), dir:(형제 패키지 경로 — 버전 조회용) }
const DEPS = {
  "@auto-hwp/editor-core": { file: "file:../editor-core", dir: path.join(reactRoot, "..", "editor-core") },
  "@auto-hwp/engine": { file: "file:../engine", dir: path.join(reactRoot, "..", "engine") },
};

const mode = process.argv[2];
if (mode !== "--publish" && mode !== "--dev") {
  console.error("usage: rewrite-workspace-deps.mjs --publish | --dev");
  process.exit(2);
}

let text = readFileSync(pkgPath, "utf8");
let changed = 0;
for (const [name, meta] of Object.entries(DEPS)) {
  const next =
    mode === "--publish" ? `^${JSON.parse(readFileSync(path.join(meta.dir, "package.json"), "utf8")).version}` : meta.file;
  // "@auto-hwp/engine": "<현재값>"  →  "@auto-hwp/engine": "<next>"  (값만 치환, 앞뒤 공백/따옴표 보존)
  const re = new RegExp(`("${name.replace(/[/\\]/g, "\\$&")}"\\s*:\\s*")([^"]*)(")`);
  const m = text.match(re);
  if (!m) continue;
  if (m[2] !== next) {
    console.log(`[rewrite-deps] ${name}: ${m[2]} → ${next}`);
    text = text.replace(re, `$1${next}$3`);
    changed++;
  }
}

writeFileSync(pkgPath, text);
console.log(`[rewrite-deps] mode=${mode} changed=${changed}`);
