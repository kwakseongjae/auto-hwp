import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * apps/hwp-lab — 독립 Next.js 앱 (issue 019). tf-hwp 루트에 npm workspace를 만들지 않으며,
 * `@tf-hwp/react` / `@tf-hwp/engine`를 `file:` 의존으로만 소비한다(package.json 참고).
 *
 * 이슈 §함정 반영:
 *  - `file:` 의존은 npm 심링크 → node_modules/@tf-hwp/* 가 ../../packages/* 를 가리킨다.
 *    Next가 심링크 실제경로를 따라가 워크스페이스 밖으로 나가면 모듈 해석/트랜스파일 스코프가
 *    깨질 수 있으므로 transpilePackages + resolve.symlinks=false 로 잡는다.
 *  - wasm 은 번들러 import 마법을 쓰지 않는다. WasmAdapter 는 런타임에 /hwp/hwp_wasm_bg.wasm
 *    (public 정적 에셋, copy-wasm.mjs가 채움)를 명시적 URL로 fetch한다. 엔진 글루의
 *    `new URL('hwp_wasm_bg.wasm', import.meta.url)` 기본 경로는 절대 타지 않으므로, 그 글루
 *    모듈에 대해 webpack 의 `new URL()` 에셋 방출(parser.url)을 꺼서 11.5MB wasm 을 번들에
 *    끌어넣지 않도록 한다.
 */
const nextConfig = {
  // file: 심링크 패키지를 Next가 트랜스파일하도록 명시. (026: ai-protocol 은 route.ts·클라 양쪽에서
  // import, editor-core 는 react 가 re-export 하는 타입 소스 — 둘 다 심링크 스코프에 넣는다.)
  transpilePackages: ["@tf-hwp/react", "@tf-hwp/engine", "@tf-hwp/ai-protocol", "@tf-hwp/editor-core"],
  // file: 의존은 모노레포 루트(../../) 밖이 아니라 그 안에 산다. 파일 트레이싱 루트를 레포
  // 루트로 고정해 심링크 추적/멀티 lockfile 경고를 정리한다.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  webpack: (config) => {
    // 심링크를 따라가지 말고 node_modules/@tf-hwp/* 경로 그대로 해석 → transpilePackages 스코프
    // 와 모듈 해석을 안정화한다(이슈 §함정).
    config.resolve.symlinks = false;
    // 엔진 wasm-bindgen 글루의 `new URL('hwp_wasm_bg.wasm', import.meta.url)`(기본 init 경로)에
    // 대한 webpack 의 URL 에셋 방출을 끈다. 우리는 그 기본을 절대 쓰지 않고(항상 명시적 public
    // URL로 fetch) — 이 스위치가 없으면 webpack이 11.5MB wasm을 클라이언트 번들에 중복 방출한다.
    config.module.rules.push({
      test: /hwp_wasm\.js$/,
      parser: { url: false },
    });
    return config;
  },
};

export default nextConfig;
