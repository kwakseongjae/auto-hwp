// issue 055 (FG-14) — 메인스레드 블로킹 BEFORE/AFTER 실측 하네스 (Chrome trace 기반).
//
// 같은 앱·같은 픽스처로 두 모드를 돌려 비교한다:
//   BEFORE = /?engineWorker=off  (기존 메인스레드 엔진)
//   AFTER  = /                (기본: 엔진 Web Worker — 055)
//
// 왜 trace 인가(longtask API 아님): 대형 문서의 총 TBT 는 "브라우저 DOM Layout"(가상화 플레이스홀더
// 수백 장 — 워커화와 무관한 양 모드 공통 비용)이 지배해, 합계만 보면 신호가 묻힌다. Chrome trace 의
// RunTask 를 자식 이벤트로 분류해 **JS(엔진+앱) 태스크**와 **Layout/Paint 태스크**를 분리 집계한다 —
// FG-14 가 없애는 것은 전자(문서 크기에 비례해 무한히 자라는 엔진 몫)다.
//
// 사용 (레포 루트에서):
//   1) dev 서버:  cd apps/hwp-lab && npm run dev -- -p 3100      (predev 가 wasm/워커 에셋 복사)
//   2) 픽스처:    node apps/hwp-lab/scripts/make-large-fixture.mjs   (128p 합성 HWPX 생성)
//   3) 실측:      node apps/hwp-lab/scripts/measure-blocking.mjs [fixture=benchmarks/synthetic-large-055.hwpx]
//   BASE_URL 환경변수로 서버 주소 변경 가능(기본 http://localhost:3100).
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..", "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const FIXTURE = path.resolve(repoRoot, process.argv[2] ?? "benchmarks/synthetic-large-055.hwpx");
/** 입력 후 관찰 창(ms) — 폰트 자동 등록 재조판까지 안정적으로 포함하도록 넉넉히. 두 모드 동일 창. */
const WINDOW_MS = 8000;
/** CPU 스로틀 배수 — 개발기(M-시리즈)는 사용자 기기 대비 지나치게 빨라 엔진 블로킹이 노이즈에 묻힌다.
 *  4×가 크롬 devtools 의 "mid-tier mobile/저사양 노트북" 관례값. CPU_THROTTLE=1 로 끌 수 있다. */
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? 4);

function classify(events, mains) {
  // RunTask(>50ms)를 자식 이벤트 우세종으로 분류: Layout/UpdateLayoutTree/PrePaint/Paint 가 절반 이상이면
  // "layout"(양 모드 공통 브라우저 비용), 아니면 "js"(엔진+앱 스크립트 — 워커화가 없애는 몫).
  const LAYOUT = new Set(["Layout", "UpdateLayoutTree", "PrePaint", "Paint", "Layerize"]);
  const tasks = events.filter((e) => e.name === "RunTask" && e.ph === "X" && mains.has(`${e.pid}:${e.tid}`) && (e.dur ?? 0) > 50_000);
  const out = { js: { n: 0, total: 0, max: 0 }, layout: { n: 0, total: 0, max: 0 } };
  for (const t of tasks) {
    const kids = events.filter(
      (e) => e.pid === t.pid && e.tid === t.tid && e.ph === "X" && e.name !== "RunTask" && e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur,
    );
    let layoutUs = 0;
    for (const k of kids) if (LAYOUT.has(k.name)) layoutUs += k.dur ?? 0;
    const bucket = layoutUs * 2 >= t.dur ? out.layout : out.js;
    const ms = t.dur / 1000;
    bucket.n++;
    bucket.total += ms;
    bucket.max = Math.max(bucket.max, ms);
  }
  for (const b of [out.js, out.layout]) {
    b.total = Math.round(b.total);
    b.max = Math.round(b.max);
  }
  return out;
}

async function measure(browser, query, label) {
  const page = await browser.newPage();
  if (CPU_THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }
  await page.goto(`${BASE}/${query}`);
  await page.waitForSelector('[data-testid="file-input"]', { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(1500); // 하이드레이션 몫을 창에서 제외
  const tracePath = path.join(os.tmpdir(), `auto-hwp-055-trace-${Date.now()}.json`);
  await browser.startTracing(page, { path: tracePath, categories: ["devtools.timeline", "v8", "disabled-by-default-devtools.timeline"] });
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForSelector(".hw-sheet svg", { timeout: 120_000 });
  await page.waitForTimeout(WINDOW_MS);
  await browser.stopTracing();
  await page.close();

  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  const events = trace.traceEvents ?? trace;
  const mains = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  return { label, ...classify(events, mains) };
}

const browser = await chromium.launch();
console.log(`fixture: ${path.basename(FIXTURE)} · base: ${BASE} · window: input→first sheet+${WINDOW_MS}ms (동일 창) · CPU throttle ×${CPU_THROTTLE}`);
const before = await measure(browser, "?engineWorker=off", "BEFORE (main-thread engine)");
const after = await measure(browser, "", "AFTER  (worker engine)");
await browser.close();

for (const r of [before, after]) {
  console.log(
    `${r.label}: JS(엔진+앱) blocked=${r.js.total}ms (max ${r.js.max}ms, n=${r.js.n}) · ` +
      `Layout/Paint(공통) blocked=${r.layout.total}ms (max ${r.layout.max}ms, n=${r.layout.n})`,
  );
}
const cut = before.js.total > 0 ? Math.round((1 - after.js.total / before.js.total) * 100) : 0;
console.log(`JS(엔진+앱) 메인스레드 블로킹: ${before.js.total}ms → ${after.js.total}ms (${cut}% 감소)`);
console.log(`Layout/Paint 공통 비용(워커화 무관 — 가상화가 상한): ${before.layout.total}ms ↔ ${after.layout.total}ms`);