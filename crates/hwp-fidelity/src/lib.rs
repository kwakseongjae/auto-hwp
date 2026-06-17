//! Benchmark-driven fidelity harness.
//!
//! The north star is "원본 그대로" — does our engine reproduce the original? This crate
//! pins a real benchmark (`benchmark.hwp` at the repo root) and the golden corpus, and
//! compares our engine's render against the **oracle** (LibreOffice + H2Orestart) page
//! by page. It becomes a hard gate from Phase 1 (view) onward (see docs/FIDELITY.md).
//!
//! Prerequisites are detected and surfaced (we never claim a pass we can't compute):
//! - `soffice` + **H2Orestart** extension → reference render of HWP v5 / HWPX.
//! - engine render path (our renderer, or the rhwp bootstrap) → "ours".

use hwp_model::error::{Error, Result};
use std::path::{Path, PathBuf};

/// Repo root (this crate lives at `crates/hwp-fidelity`).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The benchmark file the user placed at the repo root.
pub fn benchmark_path() -> PathBuf {
    repo_root().join("benchmark.hwp")
}

/// Per-page fidelity verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FidelityBand {
    /// pixel/structural match within tolerance → edit inline
    Green,
    /// close but flagged → edit with "approximate layout" banner
    Yellow,
    /// diverges → read-only PDF fallback
    Red,
}

/// What the fidelity gate can currently run.
#[derive(Clone, Copy, Debug)]
pub struct Prerequisites {
    pub soffice: bool,
    pub h2orestart: bool,
    /// Our engine can render (own renderer or rhwp bootstrap wired).
    pub engine_render: bool,
}

impl Prerequisites {
    pub fn detect() -> Self {
        Prerequisites {
            soffice: hwp_oracle::soffice_available(),
            h2orestart: hwp_oracle::h2orestart_installed(),
            engine_render: cfg!(feature = "rhwp"),
        }
    }
    /// Reference render is possible (oracle ready).
    pub fn can_reference(&self) -> bool {
        self.soffice && self.h2orestart
    }
    /// Full benchmark fidelity comparison is possible.
    pub fn can_compare(&self) -> bool {
        self.can_reference() && self.engine_render
    }
}

/// Produce the oracle reference render (PDF) for a document.
pub fn reference_pdf(input: &Path, out_dir: &Path) -> Result<PathBuf> {
    let pre = Prerequisites::detect();
    if !pre.soffice {
        return Err(Error::CapabilityUnavailable("soffice (install LibreOffice)"));
    }
    if !pre.h2orestart {
        return Err(Error::CapabilityUnavailable(
            "H2Orestart extension (run scripts/install-h2orestart.sh) — native hwpfilter is HWP v3 only",
        ));
    }
    std::fs::create_dir_all(out_dir).map_err(|e| Error::Io(e.to_string()))?;
    hwp_oracle::convert_to_pdf(input, out_dir)
}

/// Per-page score.
#[derive(Clone, Debug)]
pub struct PageScore {
    pub index: usize,
    /// Cross-renderer pixel agreement in [0,1]; `None` if the page exists in only one render.
    pub similarity: Option<f64>,
    pub band: FidelityBand,
}

/// What the reference render is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceKind {
    /// A ground-truth PDF provided next to the input (e.g. exported from Hancom). ABSOLUTE fidelity.
    GroundTruthPdf,
    /// LibreOffice + H2Orestart render. Cross-renderer agreement only (not ground truth).
    Oracle,
}

/// Result of a fidelity comparison.
///
/// With `reference == GroundTruthPdf` this is ABSOLUTE fidelity (our render vs the authoritative
/// PDF). With `reference == Oracle` it is only cross-renderer agreement (our engine vs LibreOffice;
/// neither is Hancom ground-truth). A page-count mismatch is a strong structural-divergence signal.
#[derive(Clone, Debug)]
pub struct FidelityReport {
    pub reference: ReferenceKind,
    pub our_pages: usize,
    pub ref_pages: usize,
    pub pages: Vec<PageScore>,
    pub overall: FidelityBand,
}

/// A ground-truth reference PDF next to the input (e.g. `benchmark.hwp` → `benchmark.pdf`).
pub fn reference_pdf_for(input: &Path) -> Option<PathBuf> {
    let p = input.with_extension("pdf");
    p.exists().then_some(p)
}

/// A documented, accepted divergence from the reference render. The fidelity gate exempts these so
/// a KNOWN structural difference (e.g. a cross-renderer re-pagination) does not fail the build,
/// while any new or unlisted divergence still does. Keep this list short and each entry justified.
#[derive(Clone, Copy, Debug)]
pub struct KnownDivergence {
    /// Which reference mode this exemption applies to (it never softens ground-truth content).
    pub reference: ReferenceKind,
    pub kind: DivergenceKind,
    pub reason: &'static str,
}

/// The shape of an accepted divergence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DivergenceKind {
    /// A page-count mismatch against this reference is accepted (plus the surplus pages it implies).
    PageCount,
    /// A specific 0-based page index is allowed to band `Red` against this reference.
    Page(usize),
}

/// Accepted divergences for the root `benchmark.hwp`. Against the ground-truth Hancom PDF there are
/// NONE — all 8 pages match (94.9–99.2%). The single entry only softens the weaker cross-renderer
/// (Oracle) mode, where LibreOffice re-paginates; the gate stays strict for absolute fidelity.
pub fn benchmark_allowlist() -> &'static [KnownDivergence] {
    &[KnownDivergence {
        reference: ReferenceKind::Oracle,
        kind: DivergenceKind::PageCount,
        reason: "LibreOffice+H2Orestart re-paginates benchmark.hwp to 10 pages; the authoritative \
                 Hancom PDF and our engine both yield 8 — a cross-renderer pagination difference, \
                 not content loss (page CONTENT still gates per-page)",
    }]
}

/// Divergences in `report` that are NOT covered by `allow` — the fidelity gate passes iff this is
/// empty. A `Red` page that is purely a surplus implied by an allowlisted page-count mismatch is
/// also exempted; an aligned-page content `Red` never is.
pub fn unexpected_divergences(report: &FidelityReport, allow: &[KnownDivergence]) -> Vec<String> {
    let count_allowed = allow
        .iter()
        .any(|d| d.reference == report.reference && d.kind == DivergenceKind::PageCount);
    let aligned = report.our_pages.min(report.ref_pages);
    let mut out = Vec::new();
    if report.our_pages != report.ref_pages && !count_allowed {
        out.push(format!("page-count mismatch: ours={} ref={}", report.our_pages, report.ref_pages));
    }
    for p in &report.pages {
        if p.band != FidelityBand::Red {
            continue;
        }
        // A Red page beyond the aligned range is a surplus page — covered by the count allowance.
        if p.index >= aligned && count_allowed {
            continue;
        }
        let page_allowed = allow
            .iter()
            .any(|d| d.reference == report.reference && d.kind == DivergenceKind::Page(p.index));
        if !page_allowed {
            out.push(format!("page {} RED (similarity {:?})", p.index + 1, p.similarity));
        }
    }
    out
}

#[cfg(feature = "rhwp")]
fn band_of(sim: f64) -> FidelityBand {
    // Lenient: different engines use different substitute fonts/AA, so even a faithful page
    // rarely exceeds ~0.95 pixel agreement.
    if sim >= 0.90 {
        FidelityBand::Green
    } else if sim >= 0.78 {
        FidelityBand::Yellow
    } else {
        FidelityBand::Red
    }
}

/// Grayscale mean-absolute-difference agreement of two PNGs, resized to a common box.
#[cfg(feature = "rhwp")]
fn image_similarity(a: &Path, b: &Path) -> Result<f64> {
    use image::imageops::FilterType;
    let load = |p: &Path| -> Result<image::GrayImage> {
        Ok(image::open(p)
            .map_err(|e| Error::Other(format!("open {}: {e}", p.display())))?
            .to_luma8())
    };
    let (w, h) = (600u32, 848u32); // ~A4 ratio
    let ra = image::imageops::resize(&load(a)?, w, h, FilterType::Triangle);
    let rb = image::imageops::resize(&load(b)?, w, h, FilterType::Triangle);
    let mut sum: u64 = 0;
    for (pa, pb) in ra.pixels().zip(rb.pixels()) {
        sum += (pa[0] as i32 - pb[0] as i32).unsigned_abs() as u64;
    }
    let mae = sum as f64 / (w as f64 * h as f64);
    Ok(1.0 - mae / 255.0)
}

/// Render every page of our engine to PNG (page → SVG → PNG).
#[cfg(feature = "rhwp")]
fn render_our_pngs(bytes: &[u8], out_dir: &Path) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(out_dir).map_err(|e| Error::Io(e.to_string()))?;
    let n = hwp_core::page_count(bytes)? as usize;
    let mut pngs = Vec::with_capacity(n);
    for p in 0..n {
        let svg = hwp_core::render_page_svg(bytes, p as u32)?;
        let svg_path = out_dir.join(format!("p{p:03}.svg"));
        let png_path = out_dir.join(format!("p{p:03}.png"));
        std::fs::write(&svg_path, svg).map_err(|e| Error::Io(e.to_string()))?;
        hwp_oracle::svg_to_png(&svg_path, &png_path, 1.0)?;
        pngs.push(png_path);
    }
    Ok(pngs)
}

/// Compare our engine's render against the reference, per page.
///
/// Reference selection: a ground-truth PDF next to the input (`<stem>.pdf`) is preferred
/// (ABSOLUTE fidelity) and needs only the engine render + rasterizers — NOT soffice/H2Orestart.
/// Otherwise falls back to the oracle (LibreOffice + H2Orestart) for cross-renderer agreement.
#[cfg(feature = "rhwp")]
pub fn compare(input: &Path) -> Result<FidelityReport> {
    let bytes = std::fs::read(input).map_err(|e| Error::Io(e.to_string()))?;
    let work = std::env::temp_dir().join("tfhwp_fidelity");
    let our_pngs = render_our_pngs(&bytes, &work.join("ours"))?;
    let ref_dir = work.join("ref");

    let (ref_pngs, reference) = match reference_pdf_for(input) {
        Some(pdf) => (hwp_oracle::pdf_to_pngs(&pdf, &ref_dir, 100)?, ReferenceKind::GroundTruthPdf),
        None => {
            let pre = Prerequisites::detect();
            if !pre.can_reference() {
                return Err(Error::CapabilityUnavailable(
                    "no ground-truth <stem>.pdf and oracle unavailable (need soffice + H2Orestart)",
                ));
            }
            let pdf = hwp_oracle::convert_to_pdf(input, &ref_dir)?;
            (hwp_oracle::pdf_to_pngs(&pdf, &ref_dir, 100)?, ReferenceKind::Oracle)
        }
    };

    // Per-page agreement over the aligned range; surplus pages on either side → Red.
    let max_n = our_pngs.len().max(ref_pngs.len());
    let aligned = our_pngs.len().min(ref_pngs.len());
    let mut pages = Vec::with_capacity(max_n);
    for i in 0..max_n {
        if i < aligned {
            let sim = image_similarity(&our_pngs[i], &ref_pngs[i])?;
            pages.push(PageScore { index: i, similarity: Some(sim), band: band_of(sim) });
        } else {
            pages.push(PageScore { index: i, similarity: None, band: FidelityBand::Red });
        }
    }

    let count_mismatch = our_pngs.len() != ref_pngs.len();
    let any_red = pages.iter().any(|p| p.band == FidelityBand::Red);
    let any_yellow = pages.iter().any(|p| p.band == FidelityBand::Yellow);
    let overall = if count_mismatch || any_red {
        FidelityBand::Red
    } else if any_yellow {
        FidelityBand::Yellow
    } else {
        FidelityBand::Green
    };

    Ok(FidelityReport { reference, our_pages: our_pngs.len(), ref_pages: ref_pngs.len(), pages, overall })
}

#[cfg(not(feature = "rhwp"))]
pub fn compare(_input: &Path) -> Result<FidelityReport> {
    Err(Error::CapabilityUnavailable(
        "fidelity compare needs the rhwp engine render: build with --features rhwp",
    ))
}

#[cfg(test)]
mod tests {
    //! The allowlist/divergence LOGIC is pure — it runs in CI without rhwp, the oracle, or the
    //! benchmark fixture, so the fidelity CONTRACT is enforced even where the render cannot run.
    use super::*;

    fn page(index: usize, band: FidelityBand) -> PageScore {
        let similarity = Some(if band == FidelityBand::Green { 0.95 } else { 0.50 });
        PageScore { index, similarity, band }
    }

    fn report(reference: ReferenceKind, our: usize, refp: usize, pages: Vec<PageScore>) -> FidelityReport {
        let overall = if pages.iter().any(|p| p.band == FidelityBand::Red) || our != refp {
            FidelityBand::Red
        } else {
            FidelityBand::Green
        };
        FidelityReport { reference, our_pages: our, ref_pages: refp, pages, overall }
    }

    #[test]
    fn groundtruth_all_green_passes_the_gate() {
        let r = report(ReferenceKind::GroundTruthPdf, 8, 8, (0..8).map(|i| page(i, FidelityBand::Green)).collect());
        assert!(unexpected_divergences(&r, benchmark_allowlist()).is_empty());
    }

    #[test]
    fn oracle_pagination_divergence_is_allowlisted() {
        // 8 ours vs 10 oracle: aligned pages green, surplus pages 9 & 10 Red — exempt via PageCount.
        let mut pages: Vec<_> = (0..8).map(|i| page(i, FidelityBand::Green)).collect();
        pages.push(PageScore { index: 8, similarity: None, band: FidelityBand::Red });
        pages.push(PageScore { index: 9, similarity: None, band: FidelityBand::Red });
        let r = report(ReferenceKind::Oracle, 8, 10, pages);
        assert!(unexpected_divergences(&r, benchmark_allowlist()).is_empty(), "pagination diff is known");
    }

    #[test]
    fn aligned_content_red_is_never_allowlisted() {
        // A real content regression on an aligned page must fail the gate in BOTH modes.
        let mut pages: Vec<_> = (0..8).map(|i| page(i, FidelityBand::Green)).collect();
        pages[3].band = FidelityBand::Red;
        let r = report(ReferenceKind::Oracle, 8, 8, pages);
        let unexpected = unexpected_divergences(&r, benchmark_allowlist());
        assert_eq!(unexpected.len(), 1);
        assert!(unexpected[0].contains("page 4"), "got: {unexpected:?}");
    }

    #[test]
    fn groundtruth_pagecount_mismatch_fails() {
        // The allowlist is Oracle-only: a page-count mismatch vs the ground truth is a real failure.
        let mut pages: Vec<_> = (0..8).map(|i| page(i, FidelityBand::Green)).collect();
        pages.push(PageScore { index: 8, similarity: None, band: FidelityBand::Red });
        let r = report(ReferenceKind::GroundTruthPdf, 8, 9, pages);
        assert!(!unexpected_divergences(&r, benchmark_allowlist()).is_empty());
    }
}
