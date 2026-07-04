# 041 — R8-2: 글리프 캐럿 지오메트리 노출 + 셀 캐럿 갭 실측 (FG-12 전반부)

- 상태: **done** (7248b71) · 우선순위: R8-P1 · 영역: packages/editor-core + packages/react의 어댑터 파일만
  (WasmAdapter.ts/TauriAdapter.ts/EngineAdapter — **컴포넌트/HwpWorkspace/styles/index.ts 금지**)
- 병렬: 040(에디터/HwpWorkspace 소유). UI 없음 — 이 이슈는 **모델+어댑터+테스트+실측 보고서**가 산출물.

## 실측 근거 (2026-07-04 코드 확인)
- `Intent::HitTest{page,x,y}` → `HitResult{node?,block?,offset,section,para_ord,in_cell,para_len}` —
  **글리프 단위 오프셋이 이미 나온다**. wasm applyIntent가 이미 직렬화(hwp-wasm lib.rs:424,451).
- `Intent::CaretRect{page,node,offset}` → `CaretRect{x,top,height}` — 존재+wasm 배선 완료.
- **갭(중요)**: HitResult.node는 "표 셀 내부 클릭"과 "NodeId 없는 문단(미편집 바이너리 .hwp)"에서
  None(hwp-mcp lib.rs:45-61 주석) → CaretRect가 셀 텍스트에 쓸 수 없다. 우리 벤치마크 문서의
  본문 대부분이 표 안이므로 이 갭의 정확한 범위가 FG-12 후반부(캐럿 UI) 설계를 결정한다.

## 목표
1. **노출**: editor-core에 TextAnchor 모델(문단/셀 + 문자 오프셋) + EngineAdapter에
   `hitTestText(page,x,y)`(offset/para_len 포함 HitResult 전체)와 `caretRect(page,node,offset)`
   시그니처 추가, WasmAdapter(applyIntent JSON 경유)·TauriAdapter(기존 명령 경유) 구현.
   018 null 정책(캐럿 없는 지점 = null, throw 금지) 준수.
2. **실측 보고서**(docs/CARET-GAP.md): 셀 캐럿 갭의 정확한 원인 체인(HitResult.node=None 조건 →
   caret_rect_current의 NodeId 의존 → node_to_section_para_ord) + 벤치마크 3종에서 클릭 지점별
   node 유무 매핑 + **셀 문단에 캐럿을 주려면 엔진 경계에 무엇이 추가로 필요한지**(예: cell-addressed
   CaretRect variant) 난이도/리스크 평가. FG-12 후반부(042) 이슈로 바로 승격 가능한 수준으로.
3. para_len 클램프 규약(HitResult 주석: past-end는 clamp되지 null 아님 — UI가 null로 문단끝 추론
   금지)을 editor-core 계약 주석+테스트로 고정.

## 구현 단계
1. wasm 스모크(node): benchmark.hwp/benchmark1.hwp에서 HitTest→offset/para_len, (node 있으면)
   CaretRect 왕복 — 좌표→오프셋→rect가 클릭 지점 근방인지 assert.
2. editor-core TextAnchor + adapter 시그니처 + 두 어댑터 구현 + node 테스트(mock).
3. 갭 매핑 실측: 세 벤치마크에서 격자 클릭 스캔 → in_cell/node 유무 분포 → CARET-GAP.md.
4. 게이트/골든: crates를 만졌다면(원칙: **불필요 — 이미 배선됨을 실측했다. 만지게 되면 사유를
   보고서에**) native golden 바이트동일 + 8==8·18==18 재확인.

## 수용 기준
- [ ] EngineAdapter.hitTestText/caretRect + 두 어댑터 구현 + editor-core TextAnchor — node 테스트
- [ ] wasm 실문서 스모크(오프셋/rect 왕복) 통과, 018 null 정책·para_len 클램프 규약 테스트
- [ ] docs/CARET-GAP.md — 갭 원인 체인 + 벤치마크 클릭 분포 실측 + 042 승격안(난이도/리스크)
- [ ] crates 무접촉이 원칙(접촉 시 golden+게이트 증빙), 040 소유 파일 무접촉, 언스테이지 0

## 함정
- CaretRect는 rhwp feature 게이트 뒤에 있다(hwp-mcp lib.rs:385) — wasm 빌드가 이 feature를 켜는지
  실측부터. 꺼져 있으면 "no rhwp" 에러 경로가 어댑터에서 null로 정규화되는지 확인.
- HitResult.offset은 문단 문자 기준, CaretRect 좌표는 page px(§4.5 px 규약) — 단위 슬립 주의.
- 이 이슈는 UI를 만들지 않는다 — 캐럿 오버레이/클릭 배선은 042(후속)다. 스코프 크리프 금지.
