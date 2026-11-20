// #549 — 발행 전 e2e 관문. 같은 커밋의 성공 기록 있음 · 없음 · 다른 커밋의 성공만 있음 + dry-run 판정 · 배선.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decide, fetchRuns, isDryRun, main } from "../e2e-gate.mjs";

const REPO = "owner/repo";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const success = (head_sha, extra = {}) => ({
  head_sha,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  html_url: `https://github.com/${REPO}/actions/runs/1`,
  run_attempt: 1,
  head_repository: { full_name: REPO },
  ...extra,
});

test("같은 커밋에 성공한 e2e 실행이 있으면 실제 발행도 통과하고, 근거 실행 주소 · 시도 횟수를 남긴다", () => {
  const result = decide({ runs: [success(OTHER), success(SHA)], sha: SHA, dryRun: false, repo: REPO });
  assert.equal(result.ok, true);
  assert.equal(result.level, "notice");
  assert.match(result.message, /actions\/runs\/1/);
  assert.match(result.message, /시도 1번째/);
  const rerun = decide({ runs: [success(SHA, { run_attempt: 2 })], sha: SHA, dryRun: false, repo: REPO });
  assert.match(rerun.message, /시도 2번째\(재실행으로 받은 초록\)/);
});

test("성공 기록이 없으면 실제 발행은 멈추고 dry-run 은 경고만 낸다", () => {
  const real = decide({ runs: [], sha: SHA, dryRun: false, repo: REPO });
  assert.equal(real.ok, false);
  assert.equal(real.level, "error");
  assert.match(real.message, /aaaaaaa/);
  const dry = decide({ runs: [], sha: SHA, dryRun: true, repo: REPO });
  assert.equal(dry.ok, true);
  assert.equal(dry.level, "warning");
});

test("다른 커밋의 성공만 · 실패 · 진행 중 · 수동 실행이 아님 · 다른 저장소의 실행은 통과가 아니다", () => {
  for (const runs of [
    [success(OTHER)],
    [success(SHA, { conclusion: "failure" })],
    [success(SHA, { status: "in_progress", conclusion: null })],
    [success(SHA, { event: "pull_request" })],
    [success(SHA, { head_repository: { full_name: "fork/repo" } })],
  ]) {
    assert.equal(decide({ runs, sha: SHA, dryRun: false, repo: REPO }).ok, false, JSON.stringify(runs));
  }
});

test("dry-run 은 발행 단계와 같게 정확히 \"true\" 일 때만이다", () => {
  assert.equal(isDryRun("true"), true);
  for (const value of [undefined, "", "false", "False", "TRUE", "1", "yes"]) {
    assert.equal(isDryRun(value), false, String(value));
  }
});

test("fetchRuns 는 e2e 워크플로의 그 커밋 · 수동 실행 · 성공 실행을 묻는다", async () => {
  let asked;
  const runs = await fetchRuns({
    repo: REPO,
    sha: SHA,
    token: "t",
    fetchImpl: async (url, init) => {
      asked = { url, init };
      return { ok: true, json: async () => ({ workflow_runs: [success(SHA)] }) };
    },
  });
  assert.equal(runs.length, 1);
  assert.match(
    asked.url,
    /\/repos\/owner\/repo\/actions\/workflows\/e2e\.yml\/runs\?head_sha=a{40}&status=success&event=workflow_dispatch/,
  );
  assert.equal(asked.init.headers.Authorization, "Bearer t");
});

test("main: 기록을 읽지 못하면 실제 발행은 멈추고 dry-run 은 경고로 계속한다", async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GITHUB_TOKEN: "t" };
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await main({ ...env, DRY_RUN: "false" }, { fetchImpl: failing, log }), 1);
  assert.match(lines.at(-1), /^::error::GitHub API 403/);
  assert.equal(await main({ ...env, DRY_RUN: "true" }, { fetchImpl: failing, log }), 0);
  assert.match(lines.at(-1), /^::warning::/);
  const ok = async () => ({ ok: true, json: async () => ({ workflow_runs: [success(SHA)] }) });
  assert.equal(await main({ ...env, DRY_RUN: "false" }, { fetchImpl: ok, log }), 0);
  assert.match(lines.at(-1), /^::notice::/);
});

test("main: DRY_RUN 이 비었거나 \"False\" 면 실제 발행으로 보고, 성공 기록이 없으면 막는다", async () => {
  const none = async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) });
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GITHUB_TOKEN: "t" };
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await main({ ...env }, { fetchImpl: none, log }), 1, "미설정");
  assert.match(lines.at(-1), /^::error::/);
  assert.equal(await main({ ...env, DRY_RUN: "False" }, { fetchImpl: none, log }), 1, "False");
  assert.match(lines.at(-1), /^::error::/);
});

test("publish.yml 배선: 관문 단계가 인증 · 빌드보다 먼저이고, 실행 기록을 읽을 권한이 있다", () => {
  const yml = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
  const gate = yml.indexOf("run: node scripts/e2e-gate.mjs");
  assert.ok(gate > 0, "관문 단계");
  for (const later of ["actions/setup-node@", "verify npm trusted publishing", "dtolnay/rust-toolchain@", 'npm publish "${PUBLISH_ARGS[@]}"']) {
    const at = yml.indexOf(later);
    assert.ok(at > gate, `${later} 는 관문 뒤`);
  }
  assert.match(yml, /^\s+actions: read\b/m);
  assert.match(yml, /DRY_RUN: \$\{\{ inputs\.dry_run \}\}/, "관문과 발행 단계가 같은 DRY_RUN 을 읽는다");
});
