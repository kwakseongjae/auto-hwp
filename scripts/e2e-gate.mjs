#!/usr/bin/env node
// e2e-gate.mjs — 발행 전 관문 (#549). npm 발행(publish.yml) 첫 단계에서, 발행하려는 커밋에
// e2e 워크플로(.github/workflows/e2e.yml)의 **성공한 실행**이 있는지 GitHub API 로 본다.
//
// - 있으면 통과.
// - 없으면 실제 발행(DRY_RUN=false)은 여기서 멈춘다(exit 1). dry-run 은 경고 줄만 남기고 계속한다.
// - 기록을 읽지 못해도(네트워크 · 권한) 같은 규칙이다 — 확인하지 못한 것은 통과가 아니다.
//
// - 「dry-run 인가」는 발행 단계와 같은 기준으로 읽는다: DRY_RUN 이 정확히 "true" 일 때만 dry-run. 비었거나 다른 값이면
//   발행 단계는 실제로 발행하므로 관문도 실제 발행으로 본다(열린 쪽으로 실패하지 않게).
// - 근거로 삼는 실행은 이 저장소의 수동 실행(workflow_dispatch)뿐이다. 통과 줄에 그 실행 주소 · 시도 횟수를 남긴다.
//
// 판단은 순수 함수 `decide` 에 두고 scripts/tests/e2e-gate.test.mjs 가 고정한다.
// 사용(Actions): GITHUB_REPOSITORY · GITHUB_SHA · GITHUB_TOKEN(actions: read) · DRY_RUN 을 env 로 받는다.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const E2E_WORKFLOW = "e2e.yml";
export const E2E_EVENT = "workflow_dispatch";

/** 발행 단계(`[ "$DRY_RUN" = "true" ]`)와 같은 판정. */
export function isDryRun(value) {
  return value === "true";
}

/**
 * @param {{ runs: Array<{ head_sha?: string, status?: string, conclusion?: string | null, event?: string, html_url?: string, run_attempt?: number, head_repository?: { full_name?: string } }>, sha: string, dryRun: boolean, repo?: string }} input
 * @returns {{ ok: boolean, level: "notice" | "warning" | "error", message: string }}
 */
export function decide({ runs, sha, dryRun, repo }) {
  const short = String(sha).slice(0, 7);
  const passed = (runs ?? []).find(
    (run) =>
      run.head_sha === sha &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.event === E2E_EVENT &&
      (!repo || run.head_repository?.full_name === repo),
  );
  if (passed) {
    const attempt = passed.run_attempt ?? 1;
    return {
      ok: true,
      level: "notice",
      message:
        `${E2E_WORKFLOW} 이 커밋 ${short} 에서 초록이다 — 근거 실행 ${passed.html_url ?? "(주소 없음)"}` +
        ` · 시도 ${attempt}번째${attempt > 1 ? "(재실행으로 받은 초록)" : ""}`,
    };
  }
  const message =
    `커밋 ${short} 에 ${E2E_WORKFLOW} 의 성공한 실행이 없다 — ` +
    `먼저 \`gh workflow run ${E2E_WORKFLOW} --ref <가지>\` 로 전체 e2e 를 돌리고 초록을 확인한 뒤 발행한다(docs/RELEASING.md)`;
  return dryRun
    ? { ok: true, level: "warning", message: `${message}. dry-run 이라 계속한다 — 실제 발행은 여기서 멈춘다` }
    : { ok: false, level: "error", message };
}

/** 이 커밋의 e2e 워크플로 실행(성공한 것) 목록. */
export async function fetchRuns({ repo, sha, token, fetchImpl = fetch }) {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${E2E_WORKFLOW}/runs` +
    `?head_sha=${encodeURIComponent(sha)}&status=success&event=${E2E_EVENT}&per_page=20`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} — ${E2E_WORKFLOW} 실행 기록을 읽지 못했다`);
  }
  const body = await response.json();
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
}

/** 실행 결과를 Actions 줄로. 반환값은 종료 코드. */
export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const dryRun = isDryRun(env.DRY_RUN);
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!repo || !sha) {
    log("::error::GITHUB_REPOSITORY · GITHUB_SHA 가 없다 — Actions 밖에서는 이 관문을 돌릴 수 없다");
    return dryRun ? 0 : 1;
  }
  let result;
  try {
    const runs = await fetchRuns({ repo, sha, token: env.GITHUB_TOKEN, fetchImpl });
    result = decide({ runs, sha, dryRun, repo });
  } catch (error) {
    const message = `${error.message}. 확인하지 못한 것은 통과가 아니다`;
    result = dryRun
      ? { ok: true, level: "warning", message: `${message} — dry-run 이라 계속한다` }
      : { ok: false, level: "error", message };
  }
  log(`::${result.level}::${result.message}`);
  return result.ok ? 0 : 1;
}

/** 이 파일을 직접 실행했는가 — 링크를 거친 경로로 불러도 같다(문자열 비교면 아무 말 없이 0 으로 끝난다). */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}
