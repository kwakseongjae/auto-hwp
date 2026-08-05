// guide-engine.gif 캡처 — 엔진 중심: 랜딩(라이트) → 샘플 열기 → 페이지 렌더·스크롤·줌 → HTML/PDF 내보내기.
// AI 패널은 건드리지 않는다(=AI 무관), 설치 없이 브라우저에서 끝난다는 것을 흐름으로 보인다.
import { launch, LIVE, Rec, installCursor, glide, tap, centerOf } from "./rec.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// 프레임 출력 폴더: 기본은 스크립트 옆, GIF_OUT_DIR 로 레포 밖(예: /tmp)으로 뺄 수 있다.
const BASE = process.env.GIF_OUT_DIR ?? HERE;
const OUT = join(BASE, "frames-engine");
const DL = join(BASE, "dl");
mkdirSync(DL, { recursive: true });

const { browser, ctx, page } = await launch();
await ctx.setDefaultTimeout(60000);
page.on("download", async (d) => {
  try {
    await d.saveAs(join(DL, d.suggestedFilename()));
  } catch {}
});

await page.goto(LIVE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('[data-testid="lab-hero"]', { timeout: 60000 });
await page.waitForTimeout(2500); // 히어로 이미지·폰트·wasm prefetch 안정화
await installCursor(page);

const rec = new Rec(page, OUT);
rec._cur = { x: 640, y: 760 };

// ── ① 랜딩(라이트) 정지 ────────────────────────────────────────────────
await rec.shot();
rec.freeze(11); // 1.0s @12fps

// ── ② "예시 샘플" 클릭 → 열기 ──────────────────────────────────────────
const sample = await centerOf(page, 'button:has-text("예시 샘플")');
await tap(rec, sample.x, sample.y, { steps: 7, after: 1 });

// ── ③ 렌더될 때까지 실시간 캡처 ────────────────────────────────────────
await rec.until(async () => (await page.locator(".hw-sheet svg").count()) >= 1, { timeout: 60000, fps: 12 });
await page.waitForTimeout(250);
await page.evaluate(() => window.__ahcurOff?.());
await rec.shot();
rec.freeze(9); // 첫 렌더에서 잠깐 멈춘다

// ── ④ 스크롤(페이지 넘김) ──────────────────────────────────────────────
await page.mouse.move(580, 450);
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 190);
  await rec.shot();
}
await rec.shot();
rec.freeze(4);

// ── ⑤ 줌 아웃(－ 세 번) — 조판이 실시간으로 다시 흐르는 게 보이게 ────────
const zout = await centerOf(page, '.hw-tool[title="축소 (⌘−)"]');
await tap(rec, zout.x, zout.y, { steps: 5, after: 2 });
for (let i = 0; i < 2; i++) {
  await page.evaluate(([a, b]) => window.__ahcur?.(a, b, true), [zout.x, zout.y]);
  await page.mouse.click(zout.x, zout.y);
  await rec.shot();
  await page.waitForTimeout(160);
  await rec.shot();
}
rec.freeze(5);

// ── ⑥ HTML 내보내기 ───────────────────────────────────────────────────
const html = await centerOf(page, '.hw-tool[title="HTML 다운로드"]');
await tap(rec, html.x, html.y, { steps: 5, after: 3 });
await page.waitForTimeout(300);
await rec.shot();
rec.freeze(3);

// ── ⑦ PDF 내보내기 ────────────────────────────────────────────────────
const pdf = await centerOf(page, '.hw-tool[title="PDF 다운로드"]');
await tap(rec, pdf.x, pdf.y, { steps: 4, after: 2 });
await rec.hold(700, 12); // 내보내기 진행
await rec.shot(); // 커서는 PDF 버튼 위에 남긴다 — 마지막 동작이 보이게
rec.freeze(15); // 끝 정지 여유

console.log("frames", rec.count());
await page.waitForTimeout(500);
await browser.close();
