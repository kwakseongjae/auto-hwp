import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 077 (SDK i18n 메시지 주입 계약) e2e.
//
// 077 은 "전 UI 문자열을 koKR 카탈로그로 옮기고, 호스트가 messages 로 부분 override 한다" 는 변경이다.
// 따라서 라이브에서 확인해야 할 것은 두 가지다.
//
//   ① 회귀 0 — messages 를 주지 않은 기본 랩(= 현행 배포와 같은 호출)에서 업로드→편집→export chrome 이
//      종전 한국어 그대로다. 카탈로그 이관이 조용히 문구를 바꾸지 않았음을 실물 wasm 경로로 잠근다.
//   ② 주입 — enUS 부분 catalog 를 주면 같은 chrome 이 영어로 나온다.
//
// 여기 있는 것은 ① 뿐이다. ② 는 랩 셸이 `messages` 를 HwpWorkspace 로 넘겨야 성립하는데, 그 파일
// (apps/hwp-lab/src/components/LabWorkspace.tsx)은 이 배치에서 [embed] 스트림 소유라 건드리지 않았다.
// vitest 쪽에서는 컴포넌트 렌더 단위로 이미 잠겨 있다 —
// packages/react/src/__tests__/i18n.messages.test.tsx 의 "enUS 부분 catalog 주입 스모크".
// 배선이 들어오면 아래 test.fixme 를 실제 테스트로 바꾸면 된다(주석의 레시피 참고).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
}

test("기본(messages 미주입) chrome 은 종전 한국어 그대로 — 카탈로그 이관 회귀 0", async ({ page }) => {
  await open(page);

  // 열림 토스트는 4초 뒤 스스로 사라지므로 SVG 를 기다리기 **전에** 잡는다(늦게 보면 이미 없다).
  await expect(page.locator(".hw-status")).toContainText("열림:", { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // ── 업로드 직후: 문서 메타 ────────────────────────────────────────────────────────────────────
  await expect(page.locator(".hw-doc-meta")).toContainText("쪽");

  // ── 툴바: 실행취소/다시 실행/내보내기 3종 ────────────────────────────────────────────────────
  await expect(page.locator('button[title="실행취소"]')).toBeVisible();
  await expect(page.locator('button[title="다시 실행"]')).toBeVisible();
  await expect(page.locator('button[title="HTML 다운로드"]')).toBeVisible();
  await expect(page.locator('button[title^="HWPX 다운로드"]')).toBeVisible();
  await expect(page.locator('button[title="PDF 다운로드"]')).toBeVisible();

  // ── 편집 chrome: 표 추가 버튼 + 디자인 인스펙터(랩은 formatSurface="inspector") ─────────────
  await expect(page.locator('[data-testid="hw-table-insert"]')).toHaveText("표 추가");
  await expect(page.locator('[data-testid="hw-design-panel"]')).toContainText("선택한 요소가 없습니다");
  await expect(page.locator('[data-testid="hw-design-tab"]')).toHaveText("디자인");

  // ── 상태바 + 아웃라인 + 사이드 패널 ──────────────────────────────────────────────────────────
  await expect(page.locator('[data-testid="hw-statusbar-page"]')).toContainText("쪽");
  await expect(page.locator('[data-testid="hw-statusbar-mode"]')).toContainText("모드");
  await expect(page.locator(".hw-outline-title")).toHaveText("문서 구조");
  await expect(page.locator(".hw-chat-title")).toHaveText("✦ 바이브 편집");
});

// 배선 레시피(오케스트레이터/[embed] 몫): LabWorkspace 가 URL 의 `?lang=en` 을 읽어
//   const messages = useMemo(() => (lang === "en" ? EN_US : undefined), [lang]);
//   <HwpWorkspace … messages={messages} />
// 로 넘기면(EN_US 는 DeepPartial<WorkspaceMessages> 상수) 아래가 그대로 돈다.
test.fixme("enUS 부분 catalog 주입 시 같은 chrome 이 영어로 — 랩 셸 배선 대기", async ({ page }) => {
  await page.goto("/?lang=en");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-status")).toContainText("Opened:", { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  await expect(page.locator('button[title="Undo"]')).toBeVisible();
  await expect(page.locator('button[title="Download PDF"]')).toBeVisible();
  await expect(page.locator('[data-testid="hw-statusbar-page"]')).not.toContainText("쪽");
});
