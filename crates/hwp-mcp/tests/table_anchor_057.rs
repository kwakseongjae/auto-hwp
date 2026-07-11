//! issue 057 — 표 앵커링 end-to-end 재현 (Intent 레인): hwpx 오리진 열기 →
//! `SetTableCell`(공유 apply_intent 경로, 내부적으로 `SetTableCellRuns`형 셀 재구성) →
//! `export_bytes` → 재파싱. 편집된 표는 **원 블록 인덱스에** 남아야 하고(제자리 재방출),
//! 문서 끝에 복제 표가 append되거나 원 위치에 편집 전 표가 잔존해서는 안 된다.
//!
//! goldenRecovery.test.ts(052) 매트릭스의 "hwpx 오리진 + 표 셀 텍스트" 케이스의 Rust 단 정본.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

const MARKER: &str = "057앵커고정";

fn fixture() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
}

fn table_indices(doc: &SemanticDoc) -> Vec<usize> {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| matches!(b, Block::Table(_)).then_some(i))
        .collect()
}

#[test]
fn hwpx_origin_cell_edit_exports_table_at_original_anchor() {
    let src = fixture();

    // 편집 대상 표의 블록 인덱스/블록 수(오리진 기준) — open_bytes와 동일한 파서 경로.
    let before = parse_semantic(&src).unwrap();
    let tables_before = table_indices(&before);
    let ti = *tables_before
        .first()
        .expect("fixture has a top-level table");
    let n_blocks = before.sections[0].blocks.len();

    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").expect("open hwpx origin");

    // 표 셀 편집 (Intent 레인 — wasm/Tauri 셸이 쓰는 그 경로).
    let out = apply_intent(
        &mut session,
        Intent::SetTableCell {
            section: 0,
            index: ti,
            row: 0,
            col: 0,
            text: MARKER.into(),
        },
    )
    .expect("SetTableCell applies");
    assert!(!matches!(out, Outcome::Discarded(_)), "edit applied");

    // 재방출 → 재파싱.
    let bytes = export_bytes(&session).expect("export_bytes");
    let after = parse_semantic(&bytes).unwrap();

    // ① 표/블록 개수 불변: 문서 끝 append 복제 없음. (수정 전: 표 +1 → 레드)
    assert_eq!(
        table_indices(&after).len(),
        tables_before.len(),
        "no duplicate table at the end"
    );
    assert_eq!(
        after.sections[0].blocks.len(),
        n_blocks,
        "block count unchanged"
    );

    // ② 편집된 표가 원 블록 인덱스에 그대로. (수정 전: 원 위치 표는 편집 전 원문 → 레드)
    let Block::Table(t) = &after.sections[0].blocks[ti] else {
        panic!("block {ti} is no longer a table after export round-trip")
    };
    let cell_text: String = t
        .cells
        .iter()
        .find(|c| c.active && c.row == 0 && c.col == 0)
        .map(|c| {
            let mut s = SemanticDoc::default();
            s.sections.push(Section {
                blocks: c.blocks.clone(),
                ..Default::default()
            });
            s.plain_text()
        })
        .unwrap_or_default();
    assert!(
        cell_text.contains(MARKER),
        "edited cell text sits at the ORIGINAL anchor: {cell_text:?}"
    );

    // ③ 마커는 문서 전체에서 정확히 한 번.
    assert_eq!(
        after.plain_text().matches(MARKER).count(),
        1,
        "edited text appears exactly once"
    );

    // ④ 재수출 결정성 + 오픈 세이프티.
    assert_eq!(
        export_bytes(&session).unwrap(),
        bytes,
        "export is byte-deterministic"
    );
    assert!(
        hwp_core::validate_hwpx(&bytes).ok,
        "exported package is open-safe"
    );
}
