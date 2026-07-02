//! Untrusted-input hardening: shared resource limits + typed limit errors (issue #014, R4).
//!
//! The parsers (`hwp-hwpx` = zip+quick-xml, `hwp-rhwp` = the vendored HWP5 bootstrap) open
//! **arbitrary internet-sourced files** once a service (013) / web front (015) exists. A zip bomb,
//! a 100-deep nested table, a corrupt CFB or a truncated file must end in a **fast, explicit,
//! code-distinguishable error** — never a panic, an OOM, or a hang.
//!
//! This module is the single home for:
//!   * the five limit **constants** ([`MAX_RAW_FILE`] … [`MAX_PARAGRAPHS`]);
//!   * the typed [`DocLimit`] enum every limit fails with (a service switches on the *variant*, not
//!     a stringly error — that is the whole point of centralising them here);
//!   * cheap predicate checks the parser entry points call at their boundaries;
//!   * [`check_layout_limits`] — a standalone guard over a parsed `SemanticDoc` (EXPOSE ONLY; the
//!     wiring into the open path is issue **013** — see the fn's docs for the exact sites).
//!
//! It stays **pure & wasm-clean**: no zip/xml/rhwp deps. The mechanism (streaming bounded reads,
//! the quick-xml depth counter, the `catch_unwind` boundary) lives in the parser crates; the
//! *policy* (numbers + typed errors + predicates) lives here.

use hwp_model::document::{Block, SemanticDoc};

// ---------------------------------------------------------------------------
// Limit constants. Each value is reported against the measured normal-corpus max in the issue
// verification; a resource cap keeps ≥10x headroom, the structural recursion guard is justified
// separately (see `MAX_TABLE_NESTING`).
// ---------------------------------------------------------------------------

/// Largest accepted raw input file (before any decompression). 64 MiB.
/// Corpus max raw = 4.31 MB (`corpus/hwp/tac-img-02.hwp`) → 15.6x headroom.
pub const MAX_RAW_FILE: u64 = 64 * 1024 * 1024;

/// Largest accepted **cumulative decompressed** size across all parts of one document. 256 MiB.
/// The zip crate is deflate-only, so the realistic threat is a single high-ratio deflate stream;
/// we count the **actual** bytes produced by inflation and never trust a declared `size()`.
/// Corpus max decompressed total = 1.10 MiB (`benchmark1.hwpx`) → 232x headroom.
pub const MAX_DECOMPRESSED_TOTAL: u64 = 256 * 1024 * 1024;

/// Largest accepted number of zip entries (checked right after the central directory is read, which
/// the zip crate does eagerly). 4096. Corpus max entries = 13 (`form-01.hwpx`) → 315x headroom.
pub const MAX_ENTRY_COUNT: usize = 4096;

/// Deepest accepted table-in-table nesting. 8.
/// This is a **recursion / structural** guard, not a linearly-scaling resource cap, so the ">=10x
/// over corpus max" rule does not apply the same way: corpus max nesting = 3 (`benchmark1.hwpx`),
/// giving 2.7x, but the number that matters is the margin against the *attack* — a depth-8 cap
/// rejects the depth-100 hostile fixture with 92 levels to spare, while real editors practically
/// never nest tables beyond 2-3. Raising it would only make a stack-exhaustion attack *easier*,
/// not the corpus safer, so 8 is deliberately tight. (Applies to the HWPX parse path; the HWP5
/// path is bounded instead by the `catch_unwind` boundary + [`check_layout_limits`].)
pub const MAX_TABLE_NESTING: usize = 8;

/// Largest accepted number of paragraphs (top-level + cell) in a parsed document — the layout guard
/// ceiling. 200_000. Corpus doc-total max = 1172 (`benchmark1.hwpx`) → 171x headroom.
pub const MAX_PARAGRAPHS: usize = 200_000;

// ---------------------------------------------------------------------------
// Typed errors.
// ---------------------------------------------------------------------------

/// A resource limit was exceeded (or the rhwp boundary caught a panic). Every variant is a distinct
/// **code** so a service can react per-case (reject as abusive, reject as malformed, retry, …)
/// without string-matching. This is intentionally NOT folded into `hwp_model::Error` (a flat
/// string enum): the "문자열 에러 금지" contract requires the limits to stay typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocLimit {
    /// Raw file bytes exceed [`MAX_RAW_FILE`].
    RawFileTooLarge { size: u64, limit: u64 },
    /// Cumulative decompressed bytes exceed [`MAX_DECOMPRESSED_TOTAL`] (counted, not declared).
    DecompressedTooLarge { limit: u64 },
    /// Zip entry count exceeds [`MAX_ENTRY_COUNT`].
    TooManyEntries { count: usize, limit: usize },
    /// Table-in-table nesting exceeds [`MAX_TABLE_NESTING`].
    TableNestingTooDeep { depth: usize, limit: usize },
    /// Paragraph count exceeds [`MAX_PARAGRAPHS`].
    TooManyParagraphs { count: usize, limit: usize },
    /// The rhwp (HWP5) adapter panicked and was caught at the boundary (`std::panic::catch_unwind`).
    /// The vendored parser cannot be fixed in-tree, so a panic is surfaced as this explicit error.
    Panicked,
}

impl std::fmt::Display for DocLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocLimit::RawFileTooLarge { size, limit } => {
                write!(f, "raw file too large: {size} bytes > {limit} limit")
            }
            DocLimit::DecompressedTooLarge { limit } => {
                write!(f, "decompressed size exceeds {limit}-byte limit")
            }
            DocLimit::TooManyEntries { count, limit } => {
                write!(f, "too many zip entries: {count} > {limit} limit")
            }
            DocLimit::TableNestingTooDeep { depth, limit } => {
                write!(f, "table nesting too deep: {depth} > {limit} limit")
            }
            DocLimit::TooManyParagraphs { count, limit } => {
                write!(f, "too many paragraphs: {count} > {limit} limit")
            }
            DocLimit::Panicked => write!(f, "parser panicked (caught at rhwp boundary)"),
        }
    }
}

impl std::error::Error for DocLimit {}

/// The outcome of a **hardened open**: either a typed limit was hit / the parser panicked
/// ([`DocLimit`]), or the input was malformed and the underlying parser rejected it fast
/// ([`HardenedError::Malformed`]). A service distinguishes "abusive/over-limit" (→ [`Self::Limit`])
/// from "just a bad file" (→ [`Self::Malformed`]) by the variant. `Malformed` carries the parser's
/// own detail string — that is genuine unstructured detail, NOT a limit masquerading as a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HardenedError {
    Limit(DocLimit),
    Malformed(String),
}

impl std::fmt::Display for HardenedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HardenedError::Limit(l) => write!(f, "{l}"),
            HardenedError::Malformed(s) => write!(f, "malformed document: {s}"),
        }
    }
}

impl std::error::Error for HardenedError {}

impl From<DocLimit> for HardenedError {
    fn from(l: DocLimit) -> Self {
        HardenedError::Limit(l)
    }
}

// ---------------------------------------------------------------------------
// Boundary predicates (called from the parser entry points).
// ---------------------------------------------------------------------------

/// Reject a raw input larger than [`MAX_RAW_FILE`]. Call BEFORE any parse/decompress.
pub fn check_raw_size(len: usize) -> Result<(), DocLimit> {
    let size = len as u64;
    if size > MAX_RAW_FILE {
        return Err(DocLimit::RawFileTooLarge { size, limit: MAX_RAW_FILE });
    }
    Ok(())
}

/// Reject an archive with more than [`MAX_ENTRY_COUNT`] entries. Call right after the zip central
/// directory is read (the zip crate reads it eagerly at `ZipArchive::new`).
pub fn check_entry_count(count: usize) -> Result<(), DocLimit> {
    if count > MAX_ENTRY_COUNT {
        return Err(DocLimit::TooManyEntries { count, limit: MAX_ENTRY_COUNT });
    }
    Ok(())
}

/// Reject cumulative decompressed bytes above [`MAX_DECOMPRESSED_TOTAL`]. `total` MUST be the
/// **actual** number of bytes produced by inflation so far — never a declared entry size.
pub fn check_decompressed_total(total: u64) -> Result<(), DocLimit> {
    if total > MAX_DECOMPRESSED_TOTAL {
        return Err(DocLimit::DecompressedTooLarge { limit: MAX_DECOMPRESSED_TOTAL });
    }
    Ok(())
}

/// Reject opening one more table level when already at [`MAX_TABLE_NESTING`]. `current_depth` is the
/// number of tables currently open (e.g. the parser's table-frame stack depth) BEFORE pushing the
/// new one. Called in the quick-xml event loop on each `<hp:tbl>` start — this is the concrete
/// "XML depth counter" for the only nesting that grows unbounded structures (a generic per-element
/// depth cap is unnecessary: the HWPX parser is iterative, so non-table nesting neither recurses nor
/// accumulates, and a single legitimate table already sits ~10 XML levels deep).
pub fn check_table_nesting(current_depth: usize) -> Result<(), DocLimit> {
    if current_depth >= MAX_TABLE_NESTING {
        return Err(DocLimit::TableNestingTooDeep {
            depth: current_depth + 1,
            limit: MAX_TABLE_NESTING,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Layout guard (EXPOSE ONLY — wiring is issue 013).
// ---------------------------------------------------------------------------

/// Post-parse guard: a document that survives parsing can still blow up **layout** (hundreds of
/// thousands of paragraphs, or a pathologically nested table that the HWP5 lift produced without
/// going through the HWPX parse-time [`check_table_nesting`]). This counts paragraphs (top-level +
/// cell) and table nesting depth **iteratively** (an explicit work stack, so counting a hostile
/// deep document cannot itself overflow the stack) and fails with [`DocLimit::TooManyParagraphs`] /
/// [`DocLimit::TableNestingTooDeep`].
///
/// It is a standalone predicate over `&SemanticDoc` and is **NOT wired** anywhere yet — per the
/// #014/#010 split, the callers below live in files owned by issue 010, so wiring is deferred to
/// **issue 013**. Eventual wiring sites (do NOT enforce inside `hwp-typeset::place_doc` /
/// `NaiveLayout` — one-sided limits there diverge the LOCKSTEP page counts the oracle depends on):
///   * `hwp_core::Engine::open`            — crates/hwp-core/src/lib.rs:52
///   * mcp open path                       — crates/hwp-mcp/src/lib.rs (~417, `fs::read`+`detect`)
///   * viewer `own_page_count`             — crates/hwp-viewer/src/lib.rs:146
pub fn check_layout_limits(doc: &SemanticDoc) -> Result<(), DocLimit> {
    let mut paragraphs = 0usize;
    // Work stack of (block, table-nesting-depth). depth 0 = top-level; each descent INTO a table's
    // cells is one level deeper. Iterative on purpose: no recursion ⇒ no stack overflow on a
    // hostile deep document.
    let mut stack: Vec<(&Block, usize)> = Vec::new();
    for sec in &doc.sections {
        for b in &sec.blocks {
            stack.push((b, 0));
        }
    }
    while let Some((b, depth)) = stack.pop() {
        if depth > MAX_TABLE_NESTING {
            return Err(DocLimit::TableNestingTooDeep { depth, limit: MAX_TABLE_NESTING });
        }
        match b {
            Block::Paragraph(_) => {
                paragraphs += 1;
                if paragraphs > MAX_PARAGRAPHS {
                    return Err(DocLimit::TooManyParagraphs {
                        count: paragraphs,
                        limit: MAX_PARAGRAPHS,
                    });
                }
            }
            Block::Table(t) => {
                for cell in &t.cells {
                    for cb in &cell.blocks {
                        stack.push((cb, depth + 1));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_model::document::{Cell, Paragraph, Section, Table};

    #[test]
    fn raw_size_and_entry_and_decomp_predicates() {
        assert!(check_raw_size(0).is_ok());
        assert!(check_raw_size(MAX_RAW_FILE as usize).is_ok());
        assert_eq!(
            check_raw_size(MAX_RAW_FILE as usize + 1),
            Err(DocLimit::RawFileTooLarge { size: MAX_RAW_FILE + 1, limit: MAX_RAW_FILE })
        );
        assert!(check_entry_count(MAX_ENTRY_COUNT).is_ok());
        assert!(matches!(
            check_entry_count(MAX_ENTRY_COUNT + 1),
            Err(DocLimit::TooManyEntries { .. })
        ));
        assert!(check_decompressed_total(MAX_DECOMPRESSED_TOTAL).is_ok());
        assert!(matches!(
            check_decompressed_total(MAX_DECOMPRESSED_TOTAL + 1),
            Err(DocLimit::DecompressedTooLarge { .. })
        ));
    }

    #[test]
    fn table_nesting_predicate_allows_up_to_max() {
        // depths 0..MAX are OK (about to open level 1..MAX); at MAX, opening MAX+1 is rejected.
        for d in 0..MAX_TABLE_NESTING {
            assert!(check_table_nesting(d).is_ok(), "depth {d} ok");
        }
        assert!(matches!(
            check_table_nesting(MAX_TABLE_NESTING),
            Err(DocLimit::TableNestingTooDeep { .. })
        ));
    }

    #[test]
    fn layout_guard_counts_paragraphs_including_cells() {
        let mut doc = SemanticDoc::default();
        let mut sec = Section::default();
        // 2 top-level paragraphs + a table with a cell holding 1 paragraph = 3 paragraphs.
        sec.blocks.push(Block::Paragraph(Paragraph::default()));
        sec.blocks.push(Block::Paragraph(Paragraph::default()));
        let mut cell = Cell::default();
        cell.blocks.push(Block::Paragraph(Paragraph::default()));
        let mut table = Table::default();
        table.cells.push(cell);
        sec.blocks.push(Block::Table(table));
        doc.sections.push(sec);
        assert!(check_layout_limits(&doc).is_ok());
    }

    #[test]
    fn layout_guard_rejects_deeply_nested_tables_without_overflowing() {
        // Build a table nested MAX_TABLE_NESTING+2 levels deep; the iterative guard must reject it
        // (and, being iterative, never recurse/overflow while counting).
        let mut inner = Table::default();
        let mut cell = Cell::default();
        cell.blocks.push(Block::Paragraph(Paragraph::default()));
        inner.cells.push(cell);
        for _ in 0..(MAX_TABLE_NESTING + 2) {
            let mut c = Cell::default();
            c.blocks.push(Block::Table(inner));
            let mut t = Table::default();
            t.cells.push(c);
            inner = t;
        }
        let mut doc = SemanticDoc::default();
        let mut sec = Section::default();
        sec.blocks.push(Block::Table(inner));
        doc.sections.push(sec);
        assert!(matches!(
            check_layout_limits(&doc),
            Err(DocLimit::TableNestingTooDeep { .. })
        ));
    }
}
