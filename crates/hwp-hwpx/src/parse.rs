//! OWPML (HWPX) → `SemanticDoc` parser — our own, rhwp-free (the round-trip moat).
//!
//! Subset (M3/M4 foundation): sections → paragraphs (`hp:p`/`hp:run`/`hp:t` text) and
//! tables (`hp:tbl`/`hp:tr`/`hp:tc` with `cellAddr`/`cellSpan` → cell paragraphs). Nesting
//! (table-in-paragraph, paragraph-in-cell) is handled via an explicit block stack. Deeper
//! fidelity (charPr/paraPr pools, images, equations, full passthrough) grows from here.

use crate::package::Package;
use hwp_ingest::limits::{self, DocLimit, HardenedError};
use hwp_model::prelude::*;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

fn hwpx_prov() -> Provenance {
    Provenance {
        source: Some(SourceFormat::Hwpx),
        raw: None,
    }
}

/// Tag under which the whole original HWPX file is retained for verbatim round-trip.
pub const SOURCE_PART_TAG: &str = "hwpx:source";

/// Parse an HWPX byte buffer into a `SemanticDoc`.
///
/// Round-trip provenance: the entire original file is retained (`SOURCE_PART_TAG`) and each
/// `Section.provenance.raw` holds its original section XML, so the serializer can re-emit
/// untouched parts byte-verbatim and patch only dirty sections.
pub fn parse_semantic(bytes: &[u8]) -> Result<SemanticDoc> {
    let pkg = Package::open(bytes)?;
    let mut doc = SemanticDoc::default();
    // Reserve index 0 as the DEFAULT shape: parsed runs/paragraphs reference index 0 (→ "use the
    // original charPrIDRef/paraPrIDRef, no synthesis"). Op-bus interning therefore allocates edited
    // shapes at index ≥1, so an in-place edit never collides with the unedited runs' index 0.
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    // P1 (#003): parse the existing header.xml charPr/paraPr pools into typed values, so the editor
    // can read an existing run/paragraph's formatting (e.g. to toggle bold) and the serializer can
    // dedup against real pool entries.
    if let Some(h) = pkg.read_header() {
        doc.header_pools = crate::synth::parse_header_pools(&String::from_utf8_lossy(&h));
    }
    // Batch C (#196): resolve each table/cell against the borderFill pool DURING parse (it needs both
    // the pool AND the section XML's cellSz/borderFillIDRef, only available here). Cloned so the
    // `doc.sections.push` borrow below doesn't conflict with reading `doc.header_pools`.
    let border_pool = doc.header_pools.border.clone();
    doc.passthrough.push(SOURCE_PART_TAG, bytes.to_vec());
    for name in pkg.section_part_names() {
        // `raw` MUST be the exact bytes the reader sees, so per-paragraph byte spans (captured in
        // parse_section) index correctly into it for surgical in-place re-emit.
        let text = String::from_utf8_lossy(&pkg.read_part(&name)?).into_owned();
        let mut section = Section {
            provenance: Provenance {
                source: Some(SourceFormat::Hwpx),
                raw: Some(text.clone().into_bytes()),
            },
            ..Default::default()
        };
        // Table-nesting guard (#014): a pathologically nested table is rejected as a fast, explicit
        // error rather than building an unbounded structure. Legacy path folds it into Error::Parse.
        parse_section(&text, &mut section.blocks, &border_pool)
            .map_err(|l| Error::Parse(l.to_string()))?;
        // Batch B (#196): the real page geometry (size/margins) drives body width/height → correct
        // pagination. Left un-edited (`page_edited` stays false) so the secPr round-trips verbatim.
        if let Some(pg) = parse_page_setup(&text) {
            section.page = pg;
        }
        doc.sections.push(section);
    }
    // Batch A (#196): resolve each run's charPrIDRef / paragraph's paraPrIDRef against the parsed
    // header pools so layout/render read the real formatting (was: all default index 0).
    resolve_shape_pools(&mut doc);
    // Batch D (#196): resolve `<hp:pic>` binary refs → doc.bin_data so the shared renderer embeds the
    // real photos (before: HWPX images never rendered — only .hwp lift populated bin_data).
    resolve_bin_data(&pkg, &mut doc);
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Hardened variant of [`parse_semantic`] for **untrusted** input (issue #014; the service path,
/// 013 wires it). Mirrors `parse_semantic` byte-for-byte in what it produces, but every boundary
/// fails with the typed [`HardenedError`] (so a service switches on the variant): raw-size /
/// entry-count / cumulative-decompression caps via [`Package::open_guarded`] + `read_part_guarded`,
/// and the table-nesting cap via [`parse_section`]. A parsed doc still owes the caller a
/// post-parse [`limits::check_layout_limits`] pass before layout (that guard is un-wired here per
/// the #010/#013 split — see its docs).
pub fn parse_semantic_guarded(bytes: &[u8]) -> std::result::Result<SemanticDoc, HardenedError> {
    let pkg = Package::open_guarded(bytes)?;
    let mut doc = SemanticDoc::default();
    // Reserve index 0 as the DEFAULT shape (see `parse_semantic`).
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    if let Some(name) = pkg.header_part_name() {
        if let Ok(h) = pkg.read_part_guarded(&name) {
            doc.header_pools = crate::synth::parse_header_pools(&String::from_utf8_lossy(&h));
        }
    }
    let border_pool = doc.header_pools.border.clone();
    doc.passthrough.push(SOURCE_PART_TAG, bytes.to_vec());
    for name in pkg.section_part_names() {
        let raw = pkg.read_part_guarded(&name)?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let mut section = Section {
            provenance: Provenance {
                source: Some(SourceFormat::Hwpx),
                raw: Some(text.clone().into_bytes()),
            },
            ..Default::default()
        };
        parse_section(&text, &mut section.blocks, &border_pool).map_err(HardenedError::Limit)?;
        if let Some(pg) = parse_page_setup(&text) {
            section.page = pg;
        }
        doc.sections.push(section);
    }
    resolve_shape_pools(&mut doc);
    resolve_bin_data(&pkg, &mut doc);
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Batch D (#196): resolve every `<hp:pic>`'s `binaryItemIDRef` → its embedded bytes in
/// `doc.bin_data`, so the shared renderer/HTML export embed the real photo. The `binaryItemIDRef`
/// (e.g. `"image1"`) maps to a package part via `content.hpf`'s `<opf:item id href>` manifest
/// (Hancom writes the BinData parts at the package root, e.g. `BinData/image1.bmp`). Best-effort:
/// an unresolved / unreadable / external image is simply skipped (the pic renders as its stub box).
fn resolve_bin_data(pkg: &Package, doc: &mut SemanticDoc) {
    let mut refs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for sec in &doc.sections {
        collect_image_refs(&sec.blocks, &mut refs);
    }
    if refs.is_empty() {
        return;
    }
    // content.hpf `<opf:item id=".." href="..">` → id→href map.
    let Some(hpf_name) = pkg
        .part_names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("content.hpf"))
    else {
        return;
    };
    let Ok(hpf) = pkg.read_part(hpf_name) else {
        return;
    };
    let hpf = String::from_utf8_lossy(&hpf);
    let mut href_of: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut idx = 0;
    while let Some(p) = hpf[idx..].find("<opf:item ") {
        let start = idx + p;
        let Some(rel) = hpf[start..].find('>') else {
            break;
        };
        let tag = &hpf[start..start + rel];
        idx = start + rel + 1;
        if let (Some(id), Some(href)) = (opf_attr(tag, "id"), opf_attr(tag, "href")) {
            href_of.insert(id.to_string(), href.to_string());
        }
    }
    for id in refs {
        let Some(href) = href_of.get(&id) else {
            continue;
        };
        let Ok(bytes) = pkg.read_part(href) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let kind = href
            .rsplit('.')
            .next()
            .filter(|e| !e.is_empty() && e.len() <= 5)
            .unwrap_or("png")
            .to_ascii_lowercase();
        doc.bin_data.push(BinData {
            bin_ref: id,
            bytes,
            kind,
        });
    }
}

/// Collect the `bin_ref` of every `Inline::Image` (recursing into tables + note bodies).
fn collect_image_refs(blocks: &[Block], out: &mut std::collections::BTreeSet<String>) {
    for b in blocks {
        match b {
            Block::Paragraph(p) => {
                for r in &p.runs {
                    for inl in &r.content {
                        match inl {
                            Inline::Image(im) => {
                                out.insert(im.bin_ref.clone());
                            }
                            Inline::Note(nr) => collect_image_refs(&nr.body, out),
                            _ => {}
                        }
                    }
                }
            }
            Block::Table(t) => {
                for c in &t.cells {
                    collect_image_refs(&c.blocks, out);
                }
            }
        }
    }
}

/// First `{name}="…"` value in an `<opf:item …>` open tag.
fn opf_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let s = tag.find(&pat)? + pat.len();
    let e = tag[s..].find('"')? + s;
    Some(&tag[s..e])
}

/// Assign stable in-memory `NodeId`s to top-level (editable) paragraphs — addressing for in-place
/// edit ops. Derived from document order (not the XML id), so they are stable across a re-parse.
/// Cell paragraphs (source=None) stay unaddressed.
fn assign_node_ids(doc: &mut SemanticDoc) {
    let mut next = 1u64;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            if let Block::Paragraph(p) = b {
                if p.source.is_some() {
                    p.id = Some(NodeId(next));
                    next += 1;
                }
            }
        }
    }
}

/// Batch A (#196): wire the already-parsed `header.xml` charPr/paraPr POOLS into the IR. For every
/// run (all sections + nested cells) resolve its `charPrIDRef` against `header_pools.char`, and for
/// every paragraph resolve its `paraPrIDRef` against `header_pools.para`; intern the resolved shape
/// into `doc.char_shapes`/`doc.para_shapes` (dedup by value) and point the run/paragraph at it, so
/// layout/render read the REAL size/color/bold/align/indent/spacing (before: every run rendered
/// 10pt black + every paragraph left-aligned/no-indent → wrong layout AND pagination).
///
/// Each interned index is recorded in `hwpx_pool_{char,para}_shapes`; the serializer consults these
/// to re-emit an UNEDITED run/paragraph's ORIGINAL IDRef instead of a lossy re-synthesized copy
/// (round-trip moat). A run/paragraph whose ref is absent from the pool keeps index 0 (the default).
fn resolve_shape_pools(doc: &mut SemanticDoc) {
    // Distinct-field borrows: the walk mutates blocks + the shape pools while READING header_pools.
    let SemanticDoc {
        sections,
        char_shapes,
        para_shapes,
        header_pools,
        hwpx_pool_char_shapes,
        hwpx_pool_para_shapes,
        ..
    } = doc;
    for sec in sections.iter_mut() {
        resolve_blocks(
            &mut sec.blocks,
            char_shapes,
            para_shapes,
            &header_pools.char,
            &header_pools.para,
            hwpx_pool_char_shapes,
            hwpx_pool_para_shapes,
        );
    }
}

/// Intern `shape` into `pool` (reusing an equal existing entry), returning its index.
fn intern_shape<T: Clone + PartialEq>(pool: &mut Vec<T>, shape: T) -> usize {
    if let Some(i) = pool.iter().position(|s| *s == shape) {
        return i;
    }
    pool.push(shape);
    pool.len() - 1
}

#[allow(clippy::too_many_arguments)]
fn resolve_blocks(
    blocks: &mut [Block],
    char_shapes: &mut Vec<CharShape>,
    para_shapes: &mut Vec<ParaShape>,
    char_pool: &std::collections::BTreeMap<u64, CharShape>,
    para_pool: &std::collections::BTreeMap<u64, ParaShape>,
    pool_c: &mut std::collections::BTreeSet<usize>,
    pool_p: &mut std::collections::BTreeSet<usize>,
) {
    for b in blocks.iter_mut() {
        match b {
            Block::Paragraph(p) => {
                if let Some(shape) = p
                    .para_ref
                    .as_deref()
                    .and_then(|r| r.trim().parse::<u64>().ok())
                    .and_then(|id| para_pool.get(&id))
                {
                    let idx = intern_shape(para_shapes, shape.clone());
                    p.para_shape = idx;
                    pool_p.insert(idx);
                }
                for run in &mut p.runs {
                    if let Some(shape) = run
                        .char_ref
                        .as_deref()
                        .and_then(|r| r.trim().parse::<u64>().ok())
                        .and_then(|id| char_pool.get(&id))
                    {
                        let idx = intern_shape(char_shapes, shape.clone());
                        run.char_shape = idx;
                        pool_c.insert(idx);
                    }
                    // Recurse into any note bodies (defensive — HWPX-in has none today).
                    for inl in &mut run.content {
                        if let Inline::Note(nr) = inl {
                            resolve_blocks(
                                &mut nr.body,
                                char_shapes,
                                para_shapes,
                                char_pool,
                                para_pool,
                                pool_c,
                                pool_p,
                            );
                        }
                    }
                }
            }
            Block::Table(t) => {
                for c in &mut t.cells {
                    resolve_blocks(
                        &mut c.blocks,
                        char_shapes,
                        para_shapes,
                        char_pool,
                        para_pool,
                        pool_c,
                        pool_p,
                    );
                }
            }
        }
    }
}

/// Batch B (#196): read a section's `<hp:secPr>` page geometry — `<hp:pagePr>` width/height +
/// orientation and the page `<hp:margin>` left/right/top/bottom (HWPUNIT) — into a [`PageSetup`],
/// so body width/height (and pagination) are correct. Columns are left at 1 (the default; the
/// typesetter does not split columns yet). `None` when the section has no `<hp:pagePr>`.
fn parse_page_setup(sec_xml: &str) -> Option<PageSetup> {
    let pp = sec_xml.find("<hp:pagePr")?;
    // Bound attr reads to the pagePr OPEN tag (up to its first '>').
    let pp_end = sec_xml[pp..].find('>')? + pp;
    let pp_tag = &sec_xml[pp..pp_end];
    let mut page = PageSetup::default();
    if let Some(w) = tag_attr_i32(pp_tag, "width") {
        page.width = w;
    }
    if let Some(h) = tag_attr_i32(pp_tag, "height") {
        page.height = h;
    }
    // `landscape` is unreliable across authoring tools (portrait docs are sometimes tagged WIDELY);
    // derive the actual orientation from the dimensions, which is all layout consumes.
    page.landscape = page.width > page.height;
    // The page `<hp:margin …/>` lives inside `<hp:pagePr>`; take the first one AFTER the pagePr open.
    if let Some(mrel) = sec_xml[pp_end..].find("<hp:margin") {
        let mstart = pp_end + mrel;
        if let Some(mend_rel) = sec_xml[mstart..].find("/>") {
            let mtag = &sec_xml[mstart..mstart + mend_rel];
            if let Some(v) = tag_attr_i32(mtag, "left") {
                page.margin_left = v;
            }
            if let Some(v) = tag_attr_i32(mtag, "right") {
                page.margin_right = v;
            }
            if let Some(v) = tag_attr_i32(mtag, "top") {
                page.margin_top = v;
            }
            if let Some(v) = tag_attr_i32(mtag, "bottom") {
                page.margin_bottom = v;
            }
        }
    }
    Some(page)
}

/// The `i32` value of attribute `name` (its first occurrence) within a single XML tag substring.
fn tag_attr_i32(tag: &str, name: &str) -> Option<i32> {
    let pat = format!("{name}=\"");
    let s = tag.find(&pat)? + pat.len();
    let e = tag[s..].find('"')? + s;
    tag[s..e].trim().parse().ok()
}

struct TblFrame {
    table: Table,
    cell: Option<Cell>,
    /// Byte offset of this table's `<hp:tbl` within the section XML (span start, issue 057).
    start: usize,
    /// Byte offset of the in-progress cell's `<hp:tc` (span start, issue 057).
    cell_start: usize,
    /// Table's own `borderFillIDRef` (표 외곽 테두리) — resolved to `Table::borders` at `</hp:tbl>`.
    border_ref: Option<u64>,
    /// Per-cell geometry (cellAddr/cellSpan + `<hp:cellSz>`) → col_widths/row_heights at `</hp:tbl>`.
    geoms: Vec<CellGeom>,
    /// The in-progress cell's `borderFillIDRef` (Batch C) — reset at each `</hp:tc>`.
    cur_cell_border: Option<u64>,
    /// The in-progress cell's `<hp:cellSz width height>` (HWPUNIT) — reset at each `</hp:tc>`.
    cur_cell_sz: Option<(i32, i32)>,
    /// The in-progress cell's `hasMargin="1"` flag (its `<hp:cellMargin>` is its OWN padding).
    cur_cell_has_margin: bool,
    /// The in-progress cell's `<hp:cellMargin left right top bottom>` (HWPUNIT).
    cur_cell_margin: Option<[i32; 4]>,
}

impl TblFrame {
    fn new(table: Table, start: usize, border_ref: Option<u64>) -> Self {
        TblFrame {
            table,
            cell: None,
            start,
            cell_start: 0,
            border_ref,
            geoms: Vec::new(),
            cur_cell_border: None,
            cur_cell_sz: None,
            cur_cell_has_margin: false,
            cur_cell_margin: None,
        }
    }
}

/// One cell's grid geometry, captured during parse → the table's `col_widths`/`row_heights`
/// (issue #196 Batch C, mirroring the .hwp lift's `derive_col_widths`/`stored_row_heights`).
struct CellGeom {
    row: usize,
    col: usize,
    row_span: usize,
    col_span: usize,
    width: i32,
    height: i32,
}

/// Accumulator for one in-progress `<hp:pic>` — its display size + the referenced binary (D1).
#[derive(Default)]
struct PicAccum {
    bin_ref: Option<String>, // <hc:img binaryItemIDRef>
    width: i32,              // <hp:sz width> (HWPUNIT)
    height: i32,             // <hp:sz height>
}

/// Accumulator for one in-progress `<hp:p>` (runs + its source provenance).
#[derive(Default)]
struct ParaAccum {
    start: usize,                              // byte offset of `<hp:p` in the section XML
    para_pr: Option<String>,                   // paraPrIDRef
    style: Option<String>,                     // styleIDRef
    id: Option<String>,                        // XML id string
    simple: bool,                              // only hp:run/hp:t children seen so far
    runs: Vec<Run>,                            // flushed runs
    cur_run: Option<(Option<String>, String)>, // open run (charPrIDRef, text)
    pending_images: Vec<ImageRef>,             // <hp:pic>s parsed inside the open run (D1)
}

/// Parse one section's XML into `out`. Returns `Err(DocLimit::TableNestingTooDeep)` if table-in-
/// table nesting exceeds [`limits::MAX_TABLE_NESTING`] — the concrete "XML depth counter" for the
/// only nesting that grows unbounded structures. All other malformation is tolerated (best-effort
/// parse); the reader stops at the first hard error/EOF as before.
fn parse_section(
    xml: &str,
    out: &mut Vec<Block>,
    borders: &std::collections::BTreeMap<u64, BorderFillDef>,
) -> std::result::Result<(), DocLimit> {
    let mut reader = Reader::from_str(xml);
    // Stack of block containers (section, then nested table-cell sublists).
    let mut blocks: Vec<Vec<Block>> = vec![Vec::new()];
    let mut tbls: Vec<TblFrame> = Vec::new();
    // Stack of in-progress paragraphs (a cell paragraph nests inside a table inside an outer para).
    let mut paras: Vec<ParaAccum> = Vec::new();
    let mut in_t = false;
    // In-progress `<hp:pic>` (D1) — captures its display size + binary ref between pic open/close.
    let mut pic: Option<PicAccum> = None;

    loop {
        let pos_before = reader.buffer_position() as usize; // lands on '<' of the upcoming tag (qxml 0.37)
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    b"p" => paras.push(ParaAccum {
                        start: pos_before,
                        para_pr: attr_str(&e, b"paraPrIDRef"),
                        style: attr_str(&e, b"styleIDRef"),
                        id: attr_str(&e, b"id"),
                        simple: true,
                        ..Default::default()
                    }),
                    b"run" => {
                        if let Some(p) = paras.last_mut() {
                            flush_run(p);
                            p.cur_run = Some((attr_str(&e, b"charPrIDRef"), String::new()));
                        }
                    }
                    b"t" => in_t = true,
                    b"tbl" => {
                        // Depth counter (#014): `tbls.len()` IS the current table-nesting depth.
                        // Reject before pushing the level that would exceed the cap.
                        limits::check_table_nesting(tbls.len())?;
                        mark_not_simple(&mut paras);
                        let rows = attr_usize(&e, b"rowCnt").unwrap_or(0);
                        let cols = attr_usize(&e, b"colCnt").unwrap_or(0);
                        let border_ref = attr_u64(&e, b"borderFillIDRef");
                        tbls.push(TblFrame::new(
                            Table {
                                rows,
                                cols,
                                provenance: hwpx_prov(),
                                ..Default::default()
                            },
                            pos_before,
                            border_ref,
                        ));
                    }
                    b"tc" => {
                        blocks.push(Vec::new());
                        if let Some(f) = tbls.last_mut() {
                            f.cell = Some(Cell::default());
                            f.cell_start = pos_before;
                            // Batch C: the cell's borderFill + its own-margin flag (its
                            // `<hp:cellMargin>` is the cell's OWN padding only when hasMargin="1").
                            f.cur_cell_border = attr_u64(&e, b"borderFillIDRef");
                            f.cur_cell_has_margin = attr_usize(&e, b"hasMargin") == Some(1);
                            f.cur_cell_sz = None;
                            f.cur_cell_margin = None;
                        }
                    }
                    // D1: a `<hp:pic>` opens picture-capture mode (its `<hp:sz>` + `<hc:img>` fill a
                    // PicAccum; `</hp:pic>` builds the `Inline::Image`). Still a structural child →
                    // NOT re-emittable from the lossy AST, so the wrapping paragraph rides verbatim.
                    b"pic" => {
                        pic = Some(PicAccum::default());
                        mark_not_simple(&mut paras);
                    }
                    // Structural children (secPr/ctrl/equation/container/…) make a paragraph NOT
                    // re-emittable from the lossy AST. `linesegarray`/`lineseg` are layout CACHE —
                    // safely dropped + recomputed by Hancom — so they don't break `simple`.
                    other => {
                        if !matches!(other, b"linesegarray" | b"lineseg") {
                            mark_not_simple(&mut paras);
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) if pic.is_some() => {
                // D1: inside a `<hp:pic>`, capture the binary ref (`<hc:img binaryItemIDRef>`) and the
                // final display size (`<hp:sz width height>`). All pic children keep the paragraph
                // non-simple (verbatim re-emit) — never table geometry.
                match e.local_name().as_ref() {
                    b"img" => {
                        if let Some(p) = pic.as_mut() {
                            p.bin_ref = attr_str(&e, b"binaryItemIDRef");
                        }
                    }
                    b"sz" => {
                        if let Some(p) = pic.as_mut() {
                            if let Some(w) = attr_i32(&e, b"width") {
                                p.width = w;
                            }
                            if let Some(h) = attr_i32(&e, b"height") {
                                p.height = h;
                            }
                        }
                    }
                    _ => {}
                }
                mark_not_simple(&mut paras);
            }
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"t" => {} // empty `<hp:t/>` — keeps an empty run; not a simple-breaker
                b"cellAddr" => {
                    if let Some(c) = tbls.last_mut().and_then(|f| f.cell.as_mut()) {
                        c.col = attr_usize(&e, b"colAddr").unwrap_or(0);
                        c.row = attr_usize(&e, b"rowAddr").unwrap_or(0);
                    }
                }
                b"cellSpan" => {
                    if let Some(c) = tbls.last_mut().and_then(|f| f.cell.as_mut()) {
                        c.col_span = attr_usize(&e, b"colSpan").unwrap_or(1).max(1);
                        c.row_span = attr_usize(&e, b"rowSpan").unwrap_or(1).max(1);
                    }
                }
                // Batch C: the cell's laid-out size → its column-width/row-height contribution.
                b"cellSz" => {
                    if let Some(f) = tbls.last_mut() {
                        f.cur_cell_sz = Some((
                            attr_i32(&e, b"width").unwrap_or(0),
                            attr_i32(&e, b"height").unwrap_or(0),
                        ));
                    }
                }
                // Batch C: the cell's inner padding (applied at `</hp:tc>` only when hasMargin="1").
                b"cellMargin" => {
                    if let Some(f) = tbls.last_mut() {
                        f.cur_cell_margin = Some([
                            attr_i32(&e, b"left").unwrap_or(0),
                            attr_i32(&e, b"right").unwrap_or(0),
                            attr_i32(&e, b"top").unwrap_or(0),
                            attr_i32(&e, b"bottom").unwrap_or(0),
                        ]);
                    }
                }
                // Batch C: the table-DEFAULT cell padding (`<hp:inMargin>` sits before the first row,
                // so `f.cell` is None then; a picture's inMargin is handled by the pic arm above).
                b"inMargin" => {
                    if let Some(f) = tbls.last_mut() {
                        if f.cell.is_none() {
                            f.table.padding = Some([
                                attr_i32(&e, b"left").unwrap_or(0),
                                attr_i32(&e, b"right").unwrap_or(0),
                                attr_i32(&e, b"top").unwrap_or(0),
                                attr_i32(&e, b"bottom").unwrap_or(0),
                            ]);
                        }
                    }
                }
                // `<hp:lineseg/>` (inside linesegarray) is layout cache; everything else structural.
                other => {
                    if !matches!(other, b"lineseg" | b"linesegarray") {
                        mark_not_simple(&mut paras);
                    }
                }
            },
            Ok(Event::Text(e)) if in_t => {
                if let Some((_, t)) = paras.last_mut().and_then(|p| p.cur_run.as_mut()) {
                    t.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"run" => {
                    if let Some(p) = paras.last_mut() {
                        flush_run(p);
                    }
                }
                b"p" => {
                    if let Some(mut p) = paras.pop() {
                        flush_run(&mut p);
                        let end = reader.buffer_position() as usize; // just past `</hp:p>`
                                                                     // Top-level iff no enclosing paragraph remains.
                        let top_level = paras.is_empty();
                        let source = top_level.then(|| ParaSource {
                            span: (p.start, end),
                            para_pr: p.para_pr.clone(),
                            style: p.style.clone(),
                            id: p.id.clone(),
                            simple: p.simple,
                        });
                        if let Some(target) = blocks.last_mut() {
                            target.push(Block::Paragraph(Paragraph {
                                runs: p.runs,
                                // Capture paraPrIDRef for EVERY paragraph — not just top-level
                                // `source` — so nested cell paragraphs' align/indent/line-spacing
                                // resolve in the pool pass too.
                                para_ref: p.para_pr.clone(),
                                source,
                                provenance: hwpx_prov(),
                                ..Default::default()
                            }));
                        }
                    }
                }
                b"pic" => {
                    // D1: finish the picture → an `Inline::Image` on the current open run (its bytes
                    // are resolved from the package's BinData in a later pass). A pic without a binary
                    // ref (external/broken) is dropped.
                    if let Some(pa) = pic.take() {
                        if let Some(bin_ref) = pa.bin_ref.filter(|r| !r.is_empty()) {
                            if let Some(p) = paras.last_mut() {
                                p.pending_images.push(ImageRef {
                                    bin_ref,
                                    width: pa.width,
                                    height: pa.height,
                                });
                            }
                        }
                    }
                }
                b"tc" => {
                    let cell_blocks = blocks.pop().unwrap_or_default();
                    if let Some(f) = tbls.last_mut() {
                        if let Some(mut c) = f.cell.take() {
                            c.blocks = cell_blocks;
                            c.active = true;
                            // `[<hp:tc … </hp:tc>)` span for surgical in-place cell re-emit (057).
                            c.src_span = Some((f.cell_start, reader.buffer_position() as usize));
                            // Batch C: resolve the cell's borderFill → per-edge borders / shade /
                            // diagonal (the SAME fields the .hwp lift fills, so the shared renderer
                            // draws the cell identically). Own padding only when hasMargin="1".
                            if let Some(bf) = f.cur_cell_border.and_then(|id| borders.get(&id)) {
                                c.borders = bf.borders;
                                c.shade_color = bf.shade;
                                c.has_border = bf.has_border;
                                c.diagonal = bf.diagonal;
                            }
                            if f.cur_cell_has_margin {
                                c.padding = f.cur_cell_margin;
                            }
                            let (w, h) = f.cur_cell_sz.unwrap_or((0, 0));
                            f.geoms.push(CellGeom {
                                row: c.row,
                                col: c.col,
                                row_span: c.row_span.max(1),
                                col_span: c.col_span.max(1),
                                width: w,
                                height: h,
                            });
                            f.table.cells.push(c);
                        }
                        f.cur_cell_border = None;
                        f.cur_cell_sz = None;
                        f.cur_cell_has_margin = false;
                        f.cur_cell_margin = None;
                    }
                }
                b"tbl" => {
                    if let Some(mut f) = tbls.pop() {
                        // Batch C: real column widths + row-height floors from the captured cell
                        // geometry (equal-split was the wrong-proportion + mis-pagination culprit).
                        if f.table.cols > 0 {
                            f.table.col_widths = derive_col_widths_hwpx(&f.geoms, f.table.cols);
                        }
                        if f.table.rows > 0 {
                            f.table.row_heights = stored_row_heights_hwpx(&f.geoms, f.table.rows);
                        }
                        // The table's OWN outline borderFill (표 외곽 테두리).
                        if let Some(bf) = f.border_ref.and_then(|id| borders.get(&id)) {
                            f.table.borders = bf.borders;
                        }
                        // Record EVERY table's `[<hp:tbl … </hp:tbl>)` span — TOP-LEVEL and NESTED.
                        // Top-level: re-emit a dirty table at its original anchor instead of the
                        // section end (issue 057). Nested: a 1×1 frame wrapper's INNER table needs
                        // its own span too, because a table edit op marks only the inner table/cell
                        // dirty (never the outer wrapper) — so the serializer splices the inner
                        // table's dirty `<hp:tc>` spans in place and leaves the wrapper verbatim
                        // (issue 060). Nested spans index the SAME section XML buffer as top-level
                        // ones. Export provenance only — render/equality ignore it.
                        f.table.src_span = Some((f.start, reader.buffer_position() as usize));
                        if let Some(top) = blocks.last_mut() {
                            top.push(Block::Table(f.table));
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    if let Some(root) = blocks.first_mut() {
        out.append(root);
    }
    Ok(())
}

/// Push the open run (if any) into the paragraph's run list — empty-text runs are KEPT (dropping
/// them would shift run indices and misaddress per-run edits). Any `<hp:pic>`s parsed inside the run
/// (D1) ride along as `Inline::Image` after the text.
fn flush_run(p: &mut ParaAccum) {
    let images = std::mem::take(&mut p.pending_images);
    if let Some((char_ref, text)) = p.cur_run.take() {
        let mut content: Vec<Inline> = vec![Inline::Text(text)];
        content.extend(images.into_iter().map(Inline::Image));
        p.runs.push(Run {
            char_shape: 0,
            char_ref,
            content,
        });
    } else if !images.is_empty() {
        // A picture outside an explicit `<hp:run>` — emit it in its own run so it still renders.
        p.runs.push(Run {
            char_shape: 0,
            char_ref: None,
            content: images.into_iter().map(Inline::Image).collect(),
        });
    }
}

/// Per-column widths (HWPUNIT) from captured cell geometry (issue #196 Batch C). Single-column cells
/// give exact widths; a column that appears ONLY under a span gets the leftover (fixpoint); anything
/// still unresolved keeps the 1800 fallback. Mirrors the .hwp lift's `derive_col_widths`. Always
/// returns `cols` POSITIVE entries so `place::column_offsets` uses them (its all-`>0` guard).
fn derive_col_widths_hwpx(geoms: &[CellGeom], cols: usize) -> Vec<i32> {
    if cols == 0 {
        return Vec::new();
    }
    let mut w = vec![0i64; cols];
    let mut known = vec![false; cols];
    // 1) Single-column cells give exact column widths (max across rows).
    for g in geoms {
        if g.col_span <= 1 && g.col < cols && g.width > 0 {
            w[g.col] = w[g.col].max(g.width as i64);
            known[g.col] = true;
        }
    }
    // 2) Resolve span-only columns: a span's width minus its known columns, split among the unknown.
    let mut changed = true;
    while changed {
        changed = false;
        for g in geoms {
            let span = g.col_span.max(1);
            if span <= 1 || g.col >= cols {
                continue;
            }
            let end = (g.col + span).min(cols);
            let unknown: Vec<usize> = (g.col..end).filter(|&i| !known[i]).collect();
            if unknown.is_empty() {
                continue;
            }
            let known_sum: i64 = (g.col..end).filter(|&i| known[i]).map(|i| w[i]).sum();
            if (g.width as i64) <= known_sum {
                continue;
            }
            let each = (g.width as i64 - known_sum) / unknown.len() as i64;
            if each <= 0 {
                continue;
            }
            for &i in &unknown {
                w[i] = each;
                known[i] = true;
            }
            changed = true;
        }
    }
    w.iter()
        .map(|&x| if x <= 0 { 1800 } else { x as i32 })
        .collect()
}

/// Per-row minimum-height floors (HWPUNIT) from stored cell heights (issue #196 Batch C). Each cell
/// contributes `height / row_span` to every row it spans, max across cells — honored as a FLOOR by
/// `hwp_typeset::apply_row_overrides`. Mirrors the .hwp lift's `stored_row_heights` (a 0 leaves the
/// row content-sized).
fn stored_row_heights_hwpx(geoms: &[CellGeom], rows: usize) -> Vec<i32> {
    let mut row_h = vec![0i32; rows];
    for g in geoms {
        let span = g.row_span.max(1);
        let per = g.height / span as i32;
        if per <= 0 {
            continue;
        }
        let end = (g.row + span).min(rows);
        for slot in row_h.iter_mut().take(end).skip(g.row) {
            *slot = (*slot).max(per);
        }
    }
    row_h
}

/// Mark the innermost in-progress paragraph as non-re-emittable (it has structural children).
fn mark_not_simple(paras: &mut [ParaAccum]) {
    if let Some(p) = paras.last_mut() {
        p.simple = false;
    }
}

fn attr_usize(e: &BytesStart, name: &[u8]) -> Option<usize> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return std::str::from_utf8(&a.value).ok()?.trim().parse().ok();
        }
    }
    None
}

fn attr_str(e: &BytesStart, name: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}

fn attr_i32(e: &BytesStart, name: &[u8]) -> Option<i32> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return std::str::from_utf8(&a.value).ok()?.trim().parse().ok();
        }
    }
    None
}

fn attr_u64(e: &BytesStart, name: &[u8]) -> Option<u64> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return std::str::from_utf8(&a.value).ok()?.trim().parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paragraphs_and_table() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p">
          <hp:p><hp:run><hp:t>첫 문단</hp:t></hp:run></hp:p>
          <hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2">
            <hp:tr>
              <hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>
                <hp:subList><hp:p><hp:run><hp:t>셀A</hp:t></hp:run></hp:p></hp:subList></hp:tc>
              <hp:tc><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>
                <hp:subList><hp:p><hp:run><hp:t>셀B</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            </hp:tr>
          </hp:tbl></hp:run></hp:p>
        </hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &Default::default()).unwrap();
        // one paragraph + one table
        assert!(blocks.iter().any(|b| matches!(b, Block::Paragraph(_))));
        let tbl = blocks.iter().find_map(|b| match b {
            Block::Table(t) => Some(t),
            _ => None,
        });
        let tbl = tbl.expect("table parsed");
        assert_eq!((tbl.rows, tbl.cols), (1, 2));
        assert_eq!(tbl.cells.len(), 2);
        // cell text round-trips into the AST
        let doc_text = {
            let mut s = SemanticDoc::default();
            s.sections.push(Section {
                blocks,
                ..Default::default()
            });
            s.plain_text()
        };
        assert!(doc_text.contains("첫 문단"));
        assert!(doc_text.contains("셀A") && doc_text.contains("셀B"));
    }

    #[test]
    fn parse_in_makes_existing_formatting_readable() {
        // P1: parse_semantic fills header_pools; an existing bold/colored run is readable by value.
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/hwpx/FormattingShowcase.hwpx"
        );
        let doc = parse_semantic(&std::fs::read(p).unwrap()).unwrap();
        assert!(!doc.header_pools.char.is_empty(), "charPr pool parsed");
        assert!(!doc.header_pools.para.is_empty(), "paraPr pool parsed");
        // The showcase's "굵은 텍스트" run uses charPrIDRef 7 (bold + blue). Find a run with that ref
        // and confirm its formatting is now READABLE from the AST.
        let bold_ref = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(pp) => pp.runs.iter().find_map(|r| {
                let cr = r.char_ref.as_deref()?;
                let cs = doc.char_shape_of_ref(cr)?;
                cs.bold.then(|| cr.to_string())
            }),
            _ => None,
        });
        let cr = bold_ref.expect("found a run whose original charPr is bold");
        assert!(
            doc.char_shape_of_ref(&cr).unwrap().bold,
            "existing bold formatting is readable"
        );
    }

    #[test]
    fn captures_source_spans_refs_and_simple_flag() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="100" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가</hp:t></hp:run><hp:run charPrIDRef="7"><hp:t>나</hp:t></hp:run></hp:p><hp:p id="200" paraPrIDRef="3"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &Default::default()).unwrap();
        let paras: Vec<&Paragraph> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .collect();

        // First top-level paragraph: simple, 2 runs with their charPrIDRefs preserved, valid span.
        let p0 = paras[0];
        let src = p0.source.as_ref().expect("top-level para has source");
        assert!(src.simple, "text-only paragraph is simple");
        assert_eq!(src.para_pr.as_deref(), Some("3"));
        assert_eq!(src.id.as_deref(), Some("100"));
        let (s, e) = src.span;
        assert!(
            xml[s..e].starts_with("<hp:p ") && xml[s..e].ends_with("</hp:p>"),
            "tight span: {:?}",
            &xml[s..e]
        );
        assert_eq!(p0.runs.len(), 2, "runs split per <hp:run>");
        assert_eq!(p0.runs[0].char_ref.as_deref(), Some("0"));
        assert_eq!(p0.runs[1].char_ref.as_deref(), Some("7"));

        // Second top-level paragraph WRAPS a table → NOT simple (must never be re-emitted in place).
        let wrapper = paras
            .iter()
            .find(|p| p.source.as_ref().is_some_and(|sc| !sc.simple));
        assert!(wrapper.is_some(), "table-wrapping paragraph is non-simple");
    }

    /// Batch B (#196): `<hp:secPr>` page geometry (pagePr width/height + the page margin) fills a
    /// `PageSetup` — the body box (and pagination) is the real one, not the A4/1-inch default.
    #[test]
    fn parse_page_setup_reads_secpr_geometry() {
        let sec = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:ctrl><hp:secPr><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="5669" right="5670" top="4251" bottom="2834"/></hp:pagePr></hp:secPr></hp:ctrl></hp:run></hp:p></hs:sec>"#;
        let pg = parse_page_setup(sec).expect("secPr parsed into a PageSetup");
        assert_eq!((pg.width, pg.height), (59528, 84186));
        assert_eq!(pg.margin_left, 5669);
        assert_eq!(pg.margin_right, 5670);
        assert_eq!(pg.margin_top, 4251);
        assert_eq!(pg.margin_bottom, 2834);
        assert!(!pg.landscape, "portrait derived from width<height");
        // No secPr → None (the caller keeps PageSetup::default()).
        assert!(parse_page_setup("<hs:sec><hp:p/></hs:sec>").is_none());
    }

    /// Batch A (#196): the resolve pass points a run at the REAL charPr and a paragraph at the REAL
    /// paraPr from a two-entry pool (was: all index-0 default) — for TOP-LEVEL and NESTED CELL
    /// paragraphs — and records the interned indices so the serializer re-emits the original IDRef.
    #[test]
    fn resolve_wires_char_and_para_pools_incl_cell() {
        // A section: one top-level styled paragraph, and a 1×1 table whose cell paragraph is styled.
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t>본문</hp:t></hp:run></hp:p><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p paraPrIDRef="3"><hp:run charPrIDRef="5"><hp:t>셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &Default::default()).unwrap();

        // The CELL paragraph must have CAPTURED its paraPrIDRef (not just top-level ones).
        let cell_para = blocks.iter().find_map(|b| match b {
            Block::Table(t) => t.cells[0].blocks.iter().find_map(|cb| match cb {
                Block::Paragraph(p) => Some(p),
                _ => None,
            }),
            _ => None,
        });
        assert_eq!(
            cell_para.and_then(|p| p.para_ref.as_deref()),
            Some("3"),
            "nested cell paragraph captures its paraPrIDRef"
        );

        // Build a doc with a two-entry char pool + two-entry para pool (ids 0 default, 5/3 styled).
        let styled_char = CharShape {
            height: 1400,
            bold: true,
            text_color: Color::from_hex("#FF0000").unwrap(),
            ..Default::default()
        };
        let styled_para = ParaShape {
            align: HorizontalAlign::Center,
            ..Default::default()
        };
        let mut doc = SemanticDoc {
            char_shapes: vec![CharShape::default()],
            para_shapes: vec![ParaShape::default()],
            ..Default::default()
        };
        doc.header_pools.char.insert(0, CharShape::default());
        doc.header_pools.char.insert(5, styled_char.clone());
        doc.header_pools.para.insert(0, ParaShape::default());
        doc.header_pools.para.insert(3, styled_para.clone());
        doc.sections.push(Section {
            blocks,
            ..Default::default()
        });

        resolve_shape_pools(&mut doc);

        // Top-level paragraph + run now point at the REAL (non-default) shapes.
        let Block::Paragraph(top) = &doc.sections[0].blocks[0] else {
            panic!("first block is a paragraph");
        };
        assert_ne!(top.para_shape, 0, "para resolved off the default");
        assert_eq!(doc.para_shapes[top.para_shape], styled_para);
        assert_ne!(top.runs[0].char_shape, 0, "char resolved off the default");
        assert_eq!(doc.char_shapes[top.runs[0].char_shape], styled_char);
        assert!(doc.hwpx_pool_char_shapes.contains(&top.runs[0].char_shape));
        assert!(doc.hwpx_pool_para_shapes.contains(&top.para_shape));

        // The NESTED CELL paragraph resolved too (dedups to the same interned indices).
        let Block::Table(t) = &doc.sections[0].blocks[1] else {
            panic!("second block is the table");
        };
        let Block::Paragraph(cp) = &t.cells[0].blocks[0] else {
            panic!("cell holds a paragraph");
        };
        assert_eq!(doc.para_shapes[cp.para_shape], styled_para);
        assert_eq!(doc.char_shapes[cp.runs[0].char_shape], styled_char);

        // A run whose ref is ABSENT from the pool keeps the reserved default index 0.
        let mut doc2 = SemanticDoc {
            char_shapes: vec![CharShape::default()],
            para_shapes: vec![ParaShape::default()],
            ..Default::default()
        };
        doc2.sections.push(Section {
            blocks: vec![Block::Paragraph(Paragraph {
                para_ref: Some("99".into()),
                runs: vec![Run {
                    char_ref: Some("99".into()),
                    content: vec![Inline::Text("x".into())],
                    ..Default::default()
                }],
                ..Default::default()
            })],
            ..Default::default()
        });
        resolve_shape_pools(&mut doc2);
        let Block::Paragraph(p) = &doc2.sections[0].blocks[0] else {
            unreachable!()
        };
        assert_eq!(p.para_shape, 0, "absent paraPrIDRef → default");
        assert_eq!(p.runs[0].char_shape, 0, "absent charPrIDRef → default");
    }

    /// Batch A end-to-end (#196): opening a real HWPX now interns MULTIPLE distinct char shapes off
    /// the pool (sizes/colors), and at least one run points at a non-default shape — the render-side
    /// fix for "all text is 10pt black".
    #[test]
    fn resolve_end_to_end_interns_multiple_char_shapes() {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/hwpx/FormattingShowcase.hwpx"
        );
        let doc = parse_semantic(&std::fs::read(p).unwrap()).unwrap();
        // Index 0 stays the reserved default; real pool shapes interned above it.
        assert!(doc.char_shapes[0].is_default());
        assert!(
            doc.char_shapes.len() > 1,
            "pool char shapes interned: {}",
            doc.char_shapes.len()
        );
        let non_default_runs = doc.sections[0]
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(pp) => Some(pp),
                _ => None,
            })
            .flat_map(|pp| &pp.runs)
            .filter(|r| r.char_shape != 0)
            .count();
        assert!(
            non_default_runs > 0,
            "at least one run resolved to a non-default char shape"
        );
        // The interned shapes carry real variety (more than one distinct non-default size/color).
        let distinct_heights: std::collections::BTreeSet<i32> =
            doc.char_shapes.iter().map(|c| c.height).collect();
        assert!(
            distinct_heights.len() > 1,
            "multiple distinct font heights interned: {distinct_heights:?}"
        );
    }

    /// Batch C (#196): per-`<hp:cellSz>` widths build NON-EQUAL `col_widths` (was: equal split) — the
    /// root cause of wrong column proportions on the HWPX render.
    #[test]
    fn table_col_widths_from_cellsz_are_nonequal() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2"><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="3000" height="800"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &Default::default()).unwrap();
        let t = blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("table");
        assert_eq!(t.col_widths, vec![1000, 3000], "real per-column widths");
        assert_eq!(
            t.row_heights,
            vec![800],
            "row-height floor from tallest cell"
        );
    }

    /// Batch C: a cell resolves its `borderFillIDRef` against the border pool → per-edge borders,
    /// background shade, and the `has_border` flag (the SAME fields the .hwp lift fills).
    #[test]
    fn cell_resolves_borders_and_shade_from_pool() {
        let edge = CellEdge {
            color: Color::from_hex("#000000").unwrap(),
            style: LineStyle::Solid,
            width_px: 0.5,
        };
        let mut borders = std::collections::BTreeMap::new();
        borders.insert(
            5u64,
            BorderFillDef {
                borders: [Some(edge); 4],
                shade: Some(Color::from_hex("#D8D8D8").unwrap()),
                diagonal: None,
                has_border: true,
            },
        );
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="1" borderFillIDRef="2"><hp:tr><hp:tc borderFillIDRef="5"><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &borders).unwrap();
        let t = blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("table");
        let c = &t.cells[0];
        assert!(
            c.has_edge_borders(),
            "per-edge borders lifted from the pool"
        );
        assert!(c.has_border);
        assert_eq!(c.shade_color, Some(Color::from_hex("#D8D8D8").unwrap()));
    }

    /// Batch D: an `<hp:pic>` produces an `Inline::Image` carrying the binary ref + display size.
    #[test]
    fn pic_parses_into_inline_image() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:pic><hp:sz width="17340" height="12960"/><hc:img binaryItemIDRef="image1"/></hp:pic><hp:t></hp:t></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &Default::default()).unwrap();
        let img = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .flat_map(|p| &p.runs)
            .flat_map(|r| &r.content)
            .find_map(|i| match i {
                Inline::Image(im) => Some(im),
                _ => None,
            })
            .expect("pic → Inline::Image");
        assert_eq!(img.bin_ref, "image1");
        assert_eq!((img.width, img.height), (17340, 12960));
    }

    /// Batch D end-to-end: parsing a package resolves a `<hp:pic>`'s `binaryItemIDRef` → its embedded
    /// bytes in `doc.bin_data` (via the `content.hpf` `<opf:item>` manifest), so the renderer can
    /// embed the real photo. Round-trip moat: serializing the UNEDITED doc re-injects NO duplicate
    /// image part (the source part rides along verbatim).
    #[test]
    fn pic_resolves_bin_data_end_to_end() {
        let png: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        let section = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:pic><hp:sz width="500" height="400"/><hc:img binaryItemIDRef="image1"/></hp:pic><hp:t></hp:t></hp:run></hp:p></hs:sec>"#;
        let hpf = r#"<opf:package xmlns:opf="opf"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/></opf:manifest></opf:package>"#;
        let bytes = build_test_hwpx(&[
            ("mimetype", b"application/hwp+zip"),
            ("Contents/header.xml", b"<hh:head></hh:head>"),
            ("Contents/section0.xml", section.as_bytes()),
            ("Contents/content.hpf", hpf.as_bytes()),
            ("BinData/image1.png", png),
        ]);
        let doc = parse_semantic(&bytes).expect("parse test hwpx");
        assert_eq!(doc.bin_data.len(), 1, "one embedded image resolved");
        assert_eq!(doc.bin_data[0].bin_ref, "image1");
        assert_eq!(doc.bin_data[0].kind, "png");
        assert_eq!(doc.bin_data[0].bytes, png);

        // Round-trip: an UNEDITED image doc re-serializes without duplicating the BinData part.
        let out = crate::serialize::serialize(&doc).expect("serialize");
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let img_parts = (0..z.len())
            .filter(|&i| z.by_index(i).unwrap().name().contains("image1.png"))
            .count();
        assert_eq!(img_parts, 1, "no duplicate BinData part on round-trip");
    }

    /// Build a minimal in-memory HWPX (ZIP) from `(name, bytes)` parts — a test fixture for the
    /// package-level parse paths.
    fn build_test_hwpx(parts: &[(&str, &[u8])]) -> Vec<u8> {
        use zip::write::{SimpleFileOptions, ZipWriter};
        let mut zw = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        for (name, data) in parts {
            zw.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zw, data).unwrap();
        }
        zw.finish().unwrap().into_inner()
    }
}
