# 044 — R10-2: 데스크톱 신 셸 — 플래그 뒤 HwpWorkspace 마운트 + host chrome

- 상태: **done** · 우선순위: R10-P0 · 영역: crates/hwp-viewer/ui (신규 엔트리 분기 + host chrome) — **기존 App.tsx 경로 무변경**
- 선행: 043 done (TauriAdapter 22/22, docs/TAURI-CONVERGENCE.md의 044 실행 계획이 이 이슈의 스펙)

## 목표
`VITE_SHELL=workspace`(빌드타임 플래그)일 때 데스크톱 앱이 기존 App.tsx 대신
**@tf-hwp/react HwpWorkspace + TauriAdapter**를 마운트한다. 플래그 없으면 기존 UI가
**바이트 동일하게** 그대로 — 롤백은 플래그 off. 기본값 전환은 이 이슈가 아니다
(SDK 승격 8종 + 회귀 0 체크리스트 후, 감사표 §4).

## 구현 단계 (TAURI-CONVERGENCE.md §4 그대로)
1. 엔트리 분기: ui의 main 진입에서 플래그 분기 — 신규 WorkspaceShell.tsx가 HwpWorkspace를
   TauriAdapter(invoke, resolveOpenPath)로 마운트. @tf-hwp/react·editor-core는 로컬 파일 의존으로
   ui package.json에 추가(빌드 순서 문서화). 기존 App.tsx/의존은 한 줄도 수정 금지.
2. host chrome (감사표의 6종 중 이번 스코프 4):
   - **타이틀바**: 기존 규율 그대로 — h-9(36px) CSS 타이틀바 + data-tauri-drag-region.
     ⚠️ trafficLightPosition/objc/데코럼 재작업 절대 금지(ccb9d5a 확정 해법).
   - **파일 열기**: Tauri 다이얼로그 → 경로/바이트 → adapter.open (043의 resolveOpenPath 계약).
   - **저장/내보내기**: HwpWorkspace의 내보내기 산출물(bytes)을 Tauri 저장 다이얼로그+atomic
     write(기존 P0-1 경로 재사용)로. 웹의 브라우저 다운로드 경로를 데스크톱에서 쓰지 않는다.
   - **드래그드롭 열기**: Tauri onDragDropEvent → open (기존 앱과 동일 UX).
   나머지 2종(클립보드 심화·파일연결 이벤트)은 기존 앱 소유로 두고 감사표 상태 유지.
3. registerFont: 데스크톱은 네이티브 폰트 → no-op 시작(043 문서화 그대로), fontCatalog 미주입.
4. 채팅(바이브 편집): HwpWorkspace의 ChatPanel이 요구하는 LLM 호출 경로를 실측 —
   웹은 /api 라우트, 데스크톱은 기존 ai_edit Tauri 커맨드가 있다. 어댑터/prop 주입으로 연결
   가능하면 연결, 구조가 안 맞으면 v1은 비활성+사유 기록(감사표 갱신). 억지 개조 금지.

## 검증 (GUI 헤드리스 불가 — 빌드·마운트 스모크까지가 자동, 나머지는 수동 QA 큐)
- ui vite build: 플래그 off(기존 번들 — diff로 기존 경로 무변경 증명) / on(신 셸 번들) 둘 다 exit 0.
- cargo check --workspace + cargo tauri 빌드 가능성(cargo check -p hwp-viewer --features pdf).
- vitest(jsdom): WorkspaceShell 마운트 스모크 — invoke mock으로 문서 열기→pageSvg 주입→셀 클릭
  경로 1회(TauriAdapter 경유). 웹 스위트(177)·e2e(20) 무회귀(웹 경로 무접촉이면 대표 확인).
- 수동 QA 체크리스트를 docs/TAURI-CONVERGENCE.md §4에 추가: `VITE_SHELL=workspace cargo tauri dev`
  로 열기→렌더→팬줌/호버/키내비/우클릭/리치에디터→저장/내보내기.

## 수용 기준
- [ ] 플래그 off = 기존 앱 바이트/거동 무변경(기존 경로 diff 0), on = HwpWorkspace 데스크톱 기동
- [ ] host chrome 4종(타이틀바 h-9 규율 준수·열기·저장/내보내기 atomic·드래그드롭) 동작 배선
- [ ] 마운트 스모크 vitest + 두 플래그 빌드 그린, 웹 스위트 무회귀, 엔진 무접촉
- [ ] 수동 QA 체크리스트 문서화(기본 전환 게이트는 후속 — 여기서 플래그 기본값 바꾸지 마라)

## 함정
- 트래픽 라이트 재작업 금지(위). 타이틀바 높이가 h-9에서 벗어나면 신호등이 중앙을 벗어난다.
- @tf-hwp/react dist 소비 시 빌드 순서(editor-core→ai-protocol→react→ui) + 낡은 번들 함정
  (.next의 데스크톱 등가물: vite 캐시/dist 재빌드 확인).
- HwpWorkspace의 파일 input/브라우저 다운로드 같은 웹 관례가 데스크톱에서 새지 않게 —
  chrome 프롭/어댑터로 대체하되 HwpWorkspace 자체 개조는 최소(필요 시 opt-in prop만 추가,
  웹 기본 동작 불변 — 웹 vitest로 증명).
