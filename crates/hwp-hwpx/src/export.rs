//! HWPX export contract — the Hancom-acceptable round-trip rules.
//!
//! Ported (clean-room) from the behavior of airmang/python-hwpx (Apache-2.0). The
//! single most load-bearing fact is the **PR#40 triad**: generic-parser-valid XML can
//! still be rejected by Hancom unless all three hold. See PLAN §4.

use hwp_model::capability::SafetyReport;

pub const MIMETYPE: &str = "application/hwp+zip";
pub const CONTENT_HPF_MEDIA_TYPE: &str = "application/hwpml-package+xml";

/// PR#40 triad — each axis individually causes Hancom to reject the file as "damaged".
pub const EXPORT_INVARIANTS: &[&str] = &[
    "every sec/head XML declaration carries standalone=\"yes\"",
    "sec/head roots declare the full HWPML_COMPAT_ROOT_NAMESPACES surface",
    "mimetype is the first ZIP entry and STORED; other entries keep original order + per-entry metadata",
];

/// The Hancom-compat root namespace surface every `sec`/`head` root must carry.
/// NOTE: prefixes are firm; URIs are best-effort from research and MUST be verified
/// against the official OWPML / KS X 6101 spec before freezing (PLAN §3.1 risks).
pub const HWPML_COMPAT_ROOT_NAMESPACES: &[(&str, &str)] = &[
    ("ha", "http://www.hancom.co.kr/hwpml/2011/app"),
    ("hp", "http://www.hancom.co.kr/hwpml/2011/paragraph"),
    ("hp10", "http://www.hancom.co.kr/hwpml/2016/paragraph"),
    ("hs", "http://www.hancom.co.kr/hwpml/2011/section"),
    ("hc", "http://www.hancom.co.kr/hwpml/2011/core"),
    ("hh", "http://www.hancom.co.kr/hwpml/2011/head"),
    ("hhs", "http://www.hancom.co.kr/hwpml/2011/history"),
    ("hm", "http://www.hancom.co.kr/hwpml/2011/master-page"),
    ("hpf", "http://www.hancom.co.kr/schema/2011/hpf"),
    ("dc", "http://purl.org/dc/elements/1.1/"),
    ("opf", "http://www.idpf.org/2007/opf/"),
    (
        "ooxmlchart",
        "http://www.hancom.co.kr/hwpml/2016/ooxmlchart",
    ),
    (
        "hwpunitchar",
        "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar",
    ),
    ("epub", "http://www.idpf.org/2007/ops"),
    ("config", "urn:oasis:names:tc:opendocument:xmlns:config:1.0"),
];

/// macOS-Hancom compatibility hints — non-blocking, satisfy on export when possible.
pub const COMPAT_HINTS: &[&str] = &[
    "include Preview/PrvText.txt",
    "hh:head version = 1.4",
    "hh:compatibleDocument targetProgram = HWP2018",
    "bold charPr carries a populated hh:fontRef",
    "strip stale linesegarray/lineseg from dirty sections",
];

/// Editor-open-safety acceptance gate (subset of `validate_editor_open_safety`).
///
/// Checks the blocking markers we can verify on the produced package: valid OPC, correct
/// mimetype as the first entry, and each section part carrying `standalone="yes"` + a section
/// root. (Deeper checks — STORED-mimetype, full namespace surface, table/secPr child sets,
/// id-reference integrity — grow here; the oracle reopen is the external confirmation.)
pub fn validate_open_safety(bytes: &[u8]) -> SafetyReport {
    let mut blocking = Vec::new();
    let warnings = Vec::new();

    match crate::package::Package::open(bytes) {
        Ok(pkg) => {
            if pkg.mimetype.as_deref() != Some(MIMETYPE) {
                blocking.push(format!("mimetype must be '{MIMETYPE}'"));
            }
            if pkg.part_names.first().map(String::as_str) != Some("mimetype") {
                blocking.push("mimetype must be the first ZIP entry".into());
            }
            let sections = pkg.section_part_names();
            if sections.is_empty() {
                blocking.push("no body section part (Contents/section*.xml)".into());
            }
            for name in sections {
                if let Ok(b) = pkg.read_part(&name) {
                    let s = String::from_utf8_lossy(&b);
                    if !s.contains("standalone=\"yes\"") {
                        blocking.push(format!(
                            "{name}: missing XML declaration with standalone=\"yes\""
                        ));
                    }
                    if !s.contains(":sec") {
                        blocking.push(format!("{name}: missing section root element"));
                    }
                }
            }
        }
        Err(e) => blocking.push(format!("not a valid OPC package: {e}")),
    }

    SafetyReport {
        ok: blocking.is_empty(),
        blocking,
        warnings,
    }
}

/// STRICTER gate for the FROM-SCRATCH synthesis path (HWP5→HWPX). On top of [`validate_open_safety`]
/// it checks the two ways a deep-lift off-by-one becomes a Hancom "damaged file" — neither of which
/// the generic XML/OPC checks catch, and `build_synth_plan` silently no-ops on:
///   (a) IDRef integrity — every `charPrIDRef`/`paraPrIDRef`/`borderFillIDRef`/`styleIDRef` in a
///       section resolves to an id that EXISTS in the header pools;
///   (b) `itemCnt` == actual child count for each header pool (Hancom trusts the declared count);
///   (c) v2 manifest integrity — `content.hpf` lists every section + BinData part it ships, and
///       every `<hc:img binaryItemIDRef>` resolves to a manifest item (dangling → broken image).
///
/// Kept SEPARATE from `validate_open_safety` (which the byte-stable HWPX-in round-trip asserts) so
/// these additions can't regress that path — only the converter runs this, inside
/// `serialize_from_scratch`, before returning.
pub fn validate_synthesis_safety(bytes: &[u8]) -> SafetyReport {
    let base = validate_open_safety(bytes);
    let mut blocking = base.blocking;
    let warnings = base.warnings;

    if let Ok(pkg) = crate::package::Package::open(bytes) {
        match pkg.read_header() {
            Some(hb) => {
                let header = String::from_utf8_lossy(&hb);
                // (b) itemCnt == childcount for each synthesizable pool.
                for (container, elem) in [
                    ("charProperties", "charPr"),
                    ("paraProperties", "paraPr"),
                    ("fontfaces", "fontface"),
                    ("borderFills", "borderFill"),
                    ("styles", "style"),
                ] {
                    if let Some((declared, actual)) =
                        pool_itemcnt_mismatch(&header, container, elem)
                    {
                        blocking.push(format!(
                            "{container}: itemCnt={declared} but {actual} <hh:{elem}> children"
                        ));
                    }
                }
                // (a) IDRef integrity — section references must resolve to header pool ids.
                let char_ids = pool_ids(&header, "charProperties", "charPr");
                let para_ids = pool_ids(&header, "paraProperties", "paraPr");
                let bf_ids = pool_ids(&header, "borderFills", "borderFill");
                let style_ids = pool_ids(&header, "styles", "style");
                for name in pkg.section_part_names() {
                    if let Ok(b) = pkg.read_part(&name) {
                        let s = String::from_utf8_lossy(&b);
                        check_refs(&s, "charPrIDRef", &char_ids, &name, &mut blocking);
                        check_refs(&s, "paraPrIDRef", &para_ids, &name, &mut blocking);
                        check_refs(&s, "borderFillIDRef", &bf_ids, &name, &mut blocking);
                        check_refs(&s, "styleIDRef", &style_ids, &name, &mut blocking);
                    }
                }
            }
            None => blocking.push("no header.xml to validate pool references against".into()),
        }

        // (c) v2 manifest integrity — content.hpf must list every section + BinData part it ships,
        // and every <hc:img binaryItemIDRef> must resolve to a manifest item. A missing manifest
        // entry or a dangling image ref opens as a Hancom "damaged file" / broken image.
        if let Ok(hpf) = pkg.read_part("Contents/content.hpf") {
            let hpf = String::from_utf8_lossy(&hpf);
            // Manifest item ids + hrefs.
            let item_ids = manifest_attr_set(&hpf, "id");
            let item_hrefs = manifest_attr_set(&hpf, "href");

            // Every Contents/section*.xml and BinData/* part is listed in the manifest (by href).
            for name in &pkg.part_names {
                let is_section = name.starts_with("Contents/section") && name.ends_with(".xml");
                let is_bindata = name.starts_with("BinData/");
                if (is_section || is_bindata) && !item_hrefs.contains(name.as_str()) {
                    blocking.push(format!(
                        "content.hpf manifest is missing an entry for '{name}'"
                    ));
                }
            }
            // Every image reference in a section resolves to a manifest item.
            for name in pkg.section_part_names() {
                if let Ok(b) = pkg.read_part(&name) {
                    let s = String::from_utf8_lossy(&b);
                    for id in attr_values(&s, "binaryItemIDRef") {
                        if !item_ids.contains(id.as_str()) {
                            blocking.push(format!(
                                "{name}: binaryItemIDRef=\"{id}\" has no matching content.hpf item"
                            ));
                        }
                    }
                }
            }
        }

        // (d) field integrity — every <hp:fieldEnd beginIDRef> must match a <hp:fieldBegin id> in
        // the SAME section (an unpaired field corrupts the document → Hancom repair prompt).
        for name in pkg.section_part_names() {
            if let Ok(b) = pkg.read_part(&name) {
                let s = String::from_utf8_lossy(&b);
                let begin_ids = tagged_attr_set(&s, "<hp:fieldBegin ", "id");
                for end_ref in attr_values_after(&s, "<hp:fieldEnd ", "beginIDRef") {
                    if !begin_ids.contains(end_ref.as_str()) {
                        blocking.push(format!(
                            "{name}: <hp:fieldEnd beginIDRef=\"{end_ref}\"> has no matching fieldBegin"
                        ));
                    }
                }
            }
        }
    }

    SafetyReport {
        ok: blocking.is_empty(),
        blocking,
        warnings,
    }
}

/// The set of `{attr}` values appearing in the open tag that starts at each `{tag}` occurrence
/// (e.g. all `id`s of `<hp:fieldBegin …>` elements).
fn tagged_attr_set(xml: &str, tag: &str, attr: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let mut idx = 0;
    let pat = format!("{attr}=\"");
    while let Some(p) = xml[idx..].find(tag) {
        let start = idx + p + tag.len();
        let tag_end = xml[start..]
            .find('>')
            .map(|e| start + e)
            .unwrap_or(xml.len());
        if let Some(a) = xml[start..tag_end].find(&pat) {
            let vs = start + a + pat.len();
            if let Some(ve) = xml[vs..tag_end].find('"') {
                out.insert(xml[vs..vs + ve].to_string());
            }
        }
        idx = tag_end;
    }
    out
}

/// Like [`tagged_attr_set`] but returns a Vec (duplicates kept) of `{attr}` from each `{tag}` tag.
fn attr_values_after(xml: &str, tag: &str, attr: &str) -> Vec<String> {
    tagged_attr_set(xml, tag, attr).into_iter().collect()
}

/// The set of `<opf:item …>` `{attr}` values in `content.hpf` (e.g. all `id`s or all `href`s).
fn manifest_attr_set(hpf: &str, attr: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let mut idx = 0;
    while let Some(p) = hpf[idx..].find("<opf:item ") {
        let start = idx + p;
        let end = hpf[start..]
            .find("/>")
            .map(|e| start + e)
            .unwrap_or(hpf.len());
        let tag = &hpf[start..end];
        let pat = format!("{attr}=\"");
        if let Some(a) = tag.find(&pat) {
            let vs = a + pat.len();
            if let Some(ve) = tag[vs..].find('"') {
                out.insert(tag[vs..vs + ve].to_string());
            }
        }
        idx = end + 2;
    }
    out
}

/// All distinct `{attr}="…"` values in `xml`.
fn attr_values(xml: &str, attr: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let pat = format!("{attr}=\"");
    let mut idx = 0;
    while let Some(p) = xml[idx..].find(&pat) {
        let start = idx + p + pat.len();
        let end = xml[start..]
            .find('"')
            .map(|e| start + e)
            .unwrap_or(xml.len());
        out.insert(xml[start..end].to_string());
        idx = end;
    }
    out
}

/// First `name="N"` (u64) within `tag`.
fn attr_u64(tag: &str, name: &str) -> Option<u64> {
    let pat = format!("{name}=\"");
    let s = tag.find(&pat)? + pat.len();
    let e = tag[s..].find('"')? + s;
    tag[s..e].parse().ok()
}

/// The set of `id`s declared by `<hh:{elem} …>` elements inside the `<hh:{container}>` pool.
fn pool_ids(header: &str, container: &str, elem: &str) -> std::collections::BTreeSet<u64> {
    let mut ids = std::collections::BTreeSet::new();
    let (open, close) = (format!("<hh:{container}"), format!("</hh:{container}>"));
    let seg = match (header.find(&open), header.find(&close)) {
        (Some(a), Some(b)) if b > a => &header[a..b],
        _ => return ids,
    };
    let needle = format!("<hh:{elem} "); // trailing space: never matches the container open tag
    let mut idx = 0;
    while let Some(p) = seg[idx..].find(&needle) {
        let start = idx + p + needle.len();
        let tag_end = seg[start..]
            .find('>')
            .map(|e| start + e)
            .unwrap_or(seg.len());
        if let Some(id) = attr_u64(&seg[start..tag_end], "id") {
            ids.insert(id);
        }
        idx = tag_end;
    }
    ids
}

/// `(declared itemCnt, actual child count)` for a pool, or None if they match / the pool is absent.
fn pool_itemcnt_mismatch(header: &str, container: &str, elem: &str) -> Option<(u64, usize)> {
    let open = format!("<hh:{container}");
    let p = header.find(&open)?;
    let tag_end = header[p..].find('>')? + p;
    let declared = attr_u64(&header[p..=tag_end], "itemCnt")?;
    let cstart = header[p..].find(&format!("</hh:{container}>"))? + p;
    let actual = header[tag_end..cstart]
        .matches(&format!("<hh:{elem} "))
        .count();
    (declared as usize != actual).then_some((declared, actual))
}

/// Flag any `{attr}="N"` in `xml` whose `N` is not in `valid` (one message per distinct bad id).
fn check_refs(
    xml: &str,
    attr: &str,
    valid: &std::collections::BTreeSet<u64>,
    part: &str,
    out: &mut Vec<String>,
) {
    let needle = format!("{attr}=\"");
    let mut idx = 0;
    let mut bad = std::collections::BTreeSet::new();
    while let Some(p) = xml[idx..].find(&needle) {
        let start = idx + p + needle.len();
        let end = xml[start..]
            .find('"')
            .map(|e| start + e)
            .unwrap_or(xml.len());
        if let Ok(id) = xml[start..end].parse::<u64>() {
            if !valid.contains(&id) {
                bad.insert(id);
            }
        }
        idx = end;
    }
    for id in bad {
        out.push(format!(
            "{part}: {attr}=\"{id}\" has no matching header pool entry"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn namespace_surface_has_15() {
        assert_eq!(HWPML_COMPAT_ROOT_NAMESPACES.len(), 15);
    }

    #[test]
    fn pool_ids_collects_ids_and_skips_container_tag() {
        let header = r#"<hh:charProperties itemCnt="2"><hh:charPr id="0"/><hh:charPr id="7"/></hh:charProperties>"#;
        let ids = pool_ids(header, "charProperties", "charPr");
        assert_eq!(ids, BTreeSet::from([0, 7]));
    }

    #[test]
    fn itemcnt_mismatch_is_detected() {
        let ok = r#"<hh:charProperties itemCnt="2"><hh:charPr id="0"/><hh:charPr id="1"/></hh:charProperties>"#;
        assert_eq!(pool_itemcnt_mismatch(ok, "charProperties", "charPr"), None);
        let bad = r#"<hh:charProperties itemCnt="3"><hh:charPr id="0"/><hh:charPr id="1"/></hh:charProperties>"#;
        assert_eq!(
            pool_itemcnt_mismatch(bad, "charProperties", "charPr"),
            Some((3, 2))
        );
    }

    #[test]
    fn manifest_and_attr_parsers() {
        let hpf = r#"<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>"#;
        let ids = manifest_attr_set(hpf, "id");
        assert!(ids.contains("image1") && ids.contains("section0") && ids.contains("header"));
        let hrefs = manifest_attr_set(hpf, "href");
        assert!(hrefs.contains("BinData/image1.png") && hrefs.contains("Contents/section0.xml"));

        let sec = r#"<hp:run><hp:pic><hc:img binaryItemIDRef="image1"/></hp:pic></hp:run><hc:img binaryItemIDRef="image9"/>"#;
        let refs = attr_values(sec, "binaryItemIDRef");
        assert_eq!(
            refs,
            BTreeSet::from(["image1".to_string(), "image9".to_string()])
        );
        // image9 is NOT in the manifest → the integrity check would flag it.
        assert!(!ids.contains("image9"));
    }

    #[test]
    fn check_refs_flags_dangling_only() {
        let valid = BTreeSet::from([0u64, 1, 7]);
        let mut out = Vec::new();
        // 0 and 7 resolve; 99 does not.
        let xml = r#"<hp:run charPrIDRef="0"/><hp:run charPrIDRef="7"/><hp:run charPrIDRef="99"/>"#;
        check_refs(xml, "charPrIDRef", &valid, "section0.xml", &mut out);
        assert_eq!(out.len(), 1, "exactly the dangling ref is flagged: {out:?}");
        assert!(out[0].contains("99"));
    }
}
