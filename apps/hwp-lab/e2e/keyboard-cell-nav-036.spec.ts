import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 036 키보드 셀 네비게이션 e2e: 셀 클릭 → 방향키로 인접 셀 선택 이동(경계·병합 클램프) →
// Enter 제자리 편집 → 편집 중 Tab = 저장 후 오른쪽 셀로 이동+재진입. 데모 픽스처는
// benchmarks/benchmark.hwp(8쪽, 표 포함). enableEditing 이 켜진 lab 에서 검증한다.
// 셀 주소(N행 M열)는 페이지에 그려지는 선택 마크 라벨(.hw-mark-label)에서 읽는다(가장 신뢰 가능).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 현재 선택된 셀의 1-기반 (행,열)을 마크 라벨에서 읽는다.
async function readCell(page: Page): Promise<{ row: number; col: number }> {
  const t = await page.locator(".hw-mark-label").first().innerText();
  const m = /(\d+)\s*행\s*(\d+)\s*열/.exec(t);
  if (!m) throw new Error(`셀 라벨 파싱 실패: ${t}`);
  return { row: parseInt(m[1], 10), col: parseInt(m[2], 10) };
}

test("방향키 셀 이동(열 증가) → Enter 편집 진입 → Tab 저장+오른쪽 셀 재진입", async ({ page }) => {
  await open(page);

  // 1) 표의 한 셀을 클릭해 선택한다(셀 마크 하나 + "N행 M열" 라벨).
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  let picked = false;
  scan: for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      await page.waitForTimeout(50);
      const labels = await page.locator(".hw-mark-label").allInnerTexts();
      if (labels.some((l) => l.includes("행")) && (await page.locator(".hw-mark-cell").count()) === 1) {
        picked = true;
        break scan;
      }
    }
  }
  expect(picked, "표 셀을 클릭해 셀 선택 마크가 떠야 한다").toBeTruthy();
  await page.waitForTimeout(150);

  // 2) 오른쪽 인접 셀이 있는 본문 행을 찾는다(맨 위 병합 헤더 행은 전폭 병합이라 오른쪽 이동이 올바르게
  //    클램프된다 — 아래 행들엔 실제 라벨/내용 2열이 있다). 각 행에서 왼쪽 끝(클램프)으로 간 뒤 오른쪽을
  //    한 번 눌러 "라벨 열 증가"를 확인한다. 성공하면 그 행 col 1 로 되돌려 편집을 시작한다.
  let navigable = false;
  for (let i = 0; i < 20 && !navigable; i++) {
    for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowLeft"); // → 행의 왼쪽 끝(col 1)
    await page.waitForTimeout(120);
    const c0 = (await readCell(page)).col;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const c1 = (await readCell(page)).col;
    if (c1 > c0) {
      navigable = true; // ★ 방향키 셀 이동 → 라벨 열 증가 확인
      await page.keyboard.press("ArrowLeft"); // col 1 로 되돌림(Tab 이 오른쪽 셀로 이동 가능)
      await page.waitForTimeout(120);
      break;
    }
    await page.keyboard.press("ArrowDown"); // 다음 행에서 재시도
    await page.waitForTimeout(120);
  }
  expect(navigable, "오른쪽 인접 셀이 있는 본문 행에서 방향키로 열이 증가해야 한다").toBeTruthy();
  const startCol = (await readCell(page)).col;

  // 3) Enter = 제자리 편집 진입(032 InPlace 에디터가 셀 위에 뜬다).
  await page.keyboard.press("Enter");
  const ta = page.locator('[data-testid="hw-inplace-editor"]');
  await expect(ta).toBeVisible({ timeout: 15_000 });
  const eb0 = await ta.boundingBox();
  if (!eb0) throw new Error("에디터 박스를 찾지 못함");

  // 4) 타이핑 후 Tab = 저장(SetTableCellRuns) + 오른쪽 셀 이동 + 재진입. 재진입한 에디터는 오른쪽
  //    셀을 덮으므로 left(x)가 증가한다("오른쪽 셀 에디터").
  await ta.fill("TAB이동확인");
  await page.keyboard.press("Tab");
  await expect(page.locator(".hw-status")).toContainText("텍스트를 수정했습니다", { timeout: 30_000 });
  await expect(ta).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      const b = await ta.boundingBox();
      return b ? b.x : -1;
    }, { timeout: 15_000 })
    .toBeGreaterThan(eb0.x + 8);
  // 재진입한 에디터의 셀이 시작 열보다 오른쪽(열 번호 증가)인지도 확인.
  expect((await readCell(page)).col).toBeGreaterThan(startCol);
});
