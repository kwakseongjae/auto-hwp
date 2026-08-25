use cfb::CompoundFile;
use hwp_hwp5::{Error, OwnHwp5Parser, HWP_SIGNATURE};
use hwp_model::document::Block;
use std::io::{Cursor, Write};

const TAG_DOCUMENT_PROPERTIES: u16 = 0x10;
const TAG_ID_MAPPINGS: u16 = 0x11;
const TAG_FACE_NAME: u16 = 0x13;
const TAG_BORDER_FILL: u16 = 0x14;
const TAG_CHAR_SHAPE: u16 = 0x15;
const TAG_PARA_SHAPE: u16 = 0x19;
const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_TEXT: u16 = 0x43;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_PARA_LINE_SEG: u16 = 0x45;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_LIST_HEADER: u16 = 0x48;
const TAG_PAGE_DEF: u16 = 0x49;
const TAG_FOOTNOTE_SHAPE: u16 = 0x4a;
const TAG_TABLE: u16 = 0x4d;
const CTRL_SECTION_DEF: u32 = u32::from_be_bytes(*b"secd");
const CTRL_PAGE_NUM_POS: u32 = u32::from_be_bytes(*b"pgnp");
const CTRL_NEW_NUMBER: u32 = u32::from_be_bytes(*b"nwno");
const CTRL_TABLE: u32 = u32::from_be_bytes(*b"tbl ");

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Landscape,
    NoBodyBox,
    BadLineCount,
    BadLineBoundary,
    BadLineLength,
    OversizeLineGeometry,
    ZeroHeightLine,
    VisibleLineGeometry,
    MultiLineGeometry,
    UnsupportedSectionChild,
    DuplicatePageDef,
    BadControlFrame,
    UnsupportedBinding,
    Column2,
    ColumnUnequal,
    BadColumnPayload,
    BadColumnTrailingGap,
    BadColumnDirection,
    BadColumnKind,
    ColumnBreakWithoutDefinition,
    MidSectionSeparator,
    PageNumber,
    PageNumberMultiSection,
    BadPageNumberLength,
    BadPageNumberAttr,
    BadPageNumberPosition,
    BadPageNumberFormat,
    BadPageNumberSurrogate,
    BadPageNumberUserSymbol,
    NewNumber,
    NewNumberMultiSection,
    BadNewNumberLength,
    BadNewNumberAttr,
    BadNewNumberType,
    BadNewNumberZero,
    NewNumberWithoutPageNumber,
    DuplicateNewNumber,
    DuplicatePageNumber,
    IdempotentPageNumberControls,
    Table,
    TableTerminatorCharShape,
    TableBadTerminatorShapeBoundary,
    TableBadTerminatorShapeReference,
    TableBadDeclaredTerminatorShapeCount,
    SixParagraphTable,
    SixParagraphBadWidthReference,
    SixParagraphBadGeometry,
    SixParagraphBadExtension,
    SevenParagraphTable,
    BadTableAttr,
    BadTableTopology,
    BadTableGeometry,
    BadTableCellAlign,
    BadTableBorderRef,
    LargeTable,
    LargeTableBadCellCount,
    LargeTableExtraCell,
    LargeTableBadSpan,
    LargeTableBadWidth,
    LargeTableBadParagraphCount,
    LargeTableBadRowHeight,
    LargeTableBadWidthRef,
    LargeTableBadCellOrder,
    MultiTable,
    MultiTableMissingMarker,
    MultiTableExtraMarker,
    MultiTableVisibleText,
    MultiTableBadCellFlag,
    MultiTableStrayChild,
    MultiTableThirdControl,
}

#[derive(Clone, Copy)]
enum NestedTableMutation {
    None,
    BadAttribute,
    BadRowCellCount,
    BadSpan,
    BadWidth,
    BadListExtra,
    MissingNestedTable,
    TooDeep,
}

#[derive(Clone, Copy)]
enum EightByFiveMutation {
    None,
    BadAttribute,
    BadRowCellCount,
    BadRowSpan,
    BadLayoutWidthDelta,
    BadWidthReference,
    MissingNestedTable,
    WrongNestedPosition,
    BadStaleNestedHeight,
}

#[derive(Clone, Copy)]
enum OneByTwoMutation {
    None,
    BadCommonAttribute,
    BadTableAttribute,
    BadRowCellCount,
    BadWidth,
    BadWidthReference,
    BadCellOrder,
    BadListExtension,
}

#[derive(Clone, Copy)]
enum SixByFourMutation {
    None,
    AllBodyWidthReferences,
    BadCommonAttribute,
    BadTableAttribute,
    BadRowCellCount,
    BadWidth,
    BadRowHeight,
    BadParagraphCount,
    BadWidthReference,
    BadAllBodyWidthReference,
    BadCellOrder,
    BadListExtension,
}

#[derive(Clone, Copy)]
enum CaptionedTableMutation {
    None,
    BadCaptionDirection,
    BadCaptionGap,
    BadCaptionReserved,
    MissingCaptionParagraph,
    ExtraCaptionParagraph,
    BadTableAttribute,
    BadRowCellCount,
    BadWidthReference,
    BadListExtension,
    BadGridGeometry,
    BadCellBorder,
}

#[derive(Clone, Copy)]
enum PlainFourByFiveMutation {
    None,
    BadCommonWidth,
    BadTableAttribute,
    BadTableBorder,
    BadRowCellCount,
    BadCellSpan,
    BadWidthReference,
    BadListExtension,
    BadGridGeometry,
    BadParagraphCount,
    BadCellPadding,
    BadCellBorder,
}

#[derive(Clone, Copy)]
enum SevenByThreeMutation {
    None,
    BadCommonAttribute,
    BadTableAttribute,
    BadRowCellCount,
    BadWidth,
    BadRowHeight,
    BadSpanHeight,
    BadParagraphCount,
    BadWidthReference,
    BadCellOrder,
    BadListExtension,
}

#[test]
fn parses_page_setup_and_blank_source_line_metrics() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::None))
        .unwrap();
    let page = doc.sections[0].page;
    assert_eq!((page.width, page.height), (59_528, 84_188));
    assert_eq!((page.margin_left, page.margin_right), (8_504, 8_504));
    assert_eq!((page.margin_top, page.margin_bottom), (5_669, 4_252));
    assert_eq!((page.margin_header, page.margin_footer), (4_252, 4_252));
    assert_eq!(page.margin_gutter, 0);
    assert!(!page.landscape);

    let Block::Paragraph(blank) = &doc.sections[0].blocks[1] else {
        panic!("expected blank paragraph")
    };
    assert_eq!(blank.source_line_metrics.len(), 1);
    assert_eq!(blank.source_line_metrics[0].height, 1_500);
    assert_eq!(blank.source_line_metrics[0].text_height, 1_200);
    assert_eq!(blank.source_line_metrics[0].baseline, 900);
    assert_eq!(blank.source_line_geometry.len(), 1);
    let source = blank.source_line_geometry[0];
    assert_eq!(source.vertical_pos, 100);
    assert_eq!(source.height, 1_500);
    assert_eq!(source.text_height, 1_200);
    assert_eq!(source.baseline, 900);
    assert_eq!(source.line_spacing, 300);
    assert_eq!(source.column_start, 0);
    assert_eq!(source.segment_width, 40_000);
}

#[test]
fn preserves_nonempty_line_geometry_without_promoting_it_to_layout_metrics() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::VisibleLineGeometry))
        .unwrap();
    let Block::Paragraph(paragraph) = &doc.sections[0].blocks[1] else {
        panic!("expected visible paragraph")
    };
    assert!(paragraph.source_line_metrics.is_empty());
    assert_eq!(paragraph.source_line_geometry.len(), 1);
    assert_eq!(paragraph.source_line_geometry[0].baseline, 900);
}

#[test]
fn preserves_multiple_source_lines_as_diagnostic_ambiguity() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::MultiLineGeometry))
        .unwrap();
    let Block::Paragraph(paragraph) = &doc.sections[0].blocks[1] else {
        panic!("expected visible paragraph")
    };
    assert!(paragraph.source_line_metrics.is_empty());
    assert_eq!(paragraph.source_line_geometry.len(), 2);
    assert_eq!(paragraph.source_line_geometry[0].vertical_pos, 100);
    assert_eq!(paragraph.source_line_geometry[1].vertical_pos, 1_600);
}

#[test]
fn preserves_hwp5_landscape_flag_without_pre_swapping_paper() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::Landscape))
        .unwrap();
    let page = doc.sections[0].page;
    assert_eq!((page.width, page.height), (59_528, 84_188));
    assert!(page.landscape);
}

#[test]
fn rejects_page_margins_that_remove_the_body_box() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::NoBodyBox)),
        Err(Error::MalformedRecord {
            tag: TAG_PAGE_DEF,
            section: Some(0),
            reason: "PAGE_DEF margins leave no positive body box",
            ..
        })
    ));
}

#[test]
fn enforces_declared_line_segment_count() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineCount)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "PARA_HEADER line-segment count differs from PARA_LINE_SEG",
            ..
        })
    ));
}

#[test]
fn rejects_line_start_outside_a_scalar_or_control_boundary() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineBoundary)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_LINE_SEG,
            section: Some(0),
            reason: "PARA_LINE_SEG text start is not a scalar/control boundary",
            ..
        })
    ));
}

#[test]
fn zero_height_line_segments_are_non_authoritative() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::ZeroHeightLine))
        .unwrap();
    let Block::Paragraph(blank) = &doc.sections[0].blocks[1] else {
        panic!("expected blank paragraph")
    };
    assert!(blank.source_line_metrics.is_empty());
    assert!(blank.source_line_geometry.is_empty());
}

#[test]
fn rejects_line_geometry_outside_the_bounded_range() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::OversizeLineGeometry)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_LINE_SEG,
            section: Some(0),
            reason: "PARA_LINE_SEG geometry exceeds the bounded range",
            ..
        })
    ));
}

#[test]
fn refuses_unsupported_section_children_with_a_content_free_span() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::UnsupportedSectionChild)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_FOOTNOTE_SHAPE,
            section: 0,
            ..
        })
    ));
}

#[test]
fn rejects_duplicate_page_def_records() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::DuplicatePageDef)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_PAGE_DEF,
            section: 0,
            ..
        })
    ));
}

#[test]
fn rejects_invalid_extended_control_framing() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadControlFrame)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_TEXT,
            section: Some(0),
            reason: "PARA_TEXT section control framing is invalid",
            ..
        })
    ));
}

#[test]
fn refuses_binding_modes_until_page_parity_is_owned() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::UnsupportedBinding)),
        Err(Error::MalformedRecord {
            tag: TAG_PAGE_DEF,
            section: Some(0),
            reason: "PAGE_DEF binding mode is not yet supported",
            ..
        })
    ));
}

#[test]
fn rejects_non_integral_line_segment_payload() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineLength)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_LINE_SEG,
            section: Some(0),
            reason: "PARA_LINE_SEG length is not a multiple of 36",
            ..
        })
    ));
}

#[test]
fn parses_equal_width_column_definition_into_absolute_shared_geometry() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::Column2))
        .expect("owned column fixture parses");
    let Block::Paragraph(paragraph) = &doc.sections[0].blocks[0] else {
        panic!("expected paragraph")
    };
    let columns = paragraph
        .column_layout_before
        .as_ref()
        .expect("cold control becomes shared geometry");
    assert_eq!(columns.widths, vec![20_760, 20_760]);
    assert_eq!(columns.gaps, vec![1_000]);
    let separator = columns.separator.expect("separator parsed");
    assert_eq!(separator.style, hwp_model::document::LineStyle::Solid);
    assert_eq!(separator.color.r, 255);
    assert_eq!(separator.width_px, 0.5);
    assert_eq!(doc.sections[0].page.columns, 2);
}

#[test]
fn rejects_truncated_column_definition_without_partial_semantics() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadColumnPayload)),
        Err(Error::MalformedRecord {
            tag: TAG_CTRL_HEADER,
            section: Some(0),
            reason: "equal-width column definition is not exactly 16 bytes",
            ..
        })
    ));
}

#[test]
fn resolves_unequal_proportional_columns_without_leaking_raw_weights() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::ColumnUnequal))
        .expect("owned unequal column fixture parses");
    let Block::Paragraph(paragraph) = &doc.sections[0].blocks[0] else {
        panic!("expected paragraph")
    };
    let columns = paragraph.column_layout_before.as_ref().expect("columns");
    assert_eq!(columns.widths, vec![6_858, 13_716, 20_576]);
    assert_eq!(columns.gaps, vec![685, 685]);
    assert_eq!(
        columns.widths.iter().sum::<i32>() + columns.gaps.iter().sum::<i32>(),
        42_520,
        "absolute geometry exactly fills the page body"
    );
}

#[test]
fn rejects_hostile_unequal_tail_and_unknown_direction() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadColumnTrailingGap)),
        Err(Error::MalformedRecord {
            reason: "column definition has a trailing gap after the last column",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadColumnDirection)),
        Err(Error::MalformedRecord {
            reason: "column definition direction is not supported",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadColumnKind)),
        Err(Error::MalformedRecord {
            reason: "column distribution kind is not yet supported",
            ..
        })
    ));
}

#[test]
fn rejects_column_break_before_any_owned_column_zone() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::ColumnBreakWithoutDefinition)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "column break appears before an owned column definition",
            ..
        })
    ));
}

#[test]
fn rejects_mid_section_separator_without_owned_vertical_span() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MidSectionSeparator)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "column separator zone must begin with its section",
            ..
        })
    ));
}

#[test]
fn parses_page_number_position_into_source_neutral_decoration() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::PageNumber))
        .expect("owned page-number fixture parses");
    let number = doc.sections[0].page_number.expect("page number");
    assert_eq!(
        number.position,
        hwp_model::document::PageNumberPosition::BottomCenter
    );
    assert_eq!(number.format, hwp_model::document::PageNumberFormat::Digit);
    assert_eq!(
        (number.prefix, number.suffix, number.dash),
        (Some('['), Some(']'), Some('-'))
    );
}

#[test]
fn rejects_malformed_or_unowned_page_number_semantics() {
    for (mutation, reason) in [
        (
            Mutation::BadPageNumberLength,
            "page-number position is not exactly 16 bytes",
        ),
        (
            Mutation::BadPageNumberAttr,
            "page-number position has unknown attribute bits",
        ),
        (
            Mutation::BadPageNumberPosition,
            "page-number position is not supported",
        ),
        (
            Mutation::BadPageNumberFormat,
            "page-number format is not yet supported",
        ),
        (
            Mutation::BadPageNumberSurrogate,
            "page-number decoration contains a surrogate code unit",
        ),
        (
            Mutation::BadPageNumberUserSymbol,
            "page-number user-symbol semantics are not yet supported",
        ),
        (
            Mutation::DuplicatePageNumber,
            "page-number positions are duplicated with conflicting semantics",
        ),
    ] {
        assert!(matches!(
            OwnHwp5Parser::new().parse(&fixture(mutation)),
            Err(Error::MalformedRecord {
                tag: TAG_CTRL_HEADER,
                section: Some(0),
                reason: actual,
                ..
            }) if actual == reason
        ));
    }
}

#[test]
fn rejects_multi_section_page_number_until_inheritance_is_owned() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::PageNumberMultiSection)),
        Err(Error::MalformedRecord {
            tag: TAG_CTRL_HEADER,
            section: Some(0),
            reason: "multi-section page-number inheritance is not yet supported",
            ..
        })
    ));
}

#[test]
fn parses_page_number_restart_into_source_neutral_start() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::NewNumber))
        .expect("owned page-number restart fixture parses");
    assert_eq!(
        doc.sections[0]
            .page_number
            .expect("page-number decoration")
            .start
            .get(),
        7
    );
}

#[test]
fn collapses_exact_duplicate_page_number_controls_by_typed_equality() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::IdempotentPageNumberControls))
        .expect("identical pgnp/nwno records are idempotent");
    let number = doc.sections[0].page_number.expect("page number");
    assert_eq!(number.start.get(), 7);
    assert_eq!(
        number.position,
        hwp_model::document::PageNumberPosition::BottomCenter
    );
}

#[test]
fn rejects_malformed_or_unowned_new_number_semantics() {
    for (mutation, reason) in [
        (
            Mutation::BadNewNumberLength,
            "new-number control is not exactly 10 bytes",
        ),
        (
            Mutation::BadNewNumberAttr,
            "new-number control has unknown attribute bits",
        ),
        (
            Mutation::BadNewNumberType,
            "non-page new-number counter is not yet supported",
        ),
        (
            Mutation::BadNewNumberZero,
            "page-number restart must be nonzero",
        ),
        (
            Mutation::NewNumberWithoutPageNumber,
            "page-number restart requires an owned page-number position",
        ),
        (
            Mutation::DuplicateNewNumber,
            "page-number restarts are duplicated with conflicting semantics",
        ),
    ] {
        assert!(matches!(
            OwnHwp5Parser::new().parse(&fixture(mutation)),
            Err(Error::MalformedRecord {
                tag: TAG_CTRL_HEADER,
                section: Some(0),
                reason: actual,
                ..
            }) if actual == reason
        ));
    }
}

#[test]
fn rejects_multi_section_new_number_until_inheritance_is_owned() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::NewNumberMultiSection)),
        Err(Error::MalformedRecord {
            tag: TAG_CTRL_HEADER,
            section: Some(0),
            reason: "multi-section page-number inheritance is not yet supported",
            ..
        })
    ));
}

#[test]
fn owns_strict_inline_one_by_one_table_as_anchor_plus_shared_ir() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::Table))
        .expect("strict table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table), Block::Paragraph(_)] =
        doc.sections[0].blocks.as_slice()
    else {
        panic!("table host must become anchor + table block")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols), (1, 1));
    assert!(table.keep_together);
    assert_eq!(table.col_widths, vec![20_000]);
    assert_eq!(table.row_heights, vec![2_000]);
    assert_eq!(
        table.source_anchor_spacing_after, 0,
        "a host without a following source-adjacent table cannot claim its stored spacing"
    );
    assert_eq!(table.padding, Some([510, 510, 141, 141]));
    assert!(table.borders.iter().all(Option::is_some));
    let cell = &table.cells[0];
    assert_eq!(
        (cell.row, cell.col, cell.row_span, cell.col_span),
        (0, 0, 1, 1)
    );
    assert_eq!(cell.width, Some(20_000));
    assert_eq!(
        cell.padding, None,
        "width_ref low bit inherits table padding"
    );
    let Block::Paragraph(cell_paragraph) = &cell.blocks[0] else {
        panic!("cell owns one paragraph")
    };
    assert!(cell_paragraph
        .runs
        .iter()
        .any(|run| run.content.iter().any(
            |inline| matches!(inline, hwp_model::document::Inline::Text(text) if text == "A")
        )));
}

#[test]
fn owns_exact_terminator_char_shape_for_text_empty_control_host() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::TableTerminatorCharShape))
        .expect("control marker and terminator shape boundaries parse");
    let [Block::Paragraph(anchor), Block::Table(_), Block::Paragraph(_)] =
        doc.sections[0].blocks.as_slice()
    else {
        panic!("table host, table, and trailing blank paragraph expected")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!(anchor.runs.len(), 2);
    assert_eq!(
        anchor
            .runs
            .iter()
            .map(|run| run.char_shape)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(anchor.runs.iter().all(|run| run.content.is_empty()));
}

#[test]
fn strict_text_empty_control_host_rejects_bad_terminator_shape_boundaries_and_counts() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::TableBadTerminatorShapeBoundary)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_CHAR_SHAPE,
            section: Some(0),
            reason: "text-empty control host has invalid PARA_CHAR_SHAPE boundaries",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::TableBadTerminatorShapeReference)),
        Err(Error::InvalidReference {
            kind: "character shape",
            index: 2,
            pool_len: 2,
            section: Some(0),
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::TableBadDeclaredTerminatorShapeCount)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "PARA_HEADER character-shape count differs from PARA_CHAR_SHAPE",
            ..
        })
    ));
}

#[test]
fn strict_inline_table_rejects_unowned_attributes_topology_geometry_alignment_and_refs() {
    for mutation in [
        Mutation::BadTableAttr,
        Mutation::BadTableTopology,
        Mutation::BadTableGeometry,
        Mutation::BadTableCellAlign,
        Mutation::BadTableBorderRef,
    ] {
        assert!(OwnHwp5Parser::new().parse(&fixture(mutation)).is_err());
    }
}

#[test]
fn owns_exact_six_paragraph_one_by_one_cell() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::SixParagraphTable))
        .expect("exact six-paragraph cell parses");
    let Block::Table(table) = &doc.sections[0].blocks[1] else {
        panic!("table host must be followed by a shared table block")
    };
    assert_eq!((table.rows, table.cols, table.cells.len()), (1, 1, 1));
    assert_eq!(table.col_widths, vec![20_000]);
    assert_eq!(table.row_heights, vec![2_000]);
    assert_eq!(table.cells[0].width, Some(20_000));
    assert_eq!(table.cells[0].blocks.len(), 6);
    assert!(table.cells[0]
        .blocks
        .iter()
        .all(|block| matches!(block, Block::Paragraph(_))));
}

#[test]
fn six_paragraph_cell_rejects_unowned_count_pairing_and_geometry() {
    for mutation in [
        Mutation::SevenParagraphTable,
        Mutation::SixParagraphBadWidthReference,
        Mutation::SixParagraphBadGeometry,
        Mutation::SixParagraphBadExtension,
    ] {
        assert!(
            OwnHwp5Parser::new().parse(&fixture(mutation)).is_err(),
            "hostile six-paragraph mutation must fail closed"
        );
    }
}

#[test]
fn owns_strict_inline_ten_by_two_table_with_horizontal_merges_and_multiple_paragraphs() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::LargeTable))
        .expect("strict 10x2 table fixture parses");
    let Block::Table(table) = &doc.sections[0].blocks[1] else {
        panic!("table host must be followed by a shared table block")
    };
    assert_eq!((table.rows, table.cols, table.cells.len()), (10, 2, 17));
    assert!(table.keep_together, "TABLE no-split attr reaches shared IR");
    assert_eq!(table.col_widths, vec![9_361, 38_552]);
    assert_eq!(table.row_heights.iter().sum::<i32>(), 65_409);
    assert_eq!(
        table
            .cells
            .iter()
            .filter(|cell| cell.col_span == 2)
            .map(|cell| cell.row)
            .collect::<Vec<_>>(),
        vec![0, 1, 5]
    );
    assert_eq!(table.cells[0].blocks.len(), 5);
    let Block::Paragraph(first) = &table.cells[0].blocks[0] else {
        panic!("cell content remains paragraph blocks")
    };
    assert!(
        first.runs.last().is_some_and(|run| run.content.is_empty()
            && run.char_shape != first.runs[0].char_shape),
        "paragraph-mark character shape remains as a terminal empty run"
    );
}

#[test]
fn strict_ten_by_two_table_rejects_hostile_counts_spans_geometry_and_width_refs() {
    for mutation in [
        Mutation::LargeTableBadCellCount,
        Mutation::LargeTableExtraCell,
        Mutation::LargeTableBadSpan,
        Mutation::LargeTableBadWidth,
        Mutation::LargeTableBadParagraphCount,
        Mutation::LargeTableBadRowHeight,
        Mutation::LargeTableBadWidthRef,
        Mutation::LargeTableBadCellOrder,
    ] {
        assert!(
            OwnHwp5Parser::new().parse(&fixture(mutation)).is_err(),
            "hostile mutation must fail closed"
        );
    }
}

#[test]
fn owns_two_ordered_tables_in_one_text_empty_host_and_cell_own_padding() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::MultiTable))
        .expect("bounded multi-table host parses");
    let [Block::Paragraph(anchor), Block::Table(first), Block::Table(second), Block::Paragraph(_)] =
        doc.sections[0].blocks.as_slice()
    else {
        panic!("host must lower to one anchor followed by both tables in source order")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((first.rows, first.cols, first.cells.len()), (10, 2, 17));
    assert_eq!((second.rows, second.cols, second.cells.len()), (1, 1, 1));
    assert_eq!(first.source_anchor_spacing_after, 0);
    assert_eq!(second.source_anchor_spacing_after, 0);
    assert_eq!(second.cells[0].blocks.len(), 4);
    assert_eq!(second.cells[0].padding, Some([283, 283, 141, 141]));
    assert_eq!(second.cells[0].width, Some(20_000));
}

#[test]
fn multi_table_host_rejects_marker_mismatch_visible_text_unknown_cell_bits_and_strays() {
    for mutation in [
        Mutation::MultiTableMissingMarker,
        Mutation::MultiTableExtraMarker,
    ] {
        assert!(matches!(
            OwnHwp5Parser::new().parse(&fixture(mutation)),
            Err(Error::MalformedRecord {
                tag: TAG_PARA_HEADER,
                reason: "PARA_TEXT structural markers do not match CTRL_HEADER records",
                ..
            })
        ));
    }
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MultiTableVisibleText)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            reason: "owned inline table host also contains visible text",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MultiTableBadCellFlag)),
        Err(Error::MalformedRecord {
            tag: TAG_LIST_HEADER,
            reason: "cell LIST_HEADER count, direction, alignment, or width reference is not owned",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MultiTableStrayChild)),
        Err(Error::MalformedRecord {
            tag: TAG_PAGE_DEF,
            reason: "owned TABLE has more active cells than its bounded topology",
            ..
        })
    ));
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MultiTableThirdControl)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_CTRL_HEADER,
            reason: "paragraphs with more than two table controls are not owned",
            ..
        })
    ));
}

#[test]
fn owns_exact_nine_by_eight_table_with_one_bounded_nested_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&nested_table_fixture(NestedTableMutation::None))
        .expect("strict 9x8 nested-table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (9, 8, 34));
    assert!(table.keep_together);
    assert!(
        !table.fixed_row_heights,
        "HWP5 TABLE page-break/repeat-header bits are not HWPX noAdjust"
    );
    assert_eq!(
        table.col_widths,
        vec![3_182, 6_810, 659, 8_082, 5_346, 10_534, 5_935, 7_435]
    );
    assert_eq!(table.row_heights.iter().sum::<i32>(), 24_072);
    let host = table
        .cells
        .iter()
        .find(|cell| (cell.row, cell.col, cell.col_span) == (1, 3, 5))
        .expect("exact nested-table host cell");
    let [Block::Paragraph(_), Block::Paragraph(nested_anchor), Block::Table(nested)] =
        host.blocks.as_slice()
    else {
        panic!("nested host paragraph must be followed by its table")
    };
    assert!(nested_anchor.is_table_anchor);
    assert_eq!((nested.rows, nested.cols, nested.cells.len()), (1, 1, 1));
}

#[test]
fn strict_nested_table_slice_rejects_hostile_attributes_topology_and_extensions() {
    for mutation in [
        NestedTableMutation::BadAttribute,
        NestedTableMutation::BadRowCellCount,
        NestedTableMutation::BadSpan,
        NestedTableMutation::BadWidth,
        NestedTableMutation::BadListExtra,
        NestedTableMutation::MissingNestedTable,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&nested_table_fixture(mutation))
                .is_err(),
            "hostile nested-table mutation must fail closed"
        );
    }
    assert!(matches!(
        OwnHwp5Parser::new().parse(&nested_table_fixture(NestedTableMutation::TooDeep)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_CTRL_HEADER,
            reason: "table nesting deeper than one level is not owned",
            ..
        })
    ));
}

#[test]
fn owns_exact_eight_by_five_rowspan_and_nine_bounded_nested_tables() {
    let doc = OwnHwp5Parser::new()
        .parse(&eight_by_five_fixture(EightByFiveMutation::None))
        .expect("strict 8x5 nested-table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (8, 5, 19));
    assert!(
        !table.keep_together,
        "row-boundary policy uses shared row fragmentation"
    );
    assert!(
        !table.fixed_row_heights,
        "HWP5 TABLE page-break/repeat-header bits are not HWPX noAdjust"
    );
    assert_eq!(table.col_widths, vec![7_667, 16_324, 3_879, 3_955, 16_324]);
    assert_eq!(
        table.row_heights,
        vec![5_012, 7_339, 10_169, 10_169, 10_169, 10_169, 11_921, 1_848]
    );
    assert_eq!(
        table
            .cells
            .iter()
            .filter(|cell| cell.row_span == 2)
            .map(|cell| (cell.row, cell.col, cell.width))
            .collect::<Vec<_>>(),
        vec![(6, 0, Some(7_667))]
    );
    assert_eq!(
        table
            .cells
            .iter()
            .filter(|cell| cell
                .blocks
                .iter()
                .any(|block| matches!(block, Block::Table(_))))
            .count(),
        9
    );
    let corrected = table
        .cells
        .iter()
        .find(|cell| (cell.row, cell.col, cell.col_span) == (6, 3, 2))
        .expect("exact stale-width slot");
    assert_eq!(corrected.width, Some(20_279));
}

#[test]
fn strict_eight_by_five_slice_rejects_hostile_topology_widths_and_nesting() {
    for mutation in [
        EightByFiveMutation::BadAttribute,
        EightByFiveMutation::BadRowCellCount,
        EightByFiveMutation::BadRowSpan,
        EightByFiveMutation::BadLayoutWidthDelta,
        EightByFiveMutation::BadWidthReference,
        EightByFiveMutation::MissingNestedTable,
        EightByFiveMutation::WrongNestedPosition,
        EightByFiveMutation::BadStaleNestedHeight,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&eight_by_five_fixture(mutation))
                .is_err(),
            "hostile 8x5 mutation must fail closed"
        );
    }
}

#[test]
fn owns_exact_column_relative_one_by_two_header_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&one_by_two_fixture(OneByTwoMutation::None))
        .expect("strict column-relative 1x2 table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (1, 2, 2));
    assert!(table.keep_together, "no-split one-row table stays atomic");
    assert!(!table.fixed_row_heights);
    assert_eq!(table.col_widths, vec![39_903, 2_261]);
    assert_eq!(table.row_heights, vec![3_005]);
    assert_eq!(table.padding, Some([140, 140, 140, 140]));
    assert_eq!(
        table
            .cells
            .iter()
            .map(|cell| (cell.row, cell.col, cell.width))
            .collect::<Vec<_>>(),
        vec![(0, 0, Some(39_903)), (0, 1, Some(2_261))]
    );
}

#[test]
fn strict_one_by_two_slice_rejects_hostile_flags_topology_widths_and_extensions() {
    for mutation in [
        OneByTwoMutation::BadCommonAttribute,
        OneByTwoMutation::BadTableAttribute,
        OneByTwoMutation::BadRowCellCount,
        OneByTwoMutation::BadWidth,
        OneByTwoMutation::BadWidthReference,
        OneByTwoMutation::BadCellOrder,
        OneByTwoMutation::BadListExtension,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&one_by_two_fixture(mutation))
                .is_err(),
            "hostile 1x2 mutation must fail closed"
        );
    }
}

#[test]
fn owns_exact_six_by_four_atomic_full_grid_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&six_by_four_fixture(SixByFourMutation::None))
        .expect("strict 6x4 full-grid table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (6, 4, 24));
    assert!(table.keep_together, "no-split table stays atomic");
    assert!(!table.fixed_row_heights);
    assert_eq!(table.col_widths, vec![3_238, 14_908, 11_795, 18_021]);
    assert_eq!(
        table.row_heights,
        vec![1_946, 1_846, 1_846, 1_846, 1_846, 1_846]
    );
    assert_eq!(table.padding, Some([140, 140, 140, 140]));
    assert!(table
        .cells
        .iter()
        .enumerate()
        .all(|(index, cell)| (cell.row, cell.col) == (index / 4, index % 4)));
    assert!(table.cells.iter().all(|cell| {
        cell.row_span == 1
            && cell.col_span == 1
            && cell.blocks.len() == 1
            && matches!(cell.blocks[0], Block::Paragraph(_))
    }));
}

#[test]
fn owns_exact_six_by_four_all_body_width_reference_variant() {
    let doc = OwnHwp5Parser::new()
        .parse(&six_by_four_fixture(
            SixByFourMutation::AllBodyWidthReferences,
        ))
        .expect("strict all-body-reference 6x4 table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (6, 4, 24));
    assert_eq!(table.col_widths, vec![3_238, 14_908, 11_795, 18_021]);
    assert_eq!(
        table.row_heights,
        vec![1_946, 1_846, 1_846, 1_846, 1_846, 1_846]
    );
    assert!(table.cells.iter().all(|cell| cell.padding.is_none()));
}

#[test]
fn strict_six_by_four_slice_rejects_hostile_pairing_topology_geometry_and_extensions() {
    for mutation in [
        SixByFourMutation::BadCommonAttribute,
        SixByFourMutation::BadTableAttribute,
        SixByFourMutation::BadRowCellCount,
        SixByFourMutation::BadWidth,
        SixByFourMutation::BadRowHeight,
        SixByFourMutation::BadParagraphCount,
        SixByFourMutation::BadWidthReference,
        SixByFourMutation::BadAllBodyWidthReference,
        SixByFourMutation::BadCellOrder,
        SixByFourMutation::BadListExtension,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&six_by_four_fixture(mutation))
                .is_err(),
            "hostile 6x4 mutation must fail closed"
        );
    }
}

#[test]
fn owns_exact_top_captioned_four_by_five_full_grid_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&captioned_table_fixture(CaptionedTableMutation::None))
        .expect("strict captioned 4x5 full-grid table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (4, 5, 20));
    assert!(table.keep_together);
    assert!(!table.fixed_row_heights);
    assert_eq!(table.col_widths, vec![3_221, 6_593, 8_956, 21_855, 7_422]);
    assert_eq!(table.row_heights, vec![1_948, 1_848, 1_848, 1_848]);
    let caption = table
        .caption
        .as_ref()
        .expect("top caption reaches shared IR");
    assert_eq!(
        caption.position,
        hwp_model::document::TableCaptionPosition::Top
    );
    assert_eq!(
        (caption.width, caption.spacing, caption.max_width),
        (8_504, 850, 48_047)
    );
    assert!(!caption.include_margin);
    assert_eq!(caption.blocks.len(), 1);
    assert!(matches!(caption.blocks[0], Block::Paragraph(_)));
    assert!(table.cells.iter().enumerate().all(|(index, cell)| {
        (cell.row, cell.col, cell.row_span, cell.col_span, cell.width)
            == (
                index / 5,
                index % 5,
                1,
                1,
                Some(table.col_widths[index % 5]),
            )
            && cell.blocks.len() == 1
    }));
}

#[test]
fn strict_captioned_table_rejects_hostile_caption_topology_geometry_and_refs() {
    for mutation in [
        CaptionedTableMutation::BadCaptionDirection,
        CaptionedTableMutation::BadCaptionGap,
        CaptionedTableMutation::BadCaptionReserved,
        CaptionedTableMutation::MissingCaptionParagraph,
        CaptionedTableMutation::ExtraCaptionParagraph,
        CaptionedTableMutation::BadTableAttribute,
        CaptionedTableMutation::BadRowCellCount,
        CaptionedTableMutation::BadWidthReference,
        CaptionedTableMutation::BadListExtension,
        CaptionedTableMutation::BadGridGeometry,
        CaptionedTableMutation::BadCellBorder,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&captioned_table_fixture(mutation))
                .is_err(),
            "hostile captioned-table mutation must fail closed"
        );
    }
}

#[test]
fn owns_exact_plain_four_by_five_full_grid_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&plain_four_by_five_fixture(PlainFourByFiveMutation::None))
        .expect("strict plain 4x5 full-grid table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (4, 5, 20));
    assert!(table.caption.is_none());
    assert!(table.keep_together);
    assert!(!table.fixed_row_heights);
    assert_eq!(table.col_widths, vec![3_221, 9_238, 14_770, 12_223, 8_594]);
    assert_eq!(table.row_heights, vec![1_948, 1_848, 1_848, 1_848]);
    assert!(table.cells.iter().enumerate().all(|(index, cell)| {
        (cell.row, cell.col, cell.row_span, cell.col_span, cell.width)
            == (
                index / 5,
                index % 5,
                1,
                1,
                Some(table.col_widths[index % 5]),
            )
            && cell.blocks.len() == 1
            && matches!(cell.blocks[0], Block::Paragraph(_))
    }));
}

#[test]
fn strict_plain_four_by_five_rejects_hostile_pairing_topology_geometry_and_refs() {
    for mutation in [
        PlainFourByFiveMutation::BadCommonWidth,
        PlainFourByFiveMutation::BadTableAttribute,
        PlainFourByFiveMutation::BadTableBorder,
        PlainFourByFiveMutation::BadRowCellCount,
        PlainFourByFiveMutation::BadCellSpan,
        PlainFourByFiveMutation::BadWidthReference,
        PlainFourByFiveMutation::BadListExtension,
        PlainFourByFiveMutation::BadGridGeometry,
        PlainFourByFiveMutation::BadParagraphCount,
        PlainFourByFiveMutation::BadCellPadding,
        PlainFourByFiveMutation::BadCellBorder,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&plain_four_by_five_fixture(mutation))
                .is_err(),
            "hostile plain 4x5 mutation must fail closed"
        );
    }
}

#[test]
fn owns_exact_seven_by_three_merged_atomic_table() {
    let doc = OwnHwp5Parser::new()
        .parse(&seven_by_three_fixture(SevenByThreeMutation::None))
        .expect("strict 7x3 merged table fixture parses");
    let [Block::Paragraph(anchor), Block::Table(table)] = doc.sections[0].blocks.as_slice() else {
        panic!("table host must lower to one anchor and one table")
    };
    assert!(anchor.is_table_anchor);
    assert_eq!((table.rows, table.cols, table.cells.len()), (7, 3, 19));
    assert!(table.keep_together, "no-split table stays atomic");
    assert!(
        !table.fixed_row_heights,
        "HWP5 TABLE page-break/repeat-header bits keep row heights as floors"
    );
    assert_eq!(table.col_widths, vec![6_509, 31_215, 10_200]);
    assert_eq!(
        table.row_heights,
        vec![2_229, 2_129, 2_129, 2_129, 2_129, 2_129, 2_229]
    );
    assert_eq!(table.padding, Some([140, 140, 140, 140]));
    assert!(table
        .cells
        .iter()
        .all(|cell| { cell.blocks.len() == 1 && matches!(cell.blocks[0], Block::Paragraph(_)) }));
    assert_eq!(
        table
            .cells
            .iter()
            .map(|cell| (cell.row, cell.col, cell.col_span, cell.row_span))
            .collect::<Vec<_>>(),
        vec![
            (0, 0, 1, 1),
            (0, 1, 1, 1),
            (0, 2, 1, 1),
            (1, 0, 1, 2),
            (1, 1, 1, 1),
            (1, 2, 1, 1),
            (2, 1, 1, 1),
            (2, 2, 1, 1),
            (3, 0, 1, 1),
            (3, 1, 1, 1),
            (3, 2, 1, 1),
            (4, 0, 1, 1),
            (4, 1, 1, 1),
            (4, 2, 1, 1),
            (5, 0, 1, 1),
            (5, 1, 1, 1),
            (5, 2, 1, 1),
            (6, 0, 2, 1),
            (6, 2, 1, 1),
        ]
    );
}

#[test]
fn strict_seven_by_three_slice_rejects_hostile_pairing_topology_geometry_and_extensions() {
    for mutation in [
        SevenByThreeMutation::BadCommonAttribute,
        SevenByThreeMutation::BadTableAttribute,
        SevenByThreeMutation::BadRowCellCount,
        SevenByThreeMutation::BadWidth,
        SevenByThreeMutation::BadRowHeight,
        SevenByThreeMutation::BadSpanHeight,
        SevenByThreeMutation::BadParagraphCount,
        SevenByThreeMutation::BadWidthReference,
        SevenByThreeMutation::BadCellOrder,
        SevenByThreeMutation::BadListExtension,
    ] {
        assert!(
            OwnHwp5Parser::new()
                .parse(&seven_by_three_fixture(mutation))
                .is_err(),
            "hostile 7x3 mutation must fail closed"
        );
    }
}

fn fixture(mutation: Mutation) -> Vec<u8> {
    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let has_table = matches!(
        mutation,
        Mutation::Table
            | Mutation::TableTerminatorCharShape
            | Mutation::TableBadTerminatorShapeBoundary
            | Mutation::TableBadTerminatorShapeReference
            | Mutation::TableBadDeclaredTerminatorShapeCount
            | Mutation::SixParagraphTable
            | Mutation::SixParagraphBadWidthReference
            | Mutation::SixParagraphBadGeometry
            | Mutation::SixParagraphBadExtension
            | Mutation::SevenParagraphTable
            | Mutation::BadTableAttr
            | Mutation::BadTableTopology
            | Mutation::BadTableGeometry
            | Mutation::BadTableCellAlign
            | Mutation::BadTableBorderRef
            | Mutation::LargeTable
            | Mutation::LargeTableBadCellCount
            | Mutation::LargeTableExtraCell
            | Mutation::LargeTableBadSpan
            | Mutation::LargeTableBadWidth
            | Mutation::LargeTableBadParagraphCount
            | Mutation::LargeTableBadRowHeight
            | Mutation::LargeTableBadWidthRef
            | Mutation::LargeTableBadCellOrder
            | Mutation::MultiTable
            | Mutation::MultiTableMissingMarker
            | Mutation::MultiTableExtraMarker
            | Mutation::MultiTableVisibleText
            | Mutation::MultiTableBadCellFlag
            | Mutation::MultiTableStrayChild
            | Mutation::MultiTableThirdControl
    );
    let has_multi_table = matches!(
        mutation,
        Mutation::MultiTable
            | Mutation::MultiTableMissingMarker
            | Mutation::MultiTableExtraMarker
            | Mutation::MultiTableVisibleText
            | Mutation::MultiTableBadCellFlag
            | Mutation::MultiTableStrayChild
            | Mutation::MultiTableThirdControl
    );
    let has_large_table = matches!(
        mutation,
        Mutation::LargeTable
            | Mutation::LargeTableBadCellCount
            | Mutation::LargeTableExtraCell
            | Mutation::LargeTableBadSpan
            | Mutation::LargeTableBadWidth
            | Mutation::LargeTableBadParagraphCount
            | Mutation::LargeTableBadRowHeight
            | Mutation::LargeTableBadWidthRef
            | Mutation::LargeTableBadCellOrder
            | Mutation::MultiTable
            | Mutation::MultiTableMissingMarker
            | Mutation::MultiTableExtraMarker
            | Mutation::MultiTableVisibleText
            | Mutation::MultiTableBadCellFlag
            | Mutation::MultiTableStrayChild
            | Mutation::MultiTableThirdControl
    );
    let has_terminal_shape = matches!(
        mutation,
        Mutation::TableTerminatorCharShape
            | Mutation::TableBadTerminatorShapeBoundary
            | Mutation::TableBadTerminatorShapeReference
            | Mutation::TableBadDeclaredTerminatorShapeCount
    );
    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    let section_count = if matches!(
        mutation,
        Mutation::PageNumberMultiSection | Mutation::NewNumberMultiSection
    ) {
        2u16
    } else {
        1
    };
    properties[..2].copy_from_slice(&section_count.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [
        0,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        usize::from(has_table),
        if has_large_table || has_terminal_shape {
            2
        } else {
            1
        },
        0,
        0,
        0,
        1,
        0,
    ] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    if has_table {
        push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    }
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    if has_large_table || has_terminal_shape {
        push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    }
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut section_text = extended_control(0x0002, CTRL_SECTION_DEF);
    let has_page_number = matches!(
        mutation,
        Mutation::PageNumber
            | Mutation::PageNumberMultiSection
            | Mutation::BadPageNumberLength
            | Mutation::BadPageNumberAttr
            | Mutation::BadPageNumberPosition
            | Mutation::BadPageNumberFormat
            | Mutation::BadPageNumberSurrogate
            | Mutation::BadPageNumberUserSymbol
            | Mutation::NewNumber
            | Mutation::NewNumberMultiSection
            | Mutation::BadNewNumberLength
            | Mutation::BadNewNumberAttr
            | Mutation::BadNewNumberType
            | Mutation::BadNewNumberZero
            | Mutation::DuplicateNewNumber
            | Mutation::DuplicatePageNumber
            | Mutation::IdempotentPageNumberControls
    );
    let has_new_number = matches!(
        mutation,
        Mutation::NewNumber
            | Mutation::NewNumberMultiSection
            | Mutation::BadNewNumberLength
            | Mutation::BadNewNumberAttr
            | Mutation::BadNewNumberType
            | Mutation::BadNewNumberZero
            | Mutation::NewNumberWithoutPageNumber
            | Mutation::DuplicateNewNumber
            | Mutation::IdempotentPageNumberControls
    );
    let has_columns = matches!(
        mutation,
        Mutation::Column2
            | Mutation::ColumnUnequal
            | Mutation::BadColumnPayload
            | Mutation::BadColumnTrailingGap
            | Mutation::BadColumnDirection
            | Mutation::BadColumnKind
    );
    if has_columns {
        section_text.extend(extended_control(0x0002, u32::from_be_bytes(*b"cold")));
    }
    if has_page_number {
        section_text.extend(extended_control(0x0015, CTRL_PAGE_NUM_POS));
        if matches!(
            mutation,
            Mutation::DuplicatePageNumber | Mutation::IdempotentPageNumberControls
        ) {
            section_text.extend(extended_control(0x0015, CTRL_PAGE_NUM_POS));
        }
    }
    if has_new_number {
        section_text.extend(extended_control(0x0015, CTRL_NEW_NUMBER));
        if matches!(
            mutation,
            Mutation::DuplicateNewNumber | Mutation::IdempotentPageNumberControls
        ) {
            section_text.extend(extended_control(0x0015, CTRL_NEW_NUMBER));
        }
    }
    if has_table {
        section_text.extend(extended_control(0x000b, CTRL_TABLE));
        if has_multi_table && !matches!(mutation, Mutation::MultiTableMissingMarker) {
            section_text.extend(extended_control(0x000b, CTRL_TABLE));
        }
        if matches!(mutation, Mutation::MultiTableExtraMarker) {
            section_text.extend(extended_control(0x000b, CTRL_TABLE));
        }
        if matches!(mutation, Mutation::MultiTableThirdControl) {
            section_text.extend(extended_control(0x000b, CTRL_TABLE));
        }
    }
    if matches!(mutation, Mutation::MultiTableVisibleText) {
        section_text.push('X' as u16);
    }
    if matches!(mutation, Mutation::BadControlFrame) {
        section_text[7] = 0;
    }
    section_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        section_text.len() as u32,
        (1 << 2)
            | if has_page_number || has_new_number {
                1 << 0x15
            } else {
                0
            }
            | if has_table { 1 << 0x000b } else { 0 },
        if has_terminal_shape && !matches!(mutation, Mutation::TableBadDeclaredTerminatorShapeCount)
        {
            2
        } else {
            1
        },
        u16::from(has_table),
        if has_columns {
            0x03
        } else if matches!(mutation, Mutation::ColumnBreakWithoutDefinition) {
            0x08
        } else {
            0
        },
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&section_text));
    let host_shape_refs = if has_terminal_shape {
        let terminator = section_text.len() as u32 - 1;
        shape_refs(&[
            (0, 0),
            (
                if matches!(mutation, Mutation::TableBadTerminatorShapeBoundary) {
                    terminator - 1
                } else {
                    terminator
                },
                if matches!(mutation, Mutation::TableBadTerminatorShapeReference) {
                    2
                } else {
                    1
                },
            ),
        ])
    } else {
        shape_refs(&[(0, 0)])
    };
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &host_shape_refs);
    if has_table {
        push_record(
            &mut body,
            TAG_PARA_LINE_SEG,
            1,
            &line_seg(0, 1_500, 1_200, 900),
        );
    }
    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    if matches!(mutation, Mutation::UnsupportedSectionChild) {
        push_record(&mut body, TAG_FOOTNOTE_SHAPE, 2, &[0; 28]);
    } else {
        push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(mutation));
        if matches!(mutation, Mutation::DuplicatePageDef) {
            push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(mutation));
        }
    }
    if has_columns {
        let mut column = Vec::new();
        column.extend_from_slice(&u32::from_be_bytes(*b"cold").to_le_bytes());
        if matches!(
            mutation,
            Mutation::ColumnUnequal | Mutation::BadColumnTrailingGap
        ) {
            column.extend_from_slice(&(3u16 << 2).to_le_bytes());
            column.extend_from_slice(&0u16.to_le_bytes());
            for (width, gap) in [
                (10_000u16, 1_000u16),
                (20_000, 1_000),
                (
                    30_000,
                    u16::from(matches!(mutation, Mutation::BadColumnTrailingGap)),
                ),
            ] {
                column.extend_from_slice(&width.to_le_bytes());
                column.extend_from_slice(&gap.to_le_bytes());
            }
            column.extend([0; 6]);
        } else {
            let direction = if matches!(mutation, Mutation::BadColumnDirection) {
                2u16 << 10
            } else {
                0
            };
            let kind = u16::from(matches!(mutation, Mutation::BadColumnKind));
            column.extend_from_slice(&((2u16 << 2) | (1 << 12) | direction | kind).to_le_bytes());
            column.extend_from_slice(&1_000u16.to_le_bytes());
            column.extend_from_slice(&0u16.to_le_bytes());
            column.push(if matches!(mutation, Mutation::Column2) {
                1
            } else {
                0
            });
            column.push(0);
            column.extend_from_slice(
                &if matches!(mutation, Mutation::Column2) {
                    0x0000_00ffu32
                } else {
                    0
                }
                .to_le_bytes(),
            );
        }
        if matches!(mutation, Mutation::BadColumnPayload) {
            column.pop();
        }
        push_record(&mut body, TAG_CTRL_HEADER, 1, &column);
    }
    if has_page_number {
        let count = if matches!(
            mutation,
            Mutation::DuplicatePageNumber | Mutation::IdempotentPageNumberControls
        ) {
            2
        } else {
            1
        };
        for index in 0..count {
            let mut control = Vec::with_capacity(16);
            control.extend_from_slice(&CTRL_PAGE_NUM_POS.to_le_bytes());
            let attr = if matches!(mutation, Mutation::BadPageNumberAttr) {
                1u32 << 16
            } else if matches!(mutation, Mutation::BadPageNumberPosition) {
                11u32 << 8
            } else if matches!(mutation, Mutation::BadPageNumberFormat) {
                6
            } else if matches!(mutation, Mutation::DuplicatePageNumber) && index == 1 {
                4u32 << 8
            } else {
                5u32 << 8
            };
            control.extend_from_slice(&attr.to_le_bytes());
            let user = if matches!(mutation, Mutation::BadPageNumberUserSymbol) {
                '*' as u16
            } else {
                0
            };
            let prefix = if matches!(mutation, Mutation::BadPageNumberSurrogate) {
                0xd800
            } else {
                '[' as u16
            };
            for scalar in [user, prefix, ']' as u16, '-' as u16] {
                control.extend_from_slice(&scalar.to_le_bytes());
            }
            if matches!(mutation, Mutation::BadPageNumberLength) {
                control.pop();
            }
            push_record(&mut body, TAG_CTRL_HEADER, 1, &control);
        }
    }
    if has_new_number {
        let count = if matches!(
            mutation,
            Mutation::DuplicateNewNumber | Mutation::IdempotentPageNumberControls
        ) {
            2
        } else {
            1
        };
        for index in 0..count {
            let mut control = Vec::with_capacity(10);
            control.extend_from_slice(&CTRL_NEW_NUMBER.to_le_bytes());
            let attr = if matches!(mutation, Mutation::BadNewNumberAttr) {
                1u32 << 16
            } else if matches!(mutation, Mutation::BadNewNumberType) {
                1
            } else {
                0
            };
            control.extend_from_slice(&attr.to_le_bytes());
            let start = if matches!(mutation, Mutation::BadNewNumberZero) {
                0u16
            } else if matches!(mutation, Mutation::DuplicateNewNumber) {
                7 + index as u16
            } else {
                7
            };
            control.extend_from_slice(&start.to_le_bytes());
            if matches!(mutation, Mutation::BadNewNumberLength) {
                control.pop();
            }
            push_record(&mut body, TAG_CTRL_HEADER, 1, &control);
        }
    }
    if has_table {
        let (table_width, table_height, table_rows, table_cols) = if has_large_table {
            (47_913u32, 65_409u32, 10u16, 2u16)
        } else {
            (20_000, 2_000, 1, 1)
        };
        let mut common = Vec::with_capacity(46);
        common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
        let attr = if matches!(mutation, Mutation::BadTableAttr) {
            0x082a_2310u32
        } else {
            0x082a_2311
        };
        common.extend_from_slice(&attr.to_le_bytes());
        common.extend_from_slice(&0u32.to_le_bytes());
        common.extend_from_slice(&0u32.to_le_bytes());
        common.extend_from_slice(&table_width.to_le_bytes());
        common.extend_from_slice(&table_height.to_le_bytes());
        common.extend_from_slice(&0i32.to_le_bytes());
        for margin in [100i16, 100, 50, 50] {
            common.extend_from_slice(&margin.to_le_bytes());
        }
        common.extend_from_slice(&1u32.to_le_bytes());
        common.extend_from_slice(&0i32.to_le_bytes());
        common.extend_from_slice(&0u16.to_le_bytes());
        push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

        let mut table = Vec::with_capacity(22 + usize::from(table_rows) * 2);
        table.extend_from_slice(&0x0400_0006u32.to_le_bytes());
        table.extend_from_slice(&table_rows.to_le_bytes());
        table.extend_from_slice(&table_cols.to_le_bytes());
        table.extend_from_slice(&0u16.to_le_bytes());
        for padding in [510i16, 510, 141, 141] {
            table.extend_from_slice(&padding.to_le_bytes());
        }
        if has_large_table {
            // HWP TABLE stores active-cell counts per row here, not row heights.
            for count in [1u16, 1, 2, 2, 2, 1, 2, 2, 2, 2] {
                table.extend_from_slice(&count.to_le_bytes());
            }
        } else {
            table.extend_from_slice(&1u16.to_le_bytes());
        }
        table.extend_from_slice(&1u16.to_le_bytes());
        table.extend_from_slice(&0u16.to_le_bytes());
        push_record(
            &mut body,
            if matches!(mutation, Mutation::BadTableTopology) {
                TAG_PAGE_DEF
            } else {
                TAG_TABLE
            },
            2,
            &table,
        );

        let mut positions = if has_large_table {
            (0usize..10)
                .flat_map(|row| {
                    if matches!(row, 0 | 1 | 5) {
                        vec![(row, 0usize, 2usize)]
                    } else {
                        vec![(row, 0, 1), (row, 1, 1)]
                    }
                })
                .collect::<Vec<_>>()
        } else {
            vec![(0, 0, 1)]
        };
        if matches!(mutation, Mutation::LargeTableBadCellCount) {
            positions.pop();
        }
        if matches!(mutation, Mutation::LargeTableExtraCell) {
            positions.push((9, 1, 1));
        }
        if matches!(mutation, Mutation::LargeTableBadSpan) {
            positions[0].2 = 1;
        }
        if matches!(mutation, Mutation::LargeTableBadCellOrder) {
            positions.swap(2, 3);
        }
        for (cell_index, (row, col, col_span)) in positions.into_iter().enumerate() {
            let paragraph_count = if matches!(mutation, Mutation::SevenParagraphTable) {
                7u16
            } else if matches!(
                mutation,
                Mutation::SixParagraphTable
                    | Mutation::SixParagraphBadWidthReference
                    | Mutation::SixParagraphBadGeometry
                    | Mutation::SixParagraphBadExtension
            ) {
                6
            } else if has_large_table && cell_index == 0 {
                if matches!(mutation, Mutation::LargeTableBadParagraphCount) {
                    6u16
                } else {
                    5
                }
            } else {
                1
            };
            let width_ref = if matches!(mutation, Mutation::SixParagraphBadWidthReference) {
                0x0100u16
            } else if matches!(mutation, Mutation::LargeTableBadWidthRef) && cell_index == 0 {
                0x0200u16
            } else if has_large_table {
                [0x0000u16, 0x0100, 0x0500][cell_index % 3]
            } else {
                0x0500
            };
            let mut cell_width = if has_large_table {
                [9_361u32, 38_552][col..col + col_span].iter().sum()
            } else {
                20_000
            };
            if cell_index == 0
                && matches!(
                    mutation,
                    Mutation::BadTableGeometry
                        | Mutation::LargeTableBadWidth
                        | Mutation::SixParagraphBadGeometry
                )
            {
                cell_width -= 1;
            }
            let mut cell_height = if has_large_table {
                if row == 9 {
                    6_909u32
                } else {
                    6_500
                }
            } else {
                2_000
            };
            if matches!(mutation, Mutation::LargeTableBadRowHeight) && cell_index == 0 {
                cell_height -= 1;
            }

            let mut cell = Vec::with_capacity(47);
            cell.extend_from_slice(&paragraph_count.to_le_bytes());
            cell.extend_from_slice(
                &if matches!(mutation, Mutation::BadTableCellAlign) {
                    0u32
                } else {
                    0x0020_0000
                }
                .to_le_bytes(),
            );
            cell.extend_from_slice(&width_ref.to_le_bytes());
            for value in [col as u16, row as u16, col_span as u16, 1] {
                cell.extend_from_slice(&value.to_le_bytes());
            }
            cell.extend_from_slice(&cell_width.to_le_bytes());
            cell.extend_from_slice(&cell_height.to_le_bytes());
            for padding in [510i16, 510, 141, 141] {
                cell.extend_from_slice(&padding.to_le_bytes());
            }
            cell.extend_from_slice(
                &if matches!(mutation, Mutation::BadTableBorderRef) {
                    2u16
                } else {
                    1
                }
                .to_le_bytes(),
            );
            if matches!(
                mutation,
                Mutation::SixParagraphTable | Mutation::SixParagraphBadExtension
            ) {
                cell.extend_from_slice(&cell_width.to_le_bytes());
                cell.extend([0; 9]);
                if matches!(mutation, Mutation::SixParagraphBadExtension) {
                    cell[38] = 1;
                }
            } else {
                cell.extend([0; 13]);
            }
            push_record(&mut body, TAG_LIST_HEADER, 2, &cell);

            for paragraph in 0..paragraph_count {
                let terminal_shape = has_large_table && cell_index == 0 && paragraph == 0;
                push_para_header_at_level(
                    &mut body,
                    2,
                    2,
                    0,
                    if terminal_shape { 2 } else { 1 },
                    0,
                    0,
                );
                push_record(
                    &mut body,
                    TAG_PARA_TEXT,
                    3,
                    &utf16_bytes(&['A' as u16, 0x000d]),
                );
                push_record(
                    &mut body,
                    TAG_PARA_CHAR_SHAPE,
                    3,
                    &shape_refs(if terminal_shape {
                        &[(0, 0), (1, 1)]
                    } else {
                        &[(0, 0)]
                    }),
                );
            }
        }
    }

    if has_multi_table {
        let additional_tables = if matches!(mutation, Mutation::MultiTableThirdControl) {
            2
        } else {
            1
        };
        for _ in 0..additional_tables {
            let mut common = Vec::with_capacity(46);
            common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
            common.extend_from_slice(&0x082a_2311u32.to_le_bytes());
            common.extend_from_slice(&0u32.to_le_bytes());
            common.extend_from_slice(&0u32.to_le_bytes());
            common.extend_from_slice(&20_000u32.to_le_bytes());
            common.extend_from_slice(&2_000u32.to_le_bytes());
            common.extend_from_slice(&0i32.to_le_bytes());
            for margin in [100i16, 100, 50, 50] {
                common.extend_from_slice(&margin.to_le_bytes());
            }
            common.extend_from_slice(&1u32.to_le_bytes());
            common.extend_from_slice(&0i32.to_le_bytes());
            common.extend_from_slice(&0u16.to_le_bytes());
            push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

            let mut table = Vec::with_capacity(24);
            table.extend_from_slice(&0x0400_0006u32.to_le_bytes());
            table.extend_from_slice(&1u16.to_le_bytes());
            table.extend_from_slice(&1u16.to_le_bytes());
            table.extend_from_slice(&0u16.to_le_bytes());
            for padding in [510i16, 510, 141, 141] {
                table.extend_from_slice(&padding.to_le_bytes());
            }
            table.extend_from_slice(&1u16.to_le_bytes());
            table.extend_from_slice(&1u16.to_le_bytes());
            table.extend_from_slice(&0u16.to_le_bytes());
            push_record(&mut body, TAG_TABLE, 2, &table);

            let mut cell = Vec::with_capacity(47);
            cell.extend_from_slice(&4u16.to_le_bytes());
            cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
            cell.extend_from_slice(
                &if matches!(mutation, Mutation::MultiTableBadCellFlag) {
                    0x0503u16
                } else {
                    0x0501
                }
                .to_le_bytes(),
            );
            for value in [0u16, 0, 1, 1] {
                cell.extend_from_slice(&value.to_le_bytes());
            }
            cell.extend_from_slice(&20_000u32.to_le_bytes());
            cell.extend_from_slice(&2_000u32.to_le_bytes());
            for padding in [283i16, 283, 141, 141] {
                cell.extend_from_slice(&padding.to_le_bytes());
            }
            cell.extend_from_slice(&1u16.to_le_bytes());
            cell.extend([0; 13]);
            push_record(&mut body, TAG_LIST_HEADER, 2, &cell);
            for _ in 0..4 {
                push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
                push_record(
                    &mut body,
                    TAG_PARA_TEXT,
                    3,
                    &utf16_bytes(&['A' as u16, 0x000d]),
                );
                push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
            }
            if matches!(mutation, Mutation::MultiTableStrayChild) {
                push_record(&mut body, TAG_PAGE_DEF, 2, &[0; 4]);
            }
        }
    }

    if matches!(mutation, Mutation::MidSectionSeparator) {
        let mut text = extended_control(0x0002, u32::from_be_bytes(*b"cold"));
        text.push(0x000d);
        push_para_header_with_break(&mut body, text.len() as u32, 1 << 2, 1, 0, 0x02);
        push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&text));
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));
        let mut column = Vec::with_capacity(16);
        column.extend_from_slice(&u32::from_be_bytes(*b"cold").to_le_bytes());
        column.extend_from_slice(&((2u16 << 2) | (1 << 12)).to_le_bytes());
        column.extend_from_slice(&1_000u16.to_le_bytes());
        column.extend_from_slice(&0u16.to_le_bytes());
        column.extend_from_slice(&[1, 0]);
        column.extend_from_slice(&0x0000_00ffu32.to_le_bytes());
        push_record(&mut body, TAG_CTRL_HEADER, 1, &column);
    } else {
        let declared_lines = if matches!(
            mutation,
            Mutation::BadLineCount | Mutation::MultiLineGeometry
        ) {
            2
        } else {
            1
        };
        let paragraph_text = if matches!(mutation, Mutation::VisibleLineGeometry) {
            vec!['X' as u16, 0x000d]
        } else if matches!(mutation, Mutation::MultiLineGeometry) {
            vec!['A' as u16, 'B' as u16, 0x000d]
        } else {
            vec![0x000d]
        };
        push_para_header(&mut body, paragraph_text.len() as u32, 0, 1, declared_lines);
        push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&paragraph_text));
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));
        let start = if matches!(mutation, Mutation::BadLineBoundary) {
            1
        } else {
            0
        };
        let (height, text_height, baseline) = if matches!(mutation, Mutation::ZeroHeightLine) {
            (0, 0, 0)
        } else {
            (1_500, 1_200, 900)
        };
        let mut line = line_seg(start, height, text_height, baseline);
        if matches!(mutation, Mutation::OversizeLineGeometry) {
            line[24..28].copy_from_slice(&10_000_001i32.to_le_bytes());
        }
        if matches!(mutation, Mutation::BadLineLength) {
            line.pop();
        }
        if matches!(mutation, Mutation::MultiLineGeometry) {
            let mut second = line_seg(1, 1_500, 1_200, 900);
            second[4..8].copy_from_slice(&1_600i32.to_le_bytes());
            line.extend(second);
        }
        push_record(&mut body, TAG_PARA_LINE_SEG, 1, &line);
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    if matches!(
        mutation,
        Mutation::PageNumberMultiSection | Mutation::NewNumberMultiSection
    ) {
        let mut stream = compound.create_stream("/BodyText/Section1").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn one_by_two_fixture(mutation: OneByTwoMutation) -> Vec<u8> {
    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(
        &if matches!(mutation, OneByTwoMutation::BadCommonAttribute) {
            0x082a_2311u32
        } else {
            0x082a_2211
        }
        .to_le_bytes(),
    );
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&42_164u32.to_le_bytes());
    common.extend_from_slice(&3_005u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [140i16, 140, 140, 140] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

    let mut table = Vec::with_capacity(24);
    table.extend_from_slice(
        &if matches!(mutation, OneByTwoMutation::BadTableAttribute) {
            0x0400_0006u32
        } else {
            0x0400_0004
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&2u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [140i16, 140, 140, 140] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    table.extend_from_slice(
        &if matches!(mutation, OneByTwoMutation::BadRowCellCount) {
            1u16
        } else {
            2
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    let mut cells = vec![(0u16, 39_903u32, 0x0500u16), (1, 2_261, 0)];
    if matches!(mutation, OneByTwoMutation::BadCellOrder) {
        cells.swap(0, 1);
    }
    for (index, (col, mut width, mut width_ref)) in cells.into_iter().enumerate() {
        if index == 0 && matches!(mutation, OneByTwoMutation::BadWidth) {
            width -= 1;
        }
        if index == 0 && matches!(mutation, OneByTwoMutation::BadWidthReference) {
            width_ref = 0;
        }
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col, 0, 1, 1] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend_from_slice(&3_005u32.to_le_bytes());
        for padding in [141i16, 141, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend([0; 9]);
        if index == 0 && matches!(mutation, OneByTwoMutation::BadListExtension) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);
        push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
        push_record(
            &mut body,
            TAG_PARA_TEXT,
            3,
            &utf16_bytes(&[u16::from(b'A') + index as u16, 0x000d]),
        );
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn six_by_four_fixture(mutation: SixByFourMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 4] = [3_238, 14_908, 11_795, 18_021];
    const ROW_HEIGHTS: [u32; 6] = [1_946, 1_846, 1_846, 1_846, 1_846, 1_846];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(
        &if matches!(mutation, SixByFourMutation::BadCommonAttribute) {
            0x082a_2211u32
        } else {
            0x082a_2311
        }
        .to_le_bytes(),
    );
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&47_962u32.to_le_bytes());
    common.extend_from_slice(&11_176u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [138i16, 138, 138, 138] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

    let mut table = Vec::with_capacity(34);
    table.extend_from_slice(
        &if matches!(mutation, SixByFourMutation::BadTableAttribute) {
            0x0400_0006u32
        } else {
            0x0400_0004
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&6u16.to_le_bytes());
    table.extend_from_slice(&4u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [140i16, 140, 140, 140] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [4u16; 6];
    if matches!(mutation, SixByFourMutation::BadRowCellCount) {
        row_counts[2] = 3;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    let mut positions = (0usize..6)
        .flat_map(|row| (0usize..4).map(move |col| (row, col)))
        .collect::<Vec<_>>();
    if matches!(mutation, SixByFourMutation::BadCellOrder) {
        positions.swap(0, 1);
    }
    for (index, (row, col)) in positions.into_iter().enumerate() {
        let mut width = COL_WIDTHS[col];
        let mut height = ROW_HEIGHTS[row];
        let all_body_width_references = matches!(
            mutation,
            SixByFourMutation::AllBodyWidthReferences | SixByFourMutation::BadAllBodyWidthReference
        );
        let mut width_ref = if all_body_width_references || row != 0 {
            0x0500u16
        } else {
            0x0100
        };
        if index == 0 && matches!(mutation, SixByFourMutation::BadWidth) {
            width -= 1;
        }
        if index == 0 && matches!(mutation, SixByFourMutation::BadRowHeight) {
            height -= 1;
        }
        if index == 0 && matches!(mutation, SixByFourMutation::BadWidthReference) {
            width_ref = 0x0500;
        }
        if index == 0 && matches!(mutation, SixByFourMutation::BadAllBodyWidthReference) {
            width_ref = 0x0100;
        }
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(
            &if index == 0 && matches!(mutation, SixByFourMutation::BadParagraphCount) {
                2u16
            } else {
                1
            }
            .to_le_bytes(),
        );
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col as u16, row as u16, 1, 1] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend_from_slice(&height.to_le_bytes());
        for padding in [141i16, 141, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend([0; 9]);
        if index == 0 && matches!(mutation, SixByFourMutation::BadListExtension) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);
        push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
        push_record(
            &mut body,
            TAG_PARA_TEXT,
            3,
            &utf16_bytes(&[u16::from(b'A') + index as u16, 0x000d]),
        );
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn captioned_table_fixture(mutation: CaptionedTableMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 5] = [3_221, 6_593, 8_956, 21_855, 7_422];
    const ROW_HEIGHTS: [u32; 4] = [1_948, 1_848, 1_848, 1_848];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 35, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    for _ in 0..35 {
        push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    }
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(&0x282a_2311u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&48_047u32.to_le_bytes());
    common.extend_from_slice(&7_492u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [141i16, 141, 141, 141] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

    let mut caption = Vec::with_capacity(30);
    caption.extend_from_slice(&1u16.to_le_bytes());
    caption.extend_from_slice(&0u32.to_le_bytes());
    caption.extend_from_slice(&0u16.to_le_bytes());
    caption.extend_from_slice(
        &if matches!(mutation, CaptionedTableMutation::BadCaptionDirection) {
            3u32
        } else {
            2
        }
        .to_le_bytes(),
    );
    caption.extend_from_slice(&8_504u32.to_le_bytes());
    caption.extend_from_slice(
        &if matches!(mutation, CaptionedTableMutation::BadCaptionGap) {
            851i16
        } else {
            850
        }
        .to_le_bytes(),
    );
    caption.extend_from_slice(&48_047u32.to_le_bytes());
    caption.extend([0; 8]);
    if matches!(mutation, CaptionedTableMutation::BadCaptionReserved) {
        caption[22] = 1;
    }
    push_record(&mut body, TAG_LIST_HEADER, 2, &caption);

    let mut push_caption_paragraph = |text: u16| {
        push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
        push_record(&mut body, TAG_PARA_TEXT, 3, &utf16_bytes(&[text, 0x000d]));
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
    };
    if !matches!(mutation, CaptionedTableMutation::MissingCaptionParagraph) {
        push_caption_paragraph(u16::from(b'C'));
    }
    if matches!(mutation, CaptionedTableMutation::ExtraCaptionParagraph) {
        push_caption_paragraph(u16::from(b'D'));
    }

    let mut table = Vec::with_capacity(30);
    table.extend_from_slice(
        &if matches!(mutation, CaptionedTableMutation::BadTableAttribute) {
            0x0400_0006u32
        } else {
            0x0600_0006
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&4u16.to_le_bytes());
    table.extend_from_slice(&5u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [141i16, 141, 141, 141] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [5u16; 4];
    if matches!(mutation, CaptionedTableMutation::BadRowCellCount) {
        row_counts[0] = 4;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(&4u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    for index in 0usize..20 {
        let row = index / 5;
        let col = index % 5;
        let mut width = COL_WIDTHS[col];
        if index == 0 && matches!(mutation, CaptionedTableMutation::BadGridGeometry) {
            width -= 1;
        }
        let width_ref =
            if index == 0 && matches!(mutation, CaptionedTableMutation::BadWidthReference) {
                0x0500u16
            } else {
                0x0400
            };
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col as u16, row as u16, 1, 1] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend_from_slice(&ROW_HEIGHTS[row].to_le_bytes());
        for padding in [141i16, 141, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(
            &if index == 0 && matches!(mutation, CaptionedTableMutation::BadCellBorder) {
                0u16
            } else {
                35
            }
            .to_le_bytes(),
        );
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend([0; 9]);
        if index == 0 && matches!(mutation, CaptionedTableMutation::BadListExtension) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);
        push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
        push_record(
            &mut body,
            TAG_PARA_TEXT,
            3,
            &utf16_bytes(&[u16::from(b'A') + index as u16, 0x000d]),
        );
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn plain_four_by_five_fixture(mutation: PlainFourByFiveMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 5] = [3_221, 9_238, 14_770, 12_223, 8_594];
    const ROW_HEIGHTS: [u32; 4] = [1_948, 1_848, 1_848, 1_848];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 36, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    for _ in 0..36 {
        push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    }
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(&0x082a_2311u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(
        &if matches!(mutation, PlainFourByFiveMutation::BadCommonWidth) {
            48_045u32
        } else {
            48_046
        }
        .to_le_bytes(),
    );
    common.extend_from_slice(&7_492u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [141i16, 141, 141, 141] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

    let mut table = Vec::with_capacity(30);
    table.extend_from_slice(
        &if matches!(mutation, PlainFourByFiveMutation::BadTableAttribute) {
            0x0400_0006u32
        } else {
            0x0600_0006
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&4u16.to_le_bytes());
    table.extend_from_slice(&5u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [141i16, 141, 141, 141] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [5u16; 4];
    if matches!(mutation, PlainFourByFiveMutation::BadRowCellCount) {
        row_counts[0] = 4;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(
        &if matches!(mutation, PlainFourByFiveMutation::BadTableBorder) {
            5u16
        } else {
            4
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    for index in 0usize..20 {
        let row = index / 5;
        let col = index % 5;
        let paragraph_count =
            if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadParagraphCount) {
                2u16
            } else {
                1
            };
        let mut width = COL_WIDTHS[col];
        if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadGridGeometry) {
            width -= 1;
        }
        let width_ref =
            if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadWidthReference) {
                0x0100u16
            } else {
                0x0500
            };
        let col_span = if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadCellSpan) {
            2u16
        } else {
            1
        };
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(&paragraph_count.to_le_bytes());
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col as u16, row as u16, col_span, 1] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend_from_slice(&ROW_HEIGHTS[row].to_le_bytes());
        for (padding_index, padding) in [141i16, 141, 141, 141].into_iter().enumerate() {
            let value = if index == 0
                && padding_index == 0
                && matches!(mutation, PlainFourByFiveMutation::BadCellPadding)
            {
                142
            } else {
                padding
            };
            cell.extend_from_slice(&value.to_le_bytes());
        }
        let border = if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadCellBorder) {
            34u16
        } else {
            match row {
                0 => 35,
                1 => 36,
                _ => 4,
            }
        };
        cell.extend_from_slice(&border.to_le_bytes());
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend([0; 9]);
        if index == 0 && matches!(mutation, PlainFourByFiveMutation::BadListExtension) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);

        for paragraph_index in 0..paragraph_count {
            let empty = row == 3 && col > 0 && paragraph_index == 0;
            push_para_header_at_level(&mut body, 2, if empty { 1 } else { 2 }, 0, 1, 0, 0);
            if !empty {
                push_record(
                    &mut body,
                    TAG_PARA_TEXT,
                    3,
                    &utf16_bytes(&[u16::from(b'A') + index as u16, 0x000d]),
                );
            }
            push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
        }
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn seven_by_three_fixture(mutation: SevenByThreeMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 3] = [6_509, 31_215, 10_200];
    const ROW_HEIGHTS: [u32; 7] = [2_229, 2_129, 2_129, 2_129, 2_129, 2_129, 2_229];
    const POSITIONS: [(usize, usize, usize, usize); 19] = [
        (0, 0, 1, 1),
        (0, 1, 1, 1),
        (0, 2, 1, 1),
        (1, 0, 1, 2),
        (1, 1, 1, 1),
        (1, 2, 1, 1),
        (2, 1, 1, 1),
        (2, 2, 1, 1),
        (3, 0, 1, 1),
        (3, 1, 1, 1),
        (3, 2, 1, 1),
        (4, 0, 1, 1),
        (4, 1, 1, 1),
        (4, 2, 1, 1),
        (5, 0, 1, 1),
        (5, 1, 1, 1),
        (5, 2, 1, 1),
        (6, 0, 2, 1),
        (6, 2, 1, 1),
    ];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(
        &if matches!(mutation, SevenByThreeMutation::BadCommonAttribute) {
            0x082a_2211u32
        } else {
            0x082a_2311
        }
        .to_le_bytes(),
    );
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&47_924u32.to_le_bytes());
    common.extend_from_slice(&15_103u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [141i16, 141, 141, 141] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_CTRL_HEADER, 1, &common);

    let mut table = Vec::with_capacity(36);
    table.extend_from_slice(
        &if matches!(mutation, SevenByThreeMutation::BadTableAttribute) {
            0x0600_000eu32
        } else {
            0x0600_000c
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&7u16.to_le_bytes());
    table.extend_from_slice(&3u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [140i16, 140, 140, 140] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [3u16, 3, 2, 3, 3, 3, 2];
    if matches!(mutation, SevenByThreeMutation::BadRowCellCount) {
        row_counts[2] = 3;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    let mut positions = POSITIONS.to_vec();
    if matches!(mutation, SevenByThreeMutation::BadCellOrder) {
        positions.swap(0, 1);
    }
    for (index, (row, col, col_span, row_span)) in positions.into_iter().enumerate() {
        let mut width = COL_WIDTHS[col..col + col_span].iter().sum::<u32>();
        let mut height = ROW_HEIGHTS[row..row + row_span].iter().sum::<u32>();
        let mut width_ref = if col == 2 { 0x0100u16 } else { 0x0500 };
        if index == 0 && matches!(mutation, SevenByThreeMutation::BadWidth) {
            width -= 1;
        }
        if index == 0 && matches!(mutation, SevenByThreeMutation::BadRowHeight) {
            height -= 1;
        }
        if (row, col) == (1, 0) && matches!(mutation, SevenByThreeMutation::BadSpanHeight) {
            height -= 1;
        }
        if index == 0 && matches!(mutation, SevenByThreeMutation::BadWidthReference) {
            width_ref = 0x0100;
        }
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(
            &if index == 0 && matches!(mutation, SevenByThreeMutation::BadParagraphCount) {
                2u16
            } else {
                1
            }
            .to_le_bytes(),
        );
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col as u16, row as u16, col_span as u16, row_span as u16] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend_from_slice(&height.to_le_bytes());
        for padding in [141i16, 141, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&width.to_le_bytes());
        cell.extend([0; 9]);
        if index == 0 && matches!(mutation, SevenByThreeMutation::BadListExtension) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);
        push_para_header_at_level(&mut body, 2, 2, 0, 1, 0, 0);
        push_record(
            &mut body,
            TAG_PARA_TEXT,
            3,
            &utf16_bytes(&[u16::from(b'A') + index as u16, 0x000d]),
        );
        push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn eight_by_five_fixture(mutation: EightByFiveMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 5] = [7_667, 16_324, 3_879, 3_955, 16_324];
    const ROW_HEIGHTS: [u32; 8] = [5_012, 7_339, 10_169, 10_169, 10_169, 10_169, 11_921, 1_848];
    const POSITIONS: [(usize, usize, usize, usize); 19] = [
        (0, 0, 1, 1),
        (0, 1, 1, 1),
        (0, 2, 2, 1),
        (0, 4, 1, 1),
        (1, 0, 1, 1),
        (1, 1, 4, 1),
        (2, 0, 1, 1),
        (2, 1, 4, 1),
        (3, 0, 1, 1),
        (3, 1, 4, 1),
        (4, 0, 1, 1),
        (4, 1, 4, 1),
        (5, 0, 1, 1),
        (5, 1, 4, 1),
        (6, 0, 1, 2),
        (6, 1, 2, 1),
        (6, 3, 2, 1),
        (7, 1, 2, 1),
        (7, 3, 2, 1),
    ];
    const NESTED: [(usize, usize); 9] = [
        (0, 1),
        (0, 4),
        (1, 1),
        (2, 1),
        (3, 1),
        (4, 1),
        (5, 1),
        (6, 1),
        (6, 3),
    ];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    push_table_common(&mut body, 1, 48_149, 66_796);
    let mut table = Vec::with_capacity(38);
    table.extend_from_slice(
        &if matches!(mutation, EightByFiveMutation::BadAttribute) {
            0x0600_000cu32
        } else {
            0x0600_000e
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&8u16.to_le_bytes());
    table.extend_from_slice(&5u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [510i16, 510, 141, 141] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [4u16, 2, 2, 2, 2, 2, 3, 2];
    if matches!(mutation, EightByFiveMutation::BadRowCellCount) {
        row_counts[6] = 2;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    for &(row, col, col_span, original_row_span) in &POSITIONS {
        let row_span =
            if (row, col) == (6, 0) && matches!(mutation, EightByFiveMutation::BadRowSpan) {
                1
            } else {
                original_row_span
            };
        let layout_width = COL_WIDTHS[col..col + col_span].iter().sum::<u32>();
        let stale_width_slot = (row, col, col_span, original_row_span) == (6, 3, 2, 1);
        let core_width = if stale_width_slot {
            layout_width
                - if matches!(mutation, EightByFiveMutation::BadLayoutWidthDelta) {
                    175
                } else {
                    176
                }
        } else {
            layout_width
        };
        let cell_height = if original_row_span == 2 {
            ROW_HEIGHTS[row] + ROW_HEIGHTS[row + 1]
        } else {
            ROW_HEIGHTS[row]
        };
        let paragraph_count = match (row, col) {
            (2, 1) | (5, 1) => 4u16,
            (3, 1) | (4, 1) => 3,
            _ => 1,
        };
        let width_ref = if row == 0 {
            0x0100u16
        } else if (row, col) == (6, 1) {
            if matches!(mutation, EightByFiveMutation::BadWidthReference) {
                0
            } else {
                0x0400
            }
        } else {
            0
        };
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(&paragraph_count.to_le_bytes());
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&width_ref.to_le_bytes());
        for value in [col as u16, row as u16, col_span as u16, row_span as u16] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&core_width.to_le_bytes());
        cell.extend_from_slice(&cell_height.to_le_bytes());
        for padding in [510i16, 510, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&layout_width.to_le_bytes());
        cell.extend([0; 9]);
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);

        let mut nested_here = NESTED.contains(&(row, col));
        if matches!(mutation, EightByFiveMutation::MissingNestedTable) && (row, col) == (6, 3) {
            nested_here = false;
        }
        if matches!(mutation, EightByFiveMutation::WrongNestedPosition) {
            if (row, col) == (0, 1) {
                nested_here = false;
            }
            if (row, col) == (0, 0) {
                nested_here = true;
            }
        }
        for paragraph_index in 0..paragraph_count as usize {
            let carries_nested = nested_here && paragraph_index == 0;
            let paragraph_text = if carries_nested {
                let mut text = extended_control(0x000b, CTRL_TABLE);
                text.push(0x000d);
                text
            } else {
                vec!['A' as u16, 0x000d]
            };
            push_para_header_at_level(
                &mut body,
                2,
                paragraph_text.len() as u32,
                if carries_nested { 1 << 0x000b } else { 0 },
                1,
                0,
                0,
            );
            push_record(&mut body, TAG_PARA_TEXT, 3, &utf16_bytes(&paragraph_text));
            push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
            if carries_nested {
                let (nested_width, common_height, cell_height) = match (row, col) {
                    (0, 1) => (
                        14_275,
                        if matches!(mutation, EightByFiveMutation::BadStaleNestedHeight) {
                            3_881
                        } else {
                            3_882
                        },
                        1_848,
                    ),
                    (0, 4) => (14_841, 3_882, 1_848),
                    (2, 1) => (38_896, 3_631, 3_631),
                    (5, 1) => (38_896, 3_150, 3_150),
                    (6, 1) | (6, 3) => (19_086, 5_131, 5_131),
                    _ => (38_896, 5_131, 5_131),
                };
                push_one_by_one_with_geometry(
                    &mut body,
                    3,
                    nested_width,
                    common_height,
                    cell_height,
                );
            }
        }
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn nested_table_fixture(mutation: NestedTableMutation) -> Vec<u8> {
    const COL_WIDTHS: [u32; 8] = [3_182, 6_810, 659, 8_082, 5_346, 10_534, 5_935, 7_435];
    const ROW_HEIGHTS: [u32; 9] = [
        2_512, 4_842, 3_744, 2_229, 2_229, 2_129, 2_129, 2_129, 2_129,
    ];
    let positions = vec![
        (0usize, 0usize, 3usize),
        (0, 3, 5),
        (1, 0, 3),
        (1, 3, 5),
        (2, 0, 3),
        (2, 3, 2),
        (2, 5, 1),
        (2, 6, 2),
        (3, 0, 8),
        (4, 0, 1),
        (4, 1, 1),
        (4, 2, 2),
        (4, 4, 3),
        (4, 7, 1),
        (5, 0, 1),
        (5, 1, 1),
        (5, 2, 2),
        (5, 4, 3),
        (5, 7, 1),
        (6, 0, 1),
        (6, 1, 1),
        (6, 2, 2),
        (6, 4, 3),
        (6, 7, 1),
        (7, 0, 1),
        (7, 1, 1),
        (7, 2, 2),
        (7, 4, 3),
        (7, 7, 1),
        (8, 0, 1),
        (8, 1, 1),
        (8, 2, 2),
        (8, 4, 3),
        (8, 7, 1),
    ];

    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);
    let mut mappings = Vec::new();
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_BORDER_FILL, 0, &solid_border_fill());
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut host_text = extended_control(0x0002, CTRL_SECTION_DEF);
    host_text.extend(extended_control(0x000b, CTRL_TABLE));
    host_text.push(0x000d);
    push_para_header_with_break(
        &mut body,
        host_text.len() as u32,
        (1 << 2) | (1 << 0x000b),
        1,
        0,
        0x01,
    );
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&host_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(Mutation::None));

    push_table_common(&mut body, 1, 47_983, 24_072);
    let mut table = Vec::with_capacity(40);
    table.extend_from_slice(
        &if matches!(mutation, NestedTableMutation::BadAttribute) {
            0x0600_0008u32
        } else {
            0x0600_000c
        }
        .to_le_bytes(),
    );
    table.extend_from_slice(&9u16.to_le_bytes());
    table.extend_from_slice(&8u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [140i16, 140, 140, 140] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    let mut row_counts = [2u16, 2, 4, 1, 5, 5, 5, 5, 5];
    if matches!(mutation, NestedTableMutation::BadRowCellCount) {
        row_counts[0] = 3;
    }
    for count in row_counts {
        table.extend_from_slice(&count.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(&mut body, TAG_TABLE, 2, &table);

    for (cell_index, &(row, col, original_span)) in positions.iter().enumerate() {
        let col_span = if cell_index == 0 && matches!(mutation, NestedTableMutation::BadSpan) {
            2
        } else {
            original_span
        };
        let mut cell_width = COL_WIDTHS[col..col + col_span].iter().sum::<u32>();
        if cell_index == 0 && matches!(mutation, NestedTableMutation::BadWidth) {
            cell_width -= 1;
        }
        let nested_host = (row, col, original_span) == (1, 3, 5);
        let paragraph_count = if nested_host { 2u16 } else { 1 };
        let mut cell = Vec::with_capacity(47);
        cell.extend_from_slice(&paragraph_count.to_le_bytes());
        cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        cell.extend_from_slice(&0x0500u16.to_le_bytes());
        for value in [col as u16, row as u16, col_span as u16, 1] {
            cell.extend_from_slice(&value.to_le_bytes());
        }
        cell.extend_from_slice(&cell_width.to_le_bytes());
        cell.extend_from_slice(&ROW_HEIGHTS[row].to_le_bytes());
        for padding in [141i16, 141, 141, 141] {
            cell.extend_from_slice(&padding.to_le_bytes());
        }
        cell.extend_from_slice(&1u16.to_le_bytes());
        cell.extend_from_slice(&cell_width.to_le_bytes());
        cell.extend([0; 9]);
        if cell_index == 0 && matches!(mutation, NestedTableMutation::BadListExtra) {
            cell[38] = 1;
        }
        push_record(&mut body, TAG_LIST_HEADER, 2, &cell);

        for paragraph_index in 0..paragraph_count as usize {
            let carries_nested = nested_host
                && paragraph_index == 1
                && !matches!(mutation, NestedTableMutation::MissingNestedTable);
            let paragraph_text = if carries_nested {
                let mut text = extended_control(0x000b, CTRL_TABLE);
                text.push(0x000d);
                text
            } else {
                vec!['A' as u16, 0x000d]
            };
            push_para_header_at_level(
                &mut body,
                2,
                paragraph_text.len() as u32,
                if carries_nested { 1 << 0x000b } else { 0 },
                1,
                0,
                0,
            );
            push_record(&mut body, TAG_PARA_TEXT, 3, &utf16_bytes(&paragraph_text));
            push_record(&mut body, TAG_PARA_CHAR_SHAPE, 3, &shape_refs(&[(0, 0)]));
            if carries_nested {
                push_nested_one_by_one(
                    &mut body,
                    3,
                    matches!(mutation, NestedTableMutation::TooDeep),
                );
            }
        }
    }

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn push_table_common(out: &mut Vec<u8>, level: u16, width: u32, height: u32) {
    let mut common = Vec::with_capacity(46);
    common.extend_from_slice(&CTRL_TABLE.to_le_bytes());
    common.extend_from_slice(&0x082a_2311u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&0u32.to_le_bytes());
    common.extend_from_slice(&width.to_le_bytes());
    common.extend_from_slice(&height.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    for margin in [141i16, 141, 141, 141] {
        common.extend_from_slice(&margin.to_le_bytes());
    }
    common.extend_from_slice(&1u32.to_le_bytes());
    common.extend_from_slice(&0i32.to_le_bytes());
    common.extend_from_slice(&0u16.to_le_bytes());
    push_record(out, TAG_CTRL_HEADER, level, &common);
}

fn push_one_by_one_with_geometry(
    out: &mut Vec<u8>,
    control_level: u16,
    width: u32,
    common_height: u32,
    cell_height: u32,
) {
    push_table_common(out, control_level, width, common_height);
    let child_level = control_level + 1;
    let mut table = Vec::with_capacity(24);
    table.extend_from_slice(&0x0400_0006u32.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [510i16, 510, 141, 141] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(out, TAG_TABLE, child_level, &table);

    let mut cell = Vec::with_capacity(47);
    cell.extend_from_slice(&1u16.to_le_bytes());
    cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
    cell.extend_from_slice(&0x0500u16.to_le_bytes());
    for value in [0u16, 0, 1, 1] {
        cell.extend_from_slice(&value.to_le_bytes());
    }
    cell.extend_from_slice(&width.to_le_bytes());
    cell.extend_from_slice(&cell_height.to_le_bytes());
    for padding in [510i16, 510, 141, 141] {
        cell.extend_from_slice(&padding.to_le_bytes());
    }
    cell.extend_from_slice(&1u16.to_le_bytes());
    cell.extend_from_slice(&width.to_le_bytes());
    cell.extend([0; 9]);
    push_record(out, TAG_LIST_HEADER, child_level, &cell);

    push_para_header_at_level(out, child_level, 2, 0, 1, 0, 0);
    push_record(
        out,
        TAG_PARA_TEXT,
        child_level + 1,
        &utf16_bytes(&['N' as u16, 0x000d]),
    );
    push_record(
        out,
        TAG_PARA_CHAR_SHAPE,
        child_level + 1,
        &shape_refs(&[(0, 0)]),
    );
}

fn push_nested_one_by_one(out: &mut Vec<u8>, control_level: u16, carries_deeper: bool) {
    push_table_common(out, control_level, 35_500, 1_848);
    let child_level = control_level + 1;
    let mut table = Vec::with_capacity(24);
    table.extend_from_slice(&0x0400_0006u32.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    for padding in [510i16, 510, 141, 141] {
        table.extend_from_slice(&padding.to_le_bytes());
    }
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&1u16.to_le_bytes());
    table.extend_from_slice(&0u16.to_le_bytes());
    push_record(out, TAG_TABLE, child_level, &table);

    let mut cell = Vec::with_capacity(47);
    cell.extend_from_slice(&1u16.to_le_bytes());
    cell.extend_from_slice(&0x0020_0000u32.to_le_bytes());
    cell.extend_from_slice(&0x0500u16.to_le_bytes());
    for value in [0u16, 0, 1, 1] {
        cell.extend_from_slice(&value.to_le_bytes());
    }
    cell.extend_from_slice(&35_500u32.to_le_bytes());
    cell.extend_from_slice(&1_848u32.to_le_bytes());
    for padding in [510i16, 510, 141, 141] {
        cell.extend_from_slice(&padding.to_le_bytes());
    }
    cell.extend_from_slice(&1u16.to_le_bytes());
    cell.extend_from_slice(&35_500u32.to_le_bytes());
    cell.extend([0; 9]);
    push_record(out, TAG_LIST_HEADER, child_level, &cell);

    let paragraph_text = if carries_deeper {
        let mut text = extended_control(0x000b, CTRL_TABLE);
        text.push(0x000d);
        text
    } else {
        vec!['N' as u16, 0x000d]
    };
    push_para_header_at_level(
        out,
        child_level,
        paragraph_text.len() as u32,
        if carries_deeper { 1 << 0x000b } else { 0 },
        1,
        0,
        0,
    );
    push_record(
        out,
        TAG_PARA_TEXT,
        child_level + 1,
        &utf16_bytes(&paragraph_text),
    );
    push_record(
        out,
        TAG_PARA_CHAR_SHAPE,
        child_level + 1,
        &shape_refs(&[(0, 0)]),
    );
    if carries_deeper {
        push_nested_one_by_one(out, control_level + 2, false);
    }
}

fn page_def(mutation: Mutation) -> Vec<u8> {
    let width = if matches!(mutation, Mutation::NoBodyBox) {
        100
    } else {
        59_528
    };
    let mut bytes = Vec::with_capacity(40);
    for value in [width, 84_188, 8_504, 8_504, 5_669, 4_252, 4_252, 4_252, 0] {
        bytes.extend_from_slice(&(value as u32).to_le_bytes());
    }
    let attr = if matches!(mutation, Mutation::UnsupportedBinding) {
        0x02
    } else {
        u32::from(matches!(mutation, Mutation::Landscape))
    };
    bytes.extend_from_slice(&attr.to_le_bytes());
    bytes
}

fn line_seg(start: u32, height: i32, text_height: i32, baseline: i32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(36);
    bytes.extend_from_slice(&start.to_le_bytes());
    for value in [100, height, text_height, baseline, 300, 0, 40_000] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes
}

fn extended_control(code: u16, id: u32) -> Vec<u16> {
    let bytes = id.to_le_bytes();
    vec![
        code,
        u16::from_le_bytes([bytes[0], bytes[1]]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
        0,
        0,
        0,
        0,
        code,
    ]
}

fn push_para_header(
    out: &mut Vec<u8>,
    char_count: u32,
    control_mask: u32,
    char_shapes: u16,
    line_segments: u16,
) {
    push_para_header_with_break(out, char_count, control_mask, char_shapes, line_segments, 0);
}

fn push_para_header_with_break(
    out: &mut Vec<u8>,
    char_count: u32,
    control_mask: u32,
    char_shapes: u16,
    line_segments: u16,
    break_type: u8,
) {
    push_para_header_at_level(
        out,
        0,
        char_count,
        control_mask,
        char_shapes,
        line_segments,
        break_type,
    );
}

fn push_para_header_at_level(
    out: &mut Vec<u8>,
    level: u16,
    char_count: u32,
    control_mask: u32,
    char_shapes: u16,
    line_segments: u16,
    break_type: u8,
) {
    let mut data = Vec::with_capacity(22);
    data.extend_from_slice(&char_count.to_le_bytes());
    data.extend_from_slice(&control_mask.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.push(0);
    data.push(break_type);
    data.extend_from_slice(&char_shapes.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&line_segments.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    push_record(out, TAG_PARA_HEADER, level, &data);
}

fn solid_border_fill() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(40);
    bytes.extend_from_slice(&0u16.to_le_bytes());
    for _ in 0..4 {
        bytes.push(1); // solid
        bytes.push(0); // thinnest owned width
        bytes.extend_from_slice(&0u32.to_le_bytes());
    }
    bytes.push(0); // no diagonal
    bytes.push(0);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // no fill
    bytes.extend_from_slice(&0u32.to_le_bytes()); // required zero tail
    bytes
}

fn face_name(value: &str) -> Vec<u8> {
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut bytes = vec![0];
    bytes.extend_from_slice(&(units.len() as u16).to_le_bytes());
    bytes.extend(utf16_bytes(&units));
    bytes
}

fn char_shape() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(68);
    for _ in 0..7 {
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend([100; 7]);
    bytes.extend([0; 7]);
    bytes.extend([100; 7]);
    bytes.extend([0; 7]);
    bytes.extend_from_slice(&1_200i32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0x00ff_ffffu32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes
}

fn para_shape() -> Vec<u8> {
    let mut bytes = vec![0; 42];
    bytes[..4].copy_from_slice(&(1u32 << 2).to_le_bytes());
    bytes[24..28].copy_from_slice(&160i32.to_le_bytes());
    bytes
}

fn shape_refs(refs: &[(u32, u32)]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(refs.len() * 8);
    for (start, shape) in refs {
        bytes.extend_from_slice(&start.to_le_bytes());
        bytes.extend_from_slice(&shape.to_le_bytes());
    }
    bytes
}

fn utf16_bytes(units: &[u16]) -> Vec<u8> {
    units.iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

fn push_record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    let header = ((data.len() as u32) << 20) | ((level as u32) << 10) | tag as u32;
    out.extend_from_slice(&header.to_le_bytes());
    out.extend_from_slice(data);
}
