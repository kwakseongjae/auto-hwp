//! Machine-readable `layout-check --json` (issue #72).
//!
//! Scores are against **stored `<hp:lineseg>`**, not Hangul's live renderer. Converted HWPX with an
//! empty lineseg cache is `unscorable`, never a fabricated 0%. Cell mismatches (which carry text)
//! are not serialized.

use serde::Serialize;

#[cfg(feature = "rhwp")]
use hwp_model::types::SourceFormat;
#[cfg(feature = "rhwp")]
use std::panic::{catch_unwind, AssertUnwindSafe};
#[cfg(feature = "rhwp")]
use std::path::Path;

#[cfg_attr(not(any(test, feature = "rhwp")), allow(dead_code))]
const LINE_MATCH_FLOOR: f64 = 98.9;

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(not(feature = "rhwp"), allow(dead_code))]
pub struct FileScore {
    pub file: String,
    pub format: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `scorable` | `unscorable` | `fail`
    pub score_kind: String,
    /// `match` | `line_gap` | `page_gap` | `unscorable` | `fail`
    pub verdict: String,
    pub our_pages: usize,
    pub oracle_pages: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_match: Option<bool>,
    pub paragraphs: usize,
    pub body_paragraphs_with_oracle: usize,
    pub body_paragraphs_missing_oracle: usize,
    pub line_exact: usize,
    pub line_within1: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_exact_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_within1_pct: Option<f64>,
    pub our_lines: usize,
    pub oracle_lines: usize,
    pub cell_paragraphs: usize,
    pub cell_paragraphs_seen: usize,
    pub cell_paragraphs_missing_oracle: usize,
    pub cell_line_exact: usize,
    pub cell_line_within1: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_exact_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_within1_pct: Option<f64>,
    pub our_cell_lines: usize,
    pub oracle_cell_lines: usize,
    pub cell_structure_mismatches: usize,
    pub tables: usize,
    pub table_rows: usize,
    pub images: usize,
    pub equations: usize,
}

pub fn run_json(files: &[std::path::PathBuf]) -> Result<(), String> {
    if files.is_empty() {
        return Err("layout-check --json: at least one file is required".into());
    }
    run_json_inner(files)
}

#[cfg(not(feature = "rhwp"))]
fn run_json_inner(_files: &[std::path::PathBuf]) -> Result<(), String> {
    Err(
        "`layout-check --json` needs the rhwp bootstrap (한컴 linesegs 파싱): build with `--features rhwp`"
            .into(),
    )
}

#[cfg(feature = "rhwp")]
fn run_json_inner(files: &[std::path::PathBuf]) -> Result<(), String> {
    let mut reports = Vec::with_capacity(files.len());
    for f in files {
        reports.push(score_path_caught(f));
    }
    let out = serde_json::to_string_pretty(&reports).map_err(|e| e.to_string())?;
    println!("{out}");
    Ok(())
}

#[cfg(feature = "rhwp")]
fn score_path_caught(path: &Path) -> FileScore {
    match catch_unwind(AssertUnwindSafe(|| score_path(path))) {
        Ok(r) => r,
        Err(_) => fail_report(
            &path.display().to_string(),
            "unknown",
            "panic during layout-check",
        ),
    }
}

#[cfg(feature = "rhwp")]
fn score_path(path: &Path) -> FileScore {
    let file = path.display().to_string();
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return fail_report(&file, "unknown", e.to_string()),
    };
    score_bytes(&file, &bytes)
}

#[cfg(feature = "rhwp")]
fn score_bytes(file: &str, bytes: &[u8]) -> FileScore {
    let fmt = hwp_core::Engine::detect(bytes);
    let fidelity = if fmt == SourceFormat::Hwpx {
        match hwp_core::Engine::open(bytes) {
            Ok(doc) => hwp_rhwp::layout_fidelity_for_doc(bytes, &doc),
            Err(e) => return fail_report(file, fmt.as_str(), e.to_string()),
        }
    } else {
        hwp_core::layout_fidelity(bytes)
    };
    match fidelity {
        Ok(f) => FileScore::from_fidelity(file, fmt.as_str(), &f),
        Err(e) => fail_report(file, fmt.as_str(), e.to_string()),
    }
}

#[cfg_attr(not(feature = "rhwp"), allow(dead_code))]
fn fail_report(file: &str, format: &str, error: impl Into<String>) -> FileScore {
    FileScore {
        file: file.to_string(),
        format: format.to_string(),
        ok: false,
        error: Some(error.into()),
        score_kind: "fail".into(),
        verdict: "fail".into(),
        our_pages: 0,
        oracle_pages: 0,
        page_match: None,
        paragraphs: 0,
        body_paragraphs_with_oracle: 0,
        body_paragraphs_missing_oracle: 0,
        line_exact: 0,
        line_within1: 0,
        line_exact_pct: None,
        line_within1_pct: None,
        our_lines: 0,
        oracle_lines: 0,
        cell_paragraphs: 0,
        cell_paragraphs_seen: 0,
        cell_paragraphs_missing_oracle: 0,
        cell_line_exact: 0,
        cell_line_within1: 0,
        cell_exact_pct: None,
        cell_within1_pct: None,
        our_cell_lines: 0,
        oracle_cell_lines: 0,
        cell_structure_mismatches: 0,
        tables: 0,
        table_rows: 0,
        images: 0,
        equations: 0,
    }
}

impl FileScore {
    #[cfg(feature = "rhwp")]
    fn from_fidelity(file: &str, format: &str, f: &hwp_rhwp::LayoutFidelity) -> Self {
        let body_oracle = f.body_paragraphs_with_oracle > 0;
        let cell_oracle = f.cell_paragraphs > 0;
        let scorable = body_oracle || cell_oracle;
        let line_exact_pct = if body_oracle {
            Some(pct(f.line_exact, f.paragraphs))
        } else {
            None
        };
        let (score_kind, verdict, page_match) =
            classify(true, scorable, f.our_pages, f.oracle_pages, line_exact_pct);
        FileScore {
            file: file.to_string(),
            format: format.to_string(),
            ok: true,
            error: None,
            score_kind: score_kind.to_string(),
            verdict: verdict.to_string(),
            our_pages: f.our_pages,
            oracle_pages: f.oracle_pages,
            page_match,
            paragraphs: f.paragraphs,
            body_paragraphs_with_oracle: f.body_paragraphs_with_oracle,
            body_paragraphs_missing_oracle: f.body_paragraphs_missing_oracle,
            line_exact: f.line_exact,
            line_within1: f.line_within1,
            line_exact_pct,
            line_within1_pct: if body_oracle {
                Some(pct(f.line_within1, f.paragraphs))
            } else {
                None
            },
            our_lines: f.our_lines,
            oracle_lines: f.oracle_lines,
            cell_paragraphs: f.cell_paragraphs,
            cell_paragraphs_seen: f.cell_paragraphs_seen,
            cell_paragraphs_missing_oracle: f.cell_paragraphs_missing_oracle,
            cell_line_exact: f.cell_line_exact,
            cell_line_within1: f.cell_line_within1,
            cell_exact_pct: if cell_oracle {
                Some(pct(f.cell_line_exact, f.cell_paragraphs))
            } else {
                None
            },
            cell_within1_pct: if cell_oracle {
                Some(pct(f.cell_line_within1, f.cell_paragraphs))
            } else {
                None
            },
            our_cell_lines: f.our_cell_lines,
            oracle_cell_lines: f.oracle_cell_lines,
            cell_structure_mismatches: f.cell_structure_mismatches,
            tables: f.tables,
            table_rows: f.table_rows,
            images: f.images,
            equations: f.equations,
        }
    }
}

#[cfg_attr(not(feature = "rhwp"), allow(dead_code))]
fn pct(n: usize, d: usize) -> f64 {
    if d == 0 {
        0.0
    } else {
        (1000.0 * n as f64 / d as f64).round() / 10.0
    }
}

/// (`score_kind`, `verdict`, `page_match`)
#[cfg_attr(not(any(test, feature = "rhwp")), allow(dead_code))]
fn classify(
    ok: bool,
    scorable: bool,
    our_pages: usize,
    oracle_pages: u32,
    line_exact_pct: Option<f64>,
) -> (&'static str, &'static str, Option<bool>) {
    if !ok {
        return ("fail", "fail", None);
    }
    if !scorable {
        return ("unscorable", "unscorable", None);
    }
    let pages_eq = our_pages as u32 == oracle_pages;
    if !pages_eq {
        return ("scorable", "page_gap", Some(false));
    }
    let line_ok = match line_exact_pct {
        Some(p) => p >= LINE_MATCH_FLOOR,
        None => true,
    };
    if line_ok {
        ("scorable", "match", Some(true))
    } else {
        ("scorable", "line_gap", Some(true))
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn unscorable_is_not_a_zero() {
        let (kind, verdict, page_match) = classify(true, false, 7, 7, Some(0.0));
        assert_eq!(kind, "unscorable");
        assert_eq!(verdict, "unscorable");
        assert_eq!(page_match, None);
    }

    #[test]
    fn match_requires_pages_and_line_floor() {
        let (_, v, pm) = classify(true, true, 8, 8, Some(98.9));
        assert_eq!(v, "match");
        assert_eq!(pm, Some(true));
        let (_, v, pm) = classify(true, true, 8, 8, Some(98.8));
        assert_eq!(v, "line_gap");
        assert_eq!(pm, Some(true));
        let (_, v, pm) = classify(true, true, 9, 8, Some(100.0));
        assert_eq!(v, "page_gap");
        assert_eq!(pm, Some(false));
    }

    #[test]
    fn cell_only_oracle_can_match_on_pages() {
        let (kind, v, pm) = classify(true, true, 3, 3, None);
        assert_eq!(kind, "scorable");
        assert_eq!(v, "match");
        assert_eq!(pm, Some(true));
    }

    #[test]
    fn fail_stays_fail() {
        let (kind, v, _) = classify(false, true, 1, 1, Some(100.0));
        assert_eq!(kind, "fail");
        assert_eq!(v, "fail");
    }
}
