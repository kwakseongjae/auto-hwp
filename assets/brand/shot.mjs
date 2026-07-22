// 배너 렌더: banner.html → autohwp-banner.png (2x 스케일 — README 선명도)
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 520 }, deviceScaleFactor: 2 });
await page.goto("file://" + join(here, "banner.html"));
await page.waitForTimeout(400); // 폰트 로드
await page.screenshot({ path: join(here, "autohwp-banner.png") });
await b.close();
console.log("banner ok");
