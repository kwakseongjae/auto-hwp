# 015 — P4-A: wasm npm 패키지 (`@tf-hwp/engine`)

- 상태: **open**
- 우선순위: P4 (목표 2 후반부 — 사이트 내 엔진 이식)
- 영역: 웹 이식 / 라이브러리화
- 선행: **007 (wasm 판정), 012 (hwp-session)**. 병렬 가능: 013
- 레드팀: **R6, R8, R9, R13**

## 전제 (007 판정 완료 — 2026-07-02: **A안**)
- **007 판정 = A안 (전 코어 11/11 wasm32 컴파일 통과)**. rhwp(HWP5 파싱)와 krilla(PDF)
  모두 wasm으로 컴파일된다. getrandom은 어느 closure에도 없다. 근거·판정표는
  `docs/WASM-FEASIBILITY.md`.
- 따라서:
  - **`open_hwp`(=.hwp 직접 열기)를 바인딩 표면에 추가하라** — 웹 v1은 HWPX 전용에
    묶이지 않는다. HWPX 변환을 013 서비스에 의존할 필요 없음(B안 폐기).
  - **PDF export는 wasm 안에서 수행**(krilla in-wasm). 서비스 경유 강등 불필요(C안 폐기).
    §단계 5(폰트 주입 PDF)는 그대로 수행.
- 단, **컴파일 통과 ≠ 런타임 안전**: 폰트 로딩이 `std::fs::read`(hwp-typeset/src/shaper.rs,
  hwp-export/src/pdf.rs)라 wasm 런타임에서 트랩한다. 폰트는 반드시 **바이트 주입**
  (`register_font(bytes)`)으로 설계할 것(R8과 동일 방향). `cfb 0.14`가 `Instant`를
  `web-time`으로 우회하므로 Instant 런타임 트랩은 rhwp CFB 경로엔 해당 없음.

## 목표
`hwp-session`(012)을 wasm-bindgen으로 감싸 **브라우저에서 열기→렌더(SVG)→편집(Intent)
→PDF 바이트**가 도는 npm 패키지를 만든다. LLM 호출은 패키지에 **넣지 않는다** —
AI 티키타카는 호스트 앱이 서버사이드에서 수행하고, 결과 Intent만 wasm에 적용한다(R6).

## 컨텍스트
- 렌더 출력이 SVG **문자열**이므로 캔버스/DOM 의존이 없다 — wasm 경계가 깨끗하다.
- Intent JSON(008)이 이미 직렬화 계약이다 — wasm 경계도 같은 JSON을 쓰면 바인딩이 얇아진다.
- PDF(krilla)는 폰트가 필요하다. 폰트는 **번들이 아니라 주입**으로 설계한다(R8):
  호스트가 폰트 바이트(예: Noto Sans KR woff2→ttf)를 `register_font()`로 넣는다.
  이렇게 하면 패키지 자체는 폰트를 재배포하지 않는다.

## 파일 지도
- 신규: `crates/hwp-wasm/` (wasm-bindgen 바인딩, cdylib)
- 신규: `packages/engine/` (npm 래퍼: 타입 정의, wasm 로더, README)
- 참조: `crates/hwp-session/src/lib.rs` (표면), `docs/INTENT-SCHEMA.md` (계약)
- 갱신: `docs/LICENSE-POLICY.md` (폰트 재배포 정책 — R8)

## 구현 단계
1. **바인딩 표면 (얇게, JSON in/out)**:
   ```
   class HwpDoc {
     static openHwpx(bytes: Uint8Array): HwpDoc   // throws typed error
     pageCount(): number
     renderPageSvg(n: number): string             // sanitize는 016의 책임 — README에 명시
     hitTest(page: number, x: number, y: number): string /*JSON*/
     apply(intentJson: string): string            /*JSON: ok|error, 영향 블록*/
     undo(): boolean; redo(): boolean
     registerFont(family: string, bytes: Uint8Array): void
     exportPdf(): Uint8Array
     exportHtml(): string
     toHwpx(): Uint8Array                          // 저장
     free(): void
   }
   ```
   에러는 전부 JS 예외로 던지되 `{ code, message }` 구조 유지(014의 typed 에러를 그대로 태움).
2. **wasm-pack 빌드**: `wasm-pack build --target web`. `packages/engine`에서 wasm 산출물을
   감싸 npm 패키지화(로더 + .d.ts + README). 번들 크기를 보고에 기록(목표: gzip 3MB 이하,
   폰트 제외 — 초과 시 원인 크레이트를 `twiggy`/`wasm-opt`로 분석해 보고).
3. **메모리 위생(R13)**: 문서 교체 시 이전 인스턴스 free를 강제하는 API 설계
   (openHwpx는 정적 생성자 — 호스트가 free를 잊으면 누수. README에 수명 규약 명시,
   가능하면 `FinalizationRegistry` 안전망).
4. **데모 페이지**: `packages/engine/demo/index.html` — 파일 입력으로 .hwpx 열기 →
   페이지 SVG 표시 → intent JSON 텍스트박스로 apply → PDF 다운로드 버튼.
   프레임워크 없이 순수 HTML/JS (016과 분리 검증용).
5. **PDF 폰트 주입**: 데모에서 Noto Sans KR(OFL)을 fetch해 registerFont → exportPdf →
   한글이 깨지지 않는 PDF 확인. `docs/LICENSE-POLICY.md`에 "번들 금지·주입만,
   OFL 폰트 권장, 함초롬 계열 재배포 불가" 명문화.
6. **골든 교차 검증**: 같은 .hwpx에 대해 wasm `renderPageSvg` 출력과 네이티브 CLI
   `own-render` 출력이 동일한지(해시) 확인 — 다르면 cfg 분기 오염을 의심하라.

## 검증
- `cargo check -p hwp-wasm --target wasm32-unknown-unknown` + wasm-pack 빌드 성공.
- 데모 페이지에서 열기→렌더→apply(셀 텍스트 변경)→PDF 다운로드 완주 (수동, 브라우저).
- wasm/네이티브 SVG 해시 동일. 공통 스위트(§4.2) 무손상.

## 수용 기준
- [ ] npm 패키지 로컬 빌드( `npm pack` ) 가능, .d.ts 포함
- [ ] 데모: 열기→렌더→편집→PDF 완주, 한글 PDF 정상
- [ ] 폰트 비번들(주입 API), LICENSE-POLICY 갱신
- [ ] wasm↔네이티브 렌더 골든 일치
- [ ] 번들 크기 보고 (gzip, 폰트 제외)
- [ ] 네이티브 게이트/테스트 무손상

## 함정
- wasm에서 시간/난수(`std::time::Instant`, getrandom)가 코어에 숨어 있으면 런타임 트랩이
  난다 — 007의 역추적 결과를 먼저 확인하라.
- SVG 문자열을 데모에서 innerHTML로 꽂지 마라 — 데모조차 sanitize 경유(016 전이지만
  최소한 DOMParser+스크립트 태그 제거). "renderPageSvg는 신뢰불가 출력"이 계약이다(R7).
- exportPdf 전 registerFont가 없으면 명시 에러(silent 빈 글리프 금지).
