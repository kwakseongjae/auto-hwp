import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { selectFirstCell } from "./cell-gesture";

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

// 드릴한 셀이 속한 표에서 "오른쪽 이웃이 있는 행"을 찾아 그 행의 왼쪽 끝(col 1)에 선다.
// 각 행에서 ArrowLeft ×6(왼쪽 끝) → ArrowRight 1회로 열 번호 증가를 확인한다. 증가하지 않으면
// ArrowDown 으로 다음 행을 시도하고, 아래로도 못 가면(1×1 표·마지막 행) 이 표로는 증명할 수 없으므로
// false 를 돌려 호출자가 다음 후보 지점을 드릴하게 한다.
async function findNavigableRow(page: Page): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowLeft"); // → 행의 왼쪽 끝(col 1)
    await page.waitForTimeout(120);
    const c0 = await readCell(page);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    const c1 = await readCell(page);
    if (c1.col > c0.col) {
      await page.keyboard.press("ArrowLeft"); // col 1 로 되돌림(Tab 이 오른쪽 셀로 이동 가능)
      await page.waitForTimeout(120);
      return true; // ★ 방향키 셀 이동 → 라벨 열 증가 확인
    }
    await page.keyboard.press("ArrowDown"); // 다음 행에서 재시도
    await page.waitForTimeout(120);
    if ((await readCell(page)).row === c0.row) return false; // 아래로 못 감 = 더 볼 행이 없다
  }
  return false;
}

test("방향키 셀 이동(열 증가) → Enter 엔진 캐럿 → 원위치 입력·undo", async ({ page }) => {
  await open(page);

  // 1)+2) 표 셀을 드릴(더블클릭)해 선택하고, 그 셀이 속한 표에서 "오른쪽 인접 셀이 있는 본문 행"을
  //   찾는다. 한 지점에 고정하지 않고 후보 지점을 순서대로 훑는 이유(⚠️ 이슈 074 회귀에서 배움):
  //   전폭 1×1 표(안내문 상자)의 셀은 좌/우/아래가 전부 올바르게 **클램프**되므로 이 검사로는
  //   증명할 수 없다 — 그런데 예전 스펙은 "첫 셀이 잡히는 지점"이 늘 아래쪽 10×2 표라고 가정했다.
  //   074 에서 본문 상자 원점이 `위 여백`에서 `위 여백 + 머리말 여백`으로 바로잡히면서(한컴 규칙 =
  //   rhwp `PageAreas::from_page_def_for_page`; benchmark.hwp 는 4251 → 7085 HWPUNIT) 페이지 내용이
  //   3.4% 아래로 밀렸고, 첫 후보 지점(높이 10%)이 그 1×1 표 안(8.4~10.6%)으로 들어와 검사가 통과할
  //   수 없게 됐다. 지오메트리는 옳다(한컴이 저장한 lineseg 최대 세로 위치 71891 이 새 본문 높이
  //   71435 에 들어맞고 옛 77103 과는 어긋난다; 게이트 8==8·18==18·24==24 유지) — 취약했던 건
  //   "10% 지점엔 다열 표가 있다"는 이 스펙의 가정이었다.
  await selectFirstCell(page, true);
  await page.waitForTimeout(150);
  const navigable = await findNavigableRow(page);
  expect(navigable, "오른쪽 인접 셀이 있는 본문 행에서 방향키로 열이 증가해야 한다").toBeTruthy();
  const startCol = (await readCell(page)).col;

  // 3) Enter = 원본 SVG 위 엔진 캐럿 진입. 별도 contentEditable 박스를 만들지 않는다.
  await page.keyboard.press("Enter");
  await expect(page.locator(".hw-caret")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0);
  await page.keyboard.type("QX", { delay: 300 });
  await expect(page.locator(".hw-pages")).toContainText("QX", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-pages")).not.toContainText("QX", { timeout: 30_000 });
  expect((await readCell(page)).col).toBe(startCol);
});
