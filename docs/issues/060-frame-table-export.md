# 060 — 1×1 프레임 래퍼 내부표 편집이 HWPX 저장에 반영 안 됨

- 상태: **done** (1778690) · 우선순위: R13-P1(정확성 버그 — 자가진단표류 문서 편집 소실) · 영역: crates/hwp-hwpx(serialize emit 게이트) + hwp-hwpx/parse(내부표 src_span) + hwp-model(Block::any_dirty 재귀 술어)
- 근거: 057이 발견, 2026-07-11 코드 정독으로 근본 원인 확정.
- 결과 요약: 2단계 수정 — ① emit 게이트를 프레임 투명 재귀 술어 `Block::any_dirty`(document.rs:144)로 교체
  ② 내부 표에 src_span 부여(parse.rs) + table_inplace_edits가 edit_target로 해소 → 내부 dirty 셀만
  splice, 외부 래퍼·미편집 형제 byte-verbatim. 재현(frame_table_060 3개) 레드→그린, **057 골든 5개 무회귀**,
  게이트 8==8·18==18. **R13 마지막 이슈 마감.**

## 근본 원인 (file:line)
표 편집 op이 `edit_target_mut()`(`hwp-model/src/document.rs:382`)로 **내부 표**만 얻어 `cell.dirty`/내부 `t.dirty`/`sec.dirty`만 마킹(`hwp-ops/src/lib.rs:1255,1308-1310`) → **외부 1×1 래퍼 표와 그 셀의 dirty는 영원히 false**. 익스포터 emit 게이트 4곳(`hwp-hwpx/src/serialize.rs:389,612,938,1422`)이 외부 블록에서 **비재귀** `t.dirty || t.cells.any(c.dirty)`만 검사 → 프레임 래퍼가 전 게이트 스킵. `any_dirty()`(document.rs:48)는 `Cell::any_dirty`(:482) 재귀라 true → export는 돌지만 아무것도 안 내보내 **원본 그대로 저장 = 편집 소실**.

## 설계 (2단계 — 057 per-cell 수술과 정합)
1. **게이트 재귀화(최소 정정, 난이도 하)**: emit 게이트 4곳의 술어를 프레임 투명(재귀)으로 — 기존 재귀 술어 `Block::any_dirty`(`document.rs:138`) 노출/재사용. ⚠️ 이것만 하면 whole-table 재합성으로 편집은 반영되나 미모델 내부 개체 소실 위험.
2. **src_span 해소(057 정합, 난이도 중 — 권장)**: `parse.rs:282`의 `if tbls.is_empty()` 가드를 풀어 내부 표에도 `src_span` 부여 + `table_inplace_edits`(`serialize.rs:938`)가 `edit_target()`로 내부 표 해소 → 내부 dirty 셀만 각 `<hp:tc>` src_span에서 splice, 외부 래퍼·미편집 형제 셀 전부 byte-verbatim.

## 수용 기준
- [ ] 프레임 래퍼(자가진단표) 내부 셀 편집 → HWPX 저장 → 재열기에 반영(현재 소실) — Rust 재현 테스트 레드→그린
- [ ] 게이트는 실제 dirty일 때만 열림 → 무편집·일반표(edit_target==self) 불변, 기존 verbatim 골든(`tests/table_anchor_057.rs`) 전부 그린
- [ ] 게이트 8==8·18==18, wasm-safe

## 함정
- verbatim passthrough(레포의 해자)를 깨면 안 됨 — 057 골든 무회귀가 안전성의 근거.
- 2단계(src_span)까지 가야 미모델 내부 개체(pic/수식) 소실 없이 반영 — 1단계만으로 완료 선언 금지.
- 중첩 깊이 2단(프레임>표>셀) 이상은 재귀 술어가 자연 커버하나 테스트로 확인.
