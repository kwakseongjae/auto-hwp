//! Optional layout normalization for LOSSY hwp→hwpx conversions (opt-in; default render is faithful).
//!
//! ## Why this exists
//! When Hancom Office "저장 → .hwpx" exports a `.hwp`, it can REMAP most body paragraphs from their
//! explicit per-paragraph line-spacing shapes (~110–130% in a typical gov form) onto the document's
//! DEFAULT paragraph shape (`paraPrIDRef="0"`, the 바탕글 style), whose spacing is a looser 160%. The
//! original tight values still exist in the `header.xml` paraPr POOL — they are simply no longer
//! REFERENCED by the paragraphs. The net effect: the same document renders ~1.6× looser (more vertical
//! space, +2 pages) in the `.hwpx` than in its `.hwp` twin. Hancom itself renders the degraded `.hwpx`
//! this loose way, so [`crate::parse::parse_semantic`] reads it FAITHFULLY (that is the default).
//!
//! This pass is the OPT-IN "레이아웃 정리" toggle: it detects that fingerprint and pulls the collapsed
//! loose paragraphs back toward the pool's central tight spacing, approximating the original `.hwp`.
//!
//! ## Fidelity contract
//! RENDER-IR ONLY — like the border-recovery heuristic, it mutates the in-memory `para_shapes` the
//! typesetter reads, never the round-trip bytes: an unedited paragraph still re-emits its ORIGINAL
//! `paraPrIDRef` via its byte span, so a save round-trips verbatim. The transform is therefore safe to
//! apply and un-apply purely by re-parsing.
//!
//! ## Conservatism
//! It fires ONLY on the degraded fingerprint (a single loose shape dominates >60% of paragraphs WHILE
//! the pool carries a rich set of unused tighter entries). A document that GENUINELY uses 160%
//! throughout has no such unused tight pool, so it is left untouched.

use crate::document::{Block, SemanticDoc};
use crate::style::LineSpacingType;
use std::collections::BTreeMap;

/// A loose paragraph is one whose PERCENT line-spacing is at least this — the collapsed-default value
/// Hancom writes (160%) sits well above; a legitimately dense body (100–145%) sits below.
const LOOSE_PCT: i32 = 150;
/// The tight band the ORIGINAL pool entries fall in (the values Hancom orphaned on export).
const TIGHT_LO: i32 = 100;
const TIGHT_HI: i32 = 145;
/// Fraction of paragraphs a single loose shape must cover to look like a collapse (not a real choice).
const DOMINANCE: f64 = 0.60;
/// Minimum count of distinct unused tight pool entries that marks the degraded fingerprint.
const MIN_TIGHT_POOL: usize = 5;
/// Fallback target when the pool has no clear tight mode.
const DEFAULT_TARGET_PCT: i32 = 130;

/// Outcome of a normalization attempt (for logging / UI feedback).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NormalizeReport {
    /// True iff the degraded fingerprint matched and spacing was pulled in.
    pub applied: bool,
    /// The loose value that dominated (e.g. 160), or 0 if none.
    pub loose_pct: i32,
    /// The tight value it was pulled to (e.g. 130), or 0 if not applied.
    pub target_pct: i32,
    /// Paragraphs whose effective spacing changed.
    pub paragraphs_touched: usize,
    /// Total paragraphs walked.
    pub total_paragraphs: usize,
}

fn collect_shape_indices(b: &Block, out: &mut Vec<usize>) {
    match b {
        Block::Paragraph(p) => out.push(p.para_shape),
        Block::Table(t) => {
            for c in &t.cells {
                for cb in &c.blocks {
                    collect_shape_indices(cb, out);
                }
            }
        }
    }
}

/// The most frequent value in a slice (ties broken by the smaller value for determinism).
fn mode(values: &[i32]) -> Option<i32> {
    let mut counts: BTreeMap<i32, usize> = BTreeMap::new();
    for &v in values {
        *counts.entry(v).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
        .map(|(v, _)| v)
}

/// Detect a lossy-conversion line-spacing collapse and, if found, pull the collapsed loose paragraphs
/// back to the pool's central tight spacing. Returns a report describing what happened.
///
/// See the module docs for the fidelity contract. Safe no-op on faithful documents.
pub fn normalize_line_spacing(doc: &mut SemanticDoc) -> NormalizeReport {
    let mut report = NormalizeReport::default();

    // 1. Which para_shape does each paragraph (incl. table-cell paragraphs) use?
    let mut idxs = Vec::new();
    for sec in &doc.sections {
        for b in &sec.blocks {
            collect_shape_indices(b, &mut idxs);
        }
    }
    report.total_paragraphs = idxs.len();
    if idxs.is_empty() {
        return report;
    }

    // 2. Per-shape usage counts.
    let mut usage: BTreeMap<usize, usize> = BTreeMap::new();
    for &i in &idxs {
        *usage.entry(i).or_default() += 1;
    }

    // 3. The set of interned shapes that are "loose" (PERCENT ≥ 150%) AND actually used.
    let is_loose = |idx: usize| -> bool {
        doc.para_shapes.get(idx).is_some_and(|s| {
            s.line_spacing_type == LineSpacingType::Percent && s.line_spacing_value >= LOOSE_PCT
        })
    };
    let loose_indices: Vec<usize> = usage.keys().copied().filter(|&i| is_loose(i)).collect();
    if loose_indices.is_empty() {
        return report; // nothing loose → nothing to normalize.
    }

    // 4. Dominance: does a single loose shape cover > DOMINANCE of all paragraphs? (the collapse
    //    signature — one default shape swallowing the body).
    let dominant = loose_indices
        .iter()
        .map(|&i| (i, usage[&i]))
        .max_by_key(|&(_, c)| c);
    let (dom_idx, dom_count) = match dominant {
        Some(x) => x,
        None => return report,
    };
    if (dom_count as f64) < DOMINANCE * (report.total_paragraphs as f64) {
        return report; // no single loose shape dominates → looks like a genuine mix, leave it.
    }
    report.loose_pct = doc.para_shapes[dom_idx].line_spacing_value;

    // 5. Fingerprint: the header pool must still carry a RICH set of tighter entries the paragraphs
    //    no longer reference (the orphaned originals). A genuinely-loose document lacks this.
    let tight_pool: Vec<i32> = doc
        .header_pools
        .para
        .values()
        .filter(|s| {
            s.line_spacing_type == LineSpacingType::Percent
                && (TIGHT_LO..=TIGHT_HI).contains(&s.line_spacing_value)
        })
        .map(|s| s.line_spacing_value)
        .collect();
    if tight_pool.len() < MIN_TIGHT_POOL {
        return report; // not the degraded fingerprint → faithful is correct, do nothing.
    }

    // 6. Target = the pool's dominant tight value (what the body most likely was), clamped.
    let target = mode(&tight_pool)
        .unwrap_or(DEFAULT_TARGET_PCT)
        .clamp(TIGHT_LO, TIGHT_HI);
    report.target_pct = target;

    // 7. Pull every used loose shape down to the target. Modifying the shared shape reaches exactly the
    //    collapsed paragraphs (they all point at it). Render-IR only — re-serialize re-emits the
    //    original paraPrIDRef, so the moat holds.
    for &i in &loose_indices {
        doc.para_shapes[i].line_spacing_value = target;
    }
    report.paragraphs_touched = idxs.iter().filter(|&&i| loose_indices.contains(&i)).count();
    report.applied = true;
    report
}

// ── Auto-fit table row-height mode (the row-height twin of the line-spacing recovery) ─────────────────
//
// A lossy hwp→hwpx save records AUTO-FIT (`noAdjust="0"`) table rows with a NOMINAL stored height (the
// `<hp:cellSz height>`), which the HWPX parser keeps in `Table::stored_row_heights` (NON-empty ONLY for
// those tables). Two faithful readings, toggled by the app:
//   • FAITHFUL — floor rows to the stored heights → mirror how Hancom itself renders the .hwpx (rows
//     spread, e.g. a 자가진단표 shows 1–7/page over ~20 pages).
//   • 레이아웃 정리 — content-fit (drop the floor) → recover the .hwp look (1–12/page, denser).
// Both mutate `row_heights` (render-IR); an unedited table re-emits via `src_span`, so neither reaches
// saved bytes. `stored_row_heights` is the immutable source, so the toggle is fully reversible.

fn tables_mut(b: &mut Block, f: &mut impl FnMut(&mut crate::document::Table)) {
    if let Block::Table(t) = b {
        // Recurse into nested tables FIRST (the `cells` borrow ends before `f(t)`), then the table.
        for c in &mut t.cells {
            for cb in &mut c.blocks {
                tables_mut(cb, f);
            }
        }
        f(t);
    }
}

/// FAITHFUL table heights: floor every auto-fit table's rows to its stored `<hp:cellSz>` heights, so the
/// render mirrors Hancom's own .hwpx layout. Targets exactly the HWPX auto-fit tables (non-empty
/// `stored_row_heights`); fixed/lift/synth tables are untouched. Returns the number of tables floored.
/// Idempotent. The inverse of [`content_fit_autofit_tables`].
pub fn apply_faithful_table_heights(doc: &mut SemanticDoc) -> usize {
    let mut n = 0;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            tables_mut(b, &mut |t| {
                if !t.stored_row_heights.is_empty() {
                    t.row_heights = t.stored_row_heights.clone();
                    n += 1;
                }
            });
        }
    }
    n
}

/// 레이아웃 정리 table heights: content-fit every auto-fit table (clear the stored floor) so the render
/// recovers the denser .hwp look. Targets exactly the HWPX auto-fit tables (non-empty
/// `stored_row_heights`); fixed tables keep their explicit `row_heights`. Returns the count. Idempotent.
/// The inverse of [`apply_faithful_table_heights`].
pub fn content_fit_autofit_tables(doc: &mut SemanticDoc) -> usize {
    let mut n = 0;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            tables_mut(b, &mut |t| {
                if !t.stored_row_heights.is_empty() {
                    t.row_heights = Vec::new();
                    n += 1;
                }
            });
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Block, Paragraph, Section};
    use crate::style::ParaShape;

    fn loose(v: i32) -> ParaShape {
        ParaShape {
            line_spacing_type: LineSpacingType::Percent,
            line_spacing_value: v,
            ..Default::default()
        }
    }

    fn doc_with(shapes: Vec<ParaShape>, para_shape_of: Vec<usize>, pool: Vec<i32>) -> SemanticDoc {
        let mut d = SemanticDoc {
            para_shapes: shapes,
            ..Default::default()
        };
        let blocks = para_shape_of
            .into_iter()
            .map(|ps| {
                Block::Paragraph(Paragraph {
                    para_shape: ps,
                    ..Default::default()
                })
            })
            .collect();
        d.sections.push(Section {
            blocks,
            ..Default::default()
        });
        for (k, v) in pool.into_iter().enumerate() {
            d.header_pools.para.insert(k as u64, loose(v));
        }
        d
    }

    #[test]
    fn degraded_collapse_is_normalized() {
        // shape 1 = 160% used by 8/10 paragraphs; pool carries 6 tight entries (mode 130).
        let shapes = vec![ParaShape::default(), loose(160), loose(120)];
        let uses = vec![1, 1, 1, 1, 1, 1, 1, 1, 2, 2];
        let pool = vec![110, 120, 130, 130, 130, 100];
        let mut d = doc_with(shapes, uses, pool);
        let r = normalize_line_spacing(&mut d);
        assert!(r.applied);
        assert_eq!(r.loose_pct, 160);
        assert_eq!(r.target_pct, 130);
        assert_eq!(r.paragraphs_touched, 8);
        assert_eq!(d.para_shapes[1].line_spacing_value, 130); // pulled in
        assert_eq!(d.para_shapes[2].line_spacing_value, 120); // tight shape untouched
    }

    #[test]
    fn genuine_loose_doc_is_left_alone() {
        // 160% dominates, but the pool has NO orphaned tight entries → faithful, do not touch.
        let shapes = vec![ParaShape::default(), loose(160)];
        let uses = vec![1; 10];
        let pool = vec![160, 160]; // no tight pool
        let mut d = doc_with(shapes, uses, pool);
        let r = normalize_line_spacing(&mut d);
        assert!(!r.applied);
        assert_eq!(d.para_shapes[1].line_spacing_value, 160); // untouched
    }

    #[test]
    fn no_dominant_loose_shape_is_left_alone() {
        // loose shape used by only 3/10 → not a collapse.
        let shapes = vec![ParaShape::default(), loose(160), loose(120)];
        let uses = vec![1, 1, 1, 2, 2, 2, 2, 2, 2, 2];
        let pool = vec![110, 120, 130, 130, 130, 100];
        let mut d = doc_with(shapes, uses, pool);
        let r = normalize_line_spacing(&mut d);
        assert!(!r.applied);
        assert_eq!(d.para_shapes[1].line_spacing_value, 160);
    }

    #[test]
    fn genuine_mix_below_dominance_is_left_alone() {
        // Regression from the real corpus (2026-07-17 validation): a GENUINE gov-form body is ~130%
        // with a LARGE minority (~45%) at 160% (headers/spacers) AND a rich tight pool. This looks
        // superficially "loose-heavy" but 160% covers < DOMINANCE(60%), so it must NOT normalize —
        // else we'd wrongly tighten a legitimately-authored document (the .hwp twin renders it 130%
        // body + 160% headers, faithfully mirrored by the .hwpx). Mirrors doc0/1/2/5/6/9 in the sweep.
        let shapes = vec![ParaShape::default(), loose(130), loose(160)];
        // 11/20 at 130% (shape 1), 9/20 at 160% (shape 2) → loose = 45% < 60%.
        let mut uses = vec![1; 11];
        uses.extend(vec![2; 9]);
        let pool = vec![110, 120, 130, 130, 130, 100, 145]; // rich tight pool present
        let mut d = doc_with(shapes, uses, pool);
        let r = normalize_line_spacing(&mut d);
        assert!(!r.applied, "45% loose is a genuine mix, not a collapse");
        assert_eq!(d.para_shapes[2].line_spacing_value, 160); // legit 160% headers untouched
    }

    // ── auto-fit table row-height toggle ──────────────────────────────────────────────────────────
    use crate::document::{Cell, Table};

    fn autofit_table(stored: Vec<i32>) -> Block {
        Block::Table(Table {
            rows: stored.len(),
            cols: 1,
            stored_row_heights: stored,
            ..Default::default()
        })
    }
    fn fixed_table(row_heights: Vec<i32>) -> Block {
        // A fixed (noAdjust=1) table: heights live in `row_heights`, `stored_row_heights` stays empty.
        Block::Table(Table {
            rows: row_heights.len(),
            cols: 1,
            row_heights,
            ..Default::default()
        })
    }
    fn doc_with_blocks(blocks: Vec<Block>) -> SemanticDoc {
        let mut d = SemanticDoc::default();
        d.sections.push(Section {
            blocks,
            ..Default::default()
        });
        d
    }

    #[test]
    fn faithful_and_contentfit_are_inverses_on_autofit_tables() {
        let mut d = doc_with_blocks(vec![autofit_table(vec![2200, 2200, 3000])]);
        // FAITHFUL: floor rows to the stored cellSz heights (mirror Hancom).
        assert_eq!(apply_faithful_table_heights(&mut d), 1);
        if let Block::Table(t) = &d.sections[0].blocks[0] {
            assert_eq!(t.row_heights, vec![2200, 2200, 3000]);
            assert_eq!(t.stored_row_heights, vec![2200, 2200, 3000]); // source retained
        } else {
            panic!("table");
        }
        // 레이아웃 정리: content-fit (drop the floor) — the .hwp look.
        assert_eq!(content_fit_autofit_tables(&mut d), 1);
        if let Block::Table(t) = &d.sections[0].blocks[0] {
            assert!(t.row_heights.is_empty());
            assert_eq!(t.stored_row_heights, vec![2200, 2200, 3000]); // still reversible
        } else {
            panic!("table");
        }
        // Reversible back to faithful.
        apply_faithful_table_heights(&mut d);
        if let Block::Table(t) = &d.sections[0].blocks[0] {
            assert_eq!(t.row_heights, vec![2200, 2200, 3000]);
        } else {
            panic!("table");
        }
    }

    #[test]
    fn fixed_and_nested_tables_are_handled_correctly() {
        // A fixed table (stored_row_heights empty) must be UNTOUCHED by both passes; a NESTED auto-fit
        // table inside a cell must be reached.
        let inner = autofit_table(vec![1500]);
        let mut outer_cell = Cell::default();
        outer_cell.blocks.push(inner);
        let outer = Table {
            rows: 1,
            cols: 1,
            cells: vec![outer_cell],
            stored_row_heights: vec![9000],
            ..Default::default()
        };
        let mut d = doc_with_blocks(vec![fixed_table(vec![500, 800]), Block::Table(outer)]);
        // Both the outer auto-fit and the nested auto-fit get floored; the fixed table does not.
        assert_eq!(apply_faithful_table_heights(&mut d), 2);
        if let Block::Table(t) = &d.sections[0].blocks[0] {
            assert_eq!(t.row_heights, vec![500, 800], "fixed table untouched");
            assert!(t.stored_row_heights.is_empty());
        }
        // content-fit clears the two auto-fit tables (outer + nested), leaves the fixed one.
        assert_eq!(content_fit_autofit_tables(&mut d), 2);
        if let Block::Table(t) = &d.sections[0].blocks[0] {
            assert_eq!(
                t.row_heights,
                vec![500, 800],
                "fixed table STILL untouched by content-fit"
            );
        }
    }
}
