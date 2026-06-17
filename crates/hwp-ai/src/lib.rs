//! AI layer (Phase A0+): structure-preserving projection + AI fill via the typed op-bus.
//!
//! Principle (PLAN §3.2): AI output is ALWAYS validated `hwp_ops::Op`s — no raw bytes/XML.
//! The cloud/local choice is a backend swap behind `LlmProvider`; cloud BYOK (Anthropic) lives
//! behind the `anthropic` feature, native-only, so the core stays wasm-clean.

use hwp_model::prelude::*;
use hwp_ops::Op;

pub mod content;

/// LLM backend abstraction. The cloud/local choice is purely a swap behind this trait.
pub trait LlmProvider {
    fn name(&self) -> &str;
    /// Given document context + an instruction, propose new paragraph(s) to append
    /// (Korean, formal 공문서 style). One string per paragraph.
    fn propose_paragraphs(&self, context: &str, instruction: &str) -> Result<Vec<String>>;
}

/// Deterministic offline provider — no API key. For testing the AI→op→export pipeline
/// without a live model. NEVER use for real drafting.
#[derive(Default)]
pub struct MockProvider;

impl LlmProvider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }
    fn propose_paragraphs(&self, _context: &str, instruction: &str) -> Result<Vec<String>> {
        Ok(vec![format!("[mock-ai] 지시에 따라 작성된 문단입니다: {instruction}")])
    }
}

/// Run an AI fill: the provider proposes paragraphs, each applied through the SAME op-bus a
/// human edit uses (validated, dirty-marked, round-trip-safe). Returns the applied ops.
///
/// MVP appends paragraphs; the proposal→validate→diff→approve→commit loop and richer ops
/// (set_para_pr, table fill, templates) grow from here (PLAN §3.2).
pub fn ai_fill(
    doc: &mut SemanticDoc,
    provider: &dyn LlmProvider,
    instruction: &str,
) -> Result<Vec<Op>> {
    let context = doc.plain_text();
    let paragraphs = provider.propose_paragraphs(&context, instruction)?;
    let mut ops = Vec::new();
    for text in paragraphs {
        let t = text.trim();
        if t.is_empty() {
            continue;
        }
        let op = Op::AppendParagraph { section: 0, text: t.to_string() };
        hwp_ops::apply(doc, &op)?;
        ops.push(op);
    }
    Ok(ops)
}

/// Project the document to **structure-preserving Markdown** (issue #004): paragraphs and tables
/// in reading order, tables rendered as `|`-grids, each block prefixed with a stable `[s{sec}/b{blk}]`
/// anchor the AI can cite (fill-from-source). The anti-PDF-flatten RAG payload (PLAN §3.2).
pub fn to_markdown(doc: &SemanticDoc) -> Result<String> {
    let mut out = String::new();
    for (si, sec) in doc.sections.iter().enumerate() {
        for (bi, block) in sec.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(p) => {
                    let text = para_text(p);
                    if !text.trim().is_empty() {
                        out.push_str(&format!("[s{si}/b{bi}] {text}\n"));
                    }
                }
                Block::Table(t) => {
                    let (rows, cols) = (t.rows.max(1), t.cols.max(1));
                    out.push_str(&format!("[s{si}/b{bi}] (표 {rows}×{cols})\n"));
                    let mut grid = vec![vec![String::new(); cols]; rows];
                    for c in t.cells.iter().filter(|c| c.active) {
                        if c.row < rows && c.col < cols {
                            grid[c.row][c.col] = cell_text(c);
                        }
                    }
                    for row in &grid {
                        out.push_str("| ");
                        out.push_str(&row.join(" | "));
                        out.push_str(" |\n");
                    }
                }
            }
        }
    }
    if out.is_empty() {
        out = doc.plain_text();
    }
    Ok(out)
}

/// Concatenate a paragraph's text runs.
fn para_text(p: &Paragraph) -> String {
    p.runs
        .iter()
        .flat_map(|r| r.content.iter())
        .filter_map(|inl| match inl {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

/// A cell's text (its first paragraph).
fn cell_text(cell: &Cell) -> String {
    cell.blocks
        .iter()
        .find_map(|b| match b {
            Block::Paragraph(p) => Some(para_text(p)),
            _ => None,
        })
        .unwrap_or_default()
}

/// An AI-proposed edit: typed ops applied to a scratch doc, validated, diff-previewed for
/// human accept/reject before commit (PLAN §3.2).
pub struct Proposal {
    pub ops: Vec<Op>,
    pub rationale: String,
}

#[cfg(feature = "anthropic")]
pub mod anthropic;
