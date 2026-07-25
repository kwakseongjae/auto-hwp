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

// 첫 페이지 위를 훑을 후보 지점(페이지 좌상단 기준 비율 → 화면 좌표). 어느 지점이 어느 표에
// 떨어지는지는 조판 지오메트리에 따라 달라지므로(⚠️ 아래 주석) 한 지점에 의존하지 않는다.
function cellCandidates(box: { x: number; y: number; width: number; height: number }) {
  const pts: { px: number; py: number }[] = [];
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      pts.push({ px: box.x + box.width * rx, py: box.y + box.height * ry });
    }
  }
  return pts;
}

// 06x Figma 드릴: 단일 클릭은 표 '전체'를 마킹하므로, 셀 하나를 선택하려면 그 지점을 더블클릭해 드릴
// 인한다. 표 위 지점을 단일 클릭으로 확인하고(.hw-mark-table) → Escape 초기화 → 깨끗한 더블클릭(raw
// 좌표 → 행 그립 가로채기 우회)으로 셀을 캐럿 없이 선택한다. 캐럿이 없어야 방향키가 036 셀 이동을 탄다.
async function drillAt(page: Page, px: number, py: number): Promise<boolean> {
  await page.mouse.click(px, py);
  if ((await page.locator(".hw-mark-table").count()) === 0) return false;
  await page.keyboard.press("Escape");
  await page.mouse.click(px, py);
  await page.mouse.click(px, py);
  try {
    await page.locator(".hw-mark-cell").first().waitFor({ state: "visible", timeout: 4000 });
  } catch {
    return false; // 셀 경계/그립에 걸림 → 다음 지점
  }
  const labels = await page.locator(".hw-mark-label").allInnerTexts();
  return labels.some((l) => l.includes("행")) && (await page.locator(".hw-mark-cell").count()) === 1;
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

test("방향키 셀 이동(열 증가) → Enter 편집 진입 → Tab 저장+오른쪽 셀 재진입", async ({ page }) => {
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
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  let navigable = false;
  for (const { px, py } of cellCandidates(box)) {
    if (!(await drillAt(page, px, py))) continue;
    await page.waitForTimeout(150);
    if (await findNavigableRow(page)) {
      navigable = true;
      break;
    }
    await page.keyboard.press("Escape"); // 이 표로는 증명 불가 → 선택 해제하고 다음 후보
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
