# 078 — HWPX 차트 파이프라인과 PDF 벡터 객체

- 상태: **research-complete / implementation-open** (2026-07-28)
- 우선순위: **P1 (충실도)**
- 영역: `hwp-hwpx` → `hwp-core`/`hwp-rhwp` → `hwp-render` → `hwp-export`

## 정정된 근거

과거 “HWPX 차트 코퍼스 0건” 판정은 현재 vendored rhwp 기준으로 낡았다.
`external/rhwp/samples/chart/`에 막대·원·선·분산·주가형을 포함한 **HWPX 28개와 HWP 28개 쌍둥이**가
있다. vendored 디렉터리는 수정하지 않고 테스트 입력으로만 사용한다.

현 상태:

- `.hwp` lift는 OOXML chart part를 `hwp-rhwp::chart_render::chart_svg`로 렌더해 `ChartRef.rendered_svg`에
  넣는다.
- 자체 `hwp-hwpx` 파서는 구조 태그를 non-simple로만 표시해 `hp:chart chartIDRef`와
  `Chart/chartN.xml`을 IR에 올리지 않는다. 원본 package는 verbatim round-trip되지만 화면에서는 사라진다.
- `PaintOp::Image.svg`는 SVG/HTML 화면에는 보이지만 `hwp-export/src/pdf.rs`가 `svg`를 무시해 PDF에서는
  스텁 박스를 그린다. 이는 차트뿐 아니라 모든 vector object의 backend gap이다.

## 결정

1. `hwp-hwpx`는 rhwp-free를 유지하며 `hp:switch/hp:chart`의 id·크기와 chart part 원문만 IR/bin-data에
   올린다. 소스 span과 non-simple 표시는 유지해 무편집 export moat를 지킨다.
2. `hwp-rhwp::chart_render::chart_svg`는 현재 `pub(crate)`이므로, 먼저 bytes→SVG를 노출하는 좁은
   public helper를 `hwp-rhwp`에 추가한 뒤 `hwp-core` enrichment 단계가 이를 호출해 SVG를 채운다.
   `hwp-hwpx → rhwp` 직접 의존은 만들지 않는다.
3. PDF는 차트 전용 특례가 아니라 `PaintOp::Image.svg` 공통 lowering으로 해결한다.
4. 우선 SVG path/text를 krilla primitive로 내리는 vector 경로를 평가한다. `resvg` raster fallback은 wasm
   크기·결정성·골든 바이트 비용을 실측한 뒤에만 채택한다.

## 수용 기준

- [ ] 28 HWPX 중 막대/원/선/분산/주가형 최소 1개씩 화면에 실제 차트를 렌더한다.
- [ ] 같은 HWP/HWPX 쌍의 chart bounds와 series/category 수가 일치한다.
- [ ] 무편집 HWPX는 chart part와 section XML을 byte-verbatim으로 보존한다.
- [ ] PDF에 스텁이 아닌 차트가 나오며 페이지 수와 LOCKSTEP이 불변이다.
- [ ] wasm raw/gzip 크기 증분, PDF 생성 시간, 결정적 골든을 기록해 backend를 선택한다.
- [ ] `external/rhwp`에는 변경을 가하지 않는다.
