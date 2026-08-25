//! Content-free differential evidence over [`PlacedDoc`](crate::PlacedDoc).
//!
//! The comparator deliberately observes only opaque ordinals, counts, payload-equality booleans,
//! and bounded coordinate buckets. It never records glyph text, font names, image references,
//! document metadata, or source provenance. Both inputs must already have passed through the same
//! shared typesetter; this module is diagnostic-only and is not a fallback or an equivalence gate.

use crate::{PlacedDoc, PlacedPage};

/// A bounded summary for one typed placement category on one page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GeometryDeltaSummary {
    pub candidate_count: usize,
    pub oracle_count: usize,
    pub paired_count: usize,
    pub exact_pairs: usize,
    /// Same coordinates but different non-identifying payload (for example glyph style/content,
    /// block kind, cell address, or line style). The payload itself is never retained.
    pub payload_mismatches: usize,
    pub candidate_only: usize,
    pub oracle_only: usize,
    pub non_finite_pairs: usize,
    pub changed_sub_hwpunit: usize,
    pub changed_within_one_px: usize,
    pub changed_within_ten_px: usize,
    pub changed_over_ten_px: usize,
    pub max_abs_delta_hwpunit_ceil: u64,
    /// First opaque ordinal that is not exact, including a one-sided tail.
    pub first_changed_ordinal: Option<usize>,
    /// Coordinate slot (not a source field or value) responsible for the maximum absolute delta.
    pub max_delta_coordinate_ordinal: Option<usize>,
}

impl GeometryDeltaSummary {
    pub fn is_exact(&self) -> bool {
        self.candidate_count == self.oracle_count
            && self.paired_count == self.exact_pairs
            && self.payload_mismatches == 0
            && self.non_finite_pairs == 0
    }
}

/// Per-page categories. Decoration glyphs are identified only by their baseline falling outside
/// the page's body box; no character or semantic source is exposed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PagePlacementDelta {
    pub page_ordinal: usize,
    pub page_box: GeometryDeltaSummary,
    pub decoration_glyphs: GeometryDeltaSummary,
    pub body_glyphs: GeometryDeltaSummary,
    pub blocks: GeometryDeltaSummary,
    pub tables: GeometryDeltaSummary,
    pub cells: GeometryDeltaSummary,
    pub rects: GeometryDeltaSummary,
    pub lines: GeometryDeltaSummary,
    pub images: GeometryDeltaSummary,
}

/// Document-level result. Page count mismatch is kept separate so missing pages cannot accidentally
/// disappear into empty per-page categories.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlacedDocDeltaReport {
    pub candidate_pages: usize,
    pub oracle_pages: usize,
    pub pages: Vec<PagePlacementDelta>,
}

impl PlacedDocDeltaReport {
    pub fn is_exact(&self) -> bool {
        self.candidate_pages == self.oracle_pages
            && self.pages.iter().all(|page| {
                page.page_box.is_exact()
                    && page.decoration_glyphs.is_exact()
                    && page.body_glyphs.is_exact()
                    && page.blocks.is_exact()
                    && page.tables.is_exact()
                    && page.cells.is_exact()
                    && page.rects.is_exact()
                    && page.lines.is_exact()
                    && page.images.is_exact()
            })
    }
}

#[derive(Clone)]
struct Fact {
    coordinates: Vec<f64>,
    payload: Vec<u64>,
}

fn color_key(color: hwp_model::types::Color) -> u64 {
    u64::from(color.r)
        | (u64::from(color.g) << 8)
        | (u64::from(color.b) << 16)
        | (u64::from(color.a) << 24)
}

fn extend_optional_text_key(payload: &mut Vec<u64>, value: Option<&str>) {
    payload.push(u64::from(value.is_some()));
    if let Some(value) = value {
        payload.push(value.len() as u64);
        payload.extend(value.as_bytes().iter().map(|byte| u64::from(*byte) + 1));
    }
}

fn summarize(candidate: Vec<Fact>, oracle: Vec<Fact>) -> GeometryDeltaSummary {
    let mut out = GeometryDeltaSummary {
        candidate_count: candidate.len(),
        oracle_count: oracle.len(),
        paired_count: candidate.len().min(oracle.len()),
        candidate_only: candidate.len().saturating_sub(oracle.len()),
        oracle_only: oracle.len().saturating_sub(candidate.len()),
        ..GeometryDeltaSummary::default()
    };
    for (ordinal, (left, right)) in candidate.iter().zip(&oracle).enumerate() {
        let finite = left
            .coordinates
            .iter()
            .chain(&right.coordinates)
            .all(|value| value.is_finite());
        if !finite || left.coordinates.len() != right.coordinates.len() {
            out.first_changed_ordinal.get_or_insert(ordinal);
            out.non_finite_pairs += 1;
            continue;
        }
        let coordinates_exact = left
            .coordinates
            .iter()
            .zip(&right.coordinates)
            .all(|(left, right)| left.to_bits() == right.to_bits());
        let payload_exact = left.payload == right.payload;
        if coordinates_exact && payload_exact {
            out.exact_pairs += 1;
            continue;
        }
        out.first_changed_ordinal.get_or_insert(ordinal);
        if !payload_exact {
            out.payload_mismatches += 1;
        }
        let (max_slot, max_delta) = left
            .coordinates
            .iter()
            .zip(&right.coordinates)
            .map(|(left, right)| (left - right).abs())
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .unwrap_or((0, 0.0));
        let max_delta_ceil = max_delta.ceil().min(u64::MAX as f64) as u64;
        if max_delta_ceil > out.max_abs_delta_hwpunit_ceil {
            out.max_abs_delta_hwpunit_ceil = max_delta_ceil;
            out.max_delta_coordinate_ordinal = Some(max_slot);
        }
        if max_delta < 1.0 {
            out.changed_sub_hwpunit += 1;
        } else if max_delta <= 75.0 {
            out.changed_within_one_px += 1;
        } else if max_delta <= 750.0 {
            out.changed_within_ten_px += 1;
        } else {
            out.changed_over_ten_px += 1;
        }
    }
    if out.first_changed_ordinal.is_none() && candidate.len() != oracle.len() {
        out.first_changed_ordinal = Some(out.paired_count);
    }
    out
}

fn glyph_facts(page: &PlacedPage, decoration: bool) -> Vec<Fact> {
    let body_bottom = page.height - page.margin_bottom;
    page.glyphs
        .iter()
        .filter(|glyph| {
            let outside_body = glyph.baseline < page.margin_top || glyph.baseline > body_bottom;
            outside_body == decoration
        })
        .map(|glyph| {
            let mut payload = vec![
                glyph.ch as u64,
                color_key(glyph.color),
                u64::from(glyph.underline),
                u64::from(glyph.bold),
                u64::from(glyph.italic),
            ];
            extend_optional_text_key(&mut payload, glyph.font.as_deref());
            extend_optional_text_key(&mut payload, glyph.cluster.as_deref());
            Fact {
                coordinates: vec![glyph.x, glyph.baseline, glyph.size],
                payload,
            }
        })
        .collect()
}

fn compare_page(ordinal: usize, candidate: &PlacedPage, oracle: &PlacedPage) -> PagePlacementDelta {
    let page_box = summarize(
        vec![Fact {
            coordinates: vec![
                candidate.width,
                candidate.height,
                candidate.margin_left,
                candidate.margin_top,
                candidate.margin_right,
                candidate.margin_bottom,
            ],
            payload: Vec::new(),
        }],
        vec![Fact {
            coordinates: vec![
                oracle.width,
                oracle.height,
                oracle.margin_left,
                oracle.margin_top,
                oracle.margin_right,
                oracle.margin_bottom,
            ],
            payload: Vec::new(),
        }],
    );
    let blocks = summarize(
        candidate
            .blocks
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![item.kind as u64],
            })
            .collect(),
        oracle
            .blocks
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![item.kind as u64],
            })
            .collect(),
    );
    let tables = summarize(
        candidate
            .tables
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![
                    item.rows as u64,
                    item.cols as u64,
                    item.first_row as u64,
                    item.last_row as u64,
                    item.cells.len() as u64,
                ],
            })
            .collect(),
        oracle
            .tables
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![
                    item.rows as u64,
                    item.cols as u64,
                    item.first_row as u64,
                    item.last_row as u64,
                    item.cells.len() as u64,
                ],
            })
            .collect(),
    );
    let cells = summarize(
        candidate
            .tables
            .iter()
            .flat_map(|table| &table.cells)
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![item.row as u64, item.col as u64],
            })
            .collect(),
        oracle
            .tables
            .iter()
            .flat_map(|table| &table.cells)
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![item.row as u64, item.col as u64],
            })
            .collect(),
    );
    let rects = summarize(
        candidate
            .rects
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![
                    u64::from(item.fill.is_some()),
                    item.fill.map_or(0, color_key),
                ],
            })
            .collect(),
        oracle
            .rects
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x, item.y, item.w, item.h],
                payload: vec![
                    u64::from(item.fill.is_some()),
                    item.fill.map_or(0, color_key),
                ],
            })
            .collect(),
    );
    let lines = summarize(
        candidate
            .lines
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x1, item.y1, item.x2, item.y2, item.width],
                payload: vec![item.style as u64, color_key(item.color)],
            })
            .collect(),
        oracle
            .lines
            .iter()
            .map(|item| Fact {
                coordinates: vec![item.x1, item.y1, item.x2, item.y2, item.width],
                payload: vec![item.style as u64, color_key(item.color)],
            })
            .collect(),
    );
    let images = summarize(
        candidate
            .images
            .iter()
            .map(|item| {
                let mut payload = vec![u64::from(item.is_background)];
                extend_optional_text_key(&mut payload, Some(&item.bin_ref));
                extend_optional_text_key(&mut payload, item.svg.as_deref());
                Fact {
                    coordinates: vec![item.x, item.y, item.w, item.h],
                    payload,
                }
            })
            .collect(),
        oracle
            .images
            .iter()
            .map(|item| {
                let mut payload = vec![u64::from(item.is_background)];
                extend_optional_text_key(&mut payload, Some(&item.bin_ref));
                extend_optional_text_key(&mut payload, item.svg.as_deref());
                Fact {
                    coordinates: vec![item.x, item.y, item.w, item.h],
                    payload,
                }
            })
            .collect(),
    );

    PagePlacementDelta {
        page_ordinal: ordinal,
        page_box,
        decoration_glyphs: summarize(glyph_facts(candidate, true), glyph_facts(oracle, true)),
        body_glyphs: summarize(glyph_facts(candidate, false), glyph_facts(oracle, false)),
        blocks,
        tables,
        cells,
        rects,
        lines,
        images,
    }
}

/// Compare two positioned documents without retaining any source content or identifying metadata.
pub fn compare_placed_docs(candidate: &PlacedDoc, oracle: &PlacedDoc) -> PlacedDocDeltaReport {
    PlacedDocDeltaReport {
        candidate_pages: candidate.pages.len(),
        oracle_pages: oracle.pages.len(),
        pages: candidate
            .pages
            .iter()
            .zip(&oracle.pages)
            .enumerate()
            .map(|(ordinal, (candidate, oracle))| compare_page(ordinal, candidate, oracle))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockKind, PlacedBlock, PlacedGlyph, PlacedGlyphOrigin, PlacedImage};
    use hwp_model::types::Color;

    fn glyph(x: f64, baseline: f64, ch: char) -> PlacedGlyph {
        PlacedGlyph {
            x,
            baseline,
            ch,
            size: 1_000.0,
            color: Color::default(),
            underline: false,
            bold: false,
            italic: false,
            font: None,
            cluster: None,
            origin: PlacedGlyphOrigin::SourceText,
        }
    }

    fn page() -> PlacedPage {
        PlacedPage {
            width: 10_000.0,
            height: 20_000.0,
            margin_top: 2_000.0,
            margin_bottom: 2_000.0,
            ..PlacedPage::default()
        }
    }

    #[test]
    fn decoration_body_and_nontext_categories_do_not_collapse() {
        let mut candidate = page();
        candidate.glyphs = vec![glyph(100.0, 1_000.0, 'A'), glyph(100.0, 3_000.0, 'B')];
        candidate.images.push(PlacedImage {
            x: 10.0,
            y: 20.0,
            w: 30.0,
            h: 40.0,
            bin_ref: "must-not-be-observed".into(),
            svg: None,
            is_background: false,
            section: 99,
            block: 99,
        });
        let mut oracle = page();
        oracle.glyphs = vec![glyph(100.0, 3_000.0, 'B')];
        let report = compare_placed_docs(
            &PlacedDoc {
                pages: vec![candidate],
            },
            &PlacedDoc {
                pages: vec![oracle],
            },
        );
        assert_eq!(report.pages[0].decoration_glyphs.candidate_only, 1);
        assert_eq!(report.pages[0].body_glyphs.exact_pairs, 1);
        assert_eq!(report.pages[0].images.candidate_only, 1);
        assert!(!format!("{report:?}").contains("must-not-be-observed"));
    }

    #[test]
    fn ordinal_shift_repetition_and_nonfinite_values_fail_closed() {
        let block = |x| PlacedBlock {
            x,
            y: 3_000.0,
            w: 100.0,
            h: 100.0,
            section: 0,
            block: 0,
            kind: BlockKind::Paragraph,
        };
        let mut candidate = page();
        candidate.blocks = vec![block(10.0), block(10.0), block(f64::NAN)];
        let mut oracle = page();
        oracle.blocks = vec![block(10.0), block(11.0), block(10.0)];
        let report = compare_placed_docs(
            &PlacedDoc {
                pages: vec![candidate],
            },
            &PlacedDoc {
                pages: vec![oracle],
            },
        );
        let blocks = &report.pages[0].blocks;
        assert_eq!(blocks.exact_pairs, 1);
        assert_eq!(blocks.changed_within_one_px, 1);
        assert_eq!(blocks.non_finite_pairs, 1);
        assert!(!blocks.is_exact());
    }

    #[test]
    fn missing_pages_never_compare_as_exact() {
        let report = compare_placed_docs(
            &PlacedDoc {
                pages: vec![page()],
            },
            &PlacedDoc::default(),
        );
        assert!(report.pages.is_empty());
        assert!(!report.is_exact());
    }
}
