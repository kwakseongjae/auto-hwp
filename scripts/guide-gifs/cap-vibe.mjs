// guide-vibe.gif 캡처 — 바이브 편집 루프: 표/셀 클릭 마킹 → 챗 지시 → (동의 1회) → 제안 카드 → 적용 → undo.
// 데모 AI 실호출 1회(승인됨). 동의는 브라우저 네이티브 confirm 이라 화면 캡처에 찍히지 않는다 —
// 스크립트가 실제로 수락한다(page.on('dialog') → accept).
import { launch, LIVE, Rec, installCursor, glide, tap, centerOf } from "./rec.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// 프레임 출력 폴더: 기본은 스크립트 옆, GIF_OUT_DIR 로 레포 밖(예: /tmp)으로 뺄 수 있다.
const BASE = process.env.GIF_OUT_DIR ?? HERE;
const OUT = join(BASE, "frames-vibe");
const INSTR = "이 칸에 '데이터 분석' 이라고 써줘";
const CELL = { x: 480, y: 423 }; // 2쪽 "팀 구성 현황" 표의 빈 칸(3행 담당 업무)

const { browser, page } = await launch(); // dialog=accept → 동의 1회
await page.goto(LIVE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "예시 샘플" }).click();
await page.locator(".hw-sheet svg").first().waitFor({ timeout: 90000 });
await page.waitForTimeout(1000);
// 촬영 시작 지점: 2쪽 "팀 구성 현황"(빈 행이 있는 표)이 보이는 위치까지 미리 스크롤
await page.mouse.move(580, 450);
for (let i = 0; i < 7; i++) await page.mouse.wheel(0, 190);
await page.waitForTimeout(1500);
await installCursor(page);

const rec = new Rec(page, OUT);
rec._cur = { x: 640, y: 700 };

// ── ① 문서 정지 ────────────────────────────────────────────────────────
await rec.shot();
rec.freeze(4);

// ── ② 표 클릭 → 셀로 드릴(더블클릭) = 마킹 ─────────────────────────────
await tap(rec, CELL.x, CELL.y, { steps: 6, after: 3 });
await page.waitForTimeout(450);
await rec.shot();
await page.evaluate(([a, b]) => window.__ahcur?.(a, b, true), [CELL.x, CELL.y]);
await page.mouse.click(CELL.x, CELL.y);
await rec.shot();
await page.mouse.click(CELL.x, CELL.y);
await rec.shot();
await page.waitForTimeout(500);
await rec.shot();
await rec.shot();
rec.freeze(5);
const anchor = await page.locator(".hw-anchor").first().innerText().catch(() => "");
console.log("anchor:", anchor);

// ── ③ 바이브 편집 탭 → 지시 입력 ───────────────────────────────────────
const tab = await centerOf(page, '[role="tab"]:has-text("바이브 편집")');
await tap(rec, tab.x, tab.y, { steps: 5, after: 2 });
const ta = await centerOf(page, ".hw-textarea");
await tap(rec, ta.x, ta.y, { steps: 4, after: 1 });
for (let i = 0; i < INSTR.length; i += 2) {
  await page.keyboard.type(INSTR.slice(i, i + 2), { delay: 8 });
  await rec.shot();
}
rec.freeze(3);

// ── ④ 보내기 → (동의 confirm 자동 수락) → 응답 대기 ────────────────────
const send = await centerOf(page, ".hw-btn-send");
await tap(rec, send.x, send.y, { steps: 4, after: 2 });
await page.evaluate(() => window.__ahcurOff?.());
const got = await rec.until(async () => (await page.locator(".hw-review .hw-btn-primary").count()) > 0, {
  timeout: 60000,
  fps: 3.5, // 응답 대기(수 초)는 저프레임으로 담는다 — 실제 진행을 압축해 보여준다
  maxFrames: 13,
});
if (!got) {
  console.error("FAIL: 제안 카드가 오지 않음 (재촬영 필요)");
  await browser.close();
  process.exit(2);
}
await page.waitForTimeout(250);
await rec.shot();
rec.freeze(6); // 제안 카드 읽는 시간

// ── ⑤ 적용 → 그 칸이 채워진다 ──────────────────────────────────────────
const apply = await centerOf(page, ".hw-review .hw-btn-primary");
await tap(rec, apply.x, apply.y, { steps: 4, after: 2 });
await rec.until(async () => (await page.locator(".hw-applied").count()) > 0, { timeout: 30000, fps: 12 });
await page.waitForTimeout(500);
await rec.shot();
rec.freeze(7);
// 렌더 SVG 는 run 단위로 <text> 가 쪼개진다("데이터"|"분석") — 공백 포함 문자열로 찾으면 못 잡는다.
const hasText = async () => {
  const t = (await page.locator(".hw-pages").textContent()) ?? "";
  return t.includes("데이터") && t.includes("분석");
};
const filled = await hasText();

// ── ⑥ undo → 원래대로 ──────────────────────────────────────────────────
const undo = await centerOf(page, '.hw-tool[title="실행취소"]');
await tap(rec, undo.x, undo.y, { steps: 5, after: 2 });
await rec.until(async () => !(await hasText()), {
  timeout: 30000,
  fps: 12,
});
await page.waitForTimeout(400);
await rec.shot();
rec.freeze(10);

const reverted = !(await hasText());
console.log("frames", rec.count(), "filled:", filled, "reverted:", reverted);
await browser.close();
if (!filled || !reverted) process.exit(3);
