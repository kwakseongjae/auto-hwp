# 064 — 중첩표(셀 안의 표) 선택·편집 (descending CellPath)

- 상태: **Tier-1 done + Tier-2 done** (중첩 셀을 CellPath로 실제 선택·편집) · 영역: crates/hwp-typeset(provenance) + crates/hwp-session(table_cell_at path·block_runs_path) + crates/hwp-ops(SetTableCellPath) + crates/hwp-mcp(Intent path) + packages(drill 스택·인라인 에디터).
- 근거: 009 §함정 "중첩표 내부 셀". Tier-1은 정직한 토스트(편집 차단)였고, Tier-2에서 **CellPath 주소 체계**로 진짜 편집 타깃으로 승격.

## Tier-1 (완료 — DATA-LOSS 차단 + 정직 UX)
1. **손실 근절 (crates/hwp-ops `Op::SetTableCell`)**: 셀의 PARAGRAPH 슬롯만 재조립하고 `Block::Table`(중첩표)·기타 비문단 블록은 **자리·순서 그대로 보존**하는 비파괴 splice로 교체(이전엔 `cell.blocks = <재조립 문단>` 전량 대체 → 중첩표 영구 삭제). 문단만 있는 셀(게이트 벤치마크 셀 포함)은 이전과 블록 목록 바이트동일 → 조판/게이트 무영향. 단위테스트 `set_table_cell_preserves_nested_table`([Paragraph,Table,Paragraph] → 중첩표 생존·문단 갱신).
2. **엔진 nested 세팅 (crates/hwp-session)**: `CellHitDto.nested: bool` 신설 + `model_cell_has_nested_table`(edit_target 언랩 후 셀 blocks에 `Block::Table` 존재 여부)로 `table_cell_at_placed`가 세팅. wasm은 DTO를 JSON 직렬화 → JS `JSON.parse`로 그대로 전달(추가 배선 불필요).
3. **정직한 토스트 (packages)**: `CellHit.nested?`(editor-core/types.ts, engine/index.d.ts) 복원 + `HwpWorkspace.openEditorAt`/`handleDoubleClick`가 nested 셀이면 인라인 에디터를 열지 않고 "중첩표는 아직 편집할 수 없습니다" 토스트. 이로써 오버레이 가림(시각 소실)과 SetTableCell 발화(파괴)를 UI에서도 차단. react 테스트 `workspace.nestedCell` 추가.

## Tier-2 (완료 — 중첩 셀 선택·편집 via descending CellPath)
- **주소 체계 CellPath**: `CellAddr={block,row,col}` 리스트(레벨0=최상위 표 셀, 이후 각 셀 안의 `Block::Table` 인덱스). 길이-1 = 기존 flat `(section,block,row,col)`이라 비중첩은 100% 무변경(불변식 #7 additive).
- **렌더 provenance (place.rs)**: `place_nested_table`가 이제 중첩표의 `PlacedTable`(+PlacedCell)을 `ancestors`+`self_block`과 함께 push. outer 다음에 그려지므로 `table_at`/`table_cell_at`의 `rfind`(topmost)가 중첩 히트를 자연히 채택. **지오메트리·게이트 무변경**(provenance는 메타데이터; benchmark 8==8·benchmark1 18==18 before==after 실측). ⚠️ `flush_fragment`의 셀 부착을 `last_mut()`→**고정 인덱스**로 교체(중첩 push가 last를 밀어냄), point-to-scope 밴드 find에 `ancestors.is_empty()` 가드 추가.
- **주소 스레딩**: `CellHitDto.path`(engine JSON로 그대로 전달) → `Anchor.path`(selKey에 접기 → 중첩 레벨별 distinct 선택) → `Intent::SetTableCellRuns.path?`(additive Option) → `Op::SetTableCellPath{section,path,runs}`(신규 additive variant, 기존 `SetTableCell`과 rebuild 로직 공유). `block_runs_path`/`block_style_path`로 리프 셀 prefill.
- **drill 스택 (selection.ts)**: `drill`을 `{section, path:CellAddr[]}`로 승격. `sameTable`로 같은 (조상+표블록) 셀만 drill 유지 → 비중첩은 기존 (section,block) 매치와 동일. `drillInto`가 최내측 리프로 하강, dbl→dbl로 편집.
- **React**: nested 셀도 EDITABLE — Tier-1 "중첩표는 편집할 수 없습니다" 토스트 **제거**, openEditorAt/openCellEditor가 path로 리프 runs prefill + commit에 path 실음.

## 미지원(잔여) — 안전하게 비활성
- **클릭-후-타이핑 셀 캐럿 레인(053/059)은 중첩 셀에서 비활성**: 그 레인은 flat `(section,block,row,col)`로만 주소되어 nested 리프에 못 닿음 → `cell_text_hit`가 nested(`ancestors` 비어있지 않음)면 `None` 반환(캐럿 미배치). 중첩 셀은 **더블클릭 인라인 에디터**로 편집(안전, 오작동 없음). 데스크톱(Tauri) 셀 편집도 flat 유지(웹이 북극성).

## 왜 revert했나 (근본 원인)
- TS 타입엔 `CellHit.nested?`(`editor-core/types.ts:67`)가 있고 selection이 `nestedCell`로 변환하지만
  (`selection.ts:341`), **Rust 엔진(`crates/hwp-session` table_cell_at)이 이 플래그를 실제로 세팅하지 않는다.**
  오히려 `hwp-session:1172` 주석은 "nested 셀도 top-level처럼 편집 가능"이라 전제 자체가 어긋남.
- 결과: mock 테스트(`cell.nested=true`)로는 토스트가 뜨지만 **프로덕션에선 절대 안 뜸**(엔진이 nested를 안 줌).
  테스트만 통과하고 실효 0인 speculative 기능 → 정직하게 revert.

## 제대로 하려면 (엔진 선행)
1. **엔진 지원**: `crates/hwp-session`의 `table_cell_at`/`table_cell_at_placed`가 클릭 지점이 중첩표(place_nested_table)
   내부 셀로 해소될 때 `CellHit`에 `nested: true`를 세팅. place.rs의 PlacedTable가 중첩 여부를 이미 알고 있는지 확인
   (place_nested_table 경로). own-render px 공간에서 outer vs inner 판정.
2. **판정 확정**: 중첩표 내부 셀이 정말 편집 불가인가, 아니면 편집 가능한가(hwp-session:1172 주석과 대조).
   편집 가능하면 이 이슈 자체가 무의미 — **먼저 이걸 실측 확정**.
3. 배선: 엔진이 nested를 주면 selection→nestedCell→toast 체인(revert된 코드 참고)을 되살림.

## 함정
- **엔진이 nested를 안 주면 어떤 UI 배선도 무의미** — 반드시 엔진 선행. 프로덕션 미발화 speculative 재발 금지.
- 게이트/렌더 무영향(마킹 UX만) — 단 hwp-session 접촉 시 게이트 재확인.
