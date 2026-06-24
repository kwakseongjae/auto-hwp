//! `hwp-jsx` — a **bidirectional codec** between the canonical [`SemanticDoc`]
//! (Rust, unchanged) and a [`JsxCssProject`] (the JSX-content + CSS-design
//! "project of files"). PIVOT milestone **M0** (design §9): prove the
//! JSX/CSS-projection premise with `parse(emit(doc)) == doc` — modeled content
//! value-equal, un-modeled content byte-/value-equal — headless, no renderer,
//! no React, no browser, no shaper.
//!
//! Canonical = `SemanticDoc`. JSX/CSS = a deterministic projection. `emit` maps the
//! interned `CharShape`/`ParaShape` pool indices to `.cN`/`.pN` CSS classes (dedup
//! inherited from `intern_*`), default shapes omit their class, and every un-modeled
//! datum (run `char_ref`, `ParaSource`, `Provenance.raw`, `Passthrough`, `BinData`,
//! per-section `PageSetup`) is carried losslessly so the round-trip is exact.

pub mod css;
pub mod equality;
pub mod jsx;
pub mod map;
pub mod op;
pub mod project;

use base64::{engine_decode, engine_encode};
use css::{CssRule, Selector, Stylesheet};
use hwp_model::prelude::*;
use jsx::{JsxElement, JsxNode, JsxText, Tag};
use map::{char_class_name, para_class_name};
use project::*;
use std::collections::BTreeMap;

/// Minimal in-crate base64 (avoids a workspace dep; standard alphabet, padded).
mod base64 {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn engine_encode(data: &[u8]) -> String {
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for chunk in data.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(A[(n >> 18 & 63) as usize] as char);
            out.push(A[(n >> 12 & 63) as usize] as char);
            out.push(if chunk.len() > 1 { A[(n >> 6 & 63) as usize] as char } else { '=' });
            out.push(if chunk.len() > 2 { A[(n & 63) as usize] as char } else { '=' });
        }
        out
    }

    pub fn engine_decode(s: &str) -> Result<Vec<u8>, String> {
        let val = |c: u8| -> Result<u32, String> {
            Ok(match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a' + 26) as u32,
                b'0'..=b'9' => (c - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                _ => return Err("bad base64".into()),
            })
        };
        let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
        let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
        for chunk in bytes.chunks(4) {
            if chunk.len() < 2 {
                return Err("truncated base64".into());
            }
            let pad = chunk.iter().filter(|&&c| c == b'=').count();
            let mut n = 0u32;
            for (k, &c) in chunk.iter().enumerate() {
                n |= if c == b'=' { 0 } else { val(c)? } << (18 - 6 * k);
            }
            out.push((n >> 16) as u8);
            if pad < 2 {
                out.push((n >> 8) as u8);
            }
            if pad < 1 {
                out.push(n as u8);
            }
        }
        Ok(out)
    }
}

fn b64(data: &[u8]) -> String {
    engine_encode(data)
}
fn unb64(s: &str) -> std::result::Result<Vec<u8>, String> {
    engine_decode(s)
}

// ===========================================================================
// EMIT  (SemanticDoc → JsxCssProject)
// ===========================================================================

/// Project a canonical [`SemanticDoc`] into a [`JsxCssProject`] (deterministic).
pub fn emit(doc: &SemanticDoc) -> JsxCssProject {
    // INVARIANT (interning/parser convention): pool index 0 is the DEFAULT shape, so the node-class
    // gate `shape != 0` (emit_run/emit_para) coincides with "non-default". reconstruct_* no longer
    // relies on this (it gates on rule presence), but the node-class gate still does — assert it so a
    // violation is loud, not a silently class-less non-default run.
    debug_assert!(
        doc.char_shapes.first().map(CharShape::is_default).unwrap_or(true),
        "char pool index 0 must be the default CharShape"
    );
    debug_assert!(
        doc.para_shapes.first().map(ParaShape::is_default).unwrap_or(true),
        "para pool index 0 must be the default ParaShape"
    );
    // 1. Stylesheet: pool index i → `.cN`/`.pN` (default shapes omit their class).
    let mut styles = Stylesheet::default();
    for (i, cs) in doc.char_shapes.iter().enumerate() {
        if cs.is_default() {
            continue;
        }
        styles.rules.push(CssRule {
            selector: Selector::Class(char_class_name(i)),
            decls: map::char_shape_to_decls(cs),
        });
    }
    for (i, ps) in doc.para_shapes.iter().enumerate() {
        if ps.is_default() {
            continue;
        }
        styles.rules.push(CssRule {
            selector: Selector::Class(para_class_name(i)),
            decls: map::para_shape_to_decls(ps),
        });
    }
    styles.rules.sort_by(|a, b| a.selector.cmp(&b.selector));

    // 2. JSX sections.
    let mut sections = Vec::with_capacity(doc.sections.len());
    let mut section_metas = Vec::with_capacity(doc.sections.len());
    for (si, sec) in doc.sections.iter().enumerate() {
        let mut el = JsxElement::new(Tag::Section).with_attr("data-sec", si.to_string());
        for b in &sec.blocks {
            el.children.push(emit_block(b));
        }
        sections.push(JsxNode::Element(el));
        section_metas.push(emit_section_meta(sec));
    }

    // 3. Root <Document>.
    let mut doc_el = JsxElement::new(Tag::Document);
    for si in 0..sections.len() {
        // The document references each section; we inline a stub <Section data-ref=i/>.
        doc_el.children.push(JsxNode::Element(
            JsxElement::new(Tag::Section).with_attr("data-ref", si.to_string()),
        ));
    }

    // 4. Manifest (lossless side channel).
    let manifest = Manifest {
        schema_version: PROJECT_SCHEMA_VERSION,
        doc_passthrough: emit_rawparts(&doc.passthrough.parts),
        char_shapes: doc.char_shapes.iter().map(map::shape_blob_char).collect(),
        para_shapes: doc.para_shapes.iter().map(map::shape_blob_para).collect(),
        header_char: doc
            .header_pools
            .char
            .iter()
            .map(|(k, v)| (*k, map::shape_blob_char(v)))
            .collect(),
        header_para: doc
            .header_pools
            .para
            .iter()
            .map(|(k, v)| (*k, map::shape_blob_para(v)))
            .collect(),
        sections: section_metas,
        asset_meta: doc
            .bin_data
            .iter()
            .map(|b| AssetMeta { bin_ref: b.bin_ref.clone(), kind: b.kind.clone() })
            .collect(),
    };

    let assets = doc
        .bin_data
        .iter()
        .map(|b| Asset { bin_ref: b.bin_ref.clone(), kind: b.kind.clone(), b64: b64(&b.bytes) })
        .collect();

    JsxCssProject {
        manifest,
        document: JsxNode::Element(doc_el),
        sections,
        styles,
        assets,
        dirty: DirtySet::default(),
    }
}

fn emit_rawparts(parts: &[RawPart]) -> Vec<RawPartBlob> {
    parts.iter().map(|p| RawPartBlob { tag: p.tag.clone(), b64: b64(&p.bytes) }).collect()
}

fn emit_section_meta(sec: &Section) -> SectionMeta {
    SectionMeta {
        page: PageSetupBlob::from(&sec.page),
        page_edited: sec.page_edited,
        provenance_raw_b64: sec.provenance.raw.as_ref().map(|r| b64(r)),
        provenance_source: sec.provenance.source.map(|s| s.as_str().to_string()),
        passthrough: emit_rawparts(&sec.passthrough.parts),
        dirty: sec.dirty.is_dirty(),
        decorations: sec.decorations.iter().map(emit_decoration).collect(),
    }
}

fn emit_decoration(d: &PageDecoration) -> DecorationBlob {
    DecorationBlob {
        kind: match d.kind {
            DecoKind::Header => "header",
            DecoKind::Footer => "footer",
        }
        .into(),
        apply: match d.apply {
            ApplyPage::Both => "both",
            ApplyPage::Even => "even",
            ApplyPage::Odd => "odd",
        }
        .into(),
        blocks_json: serde_json::to_string(
            &d.blocks.iter().map(emit_block).collect::<Vec<_>>(),
        )
        .unwrap_or_default(),
    }
}

fn emit_block(b: &Block) -> JsxNode {
    match b {
        Block::Paragraph(p) => emit_para(p),
        Block::Table(t) => emit_table(t),
    }
}

fn emit_para(p: &Paragraph) -> JsxNode {
    let mut el = JsxElement::new(Tag::Para);
    if p.para_shape != 0 {
        el.class_list.push(para_class_name(p.para_shape));
    }
    if let Some(id) = p.id {
        el.id = Some(format!("n{}", id.0));
    }
    if let Some(name) = &p.style_name {
        el.attrs.insert("data-style".into(), name.clone());
    }
    if let Some(src) = &p.source {
        el.attrs.insert("data-src".into(), encode_para_source(src));
    }
    el.attrs.insert("data-prov".into(), encode_provenance(&p.provenance));
    if !p.passthrough.is_empty() {
        el.attrs.insert(
            "data-pass".into(),
            serde_json::to_string(&emit_rawparts(&p.passthrough.parts)).unwrap_or_default(),
        );
    }
    if p.dirty.is_dirty() {
        el.attrs.insert("data-dirty".into(), "1".into());
    }
    for run in &p.runs {
        el.children.push(emit_run(run));
    }
    JsxNode::Element(el)
}

fn emit_run(r: &Run) -> JsxNode {
    let mut el = JsxElement::new(Tag::Run);
    if r.char_shape != 0 {
        el.class_list.push(char_class_name(r.char_shape));
    }
    if let Some(cref) = &r.char_ref {
        el.attrs.insert("data-cref".into(), cref.clone());
    }
    for inl in &r.content {
        el.children.push(emit_inline(inl));
    }
    JsxNode::Element(el)
}

fn emit_inline(inl: &Inline) -> JsxNode {
    match inl {
        Inline::Text(t) => JsxNode::Text(JsxText { node_key: None, text: t.clone() }),
        Inline::Image(img) => JsxNode::Element(
            JsxElement::new(Tag::Image)
                .with_attr("src", format!("assets/{}", img.bin_ref))
                .with_attr("data-w", img.width.to_string())
                .with_attr("data-h", img.height.to_string()),
        ),
        Inline::Equation(e) => JsxNode::Element(
            JsxElement::new(Tag::Equation).with_attr("data-b64", b64(&encode_equation(e))),
        ),
        Inline::FieldBegin(f) => JsxNode::Element(
            JsxElement::new(Tag::Field)
                .with_attr("data-begin", "1")
                .with_attr("data-id", f.id.to_string())
                .with_attr("data-type", f.field_type.clone())
                .with_attr("data-cmd", f.command.clone()),
        ),
        Inline::FieldEnd(id) => JsxNode::Element(
            JsxElement::new(Tag::Field).with_attr("data-end", id.to_string()),
        ),
        Inline::Bookmark(name) => {
            JsxNode::Element(JsxElement::new(Tag::Bookmark).with_attr("data-name", name.clone()))
        }
        Inline::Note(n) => JsxNode::Element(
            JsxElement::new(Tag::Note).with_attr("data-b64", b64(&encode_note(n))),
        ),
        Inline::Raw(rp) => JsxNode::Element(
            JsxElement::new(Tag::Raw)
                .with_attr("data-tag", rp.tag.clone())
                .with_attr("data-b64", b64(&rp.bytes)),
        ),
    }
}

fn emit_table(t: &Table) -> JsxNode {
    let mut el = JsxElement::new(Tag::Table)
        .with_attr("data-rows", t.rows.to_string())
        .with_attr("data-cols", t.cols.to_string());
    if !t.col_widths.is_empty() {
        let w = t.col_widths.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(",");
        el.attrs.insert("data-colw".into(), w);
    }
    el.attrs.insert("data-prov".into(), encode_provenance(&t.provenance));
    if !t.passthrough.is_empty() {
        el.attrs.insert(
            "data-pass".into(),
            serde_json::to_string(&emit_rawparts(&t.passthrough.parts)).unwrap_or_default(),
        );
    }
    if t.dirty.is_dirty() {
        el.attrs.insert("data-dirty".into(), "1".into());
    }
    // Cells are emitted flat (one <TableCell> each) — the parser reconstructs the Vec<Cell>
    // in order; HWP's merge convention keeps covered cells active=false but present.
    for c in &t.cells {
        el.children.push(emit_cell(c));
    }
    JsxNode::Element(el)
}

fn emit_cell(c: &Cell) -> JsxNode {
    let mut el = JsxElement::new(Tag::TableCell)
        .with_attr("data-row", c.row.to_string())
        .with_attr("data-col", c.col.to_string());
    if c.col_span != 1 {
        el.attrs.insert("colSpan".into(), c.col_span.to_string());
    }
    if c.row_span != 1 {
        el.attrs.insert("rowSpan".into(), c.row_span.to_string());
    }
    if !c.active {
        el.attrs.insert("data-inactive".into(), "1".into());
    }
    if let Some(sh) = c.shade_color {
        el.attrs.insert("data-shade".into(), sh.to_hex());
    }
    // A borderless cell (has_border=false) carries the legacy data-noborder flag so the field
    // round-trips faithfully. (When per-edge borders are also present the renderer uses THOSE, but we
    // still preserve has_border exactly so the codec is lossless — see cell_eq.)
    if !c.has_border {
        el.attrs.insert("data-noborder".into(), "1".into());
    }
    // Per-edge borders (lifted from the real borderFill): "L|R|T|B" where each side is
    // "style,hex,width" or "-" for an unspecified edge. data-diag = "kind,hex,width".
    if c.has_edge_borders() {
        el.attrs.insert("data-borders".into(), encode_cell_borders(&c.borders));
    }
    if let Some(d) = c.diagonal {
        el.attrs.insert("data-diag".into(), encode_cell_diagonal(d));
    }
    if c.dirty.is_dirty() {
        el.attrs.insert("data-dirty".into(), "1".into());
    }
    for b in &c.blocks {
        el.children.push(emit_block(b));
    }
    JsxNode::Element(el)
}

/// Encode the four per-edge borders as "left|right|top|bottom", each side "style,#RRGGBB,width" or
/// "-" when the edge is unspecified (`None`). style ∈ {none,solid,dashed,dotted,double}.
fn encode_cell_borders(borders: &[Option<CellEdge>; 4]) -> String {
    borders
        .iter()
        .map(|e| match e {
            Some(edge) => format!("{},{},{}", line_style_str(edge.style), edge.color.to_hex(), edge.width_px),
            None => "-".to_string(),
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn decode_cell_borders(s: &str) -> [Option<CellEdge>; 4] {
    let mut out = [None; 4];
    for (i, side) in s.split('|').enumerate().take(4) {
        if side == "-" {
            continue;
        }
        let mut it = side.split(',');
        let style = it.next().map(line_style_from_str).unwrap_or(LineStyle::Solid);
        let color = it.next().and_then(Color::from_hex).unwrap_or_default();
        let width_px = it.next().and_then(|w| w.parse().ok()).unwrap_or(1.0);
        out[i] = Some(CellEdge { color, style, width_px });
    }
    out
}

fn encode_cell_diagonal(d: CellDiagonal) -> String {
    let kind = match d.kind {
        DiagonalKind::Slash => "slash",
        DiagonalKind::BackSlash => "backslash",
    };
    format!("{},{},{}", kind, d.color.to_hex(), d.width_px)
}

fn decode_cell_diagonal(s: &str) -> Option<CellDiagonal> {
    let mut it = s.split(',');
    let kind = match it.next()? {
        "slash" => DiagonalKind::Slash,
        "backslash" => DiagonalKind::BackSlash,
        _ => return None,
    };
    let color = it.next().and_then(Color::from_hex).unwrap_or_default();
    let width_px = it.next().and_then(|w| w.parse().ok()).unwrap_or(1.0);
    Some(CellDiagonal { kind, color, width_px })
}

fn line_style_str(s: LineStyle) -> &'static str {
    match s {
        LineStyle::None => "none",
        LineStyle::Solid => "solid",
        LineStyle::Dashed => "dashed",
        LineStyle::Dotted => "dotted",
        LineStyle::Double => "double",
    }
}

fn line_style_from_str(s: &str) -> LineStyle {
    match s {
        "none" => LineStyle::None,
        "dashed" => LineStyle::Dashed,
        "dotted" => LineStyle::Dotted,
        "double" => LineStyle::Double,
        _ => LineStyle::Solid,
    }
}

// ---- scalar encoders (compact JSON, base64'd where needed) ----

fn encode_para_source(src: &ParaSource) -> String {
    serde_json::to_string(&ParaSourceBlob {
        span: [src.span.0, src.span.1],
        para_pr: src.para_pr.clone(),
        style: src.style.clone(),
        id: src.id.clone(),
        simple: src.simple,
    })
    .unwrap_or_default()
}

fn decode_para_source(s: &str) -> Option<ParaSource> {
    let b: ParaSourceBlob = serde_json::from_str(s).ok()?;
    Some(ParaSource {
        span: (b.span[0], b.span[1]),
        para_pr: b.para_pr,
        style: b.style,
        id: b.id,
        simple: b.simple,
    })
}

fn encode_provenance(p: &Provenance) -> String {
    serde_json::to_string(&ProvBlob {
        source: p.source.map(|s| s.as_str().to_string()),
        raw_b64: p.raw.as_ref().map(|r| b64(r)),
    })
    .unwrap_or_default()
}

fn decode_provenance(s: &str) -> Provenance {
    let b: ProvBlob = serde_json::from_str(s).unwrap_or(ProvBlob { source: None, raw_b64: None });
    Provenance {
        source: b.source.as_deref().and_then(parse_source_format),
        raw: b.raw_b64.as_deref().and_then(|x| unb64(x).ok()),
    }
}

fn parse_source_format(s: &str) -> Option<SourceFormat> {
    Some(match s {
        "hwp5" => SourceFormat::Hwp5,
        "hwp3" => SourceFormat::Hwp3,
        "hwpx" => SourceFormat::Hwpx,
        "unknown" => SourceFormat::Unknown,
        _ => return None,
    })
}

fn encode_equation(e: &EquationRef) -> Vec<u8> {
    serde_json::to_vec(&EqBlob {
        script: e.script.clone(),
        font: e.font.clone(),
        base_unit: e.base_unit,
        baseline: e.baseline,
        color: [e.color.r, e.color.g, e.color.b, e.color.a],
        width: e.width,
        height: e.height,
        version: e.version.clone(),
    })
    .unwrap_or_default()
}

fn decode_equation(bytes: &[u8]) -> EquationRef {
    let b: EqBlob = serde_json::from_slice(bytes).unwrap_or_default();
    EquationRef {
        script: b.script,
        font: b.font,
        base_unit: b.base_unit,
        baseline: b.baseline,
        color: Color { r: b.color[0], g: b.color[1], b: b.color[2], a: b.color[3] },
        width: b.width,
        height: b.height,
        version: b.version,
    }
}

fn encode_note(n: &NoteRef) -> Vec<u8> {
    serde_json::to_vec(&NoteBlob {
        kind: matches!(n.kind, NoteKind::End),
        number: n.number,
        prefix_char: n.prefix_char,
        suffix_char: n.suffix_char,
        inst_id: n.inst_id,
        body: serde_json::to_string(&n.body.iter().map(emit_block).collect::<Vec<_>>())
            .unwrap_or_default(),
    })
    .unwrap_or_default()
}

fn decode_note(bytes: &[u8]) -> std::result::Result<NoteRef, String> {
    let b: NoteBlob = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let body_nodes: Vec<JsxNode> = serde_json::from_str(&b.body).map_err(|e| e.to_string())?;
    let body = body_nodes
        .iter()
        .map(|n| parse_block(n).map_err(|e| e.to_string()))
        .collect::<std::result::Result<Vec<_>, String>>()?;
    Ok(NoteRef {
        kind: if b.kind { NoteKind::End } else { NoteKind::Foot },
        number: b.number,
        prefix_char: b.prefix_char,
        suffix_char: b.suffix_char,
        inst_id: b.inst_id,
        body,
    })
}

// ===========================================================================
// PARSE  (JsxCssProject → SemanticDoc)
// ===========================================================================

/// Reconstruct the canonical [`SemanticDoc`] from a [`JsxCssProject`] (exact inverse of [`emit`]).
#[allow(clippy::field_reassign_with_default)]
pub fn parse(proj: &JsxCssProject) -> Result<SemanticDoc> {
    let mut doc = SemanticDoc::default();

    // Pools: the manifest blobs are authoritative for length + every field; the CSS class
    // decls (.cN/.pN) are an exact inverse of the modeled subset. We reconstruct from the
    // blob then overlay the (possibly AI-edited) CSS decls so a CSS-only op is reflected.
    doc.char_shapes = proj
        .manifest
        .char_shapes
        .iter()
        .enumerate()
        .map(|(i, blob)| reconstruct_char_shape(i, blob, &proj.styles))
        .collect::<Result<_>>()?;
    doc.para_shapes = proj
        .manifest
        .para_shapes
        .iter()
        .enumerate()
        .map(|(i, blob)| reconstruct_para_shape(i, blob, &proj.styles))
        .collect::<Result<_>>()?;

    for (k, v) in &proj.manifest.header_char {
        doc.header_pools.char.insert(*k, map::shape_from_blob_char(v)?);
    }
    for (k, v) in &proj.manifest.header_para {
        doc.header_pools.para.insert(*k, map::shape_from_blob_para(v)?);
    }

    doc.passthrough = Passthrough { parts: parse_rawparts(&proj.manifest.doc_passthrough)? };

    doc.bin_data = proj
        .assets
        .iter()
        .map(|a| Ok(BinData { bin_ref: a.bin_ref.clone(), bytes: unb64(&a.b64).map_err(err)?, kind: a.kind.clone() }))
        .collect::<Result<_>>()?;

    for (si, sec_node) in proj.sections.iter().enumerate() {
        let meta = proj
            .manifest
            .sections
            .get(si)
            .ok_or_else(|| Error::Parse(format!("section {si} meta missing")))?;
        let blocks = match sec_node {
            JsxNode::Element(e) => e.children.iter().map(parse_block).collect::<Result<_>>()?,
            _ => return Err(Error::Parse("section node is not an element".into())),
        };
        doc.sections.push(Section {
            blocks,
            page: meta.page.into(),
            page_edited: meta.page_edited,
            decorations: meta.decorations.iter().map(parse_decoration).collect::<Result<_>>()?,
            provenance: Provenance {
                source: meta.provenance_source.as_deref().and_then(parse_source_format),
                raw: meta.provenance_raw_b64.as_deref().map(unb64).transpose().map_err(err)?,
            },
            passthrough: Passthrough { parts: parse_rawparts(&meta.passthrough)? },
            dirty: Dirty(meta.dirty),
        });
    }

    Ok(doc)
}

fn err(s: String) -> Error {
    Error::Parse(s)
}

fn reconstruct_char_shape(i: usize, blob: &str, styles: &Stylesheet) -> Result<CharShape> {
    let mut s = map::shape_from_blob_char(blob)?;
    // Overlay CSS decls (so an AI CssSetDecl on .cN is reflected on reparse). Gate on rule PRESENCE,
    // never on `i != 0`: emit creates a `.cN` rule iff the shape is non-default (any index), so a
    // non-default shape interned at index 0 would otherwise have its `.c0` rule (and any AI op on it)
    // SILENTLY dropped. `styles.rule(..)` already returns None for a default shape (no rule emitted).
    if let Some(rule) = styles.rule(&Selector::Class(char_class_name(i))) {
        s = map::decls_to_char_shape(&overlay(&map::char_shape_to_decls(&s), &rule.decls));
    }
    Ok(s)
}

fn reconstruct_para_shape(i: usize, blob: &str, styles: &Stylesheet) -> Result<ParaShape> {
    let mut s = map::shape_from_blob_para(blob)?;
    if let Some(rule) = styles.rule(&Selector::Class(para_class_name(i))) {
        s = map::decls_to_para_shape(&overlay(&map::para_shape_to_decls(&s), &rule.decls));
    }
    Ok(s)
}

/// Merge `css` decls over `base` (css wins). The `--shape` blob stays from `base`
/// (so non-modeled fields survive) but modeled props that the css changed override it.
fn overlay(
    base: &BTreeMap<String, String>,
    css: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out = base.clone();
    for (k, v) in css {
        if k == "--shape" {
            continue; // keep the lossless base blob
        }
        out.insert(k.clone(), v.clone());
    }
    out
}

fn parse_rawparts(blobs: &[RawPartBlob]) -> Result<Vec<RawPart>> {
    blobs
        .iter()
        .map(|b| Ok(RawPart { tag: b.tag.clone(), bytes: unb64(&b.b64).map_err(err)? }))
        .collect()
}

fn parse_decoration(d: &DecorationBlob) -> Result<PageDecoration> {
    let nodes: Vec<JsxNode> = serde_json::from_str(&d.blocks_json).map_err(|e| err(e.to_string()))?;
    Ok(PageDecoration {
        kind: if d.kind == "footer" { DecoKind::Footer } else { DecoKind::Header },
        apply: match d.apply.as_str() {
            "even" => ApplyPage::Even,
            "odd" => ApplyPage::Odd,
            _ => ApplyPage::Both,
        },
        blocks: nodes.iter().map(parse_block).collect::<Result<_>>()?,
    })
}

fn parse_block(node: &JsxNode) -> Result<Block> {
    let el = match node {
        JsxNode::Element(e) => e,
        JsxNode::Text(_) => return Err(Error::Parse("block position holds bare text".into())),
    };
    match el.tag() {
        Some(Tag::Para) => Ok(Block::Paragraph(parse_para(el)?)),
        Some(Tag::Table) => Ok(Block::Table(parse_table(el)?)),
        other => Err(Error::Parse(format!("unexpected block tag {other:?}"))),
    }
}

fn parse_para(el: &JsxElement) -> Result<Paragraph> {
    let para_shape = el
        .class_list
        .iter()
        .find_map(|c| map::para_class_index(c))
        .unwrap_or(0);
    let id = el
        .id
        .as_deref()
        .and_then(|s| s.strip_prefix('n'))
        .and_then(|n| n.parse().ok())
        .map(NodeId);
    let runs = el
        .children
        .iter()
        .map(|c| match c {
            JsxNode::Element(e) if e.tag() == Some(Tag::Run) => parse_run(e),
            _ => Err(Error::Parse("paragraph child is not a Run".into())),
        })
        .collect::<Result<_>>()?;
    Ok(Paragraph {
        id,
        para_shape,
        style_name: el.attrs.get("data-style").cloned(),
        runs,
        source: el.attrs.get("data-src").and_then(|s| decode_para_source(s)),
        provenance: el.attrs.get("data-prov").map(|s| decode_provenance(s)).unwrap_or_default(),
        passthrough: parse_pass_attr(el)?,
        dirty: Dirty(el.attrs.contains_key("data-dirty")),
    })
}

fn parse_pass_attr(el: &JsxElement) -> Result<Passthrough> {
    match el.attrs.get("data-pass") {
        Some(s) => {
            let blobs: Vec<RawPartBlob> = serde_json::from_str(s).map_err(|e| err(e.to_string()))?;
            Ok(Passthrough { parts: parse_rawparts(&blobs)? })
        }
        None => Ok(Passthrough::default()),
    }
}

fn parse_run(el: &JsxElement) -> Result<Run> {
    let char_shape = el
        .class_list
        .iter()
        .find_map(|c| map::char_class_index(c))
        .unwrap_or(0);
    let content = el.children.iter().map(parse_inline).collect::<Result<_>>()?;
    Ok(Run { char_shape, char_ref: el.attrs.get("data-cref").cloned(), content })
}

fn parse_inline(node: &JsxNode) -> Result<Inline> {
    match node {
        JsxNode::Text(t) => Ok(Inline::Text(t.text.clone())),
        JsxNode::Element(e) => match e.tag() {
            Some(Tag::Image) => Ok(Inline::Image(ImageRef {
                bin_ref: e
                    .attrs
                    .get("src")
                    .map(|s| s.strip_prefix("assets/").unwrap_or(s).to_string())
                    .unwrap_or_default(),
                width: e.attrs.get("data-w").and_then(|v| v.parse().ok()).unwrap_or(0),
                height: e.attrs.get("data-h").and_then(|v| v.parse().ok()).unwrap_or(0),
            })),
            Some(Tag::Equation) => {
                let bytes = unb64(e.attrs.get("data-b64").map(String::as_str).unwrap_or("")).map_err(err)?;
                Ok(Inline::Equation(decode_equation(&bytes)))
            }
            Some(Tag::Field) => {
                if let Some(end) = e.attrs.get("data-end") {
                    Ok(Inline::FieldEnd(end.parse().map_err(|_| err("bad field end".into()))?))
                } else {
                    Ok(Inline::FieldBegin(FieldMarker {
                        id: e.attrs.get("data-id").and_then(|v| v.parse().ok()).unwrap_or(0),
                        field_type: e.attrs.get("data-type").cloned().unwrap_or_default(),
                        command: e.attrs.get("data-cmd").cloned().unwrap_or_default(),
                    }))
                }
            }
            Some(Tag::Bookmark) => {
                Ok(Inline::Bookmark(e.attrs.get("data-name").cloned().unwrap_or_default()))
            }
            Some(Tag::Note) => {
                let bytes = unb64(e.attrs.get("data-b64").map(String::as_str).unwrap_or("")).map_err(err)?;
                Ok(Inline::Note(decode_note(&bytes).map_err(err)?))
            }
            Some(Tag::Raw) => Ok(Inline::Raw(RawPart {
                tag: e.attrs.get("data-tag").cloned().unwrap_or_default(),
                bytes: unb64(e.attrs.get("data-b64").map(String::as_str).unwrap_or("")).map_err(err)?,
            })),
            // Out-of-grammar inline (only reachable from hand-/AI-authored JSX — emit never produces
            // it): a CLEAN typed Err, never a panic. The §3.3 "<Raw> fallback" (salvage unknown nodes
            // as Raw instead of erroring) is a later refinement; M0 rejects rather than salvages.
            other => Err(Error::Parse(format!("unexpected inline tag {other:?}"))),
        },
    }
}

fn parse_table(el: &JsxElement) -> Result<Table> {
    let cells = el
        .children
        .iter()
        .map(|c| match c {
            JsxNode::Element(e) if e.tag() == Some(Tag::TableCell) => parse_cell(e),
            _ => Err(Error::Parse("table child is not a TableCell".into())),
        })
        .collect::<Result<_>>()?;
    let col_widths = el
        .attrs
        .get("data-colw")
        .map(|s| s.split(',').filter_map(|w| w.parse().ok()).collect())
        .unwrap_or_default();
    Ok(Table {
        rows: el.attrs.get("data-rows").and_then(|v| v.parse().ok()).unwrap_or(0),
        cols: el.attrs.get("data-cols").and_then(|v| v.parse().ok()).unwrap_or(0),
        cells,
        col_widths,
        outer_margin_top: el.attrs.get("data-omt").and_then(|v| v.parse().ok()).unwrap_or(0),
        outer_margin_bottom: el.attrs.get("data-omb").and_then(|v| v.parse().ok()).unwrap_or(0),
        provenance: el.attrs.get("data-prov").map(|s| decode_provenance(s)).unwrap_or_default(),
        passthrough: parse_pass_attr(el)?,
        dirty: Dirty(el.attrs.contains_key("data-dirty")),
    })
}

fn parse_cell(el: &JsxElement) -> Result<Cell> {
    let blocks = el.children.iter().map(parse_block).collect::<Result<_>>()?;
    Ok(Cell {
        row: el.attrs.get("data-row").and_then(|v| v.parse().ok()).unwrap_or(0),
        col: el.attrs.get("data-col").and_then(|v| v.parse().ok()).unwrap_or(0),
        col_span: el.attrs.get("colSpan").and_then(|v| v.parse().ok()).unwrap_or(1),
        row_span: el.attrs.get("rowSpan").and_then(|v| v.parse().ok()).unwrap_or(1),
        blocks,
        active: !el.attrs.contains_key("data-inactive"),
        shade_color: el.attrs.get("data-shade").and_then(|s| Color::from_hex(s)),
        // Borderless cells carry data-noborder; absence keeps the default (bordered) cell.
        has_border: !el.attrs.contains_key("data-noborder"),
        borders: el.attrs.get("data-borders").map(|s| decode_cell_borders(s)).unwrap_or([None; 4]),
        diagonal: el.attrs.get("data-diag").and_then(|s| decode_cell_diagonal(s)),
        dirty: Dirty(el.attrs.contains_key("data-dirty")),
    })
}

// ===========================================================================
// DISK  (JsxCssProject ↔ project directory)
// ===========================================================================

/// Write a project to a directory (§3.5 layout): project.json, document.jsx,
/// sections/section-k.jsx, styles/document.css, assets/*.
pub fn write_project_dir(proj: &JsxCssProject, dir: &std::path::Path) -> Result<()> {
    let io = |e: std::io::Error| Error::Io(e.to_string());
    std::fs::create_dir_all(dir).map_err(io)?;
    std::fs::create_dir_all(dir.join("sections")).map_err(io)?;
    std::fs::create_dir_all(dir.join("styles")).map_err(io)?;
    std::fs::create_dir_all(dir.join("assets")).map_err(io)?;

    std::fs::write(
        dir.join("project.json"),
        serde_json::to_vec_pretty(&proj.manifest).map_err(|e| err(e.to_string()))?,
    )
    .map_err(io)?;
    std::fs::write(dir.join("document.jsx"), jsx::emit_jsx(&proj.document)).map_err(io)?;
    for (i, sec) in proj.sections.iter().enumerate() {
        std::fs::write(dir.join(format!("sections/section-{i}.jsx")), jsx::emit_jsx(sec))
            .map_err(io)?;
    }
    std::fs::write(dir.join("styles/document.css"), css::emit_css(&proj.styles)).map_err(io)?;
    for a in &proj.assets {
        std::fs::write(dir.join(format!("assets/{}", a.bin_ref)), unb64(&a.b64).map_err(err)?)
            .map_err(io)?;
    }
    Ok(())
}

/// Read a project back from a directory written by [`write_project_dir`].
pub fn read_project_dir(dir: &std::path::Path) -> Result<JsxCssProject> {
    let io = |e: std::io::Error| Error::Io(e.to_string());
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(dir.join("project.json")).map_err(io)?,
    )
    .map_err(|e| err(e.to_string()))?;
    let document =
        jsx::parse_jsx(&std::fs::read_to_string(dir.join("document.jsx")).map_err(io)?)
            .map_err(err)?;
    let mut sections = Vec::with_capacity(manifest.sections.len());
    for i in 0..manifest.sections.len() {
        let txt = std::fs::read_to_string(dir.join(format!("sections/section-{i}.jsx")))
            .map_err(io)?;
        sections.push(jsx::parse_jsx(&txt).map_err(err)?);
    }
    let styles = css::parse_css(&std::fs::read_to_string(dir.join("styles/document.css")).map_err(io)?)
        .map_err(err)?;
    let mut assets = Vec::new();
    for am in &manifest.asset_meta {
        let bytes = std::fs::read(dir.join(format!("assets/{}", am.bin_ref))).map_err(io)?;
        assets.push(Asset { bin_ref: am.bin_ref.clone(), kind: am.kind.clone(), b64: b64(&bytes) });
    }
    Ok(JsxCssProject { manifest, document, sections, styles, assets, dirty: DirtySet::default() })
}

// ---- serde blobs (compact) ----

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct ParaSourceBlob {
    span: [usize; 2],
    para_pr: Option<String>,
    style: Option<String>,
    id: Option<String>,
    simple: bool,
}

#[derive(Serialize, Deserialize)]
struct ProvBlob {
    source: Option<String>,
    raw_b64: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct EqBlob {
    script: String,
    font: String,
    base_unit: u32,
    baseline: i16,
    color: [u8; 4],
    width: i32,
    height: i32,
    version: String,
}

#[derive(Serialize, Deserialize)]
struct NoteBlob {
    kind: bool, // true = End
    number: u16,
    prefix_char: u16,
    suffix_char: u16,
    inst_id: u32,
    body: String,
}
