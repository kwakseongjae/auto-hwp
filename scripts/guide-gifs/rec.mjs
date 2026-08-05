// 공용 캡처 하네스 — 라이브 사이트를 몰고 다니며 PNG 프레임 시퀀스를 남긴다.
// 프레임은 나중에 ffmpeg(palettegen/paletteuse)로 GIF 로 조립한다(uniform fps + 프레임 복제로 정지 구간).
import { mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// playwright 는 이 스크립트 옆이 아니라 **실행 cwd**(= apps/hwp-lab)의 node_modules 에 있다.
// ESM 기본 해석은 importer 위치 기준이라 여기서 명시적으로 cwd 기준 해석한다.
const require = createRequire(join(process.cwd(), "noop.js"));
const { chromium } = require("playwright"); // CJS — dynamic import() 하면 exports 가 .default 로 들어간다

export const LIVE = "https://kwakseongjae.github.io/auto-hwp/";
export const VIEW = { width: 1280, height: 800 };

export class Rec {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.n = 0;
    this.last = null;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  name(i) {
    return join(this.dir, `f${String(i).padStart(4, "0")}.png`);
  }
  /** 프레임 1장 캡처 */
  async shot() {
    const p = this.name(this.n++);
    await this.page.screenshot({ path: p, animations: "disabled" });
    this.last = p;
    return p;
  }
  /** ms 동안 fps 로 캡처(실시간 진행 상황을 담는다) */
  async hold(ms, fps = 10) {
    const step = 1000 / fps;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t0 = Date.now();
      await this.shot();
      const left = step - (Date.now() - t0);
      if (left > 0) await this.page.waitForTimeout(left);
    }
  }
  /** 마지막 프레임을 n장 복제 = 정지(freeze) */
  freeze(n) {
    if (!this.last) throw new Error("freeze 전에 shot 이 필요");
    for (let i = 0; i < n; i++) copyFileSync(this.last, this.name(this.n++));
  }
  /** 조건이 참이 될 때까지 캡처하며 대기(최대 timeout). maxFrames 를 넘으면 캡처를 멈추고 계속 기다린다 */
  async until(fn, { timeout = 60000, fps = 10, maxFrames = Infinity } = {}) {
    const step = 1000 / fps;
    const end = Date.now() + timeout;
    let shot = 0;
    while (Date.now() < end) {
      if (await fn()) return true;
      const t0 = Date.now();
      if (shot < maxFrames) {
        await this.shot();
        shot++;
      }
      const left = step - (Date.now() - t0);
      if (left > 0) await this.page.waitForTimeout(left);
    }
    return false;
  }
  count() {
    return this.n;
  }
}

/** 마우스 커서 표식 — 화면 녹화에 클릭 지점이 보이게(실제 커서는 스크린샷에 안 찍힌다) */
export const CURSOR_CSS = `
#__ahcur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
  transform:translate(-50%,-50%);opacity:0;transition:opacity .12s linear}
#__ahcur .d{position:absolute;inset:0;border-radius:50%;background:rgba(124,58,237,.28);
  border:2px solid rgba(124,58,237,.85);box-shadow:0 0 0 2px rgba(255,255,255,.85)}
#__ahcur.on{opacity:1}
#__ahcur.tap .d{animation:__ahtap .42s ease-out}
@keyframes __ahtap{0%{transform:scale(.5);opacity:1}100%{transform:scale(2.1);opacity:0}}
`;

export async function installCursor(page) {
  await page.addStyleTag({ content: CURSOR_CSS });
  await page.evaluate(() => {
    if (document.getElementById("__ahcur")) return;
    const el = document.createElement("div");
    el.id = "__ahcur";
    el.innerHTML = '<div class="d"></div>';
    document.body.appendChild(el);
    window.__ahcur = (x, y, tap) => {
      const c = document.getElementById("__ahcur");
      if (!c) return;
      c.style.left = x + "px";
      c.style.top = y + "px";
      c.classList.add("on");
      if (tap) {
        c.classList.remove("tap");
        void c.offsetWidth;
        c.classList.add("tap");
      }
    };
    window.__ahcurOff = () => document.getElementById("__ahcur")?.classList.remove("on");
  });
}

/** 커서를 목표까지 부드럽게 옮기며 프레임을 남긴다 */
export async function glide(rec, x, y, steps = 6) {
  const page = rec.page;
  const from = rec._cur || { x: VIEW.width / 2, y: VIEW.height - 40 };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = from.x + (x - from.x) * t;
    const cy = from.y + (y - from.y) * t;
    await page.mouse.move(cx, cy);
    await page.evaluate(([a, b]) => window.__ahcur?.(a, b, false), [cx, cy]);
    await rec.shot();
  }
  rec._cur = { x, y };
}

/** 이동 → 탭 표식 → 실제 클릭 */
export async function tap(rec, x, y, { steps = 6, after = 2 } = {}) {
  await glide(rec, x, y, steps);
  await rec.page.evaluate(([a, b]) => window.__ahcur?.(a, b, true), [x, y]);
  await rec.shot();
  await rec.page.mouse.click(x, y);
  for (let i = 0; i < after; i++) await rec.shot();
}

export async function centerOf(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`boundingBox 없음: ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export async function launch({ dialogs = "accept" } = {}) {
  const browser = await chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, locale: "ko-KR" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => (dialogs === "accept" ? d.accept() : d.dismiss()));
  return { browser, ctx, page };
}
