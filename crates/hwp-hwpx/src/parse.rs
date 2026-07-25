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
        let mut decos = Vec::new();
        parse_section(&text, &mut section.blocks, &mut decos, &border_pool)
            .map_err(|l| Error::Parse(l.to_string()))?;
        section.decorations = decos;
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
        let mut decos = Vec::new();
        parse_section(&text, &mut section.blocks, &mut decos, &border_pool)
            .map_err(HardenedError::Limit)?;
        section.decorations = decos;
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
    // content.hpf `<opf:item id=".." href="..">` → id→href map (섹션 순서를 읽는 spine 파서와
    // 같은 매니페스트 스캐너를 공유한다 — 표기 규칙이 갈리면 이미지/섹션 해석이 어긋난다).
    let Some(hpf) = pkg.read_content_hpf() else {
        return;
    };
    let href_of = crate::package::manifest_hrefs(&hpf);
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
    /// `<hp:tbl noAdjust>`: 1 = FIXED row heights (apply the stored `<hp:cellSz height>` as a floor);
    /// 0 (auto-fit, the common case) = Hancom re-lays-out rows to CONTENT and ignores the stored nominal
    /// heights — so we must NOT floor them (else single-line rows inflate ~1.6× → +2 pages, #196 gap).
    no_adjust: bool,
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
    fn new(table: Table, start: usize, border_ref: Option<u64>, no_adjust: bool) -> Self {
        TblFrame {
            table,
            cell: None,
            start,
            cell_start: 0,
            border_ref,
            geoms: Vec::new(),
            no_adjust,
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

/// Accumulator for one in-progress `<hp:equation>` — its display attrs (open tag) + the `<hp:script>`
/// body text. Mirrors [`PicAccum`]: the open tag arms it, the children fill it, `</hp:equation>`
/// builds the [`EquationRef`].
///
/// The script is HWP's equation markup and OWPML's `<hp:script>` is the SAME language, so it rides
/// through verbatim (no transcode) — exactly what the .hwp lift (`lift_equation`) does.
#[derive(Default)]
struct EqAccum {
    script: String,
    font: String,
    base_unit: u32,
    baseline: i16,
    color: Color,
    width: i32,  // <hp:sz width> (HWPUNIT)
    height: i32, // <hp:sz height>
    version: String,
}

impl EqAccum {
    /// `<hp:equation version baseLine textColor baseUnit font …>` → the display attrs. Every one is
    /// optional; the serializer (`emit_equation`) substitutes 한컴's defaults for the empty/zero ones,
    /// so a sparsely-attributed equation still round-trips.
    fn from_attrs(e: &BytesStart) -> EqAccum {
        EqAccum {
            font: attr_str(e, b"font").unwrap_or_default(),
            base_unit: attr_i32(e, b"baseUnit").unwrap_or(0).max(0) as u32,
            baseline: attr_i32(e, b"baseLine")
                .unwrap_or(0)
                .clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            // `Color::default()` 는 알파 0(투명)이라 수식 기본색으로는 틀리다 — 불투명 검정.
            color: attr_str(e, b"textColor")
                .and_then(|s| Color::from_hex(&s))
                .unwrap_or(Color {
                    r: 0,
                    g: 0,
                    b: 0,
                    a: 255,
                }),
            version: attr_str(e, b"version").unwrap_or_default(),
            ..Default::default()
        }
    }

    fn into_ref(self) -> EquationRef {
        EquationRef {
            script: self.script,
            font: self.font,
            base_unit: self.base_unit,
            baseline: self.baseline,
            color: self.color,
            width: self.width,
            height: self.height,
            version: self.version,
            // 파생 캐시 — rhwp 의 수식 엔진이 필요하고 이 크레이트는 rhwp 를 모른다(wasm 대상).
            // `None` = 예전과 바이트동일한 스텁 박스 폴백이라 순수 가산이다.
            rendered_svg: None,
        }
    }
}

/// Accumulator for one in-progress `<hp:fieldBegin>` — its id/type plus the `Command` string param
/// (a hyperlink's URL, a click-here's guide payload …). `</hp:fieldBegin>` builds the marker.
#[derive(Default)]
struct FieldAccum {
    id: u32,
    field_type: String,
    command: String,
}

impl FieldAccum {
    /// `<hp:fieldBegin id type …>`. `id` is what the matching `<hp:fieldEnd beginIDRef>` references,
    /// so it must ride through unchanged (the pairing is what makes the range meaningful).
    fn from_attrs(e: &BytesStart) -> FieldAccum {
        FieldAccum {
            id: attr_u64(e, b"id").unwrap_or(0) as u32,
            field_type: attr_str(e, b"type").unwrap_or_default(),
            command: String::new(),
        }
    }

    fn into_marker(self) -> FieldMarker {
        FieldMarker {
            id: self.id,
            field_type: self.field_type,
            command: self.command,
        }
    }
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
    /// Non-text inlines parsed inside the OPEN run, in DOCUMENT ORDER: `<hp:pic>` (D1),
    /// `<hp:footNote>`/`<hp:endNote>`, `<hp:equation>`, `<hp:fieldBegin>`/`<hp:fieldEnd>`.
    /// One ordered list (not per-kind lists) because field markers only mean anything in order —
    /// a `FieldEnd` that floats ahead of its `FieldBegin` would invert a hyperlink range.
    pending: Vec<Inline>,
    hosts_table: bool, // `<hp:tbl>` 를 품었다 → 표 앵커 후보
}

/// 본문이 아닌 서브바디 프레임(머리말/꼬리말/각주/미주). 여는 태그에서 `blocks` 스택에 프레임을
/// 밀고 이 값을 함께 쌓아, 닫는 태그에서 어디로 보낼지를 결정한다 — `<hp:tc>` 와 같은 규율.
enum SubFrame {
    Deco {
        kind: DecoKind,
        apply: ApplyPage,
    },
    Note {
        kind: NoteKind,
        number: u16,
        prefix_char: u16,
        suffix_char: u16,
        inst_id: u32,
    },
}

/// `<hp:header applyPageType="BOTH|EVEN|ODD">` → [`ApplyPage`] (미지정/미상은 BOTH).
fn apply_page(v: Option<&str>) -> ApplyPage {
    match v.unwrap_or("").trim().to_ascii_uppercase().as_str() {
        "EVEN" => ApplyPage::Even,
        "ODD" => ApplyPage::Odd,
        _ => ApplyPage::Both,
    }
}

/// 한글's default thin cell-border stroke width (device px), synthesized to RECOVER a table grid on a
/// **border-stripped** HWPX. Some lossy hwp→hwpx converters (e.g. 독스헌터) rewrite EVERY cell's
/// borderFill to all-NONE, dropping the table lines the source .hwp — and its reference PDF — still
/// draw; our faithful parse then renders the table borderless. 0.12mm ≈ 0.5px is 한글's default 표
/// (table) cell line weight (mirrors `synth::border_width_from_token`'s "0.12 mm" row). Tunable here.
///
/// This is a RENDER-ONLY recovery, NOT spec behavior: the synthesized border lives only in the render
/// IR. The original all-NONE `borderFillIDRef` is never written back — an unedited table re-serializes
/// byte-verbatim through the `src_span` round-trip moat, so no fabricated border is ever saved.
const RECOVERED_BORDER_WIDTH_PX: f64 = 0.5;

/// The default edge applied to every side of a stripped table's cells (see [`RECOVERED_BORDER_WIDTH_PX`]).
fn recovered_default_edge() -> CellEdge {
    CellEdge {
        color: Color {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        },
        style: LineStyle::Solid,
        width_px: RECOVERED_BORDER_WIDTH_PX,
    }
}

/// The border-stripped-conversion fingerprint: EVERY active cell is borderless AND the table holds ≥2
/// active cells (an actual grid). A single visible edge anywhere — a per-edge style other than 선없음,
/// or the legacy `has_border` box — means the table carries a genuine design → left 100% UNTOUCHED.
/// The ≥2-cell floor skips degenerate single-cell frames (including a 1×1 자가진단표 wrapper, whose
/// borderless outer cell is intentional): there is no grid to recover in one cell, and firing there
/// would fabricate an outer box the file never implied. Shade/diagonal are ignored here (a shaded or
/// diagonal-decorated borderless cell still counts as "no border edge").
fn table_is_border_stripped(cells: &[Cell]) -> bool {
    let mut active = 0usize;
    for c in cells {
        if !c.active {
            continue;
        }
        active += 1;
        if c.has_border {
            return false;
        }
        if c.borders
            .iter()
            .any(|e| matches!(e, Some(edge) if edge.style != LineStyle::None))
        {
            return false;
        }
    }
    active >= 2
}

/// Synthesize 한글's default thin grid on a fingerprinted stripped table: set all four edges of every
/// active cell to [`recovered_default_edge`] and flag `has_border`, so `place.rs` draws a full grid
/// through the SAME per-edge path a real .hwp border flows through. Shade and diagonals are left
/// untouched (they already resolved correctly). No `dirty`/`src_span` is touched → serialization is
/// unaffected and the original NONE borderFills persist on save.
fn recover_stripped_borders(cells: &mut [Cell]) {
    let edge = recovered_default_edge();
    for c in cells.iter_mut() {
        if c.active {
            c.borders = [Some(edge); 4];
            c.has_border = true;
        }
    }
}

/// Parse one section's XML into `out` (body blocks) and `decos` (머리말/꼬리말). Returns
/// `Err(DocLimit::TableNestingTooDeep)` if table-in-table nesting exceeds
/// [`limits::MAX_TABLE_NESTING`] — the concrete "XML depth counter" for the only nesting that grows
/// unbounded structures. All other malformation is tolerated (best-effort parse); the reader stops
/// at the first hard error/EOF as before.
fn parse_section(
    xml: &str,
    out: &mut Vec<Block>,
    decos: &mut Vec<PageDecoration>,
    borders: &std::collections::BTreeMap<u64, BorderFillDef>,
) -> std::result::Result<(), DocLimit> {
    let mut reader = Reader::from_str(xml);
    // Stack of block containers (section, then nested table-cell / header / note sublists).
    let mut blocks: Vec<Vec<Block>> = vec![Vec::new()];
    let mut tbls: Vec<TblFrame> = Vec::new();
    // 머리말/꼬리말/각주 프레임 스택 — `<hp:tc>` 와 1:1 대응(열 때 blocks 프레임 push, 닫을 때 pop).
    let mut subs: Vec<SubFrame> = Vec::new();
    // Stack of in-progress paragraphs (a cell paragraph nests inside a table inside an outer para).
    let mut paras: Vec<ParaAccum> = Vec::new();
    let mut in_t = false;
    // In-progress `<hp:pic>` (D1) — captures its display size + binary ref between pic open/close.
    let mut pic: Option<PicAccum> = None;
    // In-progress `<hp:equation>` + whether we're inside its `<hp:script>` text.
    let mut eq: Option<EqAccum> = None;
    let mut in_script = false;
    // In-progress `<hp:fieldBegin>` + whether we're inside its `Command` `<hp:stringParam>`.
    let mut field: Option<FieldAccum> = None;
    let mut in_field_cmd = false;

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
                        // 이 문단이 표를 품는다 = 표 앵커 후보(`</hp:p>` 에서 텍스트 유무로 확정).
                        if let Some(p) = paras.last_mut() {
                            p.hosts_table = true;
                        }
                        let rows = attr_usize(&e, b"rowCnt").unwrap_or(0);
                        let cols = attr_usize(&e, b"colCnt").unwrap_or(0);
                        let border_ref = attr_u64(&e, b"borderFillIDRef");
                        // noAdjust=1 → fixed row heights; 0/absent → auto-fit (content drives; don't floor).
                        let no_adjust = attr_usize(&e, b"noAdjust") == Some(1);
                        tbls.push(TblFrame::new(
                            Table {
                                rows,
                                cols,
                                provenance: hwpx_prov(),
                                ..Default::default()
                            },
                            pos_before,
                            border_ref,
                            no_adjust,
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
                    // 수식 — `<hp:pic>` 와 **완전히 같은 패턴**: 여는 태그가 누산기를 열고,
                    // 자식(`<hp:sz>`/`<hp:script>`)이 채우고, 닫는 태그가 `Inline::Equation` 을
                    // 만든다. 예전엔 `other =>` 폴백이 `mark_not_simple` 만 찍고 **내용을 통째로
                    // 버려서** 수식이 렌더/조판/export 어디에도 남지 않았다(스텁 박스조차 없음).
                    // 구조적 자식이므로 호스트 문단은 계속 non-simple = 재출력 시 바이트 그대로.
                    b"equation" => {
                        eq = Some(EqAccum::from_attrs(&e));
                        mark_not_simple(&mut paras);
                    }
                    // `<hp:script>` 는 수식 문맥에서만 텍스트 수집 대상이다(`in_t` 는 `<hp:t>` 전용).
                    b"script" if eq.is_some() => {
                        in_script = true;
                        mark_not_simple(&mut paras);
                    }
                    // 필드(하이퍼링크/누름틀/상호참조) 시작 — `<hp:parameters>` 자식을 가지므로 Start.
                    b"fieldBegin" => {
                        field = Some(FieldAccum::from_attrs(&e));
                        mark_not_simple(&mut paras);
                    }
                    // 필드의 `Command` 파라미터(하이퍼링크 URL 등)만 본문 텍스트로 모은다.
                    b"stringParam" if field.is_some() => {
                        if attr_str(&e, b"name").as_deref() == Some("Command") {
                            in_field_cmd = true;
                        }
                        mark_not_simple(&mut paras);
                    }
                    // 머리말/꼬리말/각주/미주는 본문이 아니다 — `<hp:tc>` 와 **완전히 같은 패턴**으로
                    // blocks 프레임을 밀어 넣어 그 안의 `<hp:p>` 가 섹션 루트로 새는 것을 막는다.
                    // (프레임이 없으면 `</hp:p>` 가 머리말 문단을 본문 첫 줄에 일반 문단으로 조판했다.)
                    // 구조적 자식이므로 호스트 문단은 계속 non-simple = verbatim 재출력 대상이다.
                    b"header" | b"footer" => {
                        mark_not_simple(&mut paras);
                        blocks.push(Vec::new());
                        subs.push(SubFrame::Deco {
                            kind: if ln.as_ref() == b"header" {
                                DecoKind::Header
                            } else {
                                DecoKind::Footer
                            },
                            apply: apply_page(attr_str(&e, b"applyPageType").as_deref()),
                        });
                    }
                    b"footNote" | b"endNote" => {
                        mark_not_simple(&mut paras);
                        blocks.push(Vec::new());
                        subs.push(SubFrame::Note {
                            kind: if ln.as_ref() == b"footNote" {
                                NoteKind::Foot
                            } else {
                                NoteKind::End
                            },
                            number: attr_usize(&e, b"number").unwrap_or(0) as u16,
                            prefix_char: attr_wchar(&e, b"prefixChar"),
                            suffix_char: attr_wchar(&e, b"suffixChar"),
                            inst_id: attr_u64(&e, b"instId").unwrap_or(0) as u32,
                        });
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
            // Inside a `<hp:equation>`: only its `<hp:sz>` matters (the reserved box the typesetter
            // and the own-render stub use). Everything else (pos/outMargin/…) is structural.
            Ok(Event::Empty(e)) if eq.is_some() => {
                if e.local_name().as_ref() == b"sz" {
                    if let Some(a) = eq.as_mut() {
                        if let Some(w) = attr_i32(&e, b"width") {
                            a.width = w;
                        }
                        if let Some(h) = attr_i32(&e, b"height") {
                            a.height = h;
                        }
                    }
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
                // 표 바깥 여백(`<hp:outMargin>`) — 조판이 표 위/아래로 예약하는 세로 공간이다.
                // 예전엔 `other` 폴백으로 버려져 `outer_margin_*` 이 전부 0 이었다(benchmark1.hwpx 는
                // 표 74개 전부 top/bottom=283 ⇒ 표당 566 HWPUNIT 세로 누락). `<hp:inMargin>` 과 같은
                // 위치 규칙: 첫 `<hp:tr>` 앞에 오므로 `f.cell` 이 None 일 때만 표의 값으로 읽는다
                // (도형/그림의 outMargin 은 위쪽 `pic` 분기 또는 셀 컨텍스트에서 걸러진다).
                //
                // ⚠️ 상쇄 주의 — 이 수정은 아래 `is_table_anchor`(표 앵커 문단의 빈 줄 초과 예약)와
                // **한 몸이다**. 둘 다 세로 회계 오차인데 부호가 반대라 오래 서로를 가리고 있었다:
                // 앵커 빈 줄이 표당 ~1300 HWPUNIT 을 과다 예약하고, 이 바깥여백 누락이 표당 566 을
                // 과소 예약했다. 실측(benchmark1.hwpx, ApproxFontMetrics · 행높이 바닥 고정 기준):
                //   원래(둘 다 버그)      : 20쪽 / 368줄
                //   앵커만 고침(이것 없이): 19쪽 / 301줄  ← 쪽수가 되레 깨진다
                //   둘 다 고침            : 20쪽 / 301줄  ← rhwp lift 와 완전 일치
                // 한쪽만 되돌리지 마라. 회귀 잠금은 `hwp-core/tests/hwpx_rhwp_parity.rs`.
                b"outMargin" => {
                    if let Some(f) = tbls.last_mut() {
                        if f.cell.is_none() {
                            f.table.outer_margin_left = attr_i32(&e, b"left").unwrap_or(0);
                            f.table.outer_margin_right = attr_i32(&e, b"right").unwrap_or(0);
                            f.table.outer_margin_top = attr_i32(&e, b"top").unwrap_or(0);
                            f.table.outer_margin_bottom = attr_i32(&e, b"bottom").unwrap_or(0);
                        }
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
                // Inline whitespace/control chars carried INSIDE a run — emit them as TEXT so the
                // line-breaker sees the same break opportunities Hancom does. `<hp:fwSpace/>` (전각
                // 공백) is the load-bearing one: dropping it glued "라벨(Problem)" and forced a mid-word
                // Latin break; as U+3000 the breaker wraps at the space. These are pure inline text, so
                // (unlike the `other` arm) they do NOT mark the paragraph non-simple.
                b"fwSpace" => push_inline_char(&mut paras, '\u{3000}'),
                b"nbSpace" => push_inline_char(&mut paras, '\u{00A0}'),
                b"tab" => push_inline_char(&mut paras, '\t'),
                b"lineBreak" => push_inline_char(&mut paras, '\n'),
                // 필드 끝 마커 — 항상 self-closing. 짝(`beginIDRef`)을 그대로 들고 간다.
                b"fieldEnd" => {
                    let id = attr_u64(&e, b"beginIDRef").unwrap_or(0) as u32;
                    push_pending(&mut paras, Inline::FieldEnd(id));
                    mark_not_simple(&mut paras);
                }
                // 파라미터 없는 필드 시작(`<hp:fieldBegin …/>`)도 실물에 존재한다 — Start 경로와
                // 같은 누산기를 즉시 확정한다.
                b"fieldBegin" => {
                    let fa = FieldAccum::from_attrs(&e);
                    push_pending(&mut paras, Inline::FieldBegin(fa.into_marker()));
                    mark_not_simple(&mut paras);
                }
                // `<hp:lineseg/>` (inside linesegarray) is layout cache; everything else structural.
                other => {
                    if !matches!(other, b"lineseg" | b"linesegarray") {
                        mark_not_simple(&mut paras);
                    }
                }
            },
            // 수식 스크립트 본문. `<hp:t>` 전용인 `in_t` 와 분리해야 한다 — 예전엔 `in_t` 만 있어
            // 스크립트 텍스트가 어디에도 잡히지 않았다.
            Ok(Event::Text(e)) if in_script => {
                if let Some(a) = eq.as_mut() {
                    a.script.push_str(&e.unescape().unwrap_or_default());
                }
            }
            // 한컴/변환기에 따라 스크립트를 CDATA 로 쓰기도 한다(수식엔 `<`, `&` 가 흔하다).
            Ok(Event::CData(e)) if in_script => {
                if let Some(a) = eq.as_mut() {
                    a.script.push_str(&String::from_utf8_lossy(&e.into_inner()));
                }
            }
            Ok(Event::Text(e)) if in_field_cmd => {
                if let Some(f) = field.as_mut() {
                    f.command.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Ok(Event::Text(e)) if in_t => {
                if let Some((_, t)) = paras.last_mut().and_then(|p| p.cur_run.as_mut()) {
                    t.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"script" => in_script = false,
                b"stringParam" => in_field_cmd = false,
                // 수식 확정 → 현재 열린 런의 `Inline::Equation`. 파생 캐시 `rendered_svg` 는
                // rhwp 의존(그리고 wasm 비대상)이라 여기선 항상 `None` — 렌더러가 스텁 박스로
                // 폴백하므로 순수 가산이다(.hwp lift 의 렌더 실패 경로와 같은 상태).
                b"equation" => {
                    if let Some(a) = eq.take() {
                        push_pending(&mut paras, Inline::Equation(a.into_ref()));
                    }
                }
                b"fieldBegin" => {
                    if let Some(f) = field.take() {
                        push_pending(&mut paras, Inline::FieldBegin(f.into_marker()));
                    }
                }
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
                        // 표 호스트 문단 = 표를 품고 보이는 텍스트가 없는 문단. 한컴은 여기에 줄을
                        // 하나도 걸지 않는다(표가 그 자리를 차지한다) — 조판이 이 플래그를 보고
                        // 줄 예약을 건너뛴다(`hwp-typeset` place.rs/lib.rs). 플래그가 없던 동안은
                        // 표마다 빈 줄 1개가 초과 예약됐다(benchmark1.hwpx 실측 +67줄 = 표 개수).
                        // .hwp lift 의 `is_table_anchor` 와 같은 판정식.
                        //
                        // ⚠️ 위 `<hp:outMargin>` 파싱과 **한 몸**이다(부호 반대의 상쇄 오차) — 자세한
                        // 실측 수치는 그쪽 주석 참조. 한쪽만 되돌리면 쪽수가 깨진다.
                        //
                        // 블록 순서는 그대로 둔다: 우리는 `[Table, 호스트문단]`(`</hp:tbl>` 이 먼저
                        // 닫힌다), lift 는 `[앵커문단, Table]`. 앵커는 어차피 줄을 예약하지 않으므로
                        // 조판 결과는 같고, 순서를 바꾸면 직렬화의 `src_span` 오름차순 가정과 바이트
                        // 보존 왕복에 닿는다 — 이득 없이 해자만 흔드는 변경이라 하지 않는다.
                        let text_empty = !p.runs.iter().any(|r| {
                            r.content
                                .iter()
                                .any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
                        });
                        if let Some(target) = blocks.last_mut() {
                            target.push(Block::Paragraph(Paragraph {
                                is_table_anchor: p.hosts_table && text_empty,
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
                            push_pending(
                                &mut paras,
                                Inline::Image(ImageRef {
                                    bin_ref,
                                    width: pa.width,
                                    height: pa.height,
                                }),
                            );
                        }
                    }
                }
                // 머리말/꼬리말/각주 프레임을 닫는다 — 본문(blocks[0])이 아니라 각자의 IR 자리로.
                // 머리말/꼬리말 → `Section.decorations`, 각주/미주 → 호스트 문단 런의 `Inline::Note`
                // (.hwp lift 와 같은 구조). 여는 태그를 못 본 채 닫는 태그만 온 깨진 XML 이면
                // `subs.pop()` 이 None 이라 blocks 스택은 건드리지 않는다(루트 프레임 보호).
                b"header" | b"footer" | b"footNote" | b"endNote" => {
                    if let Some(fr) = subs.pop() {
                        let body = blocks.pop().unwrap_or_default();
                        match fr {
                            SubFrame::Deco { kind, apply } => decos.push(PageDecoration {
                                kind,
                                apply,
                                blocks: body,
                                // 이 머리말/꼬리말은 섹션 XML 안에 그대로 있고 직렬화가 그 바이트를
                                // 통째로 재출력한다 — 다시 합성해 끼워 넣으면 **중복**된다.
                                from_source: true,
                            }),
                            SubFrame::Note {
                                kind,
                                number,
                                prefix_char,
                                suffix_char,
                                inst_id,
                            } => {
                                if !paras.is_empty() {
                                    push_pending(
                                        &mut paras,
                                        Inline::Note(NoteRef {
                                            kind,
                                            number,
                                            prefix_char,
                                            suffix_char,
                                            inst_id,
                                            body,
                                        }),
                                    );
                                } else if let Some(target) = blocks.last_mut() {
                                    // OWPML 은 각주를 항상 문단 안에 넣으므로 도달 불가.
                                    // 그래도 콘텐츠를 버리지는 않는다(현행 동작과 동일한 자리로).
                                    target.extend(body);
                                }
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
                        // Row-height handling splits on `noAdjust`:
                        //  • FIXED (noAdjust=1): apply the stored `<hp:cellSz height>` as the `row_heights`
                        //    floor (the codec round-trips it — issue 054/020).
                        //  • AUTO-FIT (noAdjust=0, the common case): keep `row_heights` CONTENT-DRIVEN (so
                        //    the round-trip codec is untouched) but RETAIN the stored floor in
                        //    `stored_row_heights` — a RENDER-IR field the app uses to offer two faithful
                        //    readings of a lossy conversion: FAITHFUL (floor to these = mirror Hancom's 20p,
                        //    checklist 1–7/page) vs 레이아웃 정리 (content-fit = the .hwp look, 1–12/page).
                        //    Both are toggled in the wasm layer; neither reaches saved bytes (src_span).
                        if f.table.rows > 0 {
                            let stored = stored_row_heights_hwpx(&f.geoms, f.table.rows);
                            if f.no_adjust {
                                f.table.row_heights = stored;
                            } else {
                                f.table.stored_row_heights = stored;
                            }
                        }
                        // The table's OWN outline borderFill (표 외곽 테두리).
                        if let Some(bf) = f.border_ref.and_then(|id| borders.get(&id)) {
                            f.table.borders = bf.borders;
                        }
                        // BORDER RECOVERY (lossy-conversion heuristic, HWPX-only): when EVERY active
                        // cell is borderless — the all-NONE-borderFill fingerprint a lossy hwp→hwpx
                        // converter leaves behind — synthesize 한글's default thin grid so the table
                        // renders like its .hwp/PDF twin. Nested tables close first, so a 자가진단표's
                        // inner grid is recovered before its 1×1 wrapper (which the ≥2-cell floor skips).
                        // RENDER IR only: the original NONE borderFillIDRef re-serializes verbatim via
                        // `src_span` (round-trip moat) — no fabricated border is ever saved.
                        if table_is_border_stripped(&f.table.cells) {
                            recover_stripped_borders(&mut f.table.cells);
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
/// Append an inline control character to the paragraph's OPEN run. Used for `<hp:fwSpace/>` (전각 공백,
/// U+3000), `<hp:nbSpace/>` (묶음 빈칸, NBSP), `<hp:tab/>` and `<hp:lineBreak/>` — self-closing elements
/// that carry TEXT content, not structure. Dropping them (the old `other` arm did) glued neighbours
/// together and, worse, removed the LINE-BREAK OPPORTUNITY a full-width space provides: a label
/// "1. 문제인식<fwSpace>(Problem)" wrapped mid-word ("(Proble"/"m)") instead of at the space like Hancom.
/// A no-op when no run is open (a stray control char outside `<hp:run>`), which OWPML does not produce.
fn push_inline_char(paras: &mut [ParaAccum], ch: char) {
    if let Some((_, t)) = paras.last_mut().and_then(|p| p.cur_run.as_mut()) {
        t.push(ch);
    }
}

fn flush_run(p: &mut ParaAccum) {
    // 그림/각주/수식/필드 마커는 런 끝에 붙인다 — .hwp lift 와 같은 v1 근사(정확한 런 중간
    // 앵커는 후속). 서로의 상대 순서는 문서 순서 그대로 보존된다(단일 `pending` 리스트).
    let pending = std::mem::take(&mut p.pending);
    if let Some((char_ref, text)) = p.cur_run.take() {
        let mut content: Vec<Inline> = vec![Inline::Text(text)];
        content.extend(pending);
        p.runs.push(Run {
            char_shape: 0,
            char_ref,
            content,
        });
    } else if !pending.is_empty() {
        // 명시적 `<hp:run>` 바깥의 그림/각주/수식 — 자체 런으로 내보내 살려 둔다.
        p.runs.push(Run {
            char_shape: 0,
            char_ref: None,
            content: pending,
        });
    }
}

/// Append a non-text inline to the innermost in-progress paragraph's OPEN-run pending list.
/// A no-op when no paragraph is open (stray object outside `<hp:p>`, which OWPML does not produce).
fn push_pending(paras: &mut [ParaAccum], inl: Inline) {
    if let Some(p) = paras.last_mut() {
        p.pending.push(inl);
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

/// 각주 장식 문자(`prefixChar`/`suffixChar`) → WChar 코드포인트. OWPML 은 보통 숫자 코드
/// (`suffixChar="41"` = `)`)로 쓰지만 리터럴 문자를 쓰는 변환기도 있어 둘 다 받는다. 없으면 0.
fn attr_wchar(e: &BytesStart, name: &[u8]) -> u16 {
    let Some(v) = attr_str(e, name) else {
        return 0;
    };
    let v = v.trim();
    if let Ok(n) = v.parse::<u16>() {
        return n;
    }
    v.chars().next().map(|c| c as u32 as u16).unwrap_or(0)
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
pub(crate) mod tests {
    use super::*;

    #[test]
    fn inline_fwspace_tab_nbspace_carry_as_text_and_stay_simple() {
        // `<hp:fwSpace/>` etc. are inline TEXT, not structure: they must become characters (so the
        // line-breaker sees the space) AND keep the paragraph simple/editable — the old code dropped
        // them and marked the paragraph non-simple, gluing "라벨(Problem)" into a mid-word wrap.
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>1. 문제인식</hp:t><hp:fwSpace/><hp:t>(Problem)</hp:t><hp:tab/><hp:nbSpace/></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
        let p = blocks
            .iter()
            .find_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .expect("paragraph");
        let text: String = p
            .runs
            .iter()
            .flat_map(|r| r.content.iter())
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "1. 문제인식\u{3000}(Problem)\t\u{00A0}");
        assert!(
            p.source.as_ref().is_some_and(|s| s.simple),
            "inline whitespace must NOT make the paragraph non-simple"
        );
    }

    /// Collect every inline of a parsed section, depth-first (paragraph runs + table cell bodies).
    fn all_inlines(blocks: &[Block]) -> Vec<Inline> {
        let mut out = Vec::new();
        fn walk(bs: &[Block], out: &mut Vec<Inline>) {
            for b in bs {
                match b {
                    Block::Paragraph(p) => {
                        for r in &p.runs {
                            out.extend(r.content.iter().cloned());
                        }
                    }
                    Block::Table(t) => {
                        for c in &t.cells {
                            walk(&c.blocks, out);
                        }
                    }
                }
            }
        }
        walk(blocks, &mut out);
        out
    }

    fn parse_sec(xml: &str) -> Vec<Block> {
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
        blocks
    }

    /// 수식 회귀 잠금: `<hp:equation>` 은 예전에 `other =>` 폴백에서 **통째로 버려졌다**(렌더 SVG에
    /// 글리프 0개 — 스텁 박스조차 없었다). 이제 스크립트/표시속성/예약 박스를 `Inline::Equation`
    /// 으로 살린다. `<hp:script>` 텍스트는 `<hp:t>` 전용 `in_t` 와 분리된 경로로 잡아야 한다.
    #[test]
    fn equation_is_lifted_with_script_and_display_attrs() {
        let xml = r##"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run charPrIDRef="7"><hp:t>앞</hp:t>
          <hp:equation id="9" version="Equation Version 60" baseLine="70" textColor="#FF0000" baseUnit="1200" lineMode="CHAR" font="HYhwpEQ">
            <hp:sz width="4300" height="2100" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>
            <hp:pos treatAsChar="1"/><hp:outMargin left="56" right="56" top="0" bottom="0"/>
            <hp:script>1 over 2 + sqrt {a &lt; b}</hp:script>
          </hp:equation><hp:t>뒤</hp:t></hp:run></hp:p></hs:sec>"##;
        let blocks = parse_sec(xml);
        let eq = all_inlines(&blocks)
            .into_iter()
            .find_map(|i| match i {
                Inline::Equation(e) => Some(e),
                _ => None,
            })
            .expect("`<hp:equation>` 은 Inline::Equation 이어야 한다");
        assert_eq!(eq.script, "1 over 2 + sqrt {a < b}");
        assert_eq!((eq.width, eq.height), (4300, 2100));
        assert_eq!(eq.font, "HYhwpEQ");
        assert_eq!(eq.base_unit, 1200);
        assert_eq!(eq.baseline, 70);
        assert_eq!(eq.color, Color::from_hex("#FF0000").unwrap());
        assert_eq!(eq.version, "Equation Version 60");
        // 파생 캐시는 rhwp 의존 → 항상 None(렌더러가 스텁 박스로 폴백).
        assert!(eq.rendered_svg.is_none());
        // 주변 텍스트는 그대로 살아 있어야 한다("사용자 콘텐츠 삭제 금지").
        let text: String = all_inlines(&blocks)
            .iter()
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.trim().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "앞뒤");
        // 구조적 자식 → 재출력 시 바이트 그대로(직렬화 대칭의 축).
        let Block::Paragraph(p) = &blocks[0] else {
            panic!("문단")
        };
        assert!(!p.source.as_ref().unwrap().simple);
    }

    /// 수식 스크립트를 CDATA 로 쓰는 변환기도 있다(수식엔 `<`/`&` 가 흔하다).
    #[test]
    fn equation_script_accepts_cdata() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run>
          <hp:equation><hp:sz width="10" height="10"/><hp:script><![CDATA[x^2 < y]]></hp:script></hp:equation>
        </hp:run></hp:p></hs:sec>"#;
        let eq = all_inlines(&parse_sec(xml))
            .into_iter()
            .find_map(|i| match i {
                Inline::Equation(e) => Some(e),
                _ => None,
            })
            .expect("CDATA 스크립트도 잡아야 한다");
        assert_eq!(eq.script, "x^2 < y");
    }

    /// 필드(하이퍼링크) 범위 회귀 잠금: `<hp:fieldBegin>`/`<hp:fieldEnd>` 는 예전에 버려져
    /// 하이퍼링크 범위가 통째로 소실됐다. id 짝과 Command(URL)까지 살린다.
    #[test]
    fn field_begin_end_are_lifted_with_command_and_pairing() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p>
          <hp:run charPrIDRef="1"><hp:ctrl><hp:fieldBegin id="2110609883" type="HYPERLINK" name="" editable="1">
            <hp:parameters cnt="2" name=""><hp:integerParam name="Prop">9</hp:integerParam>
            <hp:stringParam name="Command" xml:space="preserve">http\://www.hometax.go.kr);1;0;0;</hp:stringParam></hp:parameters>
          </hp:fieldBegin></hp:ctrl></hp:run>
          <hp:run charPrIDRef="6"><hp:t>국세청</hp:t></hp:run>
          <hp:run charPrIDRef="1"><hp:ctrl><hp:fieldEnd beginIDRef="2110609883" fieldid="627272811"/></hp:ctrl><hp:t/></hp:run>
        </hp:p></hs:sec>"#;
        let inls = all_inlines(&parse_sec(xml));
        let begin = inls
            .iter()
            .find_map(|i| match i {
                Inline::FieldBegin(m) => Some(m.clone()),
                _ => None,
            })
            .expect("FieldBegin");
        assert_eq!(begin.id, 2110609883);
        assert_eq!(begin.field_type, "HYPERLINK");
        assert_eq!(begin.command, "http\\://www.hometax.go.kr);1;0;0;");
        assert!(
            inls.iter()
                .any(|i| matches!(i, Inline::FieldEnd(id) if *id == begin.id)),
            "짝이 맞는 FieldEnd 가 있어야 한다"
        );
        // 문서 순서 보존: begin → 텍스트 → end.
        let order: Vec<&str> = inls
            .iter()
            .filter_map(|i| match i {
                Inline::FieldBegin(_) => Some("b"),
                Inline::FieldEnd(_) => Some("e"),
                Inline::Text(t) if !t.is_empty() => Some("t"),
                _ => None,
            })
            .collect();
        assert_eq!(order, ["b", "t", "e"]);
    }

    /// benchmark1.hwpx 실물은 같은 문단에서 `fieldEnd` 가 `fieldBegin` **앞**에 온다(한컴이 실제로
    /// 그렇게 쓴다). 순서를 그대로 보존해야 범위가 뒤집히지 않는다.
    #[test]
    fn field_markers_keep_document_order_even_when_end_precedes_begin() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p>
          <hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="17" fieldid="17"/></hp:ctrl></hp:run>
          <hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="17" type="HYPERLINK"><hp:parameters cnt="1" name=""><hp:stringParam name="Command">u</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>
        </hp:p></hs:sec>"#;
        let order: Vec<&str> = all_inlines(&parse_sec(xml))
            .iter()
            .filter_map(|i| match i {
                Inline::FieldBegin(_) => Some("b"),
                Inline::FieldEnd(_) => Some("e"),
                _ => None,
            })
            .collect();
        assert_eq!(order, ["e", "b"]);
    }

    /// 파라미터 없는 self-closing `<hp:fieldBegin/>` 도 실물에 있다.
    #[test]
    fn self_closing_field_begin_is_lifted() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:ctrl><hp:fieldBegin id="5" type="CLICK_HERE"/></hp:ctrl></hp:run></hp:p></hs:sec>"#;
        assert!(all_inlines(&parse_sec(xml)).iter().any(
            |i| matches!(i, Inline::FieldBegin(m) if m.id == 5 && m.field_type == "CLICK_HERE")
        ));
    }

    /// 표 셀 안의 수식/필드도 살아야 한다(셀 본문은 별도 blocks 프레임을 탄다).
    #[test]
    fn equation_and_field_inside_table_cell_survive() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="1"><hp:tr>
          <hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList>
            <hp:p><hp:run><hp:t>셀</hp:t><hp:equation><hp:sz width="900" height="600"/><hp:script>a over b</hp:script></hp:equation></hp:run></hp:p>
          </hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let inls = all_inlines(&parse_sec(xml));
        assert!(inls.iter().any(
            |i| matches!(i, Inline::Equation(e) if e.script == "a over b" && e.height == 600)
        ));
        assert!(inls
            .iter()
            .any(|i| matches!(i, Inline::Text(t) if t.trim() == "셀")));
    }

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
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
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
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
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
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();

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
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
        let t = blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("table");
        assert_eq!(t.col_widths, vec![1000, 3000], "real per-column widths");
        // No `noAdjust` → auto-fit: `row_heights` stays CONTENT-DRIVEN (empty) so the round-trip codec
        // is untouched — but the stored cellSz floor is RETAINED in `stored_row_heights` (render-IR) so
        // the app can offer the faithful(=floor)/레이아웃 정리(=content-fit) toggle.
        assert!(
            t.row_heights.is_empty(),
            "auto-fit table → row_heights content-driven (round-trip codec unchanged)"
        );
        assert_eq!(
            t.stored_row_heights,
            vec![800],
            "auto-fit table RETAINS the stored cellSz floor for the faithful-render toggle"
        );
    }

    /// A FIXED table (`noAdjust="1"`) DOES apply the `<hp:cellSz height>` floor (row height is
    /// author-set, not auto-fit) — the gate must keep that path working.
    #[test]
    fn table_noadjust_fixed_applies_row_height_floor() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2" noAdjust="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="3000" height="800"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
        let t = blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("table");
        assert_eq!(t.col_widths, vec![1000, 3000]);
        assert_eq!(
            t.row_heights,
            vec![800],
            "fixed table keeps the cellSz height floor"
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
        parse_section(xml, &mut blocks, &mut Vec::new(), &borders).unwrap();
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

    /// An all-NONE `BorderFillDef` (the border-stripped-conversion fingerprint) — every edge resolves
    /// as `Some(LineStyle::None)`, `has_border=false` — exactly what `parse_border_fill` yields for a
    /// 독스헌터-style stripped cell.
    fn all_none_fill() -> BorderFillDef {
        let none_edge = CellEdge {
            color: Color::from_hex("#000000").unwrap(),
            style: LineStyle::None,
            width_px: 0.5,
        };
        BorderFillDef {
            borders: [Some(none_edge); 4],
            shade: None,
            diagonal: None,
            has_border: false,
        }
    }

    fn find_table(blocks: &[Block]) -> &Table {
        blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("table")
    }

    /// BORDER RECOVERY: a table whose cells ALL reference an all-NONE borderFill (the stripped-
    /// conversion fingerprint) gets 한글's default thin grid synthesized on every active cell.
    #[test]
    fn stripped_table_gets_recovered_default_borders() {
        let mut borders = std::collections::BTreeMap::new();
        borders.insert(1u64, all_none_fill());
        // A 1×2 grid — both cells reference the all-NONE fill.
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2" borderFillIDRef="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc><hp:tc borderFillIDRef="1"><hp:subList><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &borders).unwrap();
        let t = find_table(&blocks);
        assert_eq!(t.cells.len(), 2);
        for c in &t.cells {
            assert!(c.has_border, "recovered cell flags has_border");
            assert!(c.has_edge_borders(), "recovered cell draws per-edge grid");
            for e in c.borders.iter() {
                let e = e.expect("all 4 edges set");
                assert_eq!(e.style, LineStyle::Solid, "solid recovered edge");
                assert_eq!(e.color, Color::from_hex("#000000").unwrap());
                assert_eq!(e.width_px, RECOVERED_BORDER_WIDTH_PX);
            }
        }
    }

    /// BORDER RECOVERY negative case: a table with ANY real border edge (even one cell) is a genuine
    /// design and is left 100% untouched — the borderless sibling KEEPS its all-NONE edges (no grid
    /// fabricated). Also proves a lone borderless cell (a frame/spacer) is never "recovered".
    #[test]
    fn table_with_a_real_border_edge_is_left_untouched() {
        let real_edge = CellEdge {
            color: Color::from_hex("#000000").unwrap(),
            style: LineStyle::Solid,
            width_px: 0.5,
        };
        let mut borders = std::collections::BTreeMap::new();
        borders.insert(1u64, all_none_fill()); // borderless
        borders.insert(
            2u64,
            BorderFillDef {
                borders: [Some(real_edge); 4],
                shade: None,
                diagonal: None,
                has_border: true,
            },
        ); // genuine border
           // Cell A = borderless (bf 1), cell B = real border (bf 2) → the table is a genuine design.
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2" borderFillIDRef="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc><hp:tc borderFillIDRef="2"><hp:subList><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &borders).unwrap();
        let t = find_table(&blocks);
        // Cell A stays borderless — NOT synthesized to a solid grid.
        let a = &t.cells[0];
        assert!(!a.has_border, "borderless cell untouched");
        assert_eq!(
            a.borders[0].expect("edge resolved").style,
            LineStyle::None,
            "borderless sibling keeps its NONE edge (no fabricated grid)"
        );
        // Cell B keeps its genuine border.
        assert!(t.cells[1].has_border);
    }

    /// ROUND-TRIP MOAT: an UNEDITED stripped table renders with recovered borders BUT re-serializes
    /// with its ORIGINAL all-NONE borderFills — the synthesized border lives only in the render IR and
    /// is NEVER written back (no fabricated borders on save).
    #[test]
    fn stripped_table_roundtrips_with_original_none_borders() {
        // header.xml carries a single all-NONE borderFill (id=1) — the stripped fingerprint.
        let header = concat!(
            r#"<hh:head><hh:refList><hh:borderFills itemCnt="1">"#,
            r##"<hh:borderFill id="1"><hh:slash type="NONE"/><hh:backSlash type="NONE"/><hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/><hh:diagonal type="NONE" width="0.1 mm" color="#000000"/></hh:borderFill>"##,
            r#"</hh:borderFills></hh:refList></hh:head>"#,
        );
        let section = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="2" borderFillIDRef="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc><hp:tc borderFillIDRef="1"><hp:subList><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let hpf = r#"<opf:package xmlns:opf="opf"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest></opf:package>"#;
        let bytes = build_test_hwpx(&[
            ("mimetype", b"application/hwp+zip"),
            ("Contents/header.xml", header.as_bytes()),
            ("Contents/section0.xml", section.as_bytes()),
            ("Contents/content.hpf", hpf.as_bytes()),
        ]);

        // RENDER IR: recovery fired (the table draws a grid).
        let doc = parse_semantic(&bytes).expect("parse stripped hwpx");
        let t = find_table(&doc.sections[0].blocks);
        assert!(t.cells.iter().all(|c| c.has_border), "recovered for render");
        assert!(t.cells[0].borders[0].unwrap().style == LineStyle::Solid);
        assert!(!doc.any_dirty(), "recovery does not dirty the doc");

        // SAVE: the UNEDITED doc re-serializes with the ORIGINAL all-NONE borderFill — no fabrication.
        let out = crate::serialize::serialize(&doc).expect("serialize");
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let read_part = |z: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str| -> String {
            use std::io::Read;
            let mut s = String::new();
            z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        let header_out = read_part(&mut z, "Contents/header.xml");
        assert_eq!(header_out, header, "header.xml re-emitted byte-verbatim");
        assert!(
            header_out.contains(r#"type="NONE""#) && !header_out.contains(r#"type="SOLID""#),
            "saved borderFill stays all-NONE — no fabricated border"
        );
        let section_out = read_part(&mut z, "Contents/section0.xml");
        assert_eq!(section_out, section, "section re-emitted byte-verbatim");
        assert!(
            section_out.contains(r#"borderFillIDRef="1""#),
            "cells still reference the original NONE borderFill"
        );
    }

    /// Batch D: an `<hp:pic>` produces an `Inline::Image` carrying the binary ref + display size.
    #[test]
    fn pic_parses_into_inline_image() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:pic><hp:sz width="17340" height="12960"/><hc:img binaryItemIDRef="image1"/></hp:pic><hp:t></hp:t></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
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

    /// 본문 텍스트(섹션 루트 블록만) — 머리말/각주가 새면 여기 나타난다.
    fn body_text(blocks: &[Block]) -> String {
        let mut s = SemanticDoc::default();
        s.sections.push(Section {
            blocks: blocks.to_vec(),
            ..Default::default()
        });
        s.plain_text()
    }

    /// 회귀 잠금(3단계): 표의 세로 회계 두 축을 **함께** 잠근다 — `<hp:outMargin>` 이 표의
    /// 바깥 여백으로 읽히고, 표만 품은 빈 호스트 문단이 `is_table_anchor` 로 표시되는 것.
    /// 둘은 부호가 반대인 상쇄 오차라 한쪽만 되돌리면 쪽수가 깨진다(parse.rs 주석 참조).
    #[test]
    fn table_outer_margin_and_anchor_flag_are_both_read() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="1"><hp:outMargin left="283" right="284" top="285" bottom="286"/><hp:inMargin left="510" right="510" top="141" bottom="141"/><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl><hp:t></hp:t></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();

        let t = blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t),
                _ => None,
            })
            .expect("표");
        assert_eq!(
            (
                t.outer_margin_left,
                t.outer_margin_right,
                t.outer_margin_top,
                t.outer_margin_bottom
            ),
            (283, 284, 285, 286),
            "<hp:outMargin> 이 버려졌다"
        );
        // 표 기본 셀 패딩(<hp:inMargin>)은 그대로 — outMargin 을 덮어쓰지 않았는지 확인.
        assert_eq!(t.padding, Some([510, 510, 141, 141]));

        let anchor = blocks
            .iter()
            .find_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .expect("호스트 문단");
        assert!(
            anchor.is_table_anchor,
            "표만 품은 빈 문단은 표 앵커 = 줄을 예약하지 않는다"
        );
    }

    /// 표를 품었어도 **보이는 텍스트가 있으면** 앵커가 아니다 — 그 줄은 실제로 조판돼야 한다.
    #[test]
    fn table_host_paragraph_with_text_is_not_an_anchor() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1"><hp:run charPrIDRef="0"><hp:t>표 옆 글자</hp:t><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="500"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p><hp:p id="2"><hp:run><hp:t>빈 줄 아님</hp:t></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks, &mut Vec::new(), &Default::default()).unwrap();
        let hosts: Vec<&Paragraph> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .collect();
        assert!(
            !hosts[0].is_table_anchor,
            "텍스트가 있는 표 호스트 문단은 앵커가 아니다"
        );
        assert!(
            !hosts[1].is_table_anchor,
            "표를 안 품은 문단은 앵커가 아니다"
        );
    }

    /// 회귀 잠금(2단계): `<hp:header>`/`<hp:footer>` 안의 문단은 **본문 블록이 아니다**.
    /// 예전엔 `<hp:tc>` 만 blocks 프레임을 밀었기 때문에 머리말의 `</hp:p>` 가 섹션 루트로
    /// push 되어, 머리말 텍스트가 본문 첫 줄에 일반 문단으로 조판됐다(실측 확인됨).
    #[test]
    fn header_and_footer_bodies_never_leak_into_section_blocks() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1"><hp:run charPrIDRef="0"><hp:ctrl><hp:header id="5" applyPageType="ODD"><hp:subList><hp:p><hp:run><hp:t>ZZHEADERZZ</hp:t></hp:run></hp:p></hp:subList></hp:header></hp:ctrl><hp:ctrl><hp:footer id="6" applyPageType="BOTH"><hp:subList><hp:p><hp:run><hp:t>ZZFOOTERZZ</hp:t></hp:run></hp:p></hp:subList></hp:footer></hp:ctrl></hp:run></hp:p><hp:p id="2"><hp:run><hp:t>본문 한 줄</hp:t></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        let mut decos = Vec::new();
        parse_section(xml, &mut blocks, &mut decos, &Default::default()).unwrap();

        let text = body_text(&blocks);
        assert!(text.contains("본문 한 줄"), "본문은 그대로: {text}");
        assert!(
            !text.contains("ZZHEADERZZ") && !text.contains("ZZFOOTERZZ"),
            "머리말/꼬리말이 본문으로 샜다: {text}"
        );
        // 호스트 문단 1개 + 본문 문단 1개 = 2개. (예전엔 머리말/꼬리말 문단까지 4개였다.)
        assert_eq!(blocks.len(), 2, "본문 블록 수");

        // 머리말/꼬리말은 IR 의 제자리(Section.decorations)로.
        assert_eq!(decos.len(), 2);
        assert_eq!(decos[0].kind, DecoKind::Header);
        assert_eq!(decos[0].apply, ApplyPage::Odd);
        assert!(body_text(&decos[0].blocks).contains("ZZHEADERZZ"));
        assert_eq!(decos[1].kind, DecoKind::Footer);
        assert_eq!(decos[1].apply, ApplyPage::Both);
        assert!(body_text(&decos[1].blocks).contains("ZZFOOTERZZ"));
    }

    /// 회귀 잠금(2단계): 각주/미주 본문도 본문 블록이 아니라 호스트 런의 `Inline::Note` 로 간다
    /// (.hwp lift 와 같은 구조). 각주가 새면 본문 페이지에 각주 텍스트가 한 줄씩 더 조판된다.
    #[test]
    fn footnote_and_endnote_bodies_become_inline_notes_not_body_blocks() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="1"><hp:run charPrIDRef="0"><hp:t>앞</hp:t><hp:ctrl><hp:footNote number="3" suffixChar="41" instId="16"><hp:subList><hp:p><hp:run><hp:t>ZZFOOTNOTEZZ</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl><hp:t>뒤</hp:t></hp:run><hp:run><hp:ctrl><hp:endNote number="1" instId="99"><hp:subList><hp:p><hp:run><hp:t>ZZENDNOTEZZ</hp:t></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        let mut decos = Vec::new();
        parse_section(xml, &mut blocks, &mut decos, &Default::default()).unwrap();

        assert!(decos.is_empty());
        assert_eq!(blocks.len(), 1, "호스트 문단 하나뿐");
        let text = body_text(&blocks);
        assert_eq!(text.trim_end(), "앞뒤", "각주 본문이 본문으로 샜다: {text}");

        let Block::Paragraph(p) = &blocks[0] else {
            panic!("문단")
        };
        let notes: Vec<&NoteRef> = p
            .runs
            .iter()
            .flat_map(|r| r.content.iter())
            .filter_map(|i| match i {
                Inline::Note(n) => Some(n),
                _ => None,
            })
            .collect();
        assert_eq!(notes.len(), 2, "각주 + 미주");
        assert_eq!(notes[0].kind, NoteKind::Foot);
        assert_eq!((notes[0].number, notes[0].inst_id), (3, 16));
        assert_eq!(notes[0].suffix_char, 41, "suffixChar 는 WChar 코드");
        assert!(body_text(&notes[0].body).contains("ZZFOOTNOTEZZ"));
        assert_eq!(notes[1].kind, NoteKind::End);
        assert!(body_text(&notes[1].body).contains("ZZENDNOTEZZ"));
    }

    /// 실물 회귀: 머리말이 있는 코퍼스 문서(창도패)를 열었을 때 머리말 문단이 본문 블록에
    /// 없어야 한다 — 합성 XML 이 아니라 한컴이 실제로 쓴 중첩 구조로 잠근다.
    #[test]
    fn real_corpus_header_is_not_a_body_block() {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/private/bench-local-2026/files/독스헌터_창도패__창업도약패키지(일반형)_2025.hwpx"
        );
        let Ok(bytes) = std::fs::read(p) else {
            return; // private 코퍼스가 없는 체크아웃에서는 건너뛴다
        };
        let doc = parse_semantic(&bytes).expect("parse");
        let decos: usize = doc.sections.iter().map(|s| s.decorations.len()).sum();
        assert!(decos > 0, "머리말이 decorations 로 잡혀야 한다");
        for sec in &doc.sections {
            for d in &sec.decorations {
                let deco_text = body_text(&d.blocks);
                let t = deco_text.trim();
                if t.is_empty() {
                    continue;
                }
                assert!(
                    !body_text(&sec.blocks).contains(t),
                    "머리말 텍스트가 본문에도 있다: {t:?}"
                );
            }
        }
    }

    /// Build a minimal in-memory HWPX (ZIP) from `(name, bytes)` parts — a test fixture for the
    /// package-level parse paths. `pub(crate)` so the serializer's round-trip tests can seed the
    /// SAME kind of package (parse → edit → serialize) instead of forking a second builder.
    pub(crate) fn build_test_hwpx(parts: &[(&str, &[u8])]) -> Vec<u8> {
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
