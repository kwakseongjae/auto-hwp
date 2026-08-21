# 조판 오라클 스윕 — 저장 lineseg 회귀 잠금

> ⚠️ **한/글의 참값이 아니라 저장 lineseg 기준의 회귀 잠금이다. HWPX 축 게이트와 같은 규율 — 참값 오라클은 이슈 075 몫.**
>
> 변환 .hwpx의 빈 `linesegarray`는 **채점 불가**이지 0점이 아니다.

재현: `node scripts/oracle-sweep.mjs` (이슈 #72). 생성 2026-08-21. CLI: `auto-hwp layout-check --json` (features rhwp,shaper). 태그는 `corpus/typeset-coverage.json`(#71)과 조인.

전수 재실행은 **로컬 전용**. CI는 `--check-committed`(요약 정합)만 본다. 기존 게이트 8==8 · 18==18 · 24==24 · 줄바꿈 98.9%+ 는 이 파일과 별개다.

## 요약

| 구분 | 건수 |
|---|---:|
| 문서 | 82 |
| 채점 가능 | 79 |
| 채점 불가 (lineseg 없음) | 3 |
| 실패 | 0 |
| 미반입 (GOV) | 0 |
| 일치 (쪽수 + 줄 98.9%+) | 53 |
| 줄격차 | 16 |
| 쪽격차 | 10 |
| 본문 줄정확 평균 (채점 가능·본문 오라클만) | 97.2% |
| 셀 줄정확 평균 (채점 가능·셀 오라클만) | 96.7% |

## 요소별 점수 (채점 가능 문서만 — 채점 불가를 0으로 넣지 않음)

| 축 | 한국어 | 태깅 | 채점가능 | 채점불가 | 쪽수일치율% | 본문 줄정확% | 셀 줄정확% |
|---|---|---:|---:|---:|---:|---:|---:|
| `header_footer` | 머리말/꼬리말 | 5 | 5 | 0 | 60 | 93.3 | 98.5 |
| `form_control` | 폼 컨트롤 | 4 | 4 | 0 | 100 | 100 | — |
| `mixed_orientation` | 가로세로 혼합 | 0 | 0 | 0 | — | — | — |
| `nested_table` | 중첩 표 | 10 | 10 | 0 | 70 | 97.5 | 98.6 |
| `multipage_table` | 다쪽 표 | 16 | 15 | 1 | 66.7 | 97.3 | 95.2 |
| `footnote` | 각주 | 1 | 1 | 0 | 0 | 90 | 100 |
| `multicolumn` | 다단 | 2 | 2 | 0 | 50 | 91.7 | — |
| `chart` | 차트 | 1 | 1 | 0 | 100 | 99 | 100 |
| `equation` | 수식 | 3 | 2 | 1 | 50 | 92.1 | — |
| `shape_ole` | 도형/OLE | 33 | 33 | 0 | 87.9 | 98.6 | 97.3 |

## 가장 낮은 요소 축 (다음 수리 티켓 근거)

| # | 축 | 채점가능 | 쪽수일치율% | 본문 줄정확% | 셀 줄정확% |
|---:|---|---:|---:|---:|---:|
| 1 | `footnote` (각주) | 1 | 0 | 90 | 100 |
| 2 | `multicolumn` (다단) | 2 | 50 | 91.7 | — |
| 3 | `equation` (수식) | 2 | 50 | 92.1 | — |

## 문서별 점수

| 파일 | 수집 | 판정 | 우리쪽 | 한컴쪽 | 본문 줄정확% | 셀 줄정확% | 태그 |
|---|---|---|---:|---:|---:|---:|---|
| `benchmarks/benchmark.hwp` | benchmark | 일치 | 8 | 8 | 98.9 | 100 | nested_table |
| `benchmarks/benchmark1.hwp` | benchmark | 일치 | 18 | 18 | 99.2 | 98.5 | nested_table, multipage_table |
| `benchmarks/benchmark1.hwpx` | benchmark | 쪽격차 | 22 | 25 | 89.5 | — | nested_table, multipage_table |
| `benchmarks/benchmark2.hwp` | benchmark | 일치 | 24 | 24 | 99.7 | 98.4 | nested_table, multipage_table |
| `corpus/hwp/복학원서.hwp` | corpus-hwp | 일치 | 1 | 1 | 100 | 100 | shape_ole |
| `corpus/hwp/한셀OLE.hwp` | corpus-hwp | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwp/draw-group.hwp` | corpus-hwp | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwp/field-01.hwp` | corpus-hwp | 일치 | 3 | 3 | 100 | — | shape_ole |
| `corpus/hwp/hwp-multi-001.hwp` | corpus-hwp | 쪽격차 | 11 | 9 | 98.4 | 81.5 | multipage_table, shape_ole |
| `corpus/hwp/issue_265.hwp` | corpus-hwp | 쪽격차 | 17 | 16 | 91.3 | 98 | header_footer |
| `corpus/hwp/issue-505-equations.hwp` | corpus-hwp | 일치 | 4 | 4 | 100 | — | equation |
| `corpus/hwp/k-water-rfp.hwp` | corpus-hwp | 줄격차 | 27 | 27 | 93.8 | 98 | header_footer, nested_table, multipage_table, shape_ole |
| `corpus/hwp/math-001.hwp` | corpus-hwp | 쪽격차 | 3 | 1 | 84.2 | — | equation |
| `corpus/hwp/shape-001.hwp` | corpus-hwp | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwp/tac-img-02.hwp` | corpus-hwp | 줄격차 | 66 | 66 | 98 | 98.5 | nested_table, multipage_table, shape_ole |
| `corpus/hwp/test-image.hwp` | corpus-hwp | 일치 | 5 | 5 | 100 | — | — |
| `corpus/hwpx/00_smoke_min.hwpx` | corpus-hwpx | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpx/footnote-01.hwpx` | corpus-hwpx | 쪽격차 | 5 | 7 | 90 | 100 | footnote |
| `corpus/hwpx/form-01.hwpx` | corpus-hwpx | 일치 | 1 | 1 | 100 | — | form_control |
| `corpus/hwpx/FormattingShowcase.hwpx` | corpus-hwpx | 일치 | 1 | 1 | 100 | 100 | — |
| `corpus/hwpx/Skeleton.hwpx` | corpus-hwpx | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/error/20230413/test.hwpx` | hwpxlib | 줄격차 | 2 | 2 | 47.8 | — | — |
| `corpus/hwpxlib_corpus/error/20230426/HwpxTest1.hwpx` | hwpxlib | 일치 | 3 | 3 | 99 | 100 | chart, shape_ole |
| `corpus/hwpxlib_corpus/error/20230728/test.hwpx` | hwpxlib | 줄격차 | 39 | 39 | 98 | 99.3 | nested_table, multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20230809/test.hwpx` | hwpxlib | 줄격차 | 1 | 1 | 83.3 | — | header_footer, multicolumn, shape_ole |
| `corpus/hwpxlib_corpus/error/20230818/test.hwpx` | hwpxlib | 일치 | 5 | 5 | 100 | 95.7 | nested_table, multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20231219/test1.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/error/20240305/2022.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/error/20240416/presentation오류.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/error/20240626/no_manifest.hwpx` | hwpxlib | 줄격차 | 4 | 4 | 96.2 | 75 | — |
| `corpus/hwpxlib_corpus/error/20240919/테스트문서.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/error/20241104/mot.hwpx` | hwpxlib | 일치 | 2 | 2 | 100 | 100 | multipage_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20250523/프로젝트 계획서.hwpx` | hwpxlib | 채점불가 | — | — | — | — | multipage_table |
| `corpus/hwpxlib_corpus/error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx` | hwpxlib | 쪽격차 | 82 | 76 | 98.2 | 99.5 | header_footer, nested_table, shape_ole |
| `corpus/hwpxlib_corpus/error/20251107/test_re.hwpx` | hwpxlib | 줄격차 | 15 | 15 | 98.1 | 87.3 | multipage_table |
| `corpus/hwpxlib_corpus/error/20251107/test.hwpx` | hwpxlib | 줄격차 | 15 | 15 | 98.1 | 87.3 | multipage_table |
| `corpus/hwpxlib_corpus/error/20260805/고정폭빈칸_문서.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/error/20260806/표전체 형광색인 경우 오류.hwpx` | hwpxlib | 줄격차 | 1 | 1 | 75 | 100 | — |
| `corpus/hwpxlib_corpus/reader_writer/ChangeTrack.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/HeaderFooter.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | header_footer |
| `corpus/hwpxlib_corpus/reader_writer/MultiColumn.hwpx` | hwpxlib | 쪽격차 | 4 | 2 | 100 | — | multicolumn |
| `corpus/hwpxlib_corpus/reader_writer/PageFunctions.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/PageSize_Margin.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/sample1.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleArc.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleButtons.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleComboBox.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleCompose.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleConnectLine.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleContainer.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleCurve.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleDutmal.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEdit.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | form_control |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEllipse.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleEquation.hwpx` | hwpxlib | 채점불가 | — | — | — | — | equation |
| `corpus/hwpxlib_corpus/reader_writer/SimpleLine.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleOLE.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimplePicture.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/SimplePolygon.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleRectangle.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/reader_writer/SimpleTable.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | 100 | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleTextArt.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/reader_writer/SimpleVideo.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/tool/blank.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/tool/finder/TestFinder.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | 100 | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/multipara.hwpx` | hwpxlib | 줄격차 | 1 | 1 | 94.4 | — | — |
| `corpus/hwpxlib_corpus/tool/textextractor/ParaHead.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | — |
| `corpus/hwpxlib_corpus/tool/textextractor/RectInPara.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/RectInRect.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | — | shape_ole |
| `corpus/hwpxlib_corpus/tool/textextractor/Table.hwpx` | hwpxlib | 일치 | 1 | 1 | 100 | 100 | shape_ole |
| `corpus/private/bench-public/files/kogl__붙임_개방지원_사업_신청서.hwp` | gov | 쪽격차 | 12 | 11 | 100 | 99.5 | nested_table, multipage_table |
| `corpus/private/bench-public/files/kogl__서식1_저작재산권_양도_계약서.hwp` | gov | 줄격차 | 4 | 4 | 88.5 | 96.4 | — |
| `corpus/private/bench-public/files/kogl__서식2_공공저작물_자유이용_허락_동의서.hwp` | gov | 일치 | 1 | 1 | 100 | 100 | — |
| `corpus/private/bench-public/files/kogl__서식3_초상이용_동의서.hwp` | gov | 일치 | 1 | 1 | 100 | 95.2 | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0212_개선이_필요한_공공언어_30선_발표.hwpx` | gov | 줄격차 | 5 | 5 | 88.6 | 96.9 | multipage_table, shape_ole |
| `corpus/private/bench-public/files/korea-kr-mcst__0326_광화문_현판_토론회_개최.hwpx` | gov | 줄격차 | 3 | 3 | 92.9 | 100 | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0411_문체부_2026년_1회_추경_확정.hwpx` | gov | 줄격차 | 4 | 4 | 95.1 | 97.7 | — |
| `corpus/private/bench-public/files/korea-kr-mcst__0413_사회문화시설_활용_인문_프로그램_공모.hwpx` | gov | 줄격차 | 5 | 5 | 92.7 | 97.9 | — |
| `corpus/private/bench-public/files/korea-kr-moel__260331_보도참고_2026년_제1차_추경예산안_주요내용.hwpx` | gov | 쪽격차 | 7 | 6 | 98.1 | 93.8 | multipage_table, shape_ole |
| `corpus/private/bench-public/files/korea-kr-mpva__260413_보도자료_2026년_국외_보훈사적지_답사_참가자_모집.hwpx` | gov | 쪽격차 | 5 | 4 | 100 | 98.7 | multipage_table, shape_ole |
| `corpus/private/bench-public/files/mohw__보도참고_도수치료_관리급여_전환_3종_고시개정안_행정예고.hwpx` | gov | 줄격차 | 4 | 4 | 92.2 | 98.1 | — |
| `corpus/sample.hwpx` | corpus-hwpx | 채점불가 | — | — | — | — | — |

GOV 바이너리는 커밋하지 않는다. 재현: `node scripts/fetch-gov-corpus.mjs`.
