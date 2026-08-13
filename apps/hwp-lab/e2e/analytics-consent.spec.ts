import { expect, test } from "@playwright/test";

test.skip(process.env.PW_ANALYTICS !== "1", "run with PW_ANALYTICS=1 so the dedicated test stream is compiled in");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("auto-hwp:analytics-e2e-initialized") === "1") return;
    localStorage.removeItem("auto-hwp:analytics-consent:v1");
    sessionStorage.setItem("auto-hwp:analytics-e2e-initialized", "1");
  });
  await page.route("https://www.googletagmanager.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
});

test("미동의·거부에는 GA 요청이 없고 허용 뒤에만 익명 bucket 이벤트를 보낸다", async ({ page }) => {
  const googleRequests: string[] = [];
  page.on("request", (request) => {
    if (/google(tagmanager|-analytics)|google-analytics/.test(request.url())) googleRequests.push(request.url());
  });

  await page.goto("/");
  const consent = page.getByTestId("analytics-consent");
  await expect(consent).toBeVisible();
  expect(googleRequests).toEqual([]);

  await consent.getByRole("button", { name: "거부" }).click();
  await page.reload();
  await expect(consent).toHaveCount(0);
  expect(googleRequests).toEqual([]);

  await page.evaluate(() => localStorage.removeItem("auto-hwp:analytics-consent:v1"));
  await page.reload();
  await consent.getByRole("button", { name: "익명 분석 허용" }).click();
  await expect.poll(() => googleRequests.some((url) => url.includes("googletagmanager.com/gtag/js?id=G-TEST123"))).toBe(true);

  await page.getByTestId("sample-sample-8p.hwp").click();
  await expect(page.locator(".hw-sheet")).toHaveCount(8);
  const events = await page.evaluate(() =>
    (window.dataLayer ?? [])
      .map((args) => Array.from(args as ArrayLike<unknown>))
      .filter((args) => args[0] === "event"),
  );
  expect(events).toContainEqual([
    "event",
    "ws_document_open",
    { file_type: "hwp", source: "sample", result: "success", page_count_bucket: "6-10" },
  ]);
  expect(JSON.stringify(events)).not.toContain("sample-8p.hwp");
});

test("개인정보 화면에서 선택을 초기화하면 즉시 GA를 disable한다", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("analytics-consent").getByRole("button", { name: "익명 분석 허용" }).click();
  await page.goto("/privacy");
  await page.getByRole("button", { name: "선택 초기화" }).click();
  await expect(page.getByTestId("analytics-consent")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"]))
    .toBe(true);
});
