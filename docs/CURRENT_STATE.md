# CURRENT STATE — 단일 복원 지점

> 새 세션·compact 후 **이 파일 하나만 읽으면 재개할 수 있어야 한다.**
> 갱신 시점: 작업 단위 완료 · 결정 확정 · 머지 직후 (보고보다 먼저). 프로토콜: `AGENTS.md` §세션 연속성.

- 기준 커밋: `6ebfbb2`+CI픽스 — **PUBLIC 전환 + 라이브 데모 배포 완료**(https://kwakseongjae.github.io/tf-hwp/) — **R12~R14 + 실물QA 065·066 + 웹QA 2~6차 + HWPX 시각 파리티 + 레이아웃 정리 토글 완료**. GitHub: https://github.com/kwakseongjae/tf-hwp (private)
- 갱신: 2026-07-22(8) · Claude — **rhwp v0.7.19 재벤더링(fa72e42) + 폰트 카탈로그 온디맨드 제공 구현**.
  ① 062 needsExternal 해소(미러에 upstream 태그 푸시, lift.rs BinDataBytes .load() 적응) — 게이트/벤치 49/49 불변,
  ⚠️ wasm 9.5→11.0MB(+1.5MB upstream 성장). ② 폰트 제공(진단 U8/보강 G): explicit-family bypass(has_family →
  place.rs display_font → pdf.rs EmbedFont.extra per-family 임베드) + HwpWorkspace.ensureCatalogFont(리본/AI 지정 시
  fetch→registerFont→@font-face) — **카탈로그 8종(전부 OFL: Pretendard·Noto Sans/Serif KR·나눔·IBM Plex·고운) 화면·PDF
  실서체 반영**. e2e 41~42/42(048 순서 플레이키 — 격리 그린, 039 계열). 072(카드 위치 보기) 설계 이슈 신설.
- 갱신: 2026-07-22(7) · Claude — **071 undo 메모리 버짓 구현 완료**. 070의 첫 병목(130p 스냅샷 딥카피 ~8MB×50
  = RSS +403MB) 해소: 직렬화 스냅샷은 round-trip/rhwp 노드 훼손으로 **기각**, `SemanticDoc::approx_heap_bytes`
  추정기 + `EditSession::with_budget`(단일 push 경로·바닥 4) + 라이브 레인 **128MiB 버짓**. 실측: 130p RSS
  +403→**+0.1MB**·깊이 50→10 정직 축소, **18p 실물 깊이 50 무회귀**. 게이트 8==8/18==18 · workspace 56 스위트 ·
  vitest 170/320/50 · e2e 42/42 · wasm 재빌드.
- 갱신(6): 2026-07-22 · Claude — **070 대형 문서 실측 완료(보강 F)**. 실 wasm 사다리(8~130p, 실물 4+합성 2):
  편집→화면 **~1ms/쪽 선형**(41p 실물 16ms·130p 136ms, 워커 비차단) → **증분 조판 보류**(재평가 임계 150p+ 실물).
  **첫 병목 = undo 스냅샷 딥카피**(130p·편집50회 RSS +403MB vs 직렬화 0.2MB) → HWPX-바이트 스냅샷 전환이
  ~40배 절감 후속 후보. 벤치 재실행: `node packages/engine/bench/large-doc-bench.mjs`(--synth 지원).
- 갱신(5): 2026-07-22 · Claude — **진단 보강 B+E 구현 완료**. B(fb1268a): AI 화이트리스트 **15→19**
  (Replace·SetCharFmt·SetTableColWidths·SetPageMargins — FOOTER 스탠자·describeIntent 구체 카드·mock Replace
  분기. SetRunCharFmt/SetTableRowHeights는 보수적 폐쇄 유지). **실 Grok 마킹0 실증**: "전부 바꿔줘"→
  Replace{all:true} 카드. E: PDF 스텁 경고 토스트(docProfile 수식/차트 카운트 재사용)+**HWPX 다운로드 버튼**
  (toHwpx 사용자 노출)+README 한/영 "알려진 제약" 절. vitest 47/170/320/50 · **e2e 42/42**.
- 갱신(4): 2026-07-22 · Claude — **069 해소 + 067/진단 커밋 완료**(87834a2 feat 067 · a6cfaf0 docs 진단/068/069).
  069 근본 = **드릴 모델(59fef4f) 미정렬 e2e 3스펙**(048·050·052 — 당시 5스펙만 정렬, 이 3개 누락. 그립 인터셉트는
  표면화 경로). 제품 동작 정상 판정 → 테스트를 드릴로 정렬(표 마킹→500ms→더블클릭 드릴, page.mouse 절대좌표)
  → **전체 e2e 42/42 그린**. 039 간헐 플레이키 1회는 아래 "알려진 flaky"로 추적.
- 갱신(3): 2026-07-22 · Claude — **067 문서 프로필 구현·검증 완료**. `hwp_session::doc_profile`(순수 모델
  walk: 제목후보·구성카운트·헤딩·표 인벤토리[s/b]·to_markdown 발췌) → wasm `docProfile` → adapter optional →
  `DocMeta.profile` → buildDocContext 앵커-우선 예산 삽입(2500자 캡) + 프롬프트 DOC PROFILE 스탠자. **LLM 0콜**.
  검증: workspace 테스트·게이트 8==8/18==18(98.9/99.2%)·wasm 재빌드(9.79MB)+copy·vitest 169/46/316/50·
  e2e 신규 doc-profile-067+066 통과·**실 Grok 마킹0 실증**(사고로그가 프로필 읽고 `TableAppendRow{s0,i1}` 제안).
  ⚠️ 부수 발견: **e2e 사전존재 실패 5건**(052×2·048×2·050×1, HEAD 재현 확정 — hw-row-grip 클릭 인터셉트 의심)
  → **069 신설**. 커밋은 사용자 요청 대기.
- 갱신(2): 2026-07-22 · Claude — **진단 후속 확정**: ① **067 신설**(문서 프로필 = **LLM 0콜 결정론** 확정 — native
  `to_markdown`/`outline` 완비, 병목은 wasm 노출뿐. 배관 5단계 additive 설계 고정) ② **068 실물 벤치 확보** —
  bench-local-2026(archive 24건, must-pass=`2026_*` 8건) + bench-public(공공 25건, HWPX 17/HWP5 8, manifest·KOGL 기록)
  = **49/49 ALL PASS**(detect·own-render·PDF·텍스트), 게이트 `scripts/bench-corpus.sh`(corpus/private=gitignore, 레포 public 주의).
  ⚠️ 게이트는 파이프라인 통과 보증 — 시각 파리티는 별개(딥테크 쌍 25p vs 18p 실측). issues/README stale 표(064~066) 갱신.
- 갱신(1): 2026-07-22 · Claude — **사용자 관점 병목 진단 발행**(`docs/USER-BOTTLENECK-DIAGNOSIS.md`, 분석-only·코드 무변경).
  4축 조사(엔진·에디터/SDK·docs·외부 생태계) → U1~U12(최종 사용자)/D1~D6(임베드 개발자)/S1~S5(전략) + 보강 A~G.
  헤드라인: **AI 문서이해 층 부재(U1)**·npm 미발행+온보딩 6단계(D1·D2)·**rhwp upstream v0.7.19 전면 경쟁 확인**(S1,
  vendored 0.7.15 대비 4버전 갭 — 재벤더링은 여전히 needsExternal)·**정부 HWPX 의무화 2026-05-18 시행**(S3, 전략 순위 급등).
  이후 관련 작업은 이 문서의 ID로 참조. 보강 우선순위는 사용자 승인 대기.
- 갱신(직전): 2026-07-16 · Claude — **HWPX 줄간격 근본진단 + 레이아웃 정리 토글**(4d74c11). 통제실험(동일문서 .hwp/.hwpx)으로
  "hwp vs hwpx 괴리"=파일 열화(한글 hwpx저장이 본문 78%를 바탕글 160%로 리매핑, 한글도 20p로 벌어지게 렌더)임을 증명. 우리 읽기는
  충실. **정규화 옵트인 토글** 추가(hwp-model::normalize_line_spacing → wasm setNormalize → 툴바 "레이아웃 정리"): 열화지문
  감지 시 160%→130% 복원(렌더-IR only·가역·moat보존). 브라우저 실검증: 충실18p(1~10행)↔정규화17p(1~12행=.hwp). 게이트 8==8/18==18.
  직전 시각 파리티 배치(c51e5ef): ①행높이(7a06e9f) ②볼드 weight-700(021a08f) ③serif 명조번들(c51e5ef).

## 지금 (현재 위치)
- 로드맵 기준: **R12 + R13 + R14 완료 + 후속 배치 진행** — R12(051~057), R13(058·059·060),
  R14 062(배포용복호=056해소·옛한글·금칙·대각선·수식v1·차트v1) + 063 웹 이식 패키징.
- **후속 배치(2026-07-13, 트리아지 90항목→7 actionable)**: ✅ flaky 028툴바 격리(Date.now 고정, 3회 296/296) ·
  ✅ IME Chrome CDP e2e(059 회귀락, main 통과) · ✅ BMP PDF 임베드(순수 Rust 파서, stub 제거) ·
  ✅ FaceName PANOSE 분류(rhwp type_info, 게이트 before==after) · ✅ rhwp upstream/kordoc 조사(→062 문서).
  ❌ 중첩표 토스트=엔진 nested 미방출 speculative→**revert, 064 신설**(엔진 선행). 
  남은 후속: **#7 npm 발행 자동화 = 063에서 이미 완료**(중복 계산이었음). **rhwp 재벤더링 v0.7.18 = 블로킹**
  (미러 포크에 태그 없음 → needsExternal, 062에 실행 스텝). → **지금 처리 가능한 후속 전부 완료.**

## 실물 QA 발견 → 수정 완료 (2026-07-13, ~/Desktop/archive 24개 실물 + Grok 4.5 실호출)
OpenRouter/Grok 4.5 웹 생성 연동 완료(`.env.local` BYOK). 실물 스윕 발견 P0 2건 = **둘 다 수정·병합·검증 완료**:
- **065 ✅ done (79ecd1a 푸시)**: 압축 mimetype HWPX 거부 → 실물 6/24(25%, 작성완료본) 안 열림. detect fallback으로
  ZIP 중앙디렉토리 엔트리 NAME(`Contents/header.xml`) 스캔(DOCX식, inflate 0 → wasm-clean·압축폭탄 0). 6개 전부 회복.
- **066 ✅ done (dab3e87)**: 바이브 표 편집 컨텍스트 blindness. hwp-session `table_grid`(edit_target 언랩·active 셀만)
  → wasm `tableGrid` → WasmAdapter → buildDocContext 그리드 첨부(`(rNcM)`+`_빈칸_`, dedup·truncate·회귀 바이트동일).
  프롬프트 FOOTER에 TABLE GRID/ADDING ROWS 규약. **실 Grok 4.5 실경로 실증**: 그리드+"표 채워줘"→col1 값칸에만
  SetTableCell(col0 라벨 미접촉), 066 이전 intents:[] 완전 해소. 구조편집(행 추가) 프롬프트도 동반 보강(F3).
- 정상 확인: .hwp 렌더/export/게이트(8==8~25==25, 99.4%) OK, 문단 편집 Grok 정상, PDF/HTML export OK(작성완료본 제외).
- 스윕 도구: `scripts/`(임시 qa-sweep는 scratchpad), CLI own-render/export-html/export-pdf/layout-check.

## 웹 QA 2차 피드백 배치 (2026-07-14, 사용자 실사용 스크린샷) — 진행 중
사용자가 웹에서 표 편집 QA 중 발견한 4건. 착수 전 병렬 조사(wrong-cell/선택모델/deselect/인라인diff)로 근본 매핑:
- **#1 라벨 덮어쓰기 (P0, 데이터손상) ✅ 수정·커밋(0f09ac4)**: "아이디어명은 여명거리로"가 대표자명 라벨칸(r0c0)을
  덮음. 근본 = **스테일 `packages/ai-protocol/dist`** — 066은 src만 고치고 dist 재빌드 안 함(앱은 컴파일 dist 소비).
  스테일 buildDocContext가 grids 드롭 → 얇은 컨텍스트 → 모델 라벨칸 추측. durable 수정: hwp-lab `predev`/`prebuild`가
  `build:deps`(ai-protocol→editor-core→react) 선행 → `npm run dev` 항상 최신 dist. verify-local.sh --full에도
  ai-protocol 빌드 추가(스테일이 그린으로 새던 구멍). playwright webServer는 provider 키 비워 e2e mock 고정.
  e2e chat-table-grid-066 mock 통과(docContext에 표 그리드 실림 확인). **⚠️ 실 Grok으로 프레임표 최종 육안 재확인 권장.**
- **#2 빈바탕 클릭 미해제 ✅ 수정·커밋(0f09ac4)**: `finishClick`이 `block_at` nearest-band 폴백(x무시)을 신뢰 →
  빈 공간 클릭이 가장 가까운 문단을 잡음. strict-containment 재검사로 교정. editor-core vitest 157(+1 회귀).
- **#4 Figma식 표 선택 ✅ 병합(59fef4f)**: 클릭=부모 표 → 더블클릭=셀 진입 → 재더블클릭/Enter=텍스트 편집(사용자 승인).
  editor-core `drill` 상태 + finishClick 우선순위 반전(표 히트=전체표, drill시 셀) + `drillInto`/`currentCell` +
  React `handleDoubleClick`(드릴 vs 에디터)/placeCaretAt 게이트/우클릭 드릴. editor-core 162·react 301.
  e2e 9건이 옛 상호작용(셀 단일클릭·더블클릭편집)으로 깨져 **드릴 모델로 정렬(5693ecb, 5스펙)** → 21 통과.
  ⚠️ **Enter=편집은 실앱서 053 캐럿이 Enter를 삼켜 안 열림**(재더블클릭은 됨) → 후속 수정 대상. 실포인터 육안은 로컬 QA.
- **#3 인라인 편집 ✅ 병합(c1a9476)**: 선택 요소 우하단 `✨ 여기서 편집` → 요소 아래 InlineEditPanel(compose→busy→
  applied→error) → 지시 제출 시 `onAiRequest`(채팅과 동일 그리드 컨텍스트)로 즉시 apply(1 undo 배치) → 변경본
  in-place 표시 + `적용 유지`/`되돌리기`(session.undo). 이중 revert 가드(외부편집·클릭어웨이 = close-and-keep).
  셀/문단/표/이미지 전부. react +4 테스트(총 301). **잔여 UX 판단(사용자 확인)**: AI 진입점 2개(툴바 채팅 ∥ 인라인 필)
  공존 → 통합 여부 · 인라인에 수동 텍스트 직접편집 추가 여부.

## 웹 QA 3차 피드백 배치 (2026-07-14) — ✅ 병합·검증 완료 (미푸시)
QA에서 #1(표 자동인식·채우기) 실 Grok 프레임표 작동 확인 후 신규 3건. 조사 4건 → 3 병렬 워크트리 → ①→②→③ 순 병합(전부 clean cherry-pick). 승인 범위 = ①②③-C·A-v1(스트리밍 투명성 ③-v2는 다음 배치).
- **① 채우기 색상 검정화 ✅ (32f521b, Rust)**: `Op::SetTableCell`/`SetParagraphRuns`가 빈칸 첫 run char_shape 전체(색 포함) 물려줘 예시 파랑/빨강 반영되던 것을, plain-run 분기에서 char_shape clone→`text_color=Color::default()` reintern(폰트·크기 유지)로 교정. 수동 명시색 run은 non-plain이라 자동 우회(스코핑). hwp-ops 65 테스트, **게이트 before==after 8==8/18==18, wasm 재빌드+복사 완료**.
- **② 다중페이지 드래그 ✅ (c6e5319, JS)**: `pointerMoveMultipage(client, slices)` 신설(React가 캡처 하 교차페이지+sub-rect 계산, core DOM-free 유지)+edge auto-scroll, `finishMarquee` 페이지별 loop+union, `SelMarquee.boxes` 확장, MarqueeLayer 페이지별 슬라이스. editor-core 163·react 301(030 렌더격리 유지). **⚠️ 실제 교차페이지 지오메트리·auto-scroll은 로컬 육안 QA**(jsdom은 페이지 스택 불가).
- **③-C 챗카드 revert + ③-A 웹검색+인용 ✅ (4aa1083, JS)**: (C) `DocSession.undoDepth()` + ChatPanel 적용카드 지속 `되돌리기`(top-of-stack만 활성, off-top은 비활성+툴팁) → `revertChatEdit`→session.undo. (A) `🔎 웹 검색` **토글**(휴리스틱 대신) → `OnAiRequest` additive 4th param `opts?:{webSearch?,onCitations?}`(InlineEditPanel 무영향) → route.ts `plugins:[{id:"web"}]` when webSearch → `EditResponse.citations?`(additive)+`extractCitations`(url_citation) → 챗 "🔎 근거" 링크. 스트리밍 없음. ai-protocol 23·react 305·hwp-lab 44.
- 통합 검증: 빌드 OK, vitest 23/163/305/44, 게이트 8==8/18==18, 챗/smoke/editing e2e 11 통과. **잔여(사용자 판단)**: always-revert 완전형(주소화 배치/보상편집=오래된 편집 개별 revert) + 스트리밍 투명성(③-v2, 검색어→결과→구성→반영 실시간)은 다음 배치.

## 웹 QA 4차 피드백 — 대형 다배치 (2026-07-15, 설계 완료·사용자 승인) — 진행 중
QA에서 8건 피드백. 6레인 병렬 설계조사(qa4-design-explore workflow) 완료. **엔진레벨 통일 원칙: 엔진은 항상 Intent를 낸다** — AI 사고/검색=스트리밍 AgentEvent 로그, 첨부=컨텍스트(새 Intent 아님), 표생성=기존 InsertTableAt, 선택주소=CellPath(중첩), 썸네일=기존 SVG 재사용. 사용자 승인: 권장 배치순서·중첩표 Tier2까지·멀티모달 이미지+문서 둘다.
- **배치1 ✅ 완료 (fd473f0·dd3f0ff·13535fc, 미푸시→푸시예정)**: ⓐ **호버 빈배경 색변**(13535fc)=`useHover.ts` runQuery에 strict-containment(pointInBox) 가드 → 실제 객체 위에서만 hover(회귀 테스트). ⓑ **표 생성**(dd3f0ff, 프롬프트갭)=prompt.ts에 내용채움 예시(팀 4×2)+"데이터→표" 스탠자(엔진 InsertTableAt 완비). ⓒ **중첩표 Tier1 데이터손실**(fd473f0, Rust)=`Op::SetTableCell` **보존방식**(문단만 splice·중첩 Block::Table 보존)+CellHit.nested 엔진세팅+정직한 토스트("중첩표는 아직 편집할 수 없습니다", 064 Tier1). cargo workspace 444, 게이트 before==after, wasm 재빌드. 통합: vitest 25/163/307/44, 8==8/18==18.
- **배치2 ✅ 완료 (fa7e22c·3fbb841, 푸시예정)**: ⓓ **페이지 썸네일**(fa7e22c)=OutlinePanel이 adapter.pageSvg→sanitizeSvg→래스터(Blob img)+IntersectionObserver lazy+클릭 점프+active 하이라이트(자기완결 030, 헤딩모드 보존). ⓔ **멀티모달 입력**(3fbb841)=`Attachment{kind,dataUrl?,text?}`+ChatPanel 📎/붙여넣기/칩+이미지=content-parts image_url(**grok-4.5 비전 확인**=input_modalities text/image/file)+doc=TXT/텍스트류 클라 추출(HWP/PDF/DOCX는 정직한 "미지원" 칩·deps 0). additive(EditRequest.attachments·buildUserMessageParts·AiRequestOptions.attachments, InlinePanel 무영향). ⚠️R5 펜스 유지. 통합: vitest 31/163/313/47, 8==8/18==18.
- **배치3 ✅ 완료 (22cbc58, XL, 푸시예정)**: ⓕ **에이전틱 AI**=`POST ?stream=1` NDJSON ReadableStream(비스트리밍 JSON+InlineEditPanel 유지=back-compat). 모델주도 툴콜링 루프(tools/tool_choice:auto/stream:true) — web_search는 OpenRouter `plugins:[{id:web}]` 서브콜로 실행+url_citation, emit_intents 종료(whitelist 재검증), max 5 iter. AgentEvent 유니온(status/thinking_delta/tool_call/tool_result/intents/error)+NDJSON parser. 대화 메모리=최근 6턴·각 ≤800자(클라 MEMORY_TURNS+서버 readHistory 이중강제, assistant는 편집 다이제스트). ChatPanel `thinking` 변형+StepTimeline, **🔎 토글 제거**(검색=모델주도). R5(검색결과·첨부=DATA 펜스)·R6(키 서버측). 통합: vitest 40/163/318/50, 8==8/18==18. **⚠️ 실 스트리밍 웹검색은 로컬 수동 QA**(테스트는 mock). Anthropic 경로는 미니멀 타임라인(웹검색 없음).
- **배치4**: ⓖ **중첩표 Tier2 ✅ 완료 (8afc6e3, 푸시예정)**=`CellPath`(descending, flat quad=length-1 fast case로 back-compat)를 전 스택 배선: place_nested_table provenance(rfind topmost가 inner 승리·additive 무기하변화)+hwp-session hit/read(resolve_cell_path·block_runs_path)+`Op::SetTableCellPath`(비파괴 rebuild 공유)+editor-core 드릴 스택({section,path})+react. Tier1 토스트 제거→중첩표 더블클릭 편집. **게이트 before==after·LOCKSTEP 확인**(place.rs flush_fragment 핀인덱스·band find ancestors 가드 수정). cargo workspace·editor-core 168·react 318·wasm 재빌드. 안전이연: 캐럿레인 flat(중첩은 더블클릭 편집)·Tauri flat·컨텍스트메뉴 행삽입=외곽표. ⓗ **차트/도표 생성 ✅ 완료 (80d2607)**=신규 `InsertChartAt`(막대/원/선). `chart_gen.rs`(순수 Rust SVG, deps 0)가 데이터→SVG 생성, **062 `ChartRef`→PaintOp::Image.svg 채널 재사용**(렌더/HTML/PDF 신규코드 0), Op이 InsertImageAt처럼 object 문단 삽입. LOCKSTEP(place_doc↔NaiveLayout 박스예약, 062가 이미 chart-aware)·게이트 before==after. PDF=예약박스 스텁(062처럼 벡터화 이연). whitelist 40→41, 프롬프트+describeIntent 카드+mock. **QA4 8/8 완료.**
- **배치3 실 Grok 스트리밍 웹검색 검증됨**: `?stream=1`에 검색요청→status=thinking→thinking_delta→searching→tool_call(web_search)→tool_result(citations=4)→composing→intents. 모델주도 검색·사고스트림·출처 실작동(합성앵커라 intents=0이지만 파이프라인 정상).
- 설계 근거 전문: workflow wf_ec4aacad-4cf journal. 3차까지=2fe44d3, QA4 배치1=16898c1·2=4e239d5·3=d890d37·4=8afc6e3.

## 웹 QA 5차 피드백 (2026-07-15) — #1 완료, #2·#3 조사 중
- **#1 에이전틱 편집 "제안된 편집 없음" 멈춤 ✅ 수정·푸시(59101a6)**: 근본=Grok이 `emit_intents` 터미널 툴콜에서 degenerate(인텐트명 오염 'SetTableCell纺'·공백 폭주)→화이트리스트 드롭→intents 0. + 러너 핫리로드됐지만 프롬프트(ai-protocol dist)가 서버 캐시 스테일이라 모델이 없는 툴 시도. 수정: **emit_intents 툴 제거→최종 편집을 JSON 배열 텍스트로 출력**(비스트리밍과 동일 검증 경로)+AGENT_PREAMBLE JSON계약+웹검색 캡(AGENT_MAX_SEARCHES=3, tool_choice:"none" 강제). 실 Grok 실증: 명시 채우기→SetTableCell 1건, 검색+채우기→3검색후 1건. ai-protocol 42·hwp-lab 50·react 318·게이트 불변.
- **#2 Figma식 컨트롤 ✅ 수정(86ad5b9, 푸시예정)**: 조사서 **지속 리본(FormatRibbon/048)이 이미 존재·마운트**됨을 발견 — 플로팅 툴바(028)는 중복이었음. FloatingToolbar 렌더 제거 → 서식은 지속 리본에만, 리본에 **서체 피커 추가**(applyRibbon 양 arm→setFont/applyLiveStyle), **컴팩트 ✨AI에게 전달 pill**(hw-ai-send, marks>0·union bbox 앵커, 여기서편집 pill과 stacked, aiFocusToken만 bump). react 316, 게이트 8==8/18==18. 테스트·e2e(editing-027/ribbon) 갱신.
- **#3 HWPX 렌더 깨짐 (근본 확정, Batch A+B 구현 중)**: **통제실험 근본** = 렌더 엔진은 공유·정상(place_doc→SvgSink source-agnostic). HWP는 rhwp lift(풍부 IR), **HWPX는 얕은 자체 파서 `hwp-hwpx/parse.rs`가 run을 char_shape 0·문단 para_shape 0으로 하드코딩** → 전 텍스트 10pt 검정(볼드·크기·색·명조 소실)·페이지수 오류(청창사 PDF 18 vs 우리 25). **풀(header_pools)은 이미 파싱돼 메모리에 있으나 char_ref→char_shape 배선 누락** = 싼 수정. secPr 여백·표·이미지도 드롭. **Batch A+B ✅ 수정(88e9d31, 푸시예정)**: `resolve_shape_pools`(parse_semantic 말미)가 run.char_ref→char_shape·paraPrIDRef→para_shape 해석(셀 문단 para_ref 캡처 포함), `parse_page_setup`이 secPr 여백→Section.page. **실측(export-html): 폰트 크기 1→4종·검정만→#0000FF/#FF0000+음영색** 회복(HWP 렌더 근접). 페이지수 개선(청창사 25→22). **round-trip moat 보존**(hwpx_pool_* 추적·build_synth_plan 미편집분 재synth 스킵). cargo workspace 466·hwp-hwpx 42+3·게이트 before==after·wasm 재빌드. 덤: hwp-jsx CSS 파서 brace-depth 버그 수정.
**Batch C+D ✅ 완료(0f894b8, 푸시예정)**: C=cellSz→col_widths/row_heights(span-aware)+borderFill 풀 파서→테두리/음영/대각선/cellMargin padding. D=hp:pic→Inline::Image+content.hpf opf:item→bin_data, fontface 풀→font_family(명조/고딕). **실측(창도약): 음영 81·테두리·비균등열·폰트패밀리 다수(함초롬바탕 serif 등), 청창사 이미지 임베드.** round-trip moat 보존(Table.geometry_edited 플래그·이미지 dedup). cargo workspace 475·hwp-hwpx 51·게이트 before==after·wasm 재빌드. **HWPX = HWP 수준 렌더 도달.** 이연: 수식/차트/필드(mark_not_simple 유지)·잔여 페이지수 갭(폰트메트릭 근사, 지오메트리 밖).
`cd apps/hwp-lab && rm -rf .next && npm run dev` → Chrome. **QA.md 시나리오 ⑪~⑱**(이번 세션 신규 렌더:
수식·차트·대각선·옛한글·IME·명조고딕·금칙·배포용복호/BMP)을 원본 PDF/한컴 뷰어와 대조. 기존 ①~⑩도 회귀 확인.
QA 발견사항 → 이슈로 정리해 다음 배치. WKWebView IME 실기(059)는 데스크톱 Tauri에서 별도 수동.
- **062 렌더러 승격 요약**: 배포용복호·옛한글·금칙·대각선·수식·차트 = rhwp(MIT) 승격 완료.
  **잔여(후속)**: ① 수식/차트 자체 PaintOp 이식 v2(Path/Bezier 프리미티브 필요, XL) + krilla PDF 렌더
  ② 레거시 OLE VtChart(rhwp도 미렌더) ③ rhwp upstream(>v0.7.15) 델타 미확인 ④ 폰트메트릭=디스코프(영구).
- **063 = 병합 완료**: file:→실버전(prepack 치환)·prepack 빌드훅 4패키지·발행 CI(publish.yml dry_run 기본)·
  Vite 임베드 예제(published tarball 설치→렌더 스모크 그린)·AI 프록시 Express 템플릿·EMBED-GUIDE. `npm pack`
  4종 tarball 실측(pkg/dist 포함·file:의존 0). ai-protocol dist ESM `.js` 결함 수정. **실 npm publish는 미실행(pack까지).**
  → 외부 사이트에 `npm i @tf-hwp/react @tf-hwp/engine` 임베드 준비 완료(발행은 사람이 workflow_dispatch로).
- **오픈소스 조사 헤드라인(2026-07-13)**: 우리 약점 상당수(배포용복호·금칙·정렬·다단·대각선·수식·옛한글·
  폰트메트릭)가 이미 external/rhwp(MIT, 우리 소유)에 완성 — 파스전용이라 미배선. → **062 신설**(라이선스 0 승격).
  056 crypto는 062-1(배포용 복호화 quick win)로 해소 경로 확정. 웹 이식 갭 → 063 승격 대기(패키징 최종 1마일).
- 로드맵 정본: `docs/PRODUCT-DIRECTION-V2.md`(북극성 = 브라우저 프로덕션: 업로드→바이브+수동 편집→PDF) + 진행표 `docs/issues/README.md`(상태 진실은 git log — 복원 스크립트가 대조).
- 제품 현 수준: 웹(`apps/hwp-lab`)에서 업로드→수동+챗 편집→PDF/HWPX export가 전부 클라이언트사이드로 동작. 판정 = "강한 내부 데모/프라이빗 베타, GA 아님"(격차 5개가 이슈 051~056).

## 다음 (사용자 승인 완료 2026-07-13 — 이 순서로 자율 진행)
1. **060 프레임표(R13 마감)** — 구현 중. 병합 후 →
2. **062 quick win 배치** — external/rhwp(MIT, 우리소유) 승격. 착수 순서: 062-1 배포용복호화(=056 해소,
   난이도 낮음·rhwp crypto.rs NIST벡터) → 062-2 옛한글 PUA(Public Domain) → 062-3 금칙(줄바꿈 향상).
   ⚠️ 062는 조판 입력 변경 가능(금칙) → 게이트 V5 필수 재확인. rhwp는 읽어서 우리 crate에 재구현(vendored 수정 금지).
3. **063 웹 이식 패키징** — 이슈 파일 신설 필요(README 웹이식 절 근거). 블로커: file:→실버전 + prepublish훅 +
   발행CI + 비-Next wasm서빙 레시피 + 임베드 예제. npm 발행 준비.
- **웹 QA(사용자, 로컬)**: `cd apps/hwp-lab && npm run dev` → localhost:3000 (QA.md). WKWebView IME 4항목 수동 큐(059).
- 검증 정본: `scripts/verify-local.sh` (--full 포함). CI는 수동 전용(`gh workflow run ci`).

## 알려진 flaky (추적 — 실회귀 아님)
- `packages/react/.../workspace.editing.test.tsx` "in-place 에디터 열림 중 028 툴바 숨김" — 전체 스위트에서
  간헐 실패(063 --full에서 1회), **격리·재실행 시 296/296 그린**. 테스트 순서/타이밍 격리 결함(소스 회귀 아님).
  후속: 이 테스트의 공유 상태(타이머/DOM leak) 격리. verify 실패 시 이 테스트면 재실행으로 판별.
- e2e `context-menu-039` "셀 우클릭 → 굵게 → SetCellRangeFmt 토스트" — 전체 스위트에서 간헐 실패
  (2026-07-22 1회), **격리 2회·풀스위트 재실행 그린(42/42)**. 순서/타이밍 계열(069 마감 시 확인).

## 막힘 / 대기 (없으면 "없음")
- 없음. (056 배포용 crypto는 "수요 확인" 게이트 — 미착수가 정상 상태)

## 진행 중 레인 (병렬 작업 시에만)
| 레인/ID | owner | 상태 | 다음 체크포인트 |
|---|---|---|---|
| (없음 — 062 잔여 배치 B1·B2·B3 전부 병합·검증 완료) | | | |
