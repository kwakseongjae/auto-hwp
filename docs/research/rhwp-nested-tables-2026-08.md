# rhwp 중첩 표·중첩 셀 스레드 전수 조사 (2026-08-10)

- 조사 범위: `edwardkim/rhwp` 이슈·PR·디스커션 (`gh search`/`gh api`, 한·영 키워드 13종). 인용은 원문.
- 목적: 우리 081(중첩 셀 캐럿 CellPath 관통) 설계의 레퍼런스. 조판 수치 축은
  [[rhwp-landscape-2026-08.md]] 소관 — 여기는 **중첩 표 축만**.
- 규모 실측: `"중첩 표"` 이슈/PR **198건** · `"중첩 셀"` 146건 · `cellPath` 72건 ·
  오너 본인 개설 중 중첩 표 포함 16건. 얕은 축이 아니라 **최근 4개월 상시 전선**이다.

**한 줄 결론: rhwp는 우리가 지금 서 있는 자리(중첩이면 캐럿 차단 가드)를 정확히 통과했고,
평면 주소를 같이 남겨 둔 대가로 5계층 버그 사슬(#2792, 아직 open)을 겪는 중이다.
그 상처의 기록 전체가 우리 설계의 정답지/오답지다.**

## 1. 핵심 스레드 (오너 발언 중심)

### 편집 주소체계 축 — 우리와 정면으로 겹치는 곳 ★

- **[#2792 queries 평면 셀 튜플 전수 지도 (5계층 사슬)](https://github.com/edwardkim/rhwp/issues/2792)** (07-21, **open**):
  평면 4-튜플 `(parent_para, ctrl_idx, cell_idx, cell_para)`는 깊이≥2를 표현 불가 → hit-test가
  `path[0]`으로 평면 필드를 채우는 지점 21곳 → 증상 패치 3건 → 살아있는 증상(검색/치환 중첩 미탐,
  선택 rect 지정 불가, Home/End가 바깥 축 줄정보) → byPath API 부재. 실측:
  > 안쪽 셀 텍스트 `X` 에 대해 `replaceAll("X","Y")` → `{"ok":true,"count":0}`
  설계 원칙(원문): *"새 경로 타입을 발명하지 않는다"* / *"깊이 일치(`ctx.path.len() == path.len()`)가
  구조적으로 강제되어 #2651 가드는 특례가 아니라 정의가 된다"* /
  **"깊이≥2 히트는 `cellPath`만 갖는다(거짓 평면 좌표를 만들지 않는다)"**.
- **[#2651](https://github.com/edwardkim/rhwp/issues/2651)** 판결(레벨 4b): *"**가드는 오매칭을 not-found로
  바꿨을 뿐**"* — 우리 `place.rs:1682` `if !t.ancestors.is_empty() { return None; }`가 정확히 이 상태.
- **[#4252 재귀 분할 중첩 표의 선택이 잘못된 cellPath로 실패](https://github.com/edwardkim/rhwp/issues/4252)** (08-08):
  분할 조판이 합성 문단 `(parentPara=0, control=0)` 좌표를 TextRun에 방출 → *"화면 조판에는 임시
  문단이 유효하므로 표는 보이지만, 선택 API는 그 경로를 실제 Document에 적용하므로 실패한다."*
  래칫 요구(원문): *"길이 2 이상인 모든 `TextRun.cell_context.path`가 원본 IR에서 마지막 `Table`까지
  resolve되는지 검증한다."* → PR [#4267](https://github.com/edwardkim/rhwp/pull/4267)로 착지
  (enclosing CellContext 끝까지 전달 + 표만 품은 부모 셀 문단의 caret anchor 복원).
- **[#4272 중첩 안쪽 셀 드래그 선택 하이라이트 미표시](https://github.com/edwardkim/rhwp/issues/4272)** (08-08):
  논리 선택은 전체 cellPath로 정상 생성돼도 rect 조회 API가 평면만 받아 바깥 셀로 오라우팅.
  *"현재 WASM bridge에는 `getSelectionRectsInCellByPath`에 해당하는 API가 없다."* 깊이 3 실측 경로 첨부.
  → PR [#4276](https://github.com/edwardkim/rhwp/pull/4276): *"선택·복사 시 경로 깊이에 비례하는 주소
  해석만 수행하며 렌더링·페이지네이션 hot path의 문서 전체 순회는 추가하지 않습니다."*
  오너 종결: 깊이 3 셀에서 선택·복사·붙여넣기 실측, warning 0.
- **[#2755](https://github.com/edwardkim/rhwp/issues/2755)** by_path 병설 함정: 분기 조건을 `isCell`로
  넓게 잡아 **깊이 1까지 전부 by_path로 새어** 들어갔는데, by_path 계열엔 셀 폭 리플로우가 없어
  *"깊이 1 표(=대부분의 실제 문서)에서 편집 후 줄 나눔이 갱신되지 않는다."* 커밋 메시지의 전제
  ("리플로우는 rebuild_section 담당")가 코드상 거짓이었다.
- **[#2717 코멘트](https://github.com/edwardkim/rhwp/issues/2717#issuecomment-5034875636)** (오너):
  `handleBackspace`가 안쪽 셀 축(`cellParaIndexOf`)을 쓰도록 정정 — Backspace 병합 오동작 해소.
- **[#2212](https://github.com/edwardkim/rhwp/issues/2212)** (오너): 조판 결함과 편집 주소 결함을 명시적으로
  분리 — *"선택 UI가 동작하지 않을 뿐 문서 파손은 없음."*

### hit-test 해소 규칙 — 착지 정책은 min-area best-match

- **[#857 중첩 표 본문 셀 진입 불가](https://github.com/edwardkim/rhwp/issues/857)** (05-12): depth-first
  순회에서 외곽 셀의 빈 placeholder TextRun(문단 전체 bbox)이 안쪽 실텍스트보다 먼저 매칭 → 선점.
  제안은 max-depth였으나 착지 커밋
  [a77d121e](https://github.com/edwardkim/rhwp/commit/a77d121e5a678a54262905ef8b3fe5c5cc595bee)는
  **min-area best-match** (기존 cell_bboxes 선택과 정책 통일이 근거).

### 조판·렌더 축 (081 비범위지만 후속 이슈의 지뢰 지도)

- **[#4042](https://github.com/edwardkim/rhwp/issues/4042)** (오너): `!has_nested_table` 조건이 저장 vpos
  앵커 경로를 배제 → 기계식 가운데 정렬 폴백 → 15쪽 문서가 24쪽 상방 회귀. `pages >= 12` 하한 검사
  테스트가 회귀를 침묵(우리 `8==8` 등가 게이트가 유리한 지점).
- **[#4069](https://github.com/edwardkim/rhwp/issues/4069)**→[#4122](https://github.com/edwardkim/rhwp/pull/4122)
  (오너): 중첩 표 큰 행의 쪽 분할 — 첫 등장 split과 continuation이 다른 모델을 쓰면 **중복 렌더**.
  통일 해법: canonical cell unit + 재귀 cursor, 같은 콘텐츠-오프셋 모델.
- **[#4326](https://github.com/edwardkim/rhwp/issues/4326)**: 1×1 투명 래퍼를 벗기고 중첩 행으로 나눈
  조각의 행 좌표가 **어느 표 것인지 데이터에 없어** 렌더러가 값으로 되추론 → margin 40개 값 중 24개
  오해석. 트리거 형상(투명 1×1 래퍼+중첩 표) 보유 문서 **681개 중 65개** — 흔한 형상이다(sample-8p 동일).
  교훈: *"해석된 행 기하의 정체를 컷과 같은 자리에서 데이터로 실어야 한다."*
- **[#4159](https://github.com/edwardkim/rhwp/issues/4159)**: 중첩 fragment가 조상과 같은 높이를 쓰면
  정확히 pad_top만큼 clip 밖으로 (실측 1.89px).
- **[#4278](https://github.com/edwardkim/rhwp/issues/4278)**/**[#4279](https://github.com/edwardkim/rhwp/issues/4279)**(open, 오너 답변 0):
  중첩 깊이가 IR 1급 사실이 아니라 순회 6벌마다 재구현 → 서로 어긋남. 제안: 재귀 진입점 하나
  (출력은 렌더 트리가 아니라 LineSeg+placement) — **채택 여부 미확정, 그들이 통합 재귀로 간다고 가정 금지**.
- **[#4275](https://github.com/edwardkim/rhwp/issues/4275)** (open): 중첩 표 타문서 붙여넣기가 HTML 경유로
  전환되며 셀존 스타일 소실(`table_to_html()`이 유효 BorderFill 대신 개별 id만 내보냄) — 우리 HTML
  export에도 같은 지뢰.
- 성능: [#4128](https://github.com/edwardkim/rhwp/issues/4128)·[#4126](https://github.com/edwardkim/rhwp/issues/4126)
  — 병목은 경로 깊이가 아니라 캐시 부재/전량 재조판. **CellPath 관통 자체는 성능 저위험**(#4276 실측).
- 파싱(읽기) 축에서 중첩을 못 읽는다는 이슈는 **없다** — rhwp 파싱 전용 사용(불변식 3)에 위험 없음.

### 오너의 배경 사상

[Discussion #367 표의 문화사](https://github.com/edwardkim/rhwp/discussions/367): *"표 하나로 부족하면 표
안에 표를 중첩시킨다. 한 페이지에 정보를 최대한 압축해 넣는 것이 미덕이다."* — 오너에게 중첩 표는
엣지가 아니라 **한국 공문서의 정의적 형상**. 우리가 "중첩 셀은 편집 대상 아님"으로 두면 이 시장에서
구조적으로 진다.

## 2. 081 설계 채택 사항 (요약 — 전문은 이슈 파일)

- **R1** 조판이 경로의 출처 — 합성 좌표 방출 금지 + "depth≥2 전 경로 IR-resolve" 래칫 게이트(#4252).
- **R2** 주소는 경로 하나만 — 깊이≥2에 평면 (row,col) 채우지 않기(#2792). 채우는 순간 5계층 사슬 시작.
- **R3** 캐럿 레인은 한 배치로 관통(hit·rect·줄정보·세로이동) — 조각내면 3개월+미완(#2792 타임라인).
  줄정보/세로이동은 rhwp도 아직 못 닫음 → 우리가 앞설 실질 지점.
- **A1** "가드로 not-found"는 수리가 아니라 증상 이동(#2651 판결). 해소 규칙은 min-area(#857 착지) 채택.
- **A2** by_path 병설 시 깊이 1은 기존 레인에 명시 위임 — 분기 조건은 `path.len()>1`로만(#2755).
- **A3** 측정/배치 이중 재귀는 반드시 어긋난다(#4278) — 우리 LOCKSTEP(place_doc↔NaiveLayout)이 같은
  병. 081은 읽기 전용이라 무접촉이지만, 중첩 분할(후속)에 착수하기 전 두 경로 파생 관계를 판단할 것.

## 3. 못 찾은 것 (정직 보고)

- 오너의 "CellPath 설계" 단일 문서(RFC)는 **0건** — 경로 주소체계는 버그를 고치다 사후적으로 굳어진
  것이고, 전수 지도(#2792)는 기여자(@kevin9327) 작성. 오너 발언은 전부 "증상+원인+수정 방향" 형식.
- 디스커션 기술 논의 0건(에세이 3편뿐). 타 오픈소스(pyhwp 등)의 중첩 표 접근 비교 스레드 0건.
- 브랜치 로컬 설계 노트(`mydocs/working/…`) 접근 불가. #4279 채택 여부 미확정.
