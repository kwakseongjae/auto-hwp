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
    ("ooxmlchart", "http://www.hancom.co.kr/hwpml/2016/ooxmlchart"),
    ("hwpunitchar", "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"),
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
                        blocking.push(format!("{name}: missing XML declaration with standalone=\"yes\""));
                    }
                    if !s.contains(":sec") {
                        blocking.push(format!("{name}: missing section root element"));
                    }
                }
            }
        }
        Err(e) => blocking.push(format!("not a valid OPC package: {e}")),
    }

    SafetyReport { ok: blocking.is_empty(), blocking, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_surface_has_15() {
        assert_eq!(HWPML_COMPAT_ROOT_NAMESPACES.len(), 15);
    }
}
