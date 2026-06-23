//! `hwp-foreign` — ingest of FOREIGN formats into the format-neutral [`SemanticDoc`].
//!
//! Two readers, each behind a Cargo feature so the DEFAULT build pulls no extra deps:
//!
//! - **`docx`** ([`docx`]): OOXML word-processing (`.docx`). A full-ish editable mapping —
//!   paragraphs/runs (bold/italic/size/color/underline/strike), tables (rows/cols, cell shading,
//!   column widths), images, headers/footers, lists, page setup. Shapes/SmartArt/charts that we
//!   don't model become [`Inline::Raw`] passthrough (preserved, non-editable). Pure-Rust: reuses
//!   the workspace `zip` + `quick-xml`.
//! - **`pdfin`** ([`pdf`]): PDF (`.pdf`). **VIEW-MOSTLY** — positioned glyphs + image boxes per
//!   page (faithful view + overlay), NOT a semantic paragraph/table reconstruction. Pure-Rust via
//!   `lopdf`.
//!
//! When a feature is off, the corresponding `read_*` returns
//! [`Error::CapabilityUnavailable`] so the seam (and the format routing in `hwp-core`) is always
//! present, and the build stays green without the dep.

use hwp_model::prelude::*;

#[cfg(feature = "docx")]
pub mod docx;
#[cfg(feature = "pdfin")]
pub mod pdf;

/// EMU (English Metric Unit) → HWPUNIT. 1 inch = 914_400 EMU = 7_200 HWPUNIT ⇒ ÷127.
#[inline]
pub fn emu_to_hwp(emu: i64) -> HwpUnit {
    (emu / 127) as HwpUnit
}

/// twips (1/20 pt) → HWPUNIT. 1 pt = 100 HWPUNIT, 1 twip = 1/20 pt ⇒ ×5.
#[inline]
pub fn twips_to_hwp(twips: i64) -> HwpUnit {
    (twips * 5) as HwpUnit
}

/// half-points (DOCX font size `w:sz` is in half-points) → HWPUNIT height (pt*100).
#[inline]
pub fn halfpt_to_hwp(halfpt: i64) -> HwpUnit {
    (halfpt * 50) as HwpUnit
}

/// Read a `.docx` byte buffer into a `SemanticDoc` (feature `docx`).
#[cfg(feature = "docx")]
pub fn read_docx(bytes: &[u8]) -> Result<SemanticDoc> {
    docx::read(bytes)
}

/// Read a `.docx` byte buffer — UNAVAILABLE stub when the `docx` feature is off.
#[cfg(not(feature = "docx"))]
pub fn read_docx(_bytes: &[u8]) -> Result<SemanticDoc> {
    Err(Error::CapabilityUnavailable(
        "docx ingest (build with --features docx)",
    ))
}

/// Read a `.pdf` byte buffer into a VIEW-MOSTLY `SemanticDoc` (feature `pdfin`).
#[cfg(feature = "pdfin")]
pub fn read_pdf(bytes: &[u8]) -> Result<SemanticDoc> {
    pdf::read(bytes)
}

/// Read a `.pdf` byte buffer — UNAVAILABLE stub when the `pdfin` feature is off.
#[cfg(not(feature = "pdfin"))]
pub fn read_pdf(_bytes: &[u8]) -> Result<SemanticDoc> {
    Err(Error::CapabilityUnavailable(
        "pdf ingest (build with --features pdfin)",
    ))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn emu_inch_is_7200_hwp() {
        assert_eq!(emu_to_hwp(914_400), 7200);
    }

    #[test]
    fn twips_inch_is_7200_hwp() {
        // 1 inch = 1440 twips → 7200 HWPUNIT.
        assert_eq!(twips_to_hwp(1440), 7200);
    }

    #[test]
    fn halfpt_12pt_is_1200_hwp() {
        // 12pt = 24 half-points → 1200 HWPUNIT.
        assert_eq!(halfpt_to_hwp(24), 1200);
    }

    #[cfg(not(feature = "docx"))]
    #[test]
    fn docx_stub_reports_unavailable() {
        assert!(matches!(
            read_docx(b"PK\x03\x04"),
            Err(Error::CapabilityUnavailable(_))
        ));
    }

    #[cfg(not(feature = "pdfin"))]
    #[test]
    fn pdf_stub_reports_unavailable() {
        assert!(matches!(
            read_pdf(b"%PDF-1.7"),
            Err(Error::CapabilityUnavailable(_))
        ));
    }
}
