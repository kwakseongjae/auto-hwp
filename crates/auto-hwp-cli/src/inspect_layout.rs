//! Typesetting-element inspector (issue #71).
//!
//! Tags come from opening the file, not from its name:
//! 1. production `Engine::open` IR walk + `place_doc` (multi-page tables)
//! 2. HWPX source XML scan (forms/headers our parser may drop)
//! 3. rhwp source census when `--features rhwp` (HWP5 controls)

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use hwp_model::document::{Block, DecoKind, Inline, NoteKind, PageSetup, SemanticDoc};
use hwp_model::types::SourceFormat;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
pub struct TagSet {
    pub header_footer: bool,
    pub form_control: bool,
    pub mixed_orientation: bool,
    pub nested_table: bool,
    pub multipage_table: bool,
    pub footnote: bool,
    pub multicolumn: bool,
    pub chart: bool,
    pub equation: bool,
    pub shape_ole: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TagCounts {
    pub header: u32,
    pub footer: u32,
    pub form: u32,
    pub nested_table: u32,
    pub footnote: u32,
    pub endnote: u32,
    pub equation: u32,
    pub chart: u32,
    pub shape: u32,
    pub ole: u32,
    pub column_gt1: u32,
    pub tables: u32,
    pub landscape_sections: u32,
    pub portrait_sections: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileReport {
    pub file: String,
    pub format: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub tags: TagSet,
    pub counts: TagCounts,
    pub evidence: Vec<String>,
    pub sections: u32,
    pub placed_pages: u32,
}

pub fn run(files: &[std::path::PathBuf]) -> Result<(), String> {
    if files.is_empty() {
        return Err("tag-layout: at least one file is required".into());
    }
    let mut reports = Vec::with_capacity(files.len());
    for f in files {
        reports.push(inspect_path(f));
    }
    let out = serde_json::to_string_pretty(&reports).map_err(|e| e.to_string())?;
    println!("{out}");
    Ok(())
}

pub fn inspect_path(path: &Path) -> FileReport {
    let file = path.display().to_string();
    match std::fs::read(path) {
        Ok(bytes) => inspect_bytes(&file, &bytes),
        Err(e) => FileReport {
            file,
            format: "unknown".into(),
            ok: false,
            error: Some(e.to_string()),
            tags: TagSet::default(),
            counts: TagCounts::default(),
            evidence: Vec::new(),
            sections: 0,
            placed_pages: 0,
        },
    }
}

pub fn inspect_bytes(file: &str, bytes: &[u8]) -> FileReport {
    let fmt = hwp_core::Engine::detect(bytes);
    let mut tags = TagSet::default();
    let mut counts = TagCounts::default();
    let mut evidence = BTreeSet::new();
    let mut sections = 0u32;
    let mut placed_pages = 0u32;
    let mut err = None;

    if fmt == SourceFormat::Hwpx {
        scan_hwpx_xml(bytes, &mut tags, &mut counts, &mut evidence);
    }

    match hwp_core::Engine::open(bytes) {
        Ok(doc) => {
            sections = doc.sections.len() as u32;
            walk_ir(&doc, &mut tags, &mut counts, &mut evidence);
            // place_doc is only needed for the multipage-table tag. Skip very large
            // samples so a coverage retag stays bounded (hwpxlib error corpus has a 7MB file).
            if bytes.len() > 5_000_000 {
                evidence.insert(format!("place_doc-skipped:{}B", bytes.len()));
            } else {
                let placed = hwp_typeset::place_doc(&doc, &hwp_typeset::ApproxFontMetrics);
                placed_pages = placed.pages.len() as u32;
                tag_multipage(&placed, &mut tags, &mut evidence);
            }
        }
        Err(e) => {
            err = Some(e.to_string());
        }
    }

    #[cfg(feature = "rhwp")]
    {
        match hwp_rhwp::source_layout_census(bytes) {
            Ok(c) => apply_census(&c, fmt, &mut tags, &mut counts, &mut evidence),
            Err(e) => {
                evidence.insert(format!("rhwp-census-error:{e}"));
            }
        }
    }

    FileReport {
        file: file.to_string(),
        format: fmt.as_str().to_string(),
        ok: err.is_none(),
        error: err,
        tags,
        counts,
        evidence: evidence.into_iter().collect(),
        sections,
        placed_pages,
    }
}

#[cfg(feature = "rhwp")]
fn apply_census(
    c: &hwp_rhwp::SourceLayoutCensus,
    fmt: SourceFormat,
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    counts.header = counts.header.max(c.header);
    counts.footer = counts.footer.max(c.footer);
    counts.form = counts.form.max(c.form);
    counts.nested_table = counts.nested_table.max(c.nested_table);
    counts.footnote = counts.footnote.max(c.footnote);
    counts.endnote = counts.endnote.max(c.endnote);
    counts.equation = counts.equation.max(c.equation);
    counts.chart = counts.chart.max(c.chart);
    counts.shape = counts.shape.max(c.shape);
    counts.ole = counts.ole.max(c.ole);
    counts.column_gt1 = counts.column_gt1.max(c.column_gt1);
    counts.tables = counts.tables.max(c.tables);
    if fmt != SourceFormat::Hwpx {
        // HWPX `landscape="WIDELY"` on portrait pages is a known authoring lie;
        // HWP5 stores the real flag. Only fold HWP5 orientation from rhwp.
        counts.landscape_sections = counts.landscape_sections.max(c.landscape_sections);
        counts.portrait_sections = counts.portrait_sections.max(c.portrait_sections);
    }
    if c.header + c.footer > 0 {
        tags.header_footer = true;
        evidence.insert("rhwp:header-or-footer".into());
    }
    if c.form > 0 {
        tags.form_control = true;
        evidence.insert(format!("rhwp:form:{}", c.form));
    }
    if c.nested_table > 0 {
        tags.nested_table = true;
        evidence.insert(format!("rhwp:nested-table:{}", c.nested_table));
    }
    if c.footnote + c.endnote > 0 {
        tags.footnote = true;
        evidence.insert(format!("rhwp:note:{}+{}", c.footnote, c.endnote));
    }
    if c.equation > 0 {
        tags.equation = true;
        evidence.insert(format!("rhwp:equation:{}", c.equation));
    }
    if c.chart > 0 {
        tags.chart = true;
        evidence.insert(format!("rhwp:chart:{}", c.chart));
    }
    if c.shape + c.ole > 0 {
        tags.shape_ole = true;
        evidence.insert(format!("rhwp:shape+ole:{}+{}", c.shape, c.ole));
    }
    if c.column_gt1 > 0 {
        tags.multicolumn = true;
        evidence.insert(format!("rhwp:colCount>1:{}", c.column_gt1));
    }
    if fmt != SourceFormat::Hwpx && c.landscape_sections > 0 && c.portrait_sections > 0 {
        tags.mixed_orientation = true;
        evidence.insert(format!(
            "rhwp:mixed-orientation:L{}/P{}",
            c.landscape_sections, c.portrait_sections
        ));
    }
}

fn walk_ir(
    doc: &SemanticDoc,
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    let mut land = 0u32;
    let mut port = 0u32;
    for sec in &doc.sections {
        if is_landscape(&sec.page) {
            land += 1;
        } else {
            port += 1;
        }
        if sec.page.columns > 1 {
            counts.column_gt1 += 1;
            tags.multicolumn = true;
            evidence.insert(format!("ir:page.columns:{}", sec.page.columns));
        }
        for deco in &sec.decorations {
            match deco.kind {
                DecoKind::Header => counts.header += 1,
                DecoKind::Footer => counts.footer += 1,
            }
            tags.header_footer = true;
            evidence.insert("ir:page-decoration".into());
            walk_blocks(&deco.blocks, tags, counts, evidence);
        }
        walk_blocks(&sec.blocks, tags, counts, evidence);
    }
    counts.landscape_sections = counts.landscape_sections.max(land);
    counts.portrait_sections = counts.portrait_sections.max(port);
    if land > 0 && port > 0 {
        tags.mixed_orientation = true;
        evidence.insert(format!("ir:mixed-orientation:L{land}/P{port}"));
    }
}

fn is_landscape(page: &PageSetup) -> bool {
    let (w, h) = hwp_typeset::display_paper(page);
    w > h
}

fn walk_blocks(
    blocks: &[Block],
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    for b in blocks {
        match b {
            Block::Paragraph(p) => {
                for run in &p.runs {
                    for inl in &run.content {
                        match inl {
                            Inline::Equation(_) => {
                                counts.equation += 1;
                                tags.equation = true;
                                evidence.insert("ir:equation".into());
                            }
                            Inline::Chart(_) => {
                                counts.chart += 1;
                                tags.chart = true;
                                evidence.insert("ir:chart".into());
                            }
                            Inline::Note(n) => {
                                match n.kind {
                                    NoteKind::Foot => counts.footnote += 1,
                                    NoteKind::End => counts.endnote += 1,
                                }
                                tags.footnote = true;
                                evidence.insert("ir:note".into());
                                walk_blocks(&n.body, tags, counts, evidence);
                            }
                            Inline::Raw(raw) => scan_raw_tag(&raw.tag, tags, counts, evidence),
                            Inline::Image(_)
                            | Inline::Text(_)
                            | Inline::FieldBegin(_)
                            | Inline::FieldEnd(_)
                            | Inline::Bookmark(_) => {}
                        }
                    }
                }
            }
            Block::Table(t) => {
                counts.tables += 1;
                let nested = t
                    .cells
                    .iter()
                    .any(|cell| cell.blocks.iter().any(|cb| matches!(cb, Block::Table(_))));
                if nested {
                    counts.nested_table += 1;
                    tags.nested_table = true;
                    evidence.insert("ir:nested-table".into());
                }
                for cell in &t.cells {
                    walk_blocks(&cell.blocks, tags, counts, evidence);
                }
            }
        }
    }
}

fn scan_raw_tag(
    tag: &str,
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    let t = tag.to_ascii_lowercase();
    if t.contains("header") || t.contains("footer") {
        tags.header_footer = true;
        evidence.insert(format!("ir:raw:{tag}"));
    }
    if ["btn", "checkbtn", "radiobtn", "combobox", "edit", "form"]
        .iter()
        .any(|k| t.contains(k))
    {
        counts.form += 1;
        tags.form_control = true;
        evidence.insert(format!("ir:raw:{tag}"));
    }
    if t.contains("equation") {
        counts.equation += 1;
        tags.equation = true;
        evidence.insert(format!("ir:raw:{tag}"));
    }
    if t.contains("chart") {
        counts.chart += 1;
        tags.chart = true;
        evidence.insert(format!("ir:raw:{tag}"));
    }
    if [
        "rect",
        "line",
        "ellipse",
        "arc",
        "polygon",
        "curve",
        "container",
        "ole",
        "connectline",
    ]
    .iter()
    .any(|k| t.contains(k))
    {
        tags.shape_ole = true;
        evidence.insert(format!("ir:raw:{tag}"));
    }
}

fn tag_multipage(
    placed: &hwp_typeset::PlacedDoc,
    tags: &mut TagSet,
    evidence: &mut BTreeSet<String>,
) {
    let mut frags: BTreeMap<(usize, usize), BTreeSet<usize>> = BTreeMap::new();
    for (pi, page) in placed.pages.iter().enumerate() {
        for t in &page.tables {
            frags.entry((t.section, t.block)).or_default().insert(pi);
        }
    }
    for ((s, b), pages) in &frags {
        if pages.len() > 1 {
            tags.multipage_table = true;
            evidence.insert(format!(
                "place_doc:table-s{s}-b{b}-on-{}-pages",
                pages.len()
            ));
        }
    }
}

fn scan_hwpx_xml(
    bytes: &[u8],
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    let Ok(pkg) = hwp_hwpx::package::Package::open(bytes) else {
        return;
    };
    if pkg
        .part_names
        .iter()
        .any(|n| n.to_ascii_lowercase().contains("chart"))
    {
        tags.chart = true;
        counts.chart = counts.chart.max(1);
        evidence.insert("hwpx:part:chart".into());
    }
    let mut land = 0u32;
    let mut port = 0u32;
    for name in pkg.section_part_names() {
        let Ok(raw) = pkg.read_part(&name) else {
            continue;
        };
        let xml = String::from_utf8_lossy(&raw);
        scan_xml_body(&xml, tags, counts, evidence);
        let (l, p) = pagepr_orientations(&xml);
        land += l;
        port += p;
        if colcount_gt1(&xml) {
            counts.column_gt1 += 1;
            tags.multicolumn = true;
            evidence.insert("hwpx:colCount>1".into());
        }
        let nest = tbl_max_depth(&xml);
        if nest >= 2 {
            counts.nested_table = counts.nested_table.max(1);
            tags.nested_table = true;
            evidence.insert(format!("hwpx:tbl-depth:{nest}"));
        }
    }
    counts.landscape_sections = counts.landscape_sections.max(land);
    counts.portrait_sections = counts.portrait_sections.max(port);
    if land > 0 && port > 0 {
        tags.mixed_orientation = true;
        evidence.insert(format!("hwpx:mixed-orientation:L{land}/P{port}"));
    }
}

fn contains_elem(xml: &str, prefix: &str) -> bool {
    let mut i = 0;
    while let Some(rest) = xml.get(i..) {
        let Some(at) = rest.find(prefix) else {
            break;
        };
        let abs = i + at;
        if is_open_tag(xml, abs, prefix) {
            return true;
        }
        i = abs + prefix.len();
    }
    false
}

fn scan_xml_body(
    xml: &str,
    tags: &mut TagSet,
    counts: &mut TagCounts,
    evidence: &mut BTreeSet<String>,
) {
    let hits: &[(&str, &str)] = &[
        ("<hp:header", "header"),
        ("<hp:footer", "footer"),
        ("<hp:checkBtn", "form"),
        ("<hp:radioBtn", "form"),
        ("<hp:comboBox", "form"),
        ("<hp:btn", "form"),
        ("<hp:edit", "form"),
        ("<hp:footNote", "footnote"),
        ("<hp:endNote", "endnote"),
        ("<hp:equation", "equation"),
        ("<hp:chart", "chart"),
        ("<hp:rect", "shape"),
        ("<hp:line", "shape"),
        ("<hp:ellipse", "shape"),
        ("<hp:arc", "shape"),
        ("<hp:polygon", "shape"),
        ("<hp:curve", "shape"),
        ("<hp:container", "shape"),
        ("<hp:ole", "ole"),
        ("<hp:connectLine", "shape"),
        ("<hp:textArt", "shape"),
    ];
    for (pat, kind) in hits {
        if !contains_elem(xml, pat) {
            continue;
        }
        evidence.insert(format!("hwpx:{pat}"));
        match *kind {
            "header" => {
                counts.header += 1;
                tags.header_footer = true;
            }
            "footer" => {
                counts.footer += 1;
                tags.header_footer = true;
            }
            "form" => {
                counts.form += 1;
                tags.form_control = true;
            }
            "footnote" => {
                counts.footnote += 1;
                tags.footnote = true;
            }
            "endnote" => {
                counts.endnote += 1;
                tags.footnote = true;
            }
            "equation" => {
                counts.equation += 1;
                tags.equation = true;
            }
            "chart" => {
                counts.chart += 1;
                tags.chart = true;
            }
            "shape" => {
                counts.shape += 1;
                tags.shape_ole = true;
            }
            "ole" => {
                counts.ole += 1;
                tags.shape_ole = true;
            }
            _ => {}
        }
    }
}

fn each_open_tag<'a>(xml: &'a str, prefix: &str) -> impl Iterator<Item = &'a str> + 'a {
    let prefix = prefix.to_string();
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        let rest = xml.get(pos..)?;
        let at = rest.find(prefix.as_str())?;
        let start = pos + at;
        if !is_open_tag(xml, start, prefix.as_str()) {
            pos = start + prefix.len();
            return Some("");
        }
        let tag = &xml[start..];
        let end = tag.find('>').unwrap_or(prefix.len());
        pos = start + end.max(1);
        Some(&tag[..end])
    })
    .filter(|t| !t.is_empty())
}

fn pagepr_orientations(xml: &str) -> (u32, u32) {
    let mut land = 0u32;
    let mut port = 0u32;
    for open in each_open_tag(xml, "<hp:pagePr") {
        let w = attr_i32(open, "width").unwrap_or(0);
        let h = attr_i32(open, "height").unwrap_or(0);
        if w > h {
            land += 1;
        } else {
            port += 1;
        }
    }
    (land, port)
}

fn colcount_gt1(xml: &str) -> bool {
    each_open_tag(xml, "<hp:colPr").any(|open| attr_i32(open, "colCount").unwrap_or(1) > 1)
}

fn attr_i32(tag: &str, name: &str) -> Option<i32> {
    let pat = format!("{name}=\"");
    let i = tag.find(&pat)?;
    let rest = &tag[i + pat.len()..];
    let end = rest.find('"')?;
    rest[..end].parse().ok()
}

fn tbl_max_depth(xml: &str) -> u32 {
    let mut depth = 0u32;
    let mut max = 0u32;
    let mut pos = 0usize;
    while pos < xml.len() {
        let rest = match xml.get(pos..) {
            Some(s) => s,
            None => break,
        };
        let open_rel = rest.find("<hp:tbl");
        let close_rel = rest.find("</hp:tbl");
        match (open_rel, close_rel) {
            (None, None) => break,
            (Some(o), Some(c)) if o < c => {
                if is_open_tag(xml, pos + o, "<hp:tbl") {
                    depth += 1;
                    max = max.max(depth);
                }
                pos += o + 7;
            }
            (Some(o), None) => {
                if is_open_tag(xml, pos + o, "<hp:tbl") {
                    depth += 1;
                    max = max.max(depth);
                }
                pos += o + 7;
            }
            (None, Some(c)) | (Some(_), Some(c)) => {
                depth = depth.saturating_sub(1);
                pos += c + 8;
            }
        }
    }
    max
}

fn is_open_tag(xml: &str, i: usize, prefix: &str) -> bool {
    let Some(s) = xml.get(i..) else {
        return false;
    };
    if !s.starts_with(prefix) {
        return false;
    }
    matches!(
        xml.as_bytes().get(i + prefix.len()),
        Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
    )
}

#[cfg(test)]
mod tests {
    use super::inspect_bytes;
    use std::path::PathBuf;

    fn load(rel: &str) -> (String, Vec<u8>) {
        let p: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(rel);
        (
            rel.to_string(),
            std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display())),
        )
    }

    #[test]
    fn form_01_is_form_control() {
        let (name, bytes) = load("corpus/hwpx/form-01.hwpx");
        let r = inspect_bytes(&name, &bytes);
        assert!(r.ok, "{}", r.error.unwrap_or_default());
        assert!(r.tags.form_control, "evidence={:?}", r.evidence);
        assert!(!r.tags.footnote);
    }

    #[test]
    fn footnote_01_has_notes() {
        let (name, bytes) = load("corpus/hwpx/footnote-01.hwpx");
        let r = inspect_bytes(&name, &bytes);
        assert!(r.ok, "{}", r.error.unwrap_or_default());
        assert!(r.tags.footnote, "evidence={:?}", r.evidence);
    }

    #[test]
    fn smoke_min_is_not_a_form() {
        let (name, bytes) = load("corpus/hwpx/00_smoke_min.hwpx");
        let r = inspect_bytes(&name, &bytes);
        assert!(r.ok, "{}", r.error.unwrap_or_default());
        assert!(!r.tags.form_control);
        assert!(!r.tags.footnote);
        assert!(!r.tags.mixed_orientation);
        assert!(!r.tags.multicolumn, "colCount=1 is not 다단");
    }

    fn maybe(rel: &str) -> Option<(String, Vec<u8>)> {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(rel);
        p.exists().then(|| load(rel))
    }

    #[test]
    fn hwpxlib_header_footer_and_multicolumn() {
        if let Some((name, bytes)) = maybe("corpus/hwpxlib_corpus/reader_writer/HeaderFooter.hwpx")
        {
            let r = inspect_bytes(&name, &bytes);
            assert!(r.ok, "{}", r.error.unwrap_or_default());
            assert!(r.tags.header_footer, "evidence={:?}", r.evidence);
        }
        if let Some((name, bytes)) = maybe("corpus/hwpxlib_corpus/reader_writer/MultiColumn.hwpx") {
            let r = inspect_bytes(&name, &bytes);
            assert!(r.ok, "{}", r.error.unwrap_or_default());
            assert!(r.tags.multicolumn, "evidence={:?}", r.evidence);
        }
        if let Some((name, bytes)) = maybe("corpus/hwpxlib_corpus/error/20230818/test.hwpx") {
            let r = inspect_bytes(&name, &bytes);
            assert!(r.ok, "{}", r.error.unwrap_or_default());
            assert!(r.tags.nested_table, "evidence={:?}", r.evidence);
        }
    }
}
