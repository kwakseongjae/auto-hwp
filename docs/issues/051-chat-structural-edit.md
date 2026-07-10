# 051 — R12-P0: 챗 구조 편집 브릿지 (EditScript 어휘 → 웹 Intent 화이트리스트)

- 상태: open · 우선순위: R12-P0 · 영역: packages/ai-protocol + apps/hwp-lab/api + (필요 시) crates/hwp-mcp Intent additive
- 병렬: 052(자동저장 — persistence/복구 경로 소유). 이 이슈는 챗 어휘/프리뷰/프롬프트만 만지고
  WasmAdapter recover()/저장 경로를 만지지 마라.

## 근거 (2026-07-10 감사)
웹 챗은 `packages/ai-protocol/src/prompt.ts`의 `DEFAULT_ALLOWED_INTENTS` 5종(SetTableCell/
SetTableCellRuns/SetParagraphText/SetCellRangeShade/SetCellRangeFmt)만 허용 — **채움/서식만 되고
구조 편집(표·이미지·문단 삽입, 블록 삭제)은 챗으로 불가**. 반면 Rust 측 `crates/hwp-ai/src/edit.rs`
EditScript는 insert_paragraph/heading/table/image·append_rows·delete를 이미 가진다(스키마가 `op` vs
`intent`로 달라 웹에 안 이어짐). op-bus에는 InsertImageAt/TableInsertRows/TableAppendEmptyRow/
DeleteBlock/MoveBlock이 기존재. 바이브 편집의 체감 가치를 가장 크게 올리는 단일 작업.

## 목표
채팅으로 "여기에 3×4 표 넣어줘 / 이 문단 삭제 / 회사 약력 표 만들어서 채워줘"가
**프리뷰→적용→⌘Z 1단위** 게이트를 그대로 지키며 동작한다. 데스크톱 신 셸(044)도 자동 획득.

## 설계 (조사 → 구현)
1. **조사(실측 먼저)**: Intent 스키마 v0(36 variant)에 이미 노출된 구조 variant 전수 —
   `crates/hwp-mcp` apply_intent 디스패처와 `packages/ai-protocol` 타입을 대조해
   "이미 있음/Intent 추가 필요/op 자체 부재" 3분류 표를 만든다. 특히 **InsertTableAt op는 부재**
   (`EditController.insertTable`은 문서 끝 ApplyContent 폴백) — 끝-append의 정직한 한계를 유지할지
   op 신설할지 이 표를 근거로 결정하고 보고.
2. **화이트리스트 확장**: `DEFAULT_ALLOWED_INTENTS`에 구조 variant 추가 + 프롬프트에 어휘/제약
   서술(앵커는 `(section,block)` — EditScript의 드리프트 추적 교훈: 삽입/삭제 후 인덱스 시프트를
   LLM에 맡기지 말고 배치 내 재계산은 우리가). unknown field 거부/`intent_version` 불변(V2).
3. **프리뷰 카드**: 구조 변경용 카드 신설 — 삽입은 위치+내용 요약, **삭제는 대상 블록 원문 표시**(V1).
   적용은 기존 `applyBatch`(1 undo 단위) 경로 그대로.
4. **테스트**: ai-protocol vitest(신규 variant 검증/거부), mock provider로 e2e 1개(챗 "표 삽입"→
   프리뷰→적용→SVG 반영→undo), schema_v0 Rust 테스트에 variant 추가 시 additive 증빙.

## 수용 기준
- [ ] 조사 표(있음/추가필요/op부재) 보고 — 구현 전 아키텍트 확인 지점
- [ ] 챗으로 표 삽입·행 추가·이미지 삽입·블록 삭제 동작(프리뷰→적용→⌘Z 1단위)
- [ ] 화이트리스트 밖 intent는 여전히 거부(보안 술어 테스트), 프롬프트 인젝션 가드 유지(V1)
- [ ] Intent 추가가 있으면 additive 증빙(기존 스키마 테스트 무변경 통과) + 게이트/wasm-safe
- [ ] 052 소유 영역 무접촉, 기존 스위트 그린

## 함정
- v1 R5(프롬프트 인젝션): 문서 텍스트는 델리미팅된 데이터 블록으로만 — 챗 컨텍스트 조립부 무변경.
- 삭제류를 화이트리스트에 넣을 때 "사용자 콘텐츠 삭제 금지" 계약과 충돌하지 않게: 삭제는
  반드시 프리뷰 카드에서 명시 승인 후에만 적용(자동 적용 경로 금지).
- 데스크톱 구 셸의 ai_edit_propose/commit_proposal 게이트는 별개 레인 — 건드리지 마라(044 §함정).
