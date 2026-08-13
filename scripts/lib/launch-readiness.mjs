import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKAGE_FILES = [
  "packages/engine/package.json",
  "packages/editor-core/package.json",
  "packages/ai-protocol/package.json",
  "packages/react/package.json",
];

const PUBLIC_CONSUMER_DOCS = [
  "docs/EMBED-GUIDE.md",
  "docs/EMBED-GUIDE.en.md",
  "examples/vite-embed/README.md",
  "examples/ai-proxy-express/README.md",
  "packages/engine/README.md",
  "packages/react/README.md",
];

const REQUIRED_MANUAL_GATES = [
  "privacy_copy_owner_review",
  "github_security_settings",
  "dependency_security",
  "branch_protection",
  "durable_rate_limit",
  "fresh_consumer_smoke",
  "tag_and_github_release",
  "release_candidate_live_smoke",
  "launch_copy_owner_approval",
];

function normalizeRepoPath(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the original text. A malformed URI will fail the existence check below.
  }
  const withoutFragment = decoded.split("#", 1)[0].split("?", 1)[0];
  return path.posix.normalize(withoutFragment.replace(/^\.\//, ""));
}

export function extractMarkdownLinks(markdown) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) targets.push(match[1] ?? match[2]);
  return targets;
}

export function createFsSource(root) {
  const absoluteRoot = path.resolve(root);
  const resolve = (relative) => path.join(absoluteRoot, relative);
  return {
    read(relative) {
      try {
        return readFileSync(resolve(relative), "utf8");
      } catch {
        return null;
      }
    },
    exists(relative) {
      return existsSync(resolve(relative));
    },
  };
}

export function createMemorySource(files) {
  return {
    read(relative) {
      return Object.hasOwn(files, relative) ? files[relative] : null;
    },
    exists(relative) {
      if (Object.hasOwn(files, relative)) return true;
      const prefix = relative.endsWith("/") ? relative : `${relative}/`;
      return Object.keys(files).some((candidate) => candidate.startsWith(prefix));
    },
  };
}

function safeJson(source, relative) {
  const raw = source.read(relative);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isExternalLink(target) {
  return /^(?:https?:|mailto:|tel:)/i.test(target);
}

function hasAiBridgeContract(markdown) {
  return (
    /npm\s+i[^\n]*@auto-hwp\/ai-protocol/.test(markdown) &&
    /import\s*\{[^}]*buildDocContext[^}]*\}\s*from\s*["']@auto-hwp\/ai-protocol["']/.test(markdown) &&
    /buildDocContext\s*\(/.test(markdown) &&
    /["']content-type["']\s*:\s*["']application\/json["']/.test(markdown) &&
    /\.intents\s*\?\?\s*\[\]/.test(markdown)
  );
}

function firstExisting(source, candidates) {
  return candidates.find((candidate) => source.exists(candidate));
}

export function auditLaunch(source) {
  const checks = [];
  const read = (relative) => source.read(relative) ?? "";
  const add = (id, area, priority, ok, summary, remediation, detail = "") => {
    checks.push({ id, area, priority, status: ok ? "pass" : "fail", summary, remediation, detail });
  };

  const readmeKo = read("README.md");
  const readmeEn = read("README.en.md");
  const repoLlms = read("llms.txt");
  const siteLlms = read("apps/hwp-lab/public/llms.txt");

  add(
    "concept.local-first-disclosure",
    "concept",
    "P0",
    /(?:파일은|문서는) 브라우저를 벗어나지 않습니다/.test(readmeKo) &&
      /AI 편집을 선택할 때만/.test(readmeKo) &&
      /OpenRouter/.test(readmeKo) &&
      /only when|only if/i.test(readmeEn) &&
      /OpenRouter/.test(readmeEn),
    "로컬 우선과 선택적 AI 전송을 한국어·영어 README에서 함께 설명한다",
    "파일 처리와 AI 문맥 전송을 분리해 쓰고, AI 선택 시 전송되는 범위와 경유지를 명시한다.",
  );

  const blanketNoServer = /저장소가 호스팅하는 공용 서버는\s*\*\*없다\*\*/;
  add(
    "concept.llms-server-truth",
    "concept",
    "P0",
    !blanketNoServer.test(repoLlms) &&
      !blanketNoServer.test(siteLlms) &&
      /문서 엔진|파일 처리/.test(repoLlms) &&
      /AI.*프록시|AI.*중계/.test(repoLlms),
    "llms.txt가 로컬 문서 엔진과 선택적 데모 AI 프록시를 구분한다",
    "'공용 서버 없음'이라는 포괄 문구를 제거하고 문서 처리 서버 없음과 데모 AI 중계를 별도로 적는다.",
  );

  const repoRelativeLinks = extractMarkdownLinks(repoLlms)
    .filter((target) => !isExternalLink(target) && !target.startsWith("#"))
    .map(normalizeRepoPath);
  const missingRepoLinks = repoRelativeLinks.filter(
    (target) => !target || target.startsWith("../") || !source.exists(target),
  );
  add(
    "agent.repo-llms-links",
    "agent",
    "P0",
    repoRelativeLinks.length > 0 && missingRepoLinks.length === 0,
    "저장소 llms.txt의 상대 링크가 모두 실제 파일로 해소된다",
    "링크 대상을 복구하거나 현재 정본 경로로 바꾼다.",
    missingRepoLinks.join(", "),
  );

  const siteLinks = extractMarkdownLinks(siteLlms).filter((target) => !target.startsWith("#"));
  const nonAbsoluteSiteLinks = siteLinks.filter((target) => !/^https:\/\//i.test(target));
  add(
    "agent.site-llms-absolute-links",
    "agent",
    "P0",
    siteLinks.length > 0 && nonAbsoluteSiteLinks.length === 0,
    "사이트 llms.txt는 사이트·GitHub 절대 HTTPS 링크만 제공한다",
    "레포용 llms.txt를 그대로 복사하지 말고 문서 레지스트리에서 사이트용 절대 URL을 생성한다.",
    nonAbsoluteSiteLinks.join(", "),
  );

  const requiredAgentRoutes = [
    "https://autohwp.com/docs/llm",
    "https://autohwp.com/docs/embed",
    "https://autohwp.com/docs/mcp",
    "https://autohwp.com/docs/self-host",
  ];
  const missingAgentRoutes = requiredAgentRoutes.filter((route) => !siteLlms.includes(route));
  add(
    "agent.site-task-router",
    "agent",
    "P0",
    missingAgentRoutes.length === 0,
    "사이트 llms.txt가 LLM·임베드·MCP·셀프호스트 정본으로 직접 라우팅한다",
    "필수 사이트 문서 URL을 llms.txt 상단 과업 라우터에 추가한다.",
    missingAgentRoutes.join(", "),
  );

  const docsHub = read("apps/hwp-lab/src/app/docs/page.tsx");
  add(
    "agent.copyable-cta",
    "agent",
    "P0",
    /에이전트에게.*(?:맡기|연동)|AI 에이전트/i.test(readmeKo) &&
      /(?:coding|AI) agent/i.test(readmeEn) &&
      /에이전트에게.*(?:맡기|연동)|AI 에이전트/i.test(docsHub) &&
      source.exists("docs/launch/AGENT-PROMPT.md"),
    "README와 문서 허브가 동일한 복사용 에이전트 시작 프롬프트를 제공한다",
    "docs/launch/AGENT-PROMPT.md를 단일 원문으로 두고 README와 사이트에 복사 버튼을 배선한다.",
  );

  add(
    "agent.readme-ai-contract-ko",
    "agent",
    "P0",
    hasAiBridgeContract(readmeKo),
    "한국어 README의 AI 복붙 예제가 Intent[]·R5 펜스·JSON 헤더 계약을 지킨다",
    "ai-protocol을 직접 설치/import하고 LLM-GUIDE의 buildDocContext + content-type + response.intents 예제를 그대로 사용한다.",
  );
  add(
    "agent.readme-ai-contract-en",
    "agent",
    "P0",
    hasAiBridgeContract(readmeEn),
    "영어 README의 AI 복붙 예제가 한국어 정본과 같은 계약을 지킨다",
    "한국어 예제와 동일한 install·import·request·Intent[] unwrap을 유지한다.",
  );

  const engineReadme = read("packages/engine/README.md");
  add(
    "docs.geometry-unit",
    "docs",
    "P0",
    /HWPUNIT\s*\/\s*75/.test(engineReadme) && !/HWPUNIT\s*\/\s*96/.test(engineReadme),
    "공개 엔진 문서의 own-render 좌표 단위가 HWPUNIT/75다",
    "패키지 README를 units.ts와 AGENTS.md의 /75 계약에 맞춘다.",
  );

  const contributing = read("CONTRIBUTING.md");
  add(
    "docs.adapter-count",
    "docs",
    "P1",
    /EngineAdapter\s+34(?:개)?메서드/.test(contributing) && !/EngineAdapter\s+27(?:개)?메서드/.test(contributing),
    "기여 문서가 현재 EngineAdapter 34메서드 계약을 가리킨다",
    "고정 숫자를 갱신하고, 가능하면 adapter.ts에서 수를 검증하는 문서 테스트를 유지한다.",
  );

  const stalePatterns = [
    /\^0\.0\.2/g,
    /현재 레지스트리 실물은\s*`?0\.0\.2/g,
    /current registry build is\s*`?0\.0\.2/gi,
    /아직\s*\*\*0\.0\.2\s*기준/gi,
    /still\s+(?:on\s+)?\*\*?0\.0\.2/gi,
    /registry\s+@auto-hwp\/\*\s+\^0\.0\.2/gi,
  ];
  const staleDocs = [];
  for (const relative of PUBLIC_CONSUMER_DOCS) {
    const body = read(relative);
    if (stalePatterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(body))) staleDocs.push(relative);
  }
  add(
    "docs.consumer-version-truth",
    "docs",
    "P0",
    staleDocs.length === 0,
    "공개 소비자 문서에 0.0.2를 현재 버전처럼 안내하는 문구가 없다",
    "현재 stable 기준으로 설치·파일 수·CDN 설명을 다시 쓰고 역사 설명은 CHANGELOG로 옮긴다.",
    staleDocs.join(", "),
  );

  const packageJsons = PACKAGE_FILES.map((relative) => ({ relative, value: safeJson(source, relative) }));
  const packageVersions = packageJsons.map(({ value }) => value?.version).filter(Boolean);
  const stableVersion = packageVersions[0] ?? "";
  add(
    "release.package-lockstep",
    "release",
    "P0",
    packageVersions.length === PACKAGE_FILES.length && new Set(packageVersions).size === 1,
    "공개 npm 4패키지의 버전이 lockstep이다",
    "engine→editor-core→ai-protocol→react를 같은 버전으로 준비한다.",
    packageJsons.map(({ relative, value }) => `${relative}=${value?.version ?? "invalid"}`).join(", "),
  );

  const changelog = read("CHANGELOG.md");
  add(
    "release.changelog-current-version",
    "release",
    "P0",
    Boolean(stableVersion) && changelog.includes(`[${stableVersion}]`),
    "CHANGELOG에 현재 패키지 버전의 릴리스 절이 있다",
    "발행 버전의 사용자 가시 변경과 파괴 변경·마이그레이션을 기록한다.",
    stableVersion,
  );

  const cargoToml = read("Cargo.toml");
  add(
    "release.repository-metadata",
    "release",
    "P0",
    /repository\s*=\s*"https:\/\/github\.com\/kwakseongjae\/auto-hwp"/.test(cargoToml) &&
      !/github\.com\/USER\//.test(cargoToml),
    "Cargo 메타데이터가 실제 공개 저장소를 가리킨다",
    "workspace.package.repository의 USER 플레이스홀더를 실제 URL로 바꾼다.",
  );

  const securityPolicy = firstExisting(source, ["SECURITY.md", ".github/SECURITY.md"]);
  const securityPolicyBody = securityPolicy ? read(securityPolicy) : "";
  add(
    "trust.security-policy",
    "trust",
    "P0",
    Boolean(securityPolicy) && /지원.*버전|supported versions/i.test(securityPolicyBody) &&
      /비공개|private|security advisory/i.test(securityPolicyBody),
    "취약점 제보 절차를 공개한 SECURITY 정책이 있다",
    "지원 버전·비공개 제보 채널·응답 목표·공개 원칙을 SECURITY.md에 적는다.",
  );

  const conduct = firstExisting(source, ["CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md"]);
  const support = firstExisting(source, ["SUPPORT.md", ".github/SUPPORT.md"]);
  add(
    "community.conduct-support",
    "community",
    "P1",
    Boolean(conduct && support),
    "외부 기여자를 위한 행동강령과 지원 경계가 있다",
    "CODE_OF_CONDUCT.md와 SUPPORT.md를 추가해 이슈·토론·보안 제보의 경계를 나눈다.",
    `conduct=${conduct ?? "missing"}, support=${support ?? "missing"}`,
  );

  const pullTemplate = firstExisting(source, [
    ".github/PULL_REQUEST_TEMPLATE.md",
    "PULL_REQUEST_TEMPLATE.md",
    ".github/PULL_REQUEST_TEMPLATE/default.md",
  ]);
  const bugTemplate = firstExisting(source, [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/bug_report.md",
  ]);
  const featureTemplate = firstExisting(source, [
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/feature_request.md",
  ]);
  add(
    "community.templates",
    "community",
    "P1",
    Boolean(pullTemplate && bugTemplate && featureTemplate),
    "PR·버그·기능 요청 템플릿이 일반 외부 기여 흐름을 안내한다",
    "레이아웃 전용 템플릿과 별도로 일반 버그·기능 요청·PR 체크리스트를 추가한다.",
    `pr=${pullTemplate ?? "missing"}, bug=${bugTemplate ?? "missing"}, feature=${featureTemplate ?? "missing"}`,
  );

  const ci = read(".github/workflows/ci.yml");
  add(
    "community.pull-request-ci",
    "community",
    "P0",
    /^\s*pull_request\s*:/m.test(ci),
    "외부 pull request가 자동으로 제한된 CI 검증을 받는다",
    "workflow_dispatch를 유지하면서 pull_request에 fmt·clippy·test·문서 게이트의 bounded lane을 추가한다.",
  );
  const codeowners = read(".github/CODEOWNERS");
  const pullTemplateBody = pullTemplate ? read(pullTemplate) : "";
  add(
    "community.issue-first",
    "community",
    "P0",
    /\bissue-link\s*:/.test(ci) && /Closes\s+#/i.test(pullTemplateBody) && /@kwakseongjae/.test(codeowners),
    "모든 PR이 공개 이슈에서 시작하고 소유자에게 자동 라우팅된다",
    "CI issue-link check, PR 템플릿의 Closes #<issue>, CODEOWNERS를 유지한다.",
  );

  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/vercel-deploy.yml",
    ".github/workflows/publish.yml",
    ".github/workflows/deploy-demo.yml",
  ];
  const staleCheckoutWorkflows = workflowPaths.filter(
    (relative) => !/actions\/checkout@v6/.test(read(relative)),
  );
  add(
    "community.actions-node24",
    "community",
    "P1",
    staleCheckoutWorkflows.length === 0,
    "CI·배포·발행 workflow가 Node 24 기반 checkout action을 사용한다",
    "GitHub hosted runner와 맞는 actions/checkout@v6로 올려 Node 20 강제 전환 경고를 제거한다.",
    staleCheckoutWorkflows.join(", "),
  );

  const vercelConfig = safeJson(source, "apps/hwp-lab/vercel.json");
  const vercelDeployWorkflow = read(".github/workflows/vercel-deploy.yml");
  add(
    "release.prebuilt-deploy-only",
    "release",
    "P0",
    vercelConfig?.git?.deploymentEnabled === false &&
      /^\s*workflow_dispatch\s*:/m.test(vercelDeployWorkflow) &&
      /vercel\s+deploy\s+--prebuilt/.test(vercelDeployWorkflow),
    "Vercel 자동 Git 빌드를 끄고 Rust·wasm을 포함한 수동 prebuilt 배포만 허용한다",
    "apps/hwp-lab/vercel.json의 git.deploymentEnabled=false와 workflow_dispatch 기반 --prebuilt 배포를 유지한다.",
  );

  const securityConfig = [
    read("apps/hwp-lab/next.config.mjs"),
    read("apps/hwp-lab/src/middleware.ts"),
    read("vercel.json"),
  ].join("\n");
  const requiredHeaders = [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "frame-ancestors",
    "frame-src 'self' blob:",
  ];
  const missingHeaders = requiredHeaders.filter((header) => !securityConfig.includes(header));
  add(
    "trust.site-security-headers",
    "trust",
    "P0",
    missingHeaders.length === 0,
    "첫 공식 사이트가 CSP·nosniff·referrer·permissions·frame 정책을 제공한다",
    "Vercel 응답 헤더를 설정하고 wasm/jsDelivr/폰트/AI 경로만 허용하는 CSP를 e2e로 확인한다.",
    missingHeaders.join(", "),
  );

  const footer = read("apps/hwp-lab/src/components/site/SiteFooter.tsx");
  const consentDialog = read("apps/hwp-lab/src/components/DemoAiConsentDialog.tsx");
  add(
    "trust.privacy-surface",
    "trust",
    "P0",
    source.exists("apps/hwp-lab/src/app/privacy/page.tsx") &&
      /\/privacy/.test(footer) &&
      /\/privacy/.test(consentDialog),
    "개인정보 안내가 독립 페이지·푸터·AI 동의 순간에 연결된다",
    "전송 항목·처리자·보유/삭제·IP rate 데이터·철회·연락처를 설명하고 동의창에서 링크한다.",
  );

  const demoAi = read("apps/hwp-lab/src/app/api/hwp-edit/demo.ts");
  const privacyPage = read("apps/hwp-lab/src/app/privacy/page.tsx");
  add(
    "trust.demo-ai-cost-guard",
    "trust",
    "P0",
    /DEFAULT_DAILY_CAP\s*=\s*400/.test(demoAi) &&
      /ah:demo:all:/.test(demoAi) &&
      /canReachUpstash/.test(demoAi) &&
      /\["PING"\]/.test(demoAi) &&
      /store_configured/.test(demoAi) &&
      /400회/.test(privacyPage) &&
      /best-effort/.test(privacyPage),
    "공개 데모 AI가 실청구 기반 전체 캡과 durability 한계를 함께 공개한다",
    "실측 비용 기준 기본 400회 전역 캡을 항상 적용하고, Upstash 도달성을 probe하며, 미구성 시 인스턴스별 best-effort임을 개인정보 안내에 적는다.",
  );

  add(
    "content.launch-brief",
    "content",
    "P1",
    source.exists("docs/launch/CONTENT-BRIEF.md"),
    "런칭 게시물의 메시지 순서·허용 주장·금지 주장이 정본화돼 있다",
    "로컬 코어→에이전트 연동→공개 벤치→정직한 한계 순서의 콘텐츠 브리프를 둔다.",
  );

  const status = safeJson(source, "docs/launch/STATUS.json");
  add(
    "release.status-manifest",
    "release",
    "P0",
    status?.schema_version === 1 && status?.target === "open-source-launch",
    "기계 판독 가능한 런칭 상태 파일이 있다",
    "docs/launch/STATUS.json을 스키마 1로 유지한다.",
  );
  add(
    "release.status-ready",
    "release",
    "P0",
    status?.stage === "ready",
    "런칭 상태가 명시적으로 ready다",
    "자동·수동 게이트가 모두 닫힌 뒤에만 stage를 ready로 바꾼다.",
    status?.stage ?? "missing",
  );
  add(
    "release.status-version",
    "release",
    "P0",
    Boolean(stableVersion) && status?.stable_npm_version === stableVersion,
    "상태 파일의 stable npm 버전이 패키지 4종과 같다",
    "릴리스 후보 버전 변경 시 STATUS.json과 4패키지를 함께 갱신한다.",
    `status=${status?.stable_npm_version ?? "missing"}, packages=${stableVersion || "invalid"}`,
  );

  add(
    "release.channel-truth",
    "release",
    "P0",
    status?.release?.kind === "open-source-launch" &&
      /^oss-launch-/.test(status?.release?.tag_candidate ?? "") &&
      status?.release?.npm_policy?.includes(status?.stable_npm_version ?? "__missing__") &&
      /Unreleased/.test(status?.release?.npm_policy ?? ""),
    "오픈소스 런칭 태그와 npm stable/Unreleased 채널을 분리해 고정한다",
    "STATUS.release에 oss-launch 태그 후보와 검증된 npm stable 유지·Unreleased 차이 정책을 기록한다.",
  );

  add(
    "release.status-commit",
    "release",
    "P0",
    typeof status?.release_commit === "string" && /^[0-9a-f]{7,40}$/i.test(status.release_commit),
    "상태 파일이 실제 릴리스 후보 커밋을 고정한다",
    "npm·tag·GitHub Release·사이트가 가리키는 동일 커밋 SHA를 기록한다.",
    status?.release_commit || "missing",
  );

  const manualGates = status?.manual_gates && typeof status.manual_gates === "object" ? status.manual_gates : {};
  for (const name of REQUIRED_MANUAL_GATES) {
    const gate = manualGates[name];
    const evidence = typeof gate?.evidence === "string" ? gate.evidence.trim() : "";
    const evidenceExists = /^https:\/\//i.test(evidence) || (evidence.length > 0 && source.exists(normalizeRepoPath(evidence)));
    const passed = gate?.status === "pass" && evidenceExists;
    add(
      `manual.${name}`,
      "manual",
      "P0",
      passed,
      `${name} 수동 게이트에 통과 증거가 있다`,
      "검증을 수행한 뒤 status=pass와 재현 가능한 evidence 경로/URL을 기록한다.",
      `status=${gate?.status ?? "missing"}, evidence=${gate?.evidence || "missing"}`,
    );
  }

  const hwp5 = status?.feature_scope?.hwp5_resave_v1;
  const hwp5Decision = hwp5?.decision;
  const hwp5DecisionValid = hwp5Decision === "included" || hwp5Decision === "excluded";
  add(
    "scope.hwp5-resave-decision",
    "scope",
    "P0",
    hwp5DecisionValid,
    "HWP5 재저장 v1의 런칭 포함/제외가 명시돼 있다",
    "한컴 실물 검증 전에는 excluded, 통과 증거와 문서 동기화 후에만 included로 확정한다.",
    hwp5Decision ?? "missing",
  );
  if (hwp5Decision === "included") {
    const publicHwpDocs = [read("docs/MCP-GUIDE.md"), repoLlms, siteLlms].join("\n");
    add(
      "scope.hwp5-resave-included-evidence",
      "scope",
      "P0",
      hwp5?.native_validation === "pass" &&
        typeof hwp5?.evidence === "string" &&
        hwp5.evidence.trim().length > 0 &&
        /hwp_export_capability/.test(publicHwpDocs) &&
        /export_hwp/.test(publicHwpDocs),
      "HWP5 재저장을 포함할 때 실물 증거와 capability-first 공개 문서가 함께 있다",
      "한컴/한컴독스 수동 수용 후 capability·안전 부분집합·구조 편집 거부를 MCP/llms 문서에 동기화한다.",
    );
  } else if (hwp5Decision === "excluded") {
    add(
      "scope.hwp5-resave-excluded-truth",
      "scope",
      "P0",
      hwp5?.artifact_presence === "experimental_guarded" &&
        hwp5?.public_support === "excluded" &&
        /재저장 경로 없음|재저장.*없/.test([readmeKo, repoLlms, siteLlms].join("\n")),
      "HWP5 재저장 실험 코드는 존재와 공개 지원 제외를 구분하고 문서가 지원한다고 주장하지 않는다",
      "STATUS에 experimental_guarded/public_support=excluded를 유지하고 README와 llms.txt에 현재 한계를 적는다.",
    );
  }

  return checks;
}

export function summarizeChecks(checks) {
  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.length - passed;
  const blockingP0 = checks.filter((check) => check.status === "fail" && check.priority === "P0").length;
  return { total: checks.length, passed, failed, blockingP0, ready: failed === 0 };
}

/** PR에서 재현 가능한 정적 계약만 고른다. 소유자 승인·GitHub 설정·태그/배포 증거는 RC 게이트에 남긴다. */
export function automatedLaunchChecks(checks) {
  const releaseEvidenceOnly = new Set(["release.status-ready", "release.status-commit"]);
  return checks.filter((check) => check.area !== "manual" && !releaseEvidenceOnly.has(check.id));
}

/**
 * 라이브 smoke를 시작하기 직전의 게이트. 라이브 smoke 자체와 그 결과로만 닫을 수 있는 최종
 * `stage=ready`만 제외한다. 나머지 승인·보안·durable rate limit·fresh consumer·tag/release·
 * 릴리스 커밋은 모두 먼저 고정돼야 하므로 이 집합에서 빠지지 않는다.
 */
export function preLiveLaunchChecks(checks) {
  const afterLiveOnly = new Set([
    "release.status-ready",
    "manual.release_candidate_live_smoke",
  ]);
  return checks.filter((check) => !afterLiveOnly.has(check.id));
}

export function renderTextReport(checks) {
  const summary = summarizeChecks(checks);
  const lines = [
    `auto-hwp launch readiness: ${summary.passed}/${summary.total} pass · ${summary.failed} fail · P0 ${summary.blockingP0}`,
  ];
  for (const check of checks) {
    const icon = check.status === "pass" ? "PASS" : "FAIL";
    lines.push(`${icon} [${check.priority}] ${check.id} — ${check.summary}`);
    if (check.status === "fail") {
      lines.push(`     → ${check.remediation}`);
      if (check.detail) lines.push(`     · ${check.detail}`);
    }
  }
  return lines.join("\n");
}
