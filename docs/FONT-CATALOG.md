# 폰트 카탈로그 (issue 022, 폰트 시스템 v1)

이 문서는 auto-hwp 의 **큐레이션 폰트 카탈로그**와 그 **라이선스 표**다.
[`docs/LICENSE-POLICY.md` §폰트 재배포(R8)](LICENSE-POLICY.md) 의 하위 문서로, 그 정책의 구체적
적용이다.

## R8 하드 게이트 (이 이슈의 실패 조건)

> **카탈로그의 전 항목은 재배포 가능 라이선스(SIL Open Font License, OFL)여야 한다.**
> 재배포 조항이 불명확한 폰트(눈누 수록 다수의 기업 배포 폰트 포함)는 **카탈로그에서 제외**한다.
> 위반 시 이 이슈는 실패로 간주한다.

- **번들 vs 주입**: 레포에 바이너리로 커밋되는 폰트는 **기본 NanumGothic(Regular/Bold)** 하나뿐이며,
  `assets/fonts/` 에 **OFL.txt 원문과 함께** 동봉되어 있다(재배포 적법성 확인됨). 나머지 카탈로그
  폰트는 레포에 커밋하지 않고 `apps/hwp-lab/scripts/fetch-fonts.mjs` 로 **개발 시점에** 공식
  저장소에서 내려받아 `public/fonts/`(git 제외)에 둔다. 그래도 각 폰트는 OFL 이라 호스트가 자체
  서빙/임베딩해도 적법하다.
- **왜 OFL 만인가**: OFL 은 임베딩(문서/PDF)·번들·재배포·수정을 모두 허용한다(단독 판매·`Reserved
  Font Name` 제약 제외). PDF 임베딩(krilla 서브셋)과 웹 @font-face 서빙이 모두 합법이다.
- **함초롬/한컴 계열은 카탈로그에 없다**: 함초롬바탕/함초롬돋움 및 한컴 번들 폰트는 재배포·임베딩
  라이선스가 없어 제외한다(법적 리스크는 롤백 불가 — LICENSE-POLICY R8).

## 카탈로그 (전 항목 OFL — 재배포/임베딩 허용)

| 폰트(family) | 한글 라벨 | 라이선스 | 공급 | 저작권자 | 공식 소스(원문 링크) | 라이선스 원문(OFL) |
|---|---|---|---|---|---|---|
| Nanum Gothic | 나눔고딕 | **OFL 1.1** | 레포 번들(`assets/fonts/`) | NAVER Corp. | https://github.com/google/fonts/tree/main/ofl/nanumgothic | `assets/fonts/OFL.txt` (동봉) · https://github.com/google/fonts/blob/main/ofl/nanumgothic/OFL.txt |
| Nanum Myeongjo | 나눔명조 | **OFL 1.1** | fetch | NAVER Corp. | https://github.com/google/fonts/tree/main/ofl/nanummyeongjo | https://github.com/google/fonts/blob/main/ofl/nanummyeongjo/OFL.txt |
| Noto Sans KR | 본고딕 | **OFL 1.1** | fetch | Google / Adobe (Noto CJK) | https://github.com/notofonts/noto-cjk | https://github.com/google/fonts/blob/main/ofl/notosanskr/OFL.txt |
| Noto Serif KR | 본명조 | **OFL 1.1** | fetch | Google / Adobe (Noto CJK) | https://github.com/notofonts/noto-cjk | https://github.com/google/fonts/blob/main/ofl/notoserifkr/OFL.txt |
| IBM Plex Sans KR | IBM Plex Sans KR | **OFL 1.1** | fetch | IBM Corp. | https://github.com/IBM/plex | https://github.com/google/fonts/blob/main/ofl/ibmplexsanskr/OFL.txt |
| Gowun Dodum | 고운돋움 | **OFL 1.1** | fetch | The Gowun Batang/Dodum Project Authors (project by Yangchun Studio) | https://github.com/google/fonts/tree/main/ofl/gowundodum | https://github.com/google/fonts/blob/main/ofl/gowundodum/OFL.txt |
| Gowun Batang | 고운바탕 | **OFL 1.1** | fetch | The Gowun Batang/Dodum Project Authors | https://github.com/google/fonts/tree/main/ofl/gowunbatang | https://github.com/google/fonts/blob/main/ofl/gowunbatang/OFL.txt |
| Pretendard | 프리텐다드 | **OFL 1.1** | fetch | Kil Hyung-jin (orioncactus) | https://github.com/orioncactus/pretendard | https://github.com/orioncactus/pretendard/blob/main/LICENSE |

> 재배포 불가/라이선스 불명 폰트: **0개** (R8 충족).

## 다운로드 소스 고정 (URL + sha256)

`apps/hwp-lab/scripts/fetch-fonts.mjs` 가 아래 URL 에서 내려받고 **sha256 을 검증**한다(변조/URL 변경
가드). 다운로드물은 `apps/hwp-lab/public/fonts/`(**git 제외**)에 저장되며, 레포에 커밋되지 않는다.

| 파일 | URL | sha256 |
|---|---|---|
| NanumMyeongjo-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/NanumMyeongjo-Regular.ttf` | `7ed9e8653a8ed04285d51dc343ffea6eb3d9c73afc27383ea8929ee4ffd03205` |
| NotoSansKR-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR[wght].ttf` | `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252` |
| NotoSerifKR-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/notoserifkr/NotoSerifKR[wght].ttf` | `11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3` |
| IBMPlexSansKR-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsanskr/IBMPlexSansKR-Regular.ttf` | `53750379270312368cf7641901f43a98dd892e3d9d5798cf25cdc245c85c71c0` |
| GowunDodum-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/gowundodum/GowunDodum-Regular.ttf` | `a6e457933227483a11758fd0947bc74422a106d46f0bf057fdaa5af94a30067d` |
| GowunBatang-Regular.ttf | `raw.githubusercontent.com/google/fonts/main/ofl/gowunbatang/GowunBatang-Regular.ttf` | `466c593e7147412e748af4856d5ad14709b5a860bdf62b9c2546f2c5874e9849` |
| Pretendard-Regular.otf | `raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/Pretendard-Regular.otf` | `3ffbacde6ab8411f1d2db54bb9b1f0b3ee2a738932033722cf0388c06aed1c93` |

> Noto Sans/Serif KR 은 google/fonts 상 **가변 폰트**(`NotoSansKR[wght].ttf`)로 배포된다 —
> fetch 스크립트가 `NotoSansKR-Regular.ttf` 라는 이름으로 저장하며, @font-face 는 가변 폰트의 기본
> 인스턴스(Regular)로 렌더한다.

## 카탈로그 소스 코드 (단일 출처)

- 카탈로그의 프로그램적 정의: `packages/react/src/fonts.ts` 의 `FONT_CATALOG` (family/label/file/source).
  이 문서의 표와 일치해야 한다.
- 기본 폰트 복사: `apps/hwp-lab/scripts/copy-fonts.mjs` (레포 자산 NanumGothic → `public/fonts/`,
  오프라인 보장). prebuild/predev 훅에 포함.
- 다운로드: `apps/hwp-lab/scripts/fetch-fonts.mjs` (`npm run fetch-fonts`).

## 폰트가 세 곳에 동일하게 적용되는 이유 (issue 022 요지)

호스트가 `HwpDoc.registerFont(family, bytes)` 로 **한 벌의 바이트**를 주입하면:
1. **조판 메트릭** — `hwp-typeset::RealFontMetrics::from_bytes` (rustybuzz/ttf-parser 바이트 파싱)로
   줄바꿈·쪽수를 계산한다(웹 셰이퍼 ON).
2. **PDF 임베드** — krilla 가 같은 바이트를 서브셋해 임베드한다(issue 018).
3. **화면 SVG** — 랩/react 가 같은 바이트로 `@font-face` 를 만들고, 문서 폰트명을 그 폰트로 별칭
   (`packages/react/src/fonts.ts::buildFontFaceCss`).

→ 화면·조판·PDF 가 **동일 폰트**로 일치한다. 미주입 상태에서는 결정적 근사 메트릭
(`ApproxFontMetrics`)으로 레이아웃만 유지하고 PDF 는 `font_missing` 에러를 던진다(R8).

## 카탈로그 온디맨드 제공 (2026-07-22 — "선호 폰트 미리 준비" 방향)

리본 서체 피커/AI(SetCharFmt)가 **카탈로그 family 를 명시 지정**하면 앱이 그 face 를
fetch→`registerFont`(추가 family — 본문 메트릭 face 유지)하고 화면 `@font-face` 를 바인딩한다
(`HwpWorkspace.ensureCatalogFont`). 엔진의 **explicit-family bypass** 와 한 쌍: 등록된 이름과
일치하는 명시 지정은 058 대체를 우회해 자기 이름 그대로 stamp 되고(`place.rs::display_font` +
`FontMetricsProvider::has_family`), PDF 는 그 family 의 face 를 그대로 임베드한다
(`pdf.rs EmbedFont.extra` per-family 매치). → **Pretendard/Noto Sans·Serif KR 등 카탈로그 8종
(전부 OFL)이 화면·PDF 에 실서체로 반영**된다. 문서 고유 서체명(함초롬 등)은 등록되지 않는 한
매치되지 않아 기존 대체 경로 그대로(게이트·골든 불변).

## 서체 충실도 대체 매핑 (issue 058)

issue 022 는 "전 문서 폰트명 → 현재 선택 폰트 1개"였다(전 문서가 단일 NanumGothic 렌더). issue 058 은
문서의 **명조/고딕 구분**을 대체 face 로 라우팅해 화면·PDF 가 실서체 계열을 구분 렌더한다.

- **분류 → 대체(단일 출처)**: `crates/hwp-model/src/font_class.rs` (`classify`/`substitute_family`).
  이름 휴리스틱으로 문서 face 를 분류한다 — `바탕/명조/궁서/Batang/Myeongjo/Serif/Times…` → **명조(serif)**,
  `돋움/고딕/굴림/Dotum/Gulim/Gothic/맑은 고딕/Arial/Pretendard…` → **고딕**, 그 외 → 기타(고딕 취급).
  React 미러: `packages/react/src/fonts.ts::classifyFont`/`substituteFamily` (반드시 Rust 와 동기).
- **대체 세트(OFL 만, 재배포 불가 폰트 0)**:
  - 명조(serif) → **Nanum Myeongjo(나눔명조)** — 정적 OFL TTF(krilla 서브셋 친화, 번들 NanumGothic 과
    한 가족). 위 카탈로그/`fetch-fonts.mjs` 에 이미 수록(sha256 고정).
  - 고딕/기타 → **NanumGothic** — 이미 번들된 보편 폴백. 명시 대체 face 없음(058 전과 렌더 동일 →
    골든 바이트 불변).
  - **함초롬/한컴 계열 번들 0** 유지. 사용자가 자기 함초롬을 업로드하면(재배포 아님) 그 이름으로
    등록되어 대체를 우회한다.
- **적용 지점(글리프 x 소유 → 화면·PDF 자동 추종)**:
  - own-render SVG: `place::paragraph_glyphs` 가 per-script 문서 face(`CharShape.fonts`)를 분류해
    `PlacedGlyph.font` 에 대체 family 를 stamp → SVG `<text font-family>` 가 명조는 `Nanum Myeongjo`.
  - PDF: `hwp-export/src/pdf.rs` 가 명조 글리프를 serif face(주입 `Nanum Myeongjo` / 네이티브
    AppleMyungjo·Noto Serif CJK)로 그린다.
  - 화면: `buildFontFaceCss(family, url, { serifUrl })` 가 `Nanum Myeongjo` `@font-face` 를 바인딩하고,
    속성 셀렉터(`text[font-family^="Nanum Myeongjo"]`)로 022 의 일괄 collapse 를 이겨 명조↔고딕 구분을
    보존한다. serifUrl 미배치/오프라인이면 SVG 폴백이 NanumGothic 으로 떨어지는 안전한 no-op.
- **게이트 불변(V5)**: 대체는 **디스플레이 전용** — 조판 메트릭(advance)은 family-blind 그대로다
  (전각 Hangul 은 face 무관 EM 격자). `layout-check` 쪽수 게이트(benchmark 8==8 · benchmark1 18==18)
  는 영향 없음(SVG 는 `font-family` 속성만 바뀌고 글리프 x 는 바이트 동일).
