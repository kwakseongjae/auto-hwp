import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { selectFirstCell } from "./cell-gesture";

// 이슈 027 편집 패리티 e2e: 열너비 드래그 · 표 추가 · 텍스트 수정 · 볼드+배경. 데모 픽스처는
// benchmarks/benchmark.hwp(8쪽, 다열 표 포함). enableEditing 이 켜진 lab 에서 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 첫 페이지를 격자 스캔해 조건이 만족되는 클릭 지점을 찾는다(헤드리스에서 정확한 셀 좌표를 몰라도
// 됨). `predicate` 가 true 를 반환하는 첫 지점을 돌려준다.
async function scan(page: Page, predicate: () => Promise<boolean>): Promise<{ x: number; y: number } | null> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const pos = { x: box.width * rx, y: box.height * ry };
      await sheet.click({ position: pos });
      if (await predicate()) return pos;
    }
  }
  return null;
}

const scanForClick = (page: Page, testid: string) => scan(page, async () => (await page.locator(testid).count()) > 0);

// 표 셀 앵커("N행 M열")가 뜨는 지점을 찾아 그 셀을 드릴(선택)한다 — 텍스트/서식은 셀을 대상으로 한다.
// 06x Figma 드릴: 단일 클릭은 표 '전체'를 마킹하므로, 셀을 고르려면 그 지점을 더블클릭해 드릴 인한다.
// 표 위 지점을 단일 클릭으로 찾고(.hw-mark-table) → Escape 로 초기화 → 깨끗한 더블클릭(raw 좌표 → 행
// 그립 가로채기 우회)으로 셀을 캐럿 없이 선택한다. 선택된 셀의 클릭 좌표를 돌려준다(에디터 진입용).
async function scanForCell(page: Page): Promise<{ cx: number; cy: number } | null> {
  return selectFirstCell(page);
}

test("표 추가: 툴바 버튼 → 2×3 픽커 → ApplyContent 로 표 삽입 → undo", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="hw-table-insert"]').click();
  await expect(page.locator('[data-testid="hw-table-picker"]')).toBeVisible();
  await page.locator('[data-testid="hw-table-cell-2-3"]').hover();
  await expect(page.locator('[data-testid="hw-table-picker-label"]')).toContainText("2 × 3");
  await page.locator('[data-testid="hw-table-cell-2-3"]').click();
  // 적용 토스트(문서 끝에 표 추가) — 편집이 op-bus 로 커밋됐다는 신호.
  await expect(page.locator(".hw-status")).toContainText("표를 문서 끝에 추가", { timeout: 30_000 });
  // undo 1회 복구.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("열너비 드래그: 표 선택 → 핸들 드래그 → 경계가 실제로 오른쪽으로 이동 (issue 031 시각 assert)", async ({ page }) => {
  await open(page);
  // 다열 표를 찾을 때까지 스캔(열 경계 핸들 hw-col-grip-1 이 뜨는 지점).
  const found = await scanForClick(page, '[data-testid="hw-col-grip-1"]');
  expect(found, "다열 표를 찾아 열 경계 핸들이 떠야 한다").toBeTruthy();
  const gripSel = '[data-testid="hw-col-grip-1"]';
  const gb = await page.locator(gripSel).first().boundingBox();
  if (!gb) throw new Error("열 경계 핸들 박스를 찾지 못함");
  const xBefore = gb.x + gb.width / 2;
  // 잡는 y 는 핸들의 **위쪽**(top+24px). 세로 중앙을 쓰면 안 되는 이유(⚠️ 이슈 074 회귀에서 배움):
  // 핸들은 표 전체 높이를 덮으므로 긴 표에서는 중앙이 뷰포트 아래 상태바(.hw-statusbar) 뒤로 들어가
  // 마우스다운이 상태바에 먹힌다(실측: elementFromPoint(중앙) = DIV.hw-statusbar → 드래그가 아예
  // 시작되지 않아 토스트도 안 뜬다). 074 에서 본문 상자 원점이 `위 여백` → `위 여백 + 머리말 여백`
  // 으로 바로잡히며(한컴 규칙 = rhwp `PageAreas::from_page_def_for_page`) 내용이 34px 내려간 것이
  // 방아쇠였을 뿐, 원래도 표가 조금만 길면 깨지는 취약점이었다. 사람은 보이는 부분을 잡는다.
  const yGrip = gb.y + Math.min(24, gb.height / 2);
  // 핸들을 오른쪽으로 48px 드래그(프리뷰 → 놓으면 비율 적용).
  await page.mouse.move(xBefore, yGrip);
  await page.mouse.down();
  await page.mouse.move(xBefore + 48, yGrip, { steps: 8 });
  await page.mouse.up();
  // 성공 토스트(apply-verify 통과 — 무반영이면 에러 토스트가 뜬다).
  await expect(page.locator(".hw-status")).toContainText("열 너비를 변경했습니다", { timeout: 30_000 });
  // ★ 시각 이동 assert(031): 커밋 후 재조회된 핸들이 실제로 +15px 이상 오른쪽으로 이동했는지 확인.
  //   (intent 발사만 확인하던 기존 방식은 무반영 버그를 통과시켰다.)
  await expect
    .poll(async () => {
      const b = await page.locator(gripSel).first().boundingBox();
      return b ? b.x + b.width / 2 : -1;
    }, { timeout: 30_000 })
    .toBeGreaterThan(xBefore + 15);
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("행높이 드래그: 표 선택 → 행 핸들 드래그 → 행 경계가 실제로 아래로 성장 (issue 031)", async ({ page }) => {
  await open(page);
  // 행 경계 핸들 hw-row-grip-1 이 뜨는 다행 표를 찾는다.
  const found = await scanForClick(page, '[data-testid="hw-row-grip-1"]');
  expect(found, "다행 표를 찾아 행 경계 핸들이 떠야 한다").toBeTruthy();
  const gripSel = '[data-testid="hw-row-grip-1"]';
  const gb = await page.locator(gripSel).first().boundingBox();
  if (!gb) throw new Error("행 경계 핸들 박스를 찾지 못함");
  const yBefore = gb.y + gb.height / 2;
  // 핸들을 아래로 48px 드래그 → 위 행이 커진다.
  await page.mouse.move(gb.x + gb.width / 2, yBefore);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2, yBefore + 48, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".hw-status")).toContainText("행 높이를 변경했습니다", { timeout: 30_000 });
  // ★ 시각 성장 assert(031): 커밋 후 재조회된 행 핸들이 아래로 이동(행이 커짐)했는지 확인. 아래 행이
  //   최소높이 밑으로 줄지 못하므로 위 행 성장폭은 클램프로 제한된다 — 무반영(0px) 버그와는 확실히
  //   구별되는 양(+4px 이상)이면 충분하다(주 신호는 apply-verify 성공 토스트: 무반영이면 에러 토스트).
  await expect
    .poll(async () => {
      const b = await page.locator(gripSel).first().boundingBox();
      return b ? b.y + b.height / 2 : -1;
    }, { timeout: 30_000 })
    .toBeGreaterThan(yBefore + 4);
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

// 이슈 06x: 드래그로 셀을 선택 → 컴팩트 "✨ AI에게 전달" pill 이 선택 bbox 인접에 뜬다(거리 assert) →
// 리본 B 적용 → pill 클릭이 채팅 포커스 + 앵커 칩을 확정한다(신규 프롬프트 로직 0). 서식은 리본, AI 전달은 pill.
test("드래그 선택 → AI에게 전달 pill 인접 표시 → 리본 B → AI 전달 → 칩 확정", async ({ page }) => {
  await open(page);
  // 표 셀 앵커가 뜨는 지점을 찾아 그 셀을 선택 상태로 만든다.
  const found = await scanForCell(page);
  expect(found, "표 셀을 선택해야 AI 전달 pill 이 뜬다").toBeTruthy();
  if ((await page.locator(".hw-caret").count()) > 0) {
    await page.keyboard.press("Escape"); // 캐럿만 해제해 선택 액션을 다시 표시
  }
  const mark = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!mark) throw new Error("셀 마킹 박스를 찾지 못함");
  // 셀 안에서 작은 드래그(마퀴 아님) — 선택은 그 셀로 유지되고, 놓으면 pill 이 등장한다.
  await page.mouse.move(mark.x + mark.width * 0.3, mark.y + mark.height / 2);
  await page.mouse.down();
  await page.mouse.move(mark.x + mark.width * 0.6, mark.y + mark.height / 2, { steps: 4 });
  await page.mouse.up();

  const pill = page.locator('[data-testid="hw-ai-send"]');
  await expect(pill).toBeVisible({ timeout: 30_000 });
  // 인접 표시(거리 assert): pill 이 선택 bbox 바로 아래에 붙는다(bottom-right 앵커).
  const pb = await pill.boundingBox();
  const m2 = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!pb || !m2) throw new Error("pill/마킹 박스를 찾지 못함");
  const gap = Math.abs(pb.y - (m2.y + m2.height));
  expect(gap, "pill 이 선택 bbox 아래에 인접해야 한다").toBeLessThan(60);

  // 우측 디자인 B 적용(SetCellRangeFmt) — 선택은 유지된다.
  await page.locator('[data-testid="hw-design-bold"]').click();
  await expect(page.locator(".hw-status")).toContainText("굵게", { timeout: 30_000 });

  // "AI에게 전달" pill → 채팅 입력 포커스 + 앵커 칩 유지(칩 확정, 기존 흐름 재사용).
  await page.locator('[data-testid="hw-ai-send"]').click();
  await expect(page.locator(".hw-textarea")).toBeFocused({ timeout: 15_000 });
  await expect(page.locator(".hw-anchor").first()).toContainText("행");
});
