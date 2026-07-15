//! HWPX serializer — round-trip-safe via **verbatim passthrough**.
//!
//! Strategy (PLAN §4): rebuild the ZIP from the original package, copying every untouched
//! part **byte-verbatim** (`zip::ZipWriter::raw_copy_file`, which preserves compression,
//! per-entry metadata, and order — so mimetype-first/STORED + the PR#40 namespace/standalone
//! surface are preserved for free). Only **dirty** sections are re-emitted, and even then we
//! patch the original section XML surgically (append new paragraphs) rather than regenerate it
//! from the lossy AST — so existing formatted content is never lost.

use crate::package::Package;
use crate::parse::SOURCE_PART_TAG;
use crate::synth;
use hwp_model::prelude::*;
use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{CompressionMethod, ZipArchive};

/// The result of pass 1: the fully-patched header.xml (fonts + charPr + paraPr pools) plus the
/// index→IDRef maps the section patcher uses to reference the synthesized shapes.
#[derive(Default)]
struct SynthPlan {
    /// char_shape index → synthesized `charPrIDRef` (only NON-default shapes; default → plain ref).
    char_ref: BTreeMap<usize, String>,
    /// para_shape index → synthesized `paraPrIDRef` (only NON-default shapes; default → base ref).
    para_ref: BTreeMap<usize, String>,
    /// Canonical borderFill key ([`bf_key`]: 4 edges + optional shade) → synthesized (or reused)
    /// `borderFillIDRef`. Replaces the old shade-only map (issue 054, F2): a cell/table with real
    /// lifted borders gets a faithful borderFill, not just a background clone.
    bf_ref: BTreeMap<String, String>,
    /// style name/engName → existing `<hh:style>` (id + paraPr/charPr). Read-only; no synthesis.
    style_map: BTreeMap<String, synth::StyleRef>,
    /// The fully-synthesized header.xml to emit, or None if nothing needed synthesizing.
    header_out: Option<String>,
}

/// Serialize a `SemanticDoc` (parsed from HWPX) back to HWPX bytes.
pub fn serialize(doc: &SemanticDoc) -> Result<Vec<u8>> {
    // FROM-SCRATCH path (HWP5→HWPX converter): a doc with no original HWPX provenance — e.g. one
    // lifted from a binary .hwp — has nothing to patch in place. Synthesize a complete HWPX by
    // seeding the embedded Skeleton and re-entering this function. HWPX-in docs ALWAYS carry
    // SOURCE_PART_TAG (set at parse), so they never take this branch — the round-trip path below
    // runs byte-identically to before. This invariant is what makes the change non-regressing.
    if doc
        .passthrough
        .parts
        .iter()
        .all(|p| p.tag != SOURCE_PART_TAG)
    {
        return serialize_from_scratch(doc);
    }
    let src = doc
        .passthrough
        .parts
        .iter()
        .find(|p| p.tag == SOURCE_PART_TAG)
        .ok_or_else(|| {
            Error::Serialize("no original HWPX provenance (parse an HWPX first)".into())
        })?;

    let pkg = Package::open(&src.bytes)?;
    let section_names = pkg.section_part_names();
    let header_name = pkg
        .part_names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("header.xml"))
        .cloned();
    let header_xml = pkg
        .read_header()
        .map(|b| String::from_utf8_lossy(&b).into_owned());

    let table_ref = find_table_borderfill(&pkg);

    // PASS 1 — synthesis plan: turn the dirty content's interned non-default Char/ParaShapes,
    // fonts, and cell shades into new header pool entries (ids above the existing max), so the
    // body can reference real, valid pool entries instead of reusing existing (mismatched) ones.
    let plan = build_synth_plan(doc, header_xml.as_deref(), table_ref.as_deref());

    let mut zin = ZipArchive::new(Cursor::new(src.bytes.clone()))
        .map_err(|e| Error::Serialize(format!("reopen source: {e}")))?;
    let names: Vec<String> = (0..zin.len())
        .map(|i| zin.by_index(i).map(|f| f.name().to_string()))
        .collect::<std::result::Result<_, _>>()
        .map_err(|e: zip::result::ZipError| Error::Serialize(format!("read entries: {e}")))?;

    // v2 PART-GENERATOR: the seed package may have FEWER section parts than the doc has sections —
    // the from-scratch converter seeds only the Skeleton's section0, but a lifted .hwp can be
    // multi-section. Append the missing `Contents/section{k}.xml` parts + any embedded images, and
    // register them in `content.hpf`. HWPX-in seeds already have a part per section and no
    // doc.bin_data → nothing extra is appended → the round-trip stays byte-identical (non-regression).
    let new_section_items: Vec<(String, String)> = (section_names.len()..doc.sections.len())
        .map(|k| (format!("section{k}"), format!("Contents/section{k}.xml")))
        .collect();
    let image_items = collect_image_items(doc);
    let content_hpf_name = names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("content.hpf"))
        .cloned();

    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for (i, name) in names.iter().enumerate() {
        let is_header = header_name.as_deref() == Some(name.as_str());
        let dirty_section = section_names
            .iter()
            .position(|n| n == name)
            .and_then(|si| doc.sections.get(si))
            .filter(|s| s.dirty.is_dirty());

        let is_content_hpf = content_hpf_name.as_deref() == Some(name.as_str())
            && (!new_section_items.is_empty() || !image_items.is_empty());

        if is_header && plan.header_out.is_some() {
            // PASS 2a — emit the fully-synthesized header.xml (fonts + charPr + paraPr pools).
            let patched = plan.header_out.as_deref().unwrap_or_default();
            out.start_file(name, deflate)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(patched.as_bytes())
                .map_err(|e| Error::Io(e.to_string()))?;
        } else if is_content_hpf {
            // PASS 2c — register the appended section/image parts in the package manifest + spine.
            let orig = pkg.read_part(name).unwrap_or_default();
            let patched = patch_content_hpf(
                &String::from_utf8_lossy(&orig),
                &new_section_items,
                &image_items,
            );
            out.start_file(name, deflate)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(patched.as_bytes())
                .map_err(|e| Error::Io(e.to_string()))?;
        } else if let Some(sec) = dirty_section {
            // PASS 2b — patch the section: append dirty blocks, referencing synthesized shapes.
            let orig = sec.provenance.raw.as_deref().unwrap_or(b"");
            let patched = patch_section_xml(orig, sec, table_ref.as_deref(), &plan);
            out.start_file(name, deflate)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(&patched)
                .map_err(|e| Error::Io(e.to_string()))?;
        } else {
            // Verbatim copy: preserves compression, metadata, order (and STORED mimetype).
            let raw = zin
                .by_index_raw(i)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.raw_copy_file(raw)
                .map_err(|e| Error::Serialize(e.to_string()))?;
        }
    }

    // PASS 3 — append parts the seed package lacked: extra sections, then embedded images. (Empty
    // for HWPX-in + v1 single-section → the zip is byte-identical to before.)
    for k in section_names.len()..doc.sections.len() {
        if let Some(sec) = doc.sections.get(k) {
            let orig = sec.provenance.raw.as_deref().unwrap_or(b"");
            let patched = patch_section_xml(orig, sec, table_ref.as_deref(), &plan);
            out.start_file(format!("Contents/section{k}.xml"), deflate)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(&patched)
                .map_err(|e| Error::Io(e.to_string()))?;
        }
    }
    for img in &image_items {
        if let Some(bytes) = doc
            .bin_data
            .iter()
            .find(|b| b.bin_ref == img.bin_ref)
            .map(|b| &b.bytes)
        {
            out.start_file(&img.href, deflate)
                .map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(bytes).map_err(|e| Error::Io(e.to_string()))?;
        }
    }

    let cur = out.finish().map_err(|e| Error::Serialize(e.to_string()))?;
    Ok(cur.into_inner())
}

/// The embedded base HWPX template — a minimal, Hancom-authored single-section package. The
/// from-scratch synthesizer seeds it and re-enters the patch pipeline. Every invariant it relies on
/// (default charPr/paraPr id=0, pool ids, the secPr-carrying section0 stub) is pinned by
/// `synth::tests::skeleton_pin_invariants`, so a regeneration can't silently break synthesis.
const SKELETON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../corpus/hwpx/Skeleton.hwpx"
));

/// Synthesize a COMPLETE HWPX from a `SemanticDoc` with no original HWPX provenance (the HWP5→HWPX
/// converter path). Strategy: clone the doc, seed the embedded [`SKELETON`] as its `SOURCE_PART_TAG`
/// provenance and the section's `provenance.raw` (the base `section0.xml`, which carries the
/// mandatory `secPr`), mark all content dirty, then RE-ENTER [`serialize`] so the existing,
/// oracle-tested synth/patch pipeline runs unchanged against the Skeleton header + section.
///
/// v2: MULTI-SECTION + IMAGES are supported. Every section is seeded from the Skeleton's section0
/// (which carries the mandatory secPr) as its `provenance.raw` base; the part-generator in
/// `serialize()` then appends `Contents/section1..N.xml` + `BinData/*` and registers them in
/// `content.hpf`. The shared header pools are synthesized once across ALL sections.
fn serialize_from_scratch(doc: &SemanticDoc) -> Result<Vec<u8>> {
    // The base section0.xml each section's body patcher appends lifted blocks into (before </hs:sec>);
    // it carries the secPr, so every emitted section gets one.
    let base_section0 = Package::open(SKELETON)?.read_part("Contents/section0.xml")?;

    let mut seeded = doc.clone();
    seeded.passthrough.push(SOURCE_PART_TAG, SKELETON.to_vec());
    for sec in &mut seeded.sections {
        sec.provenance.raw = Some(base_section0.clone());
        sec.dirty.mark();
        for block in &mut sec.blocks {
            mark_block_dirty(block);
        }
    }
    let out = serialize(&seeded)?;

    // v1 BLOCKER tripwire: a deep-lift off-by-one would emit a dangling charPr/paraPr/borderFill/
    // styleIDRef (build_synth_plan silently no-ops on out-of-range ids) or a wrong itemCnt — both
    // open as a Hancom "damaged file". Refuse to hand back such a package.
    let report = crate::export::validate_synthesis_safety(&out);
    if !report.ok {
        return Err(Error::Serialize(format!(
            "synthesized HWPX failed open-safety ({} issue(s)): {}",
            report.blocking.len(),
            report.blocking.join("; ")
        )));
    }
    Ok(out)
}

/// An embedded image part to emit: its BinData ref (which is ALSO the manifest item id and the
/// `<hc:img binaryItemIDRef>`), the zip part name (`Contents/BinData/{ref}.{kind}`), and the OWPML
/// media-type (Hancom's exact spelling: `image/png`, `image/bmp`, `image/jpg`, …).
struct ImageItem {
    bin_ref: String,
    href: String,
    media_type: String,
}

/// Collect the distinct embedded images actually referenced by `Inline::Image` across all sections
/// and table cells, paired with their `SemanticDoc::bin_data` bytes → the BinData parts to emit +
/// manifest items. Empty for HWPX-in (no `bin_data`) and for the v1 text/table lift.
fn collect_image_items(doc: &SemanticDoc) -> Vec<ImageItem> {
    fn walk(blocks: &[Block], used: &mut std::collections::BTreeSet<String>) {
        for b in blocks {
            match b {
                Block::Paragraph(p) => {
                    for r in &p.runs {
                        for inl in &r.content {
                            match inl {
                                Inline::Image(im) => {
                                    used.insert(im.bin_ref.clone());
                                }
                                // SEAM D: images can live inside a note body — descend it.
                                Inline::Note(nr) => walk(&nr.body, used),
                                _ => {}
                            }
                        }
                    }
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        walk(&c.blocks, used);
                    }
                }
            }
        }
    }
    let mut used = std::collections::BTreeSet::new();
    for s in &doc.sections {
        walk(&s.blocks, &mut used);
        for d in &s.decorations {
            walk(&d.blocks, &mut used); // SEAM D: images in headers/footers
        }
    }
    doc.bin_data
        .iter()
        .filter(|b| used.contains(&b.bin_ref))
        .map(|b| ImageItem {
            // BinData parts live at the package root (matches Hancom: `BinData/image1.png`), which is
            // also the manifest href AND the zip entry name.
            bin_ref: b.bin_ref.clone(),
            href: format!("BinData/{}.{}", b.bin_ref, b.kind),
            media_type: image_media_type(&b.kind),
        })
        .collect()
}

/// OWPML media-type for an image extension, matching Hancom's spelling (note: `image/jpg`, not
/// `image/jpeg`).
fn image_media_type(kind: &str) -> String {
    match kind.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "bmp" => "image/bmp",
        "jpg" | "jpeg" => "image/jpg",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "wmf" => "image/wmf",
        "emf" => "image/emf",
        other => return format!("image/{other}"),
    }
    .to_string()
}

/// Register appended parts in `content.hpf`: each new section → a `<opf:item media-type=
/// "application/xml">` in `<opf:manifest>` + an `<opf:itemref>` in `<opf:spine>`; each image → a
/// manifest `<opf:item media-type="image/.." isEmbeded="1">` (images are NOT in the spine). Hrefs
/// are package-root-relative as Hancom writes them: `Contents/section1.xml`, `BinData/image1.png`.
fn patch_content_hpf(hpf: &str, sections: &[(String, String)], images: &[ImageItem]) -> String {
    let mut manifest = String::new();
    let mut spine = String::new();
    for (id, href) in sections {
        manifest.push_str(&format!(
            "<opf:item id=\"{id}\" href=\"{href}\" media-type=\"application/xml\"/>"
        ));
        spine.push_str(&format!("<opf:itemref idref=\"{id}\" linear=\"yes\"/>"));
    }
    for img in images {
        manifest.push_str(&format!(
            "<opf:item id=\"{}\" href=\"{}\" media-type=\"{}\" isEmbeded=\"1\"/>",
            img.bin_ref, img.href, img.media_type
        ));
    }
    let mut s = hpf.to_string();
    if let Some(p) = s.find("</opf:manifest>") {
        s.insert_str(p, &manifest);
    }
    if let Some(p) = s.find("</opf:spine>") {
        s.insert_str(p, &spine);
    }
    s
}

/// Recursively mark a block dirty so the append path ([`dirty_emit`]) emits it: a lifted paragraph
/// carries no `source` span (`source.is_none()`), so marking it dirty routes it through the
/// append-new branch rather than the in-place replace branch. For a table, mark the table and every
/// cell (and the cells' inner paragraphs) so the whole structure is (re-)emitted.
fn mark_block_dirty(block: &mut Block) {
    match block {
        Block::Paragraph(p) => p.dirty.mark(),
        Block::Table(t) => {
            t.dirty.mark();
            // The from-scratch path re-seeds `provenance.raw` with the Skeleton section, so any
            // original-XML span would point into the WRONG buffer — clear them so these tables
            // take the append lane, never a bogus in-place splice (issue 057 safety).
            t.src_span = None;
            for cell in &mut t.cells {
                cell.dirty.mark();
                cell.src_span = None;
                for cb in &mut cell.blocks {
                    mark_block_dirty(cb);
                }
            }
        }
    }
}

type IdxSet = std::collections::BTreeSet<usize>;

/// Collect the char_shape AND para_shape indices referenced by dirty content (paragraphs + cells).
fn collect_used_shapes(doc: &SemanticDoc, chars: &mut IdxSet, paras: &mut IdxSet) {
    // Collect EVERY char/para shape in an emitted block tree — cells AND note bodies are always
    // emitted in full, so they're walked unconditionally (SEAM D); a shape used only inside a note
    // would otherwise dangle its charPrIDRef and fail the validator.
    fn walk_all(blocks: &[Block], chars: &mut IdxSet, paras: &mut IdxSet) {
        for b in blocks {
            match b {
                Block::Paragraph(p) => {
                    paras.insert(p.para_shape);
                    for r in &p.runs {
                        chars.insert(r.char_shape);
                        for inl in &r.content {
                            if let Inline::Note(nr) = inl {
                                walk_all(&nr.body, chars, paras);
                            }
                        }
                    }
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        walk_all(&c.blocks, chars, paras);
                    }
                }
            }
        }
    }
    // Top-level: only DIRTY blocks are appended/emitted.
    for sec in doc.sections.iter().filter(|s| s.dirty.is_dirty()) {
        for b in &sec.blocks {
            // Frame-transparent (issue 060): a 1×1 wrapper's inner-table edit leaves the OUTER
            // table/cell clean, so gate on the RECURSIVE dirty predicate — else the wrapper's
            // emitted (spliced) inner cells reference shapes/borderFills we never collected.
            let emit = b.any_dirty();
            if emit {
                walk_all(std::slice::from_ref(b), chars, paras);
            }
        }
        // SEAM D: header/footer bodies are always emitted into the secPr — collect their shapes.
        for d in &sec.decorations {
            walk_all(&d.blocks, chars, paras);
        }
    }
}

/// PASS 1: synthesize every header pool entry the dirty content needs (fonts → charPr → paraPr →
/// cell-shade borderFills), returning the fully-patched header.xml + the index→IDRef maps. All
/// header mutation happens here so the patches compose on one header string.
fn build_synth_plan(
    doc: &SemanticDoc,
    header_xml: Option<&str>,
    table_ref: Option<&str>,
) -> SynthPlan {
    let mut plan = SynthPlan::default();
    let Some(header0) = header_xml else {
        return plan;
    };

    // Read-only: the existing styles pool (so paragraphs can reference 바탕글/본문/개요 N by name).
    plan.style_map = synth::parse_styles(header0);

    let mut chars = IdxSet::new();
    let mut paras = IdxSet::new();
    collect_used_shapes(doc, &mut chars, &mut paras);

    // Snapshot the default charPr/paraPr elements once (their content is stable across patching).
    let base_char = synth::default_char_pr(header0).map(str::to_string);
    let base_para = synth::default_para_pr(header0).map(str::to_string);

    let mut header = header0.to_string();
    let mut char_fragments = String::new();
    let mut char_count = 0;
    if let Some(base) = &base_char {
        let mut next_id = synth::max_pool_id(header0, "charProperties") + 1;
        for idx in chars {
            // Pool-resolved (HWPX #196): this shape came from the ORIGINAL header pool, not an edit.
            // Skip synthesis — the unedited run re-emits its original `charPrIDRef` (via
            // `Run::char_ref`), so it keeps ALL its sub-attrs instead of a lossy re-synthesized copy.
            if doc.hwpx_pool_char_shapes.contains(&idx) {
                continue;
            }
            match doc.char_shapes.get(idx) {
                Some(s) if s.is_default() => {}
                Some(shape) => {
                    // Resolve fonts → fontfaces pool ids (mutates `header`). Per-script `fonts` (each
                    // script its own face) takes precedence; else a single `font_family` for all
                    // scripts; else inherit the base charPr's fontRef.
                    let fontref = if shape.fonts.iter().any(Option::is_some) {
                        let (h, fr) = synth::intern_fonts(&header, &shape.fonts, base);
                        header = h;
                        Some(fr)
                    } else if let Some(fam) = shape.font_family.as_deref() {
                        let (h, fr) = synth::intern_font(&header, fam);
                        header = h;
                        Some(fr)
                    } else {
                        None
                    };
                    let frag = synth::synthesize_char_pr(base, next_id, shape, fontref.as_deref());
                    // Dedup (#003): reuse an existing pool charPr identical modulo id.
                    if let Some(existing) =
                        synth::existing_equivalent_id(header0, "<hh:charPr ", "</hh:charPr>", &frag)
                    {
                        plan.char_ref.insert(idx, existing);
                    } else {
                        char_fragments.push_str(&frag);
                        plan.char_ref.insert(idx, next_id.to_string());
                        char_count += 1;
                        next_id += 1;
                    }
                }
                None => {}
            }
        }
    }
    header = synth::patch_pool(&header, "charProperties", &char_fragments, char_count);

    let mut para_fragments = String::new();
    let mut para_count = 0;
    if let Some(base) = &base_para {
        let mut next_id = synth::max_pool_id(header0, "paraProperties") + 1;
        for idx in paras {
            // Pool-resolved (HWPX #196): keep the paragraph's byte-verbatim `<hp:p>` open tag (its
            // original `paraPrIDRef`) instead of patching in a lossy re-synthesized paraPr.
            if doc.hwpx_pool_para_shapes.contains(&idx) {
                continue;
            }
            match doc.para_shapes.get(idx) {
                Some(s) if s.is_default() => {}
                Some(shape) => {
                    let frag = synth::synthesize_para_pr(base, next_id, shape);
                    // Dedup (#003): reuse an existing pool paraPr identical modulo id.
                    if let Some(existing) =
                        synth::existing_equivalent_id(header0, "<hh:paraPr ", "</hh:paraPr>", &frag)
                    {
                        plan.para_ref.insert(idx, existing);
                    } else {
                        para_fragments.push_str(&frag);
                        plan.para_ref.insert(idx, next_id.to_string());
                        para_count += 1;
                        next_id += 1;
                    }
                }
                None => {}
            }
        }
    }
    header = synth::patch_pool(&header, "paraProperties", &para_fragments, para_count);

    // Cell/table borderFills (F2): clone the table's bordered fill, patch the four real edges
    // (style/width/color) + the fill per distinct combination. Shade-only combos degenerate to the
    // old "clone + fillBrush" output, so pre-F2 documents synthesize byte-identically.
    let mut bf_fragments = String::new();
    let mut bf_count = 0;
    let specs = collect_bf_specs(doc);
    if !specs.is_empty() {
        if let Some(base) = table_ref.and_then(|id| synth::border_fill_by_id(header0, id)) {
            let mut next_id = synth::max_pool_id(header0, "borderFills") + 1;
            for (key, spec) in specs {
                let frag =
                    synth::synthesize_border_fill_full(&base, next_id, &spec.borders, spec.shade);
                // Dedup (#003): reuse an existing pool borderFill identical modulo id.
                if let Some(existing) = synth::existing_equivalent_id(
                    header0,
                    "<hh:borderFill ",
                    "</hh:borderFill>",
                    &frag,
                ) {
                    plan.bf_ref.insert(key, existing);
                } else {
                    bf_fragments.push_str(&frag);
                    plan.bf_ref.insert(key, next_id.to_string());
                    bf_count += 1;
                    next_id += 1;
                }
            }
        }
    }
    header = synth::patch_pool(&header, "borderFills", &bf_fragments, bf_count);

    if char_count > 0 || para_count > 0 || bf_count > 0 {
        plan.header_out = Some(header);
    }
    plan
}

/// A distinct borderFill the emitted content needs: real per-edge borders + optional background.
#[derive(Clone)]
struct BfSpec {
    borders: [Option<CellEdge>; 4],
    shade: Option<Color>,
}

/// The spec for a cell/table's border+fill combination, or `None` when it carries neither
/// (→ the emitter references the document's default table borderFill, the pre-F2 behavior).
fn bf_spec(borders: &[Option<CellEdge>; 4], shade: Option<Color>) -> Option<BfSpec> {
    if borders.iter().all(Option::is_none) && shade.is_none() {
        return None;
    }
    Some(BfSpec {
        borders: *borders,
        shade,
    })
}

/// Canonical, deterministic key for a [`BfSpec`] — computed from the SAME OWPML tokens the
/// synthesizer emits, so two specs that would synthesize identical XML share one pool entry.
fn bf_key(spec: &BfSpec) -> String {
    let edge = |e: &Option<CellEdge>| -> String {
        match e {
            None => "-".to_string(),
            Some(e) => format!(
                "{}:{}:{}",
                synth::border_type_token(e.style),
                synth::border_width_token(e.width_px),
                e.color.to_hex()
            ),
        }
    };
    format!(
        "L={}|R={}|T={}|B={}|F={}",
        edge(&spec.borders[0]),
        edge(&spec.borders[1]),
        edge(&spec.borders[2]),
        edge(&spec.borders[3]),
        spec.shade
            .map(|c| c.to_hex())
            .unwrap_or_else(|| "-".to_string())
    )
}

/// Distinct border+fill combinations used by EMITTED content: dirty top-level tables (recursing
/// into nested tables and note bodies) + always-emitted decoration (header/footer) bodies —
/// mirroring [`collect_used_shapes`]'s gating so every emitted `borderFillIDRef` resolves.
fn collect_bf_specs(doc: &SemanticDoc) -> BTreeMap<String, BfSpec> {
    fn walk(blocks: &[Block], out: &mut BTreeMap<String, BfSpec>) {
        for b in blocks {
            match b {
                Block::Table(t) => {
                    if let Some(spec) = bf_spec(&t.borders, None) {
                        out.insert(bf_key(&spec), spec);
                    }
                    for c in t.cells.iter().filter(|c| c.active) {
                        if let Some(spec) = bf_spec(&c.borders, c.shade_color) {
                            out.insert(bf_key(&spec), spec);
                        }
                        walk(&c.blocks, out);
                    }
                }
                Block::Paragraph(p) => {
                    for r in &p.runs {
                        for inl in &r.content {
                            if let Inline::Note(nr) = inl {
                                walk(&nr.body, out);
                            }
                        }
                    }
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for sec in doc.sections.iter().filter(|s| s.dirty.is_dirty()) {
        for b in &sec.blocks {
            // Frame-transparent (issue 060): a 1×1 wrapper's inner-table edit leaves the OUTER
            // table/cell clean, so gate on the RECURSIVE dirty predicate — else the wrapper's
            // emitted (spliced) inner cells reference shapes/borderFills we never collected.
            let emit = b.any_dirty();
            if emit {
                walk(std::slice::from_ref(b), &mut out);
            }
        }
        for d in &sec.decorations {
            walk(&d.blocks, &mut out);
        }
    }
    out
}

/// Surgically append new (dirty) paragraphs to a section's original XML, before its root
/// close tag — existing content stays byte-identical (round-trip-safe).
///
/// The appended `<hp:p>` must be Hancom-acceptable: a unique `id`, the standard
/// `pageBreak/columnBreak/merged` attrs, and VALID `paraPrIDRef`/`charPrIDRef` that exist in
/// the header pools — so we reuse the refs of the section's last existing paragraph/run rather
/// than guess. (linesegarray is intentionally omitted; Hancom recomputes layout on open.)
fn patch_section_xml(
    orig: &[u8],
    sec: &Section,
    table_ref: Option<&str>,
    plan: &SynthPlan,
) -> Vec<u8> {
    let original = String::from_utf8_lossy(orig).into_owned();

    // (1) IN-PLACE EDITS: dirty *simple* paragraphs that carry a source byte-span → replace their
    // run content while keeping the original `<hp:p …>` open tag verbatim. Apply in DESCENDING
    // start order so earlier byte offsets remain valid as we splice.
    let mut edits: Vec<(usize, usize, String)> = sec
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => {
                let src = p.source.as_ref()?;
                if !(p.dirty.is_dirty() && src.span.1 <= original.len()) {
                    return None;
                }
                let orig = &original[src.span.0..src.span.1];
                // Simple paragraph → rebuild runs. Structural paragraph → keep the body verbatim
                // and patch only the open tag (SetParaPr/ApplyStyle; body edits are refused upstream).
                // DEFENSE-IN-DEPTH: `reemit_paragraph` keeps only `Inline::Text`, so any verbatim
                // `Inline::Raw` (shape/chart/OLE/textbox) it sees would be SILENTLY dropped. The
                // `simple` flag is meant to exclude such paragraphs, but it's a parse-time proxy
                // decoupled from the actual run content — so guard the rebuild on Raw directly and
                // keep the body byte-verbatim (open-tag-only) when any Raw is present, never lose it.
                let has_raw = p
                    .runs
                    .iter()
                    .flat_map(|r| &r.content)
                    .any(|i| matches!(i, Inline::Raw(_)));
                let xml = if src.simple && !has_raw {
                    reemit_paragraph(orig, p, plan)
                } else {
                    reemit_paragraph_open_only(orig, p, plan)
                };
                Some((src.span.0, src.span.1, xml))
            }
            _ => None,
        })
        .collect();
    // (1b) IN-PLACE TABLE EDITS (issue 057): a dirty table parsed from THIS section's XML carries
    // its original `<hp:tbl>` byte span — re-emit it at that anchor (per-cell surgery when the
    // structure is unchanged, whole-table replacement otherwise) instead of appending a copy at
    // the section end while the stale original stayed in place.
    let (tbl_edits, tables_in_place) = table_inplace_edits(&original, sec, &edits, table_ref, plan);
    edits.extend(tbl_edits);

    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut s = original;
    for (start, end, xml) in &edits {
        s.replace_range(*start..*end, xml);
    }

    // (2) PAGE EDIT (#005): patch secPr in place (string-search → robust after the splices above).
    if sec.page_edited {
        s = synth::patch_page(&s, &sec.page);
    }

    // (3) APPENDED blocks (dirty, source=None) → emit + inject before the section close tag.
    // Tables already re-emitted in place (1b) are excluded — appending them too would duplicate
    // (issue 057). Sequence-aware (like emit_blocks): a pure table-anchor paragraph is elided and
    // its forced page break rides on the next table's wrapper <hp:p> (issue 054).
    let mut dirty: Vec<EmitBlock> = Vec::new();
    let mut pending_pb = false;
    for (bi, b) in sec.blocks.iter().enumerate() {
        if tables_in_place.contains(&bi) {
            continue;
        }
        if !dirty_appended(b) {
            continue;
        }
        if let Block::Paragraph(p) = b {
            if is_pure_table_anchor(p) {
                pending_pb |= p.page_break_before;
                continue;
            }
        }
        let mut eb = project_block(b);
        if let EmitBlock::Table(t) = &mut eb {
            t.page_break = std::mem::take(&mut pending_pb);
        }
        dirty.push(eb);
    }
    if dirty.is_empty() && sec.decorations.is_empty() {
        // Edits / page already applied (or nothing changed) — no append needed.
        return s.into_bytes();
    }

    let base_para_ref = last_attr(&s, "paraPrIDRef").unwrap_or("0").to_string();
    let plain_ref = last_attr(&s, "charPrIDRef").unwrap_or("0").to_string();
    let base_para_ref: &str = &base_para_ref;
    let plain_ref_owned = plain_ref.clone();
    // Resolve a run's interned char_shape index → charPrIDRef (synthesized id, or the plain ref).
    let cref = |idx: usize| {
        plan.char_ref
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| plain_ref_owned.clone())
    };
    // …and a paragraph's para_shape index → paraPrIDRef (synthesized id, or the base ref). Used by
    // cell/note-body paragraphs so their real line-spacing/문단간격 survive (054).
    let base_para_owned = base_para_ref.to_string();
    let pref = |idx: usize| {
        plan.para_ref
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| base_para_owned.clone())
    };
    let body_ctx = BodyCtx {
        cref: &cref,
        pref: &pref,
        base_para_ref,
        plain_ref: &plain_ref,
        bf: table_ref.unwrap_or("1"),
        bf_ref: &plan.bf_ref,
    };
    let mut next_id = max_id(&s) + 1;

    // (2.5) HEADERS/FOOTERS: splice each as a <hp:ctrl><hp:header|footer><hp:subList>body</…> right
    // after </hp:secPr> (the secPr-carrier run) — additive, only when the section has decorations.
    if !sec.decorations.is_empty() {
        if let Some(pos) = s.find("</hp:secPr>") {
            let mut deco = String::new();
            for d in &sec.decorations {
                let tag = match d.kind {
                    DecoKind::Header => "header",
                    DecoKind::Footer => "footer",
                };
                let apply = match d.apply {
                    ApplyPage::Both => "BOTH",
                    ApplyPage::Even => "EVEN",
                    ApplyPage::Odd => "ODD",
                };
                let body: Vec<EmitBlock> = emit_blocks(&d.blocks);
                let did = next_id;
                next_id += 1;
                deco.push_str(&format!(
                    "<hp:ctrl><hp:{tag} id=\"{did}\" applyPageType=\"{apply}\"><hp:subList id=\"\" textDirection=\"HORIZONTAL\" lineWrap=\"BREAK\" vertAlign=\"TOP\" linkListIDRef=\"0\" linkListNextIDRef=\"0\" textWidth=\"0\" textHeight=\"0\" hasTextRef=\"0\" hasNumRef=\"0\">"
                ));
                emit_cell_content(&mut deco, &body, &body_ctx, &mut next_id);
                deco.push_str(&format!("</hp:subList></hp:{tag}></hp:ctrl>"));
            }
            let at = pos + "</hp:secPr>".len();
            s.insert_str(at, &deco);
        }
    }

    // FROM-SCRATCH stub merge (054): the Skeleton's section base is a lone EMPTY <hp:p> carrying
    // the mandatory secPr. Appending ALL content after it leaves a spurious blank first LINE per
    // section on reopen, and makes a leading forced page break — a no-op at section start in the
    // original — fire AFTER the stub (+1 page). Hancom's own convention is that the first paragraph
    // carries the secPr *and* the first real content, so we splice the first emitted block's body
    // into the stub and transplant its open-tag attrs. Only for from-scratch sections (provenance
    // Hwp5); an HWPX-in section's first paragraph is real content and stays byte-identical.
    let merge_stub = sec.provenance.source == Some(SourceFormat::Hwp5);

    let mut inject = String::new();
    for (bi, block) in dirty.iter().enumerate() {
        let mut piece = String::new();
        match block {
            EmitBlock::Para {
                para_shape,
                style,
                runs,
                page_break,
            } => {
                // Resolve a named style (if any): styleIDRef + the style's default para/char refs.
                let style_ref = style.as_deref().and_then(|n| plan.style_map.get(n));
                let style_id = style_ref.map(|s| s.id.as_str()).unwrap_or("0");
                // paraPrIDRef: synthesized shape overrides the style's paraPr overrides the base.
                let para_ref = plan
                    .para_ref
                    .get(para_shape)
                    .cloned()
                    .or_else(|| style_ref.map(|s| s.para_pr.clone()))
                    .unwrap_or_else(|| base_para_ref.to_string());
                // a run with no synthesized charPr falls back to the style's charPr, else plain.
                let char_fallback = style_ref
                    .map(|s| s.char_pr.clone())
                    .unwrap_or_else(|| plain_ref.to_string());
                let resolve = |idx: usize| {
                    plan.char_ref
                        .get(&idx)
                        .cloned()
                        .unwrap_or_else(|| char_fallback.clone())
                };
                let ctx = BodyCtx {
                    cref: &resolve,
                    pref: &pref,
                    base_para_ref,
                    plain_ref: &plain_ref,
                    bf: table_ref.unwrap_or("1"),
                    bf_ref: &plan.bf_ref,
                };
                let pid = next_id;
                next_id += 1;
                emit_paragraph(
                    &mut piece,
                    pid,
                    &para_ref,
                    style_id,
                    runs,
                    *page_break,
                    &ctx,
                    &mut next_id,
                );
            }
            EmitBlock::Table(tbl) => {
                // A table lives inside a wrapping <hp:p><hp:run>…</hp:run></hp:p>.
                let pid = next_id;
                let tid = next_id + 1;
                next_id += 2;
                let pb = if tbl.page_break { "1" } else { "0" };
                piece.push_str(&format!(
                    "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"{pb}\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{plain_ref}\">"
                ));
                emit_table(&mut piece, tid, tbl, &body_ctx, &mut next_id);
                piece.push_str("<hp:t></hp:t></hp:run></hp:p>");
            }
            EmitBlock::Image {
                bin_ref,
                width,
                height,
            } => {
                let pid = next_id;
                let picid = next_id + 1;
                next_id += 2;
                emit_pic(
                    &mut piece,
                    pid,
                    picid,
                    bin_ref,
                    *width,
                    *height,
                    base_para_ref,
                    &plain_ref,
                );
            }
            EmitBlock::Equation(eq) => {
                let pid = next_id;
                let eqid = next_id + 1;
                next_id += 2;
                emit_equation(&mut piece, pid, eqid, eq, base_para_ref, &plain_ref);
            }
        }
        if bi == 0 && merge_stub && merge_first_block_into_stub(&mut s, &piece) {
            continue;
        }
        inject.push_str(&piece);
    }

    match s.rfind("</") {
        Some(pos) => {
            let mut o = String::with_capacity(s.len() + inject.len());
            o.push_str(&s[..pos]);
            o.push_str(&inject);
            o.push_str(&s[pos..]);
            o.into_bytes()
        }
        None => orig.to_vec(),
    }
}

/// The in-place lane's decision for one dirty table (issue 057).
enum TablePatch {
    /// Structure unchanged → splice only the dirty cells' `<hp:tc>` spans (max fidelity: every
    /// untouched cell + the table geometry stay byte-verbatim).
    Cells(Vec<(usize, usize, String)>),
    /// Structure changed (rows/cols/op-set widths/heights/fresh cells) → replace the whole
    /// `<hp:tbl>` span with a re-synthesized table — still anchored at the original position.
    Whole(usize, usize, String),
}

/// Build the in-place splices for every dirty table that carries an original-XML span (issue 057).
/// Returns the splice list plus the block indices handled here (the append lane skips them).
/// A table whose span is missing/stale, or which collides with a paragraph edit's span (the table
/// XML lives INSIDE its wrapper `<hp:p>`), falls back to the legacy append — never a bad splice.
fn table_inplace_edits(
    original: &str,
    sec: &Section,
    para_edits: &[(usize, usize, String)],
    table_ref: Option<&str>,
    plan: &SynthPlan,
) -> (
    Vec<(usize, usize, String)>,
    std::collections::BTreeSet<usize>,
) {
    let mut edits = Vec::new();
    let mut handled = std::collections::BTreeSet::new();
    // Fallback refs when a cell has no original paragraph to copy from — the same
    // reuse-a-valid-existing-ref strategy as the append lane, computed on the pristine XML.
    let sec_para_ref = last_attr(original, "paraPrIDRef")
        .unwrap_or("0")
        .to_string();
    let sec_plain_ref = last_attr(original, "charPrIDRef")
        .unwrap_or("0")
        .to_string();
    // New <hp:p>/<hp:tbl> ids start above the section's current max. The append lane recomputes
    // its own max AFTER these splices land, so the two lanes can never collide.
    let mut next_id = max_id(original) + 1;

    for (bi, block) in sec.blocks.iter().enumerate() {
        let Block::Table(outer) = block else { continue };
        // Frame-transparent (issue 060): resolve a 1×1 wrapper (자가진단표) to its INNER table — the
        // edit op marks the inner table/cell dirty, never the outer wrapper, so we splice the inner
        // table's own `<hp:tc>` spans in place (assigned by parse for nested tables too) and leave
        // the outer wrapper + untouched siblings byte-verbatim. A normal table is its own edit
        // target, so the 057 path is behavior-identical.
        let t = outer.edit_target();
        if !(t.dirty.is_dirty() || t.cells.iter().any(|c| c.dirty.is_dirty())) {
            continue;
        }
        let Some((s0, e0)) = t.src_span else { continue };
        // Stale/foreign span guard: the span must address a `<hp:tbl>…</hp:tbl>` in THIS XML
        // (char-boundary checks first — a stale span must degrade to append, never panic).
        if e0 > original.len()
            || s0 >= e0
            || !original.is_char_boundary(s0)
            || !original.is_char_boundary(e0)
            || !original[s0..].starts_with("<hp:tbl")
            || !original[..e0].ends_with("</hp:tbl>")
        {
            continue;
        }
        // A dirty WRAPPER paragraph's re-emit span contains the table's span — splicing both
        // would corrupt the XML. Yield to the paragraph edit; the table keeps the append lane.
        if para_edits.iter().any(|(ps, pe, _)| *ps < e0 && s0 < *pe) {
            continue;
        }
        match build_table_patch(
            original,
            (s0, e0),
            t,
            table_ref,
            plan,
            &sec_para_ref,
            &sec_plain_ref,
            &mut next_id,
        ) {
            TablePatch::Cells(cell_edits) => edits.extend(cell_edits),
            TablePatch::Whole(a, b, xml) => edits.push((a, b, xml)),
        }
        handled.insert(bi);
    }
    (edits, handled)
}

/// Decide + build the in-place patch for ONE dirty table whose original span checks out.
#[allow(clippy::too_many_arguments)]
fn build_table_patch(
    original: &str,
    (s0, e0): (usize, usize),
    t: &Table,
    table_ref: Option<&str>,
    plan: &SynthPlan,
    sec_para_ref: &str,
    sec_plain_ref: &str,
    next_id: &mut u64,
) -> TablePatch {
    let open_end = original[s0..].find('>').map(|i| s0 + i + 1).unwrap_or(e0);
    let open_tag = &original[s0..open_end];
    // Reuse the original table's own borderFill for freshly-emitted cells; fall back to the
    // doc-level table ref, then "1" (the append lane's chain).
    let bf_owned = first_attr(open_tag, "borderFillIDRef")
        .map(str::to_string)
        .or_else(|| table_ref.map(str::to_string))
        .unwrap_or_else(|| "1".to_string());
    let bf = bf_owned.as_str();

    // STRUCTURE CHECK — per-cell surgery is only sound when the table's shape is untouched:
    // row/col counts still match the original XML, no op-set widths/heights (the HWPX parser
    // leaves both empty), at least one dirty cell, and every dirty cell still addressable by its
    // original `<hp:tc>` span inside this table.
    let same_rows =
        first_attr(open_tag, "rowCnt").and_then(|v| v.trim().parse::<usize>().ok()) == Some(t.rows);
    let same_cols =
        first_attr(open_tag, "colCnt").and_then(|v| v.trim().parse::<usize>().ok()) == Some(t.cols);
    let geometry_untouched = t.col_widths.is_empty() && t.row_heights.is_empty();
    let dirty_cells: Vec<&Cell> = t.cells.iter().filter(|c| c.dirty.is_dirty()).collect();
    let cell_spans_ok = !dirty_cells.is_empty()
        && dirty_cells.iter().all(|c| {
            c.src_span.is_some_and(|(cs, ce)| {
                cs >= open_end
                    && ce <= e0
                    && cs < ce
                    && original.is_char_boundary(cs)
                    && original.is_char_boundary(ce)
                    && original[cs..].starts_with("<hp:tc")
            })
        });

    if same_rows && same_cols && geometry_untouched && cell_spans_ok {
        let mut cell_edits = Vec::new();
        let mut ok = true;
        for cell in &dirty_cells {
            let (cs, ce) = cell.src_span.expect("checked by cell_spans_ok");
            match patch_cell_xml(
                &original[cs..ce],
                cell,
                plan,
                bf,
                sec_para_ref,
                sec_plain_ref,
                next_id,
            ) {
                Some(xml) => cell_edits.push((cs, ce, xml)),
                None => {
                    ok = false; // malformed segment → don't half-patch; re-emit the whole table
                    break;
                }
            }
        }
        if ok {
            return TablePatch::Cells(cell_edits);
        }
    }

    // WHOLE-TABLE re-emit at the original anchor. The table stays inside its original wrapper
    // `<hp:p><hp:run>` (only the `<hp:tbl>` span is replaced), so document order is preserved.
    let cref = |idx: usize| {
        plan.char_ref
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| sec_plain_ref.to_string())
    };
    let pref = |idx: usize| {
        plan.para_ref
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| sec_para_ref.to_string())
    };
    let ctx = BodyCtx {
        cref: &cref,
        pref: &pref,
        base_para_ref: sec_para_ref,
        plain_ref: sec_plain_ref,
        bf,
        bf_ref: &plan.bf_ref,
    };
    // Same projection as project_block's Table arm (054) — kept inline because the in-place lane
    // re-emits from a &Table, not a &Block.
    let et = EmitTable {
        rows: t.rows.max(1),
        cols: t.cols.max(1),
        cells: placed_cells(t),
        col_widths: t.col_widths.clone(),
        row_heights: t.row_heights.clone(),
        padding: t.padding,
        outer_margin: [
            t.outer_margin_left,
            t.outer_margin_right,
            t.outer_margin_top,
            t.outer_margin_bottom,
        ],
        bf_key: bf_spec(&t.borders, None).map(|s| bf_key(&s)),
        page_break: false, // in-place re-emit stays inside the original wrapper <hp:p>
    };
    let tid = *next_id;
    *next_id += 1;
    let mut xml = String::new();
    emit_table(&mut xml, tid, &et, &ctx, next_id);
    TablePatch::Whole(s0, e0, xml)
}

/// True when any block in a cell's body tree is dirty — i.e. the cell's CONTENT was actually
/// replaced/edited (SetTableCellRuns builds fresh `Dirty(true)` paragraphs). A cell that is dirty
/// only at the CELL level (SetTableCellShade) keeps its body byte-verbatim — rebuilding it from
/// the lossy parse AST would silently drop un-modeled objects (pic/equation/ctrl) living inside.
fn cell_content_dirty(blocks: &[Block]) -> bool {
    blocks.iter().any(|b| match b {
        Block::Paragraph(p) => p.dirty.is_dirty(),
        Block::Table(t) => {
            t.dirty.is_dirty()
                || t.cells
                    .iter()
                    .any(|c| c.dirty.is_dirty() || cell_content_dirty(&c.blocks))
        }
    })
}

/// Surgically re-emit ONE dirty cell: the `<hp:tc …>` open tag, the `<hp:subList …>` open tag and
/// everything AFTER `</hp:subList>` (cellAddr/cellSpan/cellSz/cellMargin) stay byte-verbatim; only
/// the subList CHILDREN (the cell's paragraphs/nested tables) are rebuilt from the edited AST —
/// and ONLY when the content itself was edited ([`cell_content_dirty`]); a cell-level-only edit
/// (shade) keeps its whole body byte-verbatim and patches just the open tag's `borderFillIDRef`.
/// Falls back to the cell's own original paraPr/charPr refs so a centered/styled cell keeps its
/// look. Returns None when the segment doesn't parse as `<hp:tc>…<hp:subList>…</hp:subList>…` —
/// the caller then re-emits the whole table instead (never a half-patch).
fn patch_cell_xml(
    cell_orig: &str,
    cell: &Cell,
    plan: &SynthPlan,
    bf: &str,
    sec_para_ref: &str,
    sec_plain_ref: &str,
    next_id: &mut u64,
) -> Option<String> {
    if !cell_orig.starts_with("<hp:tc") {
        return None;
    }
    let sub = cell_orig.find("<hp:subList")?;
    let open_end = sub + cell_orig[sub..].find('>')? + 1;
    // The LAST close is the cell's own subList (a nested table's subLists all close earlier).
    let close = cell_orig.rfind("</hp:subList>")?;
    if close < open_end {
        return None;
    }

    let mut out;
    if cell_content_dirty(&cell.blocks) {
        // Content edit (SetTableCellRuns): rebuild the subList children from the edited AST.
        // Cell-local fallback refs: keep the cell's original paragraph/char refs when present (a
        // centered gov-doc cell stays centered), else the section-level fallback.
        let inner = &cell_orig[open_end..close];
        let para_ref = last_attr(inner, "paraPrIDRef")
            .unwrap_or(sec_para_ref)
            .to_string();
        let plain_ref = last_attr(inner, "charPrIDRef")
            .unwrap_or(sec_plain_ref)
            .to_string();
        let cref = |idx: usize| {
            plan.char_ref
                .get(&idx)
                .cloned()
                .unwrap_or_else(|| plain_ref.clone())
        };
        let pref = |idx: usize| {
            plan.para_ref
                .get(&idx)
                .cloned()
                .unwrap_or_else(|| para_ref.clone())
        };
        let ctx = BodyCtx {
            cref: &cref,
            pref: &pref,
            base_para_ref: &para_ref,
            plain_ref: &plain_ref,
            bf,
            bf_ref: &plan.bf_ref,
        };
        let blocks: Vec<EmitBlock> = cell.blocks.iter().map(project_block).collect();
        let mut body = String::new();
        emit_cell_content(&mut body, &blocks, &ctx, next_id);

        out = String::with_capacity(cell_orig.len() + body.len());
        out.push_str(&cell_orig[..open_end]);
        out.push_str(&body);
        out.push_str(&cell_orig[close..]);
    } else {
        // Cell-level-only edit (shade): the body — including any un-modeled pic/equation/ctrl the
        // parse AST can't represent — stays byte-verbatim ("사용자 콘텐츠 삭제 금지").
        out = cell_orig.to_string();
    }

    // Shade edit (SetTableCellShade): re-point the verbatim tc open tag's borderFillIDRef at the
    // synthesized shaded fill. `shade_color` is only ever Some when an op set it (the parser
    // leaves it None), so untouched cells keep their original fill byte-verbatim.
    // (Post-054 the shade-only map is gone: the canonical borderFill key covers edges+shade. The
    // shade_color gate is load-bearing — only op-set shades may re-point a verbatim cell's fill.)
    if let Some(id) = cell
        .shade_color
        .and_then(|_| bf_spec(&cell.borders, cell.shade_color))
        .map(|s| bf_key(&s))
        .and_then(|k| plan.bf_ref.get(&k))
    {
        let tc_open_end = out.find('>')? + 1;
        let patched = synth::set_attr(&out[..tc_open_end], "borderFillIDRef", id);
        out = format!("{patched}{}", &out[tc_open_end..]);
    }
    Some(out)
}

/// Splice the first emitted block's `<hp:p>` BODY into the section's stub paragraph (the Skeleton's
/// lone secPr-carrying `<hp:p>`), transplanting the emitted open-tag attrs (paraPrIDRef/styleIDRef/
/// pageBreak) onto the stub. Returns false (→ caller appends normally) if `piece` isn't a single
/// `<hp:p …>…</hp:p>` or the stub can't be located. See the call site for why (054 stub blank line).
fn merge_first_block_into_stub(s: &mut String, piece: &str) -> bool {
    if !piece.starts_with("<hp:p ") || !piece.ends_with("</hp:p>") {
        return false;
    }
    let Some(open_end) = piece.find('>').map(|i| i + 1) else {
        return false;
    };
    let body = &piece[open_end..piece.len() - "</hp:p>".len()];

    // Patch the stub's open tag (the FIRST <hp:p in the section — the Skeleton base has exactly one).
    let Some(stub_start) = s.find("<hp:p") else {
        return false;
    };
    let Some(stub_open_end) = s[stub_start..].find('>').map(|i| stub_start + i + 1) else {
        return false;
    };
    let mut stub_tag = s[stub_start..stub_open_end].to_string();
    for attr in ["paraPrIDRef", "styleIDRef", "pageBreak"] {
        if let Some(v) = first_attr(&piece[..open_end], attr) {
            stub_tag = synth::set_attr(&stub_tag, attr, v);
        }
    }
    let new_open_end = stub_start + stub_tag.len();
    s.replace_range(stub_start..stub_open_end, &stub_tag);

    // Insert the body before the STUB's own close tag — found by DEPTH scan, because the stub can
    // contain nested <hp:p> by then (a spliced header/footer ctrl carries a subList of paragraphs;
    // naively taking the first </hp:p> would inject the body into that subList). The stub's own
    // empty run stays (zero-width; contributes no text).
    let Some(close) = paragraph_close_at(s, new_open_end) else {
        return false;
    };
    s.insert_str(close, body);
    true
}

/// Byte offset of the `</hp:p>` closing the paragraph whose open tag ends at `from` — depth-scans
/// nested `<hp:p`/`</hp:p>` pairs (subLists inside ctrl/table content). `None` if unbalanced.
fn paragraph_close_at(s: &str, from: usize) -> Option<usize> {
    let mut depth = 1usize;
    let mut idx = from;
    while depth > 0 {
        let open = s[idx..].find("<hp:p ").map(|p| idx + p);
        let close = s[idx..].find("</hp:p>").map(|p| idx + p)?;
        if let Some(o) = open.filter(|&o| o < close) {
            depth += 1;
            idx = o + "<hp:p ".len();
        } else {
            depth -= 1;
            if depth == 0 {
                return Some(close);
            }
            idx = close + "</hp:p>".len();
        }
    }
    None
}

/// Re-emit an EDITED simple paragraph in place: keep its original `<hp:p …>` open tag verbatim
/// (preserves id/paraPrIDRef/styleIDRef/pageBreak/… attrs), and rebuild the run content from the
/// AST. Each run references a synthesized charPr if it was re-formatted (`char_shape` interned),
/// else its original `charPrIDRef`. Simple paragraphs have no `<hp:linesegarray>` to preserve.
/// CONTRACT: only `Inline::Text` survives here (other inlines are filtered out below), so the
/// caller MUST keep `Inline::Raw`-bearing paragraphs off this path (see `patch_section_xml`) or
/// the verbatim object would be silently dropped.
/// Patch a `<hp:p …>` open tag's `paraPrIDRef`/`styleIDRef` for a SetParaPr/ApplyStyle edit. The
/// tag is rewritten ONLY when the paragraph carries a synthesized para_shape or a named style — a
/// runs-only edit (SetCharPr/InsertText/DeleteRange) leaves it byte-identical to the original.
fn patch_para_open_tag(open: &str, p: &Paragraph, plan: &SynthPlan) -> String {
    let style_ref = p.style_name.as_deref().and_then(|n| plan.style_map.get(n));
    let mut out = open.to_string();
    // paraPrIDRef: a synthesized para_shape (non-default) wins over the style's paraPr.
    if let Some(pr) = plan.para_ref.get(&p.para_shape) {
        out = synth::set_attr(&out, "paraPrIDRef", pr);
    } else if let Some(sr) = style_ref {
        out = synth::set_attr(&out, "paraPrIDRef", &sr.para_pr);
    }
    if let Some(sr) = style_ref {
        out = synth::set_attr(&out, "styleIDRef", &sr.id);
    }
    out
}

/// Re-emit a DIRTY structural (non-simple) paragraph: keep its ENTIRE body byte-verbatim (so
/// secPr/ctrl/pic/equation/tbl survive exactly) and patch ONLY the open-tag attributes. Body
/// edits (SetCharPr/run/text) are refused upstream on non-simple paragraphs, so a dirty non-simple
/// paragraph reaching here is guaranteed to be a SetParaPr/ApplyStyle (open-tag-only) change.
fn reemit_paragraph_open_only(orig_para: &str, p: &Paragraph, plan: &SynthPlan) -> String {
    let open_end = orig_para.find('>').map(|i| i + 1).unwrap_or(0);
    let open = patch_para_open_tag(&orig_para[..open_end], p, plan);
    format!("{open}{}", &orig_para[open_end..])
}

fn reemit_paragraph(orig_para: &str, p: &Paragraph, plan: &SynthPlan) -> String {
    let open_end = orig_para.find('>').map(|i| i + 1).unwrap_or(0);
    let mut out = String::with_capacity(orig_para.len() + 32);
    out.push_str(&patch_para_open_tag(&orig_para[..open_end], p, plan));
    if p.runs.is_empty() {
        out.push_str("<hp:run charPrIDRef=\"0\"><hp:t></hp:t></hp:run>");
    }
    for run in &p.runs {
        let cref = plan
            .char_ref
            .get(&run.char_shape)
            .cloned()
            .or_else(|| run.char_ref.clone())
            .unwrap_or_else(|| "0".to_string());
        let text: String = run
            .content
            .iter()
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        out.push_str(&format!(
            "<hp:run charPrIDRef=\"{cref}\"><hp:t>{}</hp:t></hp:run>",
            xml_escape(&text)
        ));
    }
    out.push_str("</hp:p>");
    out
}

/// A placed table cell ready to emit (origin position + span + content + border/fill + padding).
/// `content` holds the cell's FULL block sequence — paragraphs AND nested tables, recursively — so
/// multi-paragraph cells and tables-within-cells (both common in real .hwp) survive in full.
struct PlacedCell {
    row: usize,
    col: usize,
    col_span: usize,
    row_span: usize,
    content: Vec<EmitBlock>,
    /// Canonical [`bf_key`] of the cell's borders+shade, or `None` → the default table borderFill.
    bf_key: Option<String>,
    /// Cell-OWN padding `[l, r, t, b]` (HWPUNIT, → `hasMargin="1"` + `<hp:cellMargin>`); `None` →
    /// inherit the table default.
    padding: Option<[i32; 4]>,
}

/// One piece of a paragraph's run sequence, in document order. `Text` is a formatted text run;
/// `Ctrl` is verbatim run-level control XML (e.g. `<hp:ctrl><hp:fieldBegin…/></hp:ctrl>` or a
/// footnote/endnote marker) emitted inside its own `<hp:run>`. (SEAM A: lets inline markers ride
/// the same emit path as text — a Text-only paragraph emits byte-identically to before.)
enum RunPiece {
    /// (text, char_shape index) → `<hp:run charPrIDRef=…><hp:t>text</hp:t></hp:run>`.
    Text(String, usize),
    /// Verbatim run-body XML → `<hp:run charPrIDRef="0">{xml}</hp:run>`.
    Ctrl(String),
    /// A foot/endnote whose body is emitted (via `emit_cell_content`) into a `<hp:subList>` inside
    /// the note ctrl — needs the emit context, so it's rendered at emit time, not pre-rendered.
    Note {
        kind: NoteKind,
        number: u16,
        prefix: u16,
        suffix: u16,
        inst: u32,
        body: Vec<EmitBlock>,
    },
}

/// A table ready to emit, carrying every captured real value (issue 054, F2): per-column widths,
/// per-row stored heights, table-default cell padding, outer margins, and the outline borderFill.
/// Each `Vec`/`Option` empty/`None` ⇒ the emitter falls back to the legacy synthetic constants, so
/// editor-inserted tables (which capture nothing) emit byte-identically to pre-F2.
struct EmitTable {
    rows: usize,
    cols: usize,
    cells: Vec<PlacedCell>,
    /// Captured per-column widths (HWPUNIT, `cols` entries); empty ⇒ uniform columns.
    col_widths: Vec<i32>,
    /// Captured per-row stored heights (HWPUNIT, `rows` entries; a `0` slot = content-sized row);
    /// empty/malformed ⇒ the legacy uniform `RH` per row.
    row_heights: Vec<i32>,
    /// Table-default cell padding `[l, r, t, b]` (→ `<hp:inMargin>`); `None` ⇒ legacy 510/141.
    padding: Option<[i32; 4]>,
    /// Outer margins `[l, r, t, b]` (→ `<hp:outMargin>`); all-zero is treated as "unknown" ⇒ the
    /// legacy 283 box (an editor-inserted table has no captured margins — see `emit_table`).
    outer_margin: [i32; 4],
    /// Canonical [`bf_key`] of the table's OUTLINE borders (표 외곽), `None` ⇒ reuse the document's
    /// existing table borderFill (pre-F2 behavior).
    bf_key: Option<String>,
    /// 쪽 나누기 앞에서 on the table's wrapper `<hp:p>` — inherited from an ELIDED pure table-anchor
    /// paragraph (see [`emit_blocks`]) so a forced break on a table survives the round-trip.
    page_break: bool,
}

/// A dirty block ready to serialize: a paragraph, a table, or an embedded image.
enum EmitBlock {
    /// `page_break` = the paragraph's 쪽 나누기 앞에서 (`hp:p pageBreak`): the lift captures it from
    /// the .hwp (forced chapter-heading breaks — how gov templates paginate), and dropping it on
    /// re-emission collapsed the reopened page count (054 measured: benchmark.hwp 8 breaks → 1).
    /// Emitting it is the serializer half of fidelity gap #10 (the capture half already existed),
    /// pulled forward because 054's round-trip page-preservation acceptance requires it.
    Para {
        para_shape: usize,
        style: Option<String>,
        runs: Vec<RunPiece>,
        page_break: bool,
    },
    Table(EmitTable),
    /// An image, emitted as a `<hp:pic>` wrapped in its own paragraph. `bin_ref` is the manifest
    /// item id + `binaryItemIDRef`; width/height are the display size in HWPUNIT.
    Image {
        bin_ref: String,
        width: i32,
        height: i32,
    },
    /// A 수식, emitted as `<hp:equation>` wrapped in its own paragraph (the script is verbatim).
    Equation(EquationRef),
}

/// Whether a block is a dirty *APPENDED* block (false if untouched OR if it is an in-place-edited
/// existing paragraph — those carry `source` and are replaced surgically, not appended).
fn dirty_appended(b: &Block) -> bool {
    match b {
        Block::Paragraph(p) => p.dirty.is_dirty() && p.source.is_none(),
        // Frame-transparent (issue 060): recurse so a wrapper with only inner-table dirt is still
        // considered dirty here. In practice such a wrapper is handled in place by
        // `table_inplace_edits` and thus skipped before this is reached (it carries a src_span);
        // recursing keeps the gate consistent and avoids a silent drop otherwise.
        Block::Table(_) => b.any_dirty(),
    }
}

/// Project a `Block` to an `EmitBlock` UNCONDITIONALLY (the dirty gate lives in [`dirty_emit`]).
/// Used for cell content, which is always emitted in full when its enclosing table is — recursing
/// into nested tables.
fn project_block(b: &Block) -> EmitBlock {
    match b {
        // An image-bearing paragraph (the v2 lift emits each picture as its own paragraph) becomes
        // an EmitBlock::Image — checked BEFORE the text path, since para_runs() drops Inline::Image.
        Block::Paragraph(p)
            if p.runs
                .iter()
                .flat_map(|r| &r.content)
                .any(|i| matches!(i, Inline::Image(_))) =>
        {
            let im = p
                .runs
                .iter()
                .flat_map(|r| &r.content)
                .find_map(|i| match i {
                    Inline::Image(im) => Some(im),
                    _ => None,
                })
                .expect("guard guarantees an image");
            EmitBlock::Image {
                bin_ref: im.bin_ref.clone(),
                width: im.width,
                height: im.height,
            }
        }
        // An equation-bearing paragraph → EmitBlock::Equation (also before the text path).
        Block::Paragraph(p)
            if p.runs
                .iter()
                .flat_map(|r| &r.content)
                .any(|i| matches!(i, Inline::Equation(_))) =>
        {
            let eq = p
                .runs
                .iter()
                .flat_map(|r| &r.content)
                .find_map(|i| match i {
                    Inline::Equation(eq) => Some(eq),
                    _ => None,
                })
                .expect("guard guarantees an equation");
            EmitBlock::Equation(eq.clone())
        }
        Block::Paragraph(p) => EmitBlock::Para {
            para_shape: p.para_shape,
            style: p.style_name.clone(),
            runs: para_runs(p),
            page_break: p.page_break_before,
        },
        Block::Table(t) => EmitBlock::Table(EmitTable {
            rows: t.rows.max(1),
            cols: t.cols.max(1),
            cells: placed_cells(t),
            col_widths: t.col_widths.clone(),
            row_heights: t.row_heights.clone(),
            padding: t.padding,
            outer_margin: [
                t.outer_margin_left,
                t.outer_margin_right,
                t.outer_margin_top,
                t.outer_margin_bottom,
            ],
            bf_key: bf_spec(&t.borders, None).map(|s| bf_key(&s)),
            page_break: false, // set by emit_blocks when an elided anchor carried a break
        }),
    }
}

/// Project a block sequence to [`EmitBlock`]s, ELIDING pure table-anchor paragraphs. The .hwp lift
/// emits `앵커 문단 + Block::Table` per table, and the table emission creates its OWN wrapper
/// `<hp:p>` — so also emitting the (empty) anchor paragraph would grow a spurious blank LINE per
/// table per round-trip (054 measured: benchmark1 +67 blocks → 18p ballooned past 20p). Skipping it
/// keeps the reopened block stream 1:1 with the original lift's; a skipped anchor's forced page
/// break rides on the next table's wrapper.
fn emit_blocks(blocks: &[Block]) -> Vec<EmitBlock> {
    let mut out = Vec::new();
    let mut pending_pb = false;
    for b in blocks {
        if let Block::Paragraph(p) = b {
            if is_pure_table_anchor(p) {
                pending_pb |= p.page_break_before;
                continue;
            }
        }
        let mut eb = project_block(b);
        if let EmitBlock::Table(t) = &mut eb {
            t.page_break = std::mem::take(&mut pending_pb);
        }
        out.push(eb);
    }
    out
}

/// A paragraph that exists ONLY to anchor a table (the lift's `is_table_anchor` flag: hosts a table
/// control, no visible text). Defensive: any non-text inline (field marker/note/image) keeps it.
fn is_pure_table_anchor(p: &Paragraph) -> bool {
    p.is_table_anchor
        && !p.runs.iter().flat_map(|r| &r.content).any(|i| match i {
            Inline::Text(t) => !t.trim().is_empty(),
            _ => true,
        })
}

/// Project a table's ACTIVE cells to [`PlacedCell`]s, recursively projecting each cell's content.
fn placed_cells(t: &Table) -> Vec<PlacedCell> {
    t.cells
        .iter()
        .filter(|c| c.active)
        .map(|cell| PlacedCell {
            row: cell.row,
            col: cell.col,
            col_span: cell.col_span.max(1),
            row_span: cell.row_span.max(1),
            content: emit_blocks(&cell.blocks),
            bf_key: bf_spec(&cell.borders, cell.shade_color).map(|s| bf_key(&s)),
            padding: cell.padding,
        })
        .collect()
}

/// A paragraph's run sequence as ordered [`RunPiece`]s. Each run's text inlines collapse into one
/// `Text` piece (byte-identical to before). Inline markers (fields/notes, added in later phases)
/// flush the pending text and push a `Ctrl` piece in document order; Image/Equation are handled at
/// the block level (own paragraph) so they don't appear here.
fn para_runs(p: &Paragraph) -> Vec<RunPiece> {
    let has_marker = |r: &Run| {
        r.content.iter().any(|i| {
            matches!(
                i,
                Inline::FieldBegin(_) | Inline::FieldEnd(_) | Inline::Bookmark(_) | Inline::Note(_)
            )
        })
    };
    let mut out = Vec::new();
    for r in &p.runs {
        // Common case (no inline markers): collapse the run's text into one piece — byte-identical.
        if !has_marker(r) {
            let text: String = r
                .content
                .iter()
                .filter_map(|i| {
                    if let Inline::Text(t) = i {
                        Some(t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            out.push(RunPiece::Text(text, r.char_shape));
            continue;
        }
        // Marker run: walk content in order, flushing text segments + emitting Ctrl markers.
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<RunPiece>| {
            if !text.is_empty() {
                out.push(RunPiece::Text(std::mem::take(text), r.char_shape));
            }
        };
        for inl in &r.content {
            match inl {
                Inline::Text(t) => text.push_str(t),
                Inline::FieldBegin(m) => {
                    flush(&mut text, &mut out);
                    out.push(RunPiece::Ctrl(field_begin_xml(m)));
                }
                Inline::FieldEnd(id) => {
                    flush(&mut text, &mut out);
                    out.push(RunPiece::Ctrl(field_end_xml(*id)));
                }
                Inline::Bookmark(name) => {
                    flush(&mut text, &mut out);
                    out.push(RunPiece::Ctrl(format!(
                        "<hp:ctrl><hp:bookmark name=\"{}\"/></hp:ctrl>",
                        xml_escape(name)
                    )));
                }
                Inline::Note(nr) => {
                    flush(&mut text, &mut out);
                    out.push(RunPiece::Note {
                        kind: nr.kind,
                        number: nr.number,
                        prefix: nr.prefix_char,
                        suffix: nr.suffix_char,
                        inst: nr.inst_id,
                        body: emit_blocks(&nr.body),
                    });
                }
                _ => {}
            }
        }
        flush(&mut text, &mut out);
    }
    out
}

/// `<hp:fieldBegin>` for a field marker (wrapped in `<hp:ctrl>`). Minimal-but-valid: a single
/// `Command` string param (a hyperlink's URL). `id` doubles as `fieldid` so the matching `fieldEnd`
/// can reference it.
fn field_begin_xml(m: &hwp_model::document::FieldMarker) -> String {
    format!(
        "<hp:ctrl><hp:fieldBegin id=\"{id}\" type=\"{ftype}\" name=\"\" editable=\"1\" dirty=\"0\" zorder=\"0\" fieldid=\"{id}\" metaTag=\"\">\
<hp:parameters cnt=\"1\" name=\"\"><hp:stringParam name=\"Command\" xml:space=\"preserve\">{cmd}</hp:stringParam></hp:parameters>\
</hp:fieldBegin></hp:ctrl>",
        id = m.id,
        ftype = m.field_type,
        cmd = xml_escape(&m.command),
    )
}

/// `<hp:fieldEnd>` referencing the matching `fieldBegin` id.
fn field_end_xml(begin_id: u32) -> String {
    format!("<hp:ctrl><hp:fieldEnd beginIDRef=\"{begin_id}\" fieldid=\"{begin_id}\"/></hp:ctrl>")
}

/// Emit a sequence of cell blocks (paragraphs + nested tables, recursively) inside an open
/// `<hp:subList>`. `next_id` is a monotonic counter giving every `<hp:p>`/`<hp:tbl>` a unique id.
/// An empty cell gets one empty paragraph (a subList requires ≥1 `<hp:p>`).
fn emit_cell_content(out: &mut String, blocks: &[EmitBlock], ctx: &BodyCtx, next_id: &mut u64) {
    let base_para_ref = ctx.base_para_ref;
    if blocks.is_empty() {
        let pid = *next_id;
        *next_id += 1;
        out.push_str(&format!(
            "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"0\"><hp:t></hp:t></hp:run></hp:p>"
        ));
        return;
    }
    for block in blocks {
        match block {
            EmitBlock::Para {
                para_shape,
                runs,
                page_break,
                ..
            } => {
                let pid = *next_id;
                *next_id += 1;
                // The cell paragraph's REAL paraPr (synthesized), not the base ref — line spacing /
                // 문단간격 drive the cell's measured height (054 round-trip stability).
                let para_ref = (ctx.pref)(*para_shape);
                emit_paragraph(out, pid, &para_ref, "0", runs, *page_break, ctx, next_id);
            }
            EmitBlock::Table(tbl) => {
                // A nested table lives inside a wrapping <hp:p><hp:run>…</hp:run></hp:p>.
                let pid = *next_id;
                let tid = *next_id + 1;
                *next_id += 2;
                let pb = if tbl.page_break { "1" } else { "0" };
                out.push_str(&format!(
                    "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"{pb}\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{}\">",
                    ctx.plain_ref
                ));
                emit_table(out, tid, tbl, ctx, next_id);
                out.push_str("<hp:t></hp:t></hp:run></hp:p>");
            }
            EmitBlock::Image {
                bin_ref,
                width,
                height,
            } => {
                let pid = *next_id;
                let picid = *next_id + 1;
                *next_id += 2;
                emit_pic(
                    out,
                    pid,
                    picid,
                    bin_ref,
                    *width,
                    *height,
                    base_para_ref,
                    ctx.plain_ref,
                );
            }
            EmitBlock::Equation(eq) => {
                let pid = *next_id;
                let eqid = *next_id + 1;
                *next_id += 2;
                emit_equation(out, pid, eqid, eq, base_para_ref, ctx.plain_ref);
            }
        }
    }
}

/// Emit an embedded image as an inline (`treatAsChar`) `<hp:pic>` wrapped in its own `<hp:p>`. The
/// `<hc:img binaryItemIDRef="{bin_ref}">` links to the manifest `<opf:item id="{bin_ref}">` whose
/// href is the `BinData/{bin_ref}.{kind}` part. orgSz=curSz=display size with identity scale, so the
/// image renders at its stored display size; crop/wrap/anchor/rotation are v2.1+.
#[allow(clippy::too_many_arguments)]
fn emit_pic(
    out: &mut String,
    pid: u64,
    picid: u64,
    bin_ref: &str,
    w: i32,
    h: i32,
    base_para_ref: &str,
    plain_ref: &str,
) {
    let w = w.max(1);
    let h = h.max(1);
    let (cx, cy) = (w / 2, h / 2);
    out.push_str(&format!(
        "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{plain_ref}\">\
<hp:pic id=\"{picid}\" zOrder=\"0\" numberingType=\"PICTURE\" textWrap=\"TOP_AND_BOTTOM\" textFlow=\"BOTH_SIDES\" lock=\"0\" dropcapstyle=\"None\" href=\"\" groupLevel=\"0\" instid=\"{picid}\" reverse=\"0\">\
<hp:offset x=\"0\" y=\"0\"/><hp:orgSz width=\"{w}\" height=\"{h}\"/><hp:curSz width=\"{w}\" height=\"{h}\"/>\
<hp:flip horizontal=\"0\" vertical=\"0\"/><hp:rotationInfo angle=\"0\" centerX=\"{cx}\" centerY=\"{cy}\" rotateimage=\"1\"/>\
<hp:renderingInfo><hc:transMatrix e1=\"1\" e2=\"0\" e3=\"0\" e4=\"0\" e5=\"1\" e6=\"0\"/><hc:scaMatrix e1=\"1\" e2=\"0\" e3=\"0\" e4=\"0\" e5=\"1\" e6=\"0\"/><hc:rotMatrix e1=\"1\" e2=\"0\" e3=\"0\" e4=\"0\" e5=\"1\" e6=\"0\"/></hp:renderingInfo>\
<hc:img binaryItemIDRef=\"{bin_ref}\" bright=\"0\" contrast=\"0\" effect=\"REAL_PIC\" alpha=\"0\"/>\
<hp:imgRect><hc:pt0 x=\"0\" y=\"0\"/><hc:pt1 x=\"{w}\" y=\"0\"/><hc:pt2 x=\"{w}\" y=\"{h}\"/><hc:pt3 x=\"0\" y=\"{h}\"/></hp:imgRect>\
<hp:imgClip left=\"0\" right=\"{w}\" top=\"0\" bottom=\"{h}\"/><hp:inMargin left=\"0\" right=\"0\" top=\"0\" bottom=\"0\"/>\
<hp:imgDim dimwidth=\"{w}\" dimheight=\"{h}\"/><hp:effects/>\
<hp:sz width=\"{w}\" widthRelTo=\"ABSOLUTE\" height=\"{h}\" heightRelTo=\"ABSOLUTE\" protect=\"0\"/>\
<hp:pos treatAsChar=\"1\" affectLSpacing=\"0\" flowWithText=\"1\" allowOverlap=\"0\" holdAnchorAndSO=\"0\" vertRelTo=\"PARA\" horzRelTo=\"PARA\" vertAlign=\"TOP\" horzAlign=\"LEFT\" vertOffset=\"0\" horzOffset=\"0\"/>\
<hp:outMargin left=\"0\" right=\"0\" top=\"0\" bottom=\"0\"/></hp:pic>\
<hp:t></hp:t></hp:run></hp:p>"
    ));
}

/// Emit a 수식 as an inline (`treatAsChar`) `<hp:equation>` wrapped in its own `<hp:p>`. The HWP
/// equation script is the SAME markup as OWPML's `<hp:script>`, so it round-trips verbatim (only
/// XML-escaped). Child order is sz→pos→outMargin→script (verified against a real Hancom equation);
/// empty font/version fall back to Hancom's defaults.
fn emit_equation(
    out: &mut String,
    pid: u64,
    eqid: u64,
    eq: &EquationRef,
    base_para_ref: &str,
    plain_ref: &str,
) {
    let w = eq.width.max(1);
    let h = eq.height.max(1);
    let font = if eq.font.is_empty() {
        "HYhwpEQ"
    } else {
        eq.font.as_str()
    };
    let version = if eq.version.is_empty() {
        "Equation Version 60"
    } else {
        eq.version.as_str()
    };
    let base_unit = if eq.base_unit == 0 {
        1000
    } else {
        eq.base_unit
    };
    let baseline = eq.baseline;
    let color = eq.color.to_hex();
    let script = xml_escape(&eq.script);
    out.push_str(&format!(
        "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{plain_ref}\">\
<hp:equation id=\"{eqid}\" zOrder=\"0\" numberingType=\"EQUATION\" textWrap=\"TOP_AND_BOTTOM\" textFlow=\"BOTH_SIDES\" lock=\"0\" dropcapstyle=\"None\" version=\"{version}\" baseLine=\"{baseline}\" textColor=\"{color}\" baseUnit=\"{base_unit}\" lineMode=\"CHAR\" font=\"{font}\">\
<hp:sz width=\"{w}\" widthRelTo=\"ABSOLUTE\" height=\"{h}\" heightRelTo=\"ABSOLUTE\" protect=\"0\"/>\
<hp:pos treatAsChar=\"1\" affectLSpacing=\"0\" flowWithText=\"1\" allowOverlap=\"0\" holdAnchorAndSO=\"0\" vertRelTo=\"PARA\" horzRelTo=\"PARA\" vertAlign=\"TOP\" horzAlign=\"LEFT\" vertOffset=\"0\" horzOffset=\"0\"/>\
<hp:outMargin left=\"56\" right=\"56\" top=\"0\" bottom=\"0\"/>\
<hp:script>{script}</hp:script></hp:equation>\
<hp:t></hp:t></hp:run></hp:p>"
    ));
}

/// The recurring emit context threaded through paragraph/cell/note-body emission: how to resolve a
/// run's char_shape index → charPrIDRef, plus the default refs a note body needs to recurse.
struct BodyCtx<'a> {
    cref: &'a dyn Fn(usize) -> String,
    /// Resolve a paragraph's `para_shape` index → `paraPrIDRef` (synthesized id, else the base ref).
    /// Load-bearing for CELL paragraphs (054): they used to hardcode the base ref, dropping the
    /// cell text's real line-spacing/문단간격 → reopened tables measured taller → page drift.
    pref: &'a dyn Fn(usize) -> String,
    base_para_ref: &'a str,
    plain_ref: &'a str,
    bf: &'a str,
    bf_ref: &'a BTreeMap<String, String>,
}

/// Emit one `<hp:p>` from its [`RunPiece`] sequence: Text pieces resolve their char_shape via
/// `ctx.cref` → `<hp:run><hp:t>`; Ctrl pieces emit verbatim run-body XML; Note pieces emit the
/// foot/endnote ctrl with its body recursed through `emit_cell_content` (SEAM B). An empty piece
/// list emits one empty run. (linesegarray omitted — Hancom recomputes layout on open.)
#[allow(clippy::too_many_arguments)]
fn emit_paragraph(
    out: &mut String,
    id: u64,
    para_ref: &str,
    style_ref: &str,
    pieces: &[RunPiece],
    page_break: bool,
    ctx: &BodyCtx,
    next_id: &mut u64,
) {
    let pb = if page_break { "1" } else { "0" };
    out.push_str(&format!(
        "<hp:p id=\"{id}\" paraPrIDRef=\"{para_ref}\" styleIDRef=\"{style_ref}\" pageBreak=\"{pb}\" columnBreak=\"0\" merged=\"0\">"
    ));
    if pieces.is_empty() {
        out.push_str("<hp:run charPrIDRef=\"0\"><hp:t></hp:t></hp:run>");
    }
    for piece in pieces {
        match piece {
            RunPiece::Text(text, idx) => out.push_str(&format!(
                "<hp:run charPrIDRef=\"{}\"><hp:t>{}</hp:t></hp:run>",
                (ctx.cref)(*idx),
                xml_escape(text)
            )),
            RunPiece::Ctrl(xml) => {
                out.push_str(&format!("<hp:run charPrIDRef=\"0\">{xml}</hp:run>"));
            }
            RunPiece::Note {
                kind,
                number,
                prefix,
                suffix,
                inst,
                body,
            } => {
                let tag = match kind {
                    NoteKind::Foot => "footNote",
                    NoteKind::End => "endNote",
                };
                out.push_str(&format!(
                    "<hp:run charPrIDRef=\"0\"><hp:ctrl><hp:{tag} number=\"{number}\" prefixChar=\"{prefix}\" suffixChar=\"{suffix}\" instId=\"{inst}\">\
<hp:subList id=\"\" textDirection=\"HORIZONTAL\" lineWrap=\"BREAK\" vertAlign=\"TOP\" linkListIDRef=\"0\" linkListNextIDRef=\"0\" textWidth=\"0\" textHeight=\"0\" hasTextRef=\"0\" hasNumRef=\"0\">"
                ));
                emit_cell_content(out, body, ctx, next_id);
                out.push_str(&format!("</hp:subList></hp:{tag}></hp:ctrl></hp:run>"));
            }
        }
    }
    out.push_str("</hp:p>");
}

/// Emit a native `<hp:tbl>` honoring cell merge (colSpan/rowSpan) + per-cell borders/shade. Covered
/// positions are omitted and fully-covered `<hp:tr>` are suppressed (Hancom's convention).
/// Geometry uses the CAPTURED real values when present (issue 054, F2 — col widths, per-row stored
/// heights, in/out margins, outline borderFill); otherwise the legacy synthetic constants, so an
/// editor-inserted table (nothing captured) emits byte-identically to pre-F2. Hancom re-lays-out
/// on open either way — but OUR re-open (rhwp parse → lift) reads these values back as the
/// row-height floors / paddings that keep pagination stable (the 8p→6p 왕복 증상).
fn emit_table(out: &mut String, tid: u64, t: &EmitTable, ctx: &BodyCtx, next_id: &mut u64) {
    let (bf, bf_ref) = (ctx.bf, ctx.bf_ref);
    const W_DEFAULT: u64 = 42520; // standard A4 text width in HWPUNIT (fallback when widths unknown)
    const RH: u64 = 2200; // ~7.7mm per row (fallback when stored heights unknown)
    let (rows, cols) = (t.rows, t.cols);
    // Use the CAPTURED per-column widths when they're present and valid (one positive entry per
    // column) — this preserves a .hwp table's real proportions (e.g. a narrow label column + wide
    // value column). Otherwise fall back to uniform columns summing to the standard text width.
    let widths_ok = t.col_widths.len() == cols && t.col_widths.iter().all(|&w| w > 0);
    let widths: Vec<u64> = if widths_ok {
        t.col_widths.iter().map(|&w| w as u64).collect()
    } else {
        let cw = W_DEFAULT / cols as u64;
        (0..cols)
            .map(|c| {
                if c + 1 == cols {
                    W_DEFAULT - cw * (cols as u64 - 1)
                } else {
                    cw
                }
            })
            .collect()
    };
    let w_total: u64 = widths.iter().sum();
    let span_w = |c: usize, n: usize| widths[c..(c + n).min(cols)].iter().sum::<u64>();
    // Per-row STORED heights (F2): emitted verbatim into <hp:cellSz> so a re-open lifts back the
    // SAME row-height floors (020) the original .hwp carried. A 0 slot stays 0 = content-sized/auto
    // (never inflated to RH — that's what repaginated re-opened docs). Malformed/absent vec → the
    // legacy uniform RH per row (editor-inserted tables; byte-stable with pre-F2).
    let heights_ok = t.row_heights.len() == rows && t.row_heights.iter().any(|&h| h > 0);
    let rh_of = |r: usize| -> u64 {
        if heights_ok {
            t.row_heights[r].max(0) as u64
        } else {
            RH
        }
    };
    // A ROW-SPANNING cell's <hp:cellSz height> must round-trip idempotently: the lift distributes a
    // spanning cell's height EVENLY (height/span) across its rows and takes the per-row max, so
    // emitting the SUM of unequal row heights would re-lift as sum/span and INFLATE the shorter rows
    // (measured: benchmark1 표 7/48 rows grew 7088→9804 on reopen). `span × min(row heights)` is the
    // unique even-distributable value that (a) never raises any covered row (min ≤ each row) and
    // (b) exactly reproduces rows the span itself determined (there min == the span's own per-row
    // contribution) — recovering the original stored height in the common case.
    let span_h = |r: usize, n: usize| -> u64 {
        let end = (r + n).min(rows);
        let n_eff = end.saturating_sub(r).max(1) as u64;
        if n_eff == 1 {
            return rh_of(r);
        }
        (r..end).map(rh_of).min().unwrap_or(0) * n_eff
    };
    let height = (0..rows).map(rh_of).sum::<u64>();
    let w = w_total; // table box width = sum of column widths
                     // Outer margins: all-zero means "nothing captured" (editor tables) → the legacy 283 box. (A
                     // lifted table with genuinely all-zero 바깥 여백 also gets 283 — a documented approximation;
                     // benchmark gov-docs carry non-zero margins.)
    let [oml, omr, omt, omb] = if t.outer_margin.iter().all(|&m| m == 0) {
        [283; 4]
    } else {
        t.outer_margin.map(|m| m.max(0))
    };
    let [iml, imr, imt, imb] = t.padding.unwrap_or([510, 510, 141, 141]);
    // Table OUTLINE borderFill (표 외곽): the synthesized faithful entry, else the reused document bf.
    let tbl_bf = t
        .bf_key
        .as_deref()
        .and_then(|k| bf_ref.get(k))
        .map(String::as_str)
        .unwrap_or(bf);
    out.push_str(&format!(
        "<hp:tbl id=\"{tid}\" zOrder=\"0\" numberingType=\"TABLE\" textWrap=\"TOP_AND_BOTTOM\" textFlow=\"BOTH_SIDES\" lock=\"0\" dropcapstyle=\"None\" pageBreak=\"CELL\" repeatHeader=\"1\" rowCnt=\"{rows}\" colCnt=\"{cols}\" cellSpacing=\"0\" borderFillIDRef=\"{tbl_bf}\" noAdjust=\"0\">\
<hp:sz width=\"{w}\" widthRelTo=\"ABSOLUTE\" height=\"{height}\" heightRelTo=\"ABSOLUTE\" protect=\"0\"/>\
<hp:pos treatAsChar=\"1\" affectLSpacing=\"0\" flowWithText=\"1\" allowOverlap=\"0\" holdAnchorAndSO=\"0\" vertRelTo=\"PARA\" horzRelTo=\"COLUMN\" vertAlign=\"TOP\" horzAlign=\"LEFT\" vertOffset=\"0\" horzOffset=\"0\"/>\
<hp:outMargin left=\"{oml}\" right=\"{omr}\" top=\"{omt}\" bottom=\"{omb}\"/>\
<hp:inMargin left=\"{iml}\" right=\"{imr}\" top=\"{imt}\" bottom=\"{imb}\"/>"
    ));
    for r in 0..rows {
        // Origin cells whose top-left lies in this row, left to right.
        let mut row_cells: Vec<&PlacedCell> = t.cells.iter().filter(|c| c.row == r).collect();
        row_cells.sort_by_key(|c| c.col);
        if row_cells.is_empty() {
            continue; // fully covered by row-spans from above — suppress the <hp:tr>
        }
        out.push_str("<hp:tr>");
        for cell in row_cells {
            let cellbf = cell
                .bf_key
                .as_ref()
                .and_then(|k| bf_ref.get(k))
                .map(String::as_str)
                .unwrap_or(bf);
            let header = if r == 0 { "1" } else { "0" };
            // Cell padding: its OWN margins when declared (hasMargin="1"), else the table default.
            let has_margin = if cell.padding.is_some() { "1" } else { "0" };
            let [cml, cmr, cmt, cmb] = cell.padding.unwrap_or([iml, imr, imt, imb]);
            out.push_str(&format!(
                "<hp:tc name=\"\" header=\"{header}\" hasMargin=\"{has_margin}\" protect=\"0\" editable=\"0\" dirty=\"0\" borderFillIDRef=\"{cellbf}\">\
<hp:subList id=\"\" textDirection=\"HORIZONTAL\" lineWrap=\"BREAK\" vertAlign=\"CENTER\" linkListIDRef=\"0\" linkListNextIDRef=\"0\" textWidth=\"0\" textHeight=\"0\" hasTextRef=\"0\" hasNumRef=\"0\">"
            ));
            // The cell's full content — paragraphs AND nested tables, recursively.
            emit_cell_content(out, &cell.content, ctx, next_id);
            out.push_str(&format!(
                "</hp:subList>\
<hp:cellAddr colAddr=\"{}\" rowAddr=\"{r}\"/>\
<hp:cellSpan colSpan=\"{}\" rowSpan=\"{}\"/>\
<hp:cellSz width=\"{}\" height=\"{}\"/>\
<hp:cellMargin left=\"{cml}\" right=\"{cmr}\" top=\"{cmt}\" bottom=\"{cmb}\"/></hp:tc>",
                cell.col,
                cell.col_span,
                cell.row_span,
                span_w(cell.col, cell.col_span),
                span_h(cell.row, cell.row_span),
            ));
        }
        out.push_str("</hp:tr>");
    }
    out.push_str("</hp:tbl>");
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Find a valid `borderFillIDRef` for an emitted table: reuse an existing table's borderFill
/// (known-good for tables) if any, else the highest borderFill id in the header pool. Returns
/// None only if the doc has no borderFill at all (then the serializer falls back to "1").
fn find_table_borderfill(pkg: &Package) -> Option<String> {
    for name in pkg.section_part_names() {
        if let Ok(bytes) = pkg.read_part(&name) {
            let s = String::from_utf8_lossy(&bytes);
            if let Some(p) = s.find("<hp:tbl") {
                if let Some(v) = first_attr(&s[p..], "borderFillIDRef") {
                    return Some(v.to_string());
                }
            }
        }
    }
    let hdr = pkg.read_header()?;
    let s = String::from_utf8_lossy(&hdr);
    max_numeric_attr(&s, "borderFill id=\"")
}

/// Value of the FIRST occurrence of `name="…"` in the slice.
fn first_attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let start = s.find(&pat)? + pat.len();
    let rest = &s[start..];
    rest.find('"').map(|end| &rest[..end])
}

/// Largest numeric value across all `{pat}N"` occurrences (e.g. the top borderFill id).
fn max_numeric_attr(s: &str, pat: &str) -> Option<String> {
    let mut best: Option<u64> = None;
    let mut idx = 0;
    while let Some(p) = s[idx..].find(pat) {
        let start = idx + p + pat.len();
        let rest = &s[start..];
        match rest.find('"') {
            Some(end) => {
                if let Ok(v) = rest[..end].parse::<u64>() {
                    best = Some(best.map_or(v, |b| b.max(v)));
                }
                idx = start + end;
            }
            None => break,
        }
    }
    best.map(|v| v.to_string())
}

/// Value of the LAST occurrence of `name="…"` in the XML (reuse an existing valid ref).
fn last_attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let start = s.rfind(&pat)? + pat.len();
    let rest = &s[start..];
    rest.find('"').map(|end| &rest[..end])
}

/// Largest numeric `id="…"` in the XML (new ids start above this to avoid collisions).
fn max_id(s: &str) -> u64 {
    let pat = "id=\"";
    let mut max = 0u64;
    let mut idx = 0;
    while let Some(p) = s[idx..].find(pat) {
        let start = idx + p + pat.len();
        let rest = &s[start..];
        match rest.find('"') {
            Some(end) => {
                if let Ok(v) = rest[..end].parse::<u64>() {
                    max = max.max(v);
                }
                idx = start + end;
            }
            None => break,
        }
    }
    max
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_semantic;

    fn sample() -> Vec<u8> {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/sample.hwpx");
        std::fs::read(p).expect("read corpus/sample.hwpx")
    }

    /// A real Hancom-produced HWPX (full header.xml pools) — needed to exercise synthesis.
    fn showcase() -> Vec<u8> {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/hwpx/FormattingShowcase.hwpx"
        );
        std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
    }

    #[test]
    fn synthesizes_charpr_for_formatted_run() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        // A red, bold CharShape interned at index 0; a default run won't synthesize.
        let red_bold = CharShape {
            bold: true,
            text_color: Color::from_hex("#FF0000").unwrap(),
            ..Default::default()
        };
        doc.char_shapes.push(red_bold);
        let red_idx = doc.char_shapes.len() - 1;
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: red_idx,
                content: vec![Inline::Text("합성된 글자".into())],
                ..Default::default()
            }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        // header.xml must gain a synthesized charPr (red + bold), with itemCnt bumped and the
        // charProperties container still balanced (the container-vs-element regression).
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        assert_eq!(
            header.matches("<hh:charProperties").count(),
            1,
            "container not duplicated"
        );
        assert_eq!(
            header.matches("</hh:charProperties>").count(),
            1,
            "container balanced"
        );
        assert!(
            header.contains("<hh:bold/>"),
            "a bold charPr was synthesized"
        );
        assert!(
            header.contains(r##"textColor="#FF0000""##),
            "red charPr synthesized"
        );
        // round-trips + opens safely
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("합성된 글자"));
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    /// 054 F2: a table carrying CAPTURED real geometry (row heights / paddings / outer margins /
    /// per-edge borders) emits those actual values — no more RH·510/141·283 hardcodes — and the
    /// bordered cell references a SYNTHESIZED faithful borderFill, not the reused table bf.
    #[test]
    fn table_emits_captured_real_geometry_and_borders() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let red = Color::from_hex("#FF0000").unwrap();
        let mk = |row: usize, text: &str| Cell {
            row,
            col: 0,
            blocks: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text(text.into())],
                    ..Default::default()
                }],
                dirty: Dirty(true),
                ..Default::default()
            })],
            dirty: Dirty(true),
            ..Default::default()
        };
        let mut c0 = mk(0, "위");
        c0.padding = Some([100, 200, 50, 60]); // 셀 고유 여백 → hasMargin="1"
        c0.borders = [
            Some(CellEdge {
                color: red,
                style: LineStyle::Solid,
                width_px: 1.0,
            }), // left: 0.25mm red
            None,
            None,
            Some(CellEdge {
                color: Color {
                    r: 0,
                    g: 0,
                    b: 0,
                    a: 255,
                },
                style: LineStyle::None,
                width_px: 0.5,
            }), // bottom: 선없음
        ];
        let c1 = mk(1, "아래");
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Table(Table {
            rows: 2,
            cols: 1,
            cells: vec![c0, c1],
            col_widths: vec![8000],
            row_heights: vec![1500, 3000], // 저장 행높이 실값 (020 floor의 재방출 소스)
            padding: Some([400, 401, 402, 403]), // 표 기본 안쪽 여백 (inMargin)
            outer_margin_left: 10,
            outer_margin_right: 20,
            outer_margin_top: 30,
            outer_margin_bottom: 40,
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let sec0 = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        // 실값 방출 (하드코딩 제거 증빙)
        assert!(
            sec0.contains(r#"<hp:inMargin left="400" right="401" top="402" bottom="403"/>"#),
            "표 안쪽 여백 실값"
        );
        assert!(
            sec0.contains(r#"<hp:outMargin left="10" right="20" top="30" bottom="40"/>"#),
            "표 바깥 여백 실값"
        );
        assert!(
            sec0.contains(r#"<hp:cellSz width="8000" height="1500"/>"#),
            "행0 저장 높이"
        );
        assert!(
            sec0.contains(r#"<hp:cellSz width="8000" height="3000"/>"#),
            "행1 저장 높이"
        );
        assert!(sec0.contains(r#"height="4500""#), "표 전체 높이 = Σ행높이");
        assert!(
            sec0.contains(r#"hasMargin="1""#)
                && sec0.contains(r#"<hp:cellMargin left="100" right="200" top="50" bottom="60"/>"#),
            "셀 고유 여백 실값"
        );
        // 헤더에 충실한 borderFill 합성 (좌: SOLID 0.25mm 빨강, 하: 선없음)
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        assert!(
            header.contains(r##"<hh:leftBorder type="SOLID" width="0.25 mm" color="#FF0000"/>"##),
            "좌 테두리 실값 합성: {header}"
        );
        assert!(
            header.contains(r#"<hh:bottomBorder type="NONE""#),
            "하 테두리 선없음 합성"
        );
        assert_eq!(
            header.matches("<hh:borderFills").count(),
            1,
            "container balanced"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    /// 054: 표만 앵커하는 빈 문단은 방출에서 생략된다(표 래퍼 <hp:p>가 앵커 역할) — 왕복마다 표당
    /// 빈 줄이 하나씩 자라는 증식을 막는다. 앵커의 쪽나누기는 래퍼로 이관된다.
    #[test]
    fn pure_table_anchor_paragraph_is_elided_and_break_rides_wrapper() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            is_table_anchor: true,
            page_break_before: true,
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.blocks.push(Block::Table(Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                blocks: vec![],
                dirty: Dirty(true),
                ..Default::default()
            }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let sec0 = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        // 래퍼가 쪽나누기를 이어받고, 별도의 빈 앵커 <hp:p>는 추가되지 않는다. (showcase 원본에도
        // 표가 있으므로 마지막 <hp:tbl> = 방금 append 된 표를 본다.)
        let tbl_at = sec0.rfind("<hp:tbl").expect("table emitted");
        let wrapper_open = sec0[..tbl_at].rfind("<hp:p ").expect("wrapper <hp:p>");
        assert!(
            sec0[wrapper_open..tbl_at].contains(r#"pageBreak="1""#),
            "앵커의 쪽나누기가 래퍼로 이관"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn synthesizes_parapr_with_doubled_default_margins() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        // center align + 20pt first-line indent (2000 HWPUNIT)
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Center,
            indent: 2000,
            ..Default::default()
        });
        let center_idx = doc.para_shapes.len() - 1;
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("가운데".into())],
                ..Default::default()
            }],
            para_shape: center_idx,
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        assert_eq!(
            header.matches("<hh:paraProperties").count(),
            1,
            "container not duplicated"
        );
        assert!(
            header.contains(r#"horizontal="CENTER""#),
            "center align synthesized"
        );
        // hp:case intent=2000, hp:default intent=4000 (doubled)
        assert!(
            header.contains(r#"<hc:intent value="2000""#),
            "case intent = V"
        );
        assert!(
            header.contains(r#"<hc:intent value="4000""#),
            "default intent = 2V (doubled)"
        );
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("가운데"));
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn table_cell_merge_and_shade_synthesize() {
        // A 2-col table: row0 has one cell spanning both columns + a shade; row1 has two cells.
        let mut doc = parse_semantic(&showcase()).unwrap();
        let shade = Color::from_hex("#DDEBF7").unwrap();
        let mk = |row, col, cspan, text: &str, sh: Option<Color>| Cell {
            row,
            col,
            col_span: cspan,
            row_span: 1,
            shade_color: sh,
            blocks: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text(text.into())],
                    ..Default::default()
                }],
                dirty: Dirty(true),
                ..Default::default()
            })],
            dirty: Dirty(true),
            ..Default::default()
        };
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Table(Table {
            rows: 2,
            cols: 2,
            cells: vec![
                mk(0, 0, 2, "머리(병합)", Some(shade)),
                mk(1, 0, 1, "A", None),
                mk(1, 1, 1, "B", None),
            ],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let xml = String::from_utf8_lossy(&out);
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        // a shaded borderFill was synthesized with the requested face color
        assert!(
            header.contains(r##"faceColor="#DDEBF7""##),
            "shade borderFill synthesized"
        );
        assert_eq!(
            header.matches("<hh:borderFills").count(),
            1,
            "container balanced"
        );
        let _ = xml;
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("머리(병합)") && doc2.plain_text().contains("A"));
        // the merged cell round-trips with colSpan 2
        let merged = doc2
            .sections
            .iter()
            .flat_map(|s| &s.blocks)
            .find_map(|b| match b {
                Block::Table(t) => t.cells.iter().find(|c| c.col_span == 2).cloned(),
                _ => None,
            });
        assert!(merged.is_some(), "merged colSpan=2 cell round-trips");
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn page_layout_edit_patches_secpr() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        // landscape A4 + 30mm margins (8504 HWPUNIT)
        sec.page = PageSetup {
            width: 84188,
            height: 59528,
            margin_left: 8504,
            margin_right: 8504,
            margin_top: 8504,
            margin_bottom: 8504,
            landscape: true,
            columns: 1,
        };
        sec.page_edited = true;
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let xml = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        let pp = &xml[xml.find("<hp:pagePr").unwrap()..];
        let pp = &pp[..pp.find('>').unwrap()];
        assert!(
            pp.contains(r#"width="84188""#) && pp.contains(r#"height="59528""#),
            "landscape dims: {pp}"
        );
        let m = &xml[xml.find("<hp:margin").unwrap()..];
        let m = &m[..m.find("/>").unwrap()];
        assert!(
            m.contains(r#"left="8504""#) && m.contains(r#"top="8504""#),
            "margins patched: {m}"
        );
        assert!(m.contains(r#"header="4252""#), "header margin preserved");
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn in_place_edit_reemits_only_the_edited_paragraph() {
        // #003-full first slice: bold+red ONE run of an EXISTING paragraph, re-emit it in place,
        // keep every other paragraph byte-identical.
        let mut doc = parse_semantic(&showcase()).unwrap();
        let orig_section = {
            let pkg = Package::open(&showcase()).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // doc.char_shapes[0] == default (reserved by parse); add bold+red at index 1.
        doc.char_shapes.push(CharShape {
            bold: true,
            text_color: Color::from_hex("#C00000").unwrap(),
            ..Default::default()
        });
        let red_bold = 1usize;

        // Pick a SIMPLE multi-run paragraph and capture an UNEDITED one's exact bytes.
        let sec = doc.sections.get_mut(0).unwrap();
        let mut unedited_bytes: Option<String> = None;
        let mut edited = false;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else {
                    continue;
                };
                if !src.simple {
                    continue;
                }
                if !edited && p.runs.len() >= 2 {
                    p.runs[0].char_shape = red_bold; // re-format the first run
                    p.dirty.mark();
                    edited = true;
                } else if unedited_bytes.is_none() {
                    unedited_bytes = Some(orig_section[src.span.0..src.span.1].to_string());
                }
            }
        }
        assert!(edited, "found a simple multi-run paragraph to edit");
        let untouched = unedited_bytes.expect("captured an unedited paragraph's bytes");
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        let new_section =
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();

        // A bold+red charPr was synthesized; the edited run references it.
        assert!(
            header.contains("<hh:bold/>") && header.contains(r##"textColor="#C00000""##),
            "bold+red charPr synthesized"
        );
        // The UNEDITED paragraph's bytes survive verbatim (relocated but byte-identical).
        assert!(
            new_section.contains(&untouched),
            "unedited paragraph is byte-preserved"
        );
        // Round-trips + text preserved + opens.
        let doc2 = parse_semantic(&out).unwrap();
        assert!(
            doc2.plain_text().contains("이 문서는") && doc2.plain_text().contains("표와 셀 병합"),
            "text preserved"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
        // emit an artifact for oracle + visual cross-check (harmless side effect).
        let _ = std::fs::write(std::env::temp_dir().join("inplace-edit.hwpx"), &out);
    }

    /// P0 safety: an edited paragraph carrying `Inline::Raw` (a verbatim-preserved shape/chart/OLE/
    /// textbox) must NEVER be silently dropped by the in-place re-emit. `reemit_paragraph` keeps
    /// only `Inline::Text`, so the re-emit decision guards on Raw directly and routes a Raw-bearing
    /// paragraph through the open-tag-only path — keeping its body bytes (where the Raw object
    /// lives) verbatim. We model the Raw as carrying the paragraph's own original body bytes (its
    /// real provenance) and assert those survive the round-trip, even though `source.simple` is
    /// left `true` so the guard — not the parse-time `simple` proxy — is what saves the object.
    #[test]
    fn raw_bearing_edited_paragraph_is_preserved_not_dropped() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let orig_section = {
            let pkg = Package::open(&showcase()).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };

        // Find a simple, in-place-editable paragraph, capture its ORIGINAL body bytes, and replace
        // its AST runs with a single `Inline::Raw` carrying exactly those bytes — the faithful
        // shape of a Raw object that lives in the source span. `source.simple` stays true on
        // purpose: without the guard, `reemit_paragraph` would run and drop the Raw silently.
        let sec = doc.sections.get_mut(0).unwrap();
        let mut raw_body: Option<String> = None;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.as_ref() else {
                    continue;
                };
                if !src.simple || p.runs.is_empty() {
                    continue;
                }
                let para = &orig_section[src.span.0..src.span.1];
                let body = &para[para.find('>').unwrap() + 1..];
                raw_body = Some(body.to_string());
                p.runs = vec![Run {
                    char_shape: 0,
                    char_ref: None,
                    content: vec![Inline::Raw(RawPart {
                        tag: "hp:run".into(),
                        bytes: body.as_bytes().to_vec(),
                    })],
                }];
                p.dirty.mark();
                break;
            }
        }
        let raw_body = raw_body.expect("found a simple paragraph to carry an Inline::Raw");
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let new_section = {
            let pkg = Package::open(&out).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // The Raw object's bytes survive verbatim — they were NOT silently dropped on re-emit.
        assert!(
            new_section.contains(&raw_body),
            "Inline::Raw object preserved verbatim, not dropped"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    /// Phase 3: SetParaPr re-points a paragraph at a synthesized paraPr; the kept-verbatim open
    /// tag gets its `paraPrIDRef` patched, an unedited sibling stays byte-identical, and a
    /// runs-only (SetCharPr-style) edit keeps its open tag byte-verbatim (no spurious rewrite).
    #[test]
    fn setparapr_in_place_patches_parapridref_and_preserves_others() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let orig_section = {
            let pkg = Package::open(&showcase()).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // Index 0 reserved (default); add a center-align paraPr (parser interns original pool
        // paraShapes at indices ≥1, so the pushed one is at the tail).
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Center,
            ..Default::default()
        });
        let center = doc.para_shapes.len() - 1;

        let sec = doc.sections.get_mut(0).unwrap();
        let mut runsonly_open: Option<(String, (usize, usize))> = None;
        let mut unedited_bytes: Option<String> = None;
        let mut para_edited = false;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else {
                    continue;
                };
                if !src.simple {
                    continue;
                }
                if !para_edited {
                    p.para_shape = center; // SetParaPr → center align
                    p.dirty.mark();
                    para_edited = true;
                } else if runsonly_open.is_none() && !p.runs.is_empty() {
                    // A second simple para edited runs-only: its open tag must stay verbatim.
                    let open_end = orig_section[src.span.0..src.span.1].find('>').unwrap() + 1;
                    runsonly_open = Some((
                        orig_section[src.span.0..src.span.0 + open_end].to_string(),
                        src.span,
                    ));
                    p.dirty.mark(); // runs-only "edit": para_shape stays 0, style_name None
                } else if unedited_bytes.is_none() {
                    unedited_bytes = Some(orig_section[src.span.0..src.span.1].to_string());
                }
            }
        }
        assert!(para_edited, "found a simple paragraph to re-shape");
        let (runsonly_open_tag, _) = runsonly_open.expect("a runs-only edited paragraph");
        let untouched = unedited_bytes.expect("an unedited paragraph");
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let new_section = {
            let pkg = Package::open(&out).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // The unedited paragraph survives byte-verbatim.
        assert!(
            new_section.contains(&untouched),
            "unedited paragraph byte-preserved"
        );
        // The runs-only paragraph's open tag is unchanged (no spurious paraPrIDRef rewrite).
        assert!(
            new_section.contains(&runsonly_open_tag),
            "runs-only edit keeps its open tag verbatim"
        );

        // Parse-in (P1): the re-shaped paragraph now resolves to a center-align paraPr in the pool.
        let doc2 = parse_semantic(&out).unwrap();
        let found_center = doc2.sections[0].blocks.iter().any(|b| match b {
            Block::Paragraph(p) => p
                .source
                .as_ref()
                .and_then(|s| s.para_pr.as_deref())
                .and_then(|r| r.trim().parse::<u64>().ok())
                .and_then(|id| doc2.header_pools.para.get(&id))
                .map(|ps| ps.align == HorizontalAlign::Center)
                .unwrap_or(false),
            _ => false,
        });
        assert!(
            found_center,
            "edited paragraph resolves to a center-align paraPr"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
        let _ = std::fs::write(std::env::temp_dir().join("setparapr-inplace.hwpx"), &out);
    }

    /// Phase 6: SetParaPr on a STRUCTURAL (non-simple) paragraph patches only its open tag — the
    /// secPr/ctrl body is preserved byte-verbatim. This is the safe non-simple editing path.
    #[test]
    fn setparapr_on_nonsimple_keeps_body_verbatim() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let orig_section = {
            let pkg = Package::open(&showcase()).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Center,
            ..Default::default()
        });
        // Parser interns original pool paraShapes at indices ≥1; the pushed one is at the tail.
        let center = doc.para_shapes.len() - 1;

        // Capture a non-simple paragraph's original body bytes (everything after its open tag).
        let sec = doc.sections.get_mut(0).unwrap();
        let mut body: Option<String> = None;
        let mut open_tag: Option<String> = None;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else {
                    continue;
                };
                if src.simple {
                    continue;
                }
                let full = &orig_section[src.span.0..src.span.1];
                let oe = full.find('>').unwrap() + 1;
                open_tag = Some(full[..oe].to_string());
                body = Some(full[oe..].to_string()); // <hp:run>…secPr…</hp:run>…</hp:p>
                p.para_shape = center; // SetParaPr on a structural paragraph
                p.dirty.mark();
                break;
            }
        }
        let body = body.expect("a non-simple paragraph (secPr/ctrl/tbl)");
        let open_tag = open_tag.unwrap();
        assert!(
            body.contains("<hp:secPr") || body.contains("<hp:tbl") || body.contains("<hp:ctrl"),
            "captured a structural body"
        );
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let new_section = {
            let pkg = Package::open(&out).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // The structural BODY survives byte-verbatim; only the open tag's paraPrIDRef changed.
        assert!(
            new_section.contains(&body),
            "structural body bytes preserved verbatim"
        );
        assert!(
            !new_section.contains(&open_tag),
            "the open tag's paraPrIDRef was patched (differs)"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
        let _ = std::fs::write(std::env::temp_dir().join("setparapr-nonsimple.hwpx"), &out);
    }

    /// Phase 3: ApplyStyle re-points a paragraph at a named style; the open tag's `styleIDRef`
    /// (and the style's `paraPrIDRef`) are patched to the resolved pool entry.
    #[test]
    fn applystyle_in_place_patches_styleidref() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let header = {
            let pkg = Package::open(&showcase()).unwrap();
            String::from_utf8(pkg.read_header().unwrap()).unwrap()
        };
        let style = synth::parse_styles(&header);
        let target = style
            .get("개요 1")
            .expect("showcase has a '개요 1' style")
            .clone();

        let sec = doc.sections.get_mut(0).unwrap();
        let mut edited = false;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else {
                    continue;
                };
                if src.simple && !edited {
                    p.style_name = Some("개요 1".into());
                    p.dirty.mark();
                    edited = true;
                }
            }
        }
        assert!(edited, "found a simple paragraph to restyle");
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        // Some edited paragraph now carries styleIDRef == 개요 1's id (and its paraPrIDRef).
        let restyled = doc2.sections[0].blocks.iter().any(|b| match b {
            Block::Paragraph(p) => p
                .source
                .as_ref()
                .map(|s| {
                    s.style.as_deref() == Some(target.id.as_str())
                        && s.para_pr.as_deref() == Some(target.para_pr.as_str())
                })
                .unwrap_or(false),
            _ => false,
        });
        assert!(
            restyled,
            "edited paragraph references the 개요 1 style + its paraPr"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn dedups_synthesized_charpr_against_existing_pool() {
        // FormattingShowcase has charPr id=7 = bold + textColor #1F4E79 (cloned from default id=0).
        // Requesting that exact shape must REUSE id=7, not append a duplicate (#003).
        let mut doc = parse_semantic(&showcase()).unwrap();
        let before = {
            let p = Package::open(&showcase()).unwrap();
            let h = String::from_utf8(p.read_header().unwrap()).unwrap();
            super::synth::max_pool_id(&h, "charProperties")
        };
        doc.char_shapes.push(CharShape {
            bold: true,
            text_color: Color::from_hex("#1F4E79").unwrap(),
            ..Default::default()
        });
        // The HWPX parser now interns the ORIGINAL pool shapes (indices ≥1), so the freshly-pushed
        // shape lands at the tail, not index 1.
        let reuse_idx = doc.char_shapes.len() - 1;
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: reuse_idx,
                content: vec![Inline::Text("기존 글자모양 재사용".into())],
                ..Default::default()
            }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        let after = super::synth::max_pool_id(&header, "charProperties");
        assert_eq!(before, after, "no new charPr appended — existing id reused");
        // the appended run references the existing id 7
        let xml = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        let p = xml.rfind("기존 글자모양 재사용").unwrap();
        let run_start = xml[..p].rfind("<hp:run ").unwrap();
        let run_tag = &xml[run_start..xml[run_start..].find('>').unwrap() + run_start];
        assert!(
            run_tag.contains(r#"charPrIDRef="7""#),
            "reused existing charPr 7: {run_tag}"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn applies_named_style_and_outline_level() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("개요 1 제목".into())],
                ..Default::default()
            }],
            style_name: Some("개요 1".into()),
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let xml = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        // 개요 1 = style id 2, paraPr 10 (from the showcase styles pool)
        let p = xml.rfind("개요 1 제목").unwrap();
        let tag_start = xml[..p].rfind("<hp:p ").unwrap();
        let tag = &xml[tag_start..xml[tag_start..].find('>').unwrap() + tag_start];
        assert!(
            tag.contains(r#"styleIDRef="2""#),
            "styleIDRef resolved to 개요 1: {tag}"
        );
        assert!(
            tag.contains(r#"paraPrIDRef="10""#),
            "adopts the style's paraPr: {tag}"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn default_shape_does_not_synthesize() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        doc.char_shapes.push(CharShape::default()); // index 0, no formatting
        let before = {
            let pkg = Package::open(&showcase()).unwrap();
            let h = String::from_utf8(pkg.read_header().unwrap()).unwrap();
            super::synth::max_pool_id(&h, "charProperties")
        };
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("기본 문단".into())],
                ..Default::default()
            }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let after = super::synth::max_pool_id(
            &String::from_utf8(pkg.read_header().unwrap()).unwrap(),
            "charProperties",
        );
        assert_eq!(
            before, after,
            "default shape must NOT synthesize a new charPr"
        );
    }

    #[test]
    fn roundtrip_noedit_reopens_with_same_text() {
        let doc = parse_semantic(&sample()).unwrap();
        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        assert_eq!(doc.plain_text(), doc2.plain_text());
        assert!(
            crate::export::validate_open_safety(&out).ok,
            "safety gate must pass on our output"
        );
    }

    #[test]
    fn append_paragraph_survives_roundtrip_and_keeps_original() {
        let mut doc = parse_semantic(&sample()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("추가된 문단".into())],
                ..Default::default()
            }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        assert!(
            doc2.plain_text().contains("추가된 문단"),
            "appended paragraph must survive"
        );
        assert!(
            doc2.plain_text().contains("안녕하세요"),
            "original content must be preserved"
        );
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn append_table_emits_native_tbl_and_survives_roundtrip() {
        // Build a 2×2 grid table (header + 1 body row) directly in the AST.
        let cell = |row, col, text: &str, bold: bool| Cell {
            row,
            col,
            blocks: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: if bold { 1 } else { 0 },
                    content: vec![Inline::Text(text.into())],
                    ..Default::default()
                }],
                dirty: Dirty(true),
                ..Default::default()
            })],
            dirty: Dirty(true),
            ..Default::default()
        };
        let mut doc = parse_semantic(&sample()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Table(Table {
            rows: 2,
            cols: 2,
            cells: vec![
                cell(0, 0, "구분", true),
                cell(0, 1, "내용", true),
                cell(1, 0, "1", false),
                cell(1, 1, "승인", false),
            ],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        let text = doc2.plain_text();
        assert!(
            text.contains("구분") && text.contains("승인"),
            "table cells must survive: {text}"
        );
        assert!(text.contains("안녕하세요"), "original content preserved");
        assert!(
            crate::export::validate_open_safety(&out).ok,
            "open-safety gate must pass"
        );
        // round-trip must yield a real Table block (not flattened to text paragraphs)
        let has_table = doc2.sections.iter().any(|s| {
            s.blocks
                .iter()
                .any(|b| matches!(b, Block::Table(t) if t.cols >= 2 && t.rows >= 2))
        });
        assert!(has_table, "round-trip must yield a native Table block");
    }

    // ── FROM-SCRATCH (HWP5→HWPX converter) ────────────────────────────────────────────────────

    #[test]
    fn from_scratch_single_section_synthesizes_openable_hwpx() {
        // A doc with NO original HWPX provenance — exactly what lifting a binary .hwp produces.
        // Before this path, serialize() errored "no original HWPX provenance (parse an HWPX first)".
        let mut doc = SemanticDoc::default();
        let mut sec = Section::default();
        for t in ["첫째 문단입니다.", "둘째 문단입니다."] {
            sec.blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text(t.into())],
                    ..Default::default()
                }],
                ..Default::default()
            }));
        }
        doc.sections.push(sec);
        assert!(
            doc.passthrough.parts.is_empty(),
            "precondition: no HWPX provenance"
        );

        let out = serialize(&doc)
            .expect("from-scratch serialize must succeed without original provenance");
        // A valid, openable HWPX (the synthesis path's correctness gate).
        assert!(
            crate::export::validate_open_safety(&out).ok,
            "from-scratch output must be open-safe"
        );
        // …that round-trips the text. (The Skeleton's secPr-carrier stub adds one leading empty
        // paragraph; the lifted text follows it in order.)
        let doc2 = parse_semantic(&out).unwrap();
        let text = doc2.plain_text();
        assert!(
            text.contains("첫째 문단입니다."),
            "first paragraph survives: {text}"
        );
        assert!(
            text.contains("둘째 문단입니다."),
            "second paragraph survives: {text}"
        );
        // serialize_from_scratch clones — the caller's doc is untouched (no provenance, no dirty).
        assert!(
            doc.passthrough.parts.is_empty(),
            "input doc must not be mutated"
        );
        assert!(
            !doc.sections[0].dirty.is_dirty(),
            "input doc must not be dirtied"
        );
    }

    #[test]
    fn from_scratch_header_splices_after_secpr() {
        let mut doc = SemanticDoc::default();
        let mut sec = Section::default();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("본문".into())],
                ..Default::default()
            }],
            ..Default::default()
        }));
        sec.decorations.push(PageDecoration {
            kind: DecoKind::Header,
            apply: ApplyPage::Both,
            blocks: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text("머리말텍스트".into())],
                    ..Default::default()
                }],
                ..Default::default()
            })],
        });
        doc.sections.push(sec);

        let out = serialize(&doc).expect("header doc serializes");
        assert!(
            crate::export::validate_synthesis_safety(&out).ok,
            "header output open-safe"
        );
        let pkg = Package::open(&out).unwrap();
        let sec0 = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        // The header ctrl is spliced AFTER </hp:secPr> (the secPr-carrier run) + carries its body.
        let secpr = sec0.find("</hp:secPr>").expect("secPr present");
        let header = sec0.find(r#"<hp:header id"#).expect("header present");
        assert!(header > secpr, "header spliced after secPr");
        assert!(
            sec0.contains(r#"applyPageType="BOTH""#) && sec0.contains("머리말텍스트"),
            "header body text emitted"
        );
    }

    #[test]
    fn from_scratch_endnote_emits_ctrl_with_body() {
        // An endnote: an inline marker in a run whose body (a paragraph) is recursed into a subList.
        let mut doc = SemanticDoc::default();
        let mut sec = Section::default();
        let note = NoteRef {
            kind: NoteKind::End,
            number: 1,
            prefix_char: 0,
            suffix_char: 41,
            inst_id: 7,
            body: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text("미주 본문".into())],
                    ..Default::default()
                }],
                ..Default::default()
            })],
        };
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("본문".into()), Inline::Note(note)],
                ..Default::default()
            }],
            ..Default::default()
        }));
        doc.sections.push(sec);

        let out = serialize(&doc).expect("endnote doc serializes");
        assert!(
            crate::export::validate_synthesis_safety(&out).ok,
            "endnote output open-safe"
        );
        let pkg = Package::open(&out).unwrap();
        let sec0 = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        assert!(
            sec0.contains(r#"<hp:endNote number="1""#),
            "endNote ctrl emitted"
        );
        assert!(sec0.contains("<hp:subList"), "note body subList emitted");
        // Both the referencing text and the note body text are present.
        let re = parse_semantic(&out).unwrap();
        let text = re.plain_text();
        assert!(
            text.contains("본문") && text.contains("미주 본문"),
            "ref + note body text: {text}"
        );
    }

    #[test]
    fn from_scratch_multi_section_emits_all_sections_and_spine() {
        // v2: a multi-section from-scratch doc emits Contents/section0.xml + section1.xml, both
        // registered in content.hpf (manifest + spine), and stays open-safe.
        let mut doc = SemanticDoc::default();
        for t in ["첫 구역 본문.", "둘째 구역 본문."] {
            let mut sec = Section::default();
            sec.blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text(t.into())],
                    ..Default::default()
                }],
                ..Default::default()
            }));
            doc.sections.push(sec);
        }
        let out = serialize(&doc).expect("multi-section from-scratch must serialize");
        assert!(
            crate::export::validate_synthesis_safety(&out).ok,
            "multi-section output open-safe"
        );

        let pkg = Package::open(&out).unwrap();
        let secs = pkg.section_part_names();
        assert!(
            secs.iter().any(|n| n.ends_with("section0.xml")),
            "section0 present: {secs:?}"
        );
        assert!(
            secs.iter().any(|n| n.ends_with("section1.xml")),
            "section1 appended: {secs:?}"
        );
        let hpf = String::from_utf8(pkg.read_part("Contents/content.hpf").unwrap()).unwrap();
        assert!(
            hpf.contains(r#"href="Contents/section1.xml""#),
            "section1 in manifest"
        );
        assert!(hpf.contains(r#"idref="section1""#), "section1 in spine");

        // Both sections' text round-trips.
        let re = parse_semantic(&out).unwrap();
        let text = re.plain_text();
        assert!(
            text.contains("첫 구역 본문.") && text.contains("둘째 구역 본문."),
            "both sections: {text}"
        );
    }
}
