// build-demo.mjs — 서버 없는 정적 데모 빌드 (OSS: GitHub Pages 등).
//
// Next `output:"export"` 는 동적 라우트 핸들러(POST /api/hwp-edit — AI BYOK 프록시)와 공존할 수
// 없으므로, 빌드 동안 src/app/api 를 임시로 치워두고(.demo-api-hold) 끝나면 반드시 복원한다.
// 클라이언트는 NEXT_PUBLIC_DEMO=1 을 보고 프록시 프로브를 건너뛰고 "정적 데모" 모드로 동작한다
// (LabWorkspace.tsx — AI 편집은 로컬 실행 안내, 뷰/수동편집/export 는 전부 브라우저에서 동작).
//
// 사용:  node scripts/build-demo.mjs            → out/ (basePath 없음 — 커스텀 도메인/로컬 서빙)
//        DEMO_BASE_PATH=/tf-hwp node scripts/build-demo.mjs  → 프로젝트 페이지(username.github.io/tf-hwp)
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const apiDir = path.join(appRoot, "src", "app", "api");
const holdDir = path.join(appRoot, ".demo-api-hold");

const run = (cmd) => execSync(cmd, { cwd: appRoot, stdio: "inherit", env: { ...process.env, DEMO_STATIC: "1" } });

// 이전 실행이 죽어 hold 가 남아 있으면 먼저 복원(멱등).
if (existsSync(holdDir) && !existsSync(apiDir)) renameSync(holdDir, apiDir);

if (!existsSync(apiDir)) {
  console.error("[build-demo] src/app/api 가 없습니다 — 레포 상태를 확인하세요.");
  process.exit(1);
}

renameSync(apiDir, holdDir);
try {
  rmSync(path.join(appRoot, ".next"), { recursive: true, force: true }); // 서버 빌드 캐시와 절대 섞지 않는다
  run("npm run build"); // prebuild 훅(build:deps + copy-wasm/fonts/samples)까지 그대로 수행
  console.log("\n[build-demo] 완료 → apps/hwp-lab/out/ (정적 사이트)");
  console.log("[build-demo] 로컬 확인: npx serve apps/hwp-lab/out");
} finally {
  renameSync(holdDir, apiDir); // 실패해도 api/ 는 반드시 제자리로
  rmSync(path.join(appRoot, ".next"), { recursive: true, force: true }); // export 캐시도 다음 dev 와 섞지 않는다
}
