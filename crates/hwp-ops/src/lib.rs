//! The typed edit-op/command bus — the **single mutation surface** for both the UI
//! and the AI (no raw-XML path anywhere). Modeled on rhwp's hwpctl Action/ParameterSet
//! shape but as our own versioned ops. See PLAN §3.2–3.3 and the ribbon→op map.
//!
//! Phase 0: op vocabulary + an undo/redo journal skeleton. Op *application* against
//! `SemanticDoc` and serialization land with the editor (Phase 3).

use hwp_model::prelude::*;

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
            if rows.is_empty() {
                return Err(Error::Other("AppendRichTable needs at least one row".into()));
            }
            let bold = intern_char_shape(doc, CharShape { bold: true, ..Default::default() });
            let plain = intern_char_shape(doc, CharShape::default());

            // Place cells with HTML-table coverage: each logical row lists only uncovered cells.
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
            let sec = section_mut(doc, *section)?;
            sec.blocks.push(Block::Table(Table {
                rows: rows.len(),
                cols: ncols.max(1),
                cells,
                dirty: Dirty(true),
                ..Default::default()
            }));
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
        _ => Err(Error::NotImplemented(
            "op apply (MVP: Append*/SetPageLayout/Set{Char,Run,Para}Pr/ApplyStyle/Insert-Delete text)",
        )),
    }
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
}

impl EditSession {
    /// Start a session over a freshly parsed (or built) document. Default history depth 100.
    pub fn new(doc: SemanticDoc) -> Self {
        EditSession { doc, undo: Vec::new(), redo: Vec::new(), limit: 100 }
    }

    /// Like [`EditSession::new`] but with an explicit history depth (`0` = unbounded).
    pub fn with_limit(doc: SemanticDoc, limit: usize) -> Self {
        EditSession { doc, undo: Vec::new(), redo: Vec::new(), limit }
    }

    /// The live document (read-only) — feed to the serializer / renderer.
    pub fn doc(&self) -> &SemanticDoc {
        &self.doc
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
        Ok(())
    }

    /// Undo the last committed op (in-memory swap; emits no XML). Returns false if nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo.pop() else { return false };
        self.redo.push(std::mem::replace(&mut self.doc, prev));
        true
    }

    /// Redo the last undone op. Returns false if nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else { return false };
        self.undo.push(std::mem::replace(&mut self.doc, next));
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
}
