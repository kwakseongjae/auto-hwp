# 세션 저널 (newest-first · append-only)

> 세션 시작: 최근 항목 1~2개 확인. 세션 종료: **맨 위에** 5줄 이내 항목 추가. 기존 항목 수정 금지.
> 결정·증거·계획의 정본이 아니다 — "무엇을 하다 어디서 멈췄나"만 기록한다.

---

## 2026-07-17 (Claude) · 빈 줄 추가/삭제 편집 기능 (69a4208)
- 사용자 요청: 표를 다음 페이지로 밀려고 빈 줄을 넣고 싶은데 추가 방법이 없음(엔터/＋로 추가, 백스페이스/－로 삭제).
- 구현: editor-core insertBlankParagraph(InsertParagraphAt runs:[] — 빈 문단=조판기 한 줄 차지→아래 밀어냄)·deleteBlock(DeleteBlock), 기존 op/intent 재사용(신규 op 0)·각 1 undo. UI: top-level 문단(kind:paragraph) 단일선택 시 액션바에 ＋/－ 빈 줄. 삭제는 빈 문단만 활성(내용 문단 비활성=실수 방지). 표/셀/이미지 미표시.
- 브라우저 실검증(doc9): 헤딩 선택→＋ 7회→9쪽→10쪽 밀림, 빈 문단 선택 시 － 활성·삭제 동작, 툴바 undo 10→9 원복. editor-core 169·react 316 그린. Rust 무변경(게이트 무영향).
- 미구현(저우선): 엔터/백스페이스 단축키(텍스트편집·기존 핸들러와 충돌 위험 → 버튼 우선, 필요 시 추가). ⌘Z는 캔버스 포커스 필요(자동화 키press 미도달했으나 툴바 undo·실제 포커스 시 동작).

## 2026-07-17 (Claude) · <hp:fwSpace/> 드롭 → 영문 병기 단어중간 깨짐 수정 (8d9c360)
- 사용자 전환: 청창사 hwpx는 완전 열화(타 툴도 못 엶)라 테스트 부적합 → 창도패(doc9)로. 새 문제: 목차표 좌측칸 "1. 문제인식(Problem)"이 "(Proble/m)"로 단어 중간에서 깨짐. 한컴독스는 "1. 문제인식 / (Problem)" 정상.
- **근본원인 실측**(doc9 raw XML): 셀 텍스트 = "1. 문제인식**<hp:fwSpace/>**(Problem)", paraPr breakLatin=KEEP_WORD. 파서 Empty 핸들러가 `<hp:fwSpace/>`(전각공백)를 other 분기로 흘려 텍스트 드롭+mark_not_simple. 공백 소실 → "문제인식(Problem)" 접합 → KEEP_WORD 백업할 공백 없어 단어중간 깸.
- 수정 2곳: ①파서 push_inline_char로 fwSpace→U+3000·nbSpace→U+00A0·tab→\t·lineBreak→\n 인라인 TEXT 복원(simple 유지=편집가능성도 회복). ②조판기 layout_paragraph break 기회를 U+3000에서도 기록(is_full_width(U+3000)=true라 폭1em·단어경계walk 이미 정합). benchmark U+3000 0개→게이트 무영향.
- **브라우저 실검증(doc9)**: (Problem)/(Solution)/(Scale-up)/(Team) 전부 온전, 한컴독스 일치. doc9는 정품이라 자동정규화 미발동(9p 충실 오픈=정상). 게이트 8==8/18==18, hwp-hwpx 57·typeset 62 그린, 회귀테스트 1 추가.
- 교훈: HWPX 인라인 제어문자(fwSpace/nbSpace/tab/lineBreak)를 텍스트로 안 살리면 줄바꿈·간격·편집이 조용히 깨진다. "충실 파싱=XML→IR 완전성"의 실체적 갭.

## 2026-07-17 (Claude) · 열화 자동감지→정규화 자동적용 — 업로드 기본=원본 근사 (ff4b3fa)
- 사용자 재보고 "hwpx가 원본 PDF와 전혀 다름(간격·색·보더·쪽수·폰트)". 재진단: 사용자 기준=원본 archive PDF(.hwp, 18p, p1에 체크리스트 1~12행+서명란)인데, 직전 커밋이 충실(=한글 미러 20p, p1에 1~7행)을 **기본값**으로 삼아 업로드 기본 모습이 원본에서 가장 멀어져 있었음. 한글의 .hwpx 렌더 자체가 원본과 전혀 다름((1).pdf 실측: 회색 안내박스·플래그 소실·20p) — 파일 열화.
- 해결: **wasm open이 열화 지문 감지 시 정규화 자동 적용**(줄간격+표 content-fit, normalize_active 보고), 정품은 충실 오픈. normalizeActive() 어댑터 체인 추가, HwpWorkspace 오픈 시 토글 동기화+열화 감지 토스트.
- **브라우저 페이지 단위 시각검수(cc.hwpx vs 원본 PDF)**: 업로드 즉시 17p, p1 체크리스트 **1~12행 전부**(원본 동일), 본문 **serif 실렌더**(함초롬바탕→NanumMyeongjo, 원본 신명조 방향 일치), 파랑/빨강/회색·테두리·열비율·라디오(■/□)·중첩 사업비표(p2)·증빙서류 빨강(p12) 전부 원본과 일치.
- 남은 갭(정직 보고): ①p1 하단 서명란이 p2로 밀림(17p vs 18p, 공유 조판기 메트릭 — .hwp 게이트가 잠가 조정 불가·열화파일 고유) ②▸플래그 배너(한글 hwpx 렌더도 소실=변환 손실) ③안내박스 빨간 테두리(.hwp 경로도 동일한 우리 렌더러 한계, 문단 테두리 미구현). 게이트·react316·editor-core168 그린. mode-aware 배치 full verify도 그린(✅ 전부 그린).

## 2026-07-17 (Claude) · mode-aware 표 행높이 옵션 구현 (5e18905)
- 사용자 요청으로 "충실=한글 렌더에 맞춤" 옵션 구현. 재분석: 손실 hwp→hwpx의 auto-fit 표는 저장 cellSz가 균일 명목값(2200)인데 **한글은 max(내용,저장)로 플로어** → 벌어짐(체크리스트 7행/p, 20p). 우리는 7a06e9f로 content-fit(16p)이라 한글과 달랐음. 한글 .hwpx PDF가 page2에 체크리스트 8~12행으로 시작(=page1 1~7행)한 것이 플로어 증거.
- 구현(round-trip 안전 우선): 파스는 auto-fit 표 cellSz 플로어를 **새 렌더-IR 필드 `Table::stored_row_heights`에만** 담고 `row_heights`는 content-driven 유지(054/020 왕복 테스트 무영향). JSX `table_eq` 미비교(src_span식). normalize 모듈 `apply_faithful_table_heights`⇄`content_fit_autofit_tables`(상호역·멱등, nested 표 순회, fixed 표 미접촉). wasm open이 기본 충실 플로어 적용, setNormalize가 baseline 복원+플로어 재적용→applied 시 content-fit.
- **브라우저 실검증(cc.hwpx)**: 충실 **20p = 한글 .hwpx 렌더 정확 일치**(체크리스트 벌어짐) ↔ 정규화 **17p**(≈.hwp 18p, 체크리스트 1~4행/p 조밀) ↔ 오프 20p 복귀. 게이트 8==8/18==18(.hwp 무영향), model 15·hwpx 56·jsx·ops 79·react 316 그린.
- 이제 두 모드 모두 원칙적: 충실=한글 미러(20p), 정규화=.hwp 복원(17p). 사용자 검수 대기.

## 2026-07-17 (Claude) · 정규화 지문 코퍼스 검증(Task3) + 표 행높이 축 조사(Task2) (471adf1)
- **Task3 지문 검증**: archive 실물 12개 .hwpx 스윕. **발동 3/3 = 전부 한글 hwpx저장 열화본**(doc3 예창패·doc7 초창패·doc11 청창사, loose 93~99%). doc3/doc7은 .hwp 쌍둥이 대조로 확정: .hwp 130%본문(loose44/41%) vs .hwpx 160%붕괴(99%) → 발동 정당(오탐0). **비발동 9/9 = 130% 본문 지배**(loose 31~48%, 쌍둥이도 동일=정품). 경계(발동93~99% vs 비발동31~48%)가 임계값0.60을 큰 여유로 통과. 그 경계(45% loose+rich pool→미발동)를 회귀테스트로 고정.
- **Task2 표 행높이 축 결론 = 무변경(현행 content-fit이 정답)**: 실험(플로어 항상적용) 결과 열화doc 페이지가 .hwp에 근접(doc3 5→6, doc7 5→6, doc11 정규화17)하나, 저장 cellSz높이=균일 명목값(2200)이라 **단일행(체크리스트)을 강제로 늘려 페이지당 항목수 감소** → 사용자 검증한 "자가진단표 1~12행" 밀도 역행(7a06e9f "플로어→7항목 vs 무플로어→12항목"과 일치). 열화 .hwpx는 .hwp의 실제 per-row 높이를 잃었으므로 content-fit이 최선근사. 실측 doc11 정규화 브라우저17p≈.hwp18p로 이미 근접. → 플로어 미적용 유지.
- 옵션(저우선·미실행): 충실 모드를 Hancom render(플로어=20p)에 맞추는 mode-aware 표높이 — 사용자 관심은 정규화(=.hwp)라 가치 낮음.

## 2026-07-16 (Claude) · HWPX 줄간격 근본진단 + "레이아웃 정리" 토글 (4d74c11·d23ee43)
- 사용자: "그냥 대응 말고 원인부터. hwp 동작방식이랑 다른게 있으니 이런 드라마틱한 차이가." → **통제실험**(archive의 동일문서 .hwp/.hwpx 둘 다 파싱): .hwp 줄간격 130%×501 다양 vs .hwpx 160%×1098(94%). 원인=한글 "hwpx 저장"이 본문 78%(916/1172)를 바탕글 기본 paraPr(id0=160%)로 리매핑→원본130% 파괴. version.xml=Hancom Office 13(우리변환 아님). **한글 자신도 이 hwpx를 20p(=.hwp 18p보다 벌어짐)로 렌더**(참조PDF 2p 직접비교로 확인)→우리 읽기는 파일에 충실. 즉 괴리=파일 열화지 렌더버그 아님.
- 사용자 선택(AskUser): "충실 기본 + 정규화 토글 둘 다". 구현: hwp-model::normalize_line_spacing(열화지문=단일 loose>60%지배+풀에 미참조 tight다수 감지→collapsed 문단 160→풀중심130% 복원, 렌더-IR only·moat보존, 정품160%문서 미발동) → EditSession::doc_mut(리비전미범프) → wasm setNormalize/normalizeActive(baseline복원 가역+캐시클리어) → engine 래퍼(index.js/d.ts)+worker화이트리스트 → adapter/session → HwpWorkspace 툴바 토글.
- **브라우저 실검증**(cc.hwpx): 충실18p 체크리스트1~10행 ↔ 정규화17p 1~12행(=.hwp일치), report "160%→130% 1098문단", 토글오프 복귀. 게이트8==8/18==18·react316·editor-core168·rust그린.
- 함정: copy-wasm이 packages/engine/worker.js를 public로 복사(정본은 engine쪽) + index.js는 **수작업 래퍼 HwpDoc**이라 새 메서드 위임 수동추가 필수(안하면 "doc[args.method] is not a function") + 브라우저 모듈캐시로 하드리로드 필요. 7a06e9f가 fmt-dirty로 나갔던 것 이번에 정리(d23ee43).
- 열린 것: 정규화는 줄간격만(테이블 행높이 축은 후속). 사용자 재검증 대기.

## 2026-07-16 (Claude) · HWPX-vs-HWP 시각 파리티 — 브라우저 실검증 3수정
- 사용자 지시: "hwp랑 퀄리티 차이 거의 안나게 계속 고도화, PDF 바탕 시각검증". 참조 = 2026 청창사 신청서 PDF. 진단은 **export-pdf가 아니라 실제 브라우저(localhost:3000) 스크린샷**으로 함(CORS 서버 8899 + JS 업로드) — export가 못 잡는 폰트 이슈를 드러냄.
- **①행높이(7a06e9f)**: noAdjust=0(auto-fit) 표에 저장 cellSz 행높이 플로어 적용 → 20p 팽창. 게이트: 플로어 미적용으로 18p 파리티 회복.
- **②볼드(021a08f)**: @font-face에 weight 서술자 없음 + CJK 합성볼드 부실 → 헤더가 전부 regular로 보임(볼드 위계 상실). NanumGothic-Bold weight-700 실 face 로드. 브라우저 확대 검증(헤더 볼드 확인).
- **③serif(c51e5ef)**: 명조/바탕 run이 NanumMyeongjo 404 → 고딕 폴백. NanumMyeongjo Reg+Bold 번들(assets/fonts)+serif 400/700 @font-face. 브라우저 JS 검증: `Nanum Myeongjo 400|loaded 700|loaded`, serif text 18곳 실렌더. react vitest 316 그린.
- 열린 것: 자가진단표 ▸플래그 배너 형태(한글 네이티브 테두리 장식 — hwp/hwpx 양쪽 렌더 미구현, 저우선). 줄간격 밀도 미세차(파일 충실). 사용자 재업로드 시각확인 대기.

## 2026-07-15~16 (Claude) · 웹 QA 5차 3건 — 에이전틱버그·Figma툴바·HWPX렌더깨짐
- **#1 (59101a6)**: 에이전틱 편집이 "제안된 편집 없음"으로 멈춤 = **Grok이 emit_intents 터미널 툴콜에서 degenerate**(인텐트명 'SetTableCell纺'·공백 폭주 → 화이트리스트 드롭). + 러너 핫리로드됐으나 프롬프트 dist 서버캐시 스테일. 수정: emit_intents 툴 제거→최종 편집 JSON 배열 텍스트 출력(비스트리밍과 동일)+웹검색 캡 3회. 실 Grok 실증.
- **#2 (86ad5b9)**: 매 선택마다 뜨는 플로팅 툴바 짜증 → **조사서 지속 리본(FormatRibbon/048)이 이미 존재** 발견(플로팅은 중복). FloatingToolbar 렌더 제거+리본에 서체+컴팩트 AI pill.
- **#3 (88e9d31, A+B)**: HWPX가 hwp 대비 많이 깨짐 = **통제실험 근본**: 렌더엔진 공유·정상, HWPX 얕은 파서가 run char_shape 0·문단 para_shape 0 하드코딩(전 텍스트 10pt 검정)이나 **풀은 이미 파싱돼 메모리에 있음=배선갭**. resolve_shape_pools로 char/para 풀 배선+secPr 페이지 지오메트리. 실측 폰트 1→4~16종·검정→파랑/빨강 회복. round-trip moat 보존. 남은 것 C(표)·D(이미지).
- 교훈: 툴콜 강제(tool_choice force)는 Grok을 degenerate시킴 — 검증된 JSON-텍스트 출력이 안정적. 대형 피드백은 설계조사 workflow/agent 선행이 근본을 빠르게 잡음. HWPX는 rhwp 아니라 우리 hwp-hwpx 얕은 파서가 문제(배선만 하면 됨).
- 다음: HWPX C/D 착수 결정 + 사용자 로컬 QA(에이전틱 편집·툴바·HWPX 스타일).

## 2026-07-15 (Claude) · 웹 QA 4차 대형 다배치 8건 — 설계조사→4배치 순차 구현
- 발단: QA 8건 피드백(중첩표 사라짐·hover 오작동·문서구조 썸네일·웹검색 동적화·멀티모달·메모리·사고스트림·표생성). 6레인 설계조사 workflow(qa4-design-explore) → 엔진레벨 통일원칙(엔진=Intent, 나머지는 감싸는 층) → 사용자 승인 4배치.
- **배치1(16898c1)**: 호버 strict-containment(빈배경 색변 제거)·표생성 프롬프트(엔진 InsertTableAt 완비, 갭=프롬프트)·중첩표 Tier1(Op::SetTableCell 비파괴화=데이터손실 차단+정직토스트). **배치2(4e239d5)**: 페이지 썸네일 레일(기존 SVG 래스터 재사용·lazy)·멀티모달 입력(이미지=grok 비전 content-parts·문서=TXT추출, HWP/PDF 미지원칩). **배치3(d890d37, XL)**: 에이전틱 스트리밍 AI(?stream=1 NDJSON·모델주도 web_search 툴콜링·사고 타임라인·대화메모리 6턴, 토글 v1 대체). **배치4(8afc6e3)**: 중첩표 Tier2(CellPath 전스택·중첩 편집 가능).
- 교훈: 대형 피드백은 설계조사 workflow 선행이 효과적(6레인 병렬로 근본 매핑). 중첩표는 데이터손실 버그였음(SetTableCell이 cell.blocks 통째 교체→중첩표 영구드롭)—Tier1 우선 안전화 후 Tier2. 배치별 워크트리 병렬→순차 cherry-pick 전부 clean(파일 영역 분리). 실 Grok 스트리밍 웹검색 서버 스모크로 파이프라인 실증. 검증: 게이트 8==8/18==18 전배치 불변, vitest 40/168/318/50.
- 다음: 사용자 로컬 QA(8건) + 차트/도표 생성(ⓗ) 착수 결정 + 실 스트리밍 웹검색 UI 육안.

## 2026-07-14 밤 (Claude) · 웹 QA 3차 피드백 3건 — AI채우기 검정색·다중페이지드래그·챗revert+웹검색
- 발단: 사용자 QA에서 #1(표 자동인식·채우기) 실 Grok 프레임표 작동 확인(고무적) + 신규 3건. 조사 4차원(색상속·마퀴·AI라우트/UI/revert + OpenRouter 웹검색 실현성) → 구현 계획 → 사용자 승인(범위 ①②③-C·A-v1, 색상=AI채우기 항상 검정) → 3 병렬 워크트리.
- **① (32f521b)**: `Op::SetTableCell`/`SetParagraphRuns`가 빈칸 첫 run char_shape 전체(색)를 물려줘 예시 파랑/빨강이 채운 값에 반영되던 것을 plain-run 분기 char_shape clone→text_color=default 검정 reintern(폰트·크기 유지)으로 교정. 수동 명시색은 non-plain이라 자동 우회. hwp-ops 65·게이트 before==after·wasm 재빌드. **② (c6e5319)**: 마퀴 시작페이지 클립 해제 → pointerMoveMultipage(React가 캡처 하 교차페이지+sub-rect, core DOM-free)+auto-scroll+finishMarquee 페이지별 union. **③ (4aa1083)**: 챗카드 지속 되돌리기(undoDepth top-of-stack v1)+🔎 웹검색 토글(OnAiRequest additive opts, InlineEditPanel 무영향)+OpenRouter web plugin+citations(additive).
- 교훈: OpenRouter web plugin은 툴콜링 없이 자동검색+url_citation → JSON-only 프롬프트 계약 안 깨고 웹검색 가능(스트리밍 투명성만 큰 리팩터). 3 워크트리 clean cherry-pick(영역 분리 좋음). 검증: vitest 23/163/305/44·게이트 8==8/18==18·챗/smoke e2e 11.
- 다음: 사용자 로컬 QA(①색 검정·②교차페이지 드래그·③되돌리기/웹검색) → 잔여=always-revert 완전형(주소화/보상편집) + 스트리밍 투명성(③-v2).

## 2026-07-14 (Claude) · 웹 QA 2차 피드백 4건 — 스테일dist버그·deselect·Figma표선택·인라인편집
- 발단: 사용자 실사용 스크린샷 — "아이디어명은 여명거리로"가 대표자명 라벨칸을 덮음(066이 안 먹힘). 병렬 조사(4차원)로 근본 매핑.
- **#1 (0f09ac4)**: 라벨 덮어쓰기 근본 = **스테일 `ai-protocol/dist`**(066은 src만·앱은 dist 소비→grids 드롭). durable: hwp-lab predev/prebuild `build:deps` 선행 + verify-local.sh에 ai-protocol 빌드 + playwright webServer mock 고정. e2e로 docContext에 그리드 실림 확인. **#2 (0f09ac4)**: 빈바탕 클릭 미해제 = finishClick이 block_at nearest-band 폴백 신뢰 → strict-containment 재검사(+회귀 테스트).
- **#4 (59fef4f)**: Figma식 클릭=표/더블클릭=셀/재더블클릭·Enter=편집. editor-core drill 상태+drillInto+currentCell, React handleDoubleClick. **#3 (c1a9476)**: 인라인 per-element 편집(✨ 여기서 편집→요소 아래 패널→onAiRequest 즉시apply→적용유지/되돌리기, 이중 가드). 둘 다 워크트리, cherry-pick 시 finishClick(#2∩#4)·HwpWorkspace(#4∩#3) 병합·테스트 드릴모델 갱신.
- 교훈: **dist 소비 아티팩트는 소스만 고치면 안 됨**(066 회귀가 스테일 dist였음 — verify가 src로만 테스트해 그린으로 샜다). 워크트리는 분기 시점 주의(#3가 #4 이전서 분기→테스트 셋업 충돌). 검증: editor-core 162·react 301·게이트 8==8/18==18. 실포인터/프레임표 실Grok 육안은 로컬 QA 큐.
- 다음: 사용자 로컬 QA(#1 프레임표 표채우기·#2 deselect·#4 드릴·#3 인라인) → 잔여 UX 판단(AI 진입점 통합/인라인 수동편집).

## 2026-07-13 밤6 (Claude) · 실물QA P0 2건 병렬 수정 완료 — 065 압축mimetype ∥ 066 표그리드컨텍스트
- 한 일: 실물 스윕 P0 둘 다 병렬 워크트리 수정→병합→검증. **065**(79ecd1a 푸시): detect가 압축 mimetype HWPX를 거부하던 것을 ZIP 중앙디렉토리 엔트리 NAME 스캔(DOCX식, inflate 0) fallback으로 해소 — 실물 6/24 회복. **066**(dab3e87): 웹 doc-context가 표 그리드에 눈멀어 "표 채워줘" intents:[] 이던 것을 hwp-session `table_grid`(edit_target 언랩·active셀) → wasm tableGrid → WasmAdapter → buildDocContext 그리드 첨부(dedup·truncate·회귀 바이트동일) + 프롬프트 FOOTER(TABLE GRID/ADDING ROWS)로 해소. 소스 선택 (b) 채택 사유=to_markdown은 hwp-ai deps 유입·전문서 덤프·edit_target 미사용으로 프레임표 좌표 틀어짐.
- 검증: 통합 --full 그린(게이트 8==8·18==18, vitest 156/20/296/41, e2e 37 pass, wasm -Oz 재빌드). **실 Grok 4.5 실경로 실증**: 4행2열 라벨+빈값칸 그리드+"표 채워줘"→col1 값칸에만 4 SetTableCell(라벨 col0 미접촉), 066 이전 빈응답 완전 해소.
- 다음: 로컬 육안 QA(사용자) — QA.md ⑪~⑱ + 이제 표채우기 바이브 플로우 포함. 미푸시=066(dab3e87)+본 문서 커밋.

## 2026-07-13 밤5 (Claude) · 후속 배치 트리아지 + 실행(flaky·IME·BMP·PANOSE, 토스트 revert)
- 한 일: 미뤄둔 후속 트리아지 워크플로(90항목→actionable 7/외부6/XL多/디스코프). 3레인 병렬 실행:
  Lane A(react/lab): flaky 028툴바 격리(근본=더블클릭 Date.now 400ms창 부하시 초과→Date.now 고정, 3회 296/296)·IME Chrome CDP e2e(main 통과)·토스트(엔진이 CellHit.nested 미방출=dead-code→**revert 8170566, 064 신설**). Lane B(Rust): BMP PDF 임베드(순수 Rust bmp.rs, from_rgba8, 26테스트)·FaceName PANOSE 분류(rhwp type_info 제공, 게이트 before==after 완전일치=metric누수0). 조사: rhwp upstream=v0.7.18(3패치 뒤, 재벤더링 저리스크로 차트/수식 자동개선)·kordoc(MIT/TS, 제품참고 중간가치).
- 교훈: 후속도 실엔진 연동 확인 필수(토스트가 speculative dead-code였음 — mock만 통과, 프로덕션 미발화). 에이전트 2곳이 느린 e2e/브라우저 미설치로 반환 반복→직접 인수(IME는 브라우저 install 후 통과, flaky/BMP/PANOSE는 워크트리 게이트 직접확인).
- 다음: #7 npm 발행 자동화 → rhwp 재벤더링 v0.7.18 → QA 핸드오프(QA.md 정식 절).

## 2026-07-13 밤4 (Claude) · B3 차트 v1 병합 → 062 잔여 배치 마감
- 한 일: B3 062-7 차트(15fc718) — 신규 chart_render.rs가 rhwp OoxmlChart bootstrap, **B2의 PaintOp::Image.svg 채널 재사용**(별도 variant 불필요). lift Control::Shape arm이 OOXML Chart만 처리(GSO/레거시VtChart/비차트OLE→드롭=바이트동일). 박스=저장크기 예약(place_doc∥NaiveLayout LOCKSTEP). 게이트 선확인=두 벤치마크 차트 없음→구조적 중립. 게이트 8==8·18==18, 차트없는 문서 바이트동일(SVG/HTML/HWPX git-stash A/B), main --full 그린(e2e 39/39).
- **062 잔여 배치 완료**: B1 대각선X자·B2 수식v1·B3 차트v1. 062 전체(배포용복호·옛한글·금칙·대각선·수식·차트) = rhwp 승격 완료. 잔여=자체PaintOp v2(XL)·krilla PDF·레거시OLE·rhwp upstream델타. 폰트메트릭=디스코프.
- 다음: 사용자 로컬 QA(수식/차트/대각선 육안) 또는 잔여 v2 착수 결정.

## 2026-07-13 밤3 (Claude) · B2 수식 렌더 v1 병합
- 한 일: B2 062-5 수식(805c447) — 신규 eq_render.rs가 rhwp 수식 파이프라인 bootstrap(catch_unwind), EquationRef.rendered_svg additive 캐싱, **SVG 채널=PaintOp::Image.svg: Option<String> additive**(screen==export 유지: PDF/canvas는 svg 무시→stub, PDF 유보 공짜). rhwp px=우리 px=HWPUNIT/75 정합. own-render+HTML에 진짜 수식, PDF v1 stub. 게이트 8==8·18==18, 수식없는 문서 바이트동일, 실샘플 eq-002.hwp lift 실증. main --full 그린(e2e 39/39).
- 통찰: B2의 PaintOp.svg 채널을 B3 차트가 재사용 가능 → 계획이 우려한 별도 RawSvg variant 불필요.
- 다음: B3 062-7 차트 v1(OOXML, svg 채널 재사용) → 062 잔여 마감.

## 2026-07-13 밤2 (Claude) · 062 잔여 계획(워크플로) + B1 대각선
- 한 일: 062 잔여 4항목 조사·적대검증·계획 워크플로(wf_842c2cd1, 9에이전트) — 발견: 대각선=거의완성(순델타 X자), 차트=rhwp에 이미 있음(이슈 "소스없음" 오류), 폰트메트릭=디스코프(라이선스+V5+실익미미). 전항목 document.rs+lift.rs 공유→순차(B1→B2→B3). B1 062-4 대각선 X자(342b833): DiagonalKind::Cross, render-only, 게이트 8==8·18==18, e2e 39/39.
- 함정: B1 에이전트가 커밋 전 external/rhwp 심링크 제거→워크트리 재검증 불가 → 코드-only 커밋이라 main cherry-pick+거기서 --full로 해소. 향후 rhwp 제거 금지. 하단 고아 에이전트 4개(058 폰트 리서치 하위)도 종료.
- 다음: B2 062-5 수식 렌더 v1(rhwp bootstrap SVG) → B3 차트(tail).

## 2026-07-13 밤 (Claude) · 063 병합·검증 완료 — 승인 배치(060→062→063) 종료
- 한 일: 063 cherry-pick 병합(50db8f0). main --full에서 react vitest 1건(workspace.editing "028 툴바 숨김") 실패 → 격리 재실행 296/296 그린 확인 = **flaky(테스트 순서/타이밍), 063 회귀 아님**. set -e로 e2e 미실행됐던 것 → e2e 별도 39/39 그린으로 검증 완료. 게이트 8==8·18==18, deny ok. flaky는 CURRENT_STATE에 추적 기록.
- **승인 배치 전부 완료**: R13 060 + R14 062 quick win(배포용복호/옛한글/금칙) + 063 웹 이식 패키징. 외부 사이트 npm 임베드 준비 완료(실 publish는 사람이 workflow_dispatch).
- 다음: 062 잔여(대각선·수식·폰트메트릭·차트) R14 후속 / 사용자 웹 QA(로컬) / flaky 테스트 격리.

## 2026-07-13 밤 (Claude) · R14 063 웹 이식 패키징 구현(워크트리)
- 한 일: 063 전 스코프. ① **file:→실버전**: 루트 pnpm-workspace 대신 **prepack 치환 전략** 채택(레포가 npm+독립락, apps/hwp-lab도 npm+file: → `workspace:*`는 npm이 못 읽어 무회귀 위반). react `prepack`이 file:→^ver 텍스트 치환(포맷 보존)·`postpack`이 복원(on-disk는 file: 유지). ② **prepack 빌드 훅** 4패키지(engine=build-wasm.mjs cargo+wasm-bindgen+wasm-opt, react=vite+tsc, editor-core/ai-protocol=tsc) → `npm pack` 4종 tarball 전부 pkg/dist 포함·file:의존 0 실측. ③ **발행 CI**(.github/workflows/publish.yml, workflow_dispatch, engine→editor-core→ai-protocol→react, dry_run 기본, publishConfig access:public). ④ **Vite 임베드 예제**(examples/vite-embed — published tarball 설치→`<HwpWorkspace/>` 렌더, Playwright 스모크 그린: 업로드→8쪽 SVG→셀 마킹→mock 편집→undo). ⑤ **AI 프록시 Express 템플릿**(examples/ai-proxy-express, GET/POST/400 mock 실측). ⑥ 문서(docs/EMBED-GUIDE.md + INTEGRATION-HANDOVER 비-Next 포인터).
- 발견/수정: **ai-protocol dist가 확장자 없는 상대 import**라 순수 Node ESM(Express 프록시)에서 ERR_MODULE_NOT_FOUND — src에 `.js` 확장자 추가로 수정(번들러/Node 양쪽 호환, vitest 15 무회귀). Vite 프로덕션 빌드는 엔진 글루 wasm을 정적에셋으로 1회 더 방출(런타임 미fetch, 무해 — 문서화).
- 함정 준수: 실제 npm publish 안 함(npm pack까지만). Rust 무접촉(빌드만). 워크트리 커밋만, 푸시 금지.
- 다음: 아키텍트가 main 병합 + verify-local --full 재확인 → 062 잔여(대각선·수식·폰트메트릭·차트).

## 2026-07-13 저녁 (Claude) · R14 062 quick win 완결 → 063 착수
- 한 일: 062 quick win 3종 병합·검증 — 062-1 배포용복호(c716e8f, **056 해소**; 발견: 배포용은 이미 rhwp가 복호 중, hwp-crypto를 NIST골든+fail-closed 정본으로 승격) · 062-2 옛한글(6b6d22d, KTUG PublicDomain 5,659매핑, 측정=전각프록시 LOCKSTEP+그리기만 자모확장 additive) · 062-3 금칙(c556114, rhwp 두 집합 verbatim→layout_paragraph kinsoku_adjust, 게이트·줄바꿈 before==after 하락0). 각 병합 후 워크트리에서 게이트 직접확인→cherry-pick, 배치 후 --full 그린(e2e 39/39).
- 패턴 확립: rhwp 승격은 워크트리에서 핵심 Rust 증명(게이트/테스트) 직접 확인 후 cherry-pick, 그다음 main --full. leaf crate(hwp-crypto)는 quick로 충분, render/typeset 접촉(062-2/3)은 --full.
- 다음: 063 웹 이식 패키징(file:→실버전+prepublish훅→npm 발행→Vite 임베드 예제).

## 2026-07-13 오후 (Claude) · R13 마감(060) + 062 착수
- 한 일: 060 프레임표(1778690) 인수·병합 — 060 에이전트가 e2e를 42분 폴링하며 반환 반복(토큰 낭비) → 직접 인수: 워크트리에서 hwp-hwpx 테스트(frame_table_060 3 + 057 골든 5 무회귀)+게이트 확인 후 커밋·cherry-pick. main verify-local --full 그린(e2e 39/39, 게이트 8==8·18==18). ⚠️ e2e가 포트 오염으로 1회 실패 → 프로세스 정리(pkill next/playwright, lsof :3100/:3000 kill)+스모크 확인 후 재실행으로 39/39 회복.
- 교훈: 에이전트가 느린 e2e를 폴링하며 반환 반복하면 직접 인수(핵심 Rust 증명만 확인하고 커밋+병합, e2e는 main에서). e2e 포트 오염 시 pkill+lsof 정리.
- **R12+R13 완료.** 다음: 062 rhwp 승격(062-1 배포용복호=056해소 ∥ 062-2 옛한글) → 063 패키징.

## 2026-07-13 (Claude) · R13 059·058 병합 + 오픈소스/웹이식 조사
- 한 일: 059 IME(1ea3365 — 캐럿추종 hidden textarea+compositionView, 한글 완전무입력 실측 확정, 엔진무변경) ff-병합 + 058 폰트(43a7c48 — 명조/고딕 OFL 라우팅, **디스플레이 전용으로 게이트 V5 원천차단** metric불변·글리프 x 바이트동일) cherry-pick 병합(HwpWorkspace 자동병합). 통합 verify-local --full 그린(게이트 8==8·18==18, vitest 156+15+296+41, e2e 39/39).
- 조사 2건: ①오픈소스 전수 → **헤드라인: 약점 상당수가 이미 external/rhwp(MIT)에 완성**(파스전용이라 미배선) → 062 신설(배포용복호·금칙·정렬·다단·대각선·수식·옛한글·폰트메트릭 승격, 라이선스0). 056은 062-1로 해소경로. ②웹이식 SDK감사 → 아키텍처 준비우수·패키징 최종1마일(file: 의존/prepublish훅/발행CI) 미비 → 063 승격대기.
- 다음: 060 프레임표(R13 마감) → 062 quick win → 063 패키징(사용자 승인 대기).

## 2026-07-11 밤 (Claude Fable 5) · 055 사후 리뷰 → 확정 결함 10건 수정
- 한 일: code-review 워크플로(high, 24에이전트, 발견별 독립 검증)가 055 diff에서 확정 결함 10건 적발 — 기능 e2e가 전부 그린인데도 동시성/수명주기/에러 경로는 구멍(복구 토스트 사장, 취소가 열린 문서 파괴, recover 동시 비행 dead-handle, 실드 boolean 소실, open 중첩, 실패 open이 이전 문서 파괴, init 거부 영구 캐시, 트랩 분류기 3중 발산, setTimeout(0) 실드 잔존 2, ctxMenu dismiss 무반응). 10건 전부 수정 + 잠금 테스트 14개(각 수정을 구 코드로 되돌려 레드 확인 후 복원). react 283/150/15/41, e2e 38/38, tsc 클린.
- 교훈: 워커화 같은 비동기화 diff는 기능 테스트 그린만으론 부족 — 병합 직후 동시성 특화 리뷰를 표준 절차로.
- 다음: R13 착수(061→059∥058→060 — README R13 절 계획 확정).

## 2026-07-11 저녁 (Claude Fable 5) · 055 웹 하드닝 + 알려진 한계 리서치 5레인
- 한 일: 055 웹 하드닝 구현·병합 — 엔진 워커화(FG-14 — @tf-hwp/engine worker.js+worker-client 수제 RPC, WasmAdapter 옵트인+052 재스폰 복구, hwp-lab 기본 ON·?engineWorker=off 롤백) + wasm-opt -Oz(raw −22%/gzip −6%, 골든 바이트동일) + 한도 UX(64MiB·DocLimit 문구·파싱 취소). 실측 458p·CPU4× JS 블로킹 11.5s→3.4s(−71%). 부수: 047 shield 레이스 수리, Cargo exclude ".claude". verify-local --full 그린(e2e 38/38, react 274, hwp-lab 36).
- 알려진 한계 5종 병렬 리서치 → 이슈 승격: 058 폰트(FontKey에 family 이미 흐름), 059 IME(반전: 입력캡처 아키텍처), 060 프레임표(emit 게이트 4곳 비재귀), 061 웹배포(Vercel prebuilt), 056(crypto 착수가능·rhwp crypto.rs MIT).
- 병합 사고: 055가 API 재시작으로 **두 워크트리에서 독립 완성**(7478b11 WasmAdapter통합 vs b5c330d 별도WorkerAdapter). 7478b11 정본 채택했으나 b5c330d만 고친 컨텍스트 메뉴 워커 레이스(늦은 우클릭 해석이 열린 메뉴 detach)가 main e2e 2건 실패로 표면화 → 지운 b5c330d를 객체로 되살려 시퀀스 가드(ctxMenuSeqRef)만 이식 → e2e 38/38 회복. 교훈: 중복 완성 시 각 워크트리가 서로 다른 버그를 고칠 수 있으니 병합 후 반드시 --full 재검증.
- 다음: **R12 전 항목 완료.** R13 후보(058~061+056) 착수 순서 결정(아키텍트). 웹 QA는 로컬 또는 061. 후속 이슈감: 대형문서 SVG 문자열 전송 최적화(034 §함정), 수백p placeholder Layout 스파이크(~1.4s@4×, 워커 무관).

## 2026-07-11 오후 (Claude Fable 5) · CI→로컬 검증 전환
- 한 일: GitHub Actions 전패 원인 2종 해결 — ① fmt 미준수 1,332곳(CI가 로컬 시절 한 번도 안 돌았음) → 전체 포맷+clippy 부채 37건 정리(-D warnings 그린) ② cargo-deny 라이선스 미등록 2종(BSL-1.0/MPL-2.0) allow 추가. CI는 workflow_dispatch 수동 전용으로 전환, 정본은 신설 `scripts/verify-local.sh`(quick/--full). AGENTS.md 검증 절 갱신.
- 검증: fmt/clippy exit 0, 테스트 374/0, 게이트 8==8·18==18, wasm 그린, deny licenses ok.
- 다음: 사용자 웹 QA(apps/hwp-lab, QA.md) → 055 웹 하드닝.

## 2026-07-11 (Claude Fable 5) · R12 배치 B 완료 — 053 병합
- 한 일: 053 v2 완주·병합(dbcc1bd) — P0 own-render 글리프 통일 채택(rhwp 발산 우회), HitTestCell/CaretRectCell(스키마 38→40), CellCaretController+CaretLayer(렌더-0), 해상률 실클릭 0%→100/99.8/100%. place.rs +412/−0 순수 추가로 V4 준수. 최종 통합 검증 후 푸시.
- 사고 기록: v2도 API 연결 오류로 1회 중단 → SendMessage 트랜스크립트 재개로 컨텍스트 보존 완주(재개 패턴 유효 확인).
- 다음: 055(웹 하드닝) 착수 가능. 후속 기획: 1×1 프레임 내부표 미export / F3 / IME(FG-13).

## 2026-07-10 밤 (Claude Fable 5) · R12 배치 B — 054·057 병합, 053 재가동
- 한 일: 057 병합(8a28ce5 — 표 앵커링: src_span+per-cell 수술, verbatim 불변) + 054 병합(8cd4233 — lift F2: 무편집 왕복 8/18/25p 복원, 왕복 손실 4종 수리). 054×057 충돌(document.rs 필드 union, serialize.rs 의미적 합성 — in-place 제외+시퀀스 append, 057 호출부를 054 신 API로 적응) 해소. 통합 검증 그린(Rust 367+30/0, 게이트, hwp-lab 22/22, e2e 34/34), 푸시.
- 사고: 053 v1이 80분 진행부진(내구적 파일 변경 0) → 중단, v2를 병합 main에서 재가동(페이스 규율+서브모듈 .git 포인터 함정 반영).
- 다음: 053 v2 병합 → 055(웹 하드닝). 후속 기획 대기: 1×1 프레임 내부표 미export(057 발견)·F3.

## 2026-07-10 저녁 (Claude Fable 5) · R12 배치 A 완료
- 한 일: 051 구현 병합(2dc92d3 — Intent 2신설·화이트리스트 14종·프리뷰 카드·e2e 32/32·게이트 그린) + 052 구현 병합(d0f0a24 — 2s 유휴 스냅샷·IndexedDB·트랩 우선 복구·배너·V3 잠금), 워크트리 병렬 → ff/cherry-pick 선형 병합
- 발견: 052 golden이 엔진 갭 2건 격리 → 057 신설(hwpx 표 앵커링 오배치), 054에 .hwp 무편집 왕복 8p→6p 기록
- 다음: 통합 검증(빌드+vitest 4종+e2e) 그린 확인 → 푸시 → 배치 B(053∥054, 057 편입 검토)

## 2026-07-10 오후 (Claude Fable 5) · R12 착수
- 한 일: 커밋 4fc37fb + GitHub private 레포 생성/푸시(kwakseongjae/tf-hwp) + 051·052 1단계 완료(결과는 각 이슈 파일 하단 절) — 051 전제 정정: InsertTableAt op 기존재, Intent만 부재 / 052 toHwpx 17ms(25p), V3 무오염 통과
- 사고: named 팀메이트 에이전트 2개 무음 정지(1시간 무작업) → 정지 후 무명 백그라운드로 재가동해 4~6분 완료. 교훈은 메모리(no-teammates-tmux)에
- 다음: 아키텍트 확인 → 051(Intent 2신설+화이트리스트 7+제외 3) ∥ 052(설계대로) 구현

## 2026-07-10 (Claude Fable 5) · 아키텍트
- 한 일: 4-에이전트 전수 감사(상호작용 파이프라인/렌더·최적화/브라우저 이식성/리스크) → 로드맵 v2 수립(`docs/PRODUCT-DIRECTION-V2.md` + 이슈 051–056) + 연속성 킷 설치(CURRENT_STATE/JOURNAL/context_restore.sh/AGENTS·CLAUDE/SessionStart 훅)
- 열린 것: R12 미착수 (첫 배치 = 051 ∥ 052)
- 다음: 051의 조사 표(구조 Intent 유/무 3분류) 또는 052의 toHwpx 스냅샷 비용 실측부터
