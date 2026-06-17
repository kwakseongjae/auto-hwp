//! AI layer (Phase A0+): structure-preserving projection + AI fill via the typed op-bus.
//!
//! Principle (PLAN §3.2): AI output is ALWAYS validated `hwp_ops::Op`s — no raw bytes/XML.
//! The cloud/local choice is a backend swap behind `LlmProvider`; cloud BYOK (Anthropic) lives
//! behind the `anthropic` feature, native-only, so the core stays wasm-clean.

use hwp_model::prelude::*;
use hwp_ops::Op;

pub mod content;
/// BYOK key resolution (env + optional OS keychain).
pub mod secret;
/// Local model provider (Ollama) — behind the `local` feature.
#[cfg(feature = "local")]
pub mod ollama;
/// OpenRouter (OpenAI-compatible) cloud provider — behind the `openrouter` feature.
#[cfg(feature = "openrouter")]
pub mod openrouter;

/// LLM backend abstraction. The cloud/local choice is purely a swap behind this trait.
pub trait LlmProvider {
    fn name(&self) -> &str;
    /// Given document context + an instruction, propose new paragraph(s) to append
    /// (Korean, formal 공문서 style). One string per paragraph. The low-fidelity path —
    /// prefer [`LlmProvider::propose_content`] for formatted output.
    fn propose_paragraphs(&self, context: &str, instruction: &str) -> Result<Vec<String>>;

    /// Propose RICH, template-conformant content ([`content::AiContent`]): headings, formatted
    /// runs, lists, tables, page setup. This is what drives the high-fidelity `AppendRich*` ops.
    /// The default wraps each plain paragraph from [`LlmProvider::propose_paragraphs`] as a
    /// paragraph block, so a text-only provider still flows through the rich pipeline unchanged.
    fn propose_content(&self, context: &str, instruction: &str) -> Result<content::AiContent> {
        let blocks = self
            .propose_paragraphs(context, instruction)?
            .into_iter()
            .map(|t| content::AiBlock::Paragraph {
                runs: vec![content::AiRun { text: t, ..Default::default() }],
                para: content::AiPara::default(),
            })
            .collect();
        Ok(content::AiContent { blocks, page: None })
    }
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
    /// Deterministic RICH content (heading + formatted runs) so the `AppendRich*` pipeline and the
    /// propose→preview→commit loop are exercisable with no API key.
    fn propose_content(&self, _context: &str, instruction: &str) -> Result<content::AiContent> {
        use content::{AiBlock, AiContent, AiPara, AiRun};
        Ok(AiContent {
            blocks: vec![
                AiBlock::Heading {
                    text: format!("[mock-ai] {instruction}"),
                    align: Some("center".into()),
                    style: None,
                },
                AiBlock::Paragraph {
                    runs: vec![
                        AiRun { text: "지시에 따라 ".into(), ..Default::default() },
                        AiRun { text: "굵게".into(), bold: true, ..Default::default() },
                        AiRun { text: " 작성된 문단입니다.".into(), ..Default::default() },
                    ],
                    para: AiPara { align: Some("justify".into()), ..Default::default() },
                },
            ],
            page: None,
        })
    }
}

/// Run an AI fill end-to-end: the provider proposes RICH content, which is compiled to ops and
/// committed to `doc` through the SAME op-bus a human edit uses (validated, dirty-marked,
/// round-trip-safe). Returns the applied ops.
///
/// For a human-in-the-loop preview/approve gate, call [`propose`] (which validates on a scratch
/// copy and returns a [`Proposal`] with a [`Proposal::preview`]) and commit it yourself.
pub fn ai_fill(
    doc: &mut SemanticDoc,
    provider: &dyn LlmProvider,
    instruction: &str,
) -> Result<Vec<Op>> {
    let proposal = propose(doc, provider, instruction)?;
    for op in &proposal.ops {
        hwp_ops::apply(doc, op)?;
    }
    Ok(proposal.ops)
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

/// An AI-proposed edit: typed ops (compiled from template-conformant content) validated on a
/// scratch copy of the document, diff-previewed for human accept/reject BEFORE commit (PLAN §3.2).
pub struct Proposal {
    pub ops: Vec<Op>,
    pub rationale: String,
}

impl Proposal {
    /// A human-readable preview of the change — one line per op — to show before committing.
    pub fn preview(&self) -> String {
        let mut s = String::new();
        for op in &self.ops {
            s.push_str(&op_summary(op));
            s.push('\n');
        }
        s
    }
}

/// Produce a validated [`Proposal`] WITHOUT mutating `doc`: the provider authors template-conformant
/// rich content, it is compiled to ops, and the ops are dry-run on a scratch clone so any apply
/// error surfaces BEFORE the human approves. The live document is untouched until the caller
/// commits the ops (via [`ai_fill`], `hwp_ops::apply`, or an `EditSession` for undo/redo).
pub fn propose(doc: &SemanticDoc, provider: &dyn LlmProvider, instruction: &str) -> Result<Proposal> {
    let context = to_markdown(doc).unwrap_or_else(|_| doc.plain_text());
    let content = provider.propose_content(&context, instruction)?;
    propose_from_content(doc, &content, &format!("지시: {instruction}"))
}

/// Validate already-authored [`content::AiContent`] into a [`Proposal`] WITHOUT mutating `doc`:
/// compile to ops and dry-run them on a scratch clone. Used by the MCP propose/commit flow where
/// an external agent authored the content JSON (no in-process LLM provider).
pub fn propose_from_content(
    doc: &SemanticDoc,
    content: &content::AiContent,
    note: &str,
) -> Result<Proposal> {
    let ops = content::compile_to_ops(content);
    if ops.is_empty() {
        return Err(Error::Other("제안된 콘텐츠가 없습니다 (AI proposed no content)".into()));
    }
    // Dry-run on a scratch copy: catch any apply error without touching the live document.
    let mut scratch = doc.clone();
    for op in &ops {
        hwp_ops::apply(&mut scratch, op)?;
    }
    let rationale =
        format!("{note}\n{} 블록 → {} op (스크래치 복사본에서 검증됨)", content.blocks.len(), ops.len());
    Ok(Proposal { ops, rationale })
}

/// One human-readable line summarizing an op (for [`Proposal::preview`]).
fn op_summary(op: &Op) -> String {
    match op {
        Op::AppendParagraph { text, .. } => format!("＋ 문단: {}", truncate(text, 60)),
        Op::AppendRichParagraph { runs, para, .. } => {
            let text: String = runs.iter().map(|r| r.text.as_str()).collect();
            let style = para.style.as_deref().map(|s| format!(" «{s}»")).unwrap_or_default();
            let align = para.align.as_deref().map(|a| format!(" [{a}]")).unwrap_or_default();
            format!("＋ 문단{style}{align}: {}", truncate(&text, 60))
        }
        Op::AppendTable { header, rows, .. } => {
            let cols = header.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
            format!("＋ 표 {}행 × {}열", rows.len() + usize::from(!header.is_empty()), cols)
        }
        Op::AppendRichTable { rows, .. } => format!("＋ 표 {}행", rows.len()),
        Op::SetPageLayout { orientation, margins_mm, .. } => {
            let o = orientation.as_deref().unwrap_or("(유지)");
            let m = margins_mm.as_ref().map(|m| format!(", 여백 {}mm", m.left)).unwrap_or_default();
            format!("＋ 페이지: {o}{m}")
        }
        other => format!("＋ {other:?}"),
    }
}

/// Truncate to `n` Unicode scalars, appending an ellipsis if cut.
fn truncate(s: &str, n: usize) -> String {
    let head: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(feature = "anthropic")]
pub mod anthropic;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_propose_yields_rich_validated_ops() {
        // A minimal section-0 doc so AppendRich* ops have a target.
        let mut doc = SemanticDoc::default();
        doc.sections.push(Section::default());

        let p = propose(&doc, &MockProvider, "결론 문단 추가").unwrap();
        // Rich path: a heading + a formatted paragraph → two AppendRichParagraph ops.
        assert_eq!(p.ops.len(), 2);
        assert!(p.ops.iter().all(|o| matches!(o, Op::AppendRichParagraph { .. })));
        // Preview is human-readable and mentions the bold-bearing paragraph text.
        let preview = p.preview();
        assert!(preview.contains("문단"), "preview: {preview}");
        // propose() must NOT mutate the live doc (no commit yet).
        assert!(!doc.any_dirty(), "propose must not touch the live document");

        // ai_fill commits the same rich ops.
        let ops = ai_fill(&mut doc, &MockProvider, "결론 문단 추가").unwrap();
        assert_eq!(ops.len(), 2);
        assert!(doc.any_dirty());
    }

    #[test]
    fn default_propose_content_wraps_plain_paragraphs() {
        // A provider that only implements propose_paragraphs still flows through the rich pipeline.
        struct PlainOnly;
        impl LlmProvider for PlainOnly {
            fn name(&self) -> &str {
                "plain"
            }
            fn propose_paragraphs(&self, _c: &str, _i: &str) -> Result<Vec<String>> {
                Ok(vec!["문단 하나".into(), "문단 둘".into()])
            }
        }
        let mut doc = SemanticDoc::default();
        doc.sections.push(Section::default());
        let p = propose(&doc, &PlainOnly, "x").unwrap();
        assert_eq!(p.ops.len(), 2);
        assert!(p.ops.iter().all(|o| matches!(o, Op::AppendRichParagraph { .. })));
    }
}
