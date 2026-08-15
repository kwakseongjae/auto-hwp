# 081 — 중첩 셀 캐럿·편집: CellPath를 캐럿 레인에 관통

- 상태: **공개 이슈 #48로 승격** (2026-08-15). 기획은 여기, 이슈/PR/수용은 GitHub #48.
- 우선순위: P1 — 중첩 표는 한국 공문서의 정의적 형상(rhwp 오너: "표 하나로 부족하면 표 안에 표를
  중첩시킨다"). sample-8p.hwp의 파란 안내 문구가 실사용 재현체이고, rhwp 코퍼스 실측으로도
  투명 1×1 래퍼+중첩 표 형상이 문서 681개 중 65개(~10%)에 있다.
- 영역: `hwp-typeset`(place.rs) + `hwp-session` + `hwp-mcp`(Intent) + `editor-core` + 어댑터(wasm/tauri)
- 레퍼런스: `docs/research/rhwp-nested-tables-2026-08.md` (rhwp가 같은 문제를 통과하며 남긴 정답지/오답지),
  `docs/research/claw-hwp-2026-08.md` (결론: 캐럿 해법 없음 — 그들은 캐럿 자체가 없는 모델)
- 실행 가능한 기술서: `apps/hwp-lab/e2e/nested-cell-caret-gap.spec.ts` (test.fixme — 이 이슈의 종료 조건)

## 문제 (실측, 2026-08-10 편집 품질 배치)

sample-8p.hwp 일반현황 표(s0/b10, 9×8)의 셀 (r1,c3) 안 **1×1 중첩 표**의 셀 문단
"※ 협약기간 내 제작·개발 완료할 최종 생산품의 형태, 수량 등 기재"는 현재 지울 방법이 하나도 없다:

1. 글자 캐럿 — `crates/hwp-typeset/src/place.rs:1682` `cell_text_hit()`의
   `if !t.ancestors.is_empty() { return None; }` 가드가 중첩 표 위 캐럿을 원천 차단
   (플랫 `(section,block,row,col)` 주소로는 중첩 leaf에 닿을 수 없어서 넣었던 064 Tier-2 가드).
2. 대체 경로(더블클릭 제자리 에디터)도 실측에서 열리지 않음 — place.rs 주석의 약속과 불일치.
3. 부수 관찰(미확인 위험): 그 위치에서 Backspace 시 화면 변화 없이 undo 단위가 생김 —
   캐럿이 **다른 대상**에 앉아 의도치 않은 편집을 커밋했을 가능성. 본 수리에서 원인 확정 필수.

자산 인벤토리 — **주소 체계는 이미 있다. 막힌 건 캐럿 읽기 레인 하나다**:

| 레인 | 상태 |
|---|---|
| 조판 provenance | ✅ `PlacedTable/PlacedCell`이 하강 `CellPath`(`ancestors`+`self_block`) 기록 (064 Tier-2) |
| 클릭→leaf 경로 | ✅ `CellHitDto{nested, path}` (hwp-session) |
| 텍스트 커밋 | ✅ `Op::SetTableCellPath` + `resolve_cell`/`resolve_cell_mut` (hwp-ops), `SetTableCellRuns.path` |
| **캐럿 읽기** | ❌ `cell_text_hit` 중첩 차단 · `cell_caret_rect` 평면 전용 · `Intent::CaretRectCell` path 없음 |
| 구조 op(행/열/병합) | ❌ 최상위 전용 (본 이슈 비범위 — 후속) |

## rhwp에서 채택하는 교훈 (전문·URL은 research 문서)

- **R1. 조판이 경로의 출처다** — 분할/중첩 조판이 합성 좌표를 방출하면 캐럿 레인이 조용히 죽는다
  (rhwp #4252: "화면 조판에는 유효하므로 표는 보이지만 선택 API는 실패"). 그들의 래칫을 게이트로 차용:
  **"depth≥2인 모든 placed CellPath가 원본 IR에서 leaf Table까지 resolve되는지" 단정**.
- **R2. 주소는 경로 하나만** — 깊이≥2 히트에 평면 (row,col)을 채우지 않는다(rhwp #2792: "거짓 평면
  좌표를 만들지 않는다"). 채우는 순간 그 값을 읽는 소비자가 생기고, 그게 그들의 5계층 버그 사슬이다.
  깊이 1의 기존 JSON/DTO는 바이트 동일 유지(additive 확장, 불변식 7).
- **R3. 한 배치로 관통** — hit·caret rect·줄정보(Home/End)·세로 이동까지 같은 배치에서 path 서명으로.
  rhwp는 축을 조각내서 3개월째 미완(#2792 open — 커서 이동 계열이 아직 깊이 1 전제). 이게 우리가
  앞설 실질 지점이다.
- **A1. 가드는 수리가 아니다** — "not-found로 안전하게"는 증상 이동일 뿐(rhwp #2651 판결). 해소 규칙은
  **min-area best-match** 채택(그들 착지 커밋 a77d121e; 우리 PlacedCell엔 placeholder run이 없어
  max-depth와 사실상 동치지만, 겹침 일반 케이스에서 정의가 명확하고 그들 검증을 업어 탈 수 있다).
- **A2. 깊이 1은 기존 레인에 명시 위임** — by_path 병설 시 분기 조건은 `path.len() > 1`로만.
  rhwp #2755: 분기를 넓게 잡아 깊이 1까지 새 경로로 새며 리플로우를 잃었다. "X는 Y가 담당한다"는
  전제는 코드를 읽어 확인한다.
- **A3. (사전 점검)** 측정/배치 이중 재귀는 반드시 어긋난다(#4278). 본 이슈는 읽기 전용이라
  `NaiveLayout` 무접촉·LOCKSTEP 무영향이지만, 후속(중첩 표 페이지 분할)에 착수하기 전 place_doc↔
  NaiveLayout 중 한쪽을 다른 쪽에서 파생시킬 수 있는지 판단을 선행할 것.

## 설계 (확정)

1. **engine — hit**: `cell_text_hit()` 가드 제거. 후보 수집을 중첩 포함으로 확장하고 겹침은
   min-area best-match로 해소. `CellTextHitDto`에 `path: Vec<CellStep>` 추가 —
   깊이 1은 기존 평면 필드 그대로(하위호환), **깊이≥2는 평면 (row,col)을 채우지 않는다**(R2).
2. **engine — caret rect**: `cell_caret_rect`의 path 서명 추가(내부 단일 구현). 깊이 1 호출은 기존
   경로에 위임(A2). 같은 배치에서 캐럿 세로 이동·Home/End·X좌표→오프셋이 쓰는 줄정보 조회도
   path를 관통시킨다(R3 — rhwp가 못 닫은 축).
3. **Intent**: `CaretRectCell`에 optional `path`(additive·`deny_unknown` 유지 — 불변식 7).
   커밋 축은 기존 `SetTableCellRuns.path` 재사용(신규 Op 없음).
4. **core**: `CellCaretAnchor.path` + 읽기 `blockRunsPath`. 편집 UI(Backspace/⌘A/타이핑)는 anchor의
   path 유무와 무관하게 같은 코드 경로.
5. **adapter**: WasmAdapter/TauriAdapter + worker RPC 화이트리스트에 path 변형 노출. wasm 재빌드
   (스테일 wasm은 신규 Intent를 unknown variant로 거부 — AGENTS 함정).
6. **관찰 위험 해소**: 현재 중첩 위 클릭이 만드는 "은닉 undo 단위"의 착지 대상을 확정하고, 수리 후
   같은 클릭이 중첩 leaf에 정확히 앉는지 회귀로 잠근다.

성능 규율: 경로 해석은 클릭/커밋 시 깊이 비례만 — 드래그/호버/줌 hot path에 문서 순회 추가 금지
(rhwp #4276 실측상 저위험 + 우리 "제스처 중 리렌더 0회" 게이트 유지).

## 수용 기준

- [ ] **래칫 게이트(R1)**: 게이트 코퍼스 전 문서에서 depth≥2 placed CellPath 전수가 IR resolve 성공
      (단정 테스트 — verify quick 레인에 추가).
- [ ] `nested-cell-caret-gap.spec.ts` fixme 해제 → green (캐럿→⌘A→Backspace→⌘Z 왕복, 실브라우저).
- [ ] 깊이 1 무회귀: cell-caret-053 등 기존 e2e 전건 + "깊이 1은 기존 레인을 탄다" 명시 테스트(A2).
- [ ] 게이트 8/18/24/6 · HWPX축 · LOCKSTEP · byte-verbatim 왕복 전부 불변 (조판 출력 무변경 — 읽기 전용 작업).
- [ ] 은닉 undo 단위 관찰의 원인 확정 + 재발 차단 테스트.
- [ ] 세로 이동/Home/End가 중첩 leaf 안에서 leaf 축 줄정보를 읽는다(바깥 축 오독 금지 — rhwp #2792 레벨 4c 재현 방지).

## 함정 (착수 전 필독)

- 분할 조각/합성 문단에서 placed 경로가 원본 IR 주소인지 반드시 확인 — 합성 좌표 방출이 rhwp 최다 재발
  패턴(#4252). 우리 `place_nested_table`→fragment 경로가 1차 의심 지점.
- 깊이≥2에 평면 좌표를 채우면 그 순간부터 5계층 사슬(#2792)이 시작된다. 컴파일러가 막게 하라
  (평면 필드를 Option으로 좁히는 것도 후보).
- wasm 재빌드+`.next` 삭제 없이는 브라우저 검증이 스테일로 침묵한다(2026-08-10 배치에서도 실측).
- 1×1 래퍼는 `edit_target`이 unwrap하는 특례가 이미 있다(hwp-ops `resolve_cell` level 0) — 캐럿 축
  해소 규칙과 unwrap 규칙이 서로 다른 leaf를 고르지 않는지 대조 테스트.

## 비범위 (후속 이슈 후보 — 지뢰 지도는 research 문서)

- 중첩 표 페이지 분할(현재 절대 비분할 → 과대 시 클립): rhwp #4069/#4122 "첫 등장·이어짐 동일
  콘텐츠-오프셋 모델" + #4326 "컷 좌표계 정체를 데이터로" + #4159 pad_top 클립을 선행 학습으로.
  착수 전 A3 판단 필수.
- 구조 op(행/열 삽입·병합·음영)의 CellPath 확장 — claw-hwp `.hwpx` deep 인덱스 패턴 참고.
- 제자리 에디터(hw-inline-open)가 중첩에서 안 열리는 editor 결함 — 캐럿이 뚫리면 재평가(중복일 수 있음).
- `.hwp`(HWP5) 재저장 등 claw-hwp 파생 백로그 — `docs/research/claw-hwp-2026-08.md` §파생 백로그.
