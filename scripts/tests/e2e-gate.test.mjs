// #549 — 발행 전 e2e 관문. 같은 커밋의 성공 기록 있음 · 없음 · 다른 커밋의 성공만 있음 + dry-run 경고.
import assert from "node:assert/strict";
import test from "node:test";

import { decide, fetchRuns, main } from "../e2e-gate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const success = (head_sha) => ({ head_sha, status: "completed", conclusion: "success" });

test("같은 커밋에 성공한 e2e 실행이 있으면 실제 발행도 통과한다", () => {
  const result = decide({ runs: [success(OTHER), success(SHA)], sha: SHA, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.level, "notice");
});

test("성공 기록이 없으면 실제 발행은 멈추고 dry-run 은 경고만 낸다", () => {
  const real = decide({ runs: [], sha: SHA, dryRun: false });
  assert.equal(real.ok, false);
  assert.equal(real.level, "error");
  assert.match(real.message, /aaaaaaa/);
  const dry = decide({ runs: [], sha: SHA, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.level, "warning");
});

test("다른 커밋의 성공만 있거나 같은 커밋이 실패 · 진행 중이면 통과가 아니다", () => {
  for (const runs of [
    [success(OTHER)],
    [{ head_sha: SHA, status: "completed", conclusion: "failure" }],
    [{ head_sha: SHA, status: "in_progress", conclusion: null }],
  ]) {
    assert.equal(decide({ runs, sha: SHA, dryRun: false }).ok, false, JSON.stringify(runs));
  }
});

test("fetchRuns 는 e2e 워크플로의 그 커밋 성공 실행을 묻는다", async () => {
  let asked;
  const runs = await fetchRuns({
    repo: "owner/repo",
    sha: SHA,
    token: "t",
    fetchImpl: async (url, init) => {
      asked = { url, init };
      return { ok: true, json: async () => ({ workflow_runs: [success(SHA)] }) };
    },
  });
  assert.equal(runs.length, 1);
  assert.match(asked.url, /\/repos\/owner\/repo\/actions\/workflows\/e2e\.yml\/runs\?head_sha=a{40}&status=success/);
  assert.equal(asked.init.headers.Authorization, "Bearer t");
});

test("main: 기록을 읽지 못하면 실제 발행은 멈추고 dry-run 은 경고로 계속한다", async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const env = { GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: SHA, GITHUB_TOKEN: "t" };
  const lines = [];
  assert.equal(await main({ ...env, DRY_RUN: "false" }, { fetchImpl: failing, log: (l) => lines.push(l) }), 1);
  assert.match(lines.at(-1), /^::error::GitHub API 403/);
  assert.equal(await main({ ...env, DRY_RUN: "true" }, { fetchImpl: failing, log: (l) => lines.push(l) }), 0);
  assert.match(lines.at(-1), /^::warning::/);
  const ok = async () => ({ ok: true, json: async () => ({ workflow_runs: [success(SHA)] }) });
  assert.equal(await main({ ...env, DRY_RUN: "false" }, { fetchImpl: ok, log: (l) => lines.push(l) }), 0);
  assert.match(lines.at(-1), /^::notice::/);
});
