// TEMPORARY probe — measures cell-paragraph space_before/space_after impact. Deleted after run.
use hwp_model::document::{Block, SemanticDoc};
use hwp_typeset::{table_height, ApproxFontMetrics};

fn para_sbsa(doc: &SemanticDoc, ps_idx: usize) -> (i64, i64) {
    let ps = doc.para_shapes.get(ps_idx);
    (
        ps.map(|s| s.space_before as i64).unwrap_or(0),
        ps.map(|s| s.space_after as i64).unwrap_or(0),
    )
}

// Recursively zero sb/sa on EVERY paragraph that lives inside a table cell (clone+repoint so shared
// para_shapes used by body paragraphs are untouched).
fn zero_cell_spacing(doc: &mut SemanticDoc) {
    // collect existing len to append zeroed shapes
    let mut sections = std::mem::take(&mut doc.sections);
    for sec in &mut sections {
        for b in &mut sec.blocks {
            if let Block::Table(t) = b {
                zero_table(doc, t);
            }
        }
    }
    doc.sections = sections;
}

fn zero_table(doc: &mut SemanticDoc, t: &mut hwp_model::document::Table) {
    for c in &mut t.cells {
        for b in &mut c.blocks {
            match b {
                Block::Paragraph(p) => {
                    let mut ps = doc.para_shapes.get(p.para_shape).cloned().unwrap_or_default();
                    ps.space_before = 0;
                    ps.space_after = 0;
                    doc.para_shapes.push(ps);
                    p.para_shape = doc.para_shapes.len() - 1;
                }
                Block::Table(inner) => zero_table(doc, inner),
            }
        }
    }
}

#[test]
fn probe_cell_spacing() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmarks/benchmark1.hwpx")).unwrap();
    let doc = hwp_core::Engine::open(&bytes).unwrap();
    let fonts = ApproxFontMetrics;

    // --- 1. census of cell vs body paragraph spacing ---
    let mut body_paras = 0usize;
    let mut body_nonzero = 0usize;
    let mut cell_paras = 0usize;
    let mut cell_nonzero = 0usize;
    let mut cell_sb_total = 0i64;
    let mut cell_sa_total = 0i64;
    let mut cell_vals: std::collections::BTreeMap<(i64, i64), usize> = Default::default();

    fn walk_cell(doc: &SemanticDoc, blocks: &[Block], cp: &mut usize, cnz: &mut usize,
                 sb_t: &mut i64, sa_t: &mut i64, vals: &mut std::collections::BTreeMap<(i64,i64),usize>) {
        for b in blocks {
            match b {
                Block::Paragraph(p) => {
                    *cp += 1;
                    let (sb, sa) = para_sbsa(doc, p.para_shape);
                    *sb_t += sb; *sa_t += sa;
                    if sb != 0 || sa != 0 { *cnz += 1; }
                    *vals.entry((sb, sa)).or_default() += 1;
                }
                Block::Table(t) => {
                    for c in &t.cells { walk_cell(doc, &c.blocks, cp, cnz, sb_t, sa_t, vals); }
                }
            }
        }
    }

    for sec in &doc.sections {
        for b in &sec.blocks {
            match b {
                Block::Paragraph(p) => {
                    body_paras += 1;
                    let (sb, sa) = para_sbsa(&doc, p.para_shape);
                    if sb != 0 || sa != 0 { body_nonzero += 1; }
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        walk_cell(&doc, &c.blocks, &mut cell_paras, &mut cell_nonzero,
                                  &mut cell_sb_total, &mut cell_sa_total, &mut cell_vals);
                    }
                }
            }
        }
    }

    eprintln!("=== CENSUS (benchmark1.hwpx) ===");
    eprintln!("top-level body paragraphs: {body_paras} ({body_nonzero} have nonzero sb/sa)");
    eprintln!("cell paragraphs:           {cell_paras} ({cell_nonzero} have nonzero sb/sa)");
    eprintln!("cell sb total = {cell_sb_total} HWPUNIT, cell sa total = {cell_sa_total} HWPUNIT");
    eprintln!("cell (sb,sa) distribution:");
    for ((sb, sa), n) in &cell_vals {
        eprintln!("   sb={sb:>6} sa={sa:>6}  ×{n}");
    }

    // --- 2. per-table row-height inflation from cell sb/sa ---
    // body width from first section page setup
    let page = &doc.sections[0].page;
    let body_w = (page.width - page.margin_left - page.margin_right).max(1) as f64;
    let body_h = (page.height - page.margin_top - page.margin_bottom).max(1) as f64;
    eprintln!("\nbody_w={body_w} body_h={body_h} HWPUNIT");

    let mut zeroed = doc.clone();
    zero_cell_spacing(&mut zeroed);

    let mut tbl_idx = 0usize;
    let mut total_with = 0.0f64;
    let mut total_without = 0.0f64;
    for (si, sec) in doc.sections.iter().enumerate() {
        let zsec = &zeroed.sections[si];
        for (bi, b) in sec.blocks.iter().enumerate() {
            if let Block::Table(t) = b {
                let h_with = table_height(t, body_w, &doc, &fonts);
                let zt = if let Block::Table(zt) = &zsec.blocks[bi] { zt } else { unreachable!() };
                let h_without = table_height(zt, body_w, &zeroed, &fonts);
                total_with += h_with;
                total_without += h_without;
                let infl = h_with - h_without;
                if infl.abs() > 1.0 {
                    eprintln!("table#{tbl_idx} ({}x{}, {} cells): with={:.0} without={:.0}  inflation={:.0} HWPUNIT ({:.2} body-pages)",
                        t.rows, t.cols, t.cells.iter().filter(|c| c.active).count(),
                        h_with, h_without, infl, infl / body_h);
                }
                tbl_idx += 1;
            }
        }
    }
    eprintln!("\nTOTAL table height: with cell sb/sa={:.0}  without={:.0}  inflation={:.0} HWPUNIT ({:.2} body-pages)",
        total_with, total_without, total_with - total_without, (total_with - total_without) / body_h);

    // --- 3. page-count impact ---
    let pages_orig = hwp_core::own_page_count(&doc);
    let pages_zeroed = hwp_core::own_page_count(&zeroed);
    eprintln!("\n=== PAGE IMPACT ===");
    eprintln!("own_page_count WITH cell sb/sa:    {pages_orig}");
    eprintln!("own_page_count WITHOUT cell sb/sa: {pages_zeroed}");
    eprintln!("Hancom reference (benchmark1.pdf): 18");
}
