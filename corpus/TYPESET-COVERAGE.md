# 조판 코퍼스 커버리지 지도

재현: `node scripts/tag-corpus.mjs` (이슈 #71). 생성 2026-08-21. 태그는 파일명 추정이 아니라 `auto-hwp tag-layout`이 파일을 열어 확인한 결과다.

오라클(`layout-check` 줄 단위)이 도는 대상은 **게이트 3건**뿐이고, 나머지 축은 침묵한다. 빈칸 우선순위는 TYPESET-ROADMAP §0의 침묵 축이 먼저다.

## 문서 수

| 수집 | 문서 | 비고 |
|---|---:|---|
| `benchmark` | 4 | |
| `corpus-hwp` | 12 | |
| `corpus-hwpx` | 6 | |
| `hwpxlib` | 49 | |
| `gov` | 11 | |
| **합계** | **82** | ok 81 · fail 1 |

## 태그 분포 (문서 수)

| 축 | 한국어 | 있음 | 없음 |
|---|---|---:|---:|
| `header_footer` | 머리말/꼬리말 | 4 | 78 |
| `form_control` | 폼 컨트롤 | 4 | 78 |
| `mixed_orientation` | 가로세로 혼합 | 0 | 82 |
| `nested_table` | 중첩 표 | 10 | 72 |
| `multipage_table` | 다쪽 표 | 16 | 66 |
| `footnote` | 각주 | 1 | 81 |
| `multicolumn` | 다단 | 2 | 80 |
| `chart` | 차트 | 1 | 81 |
| `equation` | 수식 | 3 | 79 |
| `shape_ole` | 도형/OLE | 33 | 49 |

## 빈칸 (커버리지 0~1건) — 우선순위

| 우선 | 축 | 건수 | 왜 먼저인가 |
|---:|---|---:|---|
| 1 | `mixed_orientation` (가로세로 혼합) | 0 | §0/#42 — 가로·세로 페이지 공존 미적용 |
| 2 | `footnote` (각주) | 1 | T2 후보 — layout-check 확장 축 |
| 3 | `chart` (차트) | 1 | 렌더 스텁/밴드. 오라클 밖 |

## 문서별 태그

| 파일 | 수집 | 오라클 | 태그 |
|---|---|---|---|
| `benchmarks/benchmark.hwp` | benchmark | layout-check-gate | nested_table |
| `benchmarks/benchmark1.hwp` | benchmark | layout-check-gate | nested_table, multipage_table |
| `benchmarks/benchmark1.hwpx` | benchmark | layout-check-hwpx-lock | nested_table, multipage_table |
| `benchmarks/benchmark2.hwp` | benchmark | layout-check-gate | nested_table, multipage_table |
| `corpus/hwp/복학원서.hwp` | corpus-hwp | none | shape_ole |
| `corpus/hwp/한셀OLE.hwp` | corpus-hwp | none | shape_ole |
| `corpus/hwp/draw-group.hwp` | corpus-hwp | none | shape_ole |
| `corpus/hwp/field-01.hwp` | corpus-hwp | none | shape_ole |
| `corpus/hwp/hwp-multi-001.hwp` | corpus-hwp | none | multipage_table, shape_ole |
| `corpus/hwp/issue_265.hwp` | corpus-hwp | none | FAIL: unrecognized or unsupported document format |
| `corpus/hwp/issue-505-equations.hwp` | corpus-hwp | none | equation |
| `corpus/hwp/k-water-rfp.hwp` | corpus-hwp | none | header_footer, nested_table, multipage_table, shape_ole |
| `corpus/hwp/math-001.hwp` | corpus-hwp | none | equation |
| `corpus/hwp/shape-001.hwp` | corpus-hwp | none | shape_ole |
| `corpus/hwp/tac-img-02.hwp` | corpus-hwp | none | nested_table, multipage_table, shape_ole |
| `corpus/hwp/test-image.hwp` | corpus-hwp | none | — |
| `corpus/hwpx/00_smoke_min.hwpx` | corpus-hwpx | none | — |
| `corpus/hwpx/footnote-01.hwpx` | corpus-hwpx | layout-check-hwpx-lock | footnote |
| `corpus/hwpx/form-01.hwpx` | corpus-hwpx | none | form_control |
| `corpus/hwpx/FormattingShowcase.hwpx` | corpus-hwpx | layout-check-hwpx-lock | — |
| `corpus/hwpx/Skeleton.hwpx` | corpus-hwpx | none | — |
| `corpus/hwpxlib_corpus/error/20230413/test.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20230426/HwpxTest1.hwpx` | hwpxlib | none | chart, shape_ole |
| `corpus/hwpxlib_corpus/error/20230728/test.hwpx` | hwpxlib | none | nested_table, multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20230809/test.hwpx` | hwpxlib | none | header_footer, multicolumn, shape_ole |
| `corpus/hwpxlib_corpus/error/20230818/test.hwpx` | hwpxlib | none | nested_table, multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20231219/test1.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20240305/2022.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/error/20240416/presentation오류.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20240626/no_manifest.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20240919/테스트문서.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20241104/mot.hwpx` | hwpxlib | none | multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20250523/프로젝트 계획서.hwpx` | hwpxlib | none | multipage_table |
| `corpus/hwpxlib_corpus/error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx` | hwpxlib | none | header_footer, nested_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20251107/test_re.hwpx` | hwpxlib | none | multipage_table |
| `corpus/hwpxlib_corpus/error/20251107/test.hwpx` | hwpxlib | none | multipage_table |
| `corpus/hwpxlib_corpus/error/20260805/고정폭빈칸_문서.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/error/20260806/표전체 형광색인 경우 오류.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/ChangeTrack.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/HeaderFooter.hwpx` | hwpxlib | none | header_footer |
| `corpus/hwpxlib_corpus/reader_writer/MultiColumn.hwpx` | hwpxlib | none | multicolumn |
| `corpus/hwpxlib_corpus/reader_writer/PageFunctions.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/PageSize_Margin.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/sample1.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleArc.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleButtons.hwpx` | hwpxlib | none | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleComboBox.hwpx` | hwpxlib | none | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleCompose.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleConnectLine.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleContainer.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleCurve.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleDutmal.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEdit.hwpx` | hwpxlib | none | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEllipse.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEquation.hwpx` | hwpxlib | none | equation |
| `corpus/hwpxlib_corpus/reader_writer/SimpleLine.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleOLE.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimplePicture.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/SimplePolygon.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleRectangle.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleTable.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleTextArt.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleVideo.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/tool/blank.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/tool/finder/TestFinder.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/multipara.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/tool/textextractor/ParaHead.hwpx` | hwpxlib | none | — |
| `corpus/hwpxlib_corpus/tool/textextractor/RectInPara.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/RectInRect.hwpx` | hwpxlib | none | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/Table.hwpx` | hwpxlib | none | shape_ole |
| `corpus/private/bench-public/files/kogl__붙임_개방지원_사업_신청서.hwp` | gov | none | nested_table, multipage_table |
| `corpus/private/bench-public/files/kogl__서식1_저작재산권_양도_계약서.hwp` | gov | none | — |
| `corpus/private/bench-public/files/kogl__서식2_공공저작물_자유이용_허락_동의서.hwp` | gov | none | — |
| `corpus/private/bench-public/files/kogl__서식3_초상이용_동의서.hwp` | gov | none | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0212_개선이_필요한_공공언어_30선_발표.hwpx` | gov | none | multipage_table, shape_ole |
| `corpus/private/bench-public/files/korea-kr-mcst__0326_광화문_현판_토론회_개최.hwpx` | gov | none | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0411_문체부_2026년_1회_추경_확정.hwpx` | gov | none | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0413_사회문화시설_활용_인문_프로그램_공모.hwpx` | gov | none | — |
| `corpus/private/bench-public/files/korea-kr-moel__260331_보도참고_2026년_제1차_추경예산안_주요내용.hwpx` | gov | none | multipage_table, shape_ole |
| `corpus/private/bench-public/files/korea-kr-mpva__260413_보도자료_2026년_국외_보훈사적지_답사_참가자_모집.hwpx` | gov | none | multipage_table, shape_ole |
| `corpus/private/bench-public/files/mohw__보도참고_도수치료_관리급여_전환_3종_고시개정안_행정예고.hwpx` | gov | none | — |
| `corpus/sample.hwpx` | corpus-hwpx | none | — |

GOV 바이너리는 커밋하지 않는다. 재현: `node scripts/fetch-gov-corpus.mjs`.
