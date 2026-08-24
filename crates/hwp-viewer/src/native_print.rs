//! Native printing from the same own-engine PDF bytes used by export.
//!
//! The webview is deliberately not a print source. We preflight krilla's replay accounting and then
//! pass the in-memory PDF to the platform print operation. Keeping the spool source in memory avoids
//! a pathname/permission/cleanup lifecycle entirely; the bytes live only until the modal operation
//! returns.

use hwp_export::pdf::{PdfExport, PdfReplayCounts};
use serde::Serialize;

const MAX_PRINT_PDF_BYTES: usize = 256 * 1024 * 1024;
const MAX_DIAGNOSTIC_CODES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrintPreflight {
    pub(crate) pages: usize,
    pub(crate) byte_len: usize,
    pub(crate) text_ops: usize,
    pub(crate) table_geometry_ops: usize,
    pub(crate) image_ops: usize,
    pub(crate) equation_ops: usize,
    pub(crate) chart_ops: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePrintResult {
    pub(crate) status: &'static str,
    pub(crate) preflight: PrintPreflight,
}

fn checked_replayed(kind: &str, counts: &PdfReplayCounts) -> Result<usize, String> {
    if counts.produced != counts.replayed + counts.stubbed {
        return Err(format!("PRINT_REPLAY_UNBALANCED:{kind}"));
    }
    if counts.stubbed != 0 {
        return Err(format!("PRINT_REPLAY_DEGRADED:{kind}"));
    }
    Ok(counts.replayed)
}

pub(crate) fn preflight(export: &PdfExport) -> Result<PrintPreflight, String> {
    if export.bytes.is_empty() || export.bytes.len() > MAX_PRINT_PDF_BYTES {
        return Err("PRINT_PDF_SIZE_OUT_OF_RANGE".into());
    }
    let trimmed_end = export
        .bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(&export.bytes[..], |last| &export.bytes[..=last]);
    if !export.bytes.starts_with(b"%PDF-") || !trimmed_end.ends_with(b"%%EOF") {
        return Err("PRINT_PDF_CONTAINER_INVALID".into());
    }
    if export.pages == 0 || export.replay.len() != export.pages {
        return Err("PRINT_PAGE_ACCOUNTING_INVALID".into());
    }
    if !export.diagnostics.is_empty() {
        let codes = export
            .diagnostics
            .iter()
            .take(MAX_DIAGNOSTIC_CODES)
            .map(|diagnostic| format!("{}:{}", diagnostic.kind, diagnostic.code))
            .collect::<Vec<_>>()
            .join(",");
        return Err(format!("PRINT_CAPABILITY_DIAGNOSTIC:{codes}"));
    }

    let mut out = PrintPreflight {
        pages: export.pages,
        byte_len: export.bytes.len(),
        text_ops: 0,
        table_geometry_ops: 0,
        image_ops: 0,
        equation_ops: 0,
        chart_ops: 0,
    };
    for (expected_page, page) in export.replay.iter().enumerate() {
        if page.page_index != expected_page {
            return Err("PRINT_PAGE_ORDER_INVALID".into());
        }
        out.text_ops += checked_replayed("text", &page.text)?;
        out.table_geometry_ops += checked_replayed("table_geometry", &page.table_geometry)?;
        out.image_ops += checked_replayed("image", &page.image)?;
        out.equation_ops += checked_replayed("equation", &page.equation)?;
        out.chart_ops += checked_replayed("chart", &page.chart)?;
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
pub(crate) fn run_print_panel(pdf_bytes: &[u8], job_title: &str) -> Result<bool, String> {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation};
    use objc2_foundation::{NSData, NSString};

    // PDFKit is intentionally accessed through its stable Objective-C surface so the bridge stays
    // three calls wide; all page construction remains in hwp-export/krilla.
    #[link(name = "PDFKit", kind = "framework")]
    unsafe extern "C" {}

    std::panic::catch_unwind(|| {
        autoreleasepool(|_| {
            let data = NSData::with_bytes(pdf_bytes);
            // SAFETY: PDFDocument's documented initWithData: consumes NSData without retaining the
            // Rust slice; `data` and the document both live through the modal operation.
            let document: Option<Retained<AnyObject>> = unsafe {
                let allocated: *mut AnyObject = msg_send![class!(PDFDocument), alloc];
                let initialized: *mut AnyObject = msg_send![allocated, initWithData: &*data];
                Retained::from_raw(initialized)
            };
            let document = document.ok_or_else(|| String::from("PRINT_PDFKIT_OPEN_FAILED"))?;
            // AppKit's print panel dereferences the print session carried by NSPrintInfo. Passing
            // nil appears tolerated by the PDFKit constructor but crashes later inside
            // `PJCSessionHasApplicationSetPrinter` when the modal panel opens (real packaged QA).
            let print_info = NSPrintInfo::sharedPrintInfo();
            // kPDFPrintPageScaleNone=0 preserves the own-PDF geometry. Scale-to-fit silently shrank
            // even an A4 source inside the printer's imageable margins during real Save-as-PDF QA.
            // autoRotate still lets PDFKit honor portrait/landscape media boxes.
            let operation: Option<Retained<NSPrintOperation>> = unsafe {
                msg_send![
                    &*document,
                    printOperationForPrintInfo: &*print_info,
                    scalingMode: 0isize,
                    autoRotate: true
                ]
            };
            let operation = operation.ok_or_else(|| String::from("PRINT_OPERATION_UNAVAILABLE"))?;
            operation.setShowsPrintPanel(true);
            operation.setShowsProgressPanel(true);
            let title = NSString::from_str(job_title);
            operation.setJobTitle(Some(&title));
            Ok(operation.runOperation())
        })
    })
    .map_err(|_| String::from("PRINT_NATIVE_EXCEPTION"))?
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn run_print_panel(_pdf_bytes: &[u8], _job_title: &str) -> Result<bool, String> {
    Err("PRINT_NATIVE_UNAVAILABLE_ON_PLATFORM".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_export::pdf::{PdfCapabilityDiagnostic, PdfPageReplayStats};
    use hwp_model::prelude::*;

    fn counts(produced: usize, replayed: usize, stubbed: usize) -> PdfReplayCounts {
        PdfReplayCounts {
            produced,
            replayed,
            stubbed,
        }
    }

    fn export(page: PdfPageReplayStats) -> PdfExport {
        PdfExport {
            bytes: b"%PDF-1.7\n%%EOF".to_vec(),
            pages: 1,
            font_path: None,
            replay: vec![page],
            diagnostics: Vec::new(),
        }
    }

    fn paragraph(content: Vec<Inline>) -> Paragraph {
        Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn tiny_bmp() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"BM");
        bytes.extend_from_slice(&(58u32).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&54u32.to_le_bytes());
        bytes.extend_from_slice(&40u32.to_le_bytes());
        bytes.extend_from_slice(&1i32.to_le_bytes());
        bytes.extend_from_slice(&1i32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&24u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&2835i32.to_le_bytes());
        bytes.extend_from_slice(&2835i32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 255, 0]);
        bytes
    }

    #[test]
    fn accepts_only_balanced_non_stubbed_own_pdf_replay() {
        let preflight = preflight(&export(PdfPageReplayStats {
            page_index: 0,
            text: counts(2, 2, 0),
            table_geometry: counts(3, 3, 0),
            image: counts(1, 1, 0),
            equation: counts(1, 1, 0),
            chart: counts(1, 1, 0),
        }))
        .unwrap();
        assert_eq!(preflight.pages, 1);
        assert_eq!(preflight.table_geometry_ops, 3);
        assert_eq!(preflight.equation_ops, 1);
        assert_eq!(preflight.chart_ops, 1);
    }

    #[test]
    fn production_pdf_preflight_covers_text_table_image_equation_chart_and_media() {
        let table = Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                row: 0,
                col: 0,
                row_span: 1,
                col_span: 1,
                blocks: vec![Block::Paragraph(paragraph(vec![Inline::Text(
                    "표 셀".into(),
                )]))],
                ..Default::default()
            }],
            col_widths: vec![9000],
            ..Default::default()
        };
        let image_paragraph = paragraph(vec![Inline::Image(ImageRef {
            bin_ref: "print-image".into(),
            width: 1800,
            height: 1800,
            treat_as_char: true,
        })]);
        let equation_paragraph = paragraph(vec![Inline::Equation(EquationRef {
                script: "x over 2".into(),
                font: "HYhwpEQ".into(),
                base_unit: 1000,
                baseline: 0,
                color: Color::default(),
                width: 3000,
                height: 1500,
                treat_as_char: true,
                version: "Equation Version 60".into(),
                rendered_svg: Some(
                    r##"<g><text x="1" y="12" font-size="12" fill="#000">x</text><line x1="0" y1="14" x2="12" y2="14" stroke="#000"/></g>"##.into(),
                ),
            })]);
        let chart_paragraph = paragraph(vec![Inline::Chart(ChartRef {
                width: 6000,
                height: 3600,
                treat_as_char: true,
                rendered_svg: Some(
                    r##"<g class="hwp-gen-chart"><rect x="0" y="0" width="30" height="18" fill="#fff"/><polyline points="0,16 10,4 20,12 30,2" fill="none" stroke="#06c"/></g>"##.into(),
                ),
            })]);
        let mut landscape = PageSetup::default();
        std::mem::swap(&mut landscape.width, &mut landscape.height);
        landscape.landscape = true;
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        doc.sections.push(Section {
            blocks: vec![
                Block::Paragraph(paragraph(vec![Inline::Text("인쇄 본문".into())])),
                Block::Table(table),
                Block::Paragraph(image_paragraph),
                Block::Paragraph(equation_paragraph),
                Block::Paragraph(chart_paragraph),
            ],
            ..Default::default()
        });
        doc.sections.push(Section {
            blocks: vec![Block::Paragraph(paragraph(vec![Inline::Text(
                "가로 편집 용지".into(),
            )]))],
            page: landscape,
            ..Default::default()
        });
        doc.bin_data.push(BinData {
            bin_ref: "print-image".into(),
            bytes: tiny_bmp(),
            kind: "bmp".into(),
        });

        let export =
            hwp_session::emit_pdf(&doc, Some("native print preflight".to_string())).unwrap();
        let checked = preflight(&export).unwrap();
        assert!(checked.pages >= 2, "section media changes remain paginated");
        assert!(checked.text_ops > 0);
        assert!(checked.table_geometry_ops > 0);
        assert!(checked.image_ops > 0);
        assert!(checked.equation_ops > 0);
        assert!(checked.chart_ops > 0);
    }

    #[test]
    fn rejects_silent_loss_stubbed_objects_and_capability_diagnostics() {
        let mut unbalanced = PdfPageReplayStats::default();
        unbalanced.text = counts(1, 0, 0);
        assert_eq!(
            preflight(&export(unbalanced)).unwrap_err(),
            "PRINT_REPLAY_UNBALANCED:text"
        );

        let mut stubbed = PdfPageReplayStats::default();
        stubbed.equation = counts(1, 0, 1);
        assert_eq!(
            preflight(&export(stubbed)).unwrap_err(),
            "PRINT_REPLAY_DEGRADED:equation"
        );

        let mut diagnostic = export(PdfPageReplayStats::default());
        diagnostic.diagnostics.push(PdfCapabilityDiagnostic {
            page_index: 0,
            op_index: 0,
            kind: "chart".into(),
            code: "svg.element.unsupported:test".into(),
        });
        assert_eq!(
            preflight(&diagnostic).unwrap_err(),
            "PRINT_CAPABILITY_DIAGNOSTIC:chart:svg.element.unsupported:test"
        );
    }

    #[test]
    fn rejects_invalid_container_page_count_and_page_order() {
        let mut invalid = export(PdfPageReplayStats::default());
        invalid.bytes = b"not pdf".to_vec();
        assert_eq!(
            preflight(&invalid).unwrap_err(),
            "PRINT_PDF_CONTAINER_INVALID"
        );

        let mut wrong_pages = export(PdfPageReplayStats::default());
        wrong_pages.pages = 2;
        assert_eq!(
            preflight(&wrong_pages).unwrap_err(),
            "PRINT_PAGE_ACCOUNTING_INVALID"
        );

        let mut wrong_order = PdfPageReplayStats::default();
        wrong_order.page_index = 1;
        assert_eq!(
            preflight(&export(wrong_order)).unwrap_err(),
            "PRINT_PAGE_ORDER_INVALID"
        );
    }
}
