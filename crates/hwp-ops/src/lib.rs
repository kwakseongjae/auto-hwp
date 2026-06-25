//! The typed edit-op/command bus — the **single mutation surface** for both the UI
//! and the AI (no raw-XML path anywhere). Modeled on rhwp's hwpctl Action/ParameterSet
//! shape but as our own versioned ops. See PLAN §3.2–3.3 and the ribbon→op map.
//!
//! Phase 0: op vocabulary + an undo/redo journal skeleton. Op *application* against
//! `SemanticDoc` and serialization land with the editor (Phase 3).

use hwp_model::prelude::*;

/// FIND / REPLACE engine: pure `find_matches` over the doc model + replace-op builders that the
/// caller hands to [`EditSession::do_ops`] (replace-all = one undo unit). See [`find`].
pub mod find;

/// Schema version of the op vocabulary (UI and AI/MCP must agree).
pub const OP_SCHEMA_VERSION: u32 = 1;

/// A range addressed by node ids (selection / target of an op).
#[derive(Clone, Debug)]
pub struct Range {
    pub start: NodeId,
    pub end: NodeId,
}

/// A caret position inside one paragraph: `offset` is a Unicode-scalar (char) index over the
/// paragraph's concatenated run text. Paragraph-scoped — never clamps into another paragraph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caret {
    pub node: NodeId,
    pub offset: usize,
}

/// Wave-1 (MVP) edit operations. Formatting ops are *property-set* ops; the HWPX
/// serializer interns them into the `header.xml` charPr/paraPr/style pools.
#[derive(Clone, Debug)]
pub enum Op {
    // text (in-place, sub-paragraph): char-offset Caret addressing within a simple paragraph
    InsertText { at: Caret, text: String },
    DeleteRange { start: Caret, end: Caret },
    // formatting (property-set; serializer interns into header.xml pools)
    SetCharPr { range: Range, shape: CharShape },
    /// Run-level (sub-paragraph) char formatting: apply `shape` to the half-open CHARACTER range
    /// `start..end` over paragraph `para`'s concatenated run text, splitting runs at those exact
    /// (UTF-8-safe) boundaries so only the selection is re-formatted.
    SetRunCharPr { para: NodeId, start: usize, end: usize, shape: CharShape },
    SetParaPr { range: Range, shape: ParaShape },
    /// Apply a named paragraph style (e.g. "개요 1", "본문") to the addressed paragraphs — the
    /// serializer resolves the name to a `styleIDRef` (+ the style's `paraPrIDRef`) via the pool.
    ApplyStyle { range: Range, style: String },
    // structure
    InsertSectionBreak { at: NodeId },
    InsertTable { at: NodeId, rows: usize, cols: usize },
    InsertImage { at: NodeId, bin_ref: String, width: HwpUnit, height: HwpUnit },
    // table edits
    TableInsertRow { table: NodeId, at: usize },
    TableInsertCol { table: NodeId, at: usize },
    MergeCells { table: NodeId, top: usize, left: usize, bottom: usize, right: usize },
    // section-addressed convenience op (MVP edit→export path)
    AppendParagraph { section: usize, text: String },
    /// Append a paragraph with per-run formatting + paragraph shape (the preprocessor target
    /// for AI content). Both synthesize header.xml charPr/paraPr entries on export.
    AppendRichParagraph { section: usize, runs: Vec<RunSpec>, para: ParaSpec },
    /// Append a simple grid table (header row + body rows) — the AI-content preprocessor
    /// target for native `<hp:tbl>` emission. Header cells render bold.
    AppendTable { section: usize, header: Vec<String>, rows: Vec<Vec<String>> },
    /// Append a table with per-cell merge spans, bold, and background shade. Each logical row
    /// lists only the *uncovered* cells (HTML-table semantics); covered positions are omitted.
    AppendRichTable { section: usize, rows: Vec<Vec<CellSpec>> },
    /// Set a section's page orientation and/or margins (patches the existing `secPr` on export).
    SetPageLayout { section: usize, orientation: Option<String>, margins_mm: Option<PageMargins> },

    // ---- vibe-docs: anchored, positional edits (anchor = (section, block index) == `[s/b]`) ----
    /// Insert a rich paragraph at block `index` (shifting later blocks down). `index == len` appends.
    InsertParagraphAt { section: usize, index: usize, runs: Vec<RunSpec>, para: ParaSpec },
    /// Insert a rich table at block `index` (same coverage semantics as `AppendRichTable`).
    InsertTableAt { section: usize, index: usize, rows: Vec<Vec<CellSpec>> },
    /// Insert an embedded image at block `index`: `bytes`/`kind` (e.g. "png") become a `BinData`,
    /// referenced by a fresh paragraph holding an `Inline::Image`. `width`/`height` in HWPUNIT.
    InsertImageAt { section: usize, index: usize, bytes: Vec<u8>, kind: String, width: HwpUnit, height: HwpUnit },
    /// Delete the block at `index` in `section`.
    DeleteBlock { section: usize, index: usize },
    /// Move the block at index `from` to index `to` within `section` (removing it, then reinserting at
    /// the post-removal index). Generalizes M4's "move = DeleteBlock + InsertImageAt" to ANY block
    /// (tables, paragraphs) in ONE op so a single undo restores the original order. `to == len` (the
    /// block-count BEFORE removal) moves it to the end; `from == to` is a no-op.
    MoveBlock { section: usize, from: usize, to: usize },
    /// Resize the anchored image of the `index`-th block: set the `ImageRef`'s `width`/`height` (in
    /// HWPUNIT) on the first image inline of that paragraph. The direct-manipulation resize handle
    /// commits exactly this on pointerup (one undoable op); "move" is `DeleteBlock` + `InsertImageAt`.
    SetImageSize { section: usize, index: usize, width: HwpUnit, height: HwpUnit },
    /// Recolor cells of an EXISTING table (the `index`-th block): set/clear background shade for the
    /// cells the selector picks (a whole column, a whole row, one cell, or all). `shade=None` clears.
    SetTableCellShade { section: usize, index: usize, sel: CellSel, shade: Option<String> },
    /// Replace the text of one EXISTING cell of the `index`-th table (the active cell anchored at
    /// `(row, col)` — same addressing as `SetTableCellShade`'s `CellSel::Cell`). The cell's blocks
    /// are rebuilt from `runs` (one paragraph), so this *fills* an existing cell rather than insert.
    SetTableCell { section: usize, index: usize, row: usize, col: usize, runs: Vec<RunSpec> },
    /// Insert one or more BODY rows into the EXISTING `index`-th table at logical row `at`
    /// (`at == t.rows` appends). Existing cells at row >= `at` shift down by `rows.len()`; the new
    /// cells take `col_span`/`shade`/`bold` from each `CellSpec` (HTML-table coverage per row).
    TableInsertRows { section: usize, index: usize, at: usize, rows: Vec<Vec<CellSpec>> },
    /// Append ONE empty BODY row to the `index`-th table that REPLICATES the column layout of the
    /// table's last active row (same per-cell `col`/`col_span` + borders, empty text). The interactive
    /// "+행" verb: a naive `cols`-single-cell row breaks tables with merged columns (the 보유역량-spans-3
    /// case → a misaligned grid), so we clone the existing column structure instead.
    TableAppendEmptyRow { section: usize, index: usize },
    /// Replace the text of a SIMPLE top-level paragraph (the `block`-th block of `section`) with one run
    /// of `text`, PRESERVING the paragraph's existing first-run char shape + para shape (so inline
    /// editing keeps the cell/paragraph's color/italic/alignment). Refuses a structural paragraph
    /// (image/field/multiple-inline) so we never silently flatten rich content — the UI falls back to chat.
    SetParagraphText { section: usize, block: usize, text: String },
    /// Set the COLUMN WIDTH proportions of the `index`-th table (the column-resize drag commit). `widths`
    /// must have exactly `t.cols` positive entries; the renderer rescales them to the body width, so only
    /// the ratios matter. ONE undo unit.
    SetTableColWidths { section: usize, index: usize, widths: Vec<i32> },
    /// Set the per-row MINIMUM HEIGHT override (HWPUNIT) of the `index`-th table (the row-resize drag
    /// commit). `heights` must have exactly `t.rows` entries, each `>= 0` (`0` = that row stays
    /// content-sized; `> 0` = a floor so text never clips). The typesetter honors these as
    /// `max(content, override)`. ONE undo unit. See [`hwp_model::prelude::Table::row_heights`].
    SetTableRowHeights { section: usize, index: usize, heights: Vec<i32> },
}

/// Which cells of an existing table a [`Op::SetTableCellShade`] targets.
#[derive(Clone, Debug)]
pub enum CellSel {
    /// Every cell whose logical column-span covers column `0`-based index.
    Col(usize),
    /// Every cell whose logical row-span covers row `0`-based index.
    Row(usize),
    /// The single cell anchored at (row, col).
    Cell(usize, usize),
    /// Every cell in the table.
    All,
}

/// Page margins in millimeters for `SetPageLayout`.
#[derive(Clone, Debug)]
pub struct PageMargins {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

/// One cell of an `AppendRichTable`. `col_span`/`row_span` default to 1.
#[derive(Clone, Debug)]
pub struct CellSpec {
    pub text: String,
    pub col_span: usize,
    pub row_span: usize,
    pub bold: bool,
    /// Background shade `#RRGGBB` (synthesized into a borderFill fillBrush).
    pub shade: Option<String>,
}

impl Default for CellSpec {
    fn default() -> Self {
        CellSpec { text: String::new(), col_span: 1, row_span: 1, bold: false, shade: None }
    }
}

/// A formatted text run for `AppendRichParagraph` (the portable representation the AI content
/// preprocessor emits). Maps 1:1 to a synthesized `CharShape` → `<hh:charPr>` on export.
#[derive(Clone, Debug, Default)]
pub struct RunSpec {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// Font size in points (e.g. 14.0); None inherits the document default.
    pub size_pt: Option<f32>,
    /// Text color `#RRGGBB`; None inherits.
    pub color: Option<String>,
    /// Highlight/shade color `#RRGGBB`; None = none.
    pub highlight: Option<String>,
    /// Font family name (e.g. "맑은 고딕"); None inherits.
    pub font: Option<String>,
}

impl RunSpec {
    /// Build the typography `CharShape` this run requests (default = no overrides).
    pub fn to_char_shape(&self) -> CharShape {
        CharShape {
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strikeout: self.strike,
            height: self.size_pt.map(|p| (p * 100.0).round() as i32).unwrap_or(0),
            text_color: self.color.as_deref().and_then(Color::from_hex).unwrap_or_default(),
            shade_color: self.highlight.as_deref().and_then(Color::from_hex).unwrap_or_default(),
            font_family: self.font.clone().filter(|s| !s.trim().is_empty()),
            ..Default::default()
        }
    }
}

/// Paragraph-shape overrides the AI content preprocessor emits. Maps to a synthesized
/// `<hh:paraPr>` on export (alignment, line spacing, indents, spacing). Unset = inherit.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParaSpec {
    /// Named paragraph style to apply (e.g. "개요 1", "본문"); resolved to a styleIDRef on export.
    pub style: Option<String>,
    /// "left" | "center" | "right" | "justify" | "distribute" | "distribute_space".
    pub align: Option<String>,
    /// Line spacing percent (e.g. 160 for 160%).
    pub line_spacing_pct: Option<u32>,
    /// First-line indent in points; negative = hanging (내어쓰기).
    pub indent_pt: Option<f32>,
    pub margin_left_pt: Option<f32>,
    pub margin_right_pt: Option<f32>,
    pub space_before_pt: Option<f32>,
    pub space_after_pt: Option<f32>,
}

impl ParaSpec {
    /// True when no overrides are set (paragraph keeps the document's existing paraPr).
    pub fn is_empty(&self) -> bool {
        *self == ParaSpec::default()
    }

    /// Build the `ParaShape` this spec requests. Unset fields stay at `ParaShape::default()`
    /// (the serializer treats default-valued fields as "inherit from the base paraPr").
    pub fn to_para_shape(&self) -> ParaShape {
        let pt = |v: f32| (v * 100.0).round() as i32;
        let mut p = ParaShape::default();
        if let Some(a) = &self.align {
            p.align = match a.to_ascii_lowercase().as_str() {
                "left" => HorizontalAlign::Left,
                "right" => HorizontalAlign::Right,
                "center" => HorizontalAlign::Center,
                "distribute" => HorizontalAlign::Distribute,
                "distribute_space" | "divide" => HorizontalAlign::DistributeSpace,
                _ => HorizontalAlign::Justify,
            };
        }
        if let Some(ls) = self.line_spacing_pct {
            p.line_spacing_type = LineSpacingType::Percent;
            p.line_spacing_value = ls as i32;
        }
        if let Some(v) = self.indent_pt {
            p.indent = pt(v);
        }
        if let Some(v) = self.margin_left_pt {
            p.left_margin = pt(v);
        }
        if let Some(v) = self.margin_right_pt {
            p.right_margin = pt(v);
        }
        if let Some(v) = self.space_before_pt {
            p.space_before = pt(v);
        }
        if let Some(v) = self.space_after_pt {
            p.space_after = pt(v);
        }
        p
    }
}

/// Intern a `CharShape` into the doc's pool (dedup by value), returning its index. The HWPX
/// serializer turns each distinct non-default shape into a synthesized `<hh:charPr>`.
fn intern_char_shape(doc: &mut SemanticDoc, shape: CharShape) -> usize {
    if let Some(i) = doc.char_shapes.iter().position(|s| *s == shape) {
        return i;
    }
    doc.char_shapes.push(shape);
    doc.char_shapes.len() - 1
}

/// Intern a `ParaShape` (dedup by value) → index. Synthesized into `<hh:paraPr>` on export.
fn intern_para_shape(doc: &mut SemanticDoc, shape: ParaShape) -> usize {
    if let Some(i) = doc.para_shapes.iter().position(|s| *s == shape) {
        return i;
    }
    doc.para_shapes.push(shape);
    doc.para_shapes.len() - 1
}

fn section_mut(doc: &mut SemanticDoc, section: usize) -> Result<&mut Section> {
    doc.sections
        .get_mut(section)
        .ok_or_else(|| Error::Other(format!("section {section} out of range")))
}

/// Run `edit` on every addressed top-level paragraph whose `NodeId` is in `lo..=hi`, marking it
/// (and its owning section) dirty; errors if no paragraph matched.
///
/// `body_edit` controls structural-paragraph handling. `true` for ops that rebuild the run body
/// (SetCharPr) — those REFUSE a non-`simple` paragraph so structural content is never dropped.
/// `false` for ops that only patch the paragraph's open tag (SetParaPr/ApplyStyle), which are
/// byte-safe on a non-simple paragraph because the serializer keeps its body verbatim.
fn edit_paras_in_range(
    doc: &mut SemanticDoc,
    lo: u64,
    hi: u64,
    body_edit: bool,
    mut edit: impl FnMut(&mut Paragraph),
) -> Result<()> {
    let mut edited = 0usize;
    for sec in &mut doc.sections {
        let mut sec_touched = false;
        for b in &mut sec.blocks {
            let Block::Paragraph(p) = b else { continue };
            let Some(NodeId(id)) = p.id else { continue };
            if !(lo..=hi).contains(&id) {
                continue;
            }
            if body_edit && p.source.as_ref().is_some_and(|s| !s.simple) {
                return Err(Error::Other(format!(
                    "paragraph {id} has structural content and cannot be edited in place"
                )));
            }
            edit(p);
            p.dirty.mark();
            sec_touched = true;
            edited += 1;
        }
        if sec_touched {
            sec.dirty.mark();
        }
    }
    if edited == 0 {
        return Err(Error::Other(format!("no editable paragraph in node range {lo}..={hi}")));
    }
    Ok(())
}

/// Find the single top-level paragraph addressed by `node`, run `edit` on it, and (if the edit
/// reports a real change) mark it + its owning section dirty. Refuses a non-`simple` paragraph
/// (structural content) and errors if no paragraph carries that `NodeId`.
fn with_simple_para(
    doc: &mut SemanticDoc,
    node: NodeId,
    edit: impl FnOnce(&mut Paragraph) -> Result<bool>,
) -> Result<()> {
    // Locate the owning section first (immutable scan) so the mutable edit touches one section and
    // the `FnOnce` is provably called at most once.
    let mut sec_idx = None;
    'scan: for (si, sec) in doc.sections.iter().enumerate() {
        for b in &sec.blocks {
            if let Block::Paragraph(p) = b {
                if p.id == Some(node) {
                    if p.source.as_ref().is_some_and(|s| !s.simple) {
                        return Err(Error::Other(format!(
                            "paragraph {} has structural content and cannot be edited in place",
                            node.0
                        )));
                    }
                    sec_idx = Some(si);
                    break 'scan;
                }
            }
        }
    }
    let si = sec_idx.ok_or_else(|| Error::Other(format!("no editable paragraph with node id {}", node.0)))?;
    let sec = &mut doc.sections[si];
    let mut changed = false;
    for b in &mut sec.blocks {
        if let Block::Paragraph(p) = b {
            if p.id == Some(node) {
                changed = edit(p)?;
                if changed {
                    p.dirty.mark();
                }
                break;
            }
        }
    }
    if changed {
        sec.dirty.mark();
    }
    Ok(())
}

/// Char (Unicode-scalar) length of a run's text content (bytes would split multibyte Korean).
fn run_char_len(r: &Run) -> usize {
    r.content
        .iter()
        .map(|i| match i {
            Inline::Text(t) => t.chars().count(),
            _ => 0,
        })
        .sum()
}

/// A run's concatenated text (parsed simple runs hold exactly one `Inline::Text`).
fn run_text(r: &Run) -> String {
    r.content
        .iter()
        .filter_map(|i| match i {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

/// Split `run` at char offset `rel` into (left, right); both inherit char_shape + char_ref so
/// unselected formatting survives. `rel→byte` via `char_indices` keeps the cut on a codepoint.
fn split_run_at(run: &Run, rel: usize) -> (Run, Run) {
    let t = run_text(run);
    let byte = t.char_indices().nth(rel).map(|(b, _)| b).unwrap_or(t.len());
    let mk = |s: &str| Run { char_shape: run.char_shape, char_ref: run.char_ref.clone(), content: vec![Inline::Text(s.to_string())] };
    (mk(&t[..byte]), mk(&t[byte..]))
}

/// If absolute char offset `off` falls STRICTLY inside a run, return `(run_idx, rel_char)` to split
/// there; `None` if `off` already coincides with a run edge (or the paragraph end) — no split.
fn locate_split(runs: &[Run], off: usize) -> Option<(usize, usize)> {
    let mut cs = 0;
    for (i, r) in runs.iter().enumerate() {
        let len = run_char_len(r);
        if len > 0 && off > cs && off < cs + len {
            return Some((i, off - cs));
        }
        cs += len;
    }
    None
}

/// Split `runs` so the half-open char range `[start, end)` is covered by whole runs, returning the
/// `[lo, hi)` run-index window to re-format. Splits at `end` first then `start` (descending offset
/// keeps the start index valid). Boundary-adjacent EMPTY runs are left outside `[lo, hi)` so their
/// `charPrIDRef` never churns. Errors only if a boundary falls inside a non-text run (unreachable
/// for parsed simple paragraphs; guards op-built multi-inline runs).
fn split_runs_for_range(runs: &mut Vec<Run>, start: usize, end: usize) -> Result<(usize, usize)> {
    let boundary_in_nontext = |off: usize| -> bool {
        let mut cs = 0;
        for r in runs.iter() {
            let len = run_char_len(r);
            if off > cs && off < cs + len {
                return r.content.iter().any(|i| !matches!(i, Inline::Text(_)));
            }
            cs += len;
        }
        false
    };
    if boundary_in_nontext(start) || boundary_in_nontext(end) {
        return Err(Error::Other("selection boundary falls inside a non-text run".into()));
    }

    if let Some((i, rel)) = locate_split(runs, end) {
        let (l, r) = split_run_at(&runs[i], rel);
        runs[i] = l;
        runs.insert(i + 1, r);
    }
    if let Some((i, rel)) = locate_split(runs, start) {
        let (l, r) = split_run_at(&runs[i], rel);
        runs[i] = l;
        runs.insert(i + 1, r);
    }

    let mut cs = 0;
    let mut lo: Option<usize> = None;
    let mut hi = 0;
    for (i, r) in runs.iter().enumerate() {
        let len = run_char_len(r);
        let ce = cs + len;
        if cs >= start && ce <= end && len > 0 {
            lo.get_or_insert(i);
            hi = i + 1;
        }
        cs = ce;
    }
    Ok(match lo {
        Some(l) => (l, hi),
        None => (0, 0),
    })
}

/// Resolve a paragraph-scoped char offset to `(run_idx, byte_offset_within_run)`. A boundary
/// attaches LEFT (to the run it ends). Errors if `char_off` is past the paragraph's text (never
/// clamps into another paragraph). Assumes ≥1 run (callers ensure it for an empty paragraph).
fn resolve_caret(p: &Paragraph, char_off: usize) -> Result<(usize, usize)> {
    let total: usize = p.runs.iter().map(run_char_len).sum();
    if char_off > total {
        return Err(Error::Other(format!("caret offset {char_off} past paragraph end {total}")));
    }
    let mut cs = 0;
    for (i, r) in p.runs.iter().enumerate() {
        let len = run_char_len(r);
        if char_off <= cs + len {
            let delta = char_off - cs;
            let t = run_text(r);
            let byte = t.char_indices().nth(delta).map(|(b, _)| b).unwrap_or(t.len());
            return Ok((i, byte));
        }
        cs += len;
    }
    // char_off == total with trailing empty runs (or an empty run list) → end of the last run.
    let last = p.runs.len().saturating_sub(1);
    let byte = p.runs.get(last).map(run_text).map(|t| t.len()).unwrap_or(0);
    Ok((last, byte))
}

/// Strip characters illegal in XML 1.0 text — NUL and C0 controls except tab/newline/CR — so a
/// user-supplied `InsertText` string can never produce malformed OWPML.
fn sanitize_text(s: &str) -> String {
    s.chars().filter(|&c| c == '\t' || c == '\n' || c == '\r' || c >= ' ').collect()
}

/// Delete the half-open char span between two resolved carets, rebuilding the affected runs (each
/// re-normalized to a single `Inline::Text`). Truncated boundary runs are KEPT even if now empty
/// (preserves distinct per-run formatting context); fully-covered middle runs are removed.
fn delete_run_range(runs: &mut Vec<Run>, ri0: usize, b0: usize, ri1: usize, b1: usize) {
    if ri0 == ri1 {
        let t = run_text(&runs[ri0]);
        runs[ri0].content = vec![Inline::Text(format!("{}{}", &t[..b0], &t[b1..]))];
        return;
    }
    let head = run_text(&runs[ri0])[..b0].to_string();
    runs[ri0].content = vec![Inline::Text(head)];
    let tail = run_text(&runs[ri1])[b1..].to_string();
    runs[ri1].content = vec![Inline::Text(tail)];
    runs.drain(ri0 + 1..ri1); // drop the fully-covered middle runs
}

/// Apply an op to the document, marking touched nodes dirty (drives dirty-only export).
/// MVP: `AppendParagraph` (round-trip-safe append). Other ops land as the editor grows.
pub fn apply(doc: &mut SemanticDoc, op: &Op) -> Result<()> {
    match op {
        Op::AppendParagraph { section, text } => {
            let plain = intern_char_shape(doc, CharShape::default());
            let sec = section_mut(doc, *section)?;
            sec.blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run { char_shape: plain, content: vec![Inline::Text(text.clone())], ..Default::default() }],
                dirty: Dirty(true),
                ..Default::default()
            }));
            sec.dirty.mark();
            Ok(())
        }
        Op::AppendRichParagraph { section, runs, para } => {
            // Intern each run's CharShape + the paragraph's ParaShape first (mutable borrow), then build.
            let interned: Vec<(usize, String)> = runs
                .iter()
                .map(|r| (intern_char_shape(doc, r.to_char_shape()), r.text.clone()))
                .collect();
            let para_shape = intern_para_shape(doc, para.to_para_shape());
            let style_name = para.style.clone().filter(|s| !s.trim().is_empty());
            let sec = section_mut(doc, *section)?;
            let para_runs = interned
                .into_iter()
                .map(|(char_shape, text)| Run { char_shape, content: vec![Inline::Text(text)], ..Default::default() })
                .collect();
            sec.blocks.push(Block::Paragraph(Paragraph {
                runs: para_runs,
                para_shape,
                style_name,
                dirty: Dirty(true),
                ..Default::default()
            }));
            sec.dirty.mark();
            Ok(())
        }
        Op::AppendTable { section, header, rows } => {
            let cols = header.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
            if cols == 0 {
                return Err(Error::Other("AppendTable needs at least one column".into()));
            }
            // Row 0 = header (bold cells); subsequent rows = body (default).
            let mut grid: Vec<Vec<String>> = Vec::new();
            if !header.is_empty() {
                grid.push(header.clone());
            }
            grid.extend(rows.iter().cloned());
            let header_rows = if header.is_empty() { 0 } else { 1 };
            let bold_shape = intern_char_shape(doc, CharShape { bold: true, ..Default::default() });
            let plain_shape = intern_char_shape(doc, CharShape::default());

            let mut cells = Vec::new();
            for (r, row) in grid.iter().enumerate() {
                for c in 0..cols {
                    let text = row.get(c).cloned().unwrap_or_default();
                    let char_shape = if r < header_rows { bold_shape } else { plain_shape };
                    cells.push(Cell {
                        row: r,
                        col: c,
                        blocks: vec![Block::Paragraph(Paragraph {
                            runs: vec![Run { char_shape, content: vec![Inline::Text(text)], ..Default::default() }],
                            dirty: Dirty(true),
                            ..Default::default()
                        })],
                        dirty: Dirty(true),
                        ..Default::default()
                    });
                }
            }
            let sec = section_mut(doc, *section)?;
            sec.blocks.push(Block::Table(Table {
                rows: grid.len(),
                cols,
                cells,
                dirty: Dirty(true),
                ..Default::default()
            }));
            sec.dirty.mark();
            Ok(())
        }
        Op::AppendRichTable { section, rows } => {
            let table = build_rich_table(doc, rows)?;
            let sec = section_mut(doc, *section)?;
            sec.blocks.push(Block::Table(table));
            sec.dirty.mark();
            Ok(())
        }
        Op::SetPageLayout { section, orientation, margins_mm } => {
            let sec = section_mut(doc, *section)?;
            let mut page = sec.page;
            if let Some(o) = orientation {
                // A4: portrait 210×297mm, landscape swaps width/height (the real page-shape driver).
                const A4_W: i32 = 59528;
                const A4_H: i32 = 84188;
                if o.eq_ignore_ascii_case("landscape") {
                    page.landscape = true;
                    page.width = A4_H;
                    page.height = A4_W;
                } else {
                    page.landscape = false;
                    page.width = A4_W;
                    page.height = A4_H;
                }
            }
            if let Some(m) = margins_mm {
                let mm = |v: f32| (v * 7200.0 / 25.4).round() as i32; // mm → HWPUNIT
                page.margin_left = mm(m.left);
                page.margin_right = mm(m.right);
                page.margin_top = mm(m.top);
                page.margin_bottom = mm(m.bottom);
            }
            sec.page = page;
            sec.page_edited = true;
            sec.dirty.mark();
            Ok(())
        }
        Op::SetCharPr { range, shape } => {
            // IN-PLACE edit (#003-full): apply `shape` to every run of each addressed top-level
            // paragraph (paragraph-granular), re-formatting EXISTING content. Refuses paragraphs
            // that aren't re-emittable (structural children) so no edit is silently lost.
            let idx = intern_char_shape(doc, shape.clone());
            edit_paras_in_range(doc, range.start.0, range.end.0, true, |p| {
                for run in &mut p.runs {
                    run.char_shape = idx;
                }
            })
        }
        Op::InsertText { at, text } => {
            // IN-PLACE text insert (#003-full) at a char-offset Caret inside one simple paragraph.
            let clean = sanitize_text(text);
            with_simple_para(doc, at.node, |p| {
                if p.runs.is_empty() {
                    p.runs.push(Run { content: vec![Inline::Text(String::new())], ..Default::default() });
                }
                let (ri, boff) = resolve_caret(p, at.offset)?;
                if clean.is_empty() {
                    return Ok(false); // nothing to insert (empty or fully-sanitized) → no dirty
                }
                let s = run_text(&p.runs[ri]);
                p.runs[ri].content = vec![Inline::Text(format!("{}{clean}{}", &s[..boff], &s[boff..]))];
                Ok(true)
            })
        }
        Op::DeleteRange { start, end } => {
            // IN-PLACE delete (#003-full) of a char span within one simple paragraph.
            if start.node != end.node {
                return Err(Error::Other("DeleteRange must stay within one paragraph".into()));
            }
            if start.offset > end.offset {
                return Err(Error::Other(format!(
                    "DeleteRange: start {} after end {}",
                    start.offset, end.offset
                )));
            }
            if start.offset == end.offset {
                return Ok(()); // empty range, no-op
            }
            let (s_off, e_off) = (start.offset, end.offset);
            with_simple_para(doc, start.node, |p| {
                let (ri0, b0) = resolve_caret(p, s_off)?;
                let (ri1, b1) = resolve_caret(p, e_off)?;
                delete_run_range(&mut p.runs, ri0, b0, ri1, b1);
                Ok(true)
            })
        }
        Op::SetRunCharPr { para, start, end, shape } => {
            // RUN-LEVEL edit (#003-full): re-format only chars [start, end) of one paragraph by
            // splitting runs at those boundaries. Char offsets (not bytes) keep Korean intact.
            if start > end {
                return Err(Error::Other(format!("SetRunCharPr: start {start} > end {end}")));
            }
            if start == end {
                return Ok(()); // empty selection: no-op, no dirty
            }
            let idx = intern_char_shape(doc, shape.clone());
            let (start, end) = (*start, *end);
            with_simple_para(doc, *para, |p| {
                let total: usize = p.runs.iter().map(run_char_len).sum();
                let end = end.min(total);
                if start >= end {
                    return Ok(false); // selection past text end → nothing to format
                }
                let (lo, hi) = split_runs_for_range(&mut p.runs, start, end)?;
                for r in &mut p.runs[lo..hi] {
                    r.char_shape = idx;
                }
                Ok(lo < hi)
            })
        }
        Op::SetParaPr { range, shape } => {
            // IN-PLACE paragraph-shape edit (#003-full): re-point each addressed paragraph at a
            // synthesized paraPr (alignment/spacing/indent). The serializer patches paraPrIDRef in
            // the kept-verbatim `<hp:p …>` open tag.
            let idx = intern_para_shape(doc, shape.clone());
            // Open-tag-only edit (paraPrIDRef): byte-safe on structural paragraphs too.
            edit_paras_in_range(doc, range.start.0, range.end.0, false, |p| p.para_shape = idx)
        }
        Op::ApplyStyle { range, style } => {
            // IN-PLACE named-style application (#003-full): set the paragraph's requested style
            // name; the serializer resolves it to a styleIDRef (+ the style's paraPr) on export.
            let name = style.trim();
            if name.is_empty() {
                return Err(Error::Other("ApplyStyle needs a non-empty style name".into()));
            }
            let name = name.to_string();
            // Open-tag-only edit (styleIDRef + the style's paraPrIDRef): byte-safe on structural paras.
            edit_paras_in_range(doc, range.start.0, range.end.0, false, |p| {
                p.style_name = Some(name.clone());
            })
        }
        Op::InsertParagraphAt { section, index, runs, para } => {
            let interned: Vec<(usize, String)> = runs
                .iter()
                .map(|r| (intern_char_shape(doc, r.to_char_shape()), r.text.clone()))
                .collect();
            let para_shape = intern_para_shape(doc, para.to_para_shape());
            let style_name = para.style.clone().filter(|s| !s.trim().is_empty());
            let sec = section_mut(doc, *section)?;
            let at = block_insert_index(sec, *index)?;
            let para_runs = interned
                .into_iter()
                .map(|(char_shape, text)| Run { char_shape, content: vec![Inline::Text(text)], ..Default::default() })
                .collect();
            sec.blocks.insert(at, Block::Paragraph(Paragraph {
                runs: para_runs,
                para_shape,
                style_name,
                dirty: Dirty(true),
                ..Default::default()
            }));
            sec.dirty.mark();
            Ok(())
        }
        Op::InsertTableAt { section, index, rows } => {
            let table = build_rich_table(doc, rows)?;
            let sec = section_mut(doc, *section)?;
            let at = block_insert_index(sec, *index)?;
            sec.blocks.insert(at, Block::Table(table));
            sec.dirty.mark();
            Ok(())
        }
        Op::InsertImageAt { section, index, bytes, kind, width, height } => {
            if bytes.is_empty() {
                return Err(Error::Other("InsertImageAt: image bytes are empty".into()));
            }
            // A stable, collision-free bin_ref: the next free "imgN" not already in the store.
            let bin_ref = {
                let mut n = doc.bin_data.len() + 1;
                while doc.bin_data.iter().any(|b| b.bin_ref == format!("img{n}")) {
                    n += 1;
                }
                format!("img{n}")
            };
            doc.bin_data.push(BinData { bin_ref: bin_ref.clone(), bytes: bytes.clone(), kind: kind.clone() });
            let plain = intern_char_shape(doc, CharShape::default());
            let sec = section_mut(doc, *section)?;
            let at = block_insert_index(sec, *index)?;
            sec.blocks.insert(at, Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: plain,
                    content: vec![Inline::Image(ImageRef { bin_ref, width: *width, height: *height })],
                    ..Default::default()
                }],
                dirty: Dirty(true),
                ..Default::default()
            }));
            sec.dirty.mark();
            Ok(())
        }
        Op::DeleteBlock { section, index } => {
            let sec = section_mut(doc, *section)?;
            if *index >= sec.blocks.len() {
                return Err(Error::Other(format!(
                    "DeleteBlock: block index {index} out of range (section has {} blocks)",
                    sec.blocks.len()
                )));
            }
            sec.blocks.remove(*index);
            sec.dirty.mark();
            Ok(())
        }
        Op::MoveBlock { section, from, to } => {
            let sec = section_mut(doc, *section)?;
            let len = sec.blocks.len();
            if *from >= len {
                return Err(Error::Other(format!(
                    "MoveBlock: from index {from} out of range (section has {len} blocks)"
                )));
            }
            // `to` addresses an insertion slot over the ORIGINAL list (0..=len): `to == len` appends.
            if *to > len {
                return Err(Error::Other(format!(
                    "MoveBlock: to index {to} out of range (section has {len} blocks)"
                )));
            }
            if from == to {
                return Ok(()); // no-op: don't churn dirty flags
            }
            let block = sec.blocks.remove(*from);
            // Removing `from` shifts every later block left by one, so a target past it rebases down.
            let dest = if *to > *from { *to - 1 } else { *to };
            sec.blocks.insert(dest, block);
            sec.dirty.mark();
            Ok(())
        }
        Op::SetImageSize { section, index, width, height } => {
            if *width <= 0 || *height <= 0 {
                return Err(Error::Other(format!(
                    "SetImageSize: width/height must be positive (got {width}×{height})"
                )));
            }
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("SetImageSize: block index {index} out of range"))
            })?;
            let Block::Paragraph(p) = block else {
                return Err(Error::Other(format!("SetImageSize: block {index} is not a paragraph")));
            };
            // Resize the FIRST image inline of the paragraph (matches place_doc, which anchors the
            // paragraph's image as the PlacedImage the overlay was drawn over).
            let img = p
                .runs
                .iter_mut()
                .flat_map(|r| r.content.iter_mut())
                .find_map(|i| if let Inline::Image(img) = i { Some(img) } else { None })
                .ok_or_else(|| Error::Other(format!("SetImageSize: block {index} has no image")))?;
            img.width = *width;
            img.height = *height;
            p.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::SetTableCellShade { section, index, sel, shade } => {
            let color = match shade {
                Some(s) => Some(Color::from_hex(s).ok_or_else(|| {
                    Error::Other(format!("SetTableCellShade: bad shade color {s:?} (want #RRGGBB)"))
                })?),
                None => None,
            };
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("SetTableCellShade: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("SetTableCellShade: block {index} is not a table")));
            };
            let mut hit = 0usize;
            for cell in &mut t.cells {
                if !cell.active {
                    continue;
                }
                let (r0, c0) = (cell.row, cell.col);
                let (r1, c1) = (r0 + cell.row_span.max(1), c0 + cell.col_span.max(1));
                let pick = match *sel {
                    CellSel::Col(c) => c0 <= c && c < c1,
                    CellSel::Row(r) => r0 <= r && r < r1,
                    CellSel::Cell(r, c) => r0 == r && c0 == c,
                    CellSel::All => true,
                };
                if pick {
                    cell.shade_color = color;
                    cell.dirty.mark();
                    hit += 1;
                }
            }
            if hit == 0 {
                return Err(Error::Other("SetTableCellShade: selector matched no cells".into()));
            }
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::SetTableCell { section, index, row, col, runs } => {
            // Intern each run's CharShape first (mutable borrow on `doc`), then rebuild the cell's
            // body — mirrors AppendRichParagraph's intern-then-build ordering.
            let interned: Vec<(usize, String)> = runs
                .iter()
                .map(|r| (intern_char_shape(doc, r.to_char_shape()), r.text.clone()))
                .collect();
            let plain = intern_char_shape(doc, CharShape::default());
            let (row, col) = (*row, *col);
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("SetTableCell: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("SetTableCell: block {index} is not a table")));
            };
            // The active cell anchored exactly at (row, col) — same as CellSel::Cell.
            let cell = t.cells.iter_mut().find(|c| c.active && c.row == row && c.col == col).ok_or_else(|| {
                Error::Other(format!("SetTableCell: no active cell at (row {row}, col {col})"))
            })?;
            // Preserve the cell's CURRENT run style for a PLAIN (unstyled) text edit — so replacing the
            // text of a blue/italic template cell keeps its look instead of resetting to black-plain.
            // A run that carried explicit styling (interned to something other than the default `plain`)
            // overrides as before; only default-styled runs adopt the existing shape.
            let existing_shape = cell.blocks.iter().find_map(|b| match b {
                Block::Paragraph(p) => p.runs.first().map(|r| r.char_shape),
                _ => None,
            });
            // Preserve the cell's existing paragraph ALIGNMENT (para_shape) too — gov-doc cells are
            // center-aligned; without this a refilled cell reset to the default (left) and read as
            // "정렬 안 맞음" next to its centered siblings.
            let existing_para = cell.blocks.iter().find_map(|b| match b {
                Block::Paragraph(p) => Some(p.para_shape),
                _ => None,
            }).unwrap_or(0);
            let resolve_shape = |cs: usize| match existing_shape {
                Some(prev) if cs == plain => prev,
                _ => cs,
            };
            let para_runs = if interned.is_empty() {
                // An empty cell still needs one (empty) run so it round-trips/re-emits cleanly.
                vec![Run { char_shape: existing_shape.unwrap_or(plain), content: vec![Inline::Text(String::new())], ..Default::default() }]
            } else {
                interned
                    .into_iter()
                    .map(|(char_shape, text)| Run { char_shape: resolve_shape(char_shape), content: vec![Inline::Text(text)], ..Default::default() })
                    .collect()
            };
            cell.blocks = vec![Block::Paragraph(Paragraph {
                runs: para_runs,
                para_shape: existing_para,
                dirty: Dirty(true),
                ..Default::default()
            })];
            cell.dirty.mark();
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::TableInsertRows { section, index, at, rows } => {
            if rows.is_empty() {
                return Err(Error::Other("TableInsertRows: no rows to insert".into()));
            }
            // Build the new cells (interning shades/shapes) BEFORE the mutable table borrow.
            let new_cells = build_rich_table(doc, rows)?.cells;
            let n = rows.len();
            let at = *at;
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("TableInsertRows: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("TableInsertRows: block {index} is not a table")));
            };
            if at > t.rows {
                return Err(Error::Other(format!(
                    "TableInsertRows: row {at} out of range (table has {} rows)",
                    t.rows
                )));
            }
            // Shift every existing cell at or below the insertion row down by N (keeps merges sane).
            for c in &mut t.cells {
                if c.row >= at {
                    c.row += n;
                    c.dirty.mark();
                }
            }
            // Rebase the freshly-built rows (which start at row 0) to begin at `at`, then add them.
            for mut c in new_cells {
                c.row += at;
                t.cells.push(c);
            }
            t.rows += n;
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::TableAppendEmptyRow { section, index } => {
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("TableAppendEmptyRow: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("TableAppendEmptyRow: block {index} is not a table")));
            };
            if t.rows == 0 || t.cols == 0 {
                return Err(Error::Other("TableAppendEmptyRow: empty table".into()));
            }
            let at = t.rows;
            let ncols = t.cols;
            // Clone the LAST anchored row's cells so the new row matches the table's column structure
            // (col positions + col_span + borders), blanking the text + shade + diagonal. This keeps a
            // merged-column table (보유역량 spans 3) from collapsing to a uniform `cols`-cell grid.
            let last = t.cells.iter().filter(|c| c.active).map(|c| c.row).max().unwrap_or(0);
            let template: Vec<Cell> = t.cells.iter().filter(|c| c.active && c.row == last).cloned().collect();
            // An empty body paragraph carrying the body cell's char/para shape (so typing inherits the look).
            let empty_para = |cs: usize, ps: usize| vec![Block::Paragraph(Paragraph {
                runs: vec![Run { char_shape: cs, content: vec![Inline::Text(String::new())], ..Default::default() }],
                para_shape: ps,
                dirty: Dirty(true),
                ..Default::default()
            })];
            let mut covered = vec![false; ncols];
            let mut new_cells: Vec<Cell> = Vec::new();
            for tc in template {
                if tc.col >= ncols {
                    continue;
                }
                let cspan = tc.col_span.max(1).min(ncols - tc.col);
                for dc in 0..cspan {
                    covered[tc.col + dc] = true;
                }
                let (cs, ps) = tc.blocks.iter().find_map(|b| match b {
                    Block::Paragraph(p) => Some((p.runs.first().map(|r| r.char_shape).unwrap_or(0), p.para_shape)),
                    _ => None,
                }).unwrap_or((0, 0));
                let blocks = empty_para(cs, ps);
                new_cells.push(Cell {
                    row: at,
                    col: tc.col,
                    col_span: cspan,
                    row_span: 1,    // a new appended row is a single row, even if the template cell spanned
                    blocks,
                    shade_color: None, // fresh body row — don't copy a header tint
                    diagonal: None,    // …or a banner/N-A slash
                    dirty: Dirty(true),
                    ..tc
                });
            }
            // Fill any column NOT covered by the template — e.g. a vertical merge from an earlier row
            // crosses the last row, so that column has no origin cell at `last`. Without this the new
            // row would have a hole (the vertical analogue of the bug we're fixing).
            for col in 0..ncols {
                if !covered[col] {
                    new_cells.push(Cell { row: at, col, blocks: empty_para(0, 0), dirty: Dirty(true), ..Default::default() });
                }
            }
            for c in new_cells {
                t.cells.push(c);
            }
            t.rows += 1;
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::SetParagraphText { section, block, text } => {
            let sec = section_mut(doc, *section)?;
            let blk = sec.blocks.get_mut(*block).ok_or_else(|| {
                Error::Other(format!("SetParagraphText: block {block} out of range"))
            })?;
            let Block::Paragraph(p) = blk else {
                return Err(Error::Other(format!("SetParagraphText: block {block} is not a paragraph")));
            };
            // Refuse a structural paragraph so we never silently flatten rich content — the UI surfaces
            // this and falls back to chat. "Structural" = the parser marked it non-simple (raw/complex
            // source) OR it carries any non-text inline (image/field/marker). A paragraph with no source
            // (freshly inserted) is treated as simple/editable.
            let simple = p.source.as_ref().map(|s| s.simple).unwrap_or(true);
            let has_nontext = p.runs.iter().any(|r| r.content.iter().any(|i| !matches!(i, Inline::Text(_))));
            if !simple || has_nontext {
                return Err(Error::Other(
                    "이 문단은 인라인 편집 대상이 아닙니다 (이미지/필드/복합 구조) — 채팅으로 편집하세요".into(),
                ));
            }
            // Preserve the first run's char shape + the paragraph's para shape (color/italic/alignment).
            let cs = p.runs.first().map(|r| r.char_shape).unwrap_or(0);
            p.runs = vec![Run { char_shape: cs, content: vec![Inline::Text(text.clone())], ..Default::default() }];
            p.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::SetTableColWidths { section, index, widths } => {
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("SetTableColWidths: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("SetTableColWidths: block {index} is not a table")));
            };
            if widths.len() != t.cols {
                return Err(Error::Other(format!(
                    "SetTableColWidths: expected {} widths, got {}", t.cols, widths.len()
                )));
            }
            if widths.iter().any(|&w| w <= 0) {
                return Err(Error::Other("SetTableColWidths: widths must be positive".into()));
            }
            t.col_widths = widths.clone();
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        Op::SetTableRowHeights { section, index, heights } => {
            let sec = section_mut(doc, *section)?;
            let block = sec.blocks.get_mut(*index).ok_or_else(|| {
                Error::Other(format!("SetTableRowHeights: block index {index} out of range"))
            })?;
            let Block::Table(t) = block else {
                return Err(Error::Other(format!("SetTableRowHeights: block {index} is not a table")));
            };
            if heights.len() != t.rows {
                return Err(Error::Other(format!(
                    "SetTableRowHeights: expected {} heights, got {}", t.rows, heights.len()
                )));
            }
            if heights.iter().any(|&h| h < 0) {
                return Err(Error::Other("SetTableRowHeights: heights must be non-negative".into()));
            }
            t.row_heights = heights.clone();
            t.dirty.mark();
            sec.dirty.mark();
            Ok(())
        }
        _ => Err(Error::NotImplemented(
            "op apply (MVP: Append*/SetPageLayout/Set{Char,Run,Para}Pr/ApplyStyle/Insert-Delete text/anchored Insert*At/DeleteBlock/MoveBlock/SetImageSize/SetTableCellShade/SetTableCell/TableInsertRows)",
        )),
    }
}

/// Build a rich table node from per-row cell specs (shared by `AppendRichTable`/`InsertTableAt`).
/// Cells use HTML-table coverage: each logical row lists only the *uncovered* cells.
fn build_rich_table(doc: &mut SemanticDoc, rows: &[Vec<CellSpec>]) -> Result<Table> {
    if rows.is_empty() {
        return Err(Error::Other("rich table needs at least one row".into()));
    }
    let bold = intern_char_shape(doc, CharShape { bold: true, ..Default::default() });
    let plain = intern_char_shape(doc, CharShape::default());
    let mut covered: std::collections::BTreeSet<(usize, usize)> = Default::default();
    let mut cells = Vec::new();
    let mut ncols = 0usize;
    for (r, row) in rows.iter().enumerate() {
        let mut c = 0usize;
        for spec in row {
            while covered.contains(&(r, c)) {
                c += 1;
            }
            let cs = spec.col_span.max(1);
            let rs = spec.row_span.max(1);
            for dr in 0..rs {
                for dc in 0..cs {
                    if dr != 0 || dc != 0 {
                        covered.insert((r + dr, c + dc));
                    }
                }
            }
            ncols = ncols.max(c + cs);
            cells.push(Cell {
                row: r,
                col: c,
                row_span: rs,
                col_span: cs,
                shade_color: spec.shade.as_deref().and_then(Color::from_hex),
                blocks: vec![Block::Paragraph(Paragraph {
                    runs: vec![Run {
                        char_shape: if spec.bold { bold } else { plain },
                        content: vec![Inline::Text(spec.text.clone())],
                        ..Default::default()
                    }],
                    dirty: Dirty(true),
                    ..Default::default()
                })],
                dirty: Dirty(true),
                ..Default::default()
            });
            c += cs;
        }
    }
    let cols = ncols.max(1);
    Ok(Table {
        rows: rows.len(),
        cols,
        // Explicit equal-split proportions so the renderer doesn't fall back to auto-layout (which
        // made inserted tables reflow to a different grid than the doc's parsed tables). The renderer
        // scales these to the body width, so equal values = equal columns.
        col_widths: vec![1; cols],
        // A small outer gap so a chat-inserted table doesn't abut the block above/below it (the
        // "tables stuck together" artifact). ~1mm; parsed tables carry their real 바깥 여백 instead.
        outer_margin_top: 280,
        outer_margin_bottom: 280,
        cells,
        dirty: Dirty(true),
        ..Default::default()
    })
}

/// Resolve a positional block-insert index, allowing `index == len` (append). Errors past the end.
fn block_insert_index(sec: &Section, index: usize) -> Result<usize> {
    if index > sec.blocks.len() {
        return Err(Error::Other(format!(
            "insert index {index} out of range (section has {} blocks)",
            sec.blocks.len()
        )));
    }
    Ok(index)
}

/// A document plus its undo/redo history — the **stateful** edit surface the UI/AI drive.
///
/// Undo is **snapshot-based**, not an inverse-op journal: each committed op clones the
/// PRE-mutation [`SemanticDoc`] onto the undo stack. `SemanticDoc: Clone` is a verified deep
/// copy (no `Rc`/`RefCell`/`Cow` anywhere in the model) that captures every node's dirty flag,
/// the interned `char_shapes`/`para_shapes` pools, and the verbatim `Provenance.raw` +
/// `Passthrough` byte buffers. Undoing back to the parsed state therefore restores the doc
/// bit-for-bit, so `serialize()` is byte-identical to no-edit (the round-trip invariant).
///
/// An inverse-op journal was rejected: `apply` grows the shape pools and overwrites per-run
/// `char_shape` without recording the prior values, and any node left `dirty=true` re-routes
/// through `reemit_paragraph` (which drops `linesegarray` and re-escapes text) — *not*
/// guaranteed byte-identical. Only a snapshot restores the clean node's verbatim ride.
pub struct EditSession {
    doc: SemanticDoc,
    undo: Vec<SemanticDoc>,
    redo: Vec<SemanticDoc>,
    /// Max retained undo snapshots (`0` = unbounded). Bounds memory: a snapshot deep-copies the
    /// whole package incl. the original `.hwpx` bytes held under `SOURCE_PART_TAG`.
    limit: usize,
    /// Monotonic mutation counter — bumped on every successful `do_op`/`do_ops`/`undo`/`redo`.
    /// Authoritative version signal for downstream caches (render/serialize): if `revision()` is
    /// unchanged, the document bytes are unchanged. Lives here because every mutation funnels
    /// through this type, so no caller can forget to bump it.
    rev: u64,
}

impl EditSession {
    /// Start a session over a freshly parsed (or built) document. Default history depth 100.
    pub fn new(doc: SemanticDoc) -> Self {
        EditSession { doc, undo: Vec::new(), redo: Vec::new(), limit: 100, rev: 0 }
    }

    /// Like [`EditSession::new`] but with an explicit history depth (`0` = unbounded).
    pub fn with_limit(doc: SemanticDoc, limit: usize) -> Self {
        EditSession { doc, undo: Vec::new(), redo: Vec::new(), limit, rev: 0 }
    }

    /// The live document (read-only) — feed to the serializer / renderer.
    pub fn doc(&self) -> &SemanticDoc {
        &self.doc
    }

    /// Monotonic revision of the live document — bumps on every applied/undone/redone change.
    /// A render or serialize cache can key on this: equal revision ⇒ identical document.
    pub fn revision(&self) -> u64 {
        self.rev
    }

    /// Consume the session, returning the live document.
    pub fn into_doc(self) -> SemanticDoc {
        self.doc
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Apply an op, committing a snapshot for undo. **Atomic**: on `Err` the document is restored
    /// to its pre-op state and no snapshot is pushed. This is load-bearing — `apply` interns the
    /// shape and may mark earlier in-range paragraphs dirty *before* it can `Err` on a later
    /// non-simple paragraph, so a non-atomic commit would leave an un-undoable partial mutation.
    pub fn do_op(&mut self, op: &Op) -> Result<()> {
        let snap = self.doc.clone();
        if let Err(e) = apply(&mut self.doc, op) {
            self.doc = snap; // restore-on-Err: discard the partial mutation
            return Err(e);
        }
        self.undo.push(snap);
        self.redo.clear(); // a new branch invalidates any redo future
        if self.limit != 0 && self.undo.len() > self.limit {
            self.undo.remove(0);
        }
        self.rev += 1;
        Ok(())
    }

    /// Apply several ops as ONE atomic, single-undo-unit change (e.g. committing an AI proposal so
    /// one `undo` reverts the whole edit). On any error the document is restored to its pre-batch
    /// state and no snapshot is pushed. An empty batch is a no-op.
    pub fn do_ops(&mut self, ops: &[Op]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        let snap = self.doc.clone();
        for op in ops {
            if let Err(e) = apply(&mut self.doc, op) {
                self.doc = snap; // roll the whole batch back
                return Err(e);
            }
        }
        self.undo.push(snap);
        self.redo.clear();
        if self.limit != 0 && self.undo.len() > self.limit {
            self.undo.remove(0);
        }
        self.rev += 1;
        Ok(())
    }

    /// Undo the last committed op (in-memory swap; emits no XML). Returns false if nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo.pop() else { return false };
        self.redo.push(std::mem::replace(&mut self.doc, prev));
        self.rev += 1;
        true
    }

    /// Redo the last undone op. Returns false if nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else { return false };
        self.undo.push(std::mem::replace(&mut self.doc, next));
        self.rev += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A simple, in-place-editable top-level paragraph carrying a NodeId and a one-run body.
    fn simple_para(id: u64, text: &str) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: vec![Run { char_ref: Some("0".into()), content: vec![Inline::Text(text.into())], ..Default::default() }],
            source: Some(ParaSource { span: (0, 0), simple: true, ..Default::default() }),
            ..Default::default()
        }
    }

    /// A non-simple (structural) top-level paragraph — every in-place op must refuse it.
    fn structural_para(id: u64, text: &str) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: vec![Run { content: vec![Inline::Text(text.into())], ..Default::default() }],
            source: Some(ParaSource { span: (0, 0), simple: false, ..Default::default() }),
            ..Default::default()
        }
    }

    fn doc_with(paras: Vec<Paragraph>) -> SemanticDoc {
        // Index 0 reserved as the default-shape sentinel, mirroring the real parser.
        let mut doc = SemanticDoc { char_shapes: vec![CharShape::default()], para_shapes: vec![ParaShape::default()], ..Default::default() };
        doc.sections.push(Section { blocks: paras.into_iter().map(Block::Paragraph).collect(), ..Default::default() });
        doc
    }

    fn bold() -> CharShape {
        CharShape { bold: true, ..Default::default() }
    }

    #[test]
    fn do_op_then_undo_redo_toggles_dirty() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가나다")]));
        assert!(!s.doc().any_dirty());
        assert!(!s.can_undo());

        s.do_op(&Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() }).unwrap();
        assert!(s.doc().any_dirty());
        assert!(s.can_undo() && !s.can_redo());

        assert!(s.undo());
        assert!(!s.doc().any_dirty()); // restored to the pristine parsed state
        assert!(!s.can_undo() && s.can_redo());

        assert!(s.redo());
        assert!(s.doc().any_dirty());
    }

    #[test]
    fn do_op_is_atomic_on_error() {
        // Range covers a simple para (1) AND a non-simple para (2). apply() marks para 1 dirty +
        // interns the shape BEFORE erroring on para 2 — do_op must roll the whole thing back.
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), structural_para(2, "나")]));
        let pools_before = s.doc().char_shapes.len();

        let err = s.do_op(&Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(2) }, shape: bold() });
        assert!(err.is_err());
        assert!(!s.doc().any_dirty(), "failed op must leave no dirty node");
        assert!(!s.can_undo(), "failed op must push no snapshot");
        assert_eq!(s.doc().char_shapes.len(), pools_before, "failed op must not grow the pool");
    }

    #[test]
    fn multi_op_undo_redo_is_lifo() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), simple_para(2, "나"), simple_para(3, "다")]));
        for id in 1..=3u64 {
            s.do_op(&Op::SetCharPr { range: Range { start: NodeId(id), end: NodeId(id) }, shape: bold() }).unwrap();
        }
        // Undo all three → pristine; redo all three → fully applied.
        assert!(s.undo() && s.undo() && s.undo());
        assert!(!s.doc().any_dirty());
        assert!(!s.undo()); // empty
        assert!(s.redo() && s.redo() && s.redo());
        assert!(s.doc().any_dirty());
    }

    #[test]
    fn revision_bumps_on_every_mutation_not_on_failure() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), structural_para(2, "나")]));
        assert_eq!(s.revision(), 0);
        s.do_op(&Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() }).unwrap();
        assert_eq!(s.revision(), 1);
        s.do_ops(&[Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() }]).unwrap();
        assert_eq!(s.revision(), 2);
        assert!(s.undo());
        assert_eq!(s.revision(), 3, "undo is a revision change");
        assert!(s.redo());
        assert_eq!(s.revision(), 4);
        // A FAILED op must not bump the revision (doc unchanged).
        let r = s.do_op(&Op::SetCharPr { range: Range { start: NodeId(2), end: NodeId(2) }, shape: bold() });
        assert!(r.is_err());
        assert_eq!(s.revision(), 4, "failed op leaves the revision unchanged");
    }

    #[test]
    fn do_ops_is_one_atomic_undo_unit() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), simple_para(2, "나")]));
        // A batch of 2 ops commits as a SINGLE undo step.
        s.do_ops(&[
            Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() },
            Op::SetCharPr { range: Range { start: NodeId(2), end: NodeId(2) }, shape: bold() },
        ])
        .unwrap();
        assert!(s.doc().any_dirty());
        assert!(s.undo());
        assert!(!s.doc().any_dirty(), "one undo reverts the whole batch");
        assert!(!s.undo(), "the batch was a single undo unit");
    }

    #[test]
    fn do_ops_rolls_back_the_whole_batch_on_error() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), structural_para(2, "나")]));
        let pools = s.doc().char_shapes.len();
        // Second op targets a non-simple para → the entire batch is rolled back.
        let r = s.do_ops(&[
            Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() },
            Op::SetCharPr { range: Range { start: NodeId(2), end: NodeId(2) }, shape: bold() },
        ]);
        assert!(r.is_err());
        assert!(!s.doc().any_dirty(), "failed batch leaves no dirty node");
        assert!(!s.can_undo(), "failed batch pushes no snapshot");
        assert_eq!(s.doc().char_shapes.len(), pools, "failed batch does not grow the pool");
    }

    #[test]
    fn new_op_after_undo_clears_redo() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "가"), simple_para(2, "나")]));
        s.do_op(&Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() }).unwrap();
        assert!(s.undo());
        assert!(s.can_redo());
        // A fresh op invalidates the redo future.
        s.do_op(&Op::SetCharPr { range: Range { start: NodeId(2), end: NodeId(2) }, shape: bold() }).unwrap();
        assert!(!s.can_redo());
    }

    #[test]
    fn history_limit_bounds_undo_depth() {
        let mut s = EditSession::with_limit(doc_with(vec![simple_para(1, "가")]), 2);
        for _ in 0..5 {
            s.do_op(&Op::SetCharPr { range: Range { start: NodeId(1), end: NodeId(1) }, shape: bold() }).unwrap();
        }
        // Only the last 2 snapshots are retained.
        assert!(s.undo() && s.undo());
        assert!(!s.undo());
    }

    // ---- Phase 4: SetRunCharPr run-splitting (Korean / UTF-8 safety) ----

    /// A multi-run paragraph from two Korean runs, char_ref Some("0"), char_shape 0.
    fn multirun_para(id: u64, parts: &[&str]) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: parts
                .iter()
                .map(|t| Run { char_ref: Some("0".into()), content: vec![Inline::Text((*t).into())], ..Default::default() })
                .collect(),
            source: Some(ParaSource { span: (0, 0), simple: true, ..Default::default() }),
            ..Default::default()
        }
    }

    fn run_texts(p: &Paragraph) -> Vec<String> {
        p.runs.iter().map(run_text).collect()
    }

    fn para_of(doc: &SemanticDoc, id: u64) -> &Paragraph {
        doc.sections[0]
            .blocks
            .iter()
            .find_map(|b| match b {
                Block::Paragraph(p) if p.id == Some(NodeId(id)) => Some(p),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn setruncharpr_splits_across_runs_on_codepoint_boundaries() {
        // '가나다'|'라마바' (chars 0..6); format [1,4) → '가' | '나다' | '라' | '마바'.
        let mut doc = doc_with(vec![multirun_para(1, &["가나다", "라마바"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 1, end: 4, shape: bold() }).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(run_texts(p), vec!["가", "나다", "라", "마바"]);
        // The two middle runs carry the interned bold shape; the outer two stay default + char_ref "0".
        let bold_idx = doc.char_shapes.iter().position(|s| *s == bold()).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(p.runs[1].char_shape, bold_idx);
        assert_eq!(p.runs[2].char_shape, bold_idx);
        assert_eq!(p.runs[0].char_shape, 0);
        assert_eq!(p.runs[3].char_shape, 0);
        assert_eq!(p.runs[0].char_ref.as_deref(), Some("0"));
        assert_eq!(p.runs[3].char_ref.as_deref(), Some("0"));
        // Concatenation is preserved exactly.
        assert_eq!(run_texts(p).concat(), "가나다라마바");
        assert!(p.dirty.is_dirty());
    }

    #[test]
    fn setruncharpr_mid_single_run_makes_three_runs() {
        let mut doc = doc_with(vec![multirun_para(1, &["가나다"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 1, end: 2, shape: bold() }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)), vec!["가", "나", "다"]);
    }

    #[test]
    fn setruncharpr_whole_run_keeps_run_count() {
        let mut doc = doc_with(vec![multirun_para(1, &["가나다", "라마바"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 0, end: 3, shape: bold() }).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(run_texts(p), vec!["가나다", "라마바"]);
        let bold_idx = doc.char_shapes.iter().position(|s| *s == bold()).unwrap();
        assert_eq!(para_of(&doc, 1).runs[0].char_shape, bold_idx);
        assert_eq!(para_of(&doc, 1).runs[1].char_shape, 0);
    }

    #[test]
    fn setruncharpr_empty_and_invalid_selections() {
        // start == end → Ok, no change, not dirty.
        let mut doc = doc_with(vec![multirun_para(1, &["가나"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 1, end: 1, shape: bold() }).unwrap();
        assert!(!para_of(&doc, 1).dirty.is_dirty());
        assert_eq!(run_texts(para_of(&doc, 1)), vec!["가나"]);

        // start > end → Err.
        let mut doc = doc_with(vec![multirun_para(1, &["가나"])]);
        assert!(apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 2, end: 1, shape: bold() }).is_err());

        // end past text end → clamps to the run end (formats the tail).
        let mut doc = doc_with(vec![multirun_para(1, &["가나"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 0, end: 99, shape: bold() }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)), vec!["가나"]);
    }

    #[test]
    fn setruncharpr_leading_empty_run_not_reformatted() {
        // ['', '가나'] format [0,1) → empty run stays default, '가' gets bold, '나' stays.
        let mut doc = doc_with(vec![multirun_para(1, &["", "가나"])]);
        apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 0, end: 1, shape: bold() }).unwrap();
        let bold_idx = doc.char_shapes.iter().position(|s| *s == bold()).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(run_texts(p).concat(), "가나");
        // The empty run (index 0) must NOT be reformatted.
        assert_eq!(p.runs[0].char_shape, 0, "empty boundary run keeps its shape");
        assert!(p.runs.iter().any(|r| r.char_shape == bold_idx), "the '가' got bold");
    }

    #[test]
    fn setruncharpr_refuses_non_simple_and_missing() {
        let mut doc = doc_with(vec![structural_para(1, "가나")]);
        assert!(apply(&mut doc, &Op::SetRunCharPr { para: NodeId(1), start: 0, end: 1, shape: bold() }).is_err());
        let mut doc = doc_with(vec![simple_para(1, "가")]);
        assert!(apply(&mut doc, &Op::SetRunCharPr { para: NodeId(99), start: 0, end: 1, shape: bold() }).is_err());
    }

    // ---- Phase 5: InsertText / DeleteRange (Caret char-offset addressing) ----

    fn caret(node: u64, offset: usize) -> Caret {
        Caret { node: NodeId(node), offset }
    }

    #[test]
    fn inserttext_mid_run_inherits_formatting_and_keeps_codepoints() {
        // '가나다' insert '한글' at char offset 2 → '가나한글다' in one run.
        let mut doc = doc_with(vec![simple_para(1, "가나다")]);
        apply(&mut doc, &Op::InsertText { at: caret(1, 2), text: "한글".into() }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)).concat(), "가나한글다");
        assert!(para_of(&doc, 1).dirty.is_dirty());
    }

    #[test]
    fn inserttext_across_run_boundary_attaches_left() {
        // ['가나','다라'] insert 'X' at offset 2 (the boundary) → attaches to the LEFT run.
        let mut doc = doc_with(vec![multirun_para(1, &["가나", "다라"])]);
        apply(&mut doc, &Op::InsertText { at: caret(1, 2), text: "X".into() }).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(run_texts(p).concat(), "가나X다라");
        assert_eq!(run_texts(p)[0], "가나X", "boundary insert lands in the left run");
    }

    #[test]
    fn inserttext_strips_control_chars() {
        let mut doc = doc_with(vec![simple_para(1, "가")]);
        apply(&mut doc, &Op::InsertText { at: caret(1, 1), text: "A\u{0}B\u{1}\tC".into() }).unwrap();
        // NUL and C0 (0x01) stripped; tab kept.
        assert_eq!(run_texts(para_of(&doc, 1)).concat(), "가AB\tC");
    }

    #[test]
    fn inserttext_into_empty_paragraph_and_out_of_range() {
        let mut doc = doc_with(vec![Paragraph {
            id: Some(NodeId(1)),
            runs: vec![],
            source: Some(ParaSource { span: (0, 0), simple: true, ..Default::default() }),
            ..Default::default()
        }]);
        apply(&mut doc, &Op::InsertText { at: caret(1, 0), text: "시작".into() }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)).concat(), "시작");

        // out-of-range offset errors (never clamps into another paragraph)
        let mut doc = doc_with(vec![simple_para(1, "가나")]);
        assert!(apply(&mut doc, &Op::InsertText { at: caret(1, 5), text: "X".into() }).is_err());
    }

    #[test]
    fn deleterange_within_and_across_runs() {
        // single run: '가나다라' delete [1,3) → '가라'
        let mut doc = doc_with(vec![simple_para(1, "가나다라")]);
        apply(&mut doc, &Op::DeleteRange { start: caret(1, 1), end: caret(1, 3) }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)).concat(), "가라");

        // across runs: ['가나','다라','마바'] delete [1,5) → '가' + '' + '바' = '가바'
        let mut doc = doc_with(vec![multirun_para(1, &["가나", "다라", "마바"])]);
        apply(&mut doc, &Op::DeleteRange { start: caret(1, 1), end: caret(1, 5) }).unwrap();
        assert_eq!(run_texts(para_of(&doc, 1)).concat(), "가바");
    }

    #[test]
    fn deleterange_full_paragraph_leaves_empty_run() {
        let mut doc = doc_with(vec![simple_para(1, "가나다")]);
        apply(&mut doc, &Op::DeleteRange { start: caret(1, 0), end: caret(1, 3) }).unwrap();
        let p = para_of(&doc, 1);
        assert_eq!(run_texts(p).concat(), "");
        assert!(!p.runs.is_empty(), "a run remains (re-emittable empty paragraph)");
    }

    #[test]
    fn deleterange_invalid_inputs() {
        // start > end
        let mut doc = doc_with(vec![simple_para(1, "가나다")]);
        assert!(apply(&mut doc, &Op::DeleteRange { start: caret(1, 2), end: caret(1, 1) }).is_err());
        // empty range = no-op (not dirty)
        let mut doc = doc_with(vec![simple_para(1, "가나다")]);
        apply(&mut doc, &Op::DeleteRange { start: caret(1, 1), end: caret(1, 1) }).unwrap();
        assert!(!para_of(&doc, 1).dirty.is_dirty());
        // cross-paragraph delete refused
        let mut doc = doc_with(vec![simple_para(1, "가"), simple_para(2, "나")]);
        assert!(apply(&mut doc, &Op::DeleteRange { start: caret(1, 0), end: caret(2, 1) }).is_err());
    }

    // ---- vibe-docs: anchored, positional edits ----

    fn run_spec(text: &str) -> RunSpec {
        RunSpec { text: text.into(), ..Default::default() }
    }

    /// Text of the i-th top-level paragraph block of section 0 (panics if it isn't a paragraph).
    fn block_para_text(doc: &SemanticDoc, i: usize) -> String {
        match &doc.sections[0].blocks[i] {
            Block::Paragraph(p) => run_texts(p).concat(),
            _ => panic!("block {i} is not a paragraph"),
        }
    }

    #[test]
    fn insert_paragraph_at_shifts_later_blocks_and_appends_at_len() {
        let mut doc = doc_with(vec![simple_para(1, "첫"), simple_para(2, "끝")]);
        // insert "목차" between them (index 1)
        apply(&mut doc, &Op::InsertParagraphAt {
            section: 0, index: 1, runs: vec![run_spec("목차")], para: ParaSpec::default(),
        }).unwrap();
        assert_eq!(block_para_text(&doc, 0), "첫");
        assert_eq!(block_para_text(&doc, 1), "목차");
        assert_eq!(block_para_text(&doc, 2), "끝");
        // index == len appends
        let n = doc.sections[0].blocks.len();
        apply(&mut doc, &Op::InsertParagraphAt {
            section: 0, index: n, runs: vec![run_spec("맨끝")], para: ParaSpec::default(),
        }).unwrap();
        assert_eq!(block_para_text(&doc, n), "맨끝");
        // past the end errors
        assert!(apply(&mut doc, &Op::InsertParagraphAt {
            section: 0, index: 999, runs: vec![run_spec("x")], para: ParaSpec::default(),
        }).is_err());
    }

    #[test]
    fn insert_table_at_anchor_after_table_of_contents() {
        // "목차 아래에 표 만들어줘": find the 목차 block, insert a table right after it.
        let mut doc = doc_with(vec![simple_para(1, "목차"), simple_para(2, "본문")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1,
            rows: vec![vec![cell("항목"), cell("내용")], vec![cell("A"), cell("B")]],
        }).unwrap();
        assert_eq!(block_para_text(&doc, 0), "목차");
        match &doc.sections[0].blocks[1] {
            Block::Table(t) => { assert_eq!((t.rows, t.cols), (2, 2)); }
            _ => panic!("expected a table after 목차"),
        }
        assert_eq!(block_para_text(&doc, 2), "본문");
    }

    #[test]
    fn inserted_table_has_explicit_col_widths_and_outer_margins() {
        // A chat-inserted table must carry explicit equal-split col_widths (so it doesn't reflow to a
        // different grid than the doc's parsed tables) and a small outer margin (so it doesn't abut
        // the neighbouring block). Regression for the "3 tables stuck together with weird borders".
        let mut doc = doc_with(vec![simple_para(1, "팀 구성")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1,
            rows: vec![vec![cell("번호"), cell("이름"), cell("역할"), cell("비고")]],
        }).unwrap();
        match &doc.sections[0].blocks[1] {
            Block::Table(t) => {
                assert_eq!(t.cols, 4);
                assert_eq!(t.col_widths.len(), t.cols, "col_widths has one entry per column");
                assert!(t.col_widths.iter().all(|&w| w > 0), "all column widths positive (no auto-layout fallback)");
                assert!(t.outer_margin_top > 0 && t.outer_margin_bottom > 0, "outer gap so it doesn't abut");
            }
            _ => panic!("expected a table"),
        }
    }

    #[test]
    fn insert_image_at_embeds_bindata_and_references_it() {
        let mut doc = doc_with(vec![simple_para(1, "여기")]);
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3];
        apply(&mut doc, &Op::InsertImageAt {
            section: 0, index: 1, bytes: png.clone(), kind: "png".into(), width: 1000, height: 800,
        }).unwrap();
        assert_eq!(doc.bin_data.len(), 1);
        assert_eq!(doc.bin_data[0].bytes, png);
        let bin_ref = doc.bin_data[0].bin_ref.clone();
        match &doc.sections[0].blocks[1] {
            Block::Paragraph(p) => match &p.runs[0].content[0] {
                Inline::Image(img) => {
                    assert_eq!(img.bin_ref, bin_ref);
                    assert_eq!((img.width, img.height), (1000, 800));
                }
                _ => panic!("expected an image inline"),
            },
            _ => panic!("expected an image paragraph"),
        }
        // empty bytes refused
        assert!(apply(&mut doc, &Op::InsertImageAt {
            section: 0, index: 1, bytes: vec![], kind: "png".into(), width: 1, height: 1,
        }).is_err());
    }

    #[test]
    fn delete_block_removes_and_bounds_check() {
        let mut doc = doc_with(vec![simple_para(1, "가"), simple_para(2, "나"), simple_para(3, "다")]);
        apply(&mut doc, &Op::DeleteBlock { section: 0, index: 1 }).unwrap();
        assert_eq!(doc.sections[0].blocks.len(), 2);
        assert_eq!(block_para_text(&doc, 0), "가");
        assert_eq!(block_para_text(&doc, 1), "다");
        assert!(apply(&mut doc, &Op::DeleteBlock { section: 0, index: 9 }).is_err());
    }

    #[test]
    fn move_block_reorders_forward_and_backward() {
        // [가,나,다,라] move block 0 → slot 2 (over the ORIGINAL list, i.e. before original idx 2 "다").
        // Remove 가 → [나,다,라]; the target rebases past the removed slot → 가 lands before 다 → [나,가,다,라].
        let mut doc = doc_with(vec![simple_para(1, "가"), simple_para(2, "나"), simple_para(3, "다"), simple_para(4, "라")]);
        apply(&mut doc, &Op::MoveBlock { section: 0, from: 0, to: 2 }).unwrap();
        assert_eq!(
            (0..4).map(|i| block_para_text(&doc, i)).collect::<Vec<_>>(),
            vec!["나", "가", "다", "라"],
        );
        // now [나,가,다,라]: move block 3 → slot 0 (backward) → 라 to the front → [라,나,가,다].
        apply(&mut doc, &Op::MoveBlock { section: 0, from: 3, to: 0 }).unwrap();
        assert_eq!(
            (0..4).map(|i| block_para_text(&doc, i)).collect::<Vec<_>>(),
            vec!["라", "나", "가", "다"],
        );
        // to == len appends to the end: move block 0 (라) to slot 4 → [나,가,다,라].
        apply(&mut doc, &Op::MoveBlock { section: 0, from: 0, to: 4 }).unwrap();
        assert_eq!(block_para_text(&doc, 3), "라");
        // bounds + no-op
        assert!(apply(&mut doc, &Op::MoveBlock { section: 0, from: 9, to: 0 }).is_err());
        assert!(apply(&mut doc, &Op::MoveBlock { section: 0, from: 0, to: 9 }).is_err());
    }

    #[test]
    fn move_block_is_one_undo_unit_and_restores_order() {
        // A table drag-to-move emits one MoveBlock; a single undo restores the original block order.
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "앞"), simple_para(2, "뒤")]));
        // Seed a table at the end (index 2), as its own undo step.
        s.do_op(&Op::InsertTableAt { section: 0, index: 2, rows: vec![vec![cell("표")]] }).unwrap();
        // Drag it to the front: MoveBlock 2 → 0 (one undo unit).
        s.do_op(&Op::MoveBlock { section: 0, from: 2, to: 0 }).unwrap();
        assert!(matches!(s.doc().sections[0].blocks[0], Block::Table(_)), "table moved to the front");
        assert_eq!(block_para_text(s.doc(), 1), "앞");
        // One undo puts the table back at the end.
        assert!(s.undo());
        assert!(matches!(s.doc().sections[0].blocks[2], Block::Table(_)), "undo restores the table at the end");
        assert_eq!(block_para_text(s.doc(), 0), "앞");
    }

    #[test]
    fn set_image_size_resizes_the_anchored_image() {
        // Insert an image, then resize it — the overlay's pointerup commit.
        let mut doc = doc_with(vec![simple_para(1, "여기")]);
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3];
        apply(&mut doc, &Op::InsertImageAt {
            section: 0, index: 1, bytes: png, kind: "png".into(), width: 1000, height: 800,
        }).unwrap();
        apply(&mut doc, &Op::SetImageSize { section: 0, index: 1, width: 2500, height: 1600 }).unwrap();
        match &doc.sections[0].blocks[1] {
            Block::Paragraph(p) => match &p.runs[0].content[0] {
                Inline::Image(img) => assert_eq!((img.width, img.height), (2500, 1600)),
                _ => panic!("expected an image inline"),
            },
            _ => panic!("expected an image paragraph"),
        }
        // Non-positive dims refused; a non-image block refused; out-of-range refused.
        assert!(apply(&mut doc, &Op::SetImageSize { section: 0, index: 1, width: 0, height: 10 }).is_err());
        assert!(apply(&mut doc, &Op::SetImageSize { section: 0, index: 0, width: 10, height: 10 }).is_err());
        assert!(apply(&mut doc, &Op::SetImageSize { section: 0, index: 9, width: 10, height: 10 }).is_err());
    }

    #[test]
    fn image_move_is_one_undo_unit_via_delete_plus_insert() {
        // "Move" = DeleteBlock + InsertImageAt batched in one do_ops → a single undoable op.
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "앞"), simple_para(2, "뒤")]));
        let png = vec![0x89, b'P', b'N', b'G', 9];
        // Seed an image at index 1, as its own undo step.
        s.do_op(&Op::InsertImageAt {
            section: 0, index: 1, bytes: png.clone(), kind: "png".into(), width: 900, height: 600,
        })
        .unwrap();
        let bin_before = s.doc().bin_data.len();
        // Move it to the end: delete then re-insert under ONE batch.
        s.do_ops(&[
            Op::DeleteBlock { section: 0, index: 1 },
            Op::InsertImageAt { section: 0, index: 2, bytes: png, kind: "png".into(), width: 900, height: 600 },
        ])
        .unwrap();
        // The image now sits at the new index.
        match &s.doc().sections[0].blocks[2] {
            Block::Paragraph(p) => assert!(matches!(p.runs[0].content[0], Inline::Image(_))),
            _ => panic!("expected the moved image paragraph"),
        }
        // One undo reverts the whole move (delete + insert), leaving the original placement.
        assert!(s.undo());
        match &s.doc().sections[0].blocks[1] {
            Block::Paragraph(p) => assert!(matches!(p.runs[0].content[0], Inline::Image(_))),
            _ => panic!("undo should restore the image at its original index"),
        }
        assert!(s.doc().bin_data.len() >= bin_before, "move re-embeds bytes; undo keeps the store sane");
    }

    #[test]
    fn set_table_column_shade_recolors_left_column_like_a_header() {
        // "표의 좌측열을 헤더 색상으로": shade column 0 of an existing table.
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1,
            rows: vec![vec![cell("구분"), cell("값1")], vec![cell("항목"), cell("값2")]],
        }).unwrap();
        apply(&mut doc, &Op::SetTableCellShade {
            section: 0, index: 1, sel: CellSel::Col(0), shade: Some("#D9E1F2".into()),
        }).unwrap();
        let want = Color::from_hex("#D9E1F2");
        if let Block::Table(t) = &doc.sections[0].blocks[1] {
            for c in &t.cells {
                if c.col == 0 {
                    assert_eq!(c.shade_color, want, "left column cell ({},{}) shaded", c.row, c.col);
                } else {
                    assert_eq!(c.shade_color, None, "right column untouched");
                }
            }
        } else {
            panic!("expected table");
        }
        // a selector that hits nothing errors; a non-table block errors
        assert!(apply(&mut doc, &Op::SetTableCellShade {
            section: 0, index: 1, sel: CellSel::Col(99), shade: None,
        }).is_err());
        assert!(apply(&mut doc, &Op::SetTableCellShade {
            section: 0, index: 0, sel: CellSel::All, shade: None,
        }).is_err());
    }

    /// Text of the active cell anchored at (row, col) of the table at section-0 block `bi`.
    fn cell_text(doc: &SemanticDoc, bi: usize, row: usize, col: usize) -> String {
        let Block::Table(t) = &doc.sections[0].blocks[bi] else { panic!("block {bi} is not a table") };
        let cell = t.cells.iter().find(|c| c.active && c.row == row && c.col == col).expect("active cell");
        cell.blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(run_texts(p).concat()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn set_table_cell_replaces_existing_cell_text() {
        // "마지막 표의 한 칸을 채워줘": fill an EXISTING cell rather than make a new table.
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1,
            rows: vec![vec![cell("항목"), cell("내용")], vec![cell(""), cell("")]],
        }).unwrap();
        apply(&mut doc, &Op::SetTableCell {
            section: 0, index: 1, row: 1, col: 0, runs: vec![run_spec("홍길동")],
        }).unwrap();
        apply(&mut doc, &Op::SetTableCell {
            section: 0, index: 1, row: 1, col: 1, runs: vec![run_spec("대표")],
        }).unwrap();
        assert_eq!(cell_text(&doc, 1, 1, 0), "홍길동");
        assert_eq!(cell_text(&doc, 1, 1, 1), "대표");
        // header row left untouched
        assert_eq!(cell_text(&doc, 1, 0, 0), "항목");
        // bad address / non-table errors
        assert!(apply(&mut doc, &Op::SetTableCell {
            section: 0, index: 1, row: 9, col: 9, runs: vec![run_spec("x")],
        }).is_err());
        assert!(apply(&mut doc, &Op::SetTableCell {
            section: 0, index: 0, row: 0, col: 0, runs: vec![run_spec("x")],
        }).is_err());
    }

    #[test]
    fn table_insert_rows_appends_three_body_rows() {
        // "마지막 표에 행 3개를 채워줘": append 3 rows to an existing 1-row table.
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![cell("번호"), cell("이름"), cell("역할")]],
        }).unwrap();
        let team = |a: &str, b: &str, c: &str| vec![cell(a), cell(b), cell(c)];
        apply(&mut doc, &Op::TableInsertRows {
            section: 0, index: 1, at: 1,
            rows: vec![team("1", "홍길동", "대표"), team("2", "김철수", "개발"), team("3", "이영희", "디자인")],
        }).unwrap();
        if let Block::Table(t) = &doc.sections[0].blocks[1] {
            assert_eq!(t.rows, 4, "1 header + 3 new body rows");
        } else {
            panic!("expected table");
        }
        assert_eq!(cell_text(&doc, 1, 0, 0), "번호"); // header survived
        assert_eq!(cell_text(&doc, 1, 1, 1), "홍길동");
        assert_eq!(cell_text(&doc, 1, 3, 2), "디자인");
    }

    #[test]
    fn table_insert_rows_in_the_middle_shifts_later_rows_down() {
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![cell("머리")], vec![cell("끝")]],
        }).unwrap();
        // insert one row at row 1, between header (row 0) and "끝" (was row 1 → now row 2).
        apply(&mut doc, &Op::TableInsertRows {
            section: 0, index: 1, at: 1, rows: vec![vec![cell("가운데")]],
        }).unwrap();
        if let Block::Table(t) = &doc.sections[0].blocks[1] {
            assert_eq!(t.rows, 3);
        } else {
            panic!("expected table");
        }
        assert_eq!(cell_text(&doc, 1, 0, 0), "머리");
        assert_eq!(cell_text(&doc, 1, 1, 0), "가운데");
        assert_eq!(cell_text(&doc, 1, 2, 0), "끝");
        // out-of-range row / non-table / empty rows error
        assert!(apply(&mut doc, &Op::TableInsertRows {
            section: 0, index: 1, at: 99, rows: vec![vec![cell("x")]],
        }).is_err());
        assert!(apply(&mut doc, &Op::TableInsertRows {
            section: 0, index: 0, at: 0, rows: vec![vec![cell("x")]],
        }).is_err());
        assert!(apply(&mut doc, &Op::TableInsertRows {
            section: 0, index: 1, at: 0, rows: vec![],
        }).is_err());
    }

    #[test]
    fn table_append_empty_row_replicates_merged_column_layout() {
        // The "+행" bug: a naive cols-single-cell row breaks a merged-column table. TableAppendEmptyRow
        // must clone the LAST row's column structure (here a 2-col-span cell), not a flat grid.
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        let wide = |t: &str| CellSpec { text: t.into(), col_span: 2, ..Default::default() };
        // Row 0: [A @col0 span1] [B @col1 span2] → 3 logical columns.
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![cell("A"), wide("B")]],
        }).unwrap();
        apply(&mut doc, &Op::TableAppendEmptyRow { section: 0, index: 1 }).unwrap();
        let Block::Table(t) = &doc.sections[0].blocks[1] else { panic!("expected table") };
        assert_eq!(t.rows, 2, "one appended row");
        let new_row: Vec<(usize, usize)> = t.cells.iter().filter(|c| c.row == 1).map(|c| (c.col, c.col_span)).collect();
        // The new row mirrors the template: a single cell at col0 and a 2-span cell at col1 — NOT three
        // single cells (which is what broke the rendered grid).
        assert!(new_row.contains(&(0, 1)) && new_row.contains(&(1, 2)), "new row replicates merged layout, got {new_row:?}");
        assert_eq!(new_row.len(), 2, "two cells, not a flat 3-cell grid");
        assert_eq!(cell_text(&doc, 1, 1, 0), "", "appended cells are empty");
    }

    #[test]
    fn table_append_empty_row_fills_columns_under_a_vertical_merge() {
        // A vertical merge from an earlier row crossing the LAST row leaves that column with no origin
        // cell at `last` — the appended row must still cover ALL columns (no hole).
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        let tall = |t: &str| CellSpec { text: t.into(), row_span: 2, ..Default::default() };
        // Row 0: [L spans rows 0-1 @col0] [R0 @col1]; Row 1: [R1 @col1] (col0 covered by L's row_span).
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![tall("L"), cell("R0")], vec![cell("R1")]],
        }).unwrap();
        apply(&mut doc, &Op::TableAppendEmptyRow { section: 0, index: 1 }).unwrap();
        let Block::Table(t) = &doc.sections[0].blocks[1] else { panic!("expected table") };
        assert_eq!(t.rows, 3);
        let new_cols: std::collections::BTreeSet<usize> = t.cells.iter().filter(|c| c.active && c.row == 2).map(|c| c.col).collect();
        assert!(new_cols.contains(&0) && new_cols.contains(&1), "appended row covers BOTH columns (no hole), got {new_cols:?}");
    }

    #[test]
    fn set_table_col_widths_sets_widths_and_validates_length() {
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![cell("a"), cell("b"), cell("c")]],
        }).unwrap();
        // Correct length sets the proportions.
        apply(&mut doc, &Op::SetTableColWidths { section: 0, index: 1, widths: vec![3, 1, 1] }).unwrap();
        let Block::Table(t) = &doc.sections[0].blocks[1] else { panic!("table") };
        assert_eq!(t.col_widths, vec![3, 1, 1]);
        // Wrong length / non-positive is rejected (no partial mutation).
        assert!(apply(&mut doc, &Op::SetTableColWidths { section: 0, index: 1, widths: vec![1, 1] }).is_err());
        assert!(apply(&mut doc, &Op::SetTableColWidths { section: 0, index: 1, widths: vec![1, 0, 1] }).is_err());
    }

    #[test]
    fn set_table_row_heights_sets_override_and_validates_length() {
        let mut doc = doc_with(vec![simple_para(1, "앞")]);
        let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
        // A 2-row, 1-col table.
        apply(&mut doc, &Op::InsertTableAt {
            section: 0, index: 1, rows: vec![vec![cell("a")], vec![cell("b")]],
        }).unwrap();
        // Default: no override stored (every row content-sized) — the oracle-safe default.
        let Block::Table(t0) = &doc.sections[0].blocks[1] else { panic!("table") };
        assert!(t0.row_heights.is_empty(), "parser/insert never fills row_heights");
        // Correct length sets the per-row floor; 0 = keep that row content-sized.
        apply(&mut doc, &Op::SetTableRowHeights { section: 0, index: 1, heights: vec![4000, 0] }).unwrap();
        let Block::Table(t) = &doc.sections[0].blocks[1] else { panic!("table") };
        assert_eq!(t.row_heights, vec![4000, 0]);
        // Wrong length / negative is rejected (no partial mutation).
        assert!(apply(&mut doc, &Op::SetTableRowHeights { section: 0, index: 1, heights: vec![1000] }).is_err());
        assert!(apply(&mut doc, &Op::SetTableRowHeights { section: 0, index: 1, heights: vec![1000, -1] }).is_err());
    }

    #[test]
    fn set_paragraph_text_preserves_shape_and_refuses_structural() {
        let mut doc = doc_with(vec![simple_para(1, "원래 내용"), structural_para(2, "구조적")]);
        // The simple paragraph keeps its first-run char shape + para shape, only the text changes.
        let before_shape = if let Block::Paragraph(p) = &doc.sections[0].blocks[0] { p.runs[0].char_shape } else { panic!() };
        apply(&mut doc, &Op::SetParagraphText { section: 0, block: 0, text: "새 내용".into() }).unwrap();
        if let Block::Paragraph(p) = &doc.sections[0].blocks[0] {
            assert_eq!(p.runs.len(), 1);
            assert_eq!(p.runs[0].char_shape, before_shape, "char shape preserved");
            let txt: String = p.runs[0].content.iter().filter_map(|i| if let Inline::Text(s) = i { Some(s.as_str()) } else { None }).collect();
            assert_eq!(txt, "새 내용");
        } else { panic!("expected paragraph") }
        // A structural paragraph is refused (never silently flattened).
        assert!(apply(&mut doc, &Op::SetParagraphText { section: 0, block: 1, text: "x".into() }).is_err(), "structural paragraph refused");
        // Empty text is allowed (clears the paragraph) — "무에서" 시작점.
        assert!(apply(&mut doc, &Op::SetParagraphText { section: 0, block: 0, text: String::new() }).is_ok());
    }
}
