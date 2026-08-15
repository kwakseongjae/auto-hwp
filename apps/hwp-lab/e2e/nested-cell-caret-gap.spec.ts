import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// caret-undo 증상 1 — **미수리 갭의 실행 가능한 기술서**(test.fixme: 지금은 반드시 실패한다).
//
// 재현(실측, sample-8p.hwp): 일반현황 표의 파란 안내 문구
//   "※ 협약기간 내 제작·개발 완료할 최종 생산품의 형태, 수량 등 기재"
// 는 s0/b10(9×8) 의 셀 (r1,c3) 안에 들어 있는 **1×1 중첩 표**의 셀 문단이다
// (`cargo run -p auto-hwp-cli --features rhwp --example nested_caret_probe -- <sample> 생산품` 로 확인).
//
// 그 결과 지금은 지울 방법이 **하나도 없다**:
//   ① 글자 캐럿   — crates/hwp-typeset/src/place.rs `cell_text_hit()` 가
//                   `if !t.ancestors.is_empty() { return None; }` 로 중첩 표 위 캐럿을 원천 차단한다
//                   (플랫 (section,block,row,col) 주소로는 중첩 leaf 에 닿을 수 없기 때문).
//   ② 제자리 에디터 — place.rs 주석은 "중첩 셀은 더블클릭 제자리 에디터로 편집한다"고 적혀 있지만,
//                   실측에서 더블클릭에도, 선택 어포던스(hw-inline-open) 클릭에도 에디터가 열리지 않았다.
//   ③ 그래서 Backspace 는 커밋할 대상이 없고, 커밋이 없으니 undo 스택도 비어 ⌘Z 도 "무반응"으로 읽힌다
//      (그 침묵은 이번 배치에서 "되돌릴 편집이 없습니다" 안내로 교정했다 — 원인 자체는 아래가 남는다).
//
// 수리 방향(합의 필요): CellPath 를 캐럿 레인까지 관통시킨다 —
//   engine  : `CellTextHit` 에 `path` 추가 + 중첩 leaf 해소, `cell_caret_rect` 의 path 변형,
//             `Intent::CaretRectCell` 에 optional `path`(additive · deny_unknown 유지).
//   core    : `CellCaretAnchor.path`, 읽기는 `blockRunsPath`, 커밋은 이미 있는 `SetTableCellRuns.path`.
//   adapter : WasmAdapter/TauriAdapter + worker RPC 화이트리스트에 path 변형 노출, wasm 재빌드.
const SAMPLE = path.resolve(process.cwd(), "public", "samples", "sample-8p.hwp");
const NEEDLE = "생산품";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(SAMPLE);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

async function showPage(page: Page, index: number) {
  await page.locator(`.hw-sheet[data-page="${index}"]`).scrollIntoViewIfNeeded();
  await expect(page.locator(`.hw-sheet[data-page="${index}"] svg`)).toBeVisible({ timeout: 30_000 });
}

/** 글리프 단위 <text> 를 y 밴드로 묶어 needle 이 있는 줄의 글리프 박스를 찾는다(옵션: 화면 안으로 스크롤). */
async function findGlyph(page: Page, needle: string, scroll = false) {
  return page.evaluate(([n, doScroll]: [string, boolean]) => {
    const els = Array.from(document.querySelectorAll(".hw-pages text")) as SVGTextElement[];
    type G = { ch: string; r: DOMRect; el: SVGTextElement };
    const glyphs: G[] = [];
    for (const el of els) {
      const ch = el.textContent ?? "";
      if (!ch.trim()) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      glyphs.push({ ch, r: r as DOMRect, el });
    }
    glyphs.sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
    const lines: G[][] = [];
    for (const g of glyphs) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].r.y - g.r.y) < Math.max(3, g.r.height * 0.5)) last.push(g);
      else lines.push([g]);
    }
    for (const line of lines) {
      line.sort((a, b) => a.r.x - b.r.x);
      const text = line.map((g) => g.ch).join("");
      const i = text.indexOf(n);
      if (i < 0) continue;
      let count = 0;
      let target: G | null = null;
      for (const g of line) {
        if (count >= i) {
          target = g;
          break;
        }
        count += g.ch.length;
      }
      const t = target ?? line[0];
      if (doScroll) t.el.scrollIntoView({ block: "center", inline: "center" });
      const r = t.el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, line: text.slice(0, 80) };
    }
    return null;
  }, [needle, scroll] as [string, boolean]);
}

test.fixme("중첩 셀 클릭이 다른 대상에 은닉 undo를 만들지 않는다", async ({ page }) => {
  await open(page);
  await findGlyph(page, NEEDLE, true);
  await page.waitForTimeout(800);
  const hit = await findGlyph(page, NEEDLE);
  if (!hit) throw new Error("문구를 화면에 올리지 못함");
  await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.waitForTimeout(300);
  const undos = page.locator('[data-testid="undo"], button[title="실행취소"]');
  await page.keyboard.press(`${MOD}+z`);
  expect(await findGlyph(page, NEEDLE)).not.toBeNull();
  expect(await findGlyph(page, "창업아이템명")).not.toBeNull();
  await expect(undos).toBeVisible();
});

test.fixme("중첩 셀에서 Home/End가 바깥 표 줄이 아니라 leaf 줄을 움직인다", async ({ page }) => {
  await open(page);
  await findGlyph(page, NEEDLE, true);
  await page.waitForTimeout(800);
  const hit = await findGlyph(page, NEEDLE);
  if (!hit) throw new Error("문구를 화면에 올리지 못함");
  const cx = hit.x + hit.width / 2;
  const cy = hit.y + hit.height / 2;
  for (let i = 0; i < 4 && (await page.locator(".hw-caret").count()) === 0; i++) {
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(400);
  }
  await expect(page.locator(".hw-caret")).toHaveCount(1, { timeout: 10_000 });
  const before = await page.locator(".hw-caret").boundingBox();
  await page.keyboard.press("Home");
  const home = await page.locator(".hw-caret").boundingBox();
  await page.keyboard.press("End");
  const end = await page.locator(".hw-caret").boundingBox();
  expect(home).toBeTruthy();
  expect(end).toBeTruthy();
  expect(end!.x).toBeGreaterThan(home!.x);
  expect(Math.abs((home!.y ?? 0) - (before!.y ?? 0))).toBeLessThan(8);
});

test.fixme("중첩 셀(1×1 표 안) 문단도 캐럿으로 지우고 ⌘Z 로 되살릴 수 있어야 한다", async ({ page }) => {
  await open(page);
  expect(await findGlyph(page, NEEDLE)).not.toBeNull();
  await findGlyph(page, NEEDLE, true);
  await page.waitForTimeout(1200);
  const hit = await findGlyph(page, NEEDLE);
  if (!hit) throw new Error("문구를 화면에 올리지 못함");
  const cx = hit.x + hit.width / 2;
  const cy = hit.y + hit.height / 2;

  // 표 → 셀 드릴 → 글자 캐럿 (지금은 여기서 멈춘다: 중첩 표 위에는 캐럿이 서지 않는다)
  for (let i = 0; i < 4 && (await page.locator(".hw-caret").count()) === 0; i++) {
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(400);
  }
  await expect(page.locator(".hw-caret")).toHaveCount(1, { timeout: 10_000 });

  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await findGlyph(page, NEEDLE)) === null, { timeout: 30_000 }).toBe(true);

  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await findGlyph(page, NEEDLE)) !== null, { timeout: 30_000 }).toBe(true);
});

test("중첩 표 선택 Backspace는 바깥 표를 보존하고, 즉시 undo도 클릭 없이 복구한다", async ({ page }) => {
  await open(page);
  await findGlyph(page, NEEDLE, true);
  await page.waitForTimeout(800);
  let hit = await findGlyph(page, NEEDLE);
  if (!hit) throw new Error("중첩 표 문구를 화면에 올리지 못함");
  expect(await findGlyph(page, "창업아이템명")).not.toBeNull();

  // 1) 실제 삭제 대상을 확인한다: 중첩 표의 문구만 사라지고 같은 바깥 양식 표의 형제 행은 남는다.
  await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await expect(page.locator(".hw-mark-table")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await findGlyph(page, NEEDLE)) === null, { timeout: 30_000 }).toBe(true);
  expect(await findGlyph(page, "창업아이템명")).not.toBeNull();

  await page.keyboard.press(`${MOD}+z`);
  await showPage(page, 1); // undo reflow may virtualize the restored page off-DOM; no click/focus change
  await expect.poll(async () => (await findGlyph(page, NEEDLE)) !== null, { timeout: 30_000 }).toBe(true);

  // 2) 경쟁 상태 회귀: 재선택 후 삭제와 undo를 기다림/중간 클릭 없이 연달아 보낸다.
  hit = await findGlyph(page, NEEDLE);
  if (!hit) throw new Error("undo 뒤 중첩 표 문구가 복구되지 않음");
  await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.keyboard.press("Backspace");
  await page.keyboard.press(`${MOD}+z`);
  await showPage(page, 1);
  await expect.poll(async () => (await findGlyph(page, NEEDLE)) !== null, { timeout: 30_000 }).toBe(true);
});
