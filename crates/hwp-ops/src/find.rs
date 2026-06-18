//! FIND / REPLACE over the [`SemanticDoc`] — the pure search + replace-op builder that the
//! editor (and the AI/MCP lane) drive through the op-bus. This module is **read-only on the doc**:
//! it locates matches and *emits* [`Op`]s; the caller hands them to [`EditSession::do_ops`] so a
//! replace-all is exactly ONE undo unit (see hwp-ops `do_ops`).
//!
//! Scope (v1, honest + verifiable):
//! - Searches only TOP-LEVEL SIMPLE body paragraphs that carry a [`NodeId`] (the editable path).
//!   Table cells / headers/footers / notes and non-simple paragraphs are SKIPPED — the in-place
//!   edit path refuses them, so we never surface a match we could not apply.
//! - A match is found WITHIN one paragraph's concatenated run text (a [`Caret`] is paragraph-scoped
//!   and [`Op::DeleteRange`] cannot cross paragraphs). A query that spans a paragraph boundary is
//!   not matched in v1.
//! - A match MAY span multiple runs / char-shapes within a paragraph — `DeleteRange`/`InsertText`
//!   address by CHAR offset over the concatenated text and rebuild across runs, so no extra work.
//!
//! Correctness load-bearers (see the per-fn docs): char-space (Unicode-scalar) offsets everywhere
//! (Korean-safe, matches `Caret.offset`/`SetRunCharPr`); per-paragraph matches are emitted
//! RIGHT-TO-LEFT so applying one replacement never corrupts a not-yet-applied lower offset; matches
//! are computed ONCE against the original doc so replacement text that contains the query never
//! re-matches; an empty query matches nothing (guards the zero-length infinite-loop at the source).

use crate::{Caret, Op};
use hwp_model::prelude::*;

/// A single search hit inside one top-level simple paragraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    /// The owning top-level simple paragraph (always a real NodeId, since only NodeId-bearing
    /// simple paragraphs are searched). Used to build a [`Caret`].
    pub node: NodeId,
    /// Char (Unicode-scalar) offset of the match START over the paragraph's CONCATENATED run text —
    /// the SAME coordinate space as [`Caret::offset`] and `Op::SetRunCharPr`.
    pub start: usize,
    /// Char (Unicode-scalar) LENGTH of the match (`end = start + len`). Length, not end-offset, so
    /// ordering is unambiguously by `start` and a (never-produced) zero-length match is representable.
    pub len: usize,
    /// 0-based section index for UI navigation / scroll-to (cheap to fill during the walk).
    pub section: usize,
    /// 0-based block index within the section.
    pub block: usize,
}

/// Options controlling [`find_matches`]. `Default` = case-insensitive, not whole-word.
#[derive(Clone, Copy, Debug, Default)]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// A paragraph's concatenated `Inline::Text` across runs (mirrors `document::block_text`'s
/// paragraph arm). Local to find.rs so the private lib.rs `run_text`/`run_char_len` helpers stay
/// private (avoid widening the op-bus API).
fn para_text(p: &Paragraph) -> String {
    let mut s = String::new();
    for run in &p.runs {
        for inl in &run.content {
            if let Inline::Text(t) = inl {
                s.push_str(t);
            }
        }
    }
    s
}

/// True iff the paragraph is searchable: carries a `NodeId` AND is SIMPLE (a `None` source means
/// synthesized/appended, treated as editable — matching `with_simple_para`, which only refuses
/// `Some(s) if !s.simple`).
fn searchable(p: &Paragraph) -> Option<NodeId> {
    let node = p.id?;
    let simple = p.source.as_ref().is_none_or(|s| s.simple);
    simple.then_some(node)
}

/// Compare two chars under the case-sensitivity option. Folds PER-CHAR (never whole-string
/// `to_lowercase`, whose length can differ for some scripts) so START/LEN stay in ORIGINAL char
/// coordinates exactly — the load-bearing correctness property. Unicode-aware via `char::to_lowercase`.
#[inline]
fn eqc(a: char, b: char, case_sensitive: bool) -> bool {
    if case_sensitive {
        a == b
    } else {
        a.to_lowercase().eq(b.to_lowercase())
    }
}

/// A "word" char for the whole-word gate: Unicode alphanumeric (covers Hangul/CJK) or `_`.
#[inline]
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Find every match of `query` in the doc's searchable paragraphs, in reading order (and ascending
/// by `start` within each paragraph). Matching is in CHAR space (Korean-safe). NON-OVERLAPPING:
/// after a hit the scan advances by the query length, so `"aa"` in `"aaaa"` yields 2 matches.
///
/// An empty `query` returns an empty `Vec` immediately (an empty query never matches — this also
/// guards the zero-length infinite-loop case at the source, since every recorded match has len ≥ 1).
pub fn find_matches(doc: &SemanticDoc, query: &str, opts: FindOptions) -> Vec<Match> {
    let q_chars: Vec<char> = query.chars().collect();
    if q_chars.is_empty() {
        return Vec::new();
    }
    let qlen = q_chars.len();
    let mut out = Vec::new();

    for (si, sec) in doc.sections.iter().enumerate() {
        for (bi, block) in sec.blocks.iter().enumerate() {
            let Block::Paragraph(p) = block else { continue };
            let Some(node) = searchable(p) else { continue };

            let hay: Vec<char> = para_text(p).chars().collect();
            if hay.len() < qlen {
                continue;
            }
            let mut start = 0usize;
            // `start` ranges over potential match starts; advancing by `qlen` (≥1) on a hit means the
            // loop always progresses, so no infinite loop is possible.
            while start + qlen <= hay.len() {
                let hit = (0..qlen).all(|k| eqc(hay[start + k], q_chars[k], opts.case_sensitive));
                if hit
                    && (!opts.whole_word
                        || (start.checked_sub(1).is_none_or(|i| !is_word_char(hay[i]))
                            && hay.get(start + qlen).is_none_or(|&c| !is_word_char(c))))
                {
                    out.push(Match { node, start, len: qlen, section: si, block: bi });
                    start += qlen; // non-overlapping
                } else {
                    start += 1;
                }
            }
        }
    }
    out
}

/// Number of matches (`find_matches(..).len()`). The Tauri `find` command returns the DTO list, so
/// this is mostly a convenience for callers that only need a count.
pub fn find_count(doc: &SemanticDoc, query: &str, opts: FindOptions) -> usize {
    find_matches(doc, query, opts).len()
}

/// The `[DeleteRange, InsertText]` op pair that replaces one match's char span with `replacement`.
/// DELETE FIRST, then INSERT at the same start offset — so a replacement that CONTAINS the query is
/// safe (matches are computed once up front and never re-scanned).
fn replace_pair(node: NodeId, start: usize, len: usize, replacement: &str) -> [Op; 2] {
    [
        Op::DeleteRange {
            start: Caret { node, offset: start },
            end: Caret { node, offset: start + len },
        },
        Op::InsertText { at: Caret { node, offset: start }, text: replacement.to_string() },
    ]
}

/// Build the ordered ops to replace ALL matches of `query` with `replacement`, for ONE
/// [`EditSession::do_ops`] batch (one undo unit). The doc is only READ (via [`find_matches`]), never
/// mutated, so this can't desync from find.
///
/// OFFSET-INVALIDATION CORRECTNESS: matches arrive grouped by paragraph, ascending by start. We emit
/// each paragraph's matches RIGHT-TO-LEFT (descending start) so every op operates at offsets strictly
/// less than the already-applied (higher) ones — no earlier-applied edit shifts a not-yet-applied
/// lower offset, regardless of whether `replacement` is shorter or longer than the match. Paragraph
/// groups are independent (carets are paragraph-scoped), so inter-group order is irrelevant; groups
/// are kept in reading order for predictability. An empty `query` → no matches → empty `Vec` →
/// `do_ops(&[])` is a documented no-op (no undo unit, no rev bump).
pub fn replace_all_ops(
    doc: &SemanticDoc,
    query: &str,
    replacement: &str,
    opts: FindOptions,
) -> Vec<Op> {
    let matches = find_matches(doc, query, opts);
    // Group by node, preserving first-seen (reading) order; within a group keep ascending order.
    let mut groups: Vec<(NodeId, Vec<Match>)> = Vec::new();
    for m in matches {
        match groups.iter_mut().find(|(n, _)| *n == m.node) {
            Some((_, v)) => v.push(m),
            None => groups.push((m.node, vec![m])),
        }
    }
    let mut ops = Vec::new();
    for (_, group) in &groups {
        // Right-to-left within the paragraph (the ascending group reversed).
        for m in group.iter().rev() {
            ops.extend(replace_pair(m.node, m.start, m.len, replacement));
        }
    }
    ops
}

/// Build the ops to replace exactly the match described by `target` with `replacement`. Trusts the
/// passed [`Match`] but RE-VALIDATES against the live doc (paragraph still exists, is simple, and
/// `start + len` is within its current char length); returns an empty `Vec` if stale (caller surfaces
/// `replaced: 0`). One match → exactly `[DeleteRange, InsertText]` → one `do_ops` batch = one undo unit.
pub fn replace_one_ops(doc: &SemanticDoc, target: &Match, replacement: &str) -> Vec<Op> {
    for sec in &doc.sections {
        for block in &sec.blocks {
            let Block::Paragraph(p) = block else { continue };
            if searchable(p) != Some(target.node) {
                continue;
            }
            let total = para_text(p).chars().count();
            if target.start + target.len <= total {
                return replace_pair(target.node, target.start, target.len, replacement).to_vec();
            }
            return Vec::new(); // stale offset
        }
    }
    Vec::new() // paragraph gone / not simple
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{apply, EditSession};

    // ---- doc builders (mirror the lib.rs test helpers) ----

    fn simple_para(id: u64, text: &str) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: vec![Run {
                char_ref: Some("0".into()),
                content: vec![Inline::Text(text.into())],
                ..Default::default()
            }],
            source: Some(ParaSource { span: (0, 0), simple: true, ..Default::default() }),
            ..Default::default()
        }
    }

    fn multirun_para(id: u64, parts: &[&str]) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: parts
                .iter()
                .map(|t| Run {
                    char_ref: Some("0".into()),
                    content: vec![Inline::Text((*t).into())],
                    ..Default::default()
                })
                .collect(),
            source: Some(ParaSource { span: (0, 0), simple: true, ..Default::default() }),
            ..Default::default()
        }
    }

    fn structural_para(id: u64, text: &str) -> Paragraph {
        Paragraph {
            id: Some(NodeId(id)),
            runs: vec![Run { content: vec![Inline::Text(text.into())], ..Default::default() }],
            source: Some(ParaSource { span: (0, 0), simple: false, ..Default::default() }),
            ..Default::default()
        }
    }

    fn doc_with(paras: Vec<Paragraph>) -> SemanticDoc {
        let mut doc = SemanticDoc {
            char_shapes: vec![CharShape::default()],
            para_shapes: vec![ParaShape::default()],
            ..Default::default()
        };
        doc.sections
            .push(Section { blocks: paras.into_iter().map(Block::Paragraph).collect(), ..Default::default() });
        doc
    }

    fn para_text_of(doc: &SemanticDoc, id: u64) -> String {
        doc.sections[0]
            .blocks
            .iter()
            .find_map(|b| match b {
                Block::Paragraph(p) if p.id == Some(NodeId(id)) => Some(para_text(p)),
                _ => None,
            })
            .unwrap()
    }

    fn ci() -> FindOptions {
        FindOptions::default()
    }
    fn cs() -> FindOptions {
        FindOptions { case_sensitive: true, whole_word: false }
    }
    fn ww() -> FindOptions {
        FindOptions { case_sensitive: false, whole_word: true }
    }

    // ---- find_matches ----

    #[test]
    fn find_counts_and_offsets() {
        let doc = doc_with(vec![simple_para(1, "abc abc abc")]);
        let ms = find_matches(&doc, "abc", cs());
        assert_eq!(ms.len(), 3);
        assert_eq!(ms.iter().map(|m| m.start).collect::<Vec<_>>(), vec![0, 4, 8]);
        assert!(ms.iter().all(|m| m.len == 3 && m.node == NodeId(1)));
    }

    #[test]
    fn find_case_sensitivity() {
        let doc = doc_with(vec![simple_para(1, "Foo foo FOO")]);
        assert_eq!(find_matches(&doc, "foo", ci()).len(), 3, "insensitive → all 3");
        let sens = find_matches(&doc, "foo", cs());
        assert_eq!(sens.len(), 1, "sensitive → only the exact 'foo'");
        assert_eq!(sens[0].start, 4);
    }

    #[test]
    fn find_korean_char_offsets_not_bytes() {
        // '가나다 가나' → '가나' at CHAR offsets 0 and 4 (NOT byte offsets), len 2.
        let doc = doc_with(vec![simple_para(1, "가나다 가나")]);
        let ms = find_matches(&doc, "가나", cs());
        assert_eq!(ms.iter().map(|m| m.start).collect::<Vec<_>>(), vec![0, 4]);
        assert!(ms.iter().all(|m| m.len == 2));
    }

    #[test]
    fn find_whole_word_ascii_and_hangul() {
        let doc = doc_with(vec![simple_para(1, "cat category cat")]);
        let ms = find_matches(&doc, "cat", ww());
        assert_eq!(ms.len(), 2, "the 'cat' inside 'category' is excluded");
        assert_eq!(ms.iter().map(|m| m.start).collect::<Vec<_>>(), vec![0, 13]);

        // Hangul boundary: '값 값어치' query '값' whole-word → only the standalone '값'.
        let doc = doc_with(vec![simple_para(1, "값 값어치")]);
        let ms = find_matches(&doc, "값", ww());
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].start, 0);
    }

    #[test]
    fn find_non_overlapping_no_infinite_loop() {
        let doc = doc_with(vec![simple_para(1, "aaaa")]);
        let ms = find_matches(&doc, "aa", cs());
        assert_eq!(ms.iter().map(|m| m.start).collect::<Vec<_>>(), vec![0, 2]);
    }

    #[test]
    fn find_empty_query_and_too_long_query() {
        let doc = doc_with(vec![simple_para(1, "short")]);
        assert!(find_matches(&doc, "", cs()).is_empty(), "empty query → no matches");
        assert!(find_matches(&doc, "this is longer than the paragraph", cs()).is_empty());
    }

    #[test]
    fn find_skips_non_simple_and_tables() {
        // simple para + structural para + a table, all containing the query → only the simple match.
        let mut doc = doc_with(vec![simple_para(1, "needle here"), structural_para(2, "needle there")]);
        doc.sections[0].blocks.push(Block::Table(Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                blocks: vec![Block::Paragraph(simple_para(3, "needle in cell"))],
                ..Default::default()
            }],
            ..Default::default()
        }));
        let ms = find_matches(&doc, "needle", cs());
        assert_eq!(ms.len(), 1, "only the top-level simple paragraph is searched");
        assert_eq!(ms[0].node, NodeId(1));
    }

    #[test]
    fn find_across_run_boundary() {
        // runs ['가나','다라'] query '나다' (spans the run boundary) → 1 match at char 1 len 2.
        let doc = doc_with(vec![multirun_para(1, &["가나", "다라"])]);
        let ms = find_matches(&doc, "나다", cs());
        assert_eq!(ms.len(), 1);
        assert_eq!((ms[0].start, ms[0].len), (1, 2));
    }

    #[test]
    fn find_records_section_and_block_indices() {
        let doc = doc_with(vec![simple_para(1, "x"), simple_para(2, "find me")]);
        let ms = find_matches(&doc, "find", cs());
        assert_eq!(ms.len(), 1);
        assert_eq!((ms[0].section, ms[0].block), (0, 1));
    }

    // ---- replace_all_ops (apply via EditSession::do_ops) ----

    fn apply_ops(doc: &mut SemanticDoc, ops: &[Op]) {
        for op in ops {
            apply(doc, op).unwrap();
        }
    }

    #[test]
    fn replace_all_basic() {
        let mut doc = doc_with(vec![simple_para(1, "abc abc")]);
        let ops = replace_all_ops(&doc, "abc", "XY", cs());
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "XY XY");
    }

    #[test]
    fn replace_all_is_single_undo_unit() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "abc abc abc")]));
        let ops = replace_all_ops(s.doc(), "abc", "Z", cs());
        assert_eq!(ops.len(), 6, "3 matches × [Delete, Insert]");
        s.do_ops(&ops).unwrap();
        assert_eq!(para_text_of(s.doc(), 1), "Z Z Z");
        // ONE undo reverts ALL three.
        assert!(s.can_undo());
        assert!(s.undo());
        assert_eq!(para_text_of(s.doc(), 1), "abc abc abc");
        assert!(!s.can_undo(), "the replace-all was a single undo unit");
    }

    #[test]
    fn replace_right_to_left_correct_for_shorter_and_longer() {
        // 'abXabXab' has 3 'ab' at 0,3,6. Replacing with a SHORTER and a LONGER string must both
        // be correct — proving offsets don't corrupt regardless of length delta (the key regression).
        let mut doc = doc_with(vec![simple_para(1, "abXabXab")]);
        let ops = replace_all_ops(&doc, "ab", "Z", cs());
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "ZXZXZ");

        let mut doc = doc_with(vec![simple_para(1, "abXabXab")]);
        let ops = replace_all_ops(&doc, "ab", "LONG", cs());
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "LONGXLONGXLONG");
    }

    #[test]
    fn replace_replacement_contains_query_does_not_runaway() {
        // 'foo' → 'foofoo' on 'foo foo' → exactly 2 replacements (not re-scanned).
        let mut doc = doc_with(vec![simple_para(1, "foo foo")]);
        let ops = replace_all_ops(&doc, "foo", "foofoo", cs());
        assert_eq!(ops.len(), 4, "exactly 2 matches");
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "foofoo foofoo");
    }

    #[test]
    fn replace_across_runs_single_undo() {
        // runs ['가나','다라'] replace '나다' with 'X' → concatenated '가X라'.
        let mut s = EditSession::new(doc_with(vec![multirun_para(1, &["가나", "다라"])]));
        let ops = replace_all_ops(s.doc(), "나다", "X", cs());
        s.do_ops(&ops).unwrap();
        assert_eq!(para_text_of(s.doc(), 1), "가X라");
        assert!(s.undo());
        assert_eq!(para_text_of(s.doc(), 1), "가나다라");
    }

    #[test]
    fn replace_all_across_paragraphs_independent_groups() {
        let mut doc = doc_with(vec![simple_para(1, "ab ab"), simple_para(2, "ab")]);
        let ops = replace_all_ops(&doc, "ab", "Z", cs());
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "Z Z");
        assert_eq!(para_text_of(&doc, 2), "Z");
    }

    #[test]
    fn replace_all_empty_query_is_noop() {
        let mut s = EditSession::new(doc_with(vec![simple_para(1, "abc")]));
        let ops = replace_all_ops(s.doc(), "", "X", cs());
        assert!(ops.is_empty());
        let rev = s.revision();
        s.do_ops(&ops).unwrap();
        assert_eq!(s.revision(), rev, "do_ops(&[]) bumps no revision");
        assert!(!s.can_undo());
    }

    // ---- replace_one_ops ----

    #[test]
    fn replace_one_replaces_only_first() {
        let doc = doc_with(vec![simple_para(1, "abc abc abc")]);
        let first = find_matches(&doc, "abc", cs())[0].clone();
        let ops = replace_one_ops(&doc, &first, "Z");
        let mut doc = doc;
        apply_ops(&mut doc, &ops);
        assert_eq!(para_text_of(&doc, 1), "Z abc abc");
    }

    #[test]
    fn replace_one_stale_match_returns_empty() {
        let doc = doc_with(vec![simple_para(1, "abc")]);
        // A Match whose span runs past the current paragraph text → stale → [].
        let stale = Match { node: NodeId(1), start: 2, len: 10, section: 0, block: 0 };
        assert!(replace_one_ops(&doc, &stale, "Z").is_empty());
        // A Match on a node that doesn't exist → [].
        let gone = Match { node: NodeId(99), start: 0, len: 1, section: 0, block: 0 };
        assert!(replace_one_ops(&doc, &gone, "Z").is_empty());
    }
}
