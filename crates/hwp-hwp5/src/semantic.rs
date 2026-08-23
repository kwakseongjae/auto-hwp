use crate::{probe, Error, Hwp5Probe, Record, Result, StreamProbe};
use hwp_model::prelude::*;

const TAG_DOCUMENT_PROPERTIES: u16 = 0x10;
const TAG_ID_MAPPINGS: u16 = 0x11;
const TAG_BIN_DATA: u16 = 0x12;
const TAG_FACE_NAME: u16 = 0x13;
const TAG_BORDER_FILL: u16 = 0x14;
const TAG_CHAR_SHAPE: u16 = 0x15;
const TAG_TAB_DEF: u16 = 0x16;
const TAG_NUMBERING: u16 = 0x17;
const TAG_BULLET: u16 = 0x18;
const TAG_PARA_SHAPE: u16 = 0x19;
const TAG_STYLE: u16 = 0x1a;
const TAG_MEMO_SHAPE: u16 = 0x5c;

const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_TEXT: u16 = 0x43;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_PARA_LINE_SEG: u16 = 0x45;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_PAGE_DEF: u16 = 0x49;

const CTRL_SECTION_DEF: u32 = u32::from_be_bytes(*b"secd");

#[derive(Clone, Copy, Debug, Default)]
struct IdMappings {
    bin_data: usize,
    fonts: [usize; 7],
    border_fills: usize,
    char_shapes: usize,
    tab_defs: usize,
    numberings: usize,
    bullets: usize,
    para_shapes: usize,
    styles: usize,
    memo_shapes: usize,
}

#[derive(Clone, Debug)]
struct FontFace {
    name: String,
    panose: Option<[u8; 10]>,
}

struct Pools {
    section_count: usize,
    char_shapes: Vec<CharShape>,
    para_shapes: Vec<ParaShape>,
}

pub(crate) fn parse_text_only(bytes: &[u8]) -> Result<SemanticDoc> {
    let inspected = probe(bytes)?;
    let pools = parse_pools(&inspected)?;
    let section_streams: Vec<&StreamProbe> = inspected
        .streams
        .iter()
        .filter(|stream| stream.section.is_some())
        .collect();
    if pools.section_count != section_streams.len() {
        return Err(Error::PoolCountMismatch {
            tag: TAG_DOCUMENT_PROPERTIES,
            expected: pools.section_count,
            actual: section_streams.len(),
        });
    }

    let mut doc = SemanticDoc {
        char_shapes: vec![CharShape::default()],
        para_shapes: vec![ParaShape::default()],
        origin: Some(SourceFormat::Hwp5),
        ..SemanticDoc::default()
    };
    for (index, shape) in pools.char_shapes.into_iter().enumerate() {
        doc.header_pools.char.insert(index as u64, shape.clone());
        doc.char_shapes.push(shape);
    }
    for (index, shape) in pools.para_shapes.into_iter().enumerate() {
        doc.header_pools.para.insert(index as u64, shape.clone());
        doc.para_shapes.push(shape);
    }
    for stream in section_streams {
        doc.sections.push(parse_section(stream, &doc)?);
    }
    Ok(doc)
}

fn parse_pools(inspected: &Hwp5Probe) -> Result<Pools> {
    let stream = inspected
        .streams
        .iter()
        .find(|stream| stream.section.is_none())
        .ok_or(Error::MissingStream("DocInfo"))?;
    let props = exactly_one(stream, TAG_DOCUMENT_PROPERTIES)?;
    let mappings_record = exactly_one(stream, TAG_ID_MAPPINGS)?;
    if data(stream, props).len() < 26 {
        return Err(malformed(
            props,
            None,
            "DOCUMENT_PROPERTIES is shorter than the 26-byte base record",
        ));
    }
    let section_count =
        read_u16(data(stream, props), 0).expect("base record length checked") as usize;
    if section_count == 0 {
        return Err(malformed(
            props,
            None,
            "DOCUMENT_PROPERTIES section count is zero",
        ));
    }
    let mappings = parse_id_mappings(data(stream, mappings_record), mappings_record)?;
    validate_count(stream, TAG_BIN_DATA, mappings.bin_data)?;
    validate_count(stream, TAG_FACE_NAME, mappings.fonts.iter().sum())?;
    validate_count(stream, TAG_BORDER_FILL, mappings.border_fills)?;
    validate_count(stream, TAG_CHAR_SHAPE, mappings.char_shapes)?;
    validate_count(stream, TAG_TAB_DEF, mappings.tab_defs)?;
    validate_count(stream, TAG_NUMBERING, mappings.numberings)?;
    validate_count(stream, TAG_BULLET, mappings.bullets)?;
    validate_count(stream, TAG_PARA_SHAPE, mappings.para_shapes)?;
    validate_count(stream, TAG_STYLE, mappings.styles)?;
    validate_count(stream, TAG_MEMO_SHAPE, mappings.memo_shapes)?;

    let face_records: Vec<&Record> = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_FACE_NAME)
        .collect();
    let mut faces = vec![Vec::<FontFace>::new(); 7];
    let mut cursor = 0usize;
    for (language, count) in mappings.fonts.into_iter().enumerate() {
        for _ in 0..count {
            let record = face_records[cursor];
            faces[language].push(parse_face(data(stream, record), record)?);
            cursor += 1;
        }
    }

    let char_shapes = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_CHAR_SHAPE)
        .map(|record| parse_char_shape(data(stream, record), record, &faces))
        .collect::<Result<Vec<_>>>()?;
    let para_shapes = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_PARA_SHAPE)
        .map(|record| parse_para_shape(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;

    Ok(Pools {
        section_count,
        char_shapes,
        para_shapes,
    })
}

fn parse_id_mappings(bytes: &[u8], record: &Record) -> Result<IdMappings> {
    if bytes.len() < 60 {
        return Err(malformed(
            record,
            None,
            "ID_MAPPINGS is shorter than 15 u32 fields",
        ));
    }
    let mut word = 0usize;
    let mut next = || {
        let value = read_u32(bytes, word * 4).expect("minimum length checked") as usize;
        word += 1;
        value
    };
    let bin_data = next();
    let mut fonts = [0usize; 7];
    for count in &mut fonts {
        *count = next();
    }
    Ok(IdMappings {
        bin_data,
        fonts,
        border_fills: next(),
        char_shapes: next(),
        tab_defs: next(),
        numberings: next(),
        bullets: next(),
        para_shapes: next(),
        styles: next(),
        memo_shapes: read_u32(bytes, 60).unwrap_or(0) as usize,
    })
}

fn parse_face(bytes: &[u8], record: &Record) -> Result<FontFace> {
    let mut reader = Reader::new(bytes);
    let attr = reader
        .u8()
        .ok_or_else(|| malformed(record, None, "FACE_NAME has no attr"))?;
    let name = reader
        .hwp_string()
        .ok_or_else(|| malformed(record, None, "FACE_NAME has invalid UTF-16 name"))?;
    if attr & 0x80 != 0 {
        reader
            .u8()
            .ok_or_else(|| malformed(record, None, "FACE_NAME alternate type is truncated"))?;
        reader
            .hwp_string()
            .ok_or_else(|| malformed(record, None, "FACE_NAME alternate name is invalid"))?;
    }
    let panose = if attr & 0x40 != 0 {
        Some(
            reader
                .array10()
                .ok_or_else(|| malformed(record, None, "FACE_NAME PANOSE is truncated"))?,
        )
    } else {
        None
    };
    if attr & 0x20 != 0 {
        reader
            .hwp_string()
            .ok_or_else(|| malformed(record, None, "FACE_NAME default name is invalid"))?;
    }
    Ok(FontFace { name, panose })
}

fn parse_char_shape(bytes: &[u8], record: &Record, faces: &[Vec<FontFace>]) -> Result<CharShape> {
    if bytes.len() < 68 {
        return Err(malformed(
            record,
            None,
            "CHAR_SHAPE is shorter than the 68-byte base record",
        ));
    }
    let mut reader = Reader::new(bytes);
    let mut font_ids = [0u16; 7];
    for id in &mut font_ids {
        *id = reader.u16().expect("base length checked");
    }
    let mut ratios = [0u8; 7];
    for ratio in &mut ratios {
        *ratio = reader.u8().expect("base length checked");
    }
    let mut spacings = [0i8; 7];
    for spacing in &mut spacings {
        *spacing = reader.i8().expect("base length checked");
    }
    let mut relative_sizes = [0u8; 7];
    for size in &mut relative_sizes {
        *size = reader.u8().expect("base length checked");
    }
    let mut offsets = [0i8; 7];
    for offset in &mut offsets {
        *offset = reader.i8().expect("base length checked");
    }
    let height = reader.i32().expect("base length checked");
    if height <= 0 {
        return Err(malformed(
            record,
            None,
            "CHAR_SHAPE base size is not positive",
        ));
    }
    let attr = reader.u32().expect("base length checked");
    reader.skip(2).expect("base length checked");
    let text_color = bgr(reader.u32().expect("base length checked"));
    let underline_color = bgr(reader.u32().expect("base length checked"));
    let shade_color = bgr(reader.u32().expect("base length checked"));
    reader.skip(4).expect("base length checked"); // shadow color

    let mut fonts = Vec::with_capacity(7);
    let mut panose = Vec::with_capacity(7);
    for (language, id) in font_ids.into_iter().enumerate() {
        let face = faces[language]
            .get(id as usize)
            .ok_or(Error::InvalidReference {
                kind: "font",
                index: id as usize,
                pool_len: faces[language].len(),
                section: None,
                offset: record.head,
            })?;
        fonts.push((!face.name.is_empty()).then(|| face.name.clone()));
        panose.push(
            face.panose
                .filter(|value| hwp_model::font_class::classify_panose(value).is_some()),
        );
    }
    if panose.iter().all(Option::is_none) {
        panose.clear();
    }
    let strike_shape = ((attr >> 26) & 0x0f) as u8;
    Ok(CharShape {
        height,
        face_id: PerScript(font_ids),
        ratio: PerScript(ratios),
        spacing: PerScript(spacings),
        rel_size: PerScript(relative_sizes),
        offset: PerScript(offsets),
        italic: attr & 1 != 0,
        bold: attr & 2 != 0,
        underline: ((attr >> 2) & 0x03) == 1 || ((attr >> 2) & 0x03) == 3,
        outline: ((attr >> 8) & 0x07) != 0,
        shadow: ((attr >> 11) & 0x03) != 0,
        emboss: attr & (1 << 13) != 0,
        engrave: attr & (1 << 14) != 0,
        superscript: attr & (1 << 15) != 0,
        subscript: attr & (1 << 16) != 0,
        strikeout: ((attr >> 18) & 0x07) != 0 && strike_shape <= 12,
        use_font_space: attr & (1 << 25) != 0,
        use_kerning: attr & (1 << 30) != 0,
        text_color,
        shade_color,
        underline_color,
        fonts,
        font_panose: panose,
        ..CharShape::default()
    })
}

fn parse_para_shape(bytes: &[u8], record: &Record) -> Result<ParaShape> {
    if bytes.len() < 42 {
        return Err(malformed(
            record,
            None,
            "PARA_SHAPE is shorter than the 42-byte base record",
        ));
    }
    let attr = read_u32(bytes, 0).expect("base length checked");
    let tab_def = read_u16(bytes, 28).expect("base length checked");
    let numbering = read_u16(bytes, 30).expect("base length checked");
    let border = read_u16(bytes, 32).expect("base length checked");
    if tab_def != 0 || numbering != 0 || border != 0 {
        return Err(malformed(
            record,
            None,
            "text-only PARA_SHAPE references an unsupported pool",
        ));
    }
    Ok(ParaShape {
        align: match (attr >> 2) & 0x07 {
            1 => HorizontalAlign::Left,
            2 => HorizontalAlign::Right,
            3 => HorizontalAlign::Center,
            4 => HorizontalAlign::Distribute,
            5 => HorizontalAlign::DistributeSpace,
            _ => HorizontalAlign::Justify,
        },
        line_spacing_type: match attr & 0x03 {
            1 => LineSpacingType::Fixed,
            2 => LineSpacingType::BetweenLines,
            3 => LineSpacingType::AtLeast,
            _ => LineSpacingType::Percent,
        },
        left_margin: read_i32(bytes, 4).expect("base length checked"),
        right_margin: read_i32(bytes, 8).expect("base length checked"),
        indent: read_i32(bytes, 12).expect("base length checked"),
        space_before: read_i32(bytes, 16).expect("base length checked"),
        space_after: read_i32(bytes, 20).expect("base length checked"),
        line_spacing_value: read_i32(bytes, 24).expect("base length checked"),
        page_break_before: attr & (1 << 19) != 0,
        ..ParaShape::default()
    })
}

fn parse_section(stream: &StreamProbe, doc: &SemanticDoc) -> Result<Section> {
    let section = stream.section.expect("caller selected section streams");
    let mut blocks = Vec::new();
    let mut page = None;
    let starts: Vec<usize> = stream
        .records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            (record.tag == TAG_PARA_HEADER && record.level == 0).then_some(index)
        })
        .collect();
    if starts.is_empty() {
        return Err(Error::UnsupportedBodyRecord {
            tag: stream.records.first().map_or(0, |record| record.tag),
            section,
            start: stream.records.first().map_or(0, |record| record.head),
            end: stream.records.first().map_or(0, |record| record.end),
        });
    }
    if starts[0] != 0 {
        let record = stream.records[0];
        return Err(unsupported(record, section));
    }
    for (ordinal, start) in starts.iter().copied().enumerate() {
        let end = starts
            .get(ordinal + 1)
            .copied()
            .unwrap_or(stream.records.len());
        let parsed = parse_paragraph(stream, &stream.records[start..end], doc, section)?;
        if let Some(parsed_page) = parsed.page {
            if ordinal != 0 || page.replace(parsed_page).is_some() {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "section definition may occur only once and only in the first paragraph",
                ));
            }
        }
        blocks.push(Block::Paragraph(parsed.paragraph));
    }
    Ok(Section {
        blocks,
        page: page.unwrap_or_default(),
        provenance: Provenance {
            source: Some(SourceFormat::Hwp5),
            raw: None,
        },
        ..Section::default()
    })
}

struct ParsedParagraph {
    paragraph: Paragraph,
    page: Option<PageSetup>,
}

fn parse_paragraph(
    stream: &StreamProbe,
    records: &[Record],
    doc: &SemanticDoc,
    section: usize,
) -> Result<ParsedParagraph> {
    let header = records[0];
    let header_data = data(stream, &header);
    if header_data.len() < 22 {
        return Err(malformed(
            &header,
            Some(section),
            "PARA_HEADER is shorter than the 22-byte base record",
        ));
    }
    let char_count = read_u32(header_data, 0).expect("minimum length checked") & 0x7fff_ffff;
    let control_mask = read_u32(header_data, 4).expect("minimum length checked");
    let para_shape_id = read_u16(header_data, 8).expect("minimum length checked") as usize;
    let style_id = header_data[10];
    let break_type = header_data[11];
    let declared_char_shapes = read_u16(header_data, 12).expect("base length checked") as usize;
    let declared_range_tags = read_u16(header_data, 14).expect("base length checked");
    let declared_line_segments = read_u16(header_data, 16).expect("base length checked");
    if style_id != 0 || break_type & !0x04 != 0 || declared_range_tags != 0 {
        return Err(unsupported(header, section));
    }
    if para_shape_id + 1 >= doc.para_shapes.len() {
        return Err(Error::InvalidReference {
            kind: "paragraph shape",
            index: para_shape_id,
            pool_len: doc.para_shapes.len().saturating_sub(1),
            section: Some(section),
            offset: header.head,
        });
    }

    let mut text_record = None;
    let mut shape_record = None;
    let mut line_record = None;
    let mut section_control = None;
    let mut cursor = 1usize;
    while cursor < records.len() {
        let record = records[cursor];
        if record.level != 1 {
            return Err(unsupported(record, section));
        }
        match record.tag {
            TAG_PARA_TEXT if text_record.is_none() => text_record = Some(record),
            TAG_PARA_CHAR_SHAPE if shape_record.is_none() => shape_record = Some(record),
            TAG_PARA_LINE_SEG if line_record.is_none() => line_record = Some(record),
            TAG_CTRL_HEADER if section_control.is_none() => {
                if read_u32(data(stream, &record), 0) != Some(CTRL_SECTION_DEF) {
                    return Err(unsupported(record, section));
                }
                let start = cursor;
                cursor += 1;
                while cursor < records.len() && records[cursor].level > 1 {
                    cursor += 1;
                }
                section_control = Some((&records[start], &records[start + 1..cursor]));
                continue;
            }
            _ => return Err(unsupported(record, section)),
        }
        cursor += 1;
    }
    let decoded = match text_record {
        Some(record) => decode_text(data(stream, &record), record, section)?,
        None if char_count <= 1 => DecodedText::default(),
        None => {
            return Err(malformed(
                &header,
                Some(section),
                "PARA_HEADER declares text but PARA_TEXT is missing",
            ))
        }
    };
    if char_count != decoded.stored_units && !(decoded.stored_units == 0 && char_count == 1) {
        return Err(malformed(
            &header,
            Some(section),
            "PARA_HEADER character count differs from PARA_TEXT",
        ));
    }
    if control_mask != decoded.inline_control_mask {
        return Err(malformed(
            &header,
            Some(section),
            "PARA_HEADER control mask differs from supported PARA_TEXT controls",
        ));
    }
    let page = match (decoded.section_controls.as_slice(), section_control) {
        ([], None) => None,
        ([(marker_offset, marker_id)], Some((control, children)))
            if *marker_id == CTRL_SECTION_DEF =>
        {
            if *marker_offset != 0 {
                return Err(malformed(
                    control,
                    Some(section),
                    "section definition marker is not at paragraph start",
                ));
            }
            Some(parse_section_control(stream, control, children, section)?)
        }
        (_, Some((control, _))) => {
            return Err(malformed(
                control,
                Some(section),
                "section control header does not match PARA_TEXT marker",
            ))
        }
        (_, None) => {
            return Err(malformed(
                &header,
                Some(section),
                "PARA_TEXT section marker has no section control header",
            ))
        }
    };
    let refs = match shape_record {
        Some(record) => parse_shape_refs(data(stream, &record), record, section, doc)?,
        None => Vec::new(),
    };
    if refs.len() != declared_char_shapes {
        return Err(malformed(
            &header,
            Some(section),
            "PARA_HEADER character-shape count differs from PARA_CHAR_SHAPE",
        ));
    }
    let runs = make_runs(&decoded, &refs, shape_record, section)?;
    let line_metrics = parse_line_metrics(
        stream,
        line_record,
        declared_line_segments as usize,
        &decoded,
        &header,
        section,
    )?;
    Ok(ParsedParagraph {
        paragraph: Paragraph {
            para_shape: para_shape_id + 1,
            page_break_before: break_type & 0x04 != 0,
            runs,
            // Stored line boxes are only an authored-height hint for a true blank spacer.
            // They never dictate line breaks for visible text or a control-host paragraph.
            source_line_metrics: if decoded.chars.is_empty() && page.is_none() {
                line_metrics
            } else {
                Vec::new()
            },
            provenance: Provenance {
                source: Some(SourceFormat::Hwp5),
                raw: None,
            },
            ..Paragraph::default()
        },
        page,
    })
}

fn parse_section_control(
    stream: &StreamProbe,
    control: &Record,
    children: &[Record],
    section: usize,
) -> Result<PageSetup> {
    let bytes = data(stream, control);
    if bytes.len() != 28 {
        return Err(malformed(
            control,
            Some(section),
            "section CTRL_HEADER is not the owned 28-byte base record",
        ));
    }
    if read_u32(bytes, 0) != Some(CTRL_SECTION_DEF) {
        return Err(unsupported(*control, section));
    }
    if children.len() != 1 || children[0].tag != TAG_PAGE_DEF || children[0].level != 2 {
        let offending = children.first().copied().unwrap_or(*control);
        return Err(unsupported(offending, section));
    }
    parse_page_def(data(stream, &children[0]), &children[0], section)
}

fn parse_page_def(bytes: &[u8], record: &Record, section: usize) -> Result<PageSetup> {
    if bytes.len() != 40 {
        return Err(malformed(
            record,
            Some(section),
            "PAGE_DEF is not exactly 40 bytes",
        ));
    }
    let mut values = [0i32; 9];
    for (index, value) in values.iter_mut().enumerate() {
        let raw = read_u32(bytes, index * 4).expect("exact length checked");
        *value = i32::try_from(raw).map_err(|_| {
            malformed(
                record,
                Some(section),
                "PAGE_DEF dimension exceeds signed HWPUNIT range",
            )
        })?;
    }
    let attr = read_u32(bytes, 36).expect("exact length checked");
    if attr & !0x07 != 0 {
        return Err(malformed(
            record,
            Some(section),
            "PAGE_DEF has unsupported attribute bits",
        ));
    }
    // Alternating inside/outside margins need a page-parity model that PageSetup does not yet own.
    // Refuse instead of pretending duplex/top-flip are single-sided.
    if (attr >> 1) & 0x03 != 0 {
        return Err(malformed(
            record,
            Some(section),
            "PAGE_DEF binding mode is not yet supported",
        ));
    }
    let landscape = attr & 0x01 != 0;
    let [width, height, margin_left, margin_right, margin_top, margin_bottom, margin_header, margin_footer, margin_gutter] =
        values;
    if width == 0 || height == 0 {
        return Err(malformed(
            record,
            Some(section),
            "PAGE_DEF paper dimensions are zero",
        ));
    }
    let (display_width, display_height) = if landscape && width < height {
        (height as i64, width as i64)
    } else {
        (width as i64, height as i64)
    };
    let horizontal = margin_left as i64 + margin_gutter as i64 + margin_right as i64;
    let vertical =
        margin_top as i64 + margin_header as i64 + margin_bottom as i64 + margin_footer as i64;
    if horizontal >= display_width || vertical >= display_height {
        return Err(malformed(
            record,
            Some(section),
            "PAGE_DEF margins leave no positive body box",
        ));
    }
    Ok(PageSetup {
        width,
        height,
        margin_left,
        margin_right,
        margin_top,
        margin_bottom,
        margin_header,
        margin_footer,
        margin_gutter,
        landscape,
        columns: 1,
    })
}

fn parse_line_metrics(
    stream: &StreamProbe,
    record: Option<Record>,
    declared: usize,
    decoded: &DecodedText,
    header: &Record,
    section: usize,
) -> Result<Vec<SourceLineMetric>> {
    let Some(record) = record else {
        return if declared == 0 {
            Ok(Vec::new())
        } else {
            Err(malformed(
                header,
                Some(section),
                "PARA_HEADER declares line segments but PARA_LINE_SEG is missing",
            ))
        };
    };
    let bytes = data(stream, &record);
    if !bytes.len().is_multiple_of(36) {
        return Err(malformed(
            &record,
            Some(section),
            "PARA_LINE_SEG length is not a multiple of 36",
        ));
    }
    let actual = bytes.len() / 36;
    if actual != declared {
        return Err(malformed(
            header,
            Some(section),
            "PARA_HEADER line-segment count differs from PARA_LINE_SEG",
        ));
    }
    let mut prior_start = None;
    let mut metrics = Vec::with_capacity(actual);
    let mut all_zero_height = true;
    for entry in bytes.chunks_exact(36) {
        let text_start = read_u32(entry, 0).expect("chunk length checked");
        if prior_start.is_some_and(|prior| prior > text_start) {
            return Err(malformed(
                &record,
                Some(section),
                "PARA_LINE_SEG text starts are not ordered",
            ));
        }
        if !decoded.is_boundary(text_start) {
            return Err(malformed(
                &record,
                Some(section),
                "PARA_LINE_SEG text start is not a scalar/control boundary",
            ));
        }
        prior_start = Some(text_start);
        let vertical_pos = read_i32(entry, 4).expect("chunk length checked");
        let height = read_i32(entry, 8).expect("chunk length checked");
        let text_height = read_i32(entry, 12).expect("chunk length checked");
        let baseline = read_i32(entry, 16).expect("chunk length checked");
        let line_spacing = read_i32(entry, 20).expect("chunk length checked");
        let segment_width = read_i32(entry, 28).expect("chunk length checked");
        if [
            vertical_pos,
            height,
            text_height,
            baseline,
            line_spacing,
            segment_width,
        ]
        .into_iter()
        .any(|value| value < 0)
        {
            return Err(malformed(
                &record,
                Some(section),
                "PARA_LINE_SEG has a negative geometry field",
            ));
        }
        all_zero_height &= height == 0 && text_height == 0;
        metrics.push(SourceLineMetric {
            height,
            text_height,
            baseline,
        });
    }
    if all_zero_height {
        metrics.clear();
    }
    Ok(metrics)
}

#[derive(Default)]
struct DecodedText {
    chars: Vec<(u32, char)>,
    section_controls: Vec<(u32, u32)>,
    stored_units: u32,
    inline_control_mask: u32,
}

impl DecodedText {
    fn is_boundary(&self, offset: u32) -> bool {
        offset == 0
            || self
                .chars
                .binary_search_by_key(&offset, |(start, _)| *start)
                .is_ok()
            || self
                .section_controls
                .binary_search_by_key(&offset, |(start, _)| *start)
                .is_ok()
    }
}

fn decode_text(bytes: &[u8], record: Record, section: usize) -> Result<DecodedText> {
    if !bytes.len().is_multiple_of(2) {
        return Err(malformed(
            &record,
            Some(section),
            "PARA_TEXT byte length is odd",
        ));
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let mut chars = Vec::new();
    let mut section_controls = Vec::new();
    let mut cursor = 0usize;
    let mut ended = false;
    let mut inline_control_mask = 0u32;
    while cursor < units.len() {
        let start = cursor as u32;
        let unit = units[cursor];
        match unit {
            0x000d => {
                ended = true;
                cursor += 1;
                if units[cursor..].iter().any(|unit| *unit != 0) {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "PARA_TEXT has data after paragraph terminator",
                    ));
                }
                cursor = units.len();
            }
            0x0009 => {
                if cursor + 8 > units.len() {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "PARA_TEXT tab control is truncated",
                    ));
                }
                chars.push((start, '\t'));
                inline_control_mask |= 1 << 0x0009;
                cursor += 8;
            }
            0x0002 => {
                if cursor + 8 > units.len() {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "PARA_TEXT section control is truncated",
                    ));
                }
                if units[cursor + 7] != unit || units[cursor + 3..cursor + 7] != [0; 4] {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "PARA_TEXT section control framing is invalid",
                    ));
                }
                let lo = units[cursor + 1].to_le_bytes();
                let hi = units[cursor + 2].to_le_bytes();
                let control_id = u32::from_le_bytes([lo[0], lo[1], hi[0], hi[1]]);
                if control_id != CTRL_SECTION_DEF {
                    return Err(unsupported(record, section));
                }
                section_controls.push((start, control_id));
                inline_control_mask |= 1 << 0x0002;
                cursor += 8;
            }
            0x000a => {
                chars.push((start, '\n'));
                inline_control_mask |= 1 << 0x000a;
                cursor += 1;
            }
            0x0018 => {
                chars.push((start, '-'));
                cursor += 1;
            }
            0x0019 => {
                chars.push((start, ' '));
                cursor += 1;
            }
            0x001e => {
                chars.push((start, '\u{00a0}'));
                cursor += 1;
            }
            0x001f => {
                chars.push((start, '\u{2007}'));
                inline_control_mask |= 1 << 0x001f;
                cursor += 1;
            }
            0x0000 => cursor += 1,
            0x0001..=0x001f => return Err(unsupported(record, section)),
            0xd800..=0xdbff => {
                let Some(low) = units.get(cursor + 1).copied() else {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "high surrogate is truncated",
                    ));
                };
                if !(0xdc00..=0xdfff).contains(&low) {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "high surrogate has no low pair",
                    ));
                }
                let scalar = 0x10000 + (((unit as u32) - 0xd800) << 10) + ((low as u32) - 0xdc00);
                chars.push((
                    start,
                    char::from_u32(scalar).expect("validated surrogate pair is scalar"),
                ));
                cursor += 2;
            }
            0xdc00..=0xdfff => {
                return Err(malformed(&record, Some(section), "unpaired low surrogate"))
            }
            _ => {
                chars.push((
                    start,
                    char::from_u32(unit as u32).expect("non-surrogate u16"),
                ));
                cursor += 1;
            }
        }
    }
    if !ended && !units.is_empty() {
        return Err(malformed(
            &record,
            Some(section),
            "PARA_TEXT has no paragraph terminator",
        ));
    }
    Ok(DecodedText {
        chars,
        section_controls,
        stored_units: units.len() as u32,
        inline_control_mask,
    })
}

fn parse_shape_refs(
    bytes: &[u8],
    record: Record,
    section: usize,
    doc: &SemanticDoc,
) -> Result<Vec<(u32, usize)>> {
    if !bytes.len().is_multiple_of(8) {
        return Err(malformed(
            &record,
            Some(section),
            "PARA_CHAR_SHAPE length is not a multiple of 8",
        ));
    }
    let mut refs = Vec::new();
    for entry in bytes.chunks_exact(8) {
        let start = u32::from_le_bytes(entry[..4].try_into().expect("four-byte chunk"));
        let raw_id = u32::from_le_bytes(entry[4..].try_into().expect("four-byte chunk")) as usize;
        let pool_len = doc.char_shapes.len().saturating_sub(1);
        if raw_id >= pool_len {
            return Err(Error::InvalidReference {
                kind: "character shape",
                index: raw_id,
                pool_len,
                section: Some(section),
                offset: record.head,
            });
        }
        if refs.last().is_some_and(|(prior, _)| *prior >= start) {
            return Err(malformed(
                &record,
                Some(section),
                "PARA_CHAR_SHAPE boundaries are not strictly increasing",
            ));
        }
        refs.push((start, raw_id + 1));
    }
    Ok(refs)
}

fn make_runs(
    decoded: &DecodedText,
    refs: &[(u32, usize)],
    record: Option<Record>,
    section: usize,
) -> Result<Vec<Run>> {
    if decoded.chars.is_empty() {
        return match refs {
            [] => Ok(Vec::new()),
            [(0, shape)] => Ok(vec![Run {
                char_shape: *shape,
                content: Vec::new(),
                ..Run::default()
            }]),
            _ => Err(malformed(
                &record.expect("non-empty refs have a source record"),
                Some(section),
                "empty paragraph has invalid PARA_CHAR_SHAPE boundaries",
            )),
        };
    }
    if refs.first().is_some_and(|(start, _)| *start != 0) {
        return Err(malformed(
            &record.expect("non-empty refs have a source record"),
            Some(section),
            "first PARA_CHAR_SHAPE boundary is not zero",
        ));
    }
    let effective: Vec<(u32, usize)> = if refs.is_empty() {
        vec![(0, 0)]
    } else {
        refs.to_vec()
    };
    for (start, _) in &effective {
        if !decoded.is_boundary(*start) {
            return Err(malformed(
                &record.expect("styled boundaries have a source record"),
                Some(section),
                "PARA_CHAR_SHAPE boundary is not a scalar start",
            ));
        }
    }
    let mut runs = Vec::new();
    let mut ref_index = 0usize;
    let mut current_shape = effective[0].1;
    let mut current_text = String::new();
    for (offset, value) in &decoded.chars {
        while ref_index + 1 < effective.len() && effective[ref_index + 1].0 <= *offset {
            ref_index += 1;
            let next_shape = effective[ref_index].1;
            if next_shape != current_shape && !current_text.is_empty() {
                runs.push(Run {
                    char_shape: current_shape,
                    content: vec![Inline::Text(std::mem::take(&mut current_text))],
                    ..Run::default()
                });
            }
            current_shape = next_shape;
        }
        current_text.push(*value);
    }
    if !current_text.is_empty() {
        runs.push(Run {
            char_shape: current_shape,
            content: vec![Inline::Text(current_text)],
            ..Run::default()
        });
    }
    Ok(runs)
}

fn exactly_one(stream: &StreamProbe, tag: u16) -> Result<&Record> {
    let mut records = stream.records.iter().filter(|record| record.tag == tag);
    let first = records.next().ok_or(Error::PoolCountMismatch {
        tag,
        expected: 1,
        actual: 0,
    })?;
    if records.next().is_some() {
        return Err(Error::PoolCountMismatch {
            tag,
            expected: 1,
            actual: stream
                .records
                .iter()
                .filter(|record| record.tag == tag)
                .count(),
        });
    }
    Ok(first)
}

fn validate_count(stream: &StreamProbe, tag: u16, expected: usize) -> Result<()> {
    let actual = stream
        .records
        .iter()
        .filter(|record| record.tag == tag)
        .count();
    if actual != expected {
        return Err(Error::PoolCountMismatch {
            tag,
            expected,
            actual,
        });
    }
    Ok(())
}

fn data<'a>(stream: &'a StreamProbe, record: &Record) -> &'a [u8] {
    &stream.raw[record.data..record.end]
}

fn malformed(record: &Record, section: Option<usize>, reason: &'static str) -> Error {
    Error::MalformedRecord {
        tag: record.tag,
        section,
        offset: record.head,
        reason,
    }
}

fn unsupported(record: Record, section: usize) -> Error {
    Error::UnsupportedBodyRecord {
        tag: record.tag,
        section,
        start: record.head,
        end: record.end,
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn bgr(value: u32) -> Color {
    if value & 0x00ff_ffff == 0 {
        Color::default()
    } else {
        Color {
            r: (value & 0xff) as u8,
            g: ((value >> 8) & 0xff) as u8,
            b: ((value >> 16) & 0xff) as u8,
            a: 255,
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn u8(&mut self) -> Option<u8> {
        let value = *self.bytes.get(self.cursor)?;
        self.cursor += 1;
        Some(value)
    }

    fn i8(&mut self) -> Option<i8> {
        Some(self.u8()? as i8)
    }

    fn u16(&mut self) -> Option<u16> {
        let value = read_u16(self.bytes, self.cursor)?;
        self.cursor += 2;
        Some(value)
    }

    fn u32(&mut self) -> Option<u32> {
        let value = read_u32(self.bytes, self.cursor)?;
        self.cursor += 4;
        Some(value)
    }

    fn i32(&mut self) -> Option<i32> {
        Some(self.u32()? as i32)
    }

    fn skip(&mut self, count: usize) -> Option<()> {
        self.bytes.get(self.cursor..self.cursor + count)?;
        self.cursor += count;
        Some(())
    }

    fn array10(&mut self) -> Option<[u8; 10]> {
        let value = self.bytes.get(self.cursor..self.cursor + 10)?;
        self.cursor += 10;
        value.try_into().ok()
    }

    fn hwp_string(&mut self) -> Option<String> {
        let length = self.u16()? as usize;
        let bytes = self
            .bytes
            .get(self.cursor..self.cursor + length.checked_mul(2)?)?;
        self.cursor += bytes.len();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).ok()
    }
}
