# 015 — P4-A: wasm npm 패키지 (`@auto-hwp/engine`)

- 상태: **open**
- 우선순위: P4 (목표 2 후반부 — 사이트 내 엔진 이식)
- 영역: 웹 이식 / 라이브러리화
- 선행: **007 (wasm 판정), 012 (hwp-session), 017 (hwp-mcp wasm화)**. 병렬 가능: 013
- 레드팀: **R6, R8, R9, R13** + wasm 패닉 복구(아래)

## ⚠️ 편집 레인의 출처 (012 LEAF 결정 반영)
편집(Intent 적용/undo/프리뷰)은 hwp-session이 아니라 **hwp-mcp lib** (`default-features = false`,
017 완료 후 wasm-safe)에서 온다: `Session` + `apply_intent_json`(008 계약) + `open_bytes`/
`export_bytes`. hwp-session은 렌더/지오메트리/HTML·PDF export. 바인딩(`HwpDoc`)은 이 둘을 감싼다 —
편집 레인을 재구현하지 마라.

## ⚠️ wasm 패닉 복구 (R4의 웹 변형 — 필수 설계)
014의 rhwp `catch_unwind` 방어는 **wasm32에서 무력**하다(패닉=트랩, 인스턴스 사망). 악성/손상
.hwp가 파서 패닉을 일으키면 wasm 인스턴스째 죽으므로, **JS 래퍼가 모든 호출을 try/catch로 감싸고
RuntimeError 시 인스턴스를 재생성하는 복구 규약**을 npm 패키지에 내장하라(호스트 페이지는 죽지
않음 — 문서 상태만 소실되므로 "다시 열기" UX로 수렴). README에 명시.

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
1. **바인딩 표면 (얇게, JSON in/out — 편집은 hwp-mcp 레인 그대로)**:
   ```
   class HwpDoc {
     static open(bytes: Uint8Array, name?: string): HwpDoc  // .hwp/.hwpx 자동 감지 (hwp_mcp::open_bytes)
     pageCount(): number
     renderPageSvg(n: number): string             // sanitize는 016의 책임 — README에 명시
     hitTest(page: number, x: number, y: number): string /*JSON*/
     tableAt(page: number, x: number, y: number): string /*JSON — 마킹용*/
     applyIntent(intentJson: string): string      /*hwp_mcp::apply_intent_json — Propose/Commit/Undo 포함*/
     undo(): boolean; redo(): boolean
     registerFont(family: string, bytes: Uint8Array): void
     exportPdf(): Uint8Array
     exportHtml(): string
     toHwpx(): Uint8Array                          // hwp_mcp::export_bytes
     free(): void
   }
   ```
   에러는 전부 JS 예외로 던지되 `{ code, message }` 구조 유지(014의 typed 에러를 그대로 태움).
   hwp-mcp는 `default-features = false`로 소비(017), 렌더/지오메트리는 hwp-session.
2. **번들링 (wasm-pack 미설치 환경 — 레시피 고정)**: crates/hwp-wasm에 `wasm-bindgen`
   의존을 추가한 뒤, **그 정확한 버전으로** `cargo install wasm-bindgen-cli --version <동일버전>`
   (crates.io 소스 빌드 — GitHub 불필요). 빌드:
   `cargo build -p hwp-wasm --release --target wasm32-unknown-unknown` →
   `wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm`.
   wasm-opt(binaryen)는 없으면 스킵하고 "미최적화 크기"로 보고. cargo install까지 불가한
   오프라인이면 crates/hwp-wasm(cargo check wasm 그린)+packages 스캐폴드까지 완성하고
   번들링만 partial로 정직 보고. 크기 기록(목표: gzip 3MB 이하, 폰트 제외).
3. **메모리 위생(R13)**: 문서 교체 시 이전 인스턴스 free를 강제하는 API 설계
   (open은 정적 생성자 — 호스트가 free를 잊으면 누수. README에 수명 규약 명시,
   가능하면 `FinalizationRegistry` 안전망). + wasm 패닉 복구(위 §참조)를 JS 로더에 내장.
4. **데모 페이지 = 창업지원도움e PoC 1호 시나리오** (`packages/engine/demo/index.html`,
   순수 HTML/JS — 016과 분리 검증용). **이 데모가 018 통합의 원형이다**:
   ① 파일 입력으로 .hwp **또는** .hwpx 업로드 → ② 전 페이지 SVG 렌더(sanitize 경유) →
   ③ 페이지 클릭 → hitTest/tableAt으로 셀 좌표 표시(마킹) → ④ intent JSON 입력창
   (SetTableCell 프리필 예제 제공) → applyIntent → 재렌더 → ⑤ undo 버튼 →
   ⑥ "PDF 다운로드"(Noto Sans KR fetch→registerFont→exportPdf→Blob) + "HTML 다운로드".
   LLM은 데모에 없음(호스트 몫) — intent 입력창이 프록시 응답의 대역이다.
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
