# 045 — R11-1: 찾기/바꾸기 SDK 승격 — ⌘F 바 + 매치 하이라이트 + 스크롤-투-매치

- 상태: **done** (8b52825) · 우선순위: **R11-P0** (감사표 SDK 승격 1순위) · 영역: packages/editor-core(find 컨트롤러) + packages/react(FindBar 신규 + HwpWorkspace 배선)
- 병렬: 046(아웃라인+상태바 — HwpWorkspace의 **레이아웃 컨테이너** 소유). 이 이슈는 HwpWorkspace의
  **키보드 이펙트·상단 바 영역**만 소유 — 사이드바/하단바 컨테이너 구조를 만지지 마라.

## 근거 (TAURI-CONVERGENCE.md 감사표)
데스크톱은 Ctrl+F 찾기/바꾸기(#27, find_text/replace_text)가 있고 SDK엔 없다. 승격하면 웹 즉시 +
신 셸(044) 데스크톱도 자동 획득. 엔진 op-bus에 Find/Replace가 기존재(hwp-wasm이 FindMatch DTO를
이미 직렬화 — lib.rs:424) — **엔진 신작 없음이 원칙**, 어댑터 표면부터 실측하라.

## 목표
- **⌘/Ctrl+F = 찾기 바** 오픈(우상단 캡슐), Esc 닫기, Enter=다음, Shift+Enter=이전, "n/m" 카운트.
- **매치 하이라이트**: 현재 매치는 강조색, 나머지는 옅게 — 문서 위 오버레이(선택 마킹과 시각 구분).
  매치 지오메트리는 엔진 반환값(페이지+박스) 사용 — 새 좌표 산술 금지(§4.5 px 규약).
- **스크롤-투-매치**: 다음/이전 이동 시 최소 스크롤(036 scrollCellIntoView 로직 재사용/일반화).
- **바꾸기**: 바꾸기 필드 + [바꾸기]=현재 매치 1건, [모두 바꾸기]=전건+개수 토스트. 커밋은 기존
  op 경로(run 보존 — replace가 런을 붕괴시키지 않는지 **실측 후 테스트로 고정**). undo 동작
  (모두 바꾸기 = 몇 undo 단위인지) 실측해 문서화+테스트.
- 문서 미열림/매치 0건/검색어 삭제 시 상태 처리. 편집 반영(refreshToken) 후 매치 무효화 → 재검색.

## 설계 (SDK-LAYERS)
- **editor-core: FindController** — search(query)/next()/prev()/replaceCurrent(repl)/replaceAll(repl),
  상태(query, matches, cursor). 어댑터 경유(wasm=applyIntent JSON의 Find/Replace 인텐트,
  Tauri=find_text/replace_text 커맨드) — 두 백엔드 **동형 파리티**(043 패턴, 반환 DTO 리맵).
  node 테스트(mock)로 커서 순환/경계/빈질의/replace 후 재검색 고정.
- **react: FindBar** 컴포넌트 + 매치 오버레이(MarqueeLayer/HoverLayer 동형 — 렌더 절제) +
  HwpWorkspace 배선(⌘F keydown — 035/036 리스너와 공존, isEditableTarget 가드는 ⌘F에는 미적용
  이 관례지만 **제자리 에디터 열림 중 동작은 실측 후 결정**(닫고 열기 vs 무시)하고 근거·테스트).

## 구현 단계
1. 어댑터 표면 실측: Find/Replace 인텐트(wasm)와 데스크톱 커맨드의 입력/반환(매치에 페이지·박스
   지오메트리가 있는가? 없으면 하이라이트는 무엇으로 그리는가 — blocksInRect/hit 재조회 등 기존
   지오메트리로 해결, 엔진 신작 금지. 정 안 되면 하이라이트 스코프를 줄이고 근거 기록).
2. editor-core FindController + node 테스트.
3. react FindBar+오버레이+배선 + vitest(⌘F 열기/Esc/Enter 순환/가드/replace mock).
4. e2e: 문서 열기 → ⌘F → 검색 → "n/m"+하이라이트 존재 → Enter 스크롤 이동 assert →
   바꾸기 1건 → SVG 텍스트 변경 확인 → undo → 모두 바꾸기 → 개수 토스트+반영 → undo.
5. 무회귀: 기존 스위트 전부(035 팬줌·036 키내비와 keydown 공존 특별 확인).

## 수용 기준
- [ ] ⌘F 바/Esc/Enter·Shift+Enter 순환/n·m 카운트/하이라이트/스크롤-투-매치 — vitest+e2e
- [ ] 바꾸기 1건·모두 바꾸기 실반영(SVG assert)+undo, run 보존 실측 테스트
- [ ] 두 백엔드 파리티(TauriAdapter 동형 구현 — vitest invoke mock), 엔진 crates 무접촉(원칙)
- [ ] 046 소유 영역(사이드바/하단바 컨테이너) 무접촉, 기존 스위트 그린, 언스테이지 0

## 함정
- 편집(032/040) 커밋 후 매치 좌표가 낡는다 — refreshToken 변화 시 재검색 or 무효화(실측 후 택1).
- replace가 plain-text 계열 op로 떨어지면 런 붕괴(040 교훈) — 엔진 replace의 런 처리 실측 필수.
- e2e 전 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**.
