//! Template-conformant AI content + the preprocessor that compiles it to portable op-bus ops.
//!
//! The pipeline (user's stated direction): the AI must produce content that follows a
//! **template** (`template_brief`) — a constrained, structured JSON, NOT free prose or raw XML.
//! `parse_content` validates it; `compile_to_ops` transforms it into typed `hwp_ops::Op`s
//! (the "이식 가능한 코드"), which the op-bus applies + validates + round-trip-safely exports.
//!
//! MVP block coverage: heading, paragraph (with bold runs → native OWPML bold), bullet,
//! divider, simple table (text grid). Native tables/charts/fonts grow here behind the SAME
//! contract — the AI's JSON shape stays stable while the compiler emits richer OWPML.

use hwp_model::error::{Error, Result};
use hwp_ops::{CellSpec, Op, PageMargins, ParaSpec, RunSpec};
use serde::{Deserialize, Serialize};

/// The structured content an AI fill must produce.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiContent {
    pub blocks: Vec<AiBlock>,
    /// Optional page setup (orientation / margins) for section 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<AiPage>,
}

/// Page setup the AI may request: orientation + a uniform margin.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiPage {
    /// "portrait" | "landscape".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// Uniform page margin in millimeters (applied to all four sides).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_mm: Option<f32>,
}

/// A formatted text run (the smallest unit the AI controls). Maps to a synthesized charPr.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiRun {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    /// Font size in points (e.g. 14). None inherits the document default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<f32>,
    /// Text color `#RRGGBB`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Highlight color `#RRGGBB`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    /// Font family name (e.g. "맑은 고딕").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
}

impl AiRun {
    fn to_run_spec(&self) -> RunSpec {
        RunSpec {
            text: self.text.clone(),
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strike: self.strike,
            size_pt: self.size_pt,
            color: self.color.clone(),
            highlight: self.highlight.clone(),
            font: self.font.clone(),
        }
    }
}

/// Paragraph-shape options (alignment, spacing, indents) — shared by heading/paragraph blocks.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiPara {
    /// Named paragraph style (e.g. "개요 1", "본문", "바탕글").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// "left" | "center" | "right" | "justify" | "distribute" | "distribute_space".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_spacing_pct: Option<u32>,
    /// First-line indent in points (negative = hanging).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_before_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_after_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_left_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_right_pt: Option<f32>,
}

impl AiPara {
    fn to_para_spec(&self) -> ParaSpec {
        ParaSpec {
            style: self.style.clone(),
            align: self.align.clone(),
            line_spacing_pct: self.line_spacing_pct,
            indent_pt: self.indent_pt,
            margin_left_pt: self.margin_left_pt,
            margin_right_pt: self.margin_right_pt,
            space_before_pt: self.space_before_pt,
            space_after_pt: self.space_after_pt,
        }
    }
}

/// One block of generated content. Tagged JSON: `{"type":"paragraph","runs":[...]}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiBlock {
    /// A heading line (bold). Optional `align` (e.g. center a title) and named `style` (e.g. "개요 1").
    Heading {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<String>,
    },
    /// A paragraph of formatted runs, with optional paragraph shape.
    Paragraph {
        runs: Vec<AiRun>,
        #[serde(default, flatten)]
        para: AiPara,
    },
    /// A single bullet item.
    Bullet { text: String },
    /// A bullet list (each item a `• ` paragraph with hanging indent).
    BulletList { items: Vec<String> },
    /// A numbered list (`1.`, `2.`, … with hanging indent).
    OrderedList { items: Vec<String> },
    /// A horizontal divider.
    Divider,
    /// A table → native `<hp:tbl>`. `header` is an optional bold first row; `rows` are body rows
    /// of cells that may be a plain string or an object with merge spans / shade.
    Table {
        #[serde(default)]
        header: Vec<String>,
        rows: Vec<Vec<AiCell>>,
    },
}

/// A table cell: either a plain string, or an object with merge spans / bold / shade.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AiCell {
    Text(String),
    Rich(AiCellObj),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiCellObj {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col_span: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_span: Option<usize>,
    #[serde(default)]
    pub bold: bool,
    /// Background shade `#RRGGBB`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shade: Option<String>,
}

impl AiCell {
    fn to_cell_spec(&self, header: bool) -> CellSpec {
        match self {
            AiCell::Text(t) => CellSpec { text: t.clone(), bold: header, ..Default::default() },
            AiCell::Rich(o) => CellSpec {
                text: o.text.clone(),
                col_span: o.col_span.unwrap_or(1).max(1),
                row_span: o.row_span.unwrap_or(1).max(1),
                bold: o.bold || header,
                shade: o.shade.clone(),
            },
        }
    }
}

/// The template the AI must follow — passed to the model (or read by a Claude Code agent) so
/// generation conforms to a portable shape instead of free-form text.
pub fn template_brief() -> &'static str {
    r##"## tf-hwp AI 콘텐츠 템플릿 (이 JSON 형식만 출력)
당신은 한국 공문서 작성 보조자입니다. 아래 JSON 스키마를 *그대로* 따른 콘텐츠만 출력하세요.
설명·머리말·마크다운·코드펜스 없이 JSON 객체 하나만 출력합니다.

{
  "blocks": [
    { "type": "heading",   "text": "제목" },
    { "type": "paragraph", "runs": [
        {"text":"일반 "},
        {"text":"굵게","bold":true},
        {"text":" 기울임","italic":true},
        {"text":" 밑줄","underline":true},
        {"text":" 취소선","strike":true},
        {"text":" 빨강","color":"#FF0000"},
        {"text":" 형광","highlight":"#FFFF00"},
        {"text":" 14pt 맑은고딕","size_pt":14,"font":"맑은 고딕"}
    ], "align":"center", "line_spacing_pct":160 },
    { "type": "bullet_list", "items": ["첫째 항목", "둘째 항목"] },
    { "type": "ordered_list", "items": ["첫째 단계", "둘째 단계"] },
    { "type": "divider" },
    { "type": "table", "header": ["항목","내용"], "rows": [
        ["A","..."],
        [ {"text":"병합 셀","col_span":2,"bold":true,"shade":"#FFF2CC"} ]
    ] }
  ]
}

규칙:
- 모든 텍스트는 한국어 공문서체.
- run 속성(선택): bold, italic, underline, strike (불리언), color·highlight ("#RRGGBB"), size_pt (숫자 pt), font (글꼴 이름).
- paragraph 속성(선택): align(left/center/right/justify), line_spacing_pct, indent_pt, space_before_pt, space_after_pt, margin_left_pt. heading은 align 가능.
- 목록: bullet_list/ordered_list 의 items 배열. 표 셀은 문자열 또는 {text,col_span,row_span,bold,shade} 객체(병합·음영).
- 스타일: heading/paragraph 에 style("바탕글"/"본문"/"개요 1"~"개요 7") 지정 가능. **개요 N 스타일은 자동으로 번호를 매기므로, 제목 text 앞에 "1." 같은 번호를 직접 넣지 말 것**(중복됨).
- 허용 블록: heading, paragraph, bullet, bullet_list, ordered_list, divider, table. 그 외 키 금지."##
}

/// Validate + parse the AI's JSON content.
pub fn parse_content(json: &str) -> Result<AiContent> {
    serde_json::from_str(json).map_err(|e| Error::Parse(format!("AI content JSON: {e}")))
}

const DIVIDER: &str = "──────────────────────────────";

/// A list-item paragraph: marker + text with a hanging indent so wrapped lines align under the
/// text rather than the marker (left margin 18pt, first line out-dented by 18pt).
fn list_item_op(text: &str) -> Op {
    Op::AppendRichParagraph {
        section: 0,
        runs: vec![RunSpec { text: text.to_string(), ..Default::default() }],
        para: ParaSpec { margin_left_pt: Some(18.0), indent_pt: Some(-18.0), ..Default::default() },
    }
}

/// Preprocess structured AI content into portable op-bus operations.
pub fn compile_to_ops(content: &AiContent) -> Vec<Op> {
    let mut ops = Vec::new();
    if let Some(pg) = &content.page {
        let margins = pg.margin_mm.map(|m| PageMargins { left: m, right: m, top: m, bottom: m });
        if pg.orientation.is_some() || margins.is_some() {
            ops.push(Op::SetPageLayout {
                section: 0,
                orientation: pg.orientation.clone(),
                margins_mm: margins,
            });
        }
    }
    for block in &content.blocks {
        match block {
            AiBlock::Heading { text, align, style } => ops.push(Op::AppendRichParagraph {
                section: 0,
                runs: vec![RunSpec { text: text.clone(), bold: true, ..Default::default() }],
                para: ParaSpec { style: style.clone(), align: align.clone(), ..Default::default() },
            }),
            AiBlock::Paragraph { runs, para } => ops.push(Op::AppendRichParagraph {
                section: 0,
                runs: runs.iter().map(AiRun::to_run_spec).collect(),
                para: para.to_para_spec(),
            }),
            AiBlock::Bullet { text } => ops.push(list_item_op(&format!("• {text}"))),
            AiBlock::BulletList { items } => {
                for it in items {
                    ops.push(list_item_op(&format!("• {it}")));
                }
            }
            AiBlock::OrderedList { items } => {
                for (n, it) in items.iter().enumerate() {
                    ops.push(list_item_op(&format!("{}. {it}", n + 1)));
                }
            }
            AiBlock::Divider => ops.push(Op::AppendParagraph {
                section: 0,
                text: DIVIDER.to_string(),
            }),
            AiBlock::Table { header, rows } => {
                let mut spec_rows: Vec<Vec<CellSpec>> = Vec::new();
                if !header.is_empty() {
                    spec_rows.push(
                        header
                            .iter()
                            .map(|h| CellSpec { text: h.clone(), bold: true, ..Default::default() })
                            .collect(),
                    );
                }
                for row in rows {
                    spec_rows.push(row.iter().map(|c| c.to_cell_spec(false)).collect());
                }
                ops.push(Op::AppendRichTable { section: 0, rows: spec_rows });
            }
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_compiles_template() {
        let json = r#"{"blocks":[
            {"type":"heading","text":"검토 의견"},
            {"type":"paragraph","runs":[{"text":"본 안건은 "},{"text":"타당","bold":true},{"text":"합니다."}]},
            {"type":"divider"},
            {"type":"table","header":["구분","결과"],"rows":[["1","승인"]]}
        ]}"#;
        let content = parse_content(json).unwrap();
        let ops = compile_to_ops(&content);
        // heading + paragraph + divider + table = 4 ops (table is one native AppendRichTable)
        assert_eq!(ops.len(), 4);
        assert!(matches!(ops[0], Op::AppendRichParagraph { .. }));
        assert!(matches!(ops[3], Op::AppendRichTable { .. }));
    }
}
