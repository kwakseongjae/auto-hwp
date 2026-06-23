//! DOCX (OOXML word-processing) → [`SemanticDoc`] reader.
//!
//! We read the package with the workspace `zip` and parse the XML parts with `quick-xml` directly
//! (the same toolset the HWPX parser uses), rather than pulling a heavy OOXML crate — this keeps the
//! reader pure-Rust and dependency-light, and lets us map straight into our IR.
//!
//! Coverage (P5, full-ish edit):
//! - `word/document.xml`: paragraphs (`w:p`) → runs (`w:r`/`w:t`) with `w:rPr` formatting
//!   (bold/italic/underline/strike, super/subscript, `w:sz` size, `w:color`, `w:rFonts`),
//!   alignment (`w:jc`), named styles (`w:pStyle`), lists (`w:numPr`), tables (`w:tbl`/`w:tr`/`w:tc`
//!   with `w:gridCol` widths, `w:tcPr/w:shd` cell shading, `w:gridSpan`/`w:vMerge` spans), drawings
//!   (`w:drawing` → image via the `r:embed` relationship + `wp:extent`), page setup (`w:sectPr`).
//! - `word/header*.xml` / `word/footer*.xml` referenced from `w:sectPr` → [`PageDecoration`]s.
//! - Embedded media in `word/media/*` → [`BinData`] keyed by `bin_ref`, joined to a run via the
//!   `r:embed` relationship id resolved through `word/_rels/document.xml.rels`.
//! - Char/para formatting is interned into the shared `SemanticDoc` shape pools (mirroring OWPML's
//!   `charPrIDRef`/`paraPrIDRef`) in a post-pass so the rest of the engine reads it uniformly.

use hwp_model::prelude::*;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use crate::{emu_to_hwp, halfpt_to_hwp, twips_to_hwp};

fn docx_prov() -> Provenance {
    Provenance { source: Some(SourceFormat::Docx), raw: None }
}

/// Parse a `.docx` byte buffer into a `SemanticDoc`.
pub fn read(bytes: &[u8]) -> Result<SemanticDoc> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| Error::Parse(format!("docx zip open: {e}")))?;

    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();

    let document = read_named(&mut zip, "word/document.xml")
        .ok_or_else(|| Error::Parse("docx: missing word/document.xml".into()))?;
    let rels = read_named(&mut zip, "word/_rels/document.xml.rels").unwrap_or_default();
    let rel_map = parse_rels(&String::from_utf8_lossy(&rels));

    let mut doc = SemanticDoc::default();
    doc.origin = Some(SourceFormat::Docx);
    // Reserve index 0 as the DEFAULT shape (mirrors the HWPX parser): synthesized shapes start at ≥1.
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());

    // Embedded media → BinData; build rId → bin_ref so `a:blip r:embed` joins to its bytes.
    let mut rel_media: BTreeMap<String, String> = BTreeMap::new();
    for n in &names {
        if n.starts_with("word/media/") {
            if let Some(data) = read_named(&mut zip, n) {
                let base = n.rsplit('/').next().unwrap_or(n).to_string();
                let kind = base
                    .rsplit('.')
                    .next()
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_else(|| "bin".into());
                doc.bin_data.push(BinData { bin_ref: base.clone(), bytes: data, kind });
                for (rid, target) in &rel_map {
                    if target.rsplit('/').next().unwrap_or(target) == base {
                        rel_media.insert(rid.clone(), base.clone());
                    }
                }
            }
        }
    }

    let mut interner = ShapeInterner::new();
    let ctx = DocxCtx { rel_media: &rel_media };

    // Parse the body. DOCX is one body; we keep it as a single section and read its `w:sectPr` for
    // page setup + header/footer refs (inline multi-section splitting is a later refinement — see the
    // module doc; no body content is dropped).
    let xml = String::from_utf8_lossy(&document).into_owned();
    let raw_blocks = parse_block_container(&xml, &ctx);
    let blocks = intern_blocks(raw_blocks, &mut doc, &mut interner);

    let (page, deco_refs) = parse_first_sectpr(&xml);
    let mut decorations = Vec::new();
    for dref in deco_refs {
        if let Some(target) = rel_map.get(&dref.rid) {
            let part = if target.starts_with("word/") {
                target.clone()
            } else {
                format!("word/{target}")
            };
            if let Some(data) = read_named(&mut zip, &part) {
                let hxml = String::from_utf8_lossy(&data).into_owned();
                let raw = parse_block_container(&hxml, &ctx);
                let dblocks = intern_blocks(raw, &mut doc, &mut interner);
                decorations.push(PageDecoration { kind: dref.kind, apply: ApplyPage::Both, blocks: dblocks });
            }
        }
    }

    let mut section = Section {
        blocks,
        page,
        page_edited: false,
        decorations,
        provenance: docx_prov(),
        ..Default::default()
    };
    section.page = page;
    doc.sections.push(section);
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Resolve & read a part by name (case-sensitive; OOXML part names are stable).
fn read_named<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Parse `word/_rels/document.xml.rels` → { rId : Target }.
fn parse_rels(xml: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        let ev = reader.read_event();
        match ev {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if e.local_name().as_ref() == b"Relationship" {
                    if let (Some(id), Some(target)) = (attr_str(&e, b"Id"), attr_str(&e, b"Target")) {
                        map.insert(id, target);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

struct DocxCtx<'a> {
    rel_media: &'a BTreeMap<String, String>,
}

/// A header/footer reference parsed from a `w:sectPr` — the rId is resolved against the rels map.
struct DecoRef {
    kind: DecoKind,
    rid: String,
}

/// Extract the first `w:sectPr` → (page setup, header/footer refs). Defaults to A4 if absent.
fn parse_first_sectpr(xml: &str) -> (PageSetup, Vec<DecoRef>) {
    let mut page = PageSetup::default();
    let mut refs = Vec::new();
    let mut reader = Reader::from_str(xml);
    let mut in_sectpr = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    b"sectPr" => in_sectpr = true,
                    b"pgSz" if in_sectpr => {
                        if let Some(w) = attr_i64(&e, b"w") {
                            page.width = twips_to_hwp(w);
                        }
                        if let Some(h) = attr_i64(&e, b"h") {
                            page.height = twips_to_hwp(h);
                        }
                        if attr_str(&e, b"orient").as_deref() == Some("landscape") {
                            page.landscape = true;
                        }
                    }
                    b"pgMar" if in_sectpr => {
                        if let Some(v) = attr_i64(&e, b"left") {
                            page.margin_left = twips_to_hwp(v);
                        }
                        if let Some(v) = attr_i64(&e, b"right") {
                            page.margin_right = twips_to_hwp(v);
                        }
                        if let Some(v) = attr_i64(&e, b"top") {
                            page.margin_top = twips_to_hwp(v);
                        }
                        if let Some(v) = attr_i64(&e, b"bottom") {
                            page.margin_bottom = twips_to_hwp(v);
                        }
                    }
                    b"cols" if in_sectpr => {
                        if let Some(n) = attr_i64(&e, b"num") {
                            page.columns = n.clamp(1, 255) as u8;
                        }
                    }
                    b"headerReference" if in_sectpr => {
                        if let Some(rid) = attr_str(&e, b"id") {
                            refs.push(DecoRef { kind: DecoKind::Header, rid });
                        }
                    }
                    b"footerReference" if in_sectpr => {
                        if let Some(rid) = attr_str(&e, b"id") {
                            refs.push(DecoRef { kind: DecoKind::Footer, rid });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"sectPr" => {
                let _ = in_sectpr;
                break; // first sectPr only
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (page, refs)
}

// ---------- raw (pre-intern) block tree ----------
//
// We first build a raw tree carrying the *typed* CharShape/ParaShape values, then intern those into
// the shared `SemanticDoc` pools in a second pass (so we don't need `&mut doc` while reading XML).

enum RawBlock {
    Paragraph(RawPara),
    Table(RawTable),
}

struct RawPara {
    para: ParaShape,
    style_name: Option<String>,
    runs: Vec<RawRun>,
}

struct RawRun {
    cs: CharShape,
    content: Vec<Inline>,
}

struct RawTable {
    rows: usize,
    cols: usize,
    cells: Vec<RawCell>,
    col_widths: Vec<HwpUnit>,
}

struct RawCell {
    row: usize,
    col: usize,
    row_span: usize,
    col_span: usize,
    active: bool,
    shade: Option<Color>,
    blocks: Vec<RawBlock>,
}

/// Intern the raw shapes into `doc`'s pools and produce real `Block`s.
fn intern_blocks(raw: Vec<RawBlock>, doc: &mut SemanticDoc, it: &mut ShapeInterner) -> Vec<Block> {
    raw.into_iter()
        .map(|b| match b {
            RawBlock::Paragraph(p) => Block::Paragraph(intern_para(p, doc, it)),
            RawBlock::Table(t) => Block::Table(intern_table(t, doc, it)),
        })
        .collect()
}

fn intern_para(p: RawPara, doc: &mut SemanticDoc, it: &mut ShapeInterner) -> Paragraph {
    let para_shape = it.para(&p.para, doc);
    let mut runs: Vec<Run> = p
        .runs
        .into_iter()
        .filter(|r| !r.content.is_empty())
        .map(|r| Run { char_shape: it.char(&r.cs, doc), char_ref: None, content: r.content })
        .collect();
    if runs.is_empty() {
        runs.push(Run { char_shape: 0, char_ref: None, content: vec![Inline::Text(String::new())] });
    }
    Paragraph { para_shape, style_name: p.style_name, runs, provenance: docx_prov(), ..Default::default() }
}

fn intern_table(t: RawTable, doc: &mut SemanticDoc, it: &mut ShapeInterner) -> Table {
    let cells = t
        .cells
        .into_iter()
        .map(|c| Cell {
            row: c.row,
            col: c.col,
            row_span: c.row_span.max(1),
            col_span: c.col_span.max(1),
            blocks: intern_blocks(c.blocks, doc, it),
            active: c.active,
            shade_color: c.shade,
            ..Default::default()
        })
        .collect();
    Table {
        rows: t.rows,
        cols: t.cols,
        cells,
        col_widths: t.col_widths,
        provenance: docx_prov(),
        ..Default::default()
    }
}

/// Dedup char/para shapes into the doc pools, returning the pool index (0 = default).
struct ShapeInterner {
    chars: BTreeMap<String, usize>,
    paras: BTreeMap<String, usize>,
}

impl ShapeInterner {
    fn new() -> Self {
        ShapeInterner { chars: BTreeMap::new(), paras: BTreeMap::new() }
    }
    fn char(&mut self, cs: &CharShape, doc: &mut SemanticDoc) -> usize {
        if cs.is_default() {
            return 0;
        }
        let key = format!("{cs:?}");
        if let Some(&i) = self.chars.get(&key) {
            return i;
        }
        let i = doc.char_shapes.len();
        doc.char_shapes.push(cs.clone());
        self.chars.insert(key, i);
        i
    }
    fn para(&mut self, ps: &ParaShape, doc: &mut SemanticDoc) -> usize {
        if ps.is_default() {
            return 0;
        }
        let key = format!("{ps:?}");
        if let Some(&i) = self.paras.get(&key) {
            return i;
        }
        let i = doc.para_shapes.len();
        doc.para_shapes.push(ps.clone());
        self.paras.insert(key, i);
        i
    }
}

// ---------- XML → raw block tree ----------

/// Parse a block container (`w:body`, a header/footer root, or a table cell) into `RawBlock`s.
fn parse_block_container(xml: &str, ctx: &DocxCtx) -> Vec<RawBlock> {
    let mut reader = Reader::from_str(xml);
    let mut blocks: Vec<Vec<RawBlock>> = vec![Vec::new()];
    let mut tbls: Vec<TblFrame> = Vec::new();
    let mut paras: Vec<ParaAccum> = Vec::new();
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    b"p" => paras.push(ParaAccum::default()),
                    b"pPr" => {
                        if let Some(p) = paras.last_mut() {
                            p.in_ppr = true;
                        }
                    }
                    b"r" => {
                        if let Some(p) = paras.last_mut() {
                            p.flush_run();
                            p.cur = Some(RunAccum::default());
                        }
                    }
                    b"rPr" => {
                        if let Some(p) = paras.last_mut() {
                            if let Some(r) = p.cur.as_mut() {
                                r.in_rpr = true;
                            }
                        }
                    }
                    b"t" => in_text = true,
                    b"tbl" => tbls.push(TblFrame::default()),
                    b"tr" => {
                        if let Some(f) = tbls.last_mut() {
                            f.cur_row = Some(Vec::new());
                            f.table_rows += 1;
                        }
                    }
                    b"tc" => {
                        if let Some(f) = tbls.last_mut() {
                            f.open_cell();
                        }
                    }
                    _ => {}
                }
                handle_format(&e, &mut paras, &mut tbls);
            }
            Ok(Event::Empty(e)) => {
                handle_format(&e, &mut paras, &mut tbls);
                handle_empty(&e, &mut paras, ctx);
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    if let Some(p) = paras.last_mut() {
                        if let Some(r) = p.cur.as_mut() {
                            r.text.push_str(&t.unescape().unwrap_or_default());
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    b"t" => in_text = false,
                    b"rPr" => {
                        if let Some(p) = paras.last_mut() {
                            if let Some(r) = p.cur.as_mut() {
                                r.in_rpr = false;
                            }
                        }
                    }
                    b"pPr" => {
                        if let Some(p) = paras.last_mut() {
                            p.in_ppr = false;
                        }
                    }
                    b"r" => {
                        if let Some(p) = paras.last_mut() {
                            p.flush_run();
                        }
                    }
                    b"p" => {
                        if let Some(p) = paras.pop() {
                            push_block(&mut blocks, &mut tbls, RawBlock::Paragraph(p.into_para()));
                        }
                    }
                    b"tc" => {
                        if let Some(f) = tbls.last_mut() {
                            f.close_cell();
                        }
                    }
                    b"tr" => {
                        if let Some(f) = tbls.last_mut() {
                            f.close_row();
                        }
                    }
                    b"tbl" => {
                        if let Some(f) = tbls.pop() {
                            push_block(&mut blocks, &mut tbls, RawBlock::Table(f.into_table()));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    blocks.pop().unwrap_or_default()
}

/// Push a finished block into the innermost open container (an open table cell, else the body).
fn push_block(blocks: &mut [Vec<RawBlock>], tbls: &mut [TblFrame], b: RawBlock) {
    if let Some(f) = tbls.last_mut() {
        if let Some(cell) = f.cur_cell.as_mut() {
            cell.blocks.push(b);
            return;
        }
    }
    if let Some(top) = blocks.last_mut() {
        top.push(b);
    }
}

/// Handle a tag carrying paragraph/run/cell formatting (covers Start AND Empty events).
fn handle_format(e: &BytesStart, paras: &mut [ParaAccum], tbls: &mut [TblFrame]) {
    if let Some(p) = paras.last_mut() {
        let ln = e.local_name();
        if p.in_ppr {
            match ln.as_ref() {
                b"jc" => {
                    if let Some(v) = attr_str(e, b"val") {
                        p.para.align = map_align(&v);
                    }
                }
                b"pStyle" => p.style_name = attr_str(e, b"val"),
                b"numPr" => {
                    if p.style_name.is_none() {
                        p.style_name = Some("List".into());
                    }
                }
                _ => {}
            }
        }
        if let Some(r) = p.cur.as_mut() {
            if r.in_rpr {
                apply_run_format(e, r);
            }
        }
    }
    // Cell/table properties (gridCol widths, cell shading, spans).
    if let Some(f) = tbls.last_mut() {
        let ln = e.local_name();
        match ln.as_ref() {
            b"gridCol" => {
                if let Some(w) = attr_i64(e, b"w") {
                    f.grid.push(twips_to_hwp(w));
                }
            }
            b"gridSpan" => {
                if let Some(c) = f.cur_cell.as_mut() {
                    if let Some(n) = attr_i64(e, b"val") {
                        c.col_span = n.max(1) as usize;
                    }
                }
            }
            b"vMerge" => {
                if let Some(c) = f.cur_cell.as_mut() {
                    // A continuation merge (val="continue" or no val) deactivates the covered cell.
                    match attr_str(e, b"val").as_deref() {
                        Some("restart") => {}
                        _ => c.active = false,
                    }
                }
            }
            b"shd" => {
                if let Some(c) = f.cur_cell.as_mut() {
                    if let Some(fill) = attr_str(e, b"fill") {
                        if fill != "auto" {
                            c.shade = Color::from_hex(&fill);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// Apply a run-property element (`w:b`, `w:i`, `w:sz`, `w:color`, …) to the open run accumulator.
fn apply_run_format(e: &BytesStart, r: &mut RunAccum) {
    let on = |e: &BytesStart| -> bool {
        !matches!(attr_str(e, b"val").as_deref(), Some("false") | Some("0") | Some("off"))
    };
    match e.local_name().as_ref() {
        b"b" => r.cs.bold = on(e),
        b"i" => r.cs.italic = on(e),
        b"strike" => r.cs.strikeout = on(e),
        b"u" => r.cs.underline = attr_str(e, b"val").as_deref() != Some("none"),
        b"vertAlign" => match attr_str(e, b"val").as_deref() {
            Some("superscript") => r.cs.superscript = true,
            Some("subscript") => r.cs.subscript = true,
            _ => {}
        },
        b"sz" => {
            if let Some(v) = attr_i64(e, b"val") {
                r.cs.height = halfpt_to_hwp(v);
            }
        }
        b"color" => {
            if let Some(v) = attr_str(e, b"val") {
                if let Some(c) = Color::from_hex(&v) {
                    r.cs.text_color = c;
                }
            }
        }
        b"rFonts" => {
            if let Some(f) = attr_str(e, b"eastAsia").or_else(|| attr_str(e, b"ascii")) {
                r.cs.font_family = Some(f);
            }
        }
        _ => {}
    }
}

/// Handle an EMPTY element that isn't formatting: drawing extent + image blip, breaks.
fn handle_empty(e: &BytesStart, paras: &mut [ParaAccum], ctx: &DocxCtx) {
    let ln = e.local_name();
    match ln.as_ref() {
        b"extent" => {
            if let Some(p) = paras.last_mut() {
                if let Some(r) = p.cur.as_mut() {
                    let cx = attr_i64(e, b"cx").map(emu_to_hwp).unwrap_or(0);
                    let cy = attr_i64(e, b"cy").map(emu_to_hwp).unwrap_or(0);
                    r.pending_extent = Some((cx, cy));
                }
            }
        }
        b"blip" => {
            if let Some(rid) = attr_str(e, b"embed") {
                if let Some(bin_ref) = ctx.rel_media.get(&rid) {
                    if let Some(p) = paras.last_mut() {
                        if let Some(r) = p.cur.as_mut() {
                            let (w, h) = r.pending_extent.take().unwrap_or((0, 0));
                            r.content.push(Inline::Image(ImageRef { bin_ref: bin_ref.clone(), width: w, height: h }));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// ---------- accumulators ----------

#[derive(Default)]
struct ParaAccum {
    in_ppr: bool,
    para: ParaShape,
    style_name: Option<String>,
    runs: Vec<RawRun>,
    cur: Option<RunAccum>,
}

impl ParaAccum {
    fn flush_run(&mut self) {
        if let Some(r) = self.cur.take() {
            let mut content = Vec::new();
            if !r.text.is_empty() {
                content.push(Inline::Text(r.text));
            }
            content.extend(r.content);
            if !content.is_empty() {
                self.runs.push(RawRun { cs: r.cs, content });
            }
        }
    }
    fn into_para(mut self) -> RawPara {
        self.flush_run();
        RawPara { para: self.para, style_name: self.style_name, runs: self.runs }
    }
}

#[derive(Default)]
struct RunAccum {
    in_rpr: bool,
    cs: CharShape,
    text: String,
    content: Vec<Inline>,
    pending_extent: Option<(HwpUnit, HwpUnit)>,
}

// ---------- table frames ----------

#[derive(Default)]
struct TblFrame {
    table_rows: usize,
    cols: usize,
    cells: Vec<RawCell>,
    cur_row: Option<Vec<RawCell>>,
    cur_cell: Option<RawCell>,
    grid: Vec<HwpUnit>,
    col_cursor: usize,
}

impl TblFrame {
    fn open_cell(&mut self) {
        self.cur_cell = Some(RawCell {
            row: self.table_rows.saturating_sub(1),
            col: self.col_cursor,
            row_span: 1,
            col_span: 1,
            active: true,
            shade: None,
            blocks: Vec::new(),
        });
    }
    fn close_cell(&mut self) {
        if let Some(cell) = self.cur_cell.take() {
            self.col_cursor += cell.col_span.max(1);
            if let Some(row) = self.cur_row.as_mut() {
                row.push(cell);
            }
        }
    }
    fn close_row(&mut self) {
        self.col_cursor = 0;
        if let Some(row) = self.cur_row.take() {
            let cols = row.iter().map(|c| c.col + c.col_span.max(1)).max().unwrap_or(0);
            self.cols = self.cols.max(cols);
            self.cells.extend(row);
        }
    }
    fn into_table(mut self) -> RawTable {
        if self.cols == 0 && !self.grid.is_empty() {
            self.cols = self.grid.len();
        }
        RawTable {
            rows: self.table_rows,
            cols: self.cols,
            cells: self.cells,
            col_widths: self.grid,
        }
    }
}

// ---------- attribute helpers ----------

fn attr_str(e: &BytesStart, local: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        if a.key.local_name().as_ref() == local {
            Some(String::from_utf8_lossy(&a.value).into_owned())
        } else {
            None
        }
    })
}

fn attr_i64(e: &BytesStart, local: &[u8]) -> Option<i64> {
    attr_str(e, local).and_then(|s| s.trim().parse().ok())
}

fn map_align(v: &str) -> HorizontalAlign {
    match v {
        "left" | "start" => HorizontalAlign::Left,
        "right" | "end" => HorizontalAlign::Right,
        "center" => HorizontalAlign::Center,
        "distribute" => HorizontalAlign::Distribute,
        _ => HorizontalAlign::Justify,
    }
}

/// Assign stable in-memory `NodeId`s to top-level paragraphs (addressing for in-place edit ops).
fn assign_node_ids(doc: &mut SemanticDoc) {
    let mut next = 1u64;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            if let Block::Paragraph(p) = b {
                p.id = Some(NodeId(next));
                next += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a minimal valid `.docx` in memory: one bold paragraph, a 2x2 table, and the parts a
    /// reader needs (`[Content_Types].xml`, `word/document.xml`, rels). Uses the workspace `zip`.
    fn tiny_docx() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            zw.start_file("[Content_Types].xml", opts).unwrap();
            zw.write_all(br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#).unwrap();

            zw.start_file("word/_rels/document.xml.rels", opts).unwrap();
            zw.write_all(br#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#).unwrap();

            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(DOC_XML.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    const DOC_XML: &str = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="FF0000"/></w:rPr><w:t>Hello Bold</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>plain line</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>
      <w:tr>
        <w:tc><w:tcPr><w:shd w:fill="FFFF00"/></w:tcPr><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>"#;

    #[test]
    fn reads_paragraphs_runs_and_table() {
        let bytes = tiny_docx();
        let doc = read(&bytes).expect("read docx");
        assert_eq!(doc.origin, Some(SourceFormat::Docx));
        assert_eq!(doc.sections.len(), 1);
        let blocks = &doc.sections[0].blocks;

        // 2 paragraphs + 1 table.
        let paras: Vec<_> = blocks.iter().filter(|b| matches!(b, Block::Paragraph(_))).collect();
        let tables: Vec<_> = blocks.iter().filter(|b| matches!(b, Block::Table(_))).collect();
        assert_eq!(paras.len(), 2, "expected 2 paragraphs");
        assert_eq!(tables.len(), 1, "expected 1 table");

        // First paragraph: centered, bold + red + 14pt run "Hello Bold".
        if let Block::Paragraph(p) = &blocks[0] {
            let ps = &doc.para_shapes[p.para_shape];
            assert_eq!(ps.align, HorizontalAlign::Center);
            let run = &p.runs[0];
            let cs = &doc.char_shapes[run.char_shape];
            assert!(cs.bold, "run should be bold");
            assert_eq!(cs.height, 1400, "14pt → 1400 HWPUNIT");
            assert_eq!(cs.text_color, Color::from_hex("FF0000").unwrap());
            assert!(matches!(&run.content[0], Inline::Text(t) if t == "Hello Bold"));
        } else {
            panic!("block 0 not a paragraph");
        }

        // Table: 2x2, column widths preserved, A1 shaded yellow.
        if let Block::Table(t) = &blocks[2] {
            assert_eq!(t.rows, 2);
            assert_eq!(t.cols, 2);
            assert_eq!(t.cells.len(), 4);
            assert_eq!(t.col_widths.len(), 2);
            assert_eq!(t.col_widths[0], twips_to_hwp(4680));
            let a1 = &t.cells[0];
            assert_eq!(a1.shade_color, Color::from_hex("FFFF00"));
            assert!(matches!(&a1.blocks[0], Block::Paragraph(_)));
        } else {
            panic!("block 2 not a table");
        }

        // Page setup from sectPr: A4-ish (11906 x 16838 twips), 1-inch (1440 twip) margins.
        let page = doc.sections[0].page;
        assert_eq!(page.width, twips_to_hwp(11906));
        assert_eq!(page.height, twips_to_hwp(16838));
        assert_eq!(page.margin_left, twips_to_hwp(1440));

        // plain_text projection covers all cells.
        let text = doc.plain_text();
        assert!(text.contains("Hello Bold"));
        assert!(text.contains("plain line"));
        assert!(text.contains("A1") && text.contains("B2"));
    }
}
