// build-demo.mjs — 서버 없는 정적 데모 빌드 (OSS: GitHub Pages 등).
//
// Next `output:"export"` 는 동적 라우트 핸들러(POST /api/hwp-edit — AI BYOK 프록시) 및 요청
// 헤더를 읽는 로컬 전용 /models 페이지와 공존할 수 없으므로, 빌드 동안 두 라우트를 app tree 밖으로
// 임시 격리하고 끝나면 반드시 복원한다. /models 를 정적으로 바꾸면 Next 15 segment config 계약을
// 어기거나 로컬 전용 화면을 정적 산출물에 노출할 수 있으므로 라우트 제외가 의도된 경계다.
// 클라이언트는 NEXT_PUBLIC_DEMO=1 을 보고 프록시 프로브를 건너뛰고 "정적 데모" 모드로 동작한다
// (LabWorkspace.tsx — AI 편집은 로컬 실행 안내, 뷰/수동편집/export 는 전부 브라우저에서 동작).
//
// 사용:  node scripts/build-demo.mjs            → out/ (basePath 없음 — 커스텀 도메인/로컬 서빙)
//        DEMO_BASE_PATH=/auto-hwp node scripts/build-demo.mjs  → 프로젝트 페이지(username.github.io/auto-hwp)
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");

export function demoRouteHolds(root = appRoot) {
  return [
    {
      label: "src/app/api",
      source: path.join(root, "src", "app", "api"),
      hold: path.join(root, ".demo-api-hold"),
    },
    {
      label: "src/app/models",
      source: path.join(root, "src", "app", "models"),
      hold: path.join(root, ".demo-models-hold"),
    },
  ];
}

function restoreMovedRoutes(routes) {
  let restoreError;

  for (const route of [...routes].reverse()) {
    const holdExists = existsSync(route.hold);
    const sourceExists = existsSync(route.source);
    if (!holdExists && !sourceExists) {
      restoreError ??= new Error(
        `[build-demo] ${route.label} 복원 실패: 원본과 임시 보관 경로가 모두 없습니다.`,
      );
      continue;
    }
    if (!holdExists) continue;
    if (sourceExists) {
      restoreError ??= new Error(
        `[build-demo] ${route.label} 복원 충돌: 원본과 임시 보관 경로가 모두 존재합니다.`,
      );
      continue;
    }

    try {
      renameSync(route.hold, route.source);
    } catch (error) {
      restoreError ??= error;
    }
  }

  if (restoreError) throw restoreError;
}

// 빌드 실패에도 원본 라우트가 돌아온다는 계약을 테스트에서 직접 주입·검증할 수 있게 경계를 분리한다.
export function withDemoRoutesHeld(root, build) {
  const routes = demoRouteHolds(root);

  // 이전 실행이 비정상 종료돼 hold 만 남았다면 먼저 복원한다. 둘 다 존재하면 어느 쪽도 덮지 않고
  // fail-closed 한다. 사용자 파일을 추측으로 선택하거나 삭제하지 않는다.
  for (const route of routes) {
    if (existsSync(route.hold) && existsSync(route.source)) {
      throw new Error(`[build-demo] ${route.label} 충돌: 원본과 임시 보관 경로가 모두 존재합니다.`);
    }
  }
  for (const route of routes) {
    if (existsSync(route.hold)) renameSync(route.hold, route.source);
  }
  for (const route of routes) {
    if (!existsSync(route.source)) {
      throw new Error(`[build-demo] ${route.label} 가 없습니다 — 레포 상태를 확인하세요.`);
    }
  }

  const moved = [];
  try {
    for (const route of routes) {
      renameSync(route.source, route.hold);
      moved.push(route);
    }
    return build();
  } finally {
    restoreMovedRoutes(moved);
  }
}

/**
 * @param {{
 *   root?: string,
 *   execute?: (command: string, options: import("node:child_process").ExecSyncOptions) => unknown,
 *   logger?: Pick<Console, "log">
 * }} [options]
 */
export function buildDemo({ root = appRoot, execute = execSync, logger = console } = {}) {
  const nextDir = path.join(root, ".next");
  const outDir = path.join(root, "out");

  try {
    const result = withDemoRoutesHeld(root, () => {
      rmSync(nextDir, { recursive: true, force: true }); // 서버 빌드 캐시와 절대 섞지 않는다
      rmSync(outDir, { recursive: true, force: true }); // 이전 export 의 /models 잔재도 허용하지 않는다
      execute("npm run build", {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, DEMO_STATIC: "1" },
      }); // prebuild 훅(build:deps + copy-wasm/fonts/samples)까지 그대로 수행
    });
    logger.log("\n[build-demo] 완료 → apps/hwp-lab/out/ (정적 사이트)");
    logger.log("[build-demo] 로컬 확인: npx serve apps/hwp-lab/out");
    return result;
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true }); // 실패한 export 일부를 다음 배포가 집지 못하게 한다
    throw error;
  } finally {
    rmSync(nextDir, { recursive: true, force: true }); // export 캐시도 다음 dev 와 섞지 않는다
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) buildDemo();
