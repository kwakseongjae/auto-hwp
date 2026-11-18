//! `layout-check --page-starts`: where pages start in OUR flow vs the layout stored in the file
//! ([`hwp_rhwp::PageStartAlignment`]). For pagination work: the page COUNT can match by accident
//! (one page too many here, one too few there), the page STARTS cannot.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(not(feature = "rhwp"), allow(dead_code))]
pub struct PageStartReport {
    pub file: String,
    pub format: String,
    pub metrics: &'static str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Why the file was not measured (`multi-column` · `no-stored-layout`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
    /// Pages in our flow (a page count; the break counts below count a table spanning pages once).
    pub our_pages: usize,
    /// Page-break events in the stored layout / in ours over the same lines.
    pub stored_breaks: usize,
    pub our_breaks: usize,
    /// Stored page breaks we make at the same line.
    pub matched: usize,
    pub max_drift: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_drift_page: Option<usize>,
    pub lines: usize,
    /// One file only (human mode): the lines where the two sides disagree.
    #[serde(skip)]
    pub disagreements: Vec<String>,
}

pub fn run(files: &[std::path::PathBuf], json: bool) -> Result<(), String> {
    if files.is_empty() {
        return Err("layout-check --page-starts: at least one file is required".into());
    }
    run_inner(files, json)
}

#[cfg(not(feature = "rhwp"))]
fn run_inner(_files: &[std::path::PathBuf], _json: bool) -> Result<(), String> {
    Err("`layout-check --page-starts` needs the rhwp bootstrap (저장 lineseg 파싱): build with `--features rhwp`".into())
}

#[cfg(feature = "rhwp")]
fn run_inner(files: &[std::path::PathBuf], json: bool) -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let reports: Vec<PageStartReport> = files
        .iter()
        .map(|path| {
            let file = path.display().to_string();
            catch_unwind(AssertUnwindSafe(|| measure(&file, path))).unwrap_or_else(|_| {
                failed(
                    &file,
                    "unknown",
                    "panic during layout-check --page-starts".into(),
                )
            })
        })
        .collect();
    if json {
        let out = serde_json::to_string_pretty(&reports).map_err(|e| e.to_string())?;
        println!("{out}");
        return Ok(());
    }
    for r in &reports {
        if let Some(error) = &r.error {
            println!("{}: 실패 — {error}", r.file);
        } else if let Some(skipped) = r.skipped {
            println!("{}: 재지 않음 ({skipped})", r.file);
        } else {
            println!(
                "{}: 쪽 시작 (저장 줄 배치 기준) — 저장 쪽 나눔 {} · 우리 {} · 같은 줄 {} · 최대 어긋남 {}쪽 · 처음 어긋난 저장 쪽 {} · 우리 쪽 수 {}",
                r.file,
                r.stored_breaks,
                r.our_breaks,
                r.matched,
                r.max_drift,
                r.first_drift_page.map_or("없음".into(), |p| p.to_string()),
                r.our_pages,
            );
            if reports.len() == 1 {
                for line in &r.disagreements {
                    println!("{line}");
                }
            }
        }
    }
    Ok(())
}

#[cfg(feature = "rhwp")]
fn measure(file: &str, path: &std::path::Path) -> PageStartReport {
    use hwp_model::types::SourceFormat;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => return failed(file, "unknown", e.to_string()),
    };
    let format = hwp_core::Engine::detect(&bytes);
    let measured = if format == SourceFormat::Hwpx {
        match hwp_core::Engine::open(&bytes) {
            Ok(doc) => hwp_rhwp::page_start_alignment_for_doc(&bytes, &doc),
            Err(e) => return failed(file, format.as_str(), e.to_string()),
        }
    } else {
        hwp_rhwp::page_start_alignment(&bytes)
    };
    match measured {
        Ok(a) => PageStartReport {
            file: file.to_string(),
            format: format.as_str().to_string(),
            metrics: crate::layout_score::METRICS_KIND,
            ok: true,
            error: None,
            skipped: a.skipped,
            our_pages: a.our_pages,
            stored_breaks: a.stored_breaks,
            our_breaks: a.our_breaks,
            matched: a.matched,
            max_drift: a.max_drift,
            first_drift_page: a.first_drift_page,
            lines: a.lines,
            disagreements: a
                .events
                .iter()
                .filter(|e| e.stored != e.ours)
                .map(|e| {
                    format!(
                        "  구역 {} · 문단 {} · 줄 {} — {}",
                        e.section,
                        e.paragraph,
                        e.line,
                        if e.stored {
                            "저장 배치만 쪽을 넘김"
                        } else {
                            "우리만 쪽을 넘김"
                        }
                    )
                })
                .collect(),
        },
        Err(e) => failed(file, format.as_str(), e.to_string()),
    }
}

#[cfg_attr(not(feature = "rhwp"), allow(dead_code))]
fn failed(file: &str, format: &str, error: String) -> PageStartReport {
    PageStartReport {
        file: file.to_string(),
        format: format.to_string(),
        metrics: crate::layout_score::METRICS_KIND,
        ok: false,
        error: Some(error),
        skipped: None,
        our_pages: 0,
        stored_breaks: 0,
        our_breaks: 0,
        matched: 0,
        max_drift: 0,
        first_drift_page: None,
        lines: 0,
        disagreements: Vec::new(),
    }
}
