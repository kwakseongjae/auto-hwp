# 043 — R10-1: Tauri 셸 수렴 전제 — 격차 감사 + TauriAdapter 완전화

- 상태: **done** · 우선순위: **R10-P0** · 영역: packages/react(TauriAdapter만) + crates/hwp-viewer(Tauri 커맨드 additive만) + docs
- 후속: 044(플래그 뒤 셸 교체)가 이 이슈의 감사표를 그대로 실행한다 — **여기서 UI를 만들지 마라.**

## 배경 (사용자 승인 방향)
데스크톱(crates/hwp-viewer/ui)은 자체 React UI라 R5~R8의 피그마급 UX(가상화·호버·팬줌·키내비·
우클릭 메뉴·선택적 갱신·리치에디터 웹판)를 못 받는다. 방향: 데스크톱 셸이 **@auto-hwp/react의
HwpWorkspace를 소비**하게 수렴 → UI 코드베이스 1개, 이후 모든 UX 개선이 양쪽에 동시 반영.
이 이슈는 그 전제조건 둘을 만든다: **① 격차 감사표(수렴 계획) ② TauriAdapter 완전화.**

## 목표 1 — 격차 감사표 (docs/TAURI-CONVERGENCE.md)
두 방향 전수 실측:
- **SDK가 요구하는 것**: HwpWorkspace/useHwpEditor가 소비하는 EngineAdapter 표면 전수(grep으로
  메서드 목록) vs TauriAdapter 구현 현황 vs crates/hwp-viewer의 Tauri 커맨드 현황 → 3열 매핑표.
- **데스크톱이 이미 가진 것**: crates/hwp-viewer/ui/src(App.tsx 등) 정독 — 찾기/바꾸기(Ctrl+F),
  이미지 드래그드롭 삽입·이동/리사이즈 핸들, 문서 아웃라인 패널, 상단 리본, 상태바, 캐럿 렌더
  (NodeId 문단), 파일 열기/저장(atomic save)·내보내기·파일연결, 배포용 문서(crypto), 타이틀바,
  셀 음영/열너비 mm 등 — 각 기능을 [데스크톱 유무 | SDK 유무 | 처분 | 규모 S/M/L]로.
  처분은 셋 중 하나: **SDK 승격**(웹도 이득 — 예: 찾기/바꾸기) / **host chrome 유지**(파일 다이얼로그·
  타이틀바·메뉴 같은 OS 표면) / **보류**(근거 명시).
- 산출물 말미에 **044 실행 계획**: 플래그(예: 환경변수) 뒤 신 셸 엔트리 → 검증 → 기본 전환 순서,
  기능 회귀 0 원칙(감사표의 '데스크톱 유' 기능이 신 셸에서 사라지면 전환 불가).

## 목표 2 — TauriAdapter 완전화 (코드)
- HwpWorkspace가 소비하는 EngineAdapter 메서드를 TauriAdapter가 **전부** 구현하게 한다.
  없는 Tauri 커맨드는 crates/hwp-viewer에 **additive로 추가**(hwp-session 파사드 경유 —
  엔진 crates(hwp-typeset/place 등) 로직 무접촉, wasm 쪽과 동일 시맨틱).
- 단위: vitest(TauriAdapter — invoke mock으로 전 메서드 시그니처/단위 변환), cargo test -p hwp-viewer
  (신규 커맨드), cargo check --workspace.
- ⚠️ 단위 규약: own-엔진 지오메트리 커맨드는 **px**(HWPUNIT/75), ops 커밋은 HWPUNIT — 기존
  own_* 커맨드들과 wasm 바인딩의 규약을 실측해 어댑터에서 통일(§4.5). 슬립은 클릭선택을 침묵사한다.

## 검증
- cargo check/test --workspace + 게이트 v2(8==8·18==18) + 네이티브 골든(viewer 커맨드는 additive지만
  crates 접촉이므로 전체 확인) + wasm 무영향 확인(cargo check -p hwp-wasm).
- packages/react vitest 159+신규 전부 그린, e2e 20 무회귀(웹 경로 무접촉이어야 정상).
- 감사표의 SDK-요구 매핑표가 "구현됨"으로 전부 채워졌는지(빈 칸=미완).

## 수용 기준
- [ ] docs/TAURI-CONVERGENCE.md: 양방향 전수 감사표 + 각 기능 처분 + 044 실행 계획
- [ ] TauriAdapter가 HwpWorkspace 소비 표면 100% 구현(매핑표 증빙) + vitest/cargo 테스트
- [ ] 엔진 로직 무접촉(hwp-viewer 커맨드 additive만), 게이트·골든·wasm 불변, 언스테이지 0
- [ ] 기존 데스크톱 UI/커맨드 무변경(신규 추가만 — 현 앱은 그대로 돈다)

## 함정
- **트래픽 라이트를 건드리지 마라**: macOS 신호등 중앙정렬은 "CSS 타이틀바 h-9(36px)"가 확정 해법
  (8라운드 삽질 끝 ccb9d5a). 감사표의 host chrome 항목에 이 규율을 그대로 인용하고, 044가
  trafficLightPosition/objc 재작업을 시도하지 않도록 명시.
- 데스크톱 자체 UI를 이 이슈에서 수정/삭제하지 마라 — 수렴은 044, 여기는 전제조건만.
- HwpWorkspace의 파일 열기(input[type=file])는 웹 관례다 — 데스크톱은 Tauri 다이얼로그가 host
  chrome으로 감싼다(감사표에 반영). adapter의 open은 bytes 기반(open_bytes)이 이미 있는지 실측.
