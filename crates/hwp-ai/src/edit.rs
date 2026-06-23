//! Anchored, conversational document editing — the **"vibe docs"** core.
//!
//! Unlike [`crate::content`] (generate-a-whole-document-from-scratch), this module is for
//! *editing an existing document by chat*: "여기에 이미지 넣어줘", "목차 아래에 표 만들어줘",
//! "표의 좌측열을 헤더 색상으로". The model sees the live document as an **anchored outline**
//! ([`crate::to_markdown`]'s `[s{sec}/b{blk}]` anchors) and emits an [`EditScript`] of anchored
//! commands, which compile to the typed [`hwp_ops::Op`] anchored ops (no raw XML — same contract
//! as the rest of the AI layer). The ops are dry-run on a scratch clone before the human commits.

use crate::content::{AiCell, AiPara, AiRun};
use hwp_model::error::{Error, Result};
use hwp_ops::{CellSel, Op};
use serde::{Deserialize, Serialize};

/// A batch of anchored edits the AI proposes for one chat turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditScript {
    pub edits: Vec<EditCommand>,
}

/// Where an insert lands relative to its anchor block. Defaults to `After` (the dominant case:
/// "목차 *아래에*" = after the 목차 block). `Start`/`End` ignore the `block` field.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Position {
    #[default]
    After,
    Before,
    /// Beginning of the section (index 0).
    Start,
    /// End of the section (append).
    End,
}

/// One anchored edit. Tagged JSON: `{"op":"insert_table","section":0,"block":3, ...}`.
/// `section`/`block` reference the `[s{section}/b{block}]` anchor the model is shown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditCommand {
    /// Insert a paragraph of formatted runs relative to the anchor block.
    InsertParagraph {
        section: usize,
        #[serde(default)]
        block: usize,
        #[serde(default)]
        position: Position,
        runs: Vec<AiRun>,
        #[serde(default, flatten)]
        para: AiPara,
    },
    /// Insert a heading (bold, optionally centered/styled) relative to the anchor block.
    InsertHeading {
        section: usize,
        #[serde(default)]
        block: usize,
        #[serde(default)]
        position: Position,
        text: String,
        #[serde(default, flatten)]
        para: AiPara,
    },
    /// Insert a table (optional bold header row + body rows) relative to the anchor block.
    InsertTable {
        section: usize,
        #[serde(default)]
        block: usize,
        #[serde(default)]
        position: Position,
        #[serde(default)]
        header: Vec<String>,
        rows: Vec<Vec<AiCell>>,
    },
    /// Insert an embedded image from a local file `path` relative to the anchor block.
    /// `width_mm`/`height_mm` size the display box (default 80×60 mm if omitted).
    InsertImage {
        section: usize,
        #[serde(default)]
        block: usize,
        #[serde(default)]
        position: Position,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_mm: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height_mm: Option<f32>,
    },
    /// Delete the anchor block.
    DeleteBlock { section: usize, block: usize },
    /// Shade a whole column of the anchor table (the "좌측열을 헤더 색상으로" case). `shade=None` clears.
    ShadeColumn {
        section: usize,
        block: usize,
        col: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shade: Option<String>,
    },
    /// Shade a whole row of the anchor table. `shade=None` clears.
    ShadeRow {
        section: usize,
        block: usize,
        row: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shade: Option<String>,
    },
    /// Shade a single cell of the anchor table. `shade=None` clears.
    ShadeCell {
        section: usize,
        block: usize,
        row: usize,
        col: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shade: Option<String>,
    },
    /// Replace the text of ONE EXISTING cell of the anchor table (fill a single cell). `runs` is the
    /// new cell content (formatted runs). This is for *filling* an existing table — never insert.
    SetCell {
        section: usize,
        block: usize,
        row: usize,
        col: usize,
        runs: Vec<AiRun>,
    },
    /// Replace the text of SEVERAL EXISTING cells of the anchor table in one batch (the dominant
    /// "표를 채워줘" case). Each entry addresses a cell by `(row, col)` and sets its plain `text`.
    SetCells { section: usize, block: usize, cells: Vec<CellEdit> },
    /// Insert ONE body row into the EXISTING anchor table. `at` omitted = append at the end; each
    /// cell is a bare string or `{text,col_span,row_span,bold,shade}` object (lenient [`AiCell`]).
    InsertRow {
        section: usize,
        block: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<usize>,
        cells: Vec<AiCell>,
    },
    /// Append SEVERAL body rows to the EXISTING anchor table (the "행 N개 추가/채워줘" case).
    AppendRows { section: usize, block: usize, rows: Vec<Vec<AiCell>> },
}

/// One cell address+text for [`EditCommand::SetCells`] (batch existing-cell fill).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellEdit {
    pub row: usize,
    pub col: usize,
    #[serde(default)]
    pub text: String,
}

/// mm → HWPUNIT (1/7200 inch). The same factor the op-bus uses for page margins.
fn mm_to_hwpunit(mm: f32) -> i32 {
    (mm * 7200.0 / 25.4).round() as i32
}

/// Detect an image `kind` ("png"/"jpg"/…) from a file path extension.
fn image_kind(path: &str) -> String {
    path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).filter(|e| {
        matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "bmp" | "tif" | "tiff" | "wmf" | "emf")
    }).unwrap_or_else(|| "png".into())
}

/// Per-section record of an emitted structural change, in **raw** (original-outline) coordinates,
/// so later commands in the same script address the right block after earlier inserts/deletes.
struct Drift {
    section: usize,
    /// Raw insertion/deletion point.
    point: usize,
    /// +1 for an insert, -1 for a delete.
    delta: i64,
}

/// Adjust a raw target index by all prior same-section structural changes (see [`Drift`]).
fn adjust(changes: &[Drift], section: usize, raw: usize) -> usize {
    let mut idx = raw as i64;
    for c in changes.iter().filter(|c| c.section == section) {
        if c.delta > 0 && c.point <= raw {
            idx += 1;
        } else if c.delta < 0 && c.point < raw {
            idx -= 1;
        }
    }
    idx.max(0) as usize
}

/// Per-table record of rows inserted by an earlier command in the same script, so a later row-edit
/// on the SAME table addresses post-insert row coordinates (block index is unaffected by row edits,
/// so this is keyed by `(section, block)` rather than going through [`Drift`]).
struct RowDrift {
    section: usize,
    block: usize,
    /// The row index the earlier insert landed at (in then-current coordinates).
    at: usize,
    /// How many rows that earlier command added.
    count: usize,
}

/// Effective row count of the table at `(section, block)`: its original `rows` plus every row a
/// prior same-table insert in this script added — the correct append point for a later row insert.
fn effective_rows(doc: &hwp_model::document::SemanticDoc, rows: &[RowDrift], section: usize, block: usize) -> usize {
    let base = table_rows(doc, section, block);
    let added: usize = rows.iter().filter(|r| r.section == section && r.block == block).map(|r| r.count).sum();
    base + added
}

/// Adjust an explicit row index by prior same-table inserts (rows at-or-before it shift it down).
fn adjust_row(rows: &[RowDrift], section: usize, block: usize, raw_at: usize) -> usize {
    let mut at = raw_at;
    for r in rows.iter().filter(|r| r.section == section && r.block == block) {
        if r.at <= raw_at {
            at += r.count;
        }
    }
    at
}

/// Resolve an insert's raw insertion point from its anchor + position (against original lengths).
fn raw_insert_point(sec_len: usize, block: usize, position: Position) -> usize {
    match position {
        Position::After => block.saturating_add(1).min(sec_len),
        Position::Before => block.min(sec_len),
        Position::Start => 0,
        Position::End => sec_len,
    }
}

/// Compile an [`EditScript`] into ordered [`Op`]s. Reads image files for `InsertImage`. The ops are
/// addressed so that **sequential** application (the order returned) lands each edit correctly even
/// when several edits touch the same section. Does NOT mutate the document.
pub fn compile_edits(doc: &hwp_model::document::SemanticDoc, script: &EditScript) -> Result<Vec<Op>> {
    let sec_len = |s: usize| doc.sections.get(s).map(|sec| sec.blocks.len()).unwrap_or(0);
    let mut ops = Vec::new();
    let mut changes: Vec<Drift> = Vec::new();
    // Row inserts on existing tables don't move block indices, so they ride a separate tracker that
    // lets sequential appends to the same table land in order (see [`RowDrift`]).
    let mut row_changes: Vec<RowDrift> = Vec::new();

    for cmd in &script.edits {
        match cmd {
            EditCommand::InsertParagraph { section, block, position, runs, para } => {
                let raw = raw_insert_point(sec_len(*section), *block, *position);
                let index = adjust(&changes, *section, raw);
                ops.push(Op::InsertParagraphAt {
                    section: *section,
                    index,
                    runs: runs.iter().map(AiRun::to_run_spec).collect(),
                    para: para.to_para_spec(),
                });
                changes.push(Drift { section: *section, point: raw, delta: 1 });
            }
            EditCommand::InsertHeading { section, block, position, text, para } => {
                let raw = raw_insert_point(sec_len(*section), *block, *position);
                let index = adjust(&changes, *section, raw);
                let run = AiRun { text: text.clone(), bold: true, ..Default::default() };
                ops.push(Op::InsertParagraphAt {
                    section: *section,
                    index,
                    runs: vec![run.to_run_spec()],
                    para: para.to_para_spec(),
                });
                changes.push(Drift { section: *section, point: raw, delta: 1 });
            }
            EditCommand::InsertTable { section, block, position, header, rows } => {
                let raw = raw_insert_point(sec_len(*section), *block, *position);
                let index = adjust(&changes, *section, raw);
                let mut grid: Vec<Vec<hwp_ops::CellSpec>> = Vec::new();
                if !header.is_empty() {
                    grid.push(
                        header.iter().map(|h| AiCell::Text(h.clone()).to_cell_spec(true)).collect(),
                    );
                }
                for row in rows {
                    grid.push(row.iter().map(|c| c.to_cell_spec(false)).collect());
                }
                if grid.is_empty() {
                    return Err(Error::Other("insert_table: 표에 행이 없습니다".into()));
                }
                ops.push(Op::InsertTableAt { section: *section, index, rows: grid });
                changes.push(Drift { section: *section, point: raw, delta: 1 });
            }
            EditCommand::InsertImage { section, block, position, path, width_mm, height_mm } => {
                let bytes = std::fs::read(path)
                    .map_err(|e| Error::Other(format!("insert_image: {path} 읽기 실패: {e}")))?;
                let raw = raw_insert_point(sec_len(*section), *block, *position);
                let index = adjust(&changes, *section, raw);
                ops.push(Op::InsertImageAt {
                    section: *section,
                    index,
                    bytes,
                    kind: image_kind(path),
                    width: mm_to_hwpunit(width_mm.unwrap_or(80.0)),
                    height: mm_to_hwpunit(height_mm.unwrap_or(60.0)),
                });
                changes.push(Drift { section: *section, point: raw, delta: 1 });
            }
            EditCommand::DeleteBlock { section, block } => {
                let index = adjust(&changes, *section, *block);
                ops.push(Op::DeleteBlock { section: *section, index });
                changes.push(Drift { section: *section, point: *block, delta: -1 });
            }
            EditCommand::ShadeColumn { section, block, col, shade } => {
                let index = adjust(&changes, *section, *block);
                ops.push(Op::SetTableCellShade {
                    section: *section,
                    index,
                    sel: CellSel::Col(*col),
                    shade: shade.clone(),
                });
            }
            EditCommand::ShadeRow { section, block, row, shade } => {
                let index = adjust(&changes, *section, *block);
                ops.push(Op::SetTableCellShade {
                    section: *section,
                    index,
                    sel: CellSel::Row(*row),
                    shade: shade.clone(),
                });
            }
            EditCommand::ShadeCell { section, block, row, col, shade } => {
                let index = adjust(&changes, *section, *block);
                ops.push(Op::SetTableCellShade {
                    section: *section,
                    index,
                    sel: CellSel::Cell(*row, *col),
                    shade: shade.clone(),
                });
            }
            EditCommand::SetCell { section, block, row, col, runs } => {
                let index = adjust(&changes, *section, *block);
                ops.push(Op::SetTableCell {
                    section: *section,
                    index,
                    row: *row,
                    col: *col,
                    runs: runs.iter().map(AiRun::to_run_spec).collect(),
                });
            }
            EditCommand::SetCells { section, block, cells } => {
                let index = adjust(&changes, *section, *block);
                for cell in cells {
                    ops.push(Op::SetTableCell {
                        section: *section,
                        index,
                        row: cell.row,
                        col: cell.col,
                        runs: vec![AiRun { text: cell.text.clone(), ..Default::default() }.to_run_spec()],
                    });
                }
            }
            EditCommand::InsertRow { section, block, at, cells } => {
                let index = adjust(&changes, *section, *block);
                // Explicit `at` is a raw row coordinate (shift it by prior same-table inserts);
                // omitted = append at the *effective* end (original rows + earlier inserts).
                let at = match at {
                    Some(a) => adjust_row(&row_changes, *section, index, *a),
                    None => effective_rows(doc, &row_changes, *section, index),
                };
                ops.push(Op::TableInsertRows {
                    section: *section,
                    index,
                    at,
                    rows: vec![cells.iter().map(|c| c.to_cell_spec(false)).collect()],
                });
                row_changes.push(RowDrift { section: *section, block: index, at, count: 1 });
            }
            EditCommand::AppendRows { section, block, rows } => {
                let index = adjust(&changes, *section, *block);
                let at = effective_rows(doc, &row_changes, *section, index);
                let grid: Vec<Vec<hwp_ops::CellSpec>> = rows
                    .iter()
                    .map(|row| row.iter().map(|c| c.to_cell_spec(false)).collect())
                    .collect();
                let count = grid.len();
                ops.push(Op::TableInsertRows { section: *section, index, at, rows: grid });
                row_changes.push(RowDrift { section: *section, block: index, at, count });
            }
        }
    }
    Ok(ops)
}

/// Row count of the table at `(section, index)` (0 if that block isn't a table) — the append point
/// for `insert_row`/`append_rows`. Reads the ORIGINAL doc, which is correct: table-edit ops don't
/// shift block indices, so no in-script drift applies to the row count.
fn table_rows(doc: &hwp_model::document::SemanticDoc, section: usize, index: usize) -> usize {
    use hwp_model::document::Block;
    match doc.sections.get(section).and_then(|s| s.blocks.get(index)) {
        Some(Block::Table(t)) => t.rows,
        _ => 0,
    }
}

/// Parse an [`EditScript`] from the model's JSON (after stripping any code fence upstream).
pub fn parse_script(json: &str) -> Result<EditScript> {
    serde_json::from_str(json).map_err(|e| Error::Parse(format!("edit script JSON: {e}")))
}

/// The system prompt the editing model follows — it explains the anchored outline it will be given
/// and the exact command vocabulary it must emit (one JSON object, no prose).
pub fn edit_brief() -> &'static str {
    r##"## tf-hwp 문서 편집 (이 JSON 형식만 출력)
당신은 한국어 문서 편집 보조자입니다. 사용자가 준 [문서 개요]의 각 줄은
`[s{섹션}/b{블록}] 내용` 형태의 **앵커**입니다. 사용자의 편집 지시를 아래 명령으로 옮겨,
설명·머리말·마크다운·코드펜스 없이 JSON 객체 하나만 출력하세요.

{ "edits": [
  {"op":"insert_paragraph","section":0,"block":3,"position":"after",
   "runs":[{"text":"본문 "},{"text":"강조","bold":true}],"align":"justify"},
  {"op":"insert_heading","section":0,"block":3,"position":"after","text":"새 제목","align":"center"},
  {"op":"insert_table","section":0,"block":3,"position":"after",
   "header":["항목","내용"],"rows":[["A","..."],["B","..."]]},
  {"op":"insert_image","section":0,"block":3,"position":"after",
   "path":"/경로/그림.png","width_mm":90},
  {"op":"delete_block","section":0,"block":5},
  {"op":"shade_column","section":0,"block":4,"col":0,"shade":"#D9E1F2"},
  {"op":"shade_row","section":0,"block":4,"row":0,"shade":"#FFF2CC"},
  {"op":"shade_cell","section":0,"block":4,"row":1,"col":2,"shade":"#FCE4D6"},
  {"op":"set_cell","section":0,"block":4,"row":1,"col":0,"runs":[{"text":"홍길동","bold":true}]},
  {"op":"set_cells","section":0,"block":4,
   "cells":[{"row":1,"col":0,"text":"홍길동"},{"row":1,"col":1,"text":"대표"}]},
  {"op":"insert_row","section":0,"block":4,"cells":["3","이영희","디자인"]},
  {"op":"append_rows","section":0,"block":4,
   "rows":[["1","홍길동","대표"],["2","김철수","개발"]]}
] }

규칙:
- position(선택): "after"(기본, "아래에"/"다음에") | "before"(위에/앞에) | "start"(섹션 맨 앞) | "end"(섹션 맨 끝).
- "목차 아래에 표" → 목차 줄의 앵커 [s/b]를 찾아 그 block 번호로 insert_table을 after 로.
- run 속성(선택): bold, italic, underline, strike, color/highlight("#RRGGBB"), size_pt, font.
- 표 셀: 문자열 또는 {text,col_span,row_span,bold,shade} 객체. header 는 굵은 첫 행.
- shade 색상은 "#RRGGBB"; shade 를 생략하거나 null 이면 음영 제거.
- 기존 표를 채우거나 행을 추가할 때는 그 표의 [s/b] 앵커로 set_cell/set_cells/insert_row/append_rows 를 쓰세요.
  새 표를 만들 때만 insert_table. 표를 '채워달라'는 요청에 insert_table 로 빈 표를 새로 만들지 말 것.
- insert_row 의 at 을 생략하면 표 맨 끝에 행을 추가; append_rows 는 항상 맨 끝에 여러 행 추가.
- 기존 표를 가리킬 때만 set_*/insert_row/append_rows/shade_*/delete 의 block 으로 그 표/블록의 앵커를 쓸 것.
- 허용 op: insert_paragraph, insert_heading, insert_table, insert_image, delete_block,
  shade_column, shade_row, shade_cell, set_cell, set_cells, insert_row, append_rows.
  그 외 키 금지. 좌표는 모두 0부터 시작."##
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_model::document::{Block, Paragraph, Run, Section, SemanticDoc};
    use hwp_model::prelude::*;

    /// A doc with `n` single-text paragraphs in section 0 (block i text = "p{i}").
    fn doc_n(n: usize) -> SemanticDoc {
        let mut doc = SemanticDoc {
            char_shapes: vec![CharShape::default()],
            para_shapes: vec![ParaShape::default()],
            ..Default::default()
        };
        let blocks = (0..n)
            .map(|i| {
                Block::Paragraph(Paragraph {
                    runs: vec![Run { content: vec![Inline::Text(format!("p{i}"))], ..Default::default() }],
                    ..Default::default()
                })
            })
            .collect();
        doc.sections.push(Section { blocks, ..Default::default() });
        doc
    }

    fn apply_all(doc: &mut SemanticDoc, ops: &[Op]) {
        for op in ops {
            hwp_ops::apply(doc, op).expect("op applies");
        }
    }

    fn para_text(doc: &SemanticDoc, i: usize) -> String {
        match &doc.sections[0].blocks[i] {
            Block::Paragraph(p) => p.runs.iter().flat_map(|r| &r.content).filter_map(|c| match c {
                Inline::Text(t) => Some(t.as_str()),
                _ => None,
            }).collect(),
            _ => String::new(),
        }
    }

    #[test]
    fn parse_round_trips_a_realistic_script() {
        let json = r##"{"edits":[
            {"op":"insert_table","section":0,"block":2,"position":"after",
             "header":["항목","내용"],"rows":[["A","1"]]},
            {"op":"shade_column","section":0,"block":3,"col":0,"shade":"#D9E1F2"}
        ]}"##;
        let s = parse_script(json).unwrap();
        assert_eq!(s.edits.len(), 2);
    }

    #[test]
    fn insert_table_after_anchor_lands_in_the_right_place() {
        // "목차(b1) 아래에 표": insert after block 1.
        let doc = doc_n(3); // p0, p1(=목차), p2
        let script = parse_script(
            r#"{"edits":[{"op":"insert_table","section":0,"block":1,"position":"after",
                "rows":[["x"]]}]}"#,
        ).unwrap();
        let ops = compile_edits(&doc, &script).unwrap();
        let mut doc = doc;
        apply_all(&mut doc, &ops);
        assert_eq!(para_text(&doc, 0), "p0");
        assert_eq!(para_text(&doc, 1), "p1");
        assert!(matches!(doc.sections[0].blocks[2], Block::Table(_)), "table after 목차");
        assert_eq!(para_text(&doc, 3), "p2");
    }

    #[test]
    fn multiple_inserts_same_section_drift_correctly() {
        // Two inserts both "after b0" must NOT clobber: applied in order they land at b1, then b2,
        // pushing p1/p2 down — sequential application stays in range and ordered.
        let doc = doc_n(3); // p0,p1,p2
        let script = parse_script(
            r#"{"edits":[
                {"op":"insert_heading","section":0,"block":0,"position":"after","text":"H1"},
                {"op":"insert_heading","section":0,"block":0,"position":"after","text":"H2"}
            ]}"#,
        ).unwrap();
        let ops = compile_edits(&doc, &script).unwrap();
        let mut doc = doc;
        apply_all(&mut doc, &ops); // must not panic / go out of range
        assert_eq!(para_text(&doc, 0), "p0");
        // both headings present between p0 and p1
        let texts: Vec<String> = (0..doc.sections[0].blocks.len()).map(|i| para_text(&doc, i)).collect();
        assert!(texts.contains(&"H1".to_string()) && texts.contains(&"H2".to_string()));
        assert_eq!(texts[0], "p0");
        assert_eq!(texts.last().unwrap(), "p2");
    }

    #[test]
    fn delete_then_insert_drift_correctly() {
        let doc = doc_n(4); // p0,p1,p2,p3
        let script = parse_script(
            r#"{"edits":[
                {"op":"delete_block","section":0,"block":1},
                {"op":"insert_heading","section":0,"block":3,"position":"after","text":"END"}
            ]}"#,
        ).unwrap();
        let ops = compile_edits(&doc, &script).unwrap();
        let mut doc = doc;
        apply_all(&mut doc, &ops);
        // p1 gone; p0,p2,p3 remain then END
        let texts: Vec<String> = (0..doc.sections[0].blocks.len()).map(|i| para_text(&doc, i)).collect();
        assert_eq!(texts, vec!["p0", "p2", "p3", "END"]);
    }

    /// A doc whose section 0 is `[p0, <1-row table>]` — block 1 is an existing table to edit.
    /// The single header row is `["번호","이름","역할"]` (built via the op-bus, like the real path).
    fn doc_with_table() -> SemanticDoc {
        let mut doc = doc_n(1); // p0
        let cell = |t: &str| hwp_ops::CellSpec { text: t.into(), ..Default::default() };
        hwp_ops::apply(
            &mut doc,
            &Op::InsertTableAt {
                section: 0,
                index: 1,
                rows: vec![vec![cell("번호"), cell("이름"), cell("역할")]],
            },
        )
        .expect("seed table");
        doc
    }

    fn table_cell_text(doc: &SemanticDoc, bi: usize, row: usize, col: usize) -> String {
        let Block::Table(t) = &doc.sections[0].blocks[bi] else { panic!("block {bi} not a table") };
        let cell = t.cells.iter().find(|c| c.active && c.row == row && c.col == col).expect("cell");
        cell.blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(
                    p.runs
                        .iter()
                        .flat_map(|r| &r.content)
                        .filter_map(|c| match c {
                            Inline::Text(t) => Some(t.as_str()),
                            _ => None,
                        })
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect()
    }

    /// THE regression guard for the user's "마지막 표에 팀원 3명…" bug: a hand-written script using
    /// `insert_row` / `set_cell` must PARSE (no "unknown variant 'insert_row'"), compile, and apply.
    #[test]
    fn fill_existing_table_script_parses_compiles_applies() {
        let json = r##"{"edits":[
            {"op":"insert_row","section":0,"block":1,"cells":["1","홍길동","대표"]},
            {"op":"insert_row","section":0,"block":1,"cells":["2","김철수","개발"]},
            {"op":"set_cell","section":0,"block":1,"row":0,"col":1,"runs":[{"text":"성명","bold":true}]}
        ]}"##;
        // 1) PARSE — this is exactly where the old vocabulary rejected `insert_row`.
        let script = parse_script(json).expect("insert_row/set_cell must parse");
        assert_eq!(script.edits.len(), 3);
        // 2) COMPILE to typed ops.
        let mut doc = doc_with_table();
        let ops = compile_edits(&doc, &script).expect("compiles to ops");
        // 3) APPLY — no parse/NotImplemented error; rows appended, header cell rewritten.
        apply_all(&mut doc, &ops);
        if let Block::Table(t) = &doc.sections[0].blocks[1] {
            assert_eq!(t.rows, 3, "1 header + 2 appended rows");
        } else {
            panic!("block 1 must still be a table");
        }
        assert_eq!(table_cell_text(&doc, 1, 0, 1), "성명"); // set_cell rewrote the header
        assert_eq!(table_cell_text(&doc, 1, 1, 1), "홍길동");
        assert_eq!(table_cell_text(&doc, 1, 2, 2), "개발");
    }

    /// `set_cells` (batch fill) and `append_rows` (multi-row) over an existing table.
    #[test]
    fn set_cells_and_append_rows_compile_and_apply() {
        let json = r##"{"edits":[
            {"op":"append_rows","section":0,"block":1,
             "rows":[["1","홍길동","대표"],["2","김철수","개발"],["3","이영희","디자인"]]},
            {"op":"set_cells","section":0,"block":1,
             "cells":[{"row":0,"col":0,"text":"No"},{"row":0,"col":2,"text":"담당"}]}
        ]}"##;
        let script = parse_script(json).expect("parses");
        let mut doc = doc_with_table();
        let ops = compile_edits(&doc, &script).expect("compiles");
        apply_all(&mut doc, &ops);
        if let Block::Table(t) = &doc.sections[0].blocks[1] {
            assert_eq!(t.rows, 4, "1 header + 3 appended rows");
        } else {
            panic!("expected table");
        }
        assert_eq!(table_cell_text(&doc, 1, 0, 0), "No");
        assert_eq!(table_cell_text(&doc, 1, 0, 2), "담당");
        assert_eq!(table_cell_text(&doc, 1, 3, 1), "이영희");
    }

    #[test]
    fn mock_provider_edit_round_trips_through_propose() {
        let doc = doc_n(2);
        let prov = crate::MockProvider;
        let proposal = crate::propose_edits(&doc, &prov, "결론 추가해줘").unwrap();
        assert_eq!(proposal.ops.len(), 1);
        let preview = proposal.preview();
        assert!(preview.contains("[mock-ai] 결론 추가해줘"), "preview shows the edit: {preview}");
    }
}
