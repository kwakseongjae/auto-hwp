import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLaunch,
  automatedLaunchChecks,
  createMemorySource,
  extractMarkdownLinks,
  preLiveLaunchChecks,
  summarizeChecks,
} from "../lib/launch-readiness.mjs";

function manifest(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    target: "open-source-launch",
    stage: "ready",
    stable_npm_version: "0.0.4",
    release_commit: "0123456789abcdef0123456789abcdef01234567",
    release: {
      kind: "open-source-launch",
      tag_candidate: "oss-launch-2026.08.12",
      npm_policy: "0.0.4 remains stable; package source changes stay Unreleased",
    },
    feature_scope: {
      hwp5_resave_v1: {
        decision: "excluded",
        artifact_presence: "experimental_guarded",
        public_support: "excluded",
        native_validation: "pending",
        evidence: "",
      },
    },
    manual_gates: {
      privacy_copy_owner_review: { status: "pass", evidence: "docs/launch/evidence/privacy.md" },
      github_security_settings: { status: "pass", evidence: "docs/launch/evidence/security.md" },
      dependency_security: { status: "pass", evidence: "docs/launch/evidence/dependencies.md" },
      branch_protection: { status: "pass", evidence: "docs/launch/evidence/branch.md" },
      durable_rate_limit: { status: "pass", evidence: "docs/launch/evidence/rate-limit.md" },
      fresh_consumer_smoke: { status: "pass", evidence: "docs/launch/evidence/consumer.md" },
      tag_and_github_release: { status: "pass", evidence: "https://github.com/example/release" },
      release_candidate_live_smoke: { status: "pass", evidence: "docs/launch/evidence/live.md" },
      launch_copy_owner_approval: { status: "pass", evidence: "docs/launch/evidence/copy.md" },
    },
    ...overrides,
  });
}

function passingFiles() {
  const pkg = (name) => JSON.stringify({
    name: `@auto-hwp/${name}`,
    version: "0.0.4",
    repository: "https://github.com/kwakseongjae/auto-hwp",
  });
  const aiSnippet = `
    AI 편집을 선택할 때만 OpenRouter로 보냅니다. 문서는 브라우저를 벗어나지 않습니다.
    AI 에이전트에게 연동 맡기기
    npm i @auto-hwp/react @auto-hwp/ai-protocol
    import { buildDocContext } from "@auto-hwp/ai-protocol";
    buildDocContext(ctx, anchors)
    headers: { "content-type": "application/json" }
    return (await res.json()).intents ?? [];
  `;
  return {
    "README.md": aiSnippet,
    "README.en.md": `Only when AI is selected, context goes to OpenRouter. Coding agent integration.
      npm i @auto-hwp/react @auto-hwp/ai-protocol
      import { buildDocContext } from "@auto-hwp/ai-protocol";
      buildDocContext(ctx, anchors); headers: { "content-type": "application/json" };
      return (await res.json()).intents ?? [];`,
    "llms.txt": `문서 엔진과 파일 처리는 로컬이다. AI 데모 프록시는 선택할 때만 쓴다.
      [README](README.md) [LLM](docs/LLM-GUIDE.md) 저장 포맷은 HWPX, .hwp 재저장 경로 없음.`,
    "apps/hwp-lab/public/llms.txt": `문서 엔진과 파일 처리는 로컬이다. AI 데모 프록시는 선택할 때만 쓴다.
      [LLM](https://autohwp.com/docs/llm) [Embed](https://autohwp.com/docs/embed)
      [MCP](https://autohwp.com/docs/mcp) [Self host](https://autohwp.com/docs/self-host)
      저장 포맷은 HWPX, .hwp 재저장 경로 없음.`,
    "docs/LLM-GUIDE.md": "buildDocContext validateRequest validateResponse",
    "docs/MCP-GUIDE.md": "MCP",
    "docs/EMBED-GUIDE.md": "npm stable 0.0.4",
    "docs/EMBED-GUIDE.en.md": "npm stable 0.0.4",
    "examples/vite-embed/README.md": "npm stable 0.0.4",
    "examples/ai-proxy-express/README.md": "npm stable 0.0.4",
    "packages/engine/README.md": "Coordinates = HWPUNIT / 75",
    "packages/react/README.md": "HwpWorkspace 0.0.4",
    "CONTRIBUTING.md": "EngineAdapter 34메서드",
    "Cargo.toml": 'repository = "https://github.com/kwakseongjae/auto-hwp"',
    "CHANGELOG.md": "## [0.0.4]",
    "packages/engine/package.json": pkg("engine"),
    "packages/editor-core/package.json": pkg("editor-core"),
    "packages/ai-protocol/package.json": pkg("ai-protocol"),
    "packages/react/package.json": pkg("react"),
    "SECURITY.md": "Supported Versions. Report privately with a GitHub security advisory.",
    "CODE_OF_CONDUCT.md": "Contributor Covenant",
    "SUPPORT.md": "Support boundaries",
    ".github/PULL_REQUEST_TEMPLATE.md": "Checklist\nCloses #123",
    ".github/CODEOWNERS": "* @kwakseongjae",
    ".github/ISSUE_TEMPLATE/bug_report.yml": "name: Bug",
    ".github/ISSUE_TEMPLATE/feature_request.yml": "name: Feature",
    ".github/workflows/ci.yml": "on:\n  pull_request:\n  workflow_dispatch:\njobs:\n  issue-link:\nuses: actions/checkout@v6",
    ".github/workflows/vercel-deploy.yml":
      "on:\n  workflow_dispatch:\nuses: actions/checkout@v6\nrun: vercel deploy --prebuilt",
    ".github/workflows/publish.yml": "uses: actions/checkout@v6",
    ".github/workflows/deploy-demo.yml": "uses: actions/checkout@v6",
    "apps/hwp-lab/vercel.json": JSON.stringify({ git: { deploymentEnabled: false } }),
    "apps/hwp-lab/next.config.mjs": `Content-Security-Policy X-Content-Type-Options Referrer-Policy
      Permissions-Policy frame-ancestors frame-src 'self' blob:`,
    "apps/hwp-lab/src/app/privacy/page.tsx": "Privacy. 전체 400회, Upstash 없이는 best-effort.",
    "apps/hwp-lab/src/app/api/hwp-edit/demo.ts":
      'const DEFAULT_DAILY_CAP = 400; `ah:demo:all:${day}`; canReachUpstash(); [["PING"]]; store_configured',
    "apps/hwp-lab/src/components/site/SiteFooter.tsx": 'href="/privacy"',
    "apps/hwp-lab/src/components/DemoAiConsentDialog.tsx": 'href="/privacy"',
    "apps/hwp-lab/src/app/docs/page.tsx": "AI 에이전트에게 연동 맡기기",
    "docs/launch/AGENT-PROMPT.md": "agent prompt",
    "docs/launch/CONTENT-BRIEF.md": "launch brief",
    "docs/launch/STATUS.json": manifest(),
    "docs/launch/evidence/privacy.md": "reviewed",
    "docs/launch/evidence/security.md": "enabled",
    "docs/launch/evidence/dependencies.md": "audited",
    "docs/launch/evidence/branch.md": "protected",
    "docs/launch/evidence/rate-limit.md": "durable",
    "docs/launch/evidence/consumer.md": "passed",
    "docs/launch/evidence/live.md": "passed",
    "docs/launch/evidence/copy.md": "approved",
  };
}

test("Markdown 링크에서 상대·절대 대상을 보존한다", () => {
  assert.deepEqual(
    extractMarkdownLinks("[a](docs/A.md) [b](<https://example.com/a b>) ![img](x.png)"),
    ["docs/A.md", "https://example.com/a b", "x.png"],
  );
});

test("완성된 출시 스냅샷은 모든 자동·수동 게이트를 통과한다", () => {
  const checks = auditLaunch(createMemorySource(passingFiles()));
  const summary = summarizeChecks(checks);
  assert.equal(summary.failed, 0, checks.filter((check) => check.status === "fail").map((check) => check.id).join(", "));
  assert.equal(summary.ready, true);
});

test("깨진 사이트 llms·복붙 예제·단위·CI·메타데이터를 각각 탐지한다", () => {
  const files = passingFiles();
  files["apps/hwp-lab/public/llms.txt"] = "[LLM](docs/LLM-GUIDE.md)";
  files["README.md"] = "문서는 브라우저를 벗어나지 않습니다. AI 편집을 선택할 때만 OpenRouter.";
  files["packages/engine/README.md"] = "Coordinates = HWPUNIT / 96";
  files["Cargo.toml"] = 'repository = "https://github.com/USER/auto-hwp"';
  files[".github/workflows/ci.yml"] = "on:\n  workflow_dispatch:";
  files["apps/hwp-lab/vercel.json"] = JSON.stringify({ git: { deploymentEnabled: { main: false } } });

  const failed = new Set(
    auditLaunch(createMemorySource(files))
      .filter((check) => check.status === "fail")
      .map((check) => check.id),
  );
  for (const id of [
    "agent.site-llms-absolute-links",
    "agent.site-task-router",
    "agent.readme-ai-contract-ko",
    "docs.geometry-unit",
    "release.repository-metadata",
    "community.pull-request-ci",
    "community.issue-first",
    "community.actions-node24",
    "release.prebuilt-deploy-only",
  ]) assert.equal(failed.has(id), true, id);
});

test("pending 수동 게이트와 HWP5 포함 결정은 증거 없이 통과하지 않는다", () => {
  const files = passingFiles();
  files["docs/launch/STATUS.json"] = manifest({
    stage: "preparation",
    feature_scope: {
      hwp5_resave_v1: { decision: "included", native_validation: "pending", evidence: "" },
    },
    manual_gates: {
      privacy_copy_owner_review: { status: "pending", evidence: "" },
    },
  });
  const failed = new Set(
    auditLaunch(createMemorySource(files))
      .filter((check) => check.status === "fail")
      .map((check) => check.id),
  );
  assert.equal(failed.has("release.status-ready"), true);
  assert.equal(failed.has("manual.privacy_copy_owner_review"), true);
  assert.equal(failed.has("scope.hwp5-resave-included-evidence"), true);
});

test("수동 게이트는 존재하지 않는 로컬 증거 경로만으로 통과하지 않는다", () => {
  const files = passingFiles();
  const status = JSON.parse(manifest());
  status.manual_gates.fresh_consumer_smoke.evidence = "docs/launch/evidence/missing.md";
  files["docs/launch/STATUS.json"] = JSON.stringify(status);
  const failed = new Set(
    auditLaunch(createMemorySource(files))
      .filter((check) => check.status === "fail")
      .map((check) => check.id),
  );
  assert.equal(failed.has("manual.fresh_consumer_smoke"), true);
});

test("PR 자동 게이트는 수동 출시 증거만 제외하고 정적 계약은 모두 유지한다", () => {
  const files = passingFiles();
  files["docs/launch/STATUS.json"] = manifest({
    stage: "preparation",
    release_commit: "",
    manual_gates: {},
  });
  const checks = automatedLaunchChecks(auditLaunch(createMemorySource(files)));
  const ids = new Set(checks.map((check) => check.id));
  assert.equal(ids.has("release.status-ready"), false);
  assert.equal(ids.has("release.status-commit"), false);
  assert.equal([...ids].some((id) => id.startsWith("manual.")), false);
  assert.equal(ids.has("agent.site-llms-absolute-links"), true);
  assert.equal(summarizeChecks(checks).ready, true);
});

test("pre-live 게이트는 라이브 smoke와 최종 ready만 제외한다", () => {
  const files = passingFiles();
  const status = JSON.parse(manifest());
  status.stage = "pre-live";
  status.manual_gates.release_candidate_live_smoke = { status: "pending", evidence: "" };
  files["docs/launch/STATUS.json"] = JSON.stringify(status);

  const checks = preLiveLaunchChecks(auditLaunch(createMemorySource(files)));
  const ids = new Set(checks.map((check) => check.id));
  assert.equal(ids.has("release.status-ready"), false);
  assert.equal(ids.has("manual.release_candidate_live_smoke"), false);
  assert.equal(ids.has("release.status-commit"), true);
  assert.equal(ids.has("manual.durable_rate_limit"), true);
  assert.equal(ids.has("manual.tag_and_github_release"), true);
  assert.equal(summarizeChecks(checks).ready, true);
});
