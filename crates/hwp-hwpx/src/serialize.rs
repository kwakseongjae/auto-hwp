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
    /// cell shade `#RRGGBB` → synthesized `borderFillIDRef` (shaded+bordered cell fill).
    shade_ref: BTreeMap<String, String>,
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
    if doc.passthrough.parts.iter().all(|p| p.tag != SOURCE_PART_TAG) {
        return serialize_from_scratch(doc);
    }
    let src = doc
        .passthrough
        .parts
        .iter()
        .find(|p| p.tag == SOURCE_PART_TAG)
        .ok_or_else(|| Error::Serialize("no original HWPX provenance (parse an HWPX first)".into()))?;

    let pkg = Package::open(&src.bytes)?;
    let section_names = pkg.section_part_names();
    let header_name = pkg
        .part_names
        .iter()
        .find(|n| n.to_ascii_lowercase().ends_with("header.xml"))
        .cloned();
    let header_xml = pkg.read_header().map(|b| String::from_utf8_lossy(&b).into_owned());

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
    let content_hpf_name =
        names.iter().find(|n| n.to_ascii_lowercase().ends_with("content.hpf")).cloned();

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
            out.start_file(name, deflate).map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(patched.as_bytes()).map_err(|e| Error::Io(e.to_string()))?;
        } else if is_content_hpf {
            // PASS 2c — register the appended section/image parts in the package manifest + spine.
            let orig = pkg.read_part(name).unwrap_or_default();
            let patched = patch_content_hpf(
                &String::from_utf8_lossy(&orig),
                &new_section_items,
                &image_items,
            );
            out.start_file(name, deflate).map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(patched.as_bytes()).map_err(|e| Error::Io(e.to_string()))?;
        } else if let Some(sec) = dirty_section {
            // PASS 2b — patch the section: append dirty blocks, referencing synthesized shapes.
            let orig = sec.provenance.raw.as_deref().unwrap_or(b"");
            let patched = patch_section_xml(orig, sec, table_ref.as_deref(), &plan);
            out.start_file(name, deflate).map_err(|e| Error::Serialize(e.to_string()))?;
            out.write_all(&patched).map_err(|e| Error::Io(e.to_string()))?;
        } else {
            // Verbatim copy: preserves compression, metadata, order (and STORED mimetype).
            let raw = zin.by_index_raw(i).map_err(|e| Error::Serialize(e.to_string()))?;
            out.raw_copy_file(raw).map_err(|e| Error::Serialize(e.to_string()))?;
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
            out.write_all(&patched).map_err(|e| Error::Io(e.to_string()))?;
        }
    }
    for img in &image_items {
        if let Some(bytes) = doc.bin_data.iter().find(|b| b.bin_ref == img.bin_ref).map(|b| &b.bytes) {
            out.start_file(&img.href, deflate).map_err(|e| Error::Serialize(e.to_string()))?;
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
const SKELETON: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/Skeleton.hwpx"));

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
                            if let Inline::Image(im) = inl {
                                used.insert(im.bin_ref.clone());
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
            for cell in &mut t.cells {
                cell.dirty.mark();
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
    fn walk(blocks: &[Block], chars: &mut IdxSet, paras: &mut IdxSet) {
        for b in blocks {
            match b {
                Block::Paragraph(p) if p.dirty.is_dirty() => {
                    chars.extend(p.runs.iter().map(|r| r.char_shape));
                    paras.insert(p.para_shape);
                }
                Block::Table(t) if t.dirty.is_dirty() || t.cells.iter().any(|c| c.dirty.is_dirty()) => {
                    for c in &t.cells {
                        walk(&c.blocks, chars, paras);
                    }
                }
                _ => {}
            }
        }
    }
    for sec in doc.sections.iter().filter(|s| s.dirty.is_dirty()) {
        walk(&sec.blocks, chars, paras);
    }
}

/// PASS 1: synthesize every header pool entry the dirty content needs (fonts → charPr → paraPr →
/// cell-shade borderFills), returning the fully-patched header.xml + the index→IDRef maps. All
/// header mutation happens here so the patches compose on one header string.
fn build_synth_plan(doc: &SemanticDoc, header_xml: Option<&str>, table_ref: Option<&str>) -> SynthPlan {
    let mut plan = SynthPlan::default();
    let Some(header0) = header_xml else { return plan };

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

    // Cell-shade borderFills: clone the table's bordered fill + add a fillBrush per distinct shade.
    let mut shade_fragments = String::new();
    let mut shade_count = 0;
    let shades = collect_shade_colors(doc);
    if !shades.is_empty() {
        if let Some(base) = table_ref.and_then(|id| synth::border_fill_by_id(header0, id)) {
            let mut next_id = synth::max_pool_id(header0, "borderFills") + 1;
            for hex in shades {
                if let Some(color) = hwp_model::types::Color::from_hex(&hex) {
                    shade_fragments.push_str(&synth::synthesize_border_fill(&base, next_id, color));
                    plan.shade_ref.insert(hex, next_id.to_string());
                    shade_count += 1;
                    next_id += 1;
                }
            }
        }
    }
    header = synth::patch_pool(&header, "borderFills", &shade_fragments, shade_count);

    if char_count > 0 || para_count > 0 || shade_count > 0 {
        plan.header_out = Some(header);
    }
    plan
}

/// Distinct cell shade colors (as `#RRGGBB`) used by dirty tables.
fn collect_shade_colors(doc: &SemanticDoc) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for sec in doc.sections.iter().filter(|s| s.dirty.is_dirty()) {
        for b in &sec.blocks {
            if let Block::Table(t) = b {
                if t.dirty.is_dirty() || t.cells.iter().any(|c| c.dirty.is_dirty()) {
                    for c in t.cells.iter().filter(|c| c.active) {
                        if let Some(col) = c.shade_color {
                            out.insert(col.to_hex());
                        }
                    }
                }
            }
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
fn patch_section_xml(orig: &[u8], sec: &Section, table_ref: Option<&str>, plan: &SynthPlan) -> Vec<u8> {
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
                let xml = if src.simple {
                    reemit_paragraph(orig, p, plan)
                } else {
                    reemit_paragraph_open_only(orig, p, plan)
                };
                Some((src.span.0, src.span.1, xml))
            }
            _ => None,
        })
        .collect();
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
    let dirty: Vec<EmitBlock> = sec.blocks.iter().filter_map(dirty_emit).collect();
    if dirty.is_empty() {
        // Edits / page already applied (or nothing changed) — no append needed.
        return s.into_bytes();
    }

    let base_para_ref = last_attr(&s, "paraPrIDRef").unwrap_or("0").to_string();
    let plain_ref = last_attr(&s, "charPrIDRef").unwrap_or("0").to_string();
    let base_para_ref: &str = &base_para_ref;
    let plain_ref_owned = plain_ref.clone();
    // Resolve a run's interned char_shape index → charPrIDRef (synthesized id, or the plain ref).
    let cref = |idx: usize| plan.char_ref.get(&idx).cloned().unwrap_or_else(|| plain_ref_owned.clone());
    let mut next_id = max_id(&s) + 1;

    let mut inject = String::new();
    for block in &dirty {
        match block {
            EmitBlock::Para { para_shape, style, runs } => {
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
                let char_fallback =
                    style_ref.map(|s| s.char_pr.clone()).unwrap_or_else(|| plain_ref.to_string());
                let resolved: Vec<(String, String)> = runs
                    .iter()
                    .map(|(t, idx)| {
                        (t.clone(), plan.char_ref.get(idx).cloned().unwrap_or_else(|| char_fallback.clone()))
                    })
                    .collect();
                emit_paragraph(&mut inject, next_id, &para_ref, style_id, &resolved);
                next_id += 1;
            }
            EmitBlock::Table { rows, cols, cells } => {
                // A table lives inside a wrapping <hp:p><hp:run>…</hp:run></hp:p>.
                let pid = next_id;
                let tid = next_id + 1;
                next_id += 2;
                let bf = table_ref.unwrap_or("1");
                inject.push_str(&format!(
                    "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{plain_ref}\">"
                ));
                emit_table(&mut inject, tid, *rows, *cols, cells, base_para_ref, &plain_ref, &cref, bf, &plan.shade_ref, &mut next_id);
                inject.push_str("<hp:t></hp:t></hp:run></hp:p>");
            }
            EmitBlock::Image { bin_ref, width, height } => {
                let pid = next_id;
                let picid = next_id + 1;
                next_id += 2;
                emit_pic(&mut inject, pid, picid, bin_ref, *width, *height, base_para_ref, &plain_ref);
            }
            EmitBlock::Equation(eq) => {
                let pid = next_id;
                let eqid = next_id + 1;
                next_id += 2;
                emit_equation(&mut inject, pid, eqid, eq, base_para_ref, &plain_ref);
            }
        }
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

/// Re-emit an EDITED simple paragraph in place: keep its original `<hp:p …>` open tag verbatim
/// (preserves id/paraPrIDRef/styleIDRef/pageBreak/… attrs), and rebuild the run content from the
/// AST. Each run references a synthesized charPr if it was re-formatted (`char_shape` interned),
/// else its original `charPrIDRef`. Simple paragraphs have no `<hp:linesegarray>` to preserve.
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

/// A placed table cell ready to emit (origin position + span + content + optional shade hex).
/// `content` holds the cell's FULL block sequence — paragraphs AND nested tables, recursively — so
/// multi-paragraph cells and tables-within-cells (both common in real .hwp) survive in full.
struct PlacedCell {
    row: usize,
    col: usize,
    col_span: usize,
    row_span: usize,
    content: Vec<EmitBlock>,
    shade: Option<String>,
}

/// A dirty block ready to serialize: a paragraph, a table, or an embedded image.
enum EmitBlock {
    Para { para_shape: usize, style: Option<String>, runs: Vec<(String, usize)> },
    Table { rows: usize, cols: usize, cells: Vec<PlacedCell> },
    /// An image, emitted as a `<hp:pic>` wrapped in its own paragraph. `bin_ref` is the manifest
    /// item id + `binaryItemIDRef`; width/height are the display size in HWPUNIT.
    Image { bin_ref: String, width: i32, height: i32 },
    /// A 수식, emitted as `<hp:equation>` wrapped in its own paragraph (the script is verbatim).
    Equation(EquationRef),
}

/// Project a dirty *APPENDED* `Block` to its `EmitBlock` (None if untouched OR if it is an
/// in-place-edited existing paragraph — those carry `source` and are replaced surgically, not appended).
fn dirty_emit(b: &Block) -> Option<EmitBlock> {
    match b {
        Block::Paragraph(p) if p.dirty.is_dirty() && p.source.is_none() => Some(project_block(b)),
        Block::Table(t) if t.dirty.is_dirty() || t.cells.iter().any(|c| c.dirty.is_dirty()) => {
            Some(project_block(b))
        }
        _ => None,
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
            if p.runs.iter().flat_map(|r| &r.content).any(|i| matches!(i, Inline::Image(_))) =>
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
            EmitBlock::Image { bin_ref: im.bin_ref.clone(), width: im.width, height: im.height }
        }
        // An equation-bearing paragraph → EmitBlock::Equation (also before the text path).
        Block::Paragraph(p)
            if p.runs.iter().flat_map(|r| &r.content).any(|i| matches!(i, Inline::Equation(_))) =>
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
        },
        Block::Table(t) => EmitBlock::Table {
            rows: t.rows.max(1),
            cols: t.cols.max(1),
            cells: placed_cells(t),
        },
    }
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
            content: cell.blocks.iter().map(project_block).collect(),
            shade: cell.shade_color.map(|c| c.to_hex()),
        })
        .collect()
}

/// A paragraph's runs as (text, char_shape index).
fn para_runs(p: &Paragraph) -> Vec<(String, usize)> {
    p.runs
        .iter()
        .map(|r| {
            let text: String = r
                .content
                .iter()
                .filter_map(|inl| match inl {
                    Inline::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect();
            (text, r.char_shape)
        })
        .collect()
}

/// Emit a sequence of cell blocks (paragraphs + nested tables, recursively) inside an open
/// `<hp:subList>`. `next_id` is a monotonic counter giving every `<hp:p>`/`<hp:tbl>` a unique id.
/// An empty cell gets one empty paragraph (a subList requires ≥1 `<hp:p>`).
#[allow(clippy::too_many_arguments)]
fn emit_cell_content(
    out: &mut String,
    blocks: &[EmitBlock],
    base_para_ref: &str,
    plain_ref: &str,
    cref: &dyn Fn(usize) -> String,
    bf: &str,
    shade_ref: &BTreeMap<String, String>,
    next_id: &mut u64,
) {
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
            EmitBlock::Para { runs, .. } => {
                let pid = *next_id;
                *next_id += 1;
                out.push_str(&format!(
                    "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\">"
                ));
                if runs.is_empty() {
                    out.push_str("<hp:run charPrIDRef=\"0\"><hp:t></hp:t></hp:run>");
                }
                for (text, cs) in runs {
                    out.push_str(&format!(
                        "<hp:run charPrIDRef=\"{}\"><hp:t>{}</hp:t></hp:run>",
                        cref(*cs),
                        xml_escape(text)
                    ));
                }
                out.push_str("</hp:p>");
            }
            EmitBlock::Table { rows, cols, cells } => {
                // A nested table lives inside a wrapping <hp:p><hp:run>…</hp:run></hp:p>.
                let pid = *next_id;
                let tid = *next_id + 1;
                *next_id += 2;
                out.push_str(&format!(
                    "<hp:p id=\"{pid}\" paraPrIDRef=\"{base_para_ref}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{plain_ref}\">"
                ));
                emit_table(out, tid, *rows, *cols, cells, base_para_ref, plain_ref, cref, bf, shade_ref, next_id);
                out.push_str("<hp:t></hp:t></hp:run></hp:p>");
            }
            EmitBlock::Image { bin_ref, width, height } => {
                let pid = *next_id;
                let picid = *next_id + 1;
                *next_id += 2;
                emit_pic(out, pid, picid, bin_ref, *width, *height, base_para_ref, plain_ref);
            }
            EmitBlock::Equation(eq) => {
                let pid = *next_id;
                let eqid = *next_id + 1;
                *next_id += 2;
                emit_equation(out, pid, eqid, eq, base_para_ref, plain_ref);
            }
        }
    }
}

/// Emit an embedded image as an inline (`treatAsChar`) `<hp:pic>` wrapped in its own `<hp:p>`. The
/// `<hc:img binaryItemIDRef="{bin_ref}">` links to the manifest `<opf:item id="{bin_ref}">` whose
/// href is the `BinData/{bin_ref}.{kind}` part. orgSz=curSz=display size with identity scale, so the
/// image renders at its stored display size; crop/wrap/anchor/rotation are v2.1+.
#[allow(clippy::too_many_arguments)]
fn emit_pic(out: &mut String, pid: u64, picid: u64, bin_ref: &str, w: i32, h: i32, base_para_ref: &str, plain_ref: &str) {
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
fn emit_equation(out: &mut String, pid: u64, eqid: u64, eq: &EquationRef, base_para_ref: &str, plain_ref: &str) {
    let w = eq.width.max(1);
    let h = eq.height.max(1);
    let font = if eq.font.is_empty() { "HYhwpEQ" } else { eq.font.as_str() };
    let version = if eq.version.is_empty() { "Equation Version 60" } else { eq.version.as_str() };
    let base_unit = if eq.base_unit == 0 { 1000 } else { eq.base_unit };
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

/// Emit one `<hp:p>` with a resolved `styleIDRef` + per-run charPrIDRef strings (linesegarray
/// omitted — Hancom recomputes layout on open).
fn emit_paragraph(out: &mut String, id: u64, para_ref: &str, style_ref: &str, runs: &[(String, String)]) {
    out.push_str(&format!(
        "<hp:p id=\"{id}\" paraPrIDRef=\"{para_ref}\" styleIDRef=\"{style_ref}\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\">"
    ));
    if runs.is_empty() {
        out.push_str("<hp:run charPrIDRef=\"0\"><hp:t></hp:t></hp:run>");
    }
    for (text, cref) in runs {
        out.push_str(&format!(
            "<hp:run charPrIDRef=\"{cref}\"><hp:t>{}</hp:t></hp:run>",
            xml_escape(text)
        ));
    }
    out.push_str("</hp:p>");
}

/// Emit a native `<hp:tbl>` honoring cell merge (colSpan/rowSpan) + per-cell shade. Covered
/// positions are omitted and fully-covered `<hp:tr>` are suppressed (Hancom's convention).
/// Geometry is synthetic — columns sum to the standard text width (42520 HWPUNIT); Hancom
/// re-lays-out on open.
#[allow(clippy::too_many_arguments)]
fn emit_table(
    out: &mut String,
    tid: u64,
    rows: usize,
    cols: usize,
    cells: &[PlacedCell],
    para_ref: &str,
    plain_ref: &str,
    cref: &dyn Fn(usize) -> String,
    bf: &str,
    shade_ref: &BTreeMap<String, String>,
    next_id: &mut u64,
) {
    const W: u64 = 42520; // standard A4 text width in HWPUNIT
    const RH: u64 = 2200; // ~7.7mm per row
    let col_w = W / cols as u64;
    let col_w_at = |c: usize| if c + 1 == cols { W - col_w * (cols as u64 - 1) } else { col_w };
    let span_w = |c: usize, n: usize| (c..(c + n).min(cols)).map(col_w_at).sum::<u64>();
    let height = RH * rows as u64;
    out.push_str(&format!(
        "<hp:tbl id=\"{tid}\" zOrder=\"0\" numberingType=\"TABLE\" textWrap=\"TOP_AND_BOTTOM\" textFlow=\"BOTH_SIDES\" lock=\"0\" dropcapstyle=\"None\" pageBreak=\"CELL\" repeatHeader=\"1\" rowCnt=\"{rows}\" colCnt=\"{cols}\" cellSpacing=\"0\" borderFillIDRef=\"{bf}\" noAdjust=\"0\">\
<hp:sz width=\"{W}\" widthRelTo=\"ABSOLUTE\" height=\"{height}\" heightRelTo=\"ABSOLUTE\" protect=\"0\"/>\
<hp:pos treatAsChar=\"1\" affectLSpacing=\"0\" flowWithText=\"1\" allowOverlap=\"0\" holdAnchorAndSO=\"0\" vertRelTo=\"PARA\" horzRelTo=\"COLUMN\" vertAlign=\"TOP\" horzAlign=\"LEFT\" vertOffset=\"0\" horzOffset=\"0\"/>\
<hp:outMargin left=\"283\" right=\"283\" top=\"283\" bottom=\"283\"/>\
<hp:inMargin left=\"510\" right=\"510\" top=\"141\" bottom=\"141\"/>"
    ));
    for r in 0..rows {
        // Origin cells whose top-left lies in this row, left to right.
        let mut row_cells: Vec<&PlacedCell> = cells.iter().filter(|c| c.row == r).collect();
        row_cells.sort_by_key(|c| c.col);
        if row_cells.is_empty() {
            continue; // fully covered by row-spans from above — suppress the <hp:tr>
        }
        out.push_str("<hp:tr>");
        for cell in row_cells {
            let cellbf = cell
                .shade
                .as_ref()
                .and_then(|h| shade_ref.get(h))
                .map(String::as_str)
                .unwrap_or(bf);
            let header = if r == 0 { "1" } else { "0" };
            out.push_str(&format!(
                "<hp:tc name=\"\" header=\"{header}\" hasMargin=\"0\" protect=\"0\" editable=\"0\" dirty=\"0\" borderFillIDRef=\"{cellbf}\">\
<hp:subList id=\"\" textDirection=\"HORIZONTAL\" lineWrap=\"BREAK\" vertAlign=\"CENTER\" linkListIDRef=\"0\" linkListNextIDRef=\"0\" textWidth=\"0\" textHeight=\"0\" hasTextRef=\"0\" hasNumRef=\"0\">"
            ));
            // The cell's full content — paragraphs AND nested tables, recursively.
            emit_cell_content(out, &cell.content, para_ref, plain_ref, cref, bf, shade_ref, next_id);
            out.push_str(&format!(
                "</hp:subList>\
<hp:cellAddr colAddr=\"{}\" rowAddr=\"{r}\"/>\
<hp:cellSpan colSpan=\"{}\" rowSpan=\"{}\"/>\
<hp:cellSz width=\"{}\" height=\"{}\"/>\
<hp:cellMargin left=\"510\" right=\"510\" top=\"141\" bottom=\"141\"/></hp:tc>",
                cell.col,
                cell.col_span,
                cell.row_span,
                span_w(cell.col, cell.col_span),
                RH * cell.row_span as u64,
            ));
        }
        out.push_str("</hp:tr>");
    }
    out.push_str("</hp:tbl>");
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
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
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
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
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run { char_shape: 1, content: vec![Inline::Text("합성된 글자".into())], ..Default::default() }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        // header.xml must gain a synthesized charPr (red + bold), with itemCnt bumped and the
        // charProperties container still balanced (the container-vs-element regression).
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        assert_eq!(header.matches("<hh:charProperties").count(), 1, "container not duplicated");
        assert_eq!(header.matches("</hh:charProperties>").count(), 1, "container balanced");
        assert!(header.contains("<hh:bold/>"), "a bold charPr was synthesized");
        assert!(header.contains(r##"textColor="#FF0000""##), "red charPr synthesized");
        // round-trips + opens safely
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("합성된 글자"));
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
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text("가운데".into())], ..Default::default() }],
            para_shape: 1,
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        assert_eq!(header.matches("<hh:paraProperties").count(), 1, "container not duplicated");
        assert!(header.contains(r#"horizontal="CENTER""#), "center align synthesized");
        // hp:case intent=2000, hp:default intent=4000 (doubled)
        assert!(header.contains(r#"<hc:intent value="2000""#), "case intent = V");
        assert!(header.contains(r#"<hc:intent value="4000""#), "default intent = 2V (doubled)");
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
                runs: vec![Run { char_shape: 0, content: vec![Inline::Text(text.into())], ..Default::default() }],
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
        assert!(header.contains(r##"faceColor="#DDEBF7""##), "shade borderFill synthesized");
        assert_eq!(header.matches("<hh:borderFills").count(), 1, "container balanced");
        let _ = xml;
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("머리(병합)") && doc2.plain_text().contains("A"));
        // the merged cell round-trips with colSpan 2
        let merged = doc2.sections.iter().flat_map(|s| &s.blocks).find_map(|b| match b {
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
        sec.page = PageSetup { width: 84188, height: 59528, margin_left: 8504, margin_right: 8504, margin_top: 8504, margin_bottom: 8504, landscape: true, columns: 1 };
        sec.page_edited = true;
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let pkg = Package::open(&out).unwrap();
        let xml = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        let pp = &xml[xml.find("<hp:pagePr").unwrap()..];
        let pp = &pp[..pp.find('>').unwrap()];
        assert!(pp.contains(r#"width="84188""#) && pp.contains(r#"height="59528""#), "landscape dims: {pp}");
        let m = &xml[xml.find("<hp:margin").unwrap()..];
        let m = &m[..m.find("/>").unwrap()];
        assert!(m.contains(r#"left="8504""#) && m.contains(r#"top="8504""#), "margins patched: {m}");
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
                let Some(src) = p.source.clone() else { continue };
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
        let new_section = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();

        // A bold+red charPr was synthesized; the edited run references it.
        assert!(header.contains("<hh:bold/>") && header.contains(r##"textColor="#C00000""##), "bold+red charPr synthesized");
        // The UNEDITED paragraph's bytes survive verbatim (relocated but byte-identical).
        assert!(new_section.contains(&untouched), "unedited paragraph is byte-preserved");
        // Round-trips + text preserved + opens.
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("이 문서는") && doc2.plain_text().contains("표와 셀 병합"), "text preserved");
        assert!(crate::export::validate_open_safety(&out).ok);
        // emit an artifact for oracle + visual cross-check (harmless side effect).
        let _ = std::fs::write(std::env::temp_dir().join("inplace-edit.hwpx"), &out);
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
        // Index 0 reserved (default); add a center-align paraPr at index 1.
        doc.para_shapes.push(ParaShape { align: HorizontalAlign::Center, ..Default::default() });
        let center = 1usize;

        let sec = doc.sections.get_mut(0).unwrap();
        let mut runsonly_open: Option<(String, (usize, usize))> = None;
        let mut unedited_bytes: Option<String> = None;
        let mut para_edited = false;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else { continue };
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
                    runsonly_open = Some((orig_section[src.span.0..src.span.0 + open_end].to_string(), src.span));
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
        assert!(new_section.contains(&untouched), "unedited paragraph byte-preserved");
        // The runs-only paragraph's open tag is unchanged (no spurious paraPrIDRef rewrite).
        assert!(new_section.contains(&runsonly_open_tag), "runs-only edit keeps its open tag verbatim");

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
        assert!(found_center, "edited paragraph resolves to a center-align paraPr");
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
        doc.para_shapes.push(ParaShape { align: HorizontalAlign::Center, ..Default::default() });
        let center = 1usize;

        // Capture a non-simple paragraph's original body bytes (everything after its open tag).
        let sec = doc.sections.get_mut(0).unwrap();
        let mut body: Option<String> = None;
        let mut open_tag: Option<String> = None;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else { continue };
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
        assert!(body.contains("<hp:secPr") || body.contains("<hp:tbl") || body.contains("<hp:ctrl"), "captured a structural body");
        sec.dirty.mark();

        let out = serialize(&doc).unwrap();
        let new_section = {
            let pkg = Package::open(&out).unwrap();
            String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
        };
        // The structural BODY survives byte-verbatim; only the open tag's paraPrIDRef changed.
        assert!(new_section.contains(&body), "structural body bytes preserved verbatim");
        assert!(!new_section.contains(&open_tag), "the open tag's paraPrIDRef was patched (differs)");
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
        let target = style.get("개요 1").expect("showcase has a '개요 1' style").clone();

        let sec = doc.sections.get_mut(0).unwrap();
        let mut edited = false;
        for b in sec.blocks.iter_mut() {
            if let Block::Paragraph(p) = b {
                let Some(src) = p.source.clone() else { continue };
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
                .map(|s| s.style.as_deref() == Some(target.id.as_str()) && s.para_pr.as_deref() == Some(target.para_pr.as_str()))
                .unwrap_or(false),
            _ => false,
        });
        assert!(restyled, "edited paragraph references the 개요 1 style + its paraPr");
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
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run { char_shape: 1, content: vec![Inline::Text("기존 글자모양 재사용".into())], ..Default::default() }],
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
        assert!(run_tag.contains(r#"charPrIDRef="7""#), "reused existing charPr 7: {run_tag}");
        assert!(crate::export::validate_open_safety(&out).ok);
    }

    #[test]
    fn applies_named_style_and_outline_level() {
        let mut doc = parse_semantic(&showcase()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text("개요 1 제목".into())], ..Default::default() }],
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
        assert!(tag.contains(r#"styleIDRef="2""#), "styleIDRef resolved to 개요 1: {tag}");
        assert!(tag.contains(r#"paraPrIDRef="10""#), "adopts the style's paraPr: {tag}");
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
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text("기본 문단".into())], ..Default::default() }],
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
        assert_eq!(before, after, "default shape must NOT synthesize a new charPr");
    }

    #[test]
    fn roundtrip_noedit_reopens_with_same_text() {
        let doc = parse_semantic(&sample()).unwrap();
        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        assert_eq!(doc.plain_text(), doc2.plain_text());
        assert!(crate::export::validate_open_safety(&out).ok, "safety gate must pass on our output");
    }

    #[test]
    fn append_paragraph_survives_roundtrip_and_keeps_original() {
        let mut doc = parse_semantic(&sample()).unwrap();
        let sec = doc.sections.get_mut(0).unwrap();
        sec.blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text("추가된 문단".into())], ..Default::default() }],
            dirty: Dirty(true),
            ..Default::default()
        }));
        sec.dirty.mark();
        let out = serialize(&doc).unwrap();
        let doc2 = parse_semantic(&out).unwrap();
        assert!(doc2.plain_text().contains("추가된 문단"), "appended paragraph must survive");
        assert!(doc2.plain_text().contains("안녕하세요"), "original content must be preserved");
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
        assert!(text.contains("구분") && text.contains("승인"), "table cells must survive: {text}");
        assert!(text.contains("안녕하세요"), "original content preserved");
        assert!(crate::export::validate_open_safety(&out).ok, "open-safety gate must pass");
        // round-trip must yield a real Table block (not flattened to text paragraphs)
        let has_table = doc2.sections.iter().any(|s| {
            s.blocks.iter().any(|b| matches!(b, Block::Table(t) if t.cols >= 2 && t.rows >= 2))
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
                runs: vec![Run { char_shape: 0, content: vec![Inline::Text(t.into())], ..Default::default() }],
                ..Default::default()
            }));
        }
        doc.sections.push(sec);
        assert!(doc.passthrough.parts.is_empty(), "precondition: no HWPX provenance");

        let out =
            serialize(&doc).expect("from-scratch serialize must succeed without original provenance");
        // A valid, openable HWPX (the synthesis path's correctness gate).
        assert!(crate::export::validate_open_safety(&out).ok, "from-scratch output must be open-safe");
        // …that round-trips the text. (The Skeleton's secPr-carrier stub adds one leading empty
        // paragraph; the lifted text follows it in order.)
        let doc2 = parse_semantic(&out).unwrap();
        let text = doc2.plain_text();
        assert!(text.contains("첫째 문단입니다."), "first paragraph survives: {text}");
        assert!(text.contains("둘째 문단입니다."), "second paragraph survives: {text}");
        // serialize_from_scratch clones — the caller's doc is untouched (no provenance, no dirty).
        assert!(doc.passthrough.parts.is_empty(), "input doc must not be mutated");
        assert!(!doc.sections[0].dirty.is_dirty(), "input doc must not be dirtied");
    }

    #[test]
    fn from_scratch_multi_section_emits_all_sections_and_spine() {
        // v2: a multi-section from-scratch doc emits Contents/section0.xml + section1.xml, both
        // registered in content.hpf (manifest + spine), and stays open-safe.
        let mut doc = SemanticDoc::default();
        for t in ["첫 구역 본문.", "둘째 구역 본문."] {
            let mut sec = Section::default();
            sec.blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run { char_shape: 0, content: vec![Inline::Text(t.into())], ..Default::default() }],
                ..Default::default()
            }));
            doc.sections.push(sec);
        }
        let out = serialize(&doc).expect("multi-section from-scratch must serialize");
        assert!(crate::export::validate_synthesis_safety(&out).ok, "multi-section output open-safe");

        let pkg = Package::open(&out).unwrap();
        let secs = pkg.section_part_names();
        assert!(secs.iter().any(|n| n.ends_with("section0.xml")), "section0 present: {secs:?}");
        assert!(secs.iter().any(|n| n.ends_with("section1.xml")), "section1 appended: {secs:?}");
        let hpf = String::from_utf8(pkg.read_part("Contents/content.hpf").unwrap()).unwrap();
        assert!(hpf.contains(r#"href="Contents/section1.xml""#), "section1 in manifest");
        assert!(hpf.contains(r#"idref="section1""#), "section1 in spine");

        // Both sections' text round-trips.
        let re = parse_semantic(&out).unwrap();
        let text = re.plain_text();
        assert!(text.contains("첫 구역 본문.") && text.contains("둘째 구역 본문."), "both sections: {text}");
    }
}
