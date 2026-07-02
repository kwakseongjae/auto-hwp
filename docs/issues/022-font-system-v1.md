# 022 — QA-5: 폰트 시스템 v1 — 큐레이션 카탈로그 + 업로드 + 화면·조판·PDF 삼위일치

- 상태: **open**
- 우선순위: P1 (QA 라운드 1) — "PDF를 읽는 사람이 위화감을 느끼면 안 된다"의 기술적 본체
- 영역: hwp-typeset(shaper)/hwp-session/hwp-wasm (엔진) + packages/react + apps/hwp-lab (UI)
- 선행: 018 (done), **020·021 병합 후 착수** (hwp-typeset·hwp-session·hwp-wasm 파일 경합 방지)
- 레드팀: **R8** (재배포 가능 라이선스만 — 이 이슈의 하드 게이트)

## 사용자 QA 관찰 (2026-07-02)
폰트가 "사용자가 직접 고르는" 수준을 넘어서: **①구글 폰트·눈누 계열의 무료 상용 한글 폰트를
큐레이션해 고르면 바로 적용**, **②필요 시 사용자가 폰트 파일 업로드**. 결과물 PDF에서 한국어
독자가 위화감을 느끼지 않아야 한다.

## 아키텍트 진단 — "위화감"의 세 층위 (전부 잡아야 완성)
1. **화면(SVG)**: own-render SVG의 `font-family`는 문서 폰트명(함초롬바탕 등) — 브라우저에
   그 폰트가 없어 시스템 폰트로 대체됨 → 화면과 PDF가 다르게 보임. **@font-face 로딩 +
   문서 폰트명→선택 폰트 별칭(alias) 매핑**이 필요.
2. **조판(레이아웃 메트릭)**: 현재 wasm은 **셰이퍼 없이(Approx 메트릭)** 빌드된다(015의 의도적
   결정 — RealFontMetrics가 `std::fs`로 폰트를 읽어 wasm에서 조용히 무너지기 때문). 데스크톱
   (rustybuzz, 98.9%)과 웹의 줄바꿈이 다를 수 있다. **메트릭도 바이트 주입**으로 셰이퍼를 웹에서
   켠다 — 018이 PDF에 한 것과 정확히 같은 패턴을 조판에 적용.
3. **PDF 임베드**: 018로 이미 해결(registerFont→krilla). 이 이슈에서 폰트 선택 UI와 연결만.

## 목표
사용자가 카탈로그에서 폰트를 고르거나 업로드하면 → **화면 SVG·조판 메트릭·PDF 임베드가 같은
폰트 바이트로 일치**한다. 기본값: 레포 자산 `assets/fonts/NanumGothic-Regular.ttf`(+Bold,
**OFL.txt 동봉 — 재배포 적법 확인됨**)을 자동 로드해 업로드 없이도 즉시 자연스러운 화면/PDF.

## 파일 지도
- `crates/hwp-typeset/src/shaper.rs` — RealFontMetrics가 std::fs::read로 폰트 로드(:88 부근) →
  **바이트 기반 생성자 추가** (`from_bytes` 류; 기존 경로 생성자는 무변경)
- `crates/hwp-session/src/lib.rs` — `own_render_fonts_with(injected: &[(String, Vec<u8>)])` 류
  신설(기존 own_render_fonts는 위임/무변경) + render_svg가 주입 메트릭을 쓰는 변형
- `crates/hwp-wasm/Cargo.toml`/`src/lib.rs` — **shaper 피처 활성** + registerFont가 (a)조판 메트릭
  (b)PDF 임베드 양쪽에 공급, 폰트 등록/교체 시 재조판·재렌더 경로
- `packages/engine` — 래퍼/d.ts/README (폰트 등록 후 renderPageSvg 결과가 바뀜을 명시)
- `packages/react/src/components/FontPicker.tsx`(신규) + HwpWorkspace 연결(단, 021이 소유한
  SelectionOverlay는 **수정 금지**)
- `apps/hwp-lab` — 카탈로그 배선, `scripts/fetch-fonts.mjs`(dev-time 다운로드, git 미포함),
  `public/fonts/`(gitignore), 기본 NanumGothic은 `assets/fonts/`에서 copy 스크립트로
- `docs/FONT-CATALOG.md`(신규) — 카탈로그+**라이선스 표**(R8 하드 게이트)

## 카탈로그 v1 (전부 재배포 가능 라이선스만 — 각 항목 라이선스 원문 링크를 docs에 명기)
OFL: Noto Sans KR, Noto Serif KR, Nanum Gothic(레포 자산), Nanum Myeongjo, IBM Plex Sans KR,
Gowun Dodum, Gowun Batang, Pretendard(SIL OFL). ※눈누는 "집합 사이트"라 라이선스가 제각각 —
**개별 폰트의 라이선스를 확인해 OFL/명시적 재배포 허용만** 채택하고, 불명확한 것은 제외한다.
다운로드 소스는 공식 저장소(Google Fonts GitHub/jsDelivr/각 프로젝트 릴리스)로 고정(fetch 스크립트에
URL+sha 기록). 네트워크 불가 시 기본 NanumGothic만으로 동작(카탈로그는 "다운로드 필요" 표시).

## 구현 단계
1. **엔진 — 메트릭 바이트 주입**: shaper.rs에 bytes 생성자(rustybuzz/ttf-parser는 이미 바이트
   파싱이 본체 — fs 부분만 우회). hwp-session `own_render_fonts_with` + 주입-메트릭 render 경로.
   **네이티브 골든**: 기존 경로(discover/fs) 출력은 바이트 불변이어야 한다(018과 동일 규율 —
   변경 전후 own-render/export-pdf 해시 비교).
2. **wasm shaper 켜기**: hwp-wasm에 shaper 피처. registerFont(family, bytes) → 메트릭+PDF 공용
   저장소. 폰트 미등록 상태의 렌더는 기존 Approx 폴백(하위호환). 등록/교체 시 문서 재조판 →
   페이지 수가 바뀔 수 있음을 API 계약에 명시(호스트가 pageCount 재조회).
   **교차 골든(신규)**: 같은 NanumGothic-Regular.ttf 바이트로 — wasm renderPageSvg vs 네이티브
   `own-render --features shaper`(동일 폰트를 쓰도록 유도) 결과 대조. 완전 바이트 일치가 폰트
   발견 경로 차이로 불가하면, 페이지 수+줄수 일치 수준으로 검증하고 사유 보고.
3. **화면 일치**: own-render SVG가 어떤 font-family 문자열을 내는지 실측 → 랩/react에서
   `@font-face`(로드한 폰트 바이트/URL) + 문서 폰트명 별칭 매핑(예: 함초롬바탕→선택 폰트)을
   `<style>` 주입으로 해결. 매핑 규칙은 단순 v1: "모든 문서 폰트명 → 현재 선택 폰트 1개".
4. **FontPicker (react, 신규 컴포넌트)**: 드롭다운(폰트명은 해당 폰트로 미리보기 렌더) + "폰트
   업로드(.ttf/.otf)" + 현재 적용 폰트 표시. 전부 한글 라벨. 선택 시: adapter.registerFont →
   재렌더 트리거 → @font-face 갱신. TTC 거부(명시 에러 — krilla 제약).
5. **랩 배선**: fetch-fonts.mjs(카탈로그 다운로드, sha 검증, public/fonts에 — git 제외),
   copy-wasm.mjs에 기본 NanumGothic 복사 추가(assets/fonts→public/fonts, 이건 레포 자산이라
   오프라인 동작 보장). 열기 직후 기본 폰트 자동 registerFont → PDF 버튼 즉시 활성.
6. **문서**: docs/FONT-CATALOG.md(라이선스 표 — R8), engine/react README 갱신, QA.md ⑥⑦에
   폰트 선택 시나리오 추가.

## 검증
- 네이티브 골든: own-render(무주입)·export-pdf 바이트 불변(변경 전후 해시) + 게이트 8==8 + typeset 테스트
- wasm: `cargo check -p hwp-wasm --target wasm32`(shaper 포함) + 번들 크기 재보고(shaper로 증가분)
- node 스모크: NanumGothic 주입 → benchmark.hwp pageCount(주입 메트릭 기준— 8 유지 확인) +
  renderPageSvg 변화 확인 + exportPdf FontFile2 유지
- vitest: FontPicker 렌더/업로드/에러(TTC) + 기존 무회귀
- Playwright: 스모크에 "기본 폰트 자동 적용 후 PDF 버튼 활성" 단계 추가
- fetch-fonts.mjs: 다운로드+sha 검증 1회 실행 로그 (불가 시 스킵 사유)

## 수용 기준
- [ ] registerFont가 조판 메트릭+PDF 임베드에 공통 적용, 미등록 시 Approx 폴백
- [ ] 네이티브 무주입 경로 바이트 불변(해시) + 게이트 8==8
- [ ] 교차 골든: 동일 폰트 바이트에서 wasm vs 네이티브(shaper) 페이지수·줄수 일치(바이트 일치면 더 좋음)
- [ ] 화면 SVG가 선택 폰트로 표시(@font-face+별칭) — 화면·PDF 시각 일치
- [ ] FontPicker: 카탈로그(전 항목 라이선스 표 완비)+업로드+한글 UI, 기본 NanumGothic 자동 적용
- [ ] docs/FONT-CATALOG.md 라이선스 표 (재배포 불가/불명 폰트 0개)
- [ ] 전 테스트 그린 + Playwright 갱신 통과 + 번들 크기 보고

## 함정
- **R8 하드 게이트**: 눈누 수록 폰트라도 라이선스가 "무료 사용"≠"재배포 허용"인 경우가 많다
  (예: 일부 기업 배포 폰트는 재배포 금지). 재배포 조항을 원문으로 확인 못 하면 카탈로그에서 빼라.
- 메트릭 주입 후 **페이지 수가 문서·폰트에 따라 달라진다** — 이는 버그가 아니라 실메트릭의 결과.
  단 benchmark.hwp+NanumGothic은 8을 유지해야 한다(네이티브 shaper가 그 근방 폰트로 8을 내는
  것과 정합). 크게 어긋나면 메트릭 배선 버그를 의심하라.
- registerFont 교체 시 이전 메트릭 캐시/레이아웃 캐시 무효화를 잊으면 화면·PDF 불일치가 생긴다.
- 020이 typeset을 고치고 있(었)다 — **020 병합 후 리베이스된 최신 main에서 시작**하라.
