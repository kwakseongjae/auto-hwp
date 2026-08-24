#![cfg(feature = "rhwp")]

use hwp_core::{hwp5_own_parser_eligibility, open_hwp5_own, Engine};
use hwp_model::document::{Block, Inline, Paragraph, SemanticDoc};
use hwp_model::prelude::{DocumentParser, SourceFormat};
use hwp_rhwp::RhwpEngine;
use hwp_typeset::{compare_placed_docs, place_doc, ApproxFontMetrics, PlacedDoc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    Body,
    Decoration,
    TableCell,
    TableCaption,
    Note,
}

fn paragraphs(doc: &SemanticDoc) -> Vec<(Scope, &Paragraph)> {
    fn visit<'a>(blocks: &'a [Block], scope: Scope, out: &mut Vec<(Scope, &'a Paragraph)>) {
        for block in blocks {
            match block {
                Block::Paragraph(paragraph) => {
                    out.push((scope, paragraph));
                    for run in &paragraph.runs {
                        for inline in &run.content {
                            if let Inline::Note(note) = inline {
                                visit(&note.body, Scope::Note, out);
                            }
                        }
                    }
                }
                Block::Table(table) => {
                    if let Some(caption) = &table.caption {
                        visit(&caption.blocks, Scope::TableCaption, out);
                    }
                    for cell in &table.cells {
                        visit(&cell.blocks, Scope::TableCell, out);
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    for section in &doc.sections {
        visit(&section.blocks, Scope::Body, &mut out);
        for decoration in &section.decorations {
            visit(&decoration.blocks, Scope::Decoration, &mut out);
        }
    }
    out
}

fn is_empty_run(run: &hwp_model::document::Run) -> bool {
    run.content.iter().all(|inline| match inline {
        Inline::Text(text) => text.is_empty(),
        _ => false,
    })
}

fn same_number(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits()
}

fn same_page_and_block_geometry(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    left.pages.len() == right.pages.len()
        && left.pages.iter().zip(&right.pages).all(|(left, right)| {
            same_number(left.width, right.width)
                && same_number(left.height, right.height)
                && left.blocks.len() == right.blocks.len()
                && left.blocks.iter().zip(&right.blocks).all(|(left, right)| {
                    left.kind == right.kind
                        && same_number(left.x, right.x)
                        && same_number(left.y, right.y)
                        && same_number(left.w, right.w)
                        && same_number(left.h, right.h)
                })
        })
}

fn same_table_geometry(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    left.pages.iter().zip(&right.pages).all(|(left, right)| {
        left.tables.len() == right.tables.len()
            && left.tables.iter().zip(&right.tables).all(|(left, right)| {
                same_number(left.x, right.x)
                    && same_number(left.y, right.y)
                    && same_number(left.w, right.w)
                    && same_number(left.h, right.h)
                    && left.first_row == right.first_row
                    && left.last_row == right.last_row
                    && left.cells.len() == right.cells.len()
                    && left.cells.iter().zip(&right.cells).all(|(left, right)| {
                        left.row == right.row
                            && left.col == right.col
                            && same_number(left.x, right.x)
                            && same_number(left.y, right.y)
                            && same_number(left.w, right.w)
                            && same_number(left.h, right.h)
                    })
            })
    })
}

fn same_rect_geometry(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    left.pages.iter().zip(&right.pages).all(|(left, right)| {
        left.rects.len() == right.rects.len()
            && left.rects.iter().zip(&right.rects).all(|(left, right)| {
                same_number(left.x, right.x)
                    && same_number(left.y, right.y)
                    && same_number(left.w, right.w)
                    && same_number(left.h, right.h)
            })
    })
}

fn same_line_geometry(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    left.pages.iter().zip(&right.pages).all(|(left, right)| {
        left.lines.len() == right.lines.len()
            && left.lines.iter().zip(&right.lines).all(|(left, right)| {
                same_number(left.x1, right.x1)
                    && same_number(left.y1, right.y1)
                    && same_number(left.x2, right.x2)
                    && same_number(left.y2, right.y2)
                    && same_number(left.width, right.width)
            })
    })
}

fn same_flow_geometry(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    same_page_and_block_geometry(left, right)
        && same_table_geometry(left, right)
        && same_rect_geometry(left, right)
        && same_line_geometry(left, right)
}

fn same_glyph_paint(left: &PlacedDoc, right: &PlacedDoc) -> bool {
    left.pages.iter().zip(&right.pages).all(|(left, right)| {
        left.glyphs.len() == right.glyphs.len()
            && left.glyphs.iter().zip(&right.glyphs).all(|(left, right)| {
                left.ch == right.ch
                    && same_number(left.x, right.x)
                    && same_number(left.baseline, right.baseline)
                    && same_number(left.size, right.size)
                    && left.color == right.color
                    && left.underline == right.underline
                    && left.bold == right.bold
                    && left.italic == right.italic
                    && left.font == right.font
                    && left.cluster == right.cluster
            })
    })
}

#[test]
fn benchmark_empty_run_deltas_are_content_free_and_layout_classified() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let candidate = open_hwp5_own(&bytes).unwrap();
    let oracle = RhwpEngine::new().parse(&bytes, SourceFormat::Hwp5).unwrap();
    let production = Engine::open(&bytes).unwrap();
    let candidate_paragraphs = paragraphs(&candidate);
    let oracle_paragraphs = paragraphs(&oracle);
    assert_eq!(candidate_paragraphs.len(), oracle_paragraphs.len());

    let mut deltas = Vec::new();
    for (ordinal, ((candidate_scope, candidate_para), (oracle_scope, oracle_para))) in
        candidate_paragraphs
            .iter()
            .zip(&oracle_paragraphs)
            .enumerate()
    {
        assert_eq!(candidate_scope, oracle_scope);
        let candidate_empty: Vec<_> = candidate_para
            .runs
            .iter()
            .enumerate()
            .filter(|(_, run)| is_empty_run(run))
            .collect();
        let oracle_empty = oracle_para
            .runs
            .iter()
            .filter(|run| is_empty_run(run))
            .count();
        if candidate_empty.len() != oracle_empty {
            let visible = candidate_para.runs.iter().any(|run| {
                run.content.iter().any(|inline| match inline {
                    Inline::Text(text) => !text.is_empty(),
                    _ => true,
                })
            });
            let shapes: Vec<_> = candidate_empty
                .iter()
                .map(|(run_ordinal, run)| {
                    (
                        *run_ordinal,
                        candidate
                            .char_shapes
                            .get(run.char_shape)
                            .map(|shape| shape.height)
                            .unwrap_or_default(),
                    )
                })
                .collect();
            deltas.push((ordinal, candidate_scope, visible, shapes, oracle_empty));
        }
    }

    assert_eq!(deltas.len(), 6);
    assert_eq!(
        deltas
            .iter()
            .filter(|(_, _, visible, _, _)| *visible)
            .count(),
        5
    );
    assert_eq!(
        deltas
            .iter()
            .map(|(_, _, _, shapes, oracle_empty)| shapes.len() - oracle_empty)
            .sum::<usize>(),
        6
    );

    let report = hwp5_own_parser_eligibility(&bytes).unwrap();
    let comparison = report.comparison.unwrap();
    assert!(comparison.empty_run_typography_equivalent);
    assert_eq!(comparison.empty_run_typography.len(), 6);
    let public = serde_json::to_string(&comparison).unwrap();
    assert!(!public.contains("benchmark.hwp"));
    assert!(!public.contains("BodyText"));

    let candidate_placed = place_doc(&candidate, &ApproxFontMetrics);
    let oracle_placed = place_doc(&oracle, &ApproxFontMetrics);
    let production_placed = place_doc(&production, &ApproxFontMetrics);
    let typed_delta = compare_placed_docs(&candidate_placed, &oracle_placed);
    assert_eq!(candidate_placed.pages.len(), 8);
    assert_eq!(candidate_placed.pages.len(), oracle_placed.pages.len());
    for (candidate_page, oracle_page) in candidate_placed.pages.iter().zip(&oracle_placed.pages) {
        assert_eq!(candidate_page.blocks.len(), oracle_page.blocks.len());
        assert_eq!(candidate_page.tables.len(), oracle_page.tables.len());
        assert_eq!(candidate_page.rects.len(), oracle_page.rects.len());
        assert_eq!(candidate_page.lines.len(), oracle_page.lines.len());
    }
    assert!(same_page_and_block_geometry(
        &candidate_placed,
        &oracle_placed
    ));
    assert!(same_table_geometry(&candidate_placed, &oracle_placed));
    assert!(same_rect_geometry(&candidate_placed, &oracle_placed));
    assert!(same_line_geometry(&candidate_placed, &oracle_placed));
    assert_eq!(
        candidate_placed
            .pages
            .iter()
            .map(|page| page.glyphs.len())
            .sum::<usize>(),
        oracle_placed
            .pages
            .iter()
            .map(|page| page.glyphs.len())
            .sum::<usize>()
            + 24
    );
    assert!(candidate
        .sections
        .iter()
        .any(|section| section.page_number.is_some()));
    assert!(oracle
        .sections
        .iter()
        .all(|section| section.page_number.is_none()));
    assert!(typed_delta.pages.iter().all(|page| {
        page.page_box.is_exact()
            && page.decoration_glyphs.candidate_count == 3
            && page.decoration_glyphs.oracle_count == 0
            && page.decoration_glyphs.candidate_only == 3
            && page.decoration_glyphs.first_changed_ordinal == Some(0)
    }));
    assert!(typed_delta.pages.iter().all(|page| {
        page.body_glyphs.is_exact()
            && page.blocks.is_exact()
            && page.tables.is_exact()
            && page.cells.is_exact()
            && page.rects.is_exact()
            && page.lines.is_exact()
            && page.images.is_exact()
    }));
    let production_delta = compare_placed_docs(&candidate_placed, &production_placed);
    assert!(production_delta.pages.iter().all(|page| {
        page.page_box.is_exact()
            && page.decoration_glyphs.is_exact()
            && page.body_glyphs.is_exact()
            && page.blocks.is_exact()
            && page.tables.is_exact()
            && page.cells.is_exact()
            && page.rects.is_exact()
            && page.lines.is_exact()
            && page.images.is_exact()
    }));
    let typed_public = format!("{typed_delta:?}");
    assert!(!typed_public.contains("benchmark.hwp"));
    assert!(!typed_public.contains("BodyText"));

    let mut candidate_without_page_number = candidate.clone();
    for section in &mut candidate_without_page_number.sections {
        section.page_number = None;
    }
    let candidate_without_page_number_placed =
        place_doc(&candidate_without_page_number, &ApproxFontMetrics);
    let page_number_delta =
        compare_placed_docs(&candidate_placed, &candidate_without_page_number_placed);
    assert!(page_number_delta.pages.iter().all(|page| {
        page.decoration_glyphs.candidate_only == 3
            && page.body_glyphs.is_exact()
            && page.blocks.is_exact()
            && page.tables.is_exact()
            && page.cells.is_exact()
            && page.rects.is_exact()
            && page.lines.is_exact()
            && page.images.is_exact()
    }));

    let mut normalized = candidate.clone();
    hwp_hwp5::normalize_empty_runs_for_layout_evidence(&mut normalized);
    let normalized_placed = place_doc(&normalized, &ApproxFontMetrics);
    assert!(same_flow_geometry(&candidate_placed, &normalized_placed));
    assert!(same_glyph_paint(&candidate_placed, &normalized_placed));
}
