import { expect, test } from "@playwright/test";

const REQUIRED_DOC_PATHS = ["/docs/llm", "/docs/embed", "/docs/mcp", "/docs/self-host"];
const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
];

function markdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map(
    (match) => match[1] ?? match[2],
  );
}

test("llms.txt가 에이전트를 실제 사이트 정본으로 보낸다", async ({ request }) => {
  const response = await request.get("/llms.txt");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/plain");

  const body = await response.text();
  expect(body).toContain("문서 엔진");
  expect(body).toMatch(/AI.*(?:프록시|중계)/);
  expect(body).not.toContain("저장소가 호스팅하는 공용 서버는 **없다**");

  const nonAbsolute = markdownTargets(body).filter((target) => !target.startsWith("https://"));
  expect(nonAbsolute).toEqual([]);
  for (const path of REQUIRED_DOC_PATHS) expect(body).toContain(`https://autohwp.com${path}`);
});

test("에이전트 정본·개인정보·검색 표면이 모두 200이다", async ({ request }) => {
  for (const path of ["/", "/docs", ...REQUIRED_DOC_PATHS, "/privacy", "/robots.txt", "/sitemap.xml"]) {
    const response = await request.get(path);
    expect(response.ok(), `${path} → ${response.status()}`).toBe(true);
  }
});

test("첫 공식 사이트가 문서·SVG·AI 경계용 보안 헤더를 낸다", async ({ request }) => {
  for (const path of ["/", "/docs", "/llms.txt"]) {
    const response = await request.get(path);
    const headers = response.headers();
    for (const name of REQUIRED_HEADERS) expect(headers[name], `${path}: ${name}`).toBeTruthy();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("frame-ancestors");
  }
});

test("문서 허브에서 에이전트 프롬프트를 발견하고 복사 완료를 확인한다", async ({ page }) => {
  await page.goto("/docs");
  const prompt = page.locator('[data-testid="agent-prompt"]');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("https://autohwp.com/llms.txt");
  await expect(prompt).toContainText("buildDocContext");

  await page.locator('[data-testid="agent-prompt-copy"]').click();
  await expect(page.getByText("복사됨", { exact: true })).toBeVisible();
});

test("푸터와 AI 개인정보 고지가 privacy 정본으로 연결된다", async ({ page }) => {
  await page.goto("/");
  const footerPrivacy = page.locator('footer a[href="/privacy"], footer a[href="/privacy/"]');
  await expect(footerPrivacy).toHaveCount(1);
  await footerPrivacy.click();
  await expect(page).toHaveURL(/\/privacy\/?$/);
  await expect(page.getByRole("heading", { name: /개인정보/ })).toBeVisible();
});

test("라이브 데모 AI는 지속형 전역·IP 비용 상한을 보고한다", async ({ request }) => {
  test.skip(!process.env.LAUNCH_BASE_URL, "배포된 RC에서만 durable rate limit을 판정한다");

  const response = await request.get("/api/hwp-edit");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    configured?: boolean;
    provider?: string;
    rate_limit?: {
      store?: string;
      durable?: boolean;
      store_configured?: boolean;
      daily_cap?: number;
      per_ip_cap?: number;
      configuration_valid?: boolean;
    };
  };

  expect(body.configured).toBe(true);
  expect(body.provider).toBe("demo");
  expect(body.rate_limit).toEqual({
    store: "upstash",
    durable: true,
    store_configured: true,
    daily_cap: 400,
    per_ip_cap: 20,
    configuration_valid: true,
  });
});
