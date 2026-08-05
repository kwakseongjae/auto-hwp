// guide-bulk.gif 캡처 — 5단계 퍼널: ①양식(샘플로 체험) → ②채울 칸 → ③명단 미리보기 →
// ④완성본 만들기 + 검수 캐러셀 → ⑤zip 내려받기. 스테퍼가 매 장면에 보이도록 프레이밍한다.
import { launch, LIVE, Rec, installCursor, tap, centerOf } from "./rec.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// 프레임 출력 폴더: 기본은 스크립트 옆, GIF_OUT_DIR 로 레포 밖(예: /tmp)으로 뺄 수 있다.
const BASE = process.env.GIF_OUT_DIR ?? HERE;
const OUT = join(BASE, "frames-bulk");
const DL = join(BASE, "dl");
mkdirSync(DL, { recursive: true });

const { browser, page } = await launch();
page.on("download", async (d) => {
  try {
    await d.saveAs(join(DL, d.suggestedFilename()));
  } catch {}
});
await page.goto(LIVE + "bulk", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('[data-testid="bulk-sample"]', { timeout: 60000 });
await page.waitForTimeout(2500);
await installCursor(page);

const rec = new Rec(page, OUT);
rec._cur = { x: 640, y: 780 };

// ── ① 양식 — 5단계 스테퍼가 처음부터 지도처럼 보인다 ────────────────────
await rec.shot();
rec.freeze(6);

// ── 샘플로 체험 → ①②③ 자동 진행 ───────────────────────────────────────
const sample = await centerOf(page, '[data-testid="bulk-sample"]');
await tap(rec, sample.x, sample.y, { steps: 6, after: 2 });
await rec.until(async () => (await page.locator('[data-testid="bulk-roster"]').count()) > 0, {
  timeout: 90000,
  fps: 8,
  maxFrames: 12,
});
await page.waitForTimeout(700);
await page.evaluate(() => window.__ahcurOff?.());
await rec.shot();
rec.freeze(7); // ③ 명단 + 미리보기 표를 읽는 시간

// ── ③ 명단 미리보기(표) 가 보이게 살짝 스크롤 ──────────────────────────
await page.mouse.move(640, 500);
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, 60);
  await rec.shot();
}
await page.waitForTimeout(250);
await rec.shot();
rec.freeze(4);

// ── ④ 완성본 만들기 ────────────────────────────────────────────────────
const gen = await centerOf(page, '[data-testid="bulk-generate"]');
await tap(rec, gen.x, gen.y, { steps: 6, after: 2 });
await rec.until(async () => (await page.locator('[data-testid="bulk-idx"]').count()) > 0, {
  timeout: 180000,
  fps: 10,
  maxFrames: 14,
});
await page.waitForTimeout(900); // 검수 SVG lazy 렌더
await page.evaluate(() => window.__ahcurOff?.());
await rec.shot();
rec.freeze(7);

// ── 검수 캐러셀 넘기기 ─────────────────────────────────────────────────
const next = await centerOf(page, 'button:has-text("다음")');
await tap(rec, next.x, next.y, { steps: 5, after: 3 });
await page.waitForTimeout(700);
await rec.shot();
await rec.shot();
rec.freeze(5);
console.log("carousel:", await page.locator('[data-testid="bulk-idx"]').innerText());
const badges = (await page.locator('[data-testid="bulk-badges"]').first().innerText()).replace(/\n/g, " · ");

// ── ⑤ zip 내려받기 ─────────────────────────────────────────────────────
const zip = await centerOf(page, '[data-testid="bulk-zip"]');
await tap(rec, zip.x, zip.y, { steps: 6, after: 3 });
const done = await rec.until(async () => (await page.locator('[data-testid="bulk-done"]').count()) > 0, {
  timeout: 60000,
  fps: 10,
  maxFrames: 10,
});
await page.waitForTimeout(600);
await page.evaluate(() => window.__ahcurOff?.());
await rec.shot();
rec.freeze(13); // 끝 정지 여유

console.log("frames", rec.count(), "step5:", done, "badges:", badges);
await page.waitForTimeout(600);
await browser.close();
if (!done) process.exit(2);
