//! Controlled #102 fixture generator used by `scripts/pdf-svg-parity-check.py`.

use std::fs;
use std::path::PathBuf;

use hwp_export::pdf::{export_pdf, PdfOptions};
use hwp_model::layout::PaintOp;
use hwp_model::prelude::*;
use hwp_typeset::ApproxFontMetrics;

fn main() -> std::result::Result<(), String> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: svg_pdf_parity OUTPUT_DIR")?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;

    let doc = fixture_doc();
    let svgs = hwp_render::render_doc_svg(&doc, &ApproxFontMetrics);
    if svgs.len() != 1 {
        return Err(format!("fixture must stay one page, got {}", svgs.len()));
    }
    fs::write(output.join("own.svg"), &svgs[0]).map_err(|error| error.to_string())?;

    let pdf = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default())?;
    if pdf.pages != 1 {
        return Err(format!("PDF fixture must stay one page, got {}", pdf.pages));
    }
    if pdf
        .diagnostics
        .iter()
        .any(|d| d.kind == "equation" || d.kind == "chart")
    {
        return Err(format!(
            "unexpected SVG replay diagnostic: {:?}",
            pdf.diagnostics
        ));
    }
    fs::write(output.join("own.pdf"), pdf.bytes).map_err(|error| error.to_string())?;

    let trees = hwp_render::render_doc_trees(&doc, &ApproxFontMetrics);
    let mut boxes = String::from("kind\tx_px\ty_px\tw_px\th_px\n");
    for op in &trees[0].ops {
        if let PaintOp::Image {
            x,
            y,
            w,
            h,
            svg: Some(svg),
            ..
        } = op
        {
            let kind = if svg.contains("hwp-gen-chart") || svg.contains("hwp-ooxml-chart") {
                "chart"
            } else {
                "equation"
            };
            boxes.push_str(&format!(
                "{kind}\t{:.4}\t{:.4}\t{:.4}\t{:.4}\n",
                x / 75.0,
                y / 75.0,
                w / 75.0,
                h / 75.0
            ));
        }
    }
    if boxes.lines().count() != 3 {
        return Err("fixture must expose one equation and one chart box".into());
    }
    fs::write(output.join("boxes.tsv"), boxes).map_err(|error| error.to_string())?;
    Ok(())
}

fn fixture_doc() -> SemanticDoc {
    let mut doc = SemanticDoc::default();
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());

    let equation = EquationRef {
        script: "x over 2".into(),
        font: "HYhwpEQ".into(),
        base_unit: 1200,
        baseline: 0,
        color: Color {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        },
        width: 9000,
        height: 3600,
        version: "Equation Version 60".into(),
        rendered_svg: Some(
            r##"<g class="hwp-equation"><text x="8" y="20" font-size="18" font-style="italic" fill="#111">x</text><line x1="3" y1="25" x2="45" y2="25" stroke="#111" stroke-width="1.5"/><text x="18" y="43" font-size="16" fill="#111">2</text><path d="M58 8 Q70 24 58 42" fill="none" stroke="#0655c9" stroke-width="2" stroke-linecap="round"/></g>"##.into(),
        ),
    };
    let chart = ChartRef {
        width: 24000,
        height: 13500,
        rendered_svg: Some(
            r##"<g class="hwp-gen-chart" data-chart-type="bar"><rect x="0" y="0" width="320" height="180" fill="#fff" stroke="#ccc" stroke-width="1"/><line x1="35" y1="145" x2="300" y2="145" stroke="#777"/><rect x="60" y="85" width="38" height="60" fill="#4472c4"/><rect x="125" y="52" width="38" height="93" fill="#ed7d31"/><rect x="190" y="105" width="38" height="40" fill="#70ad47"/><polyline points="60,72 144,35 228,82" fill="none" stroke="#a50021" stroke-width="3" stroke-linejoin="round"/><circle cx="144" cy="35" r="4" fill="#a50021"/><text x="160" y="22" font-family="sans-serif" font-size="14" font-weight="700" text-anchor="middle" fill="#222">PDF parity</text></g>"##.into(),
        ),
    };

    let mut equation_paragraph = Paragraph::default();
    equation_paragraph.runs.push(Run {
        char_shape: 0,
        content: vec![Inline::Equation(equation)],
        ..Default::default()
    });
    let mut chart_paragraph = Paragraph::default();
    chart_paragraph.runs.push(Run {
        char_shape: 0,
        content: vec![Inline::Chart(chart)],
        ..Default::default()
    });
    doc.sections.push(Section {
        blocks: vec![
            Block::Paragraph(equation_paragraph),
            Block::Paragraph(chart_paragraph),
        ],
        ..Default::default()
    });
    doc
}
