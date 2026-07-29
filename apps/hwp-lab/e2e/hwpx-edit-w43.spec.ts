import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret } from "./cell-gesture";

// W4.3 — HWPX 편집 레인의 e2e. 그동안 게이트도 e2e도 .hwp 픽스처만 봤기 때문에, HWPX 전용
// 경로(자체 파서 → 자체 조판 → 바이트 스팬 왕복 직렬화)의 회귀는 전부 사각지대였다. 정부
// HWPX 의무화(2026-05) 이후 HWPX 가 1급 입구가 되므로, 여기서 캐럿 타이핑·셀 편집·저장 왕복·
// 섹션 첫 문단 타이핑(W4.2 실증) 네 갈래를 실브라우저로 잠근다.
//
// 픽스처는 앱이 실제로 배포하는 샘플(public/samples/sample-18p.hwpx) — 방문자가 "샘플 열기"로
// 만나는 바로 그 문서다.
// ⚠️ 쪽수는 **파일명이 아니라 실측**으로 다룬다. 파일명은 원본 한/글 기준 18쪽이지만 우리 조판의
//    실측치는 다르다(참값 오라클은 075 몫). 그래서 이 스펙은 어떤 쪽수도 상수로 박지 않고, 열었을
//    때의 슬롯 수를 읽어 편집·저장 전후로 **변하지 않는지만** 본다.
const SAMPLE = path.resolve(process.cwd(), "public", "samples", "sample-18p.hwpx");

/** 문서에 사실상 없는 토큰(US 배열 문자만 — Playwright 는 배열 밖 문자의 keydown 을 만들지 않는다). */
const TOKEN = "ZQJX";

/** 커밋된 본문은 오직 페이지 SVG 안에만 산다(오버레이/툴바 오탐 배제 — 059 스펙과 같은 규율). */
const PAGE0_SVG = '.hw-sheet[data-page="0"] svg';

/** 위 셀렉터의 **첫** 매치(다중 매치 locator 에 toContainText 를 쓰면 Playwright 가 거부한다). */
const page0Svg = (page: Page) => page.locator(PAGE0_SVG).first();

async function open(page: Page, file: string = SAMPLE): Promise<number> {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(file);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1200); // 폰트 재배치 + 가상화 settle
  return page.locator(".hw-sheet").count();
}

/**
 * 첫 페이지의 **본문**(표 밖) 문단을 훑어 글리프 캐럿을 세운다.
 *
 * 셀 캐럿과 달리 드릴이 필요 없다 — 단일 클릭이 캐럿 라우터를 태우고(셀 먼저, 아니면 본문),
 * `own_hit_test` 밴드 안이면 캐럿이 선다. 표 위 클릭은 표/셀 앵커를 만드므로 건너뛴다.
 * `fromTop` 이면 위에서 아래로 훑어 **가장 위 밴드**부터 잡는다(섹션 첫 문단 타이핑용).
 */
async function placeBodyCaret(page: Page, fromTop = false): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");

  const yFrom = fromTop ? 0.02 : 0.06;
  const yTo = fromTop ? 0.22 : 0.94;
  const yStep = fromTop ? 0.01 : 0.03;
  for (let ry = yFrom; ry <= yTo; ry += yStep) {
    for (let rx = 0.12; rx <= 0.88; rx += 0.08) {
      await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
      // 한 점의 hit-test/캐럿 worker settle 이 끝나기 전에 다음 점을 쏘면 최신-gesture 정책상 앞 점의
      // 늦은 캐럿이 취소된다. 스캐너도 사용자 클릭처럼 한 점씩 settle 시킨다(053/059 와 같은 규율).
      await page.waitForTimeout(180);
      // 표/그림 위였다면 캐럿은 서지 않는다(라우터가 셀→본문 순으로 판정하고, 어디에도 안 걸리면
      // 018 null 정책으로 캐럿을 지운다) — 그래서 `.hw-caret` 유무 하나로 충분하다.
      if ((await page.locator(".hw-caret").count()) > 0) return;
    }
  }
  throw new Error("본문 문단 캐럿을 세우지 못함 (스캔 실패)");
}

test("HWPX 본문 문단: 클릭 → 캐럿 → 타이핑이 SVG 에 반영 → undo 복원", async ({ page }) => {
  const pages = await open(page);
  expect(pages).toBeGreaterThan(1);

  await placeBodyCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();
  await expect(page0Svg(page)).not.toContainText(TOKEN);

  // 키 하나 = SetParagraphRuns 하나 = undo 하나 (불변식 5 — 평문 variant 금지).
  await page.keyboard.type(TOKEN, { delay: 350 });
  await expect(page0Svg(page)).toContainText(TOKEN, { timeout: 30_000 });
  await expect(page.locator(".hw-caret")).toBeVisible(); // 커밋 후에도 캐럿 유지(지오메트리 재해석)

  // 편집이 쪽수를 흔들지 않는다(조판 회귀 감시 — LOCKSTEP 이 깨지면 여기서 먼저 터진다).
  await expect(page.locator(".hw-sheet")).toHaveCount(pages, { timeout: 30_000 });

  for (let i = 0; i < TOKEN.length; i++) {
    await page.locator('.hw-tool[title="실행취소"]').click();
    await page.waitForTimeout(150);
  }
  await expect(page0Svg(page)).not.toContainText(TOKEN, { timeout: 30_000 });
});

test("HWPX 표 셀: 드릴 → 캐럿 → 타이핑 커밋(SetTableCellRuns) → undo", async ({ page }) => {
  const pages = await open(page);

  // 셀 드릴/캐럿은 .hwp 와 **같은 제스처 계약**을 쓴다 — 헬퍼를 그대로 재사용해 HWPX 에서도
  // 같은 경로가 서는지 본다(057 셀 스팬 splice 가 살아 있는지의 실브라우저 증거).
  await placeCellCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();

  await page.keyboard.type(TOKEN, { delay: 350 });
  await expect(page.locator(".hw-pages")).toContainText(TOKEN, { timeout: 30_000 });
  await expect(page.locator(".hw-sheet")).toHaveCount(pages, { timeout: 30_000 });

  for (let i = 0; i < TOKEN.length; i++) {
    await page.locator('.hw-tool[title="실행취소"]').click();
    await page.waitForTimeout(150);
  }
  await expect(page.locator(".hw-pages")).not.toContainText(TOKEN, { timeout: 30_000 });
});

test("HWPX 저장 왕복: 편집 → HWPX 다운로드 → 재업로드에 편집이 살아 있고 쪽수 불변", async ({ page }) => {
  const pages = await open(page);

  await placeBodyCaret(page);
  await page.keyboard.type(TOKEN, { delay: 350 });
  await expect(page0Svg(page)).toContainText(TOKEN, { timeout: 30_000 });

  const saveBtn = page.locator('.hw-tool[title^="HWPX 다운로드"]');
  await expect(saveBtn).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    saveBtn.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.hwpx$/i);

  const saved = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hwpx-w43-")), "saved.hwpx");
  await download.saveAs(saved);
  const stat = await fs.stat(saved);
  expect(stat.size).toBeGreaterThan(1024);

  // 저장본을 **다시 열어** 확인한다: 편집이 남아 있고, 쪽수가 그대로다. 문단 순서가 파손되면
  // (W4.1 이전 증상) 토큰이 문서 끝으로 밀려 나거나 쪽수가 흔들린다.
  const pagesAfter = await open(page, saved);
  expect(pagesAfter).toBe(pages);
  await expect(page.locator(".hw-pages")).toContainText(TOKEN, { timeout: 30_000 });
});

test("HWPX 섹션 첫 문단(secPr 호스트) 타이핑 — W4.2 편집 개방 실증", async ({ page }) => {
  // 섹션의 첫 `<hp:p>` 는 페이지 설정(`<hp:secPr>`)을 품어 파서가 non-simple 로 표시한다. W4.2
  // 이전에는 그 문단의 텍스트 커밋이 통째로 거부됐다("이 문단은 인라인 편집 대상이 아닙니다").
  // 이 픽스처의 첫 문단은 **문서 맨 위의 빈 줄**이므로, 위에서부터 훑어 첫 밴드를 잡으면 바로 그
  // 문단이다. 타이핑한 토큰이 문서에서 **가장 먼저** 오면 그 문단에 들어간 것이 증명된다.
  const pages = await open(page);

  // 이 픽스처의 첫 실텍스트(첫 문단 바로 다음). 문서 순서 비교의 기준점.
  // ⚠️ 페이지 SVG 는 글리프를 개별 배치하므로 textContent 에 공백이 없다 — 기준점도 공백 없이 적는다
  //    (아래 순서 비교는 어차피 `\s+` 를 지우고 맞춘다).
  const FIRST_REAL_TEXT = "※신청서작성에";
  const svg = page0Svg(page);
  await expect(svg).toContainText(FIRST_REAL_TEXT, { timeout: 30_000 });

  await placeBodyCaret(page, true);
  await expect(page.locator(".hw-caret")).toBeVisible();

  await page.keyboard.type(TOKEN, { delay: 350 });
  await expect(svg).toContainText(TOKEN, { timeout: 30_000 });

  const order = await svg.evaluate((el, needles) => {
    const text = (el.textContent ?? "").replace(/\s+/g, "");
    return needles.map((n: string) => text.indexOf(n.replace(/\s+/g, "")));
  }, [TOKEN, FIRST_REAL_TEXT]);
  expect(order[0], "타이핑한 토큰이 SVG 에 있어야 한다").toBeGreaterThanOrEqual(0);
  expect(order[1], "기준 텍스트가 SVG 에 있어야 한다").toBeGreaterThanOrEqual(0);
  expect(order[0], "섹션 첫 문단에 들어갔다면 토큰이 문서에서 가장 먼저 온다").toBeLessThan(order[1]);

  // secPr 이 살아 있다는 관찰 가능한 증거: 페이지 지오메트리(쪽수/시트 크기)가 그대로다.
  await expect(page.locator(".hw-sheet")).toHaveCount(pages, { timeout: 30_000 });
});
