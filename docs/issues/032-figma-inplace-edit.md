# 032 — R5-3: 피그마식 제자리 텍스트 편집 (팝오버 크롬 제거)

- 상태: **open** · 우선순위: R5-P1 · 영역: packages/react (+editor-core 최소)
- 선행: **030 병합 후** (렌더 경로 안정 위에서; HwpWorkspace 편집 배선 충돌 방지)

## 사용자 QA 관찰 (스크린샷)
셀 더블클릭 시 별도 박스(테두리+저장/취소 버튼+힌트)가 떠서 **"편집 상태가 될 때 UI가 너무
바뀐다"** — 원하는 것: **피그마처럼 보이는 크기·위치 그대로** 그 자리에서 편집.

## 목표
더블클릭하면 셀 **바로 그 자리에**, 같은 폰트 크기(×줌)로 텍스트가 편집 가능해진다.
크롬은 얇은 포커스 링 뿐 — 버튼/힌트 박스 없음. Enter=저장, Esc=취소, blur=저장,
Shift+Enter=줄바꿈. IME 조합 중 커밋 금지(기존 가드 유지). 커밋은 기존 run 보존 경로
(editCellText — 027) 그대로.

## 구현 단계
1. **InPlaceCellEditor 컴포넌트(신규)**: 셀 rect(페이지px×scale — HwpPageView 기존 변환
   단일점)를 그대로 덮는 absolutely-positioned contentEditable(plaintext-only) 또는 textarea.
   스타일 매칭: font-size = 셀 첫 run의 size_pt × scale(blockRuns로 조회 — 027의 read 경로
   재사용), line-height·padding은 렌더와 최대한 근사, 배경 흰색/셀 음영색, 테두리 없음 +
   `outline: 2px focus ring`. 편집 중 원본 SVG 셀 텍스트는 가리기(에디터 배경으로 자연 커버
   — 셀 rect보다 작지 않게).
2. **진입/종료**: 더블클릭 진입(기존), 진입 시 전체선택 대신 **클릭 지점 근처 캐럿**은 v1
   스코프 밖(전체선택 허용 — 문서화). Enter 저장 / Shift+Enter 개행 / Esc 취소 / 외부 클릭
   blur 저장. 저장 실패 시 에디터 유지+에러 토스트.
3. **오버플로**: 입력이 셀 높이를 넘으면 에디터가 아래로 자연 확장(문서 위에 떠서) — 저장 시
   엔진이 재조판(행 성장)하므로 시각 점프 최소화를 위해 저장 직후 해당 페이지 재렌더까지
   포커스 링 유지.
4. **CellTextPopover는 export 잔존**(하위호환, deprecated 주석) — HwpWorkspace 기본 경로만
   InPlace로 교체. 문단 편집(editParagraphText)도 동일 패턴 적용 가능하면 포함, 아니면 셀만
   +사유.
5. **테스트**: vitest — 진입 시 위치/폰트 스타일 일치(모의 rect·scale로 스타일 계산 단위테스트),
   Enter/Esc/blur/IME 가드, run 보존(기존 테스트 재사용). Playwright — 텍스트 수정 시나리오를
   InPlace 경로로 갱신: 더블클릭 → **에디터 bbox가 셀 bbox와 근사(오차<4px) assert** → 타이핑
   → Enter → 문서 반영 + 볼드 유지.

## 수용 기준
- [ ] 더블클릭 시 셀 rect 위 제자리 편집(위치·크기 오차<4px assert), 크롬은 포커스 링뿐
- [ ] 폰트 크기×줌 매칭(단위테스트), Enter/Shift+Enter/Esc/blur 규약, IME 가드 유지
- [ ] 커밋은 editCellText(run 보존) 그대로 — 볼드 유지 e2e 재통과
- [ ] CellTextPopover 하위호환 잔존, vitest·Playwright 전부 그린, 엔진 무접촉

## 함정
- 줌 변경/스크롤 중 편집 열림 상태면 에디터가 셀에 붙어 따라가야 한다(같은 scale 소스).
- contentEditable plaintext-only는 브라우저별 차이 — textarea가 더 안전하면 textarea+자동
  높이. 리치 서식 편집(부분 볼드)은 스코프 밖(033 리서치 항목).
- 편집 중 플로팅 툴바(028)는 숨김(두 크롬 경합 금지).
