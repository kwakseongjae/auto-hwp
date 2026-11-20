#!/usr/bin/env node
// e2e-gate.mjs — 발행 전 관문 (#549). npm 발행(publish.yml) 첫 단계에서, 발행하려는 커밋에
// e2e 워크플로(.github/workflows/e2e.yml)의 **성공한 실행**이 있는지 GitHub API 로 본다.
//
// - 있으면 통과.
// - 없으면 실제 발행(DRY_RUN=false)은 여기서 멈춘다(exit 1). dry-run 은 경고 줄만 남기고 계속한다.
// - 기록을 읽지 못해도(네트워크 · 권한) 같은 규칙이다 — 확인하지 못한 것은 통과가 아니다.
//
// 판단은 순수 함수 `decide` 에 두고 scripts/tests/e2e-gate.test.mjs 가 세 경우를 고정한다.
// 사용(Actions): GITHUB_REPOSITORY · GITHUB_SHA · GITHUB_TOKEN(actions: read) · DRY_RUN 을 env 로 받는다.
import { pathToFileURL } from "node:url";

export const E2E_WORKFLOW = "e2e.yml";

/**
 * @param {{ runs: Array<{ head_sha?: string, status?: string, conclusion?: string | null }>, sha: string, dryRun: boolean }} input
 * @returns {{ ok: boolean, level: "notice" | "warning" | "error", message: string }}
 */
export function decide({ runs, sha, dryRun }) {
  const short = String(sha).slice(0, 7);
  const passed = (runs ?? []).some(
    (run) => run.head_sha === sha && run.status === "completed" && run.conclusion === "success",
  );
  if (passed) {
    return { ok: true, level: "notice", message: `${E2E_WORKFLOW} 이 커밋 ${short} 에서 초록이다` };
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
    `?head_sha=${encodeURIComponent(sha)}&status=success&per_page=20`;
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
  const dryRun = env.DRY_RUN !== "false";
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!repo || !sha) {
    log("::error::GITHUB_REPOSITORY · GITHUB_SHA 가 없다 — Actions 밖에서는 이 관문을 돌릴 수 없다");
    return dryRun ? 0 : 1;
  }
  let result;
  try {
    const runs = await fetchRuns({ repo, sha, token: env.GITHUB_TOKEN, fetchImpl });
    result = decide({ runs, sha, dryRun });
  } catch (error) {
    const message = `${error.message}. 확인하지 못한 것은 통과가 아니다`;
    result = dryRun
      ? { ok: true, level: "warning", message: `${message} — dry-run 이라 계속한다` }
      : { ok: false, level: "error", message };
  }
  log(`::${result.level}::${result.message}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
