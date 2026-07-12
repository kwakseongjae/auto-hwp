# 058 — 폰트 충실도: 문서 서체 → OFL 대체 매핑 레이어

- 상태: open · 우선순위: R13-P1 · 영역: crates/hwp-typeset(shaper) + hwp-model(FaceName typeInfo) + packages/react(카탈로그)
- 근거: 2026-07-11 리서치. 현재 전 문서가 주입된 단일 face(NanumGothic)로 렌더 → 실서체(함초롬바탕/돋움=재배포 불가)와 무관.

## 핵심 발견 (레포 사실 — 설계가 유리하다)
- `FontMetricsProvider::advance_width(font: &FontKey{family,bold,italic}, ch, size)`가 **이미 문서 폰트명을 메트릭 질의까지 전달**(`crates/hwp-model/src/capability.rs:37-45`). 병목은 `RealFontMetrics`(`crates/hwp-typeset/src/shaper.rs`)가 이를 **무시**하고 CJK 1슬롯+Latin 1슬롯으로만 라우팅하는 것.
- per-script 폰트 이름이 모델에 이미 존재: `CharShape.fonts: Vec<Option<String>>`(7 스크립트 슬롯, `hwp-model/src/style.rs:89-94`), HWP5에서 `doc_info.font_faces`로 리프트(`hwp-rhwp/src/lift.rs:772-780`).
- PDF·SVG 모두 **글리프 단위 절대 x 배치**(pdf.rs `paint_glyph`, render lib.rs per-glyph `<text>`) → 메트릭 보정은 **`RealFontMetrics` 한 곳만 고치면 화면·PDF 자동 추종**.
- 미비: HWP5 FaceName의 PANOSE/typeInfo(명조/고딕 분류 힌트) 미파싱(HWPX synth도 빈 `<hh:typeInfo/>`). React에 OFL 8종 카탈로그(`packages/react/src/fonts.ts`) 이미 존재.

## 설계 (단계별)
1. **매핑 레이어**: 문서 face 이름 → 카테고리(명조/고딕/굵기) → 번들 OFL face 라우팅. 분류 소스: (a) FaceName typeInfo 파싱(신규), (b) 이름 휴리스틱("바탕/명조/Serif"→명조, "돋움/고딕/Gothic"→고딕). `RealFontMetrics`에 face별 메트릭 슬롯 다중화.
2. **권장 대체 세트(OFL, 재배포 가능)**: 명조계=본명조(Noto Serif KR), 고딕계=Pretendard 또는 본고딕(Noto Sans KR), 폴백=Noto(옛한글/한자/기호). 굵기별 face.
3. **메트릭 보정**: 대체 advance가 원본과 다를 때 — CSS `size-adjust`/`ascent-override` 관행을 own-render/krilla에 적용(글리프 x를 소유하므로 스케일 팩터 1개로 흡수 가능).
4. **사용자 폰트 업로드**: 사용자가 자기 함초롬 폰트 업로드(재배포 아님) 또는 Local Font Access API(Chromium)로 시스템 폰트 read → registerFont. 브라우저 지원/권한 제약 문서화.

## 수용 기준
- [x] 문서가 명조/고딕을 섞어 쓰면 화면·PDF도 대응 대체 face로 구분 렌더(현재는 전부 Nanum)
      — own-render SVG: benchmark 661 글리프·benchmark1 2356 글리프가 명조로 라우팅(나머지 고딕).
      네이티브 PDF: AppleMyungjo(serif) + NanumGothic(gothic) 동시 임베드 확인.
- [x] 게이트 8==8·18==18 불변 — **디스플레이 전용**이라 metric family-blind 유지(글리프 x 바이트 동일;
      SVG는 `font-family` 속성만 변경). 측정 완료(§구현).
- [x] 라이선스: 대체 face 전부 OFL(Nanum Myeongjo·NanumGothic), 함초롬 번들 0. deny licenses ok,
      LICENSE-POLICY.md/FONT-CATALOG.md 갱신. (신규 커밋 폰트/crate 0 — Nanum Myeongjo는 기존 fetch 카탈로그.)

## 구현 (v1, 2026-07-13)
- **매핑 레이어(단일 출처)**: `crates/hwp-model/src/font_class.rs` — `classify(name)`(이름 휴리스틱) +
  `substitute_family(name)`(명조 → `Nanum Myeongjo`, 고딕/기타 → None=기본 고딕). React 미러:
  `packages/react/src/fonts.ts::classifyFont`/`substituteFamily`.
- **적용(글리프 x 소유 → 화면·PDF 자동 추종)**:
  - own-render: `place::paragraph_glyphs` 가 per-script `CharShape.fonts` 를 분류해 `PlacedGlyph.font`
    에 대체 family stamp(디스플레이 전용, advance 불변).
  - PDF: `hwp-export/src/pdf.rs` `EmbedFont.serif` 슬롯(네이티브 discover=AppleMyungjo/Noto Serif,
    wasm=주입 `Nanum Myeongjo`) + `paint_glyph` 명조 라우팅. `HwpDoc.registerFont` 는 family 별
    누적(첫 face=body=메트릭, 서프=추가).
  - 화면: `buildFontFaceCss(.., { serifUrl })` 가 serif `@font-face` + 속성 셀렉터 override(022 collapse
    보다 specificity 우위)로 명조↔고딕 보존. 랩은 `injectSerifSubstitute` 로 PDF용 serif 도 주입.
- **v1 스코프 밖(후속)**: (a) advance 레벨 메트릭 보정(size-adjust) — 게이트 리스크(V5)라 v1은 metric
  family-blind 유지; (b) FaceName PANOSE/typeInfo 파싱(현재 이름 휴리스틱만); (c) 사용자 폰트 업로드는
  기존 FontPicker 업로드 경로로 커버(Local Font Access는 Chromium 한정 — 스코프 밖).

## 함정
- 메트릭 변경은 게이트 리스크(V5류) — **v1은 디스플레이 전용**으로 회피(metric 무변경 → 게이트 무영향 증빙).
- FaceName typeInfo 파싱은 rhwp 경유(vendored 수정 금지 — 어댑터에서). v1은 이름 휴리스틱만 사용.
- 사용자 폰트 = 재배포 아님(약관 명시), 시스템 폰트 API는 Chromium 한정(폴백 필요).
