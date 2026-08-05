// 히어로 렌더: hero.html(+hero-scene.png) → autohwp-hero.raw.png (2560x840 @2x)
//
// 장면(hero-scene.png)은 codex CLI(gpt-image)로 생성한 candidates/cand-d.png 의
// 콘텐츠 bbox(1496,84,2441,780) 크롭이다. cand-d 는 배경이 정확히 단색 #f5f6fb(--ah-bg)라
// 캔버스에 이음매 없이 얹힌다. candidates/*.png 는 리뷰용 축소본이므로, 크롭 원본은
// 이 폴더의 hero-scene.png 가 정본이다.
//
// ⚠️ 워드마크("오토한글")는 생성모델이 아니라 실폰트로 합성한다 — gpt-image 계열의 한글
//    글자 렌더는 오타/깨짐 위험이 크다. 타이포는 라이브 랜딩 라이트 토큰을 그대로 쓴다.
//
// 실행:  node assets/brand/shot-hero.mjs      (레포 어디서 실행해도 됨)
// 이후:  256색 양자화로 500KB 이하 다이어트 → autohwp-hero.png
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// playwright 는 레포 루트에 없고 apps/hwp-lab 에 설치돼 있다 — 명시적으로 해석한다.
const require = createRequire(join(here, "../../apps/hwp-lab/package.json"));
const { chromium } = require("playwright");

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 420 }, deviceScaleFactor: 2 });
await page.goto("file://" + join(here, "hero.html"));
await page.waitForTimeout(600); // 폰트 로드
await page.screenshot({ path: join(here, "autohwp-hero.raw.png") });
await b.close();
console.log("hero rendered → autohwp-hero.raw.png (2560x840)");
