import { expect, type Page } from "@playwright/test";

type CellPoint = { cx: number; cy: number };

const anchorLabel = async (page: Page): Promise<string> => {
  const anchor = page.locator(".hw-anchor").first();
  return (await anchor.count()) > 0 ? (await anchor.innerText()).trim() : "";
};

/** 선택 시 자동으로 열린 디자인 inspector에서 사용자가 챗을 계속하려는 동작을 재현한다. */
export async function showVibePanel(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "✦ 바이브 편집", exact: true });
  const textarea = page.locator(".hw-textarea");
  await expect
    .poll(
      async () => {
        if (!(await textarea.isVisible())) await tab.click();
        return textarea.isVisible();
      },
      { timeout: 15_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
}

/**
 * 첫 페이지의 표를 찾아 표 선택 → 셀 드릴을 실제 pointer-up 순서대로 settle한다.
 *
 * selection/tableAt/imageAt은 worker를 거치는 비동기 경로다. 같은 좌표에 settle 없이 클릭을
 * 몰아치면 최신-gesture 정책이 앞 pointer-up을 정상적으로 폐기하므로, E2E도 사용자 입력처럼
 * 표 선택을 확인한 다음 double-click을 보낸다.
 */
export async function selectFirstCell(page: Page, requireMultiColumn = false): Promise<CellPoint> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");

  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const cx = box.x + box.width * rx;
      const cy = box.y + box.height * ry;
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(150);

      const label = await anchorLabel(page);
      if (label.includes("행")) {
        if (!requireMultiColumn || (await page.locator('[data-testid="hw-col-grip-1"]').count()) > 0) {
          const mark = await page.locator(".hw-mark-cell").first().boundingBox();
          return mark ? { cx: mark.x + mark.width / 2, cy: mark.y + mark.height / 2 } : { cx, cy };
        }
        continue;
      }
      if (!label.includes("표")) continue;
      if (requireMultiColumn && (await page.locator('[data-testid="hw-col-grip-1"]').count()) === 0) continue;

      // 표 전체 선택의 worker 결과가 currentCell snapshot에 반영된 뒤 double-click으로 셀을 드릴한다.
      await page.waitForTimeout(500);
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(100);
      await page.mouse.click(cx, cy);
      try {
        await expect.poll(() => anchorLabel(page), { timeout: 4_000, intervals: [25, 50, 100] }).toContain("행");
      } catch {
        continue;
      }
      if (requireMultiColumn && (await page.locator('[data-testid="hw-col-grip-1"]').count()) === 0) continue;
      const mark = await page.locator(".hw-mark-cell").first().boundingBox();
      if (mark) return { cx: mark.x + mark.width / 2, cy: mark.y + mark.height / 2 };
    }
  }
  throw new Error("표 셀을 드릴하지 못함 (스캔 실패)");
}

/** 셀을 드릴한 뒤 그 셀의 텍스트 밴드를 훑어 주소형 캐럿을 세운다. */
export async function placeCellCaret(page: Page): Promise<void> {
  await selectFirstCell(page);
  const mark = page.locator(".hw-mark-cell").first();
  const box = await mark.boundingBox();
  if (!box) throw new Error("드릴된 셀 마킹 박스를 찾지 못함");

  for (let ry = 0.08; ry <= 0.92; ry += 0.12) {
    for (let rx = 0.05; rx <= 0.95; rx += 0.15) {
      await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
      await page.waitForTimeout(200);
      if ((await page.locator(".hw-caret").count()) > 0) return;
    }
  }
  throw new Error("셀 텍스트 캐럿을 세우지 못함 (스캔 실패)");
}
