import { expect, test, type Page } from "@playwright/test";
import { showVibePanel } from "./cell-gesture";

// 공개 데모 AI 전송 동의 e2e (사용자 결정 2026-07-30: **최초 1회만** 묻는다).
//
// 잠그는 계약:
//  ① 첫 AI 요청 전에 **인앱 모달**이 뜬다(네이티브 window.confirm 아님 — 페이지 DOM 안에 산다).
//     문구는 lib/demoAiConsent.ts 원문(전송 대상·중계 경로·되돌리기)을 그대로 싣는다.
//  ② 거부는 **아무 것도 기억하지 않는다** → 다음 요청에서 다시 묻는다("다시 보지 않음"이 아니다).
//     닫는 방법(버튼·Esc)과 무관하게 요청은 나가지 않고 채팅에 이유가 남는다.
//  ③ 동의는 localStorage("auto-hwp:demo-ai-consent")에 1회 기록되고, **새로고침 뒤에도** 다시 묻지 않는다.
//
// 데모 계약을 e2e 에서 켜는 법: `?demoAi=1`(LabWorkspace 의 QA 스위치). NEXT_PUBLIC_DEMO_AI 는 빌드
// 타임에 번들로 인라인되므로 이 스위치가 없으면 서버 전체를 데모 모드로 띄워야 하고, 그러면 다른 챗
// 스펙이 전부 이 모달에 걸린다. 서버(route.ts)는 키가 없어 mock 으로 답하므로 제안 카드까지 결정적이다.
const SAMPLE = "sample-8p.hwp";
const CONSENT_KEY = "auto-hwp:demo-ai-consent";
const PROMPT = "3x3 표를 삽입해줘";

const consentValue = (page: Page) => page.evaluate((k) => localStorage.getItem(k), CONSENT_KEY);

async function openSample(page: Page) {
  await page.goto("/?demoAi=1");
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

/** 채팅 전송. 보내기 버튼은 누르는 즉시 disabled 가 되고 모달이 그 위를 덮으므로, Playwright 의
 *  actionability 재시도가 "disabled 라 못 누른다"로 무한 루프에 빠진다(실측 flaky) — 먼저 앞 요청이
 *  끝났음을(enabled) 확인하고 나서 한 번만 디스패치한다. */
async function send(page: Page) {
  const button = page.locator(".hw-btn-send");
  await page.locator(".hw-textarea").fill(PROMPT);
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click({ force: true });
}

test("데모 AI 동의: 첫 요청에만 모달 · 거부하면 다시 묻고 · 동의는 새로고침 뒤에도 기억된다", async ({ page }) => {
  await openSample(page);
  expect(await consentValue(page), "동의 전에는 저장된 것이 없어야 한다").toBeNull();

  await showVibePanel(page);
  const dialog = page.locator('[data-testid="demo-ai-consent"]');

  // ── ① 첫 요청 → 인앱 모달(페이지 DOM). 문구는 원문 그대로. ──────────────────────────────────
  await send(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText("OpenRouter");
  await expect(dialog).toContainText("데모 서버(Vercel)를 거쳐"); // ?demoAi=1 = same-origin 라우트 경로
  await expect(dialog).toContainText("파일 원본 전체는 업로드하지 않습니다");
  await expect(dialog).toContainText("되돌릴 수 있습니다");
  // 기본기: 열리면 기본 버튼에 포커스가 잡힌다(키보드만으로 결정 가능).
  await expect(page.locator('[data-testid="demo-ai-consent-accept"]')).toBeFocused();

  // ── ② 거부(버튼) → 전송 없음 + 이유 표시 + 저장소 무변경 ────────────────────────────────────
  const errors = page.locator(".hw-msg-error");
  await page.locator('[data-testid="demo-ai-consent-decline"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(errors).toHaveCount(1, { timeout: 20_000 });
  await expect(errors.last()).toContainText("동의하지 않아");
  expect(await consentValue(page), "거부는 아무 것도 기록하지 않는다").toBeNull();

  // ── ③ 다시 요청 → 다시 묻는다. Esc 로 닫아도 거부(=역시 기록 없음 + 이유 표시). ────────────
  await send(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(errors).toHaveCount(2, { timeout: 20_000 });
  await expect(errors.last()).toContainText("동의하지 않아");
  expect(await consentValue(page)).toBeNull();

  // ── ④ 동의 → 요청이 실제로 나가 제안 카드가 뜨고, 동의가 1회 기록된다. ─────────────────────
  await send(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-testid="demo-ai-consent-accept"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".hw-card").first()).toBeVisible({ timeout: 30_000 });
  expect(await consentValue(page)).toBe("1");

  // ── ⑤ 새로고침(자동 재개) 후에도 묻지 않는다 — "최초 1회"의 본체. ─────────────────────────
  await page.reload();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  await showVibePanel(page);
  await send(page);
  await expect(page.locator(".hw-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveCount(0);
});
