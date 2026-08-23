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
const TAG_LIST_HEADER: u16 = 0x48;
const TAG_PAGE_DEF: u16 = 0x49;
const TAG_TABLE: u16 = 0x4d;

const CTRL_SECTION_DEF: u32 = u32::from_be_bytes(*b"secd");
const CTRL_COLUMN_DEF: u32 = u32::from_be_bytes(*b"cold");
const CTRL_PAGE_NUM_POS: u32 = u32::from_be_bytes(*b"pgnp");
const CTRL_NEW_NUMBER: u32 = u32::from_be_bytes(*b"nwno");
const CTRL_TABLE: u32 = u32::from_be_bytes(*b"tbl ");

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
    para_usage: Vec<ParaUsage>,
    border_fills: Vec<BorderFillDef>,
    styles: Vec<StyleDef>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ParaUsage {
    has_custom_tabs: bool,
    numbering: u16,
    border_fill: u16,
    head_type: u8,
}

#[derive(Clone, Debug, Default)]
struct TabDef {
    custom_count: usize,
}

#[derive(Clone, Debug, Default)]
struct NumberingDef {
    char_shape_refs: Vec<u32>,
}

#[derive(Clone, Debug, Default)]
struct BulletDef {
    char_shape_ref: u32,
}

#[derive(Clone, Copy, Debug)]
struct StyleDef {
    kind: u8,
    next_style: u8,
    para_shape: u16,
    char_shape: u16,
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
    for (index, border) in pools.border_fills.into_iter().enumerate() {
        doc.header_pools.border.insert((index + 1) as u64, border);
    }
    for stream in section_streams {
        doc.sections.push(parse_section(
            stream,
            &doc,
            &pools.para_usage,
            &pools.styles,
            pools.section_count == 1,
        )?);
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
    let border_fills = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_BORDER_FILL)
        .map(|record| parse_border_fill(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;
    let tab_defs = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_TAB_DEF)
        .map(|record| parse_tab_def(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;
    let numberings = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_NUMBERING)
        .map(|record| parse_numbering(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;
    let bullets = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_BULLET)
        .map(|record| parse_bullet(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;
    validate_support_refs(&numberings, &bullets, char_shapes.len(), stream)?;
    let parsed_para_shapes = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_PARA_SHAPE)
        .map(|record| {
            parse_para_shape(
                data(stream, record),
                record,
                &tab_defs,
                numberings.len(),
                bullets.len(),
                border_fills.len(),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let (para_shapes, para_usage): (Vec<_>, Vec<_>) = parsed_para_shapes.into_iter().unzip();
    let style_records: Vec<&Record> = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_STYLE)
        .collect();
    let styles = style_records
        .iter()
        .map(|record| parse_style(data(stream, record), record))
        .collect::<Result<Vec<_>>>()?;
    validate_style_refs(
        &styles,
        &style_records,
        para_shapes.len(),
        char_shapes.len(),
    )?;

    Ok(Pools {
        section_count,
        char_shapes,
        para_shapes,
        para_usage,
        border_fills,
        styles,
    })
}

fn parse_style(bytes: &[u8], record: &Record) -> Result<StyleDef> {
    let mut reader = Reader::new(bytes);
    reader
        .hwp_string()
        .ok_or_else(|| malformed(record, None, "STYLE local name is invalid UTF-16"))?;
    reader
        .hwp_string()
        .ok_or_else(|| malformed(record, None, "STYLE English name is invalid UTF-16"))?;
    let attr = reader
        .u8()
        .ok_or_else(|| malformed(record, None, "STYLE metadata is truncated"))?;
    if attr & !0x07 != 0 || attr & 0x07 > 1 {
        return Err(malformed(
            record,
            None,
            "STYLE has an unknown kind or attributes",
        ));
    }
    let next_style = reader
        .u8()
        .ok_or_else(|| malformed(record, None, "STYLE metadata is truncated"))?;
    reader
        .u16()
        .ok_or_else(|| malformed(record, None, "STYLE language id is truncated"))?;
    let para_shape = reader
        .u16()
        .ok_or_else(|| malformed(record, None, "STYLE paragraph-shape ref is truncated"))?;
    let char_shape = reader
        .u16()
        .ok_or_else(|| malformed(record, None, "STYLE character-shape ref is truncated"))?;
    match reader.remaining() {
        0 => {}
        2 if reader.u16() == Some(0) => {}
        2 => return Err(malformed(record, None, "STYLE reserved tail is nonzero")),
        _ => return Err(malformed(record, None, "STYLE has unknown trailing bytes")),
    }
    Ok(StyleDef {
        kind: attr & 0x07,
        next_style,
        para_shape,
        char_shape,
    })
}

fn validate_style_refs(
    styles: &[StyleDef],
    records: &[&Record],
    para_shapes: usize,
    char_shapes: usize,
) -> Result<()> {
    for (style, record) in styles.iter().zip(records.iter().copied()) {
        if style.next_style as usize >= styles.len() {
            return Err(invalid_pool_ref(
                "next style",
                style.next_style as usize,
                styles.len(),
                record,
            ));
        }
        match style.kind {
            0 if style.para_shape as usize >= para_shapes => {
                return Err(invalid_pool_ref(
                    "style paragraph shape",
                    style.para_shape as usize,
                    para_shapes,
                    record,
                ));
            }
            1 if style.char_shape as usize >= char_shapes => {
                return Err(invalid_pool_ref(
                    "style character shape",
                    style.char_shape as usize,
                    char_shapes,
                    record,
                ));
            }
            _ => {}
        }
    }
    Ok(())
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

fn parse_border_fill(bytes: &[u8], record: &Record) -> Result<BorderFillDef> {
    let mut reader = Reader::new(bytes);
    let attr = reader
        .u16()
        .ok_or_else(|| malformed(record, None, "BORDER_FILL has no attributes"))?;
    let mut borders = [None; 4];
    let mut has_border = false;
    for edge in &mut borders {
        let line_type = reader
            .u8()
            .ok_or_else(|| malformed(record, None, "BORDER_FILL edge is truncated"))?;
        let width = reader
            .u8()
            .ok_or_else(|| malformed(record, None, "BORDER_FILL edge is truncated"))?;
        let color = reader
            .u32()
            .ok_or_else(|| malformed(record, None, "BORDER_FILL edge is truncated"))?;
        let style = border_line_style(line_type)
            .ok_or_else(|| malformed(record, None, "BORDER_FILL has an unknown line type"))?;
        if width > 15 {
            return Err(malformed(
                record,
                None,
                "BORDER_FILL has an unknown line width",
            ));
        }
        has_border |= style != LineStyle::None;
        *edge = Some(CellEdge {
            color: opaque_bgr(color),
            style,
            width_px: border_width_px(width),
        });
    }
    let diagonal_type = reader
        .u8()
        .ok_or_else(|| malformed(record, None, "BORDER_FILL diagonal is truncated"))?;
    let diagonal_width = reader
        .u8()
        .ok_or_else(|| malformed(record, None, "BORDER_FILL diagonal is truncated"))?;
    let diagonal_color = reader
        .u32()
        .ok_or_else(|| malformed(record, None, "BORDER_FILL diagonal is truncated"))?;
    let diagonal_style = border_line_style(diagonal_type)
        .ok_or_else(|| malformed(record, None, "BORDER_FILL has an unknown diagonal type"))?;
    if diagonal_width > 15 {
        return Err(malformed(
            record,
            None,
            "BORDER_FILL has an unknown diagonal width",
        ));
    }
    let diagonal = diagonal_kind(attr, diagonal_style).map(|kind| CellDiagonal {
        kind,
        color: opaque_bgr(diagonal_color),
        width_px: border_width_px(diagonal_width),
    });

    let fill_type = reader
        .u32()
        .ok_or_else(|| malformed(record, None, "BORDER_FILL has no fill type"))?;
    let shade = match fill_type {
        0 => {
            let reserved = reader
                .u32()
                .ok_or_else(|| malformed(record, None, "BORDER_FILL no-fill tail is truncated"))?;
            if reserved != 0 {
                return Err(malformed(
                    record,
                    None,
                    "BORDER_FILL no-fill tail is not zero",
                ));
            }
            None
        }
        1 => {
            let face = reader
                .u32()
                .ok_or_else(|| malformed(record, None, "BORDER_FILL solid fill is truncated"))?;
            let _pattern_color = reader
                .u32()
                .ok_or_else(|| malformed(record, None, "BORDER_FILL solid fill is truncated"))?;
            let pattern = reader
                .i32()
                .ok_or_else(|| malformed(record, None, "BORDER_FILL solid fill is truncated"))?;
            if pattern != -1 {
                return Err(malformed(
                    record,
                    None,
                    "BORDER_FILL pattern semantics are not supported",
                ));
            }
            let additional = reader.u32().ok_or_else(|| {
                malformed(record, None, "BORDER_FILL additional property is truncated")
            })?;
            if additional != 0 {
                return Err(malformed(
                    record,
                    None,
                    "BORDER_FILL additional property is not supported",
                ));
            }
            let alpha = reader
                .u8()
                .ok_or_else(|| malformed(record, None, "BORDER_FILL alpha is truncated"))?;
            if alpha != 0 {
                return Err(malformed(
                    record,
                    None,
                    "BORDER_FILL alpha is not supported",
                ));
            }
            nondefault_shade(face)
        }
        value if value & !0x07 != 0 => {
            return Err(malformed(record, None, "BORDER_FILL has unknown fill bits"))
        }
        _ => {
            return Err(malformed(
                record,
                None,
                "BORDER_FILL image, gradient, or mixed fill is not supported",
            ))
        }
    };
    if !reader.is_finished() {
        return Err(malformed(
            record,
            None,
            "BORDER_FILL has an unowned trailing payload",
        ));
    }
    Ok(BorderFillDef {
        borders,
        shade,
        diagonal,
        has_border,
    })
}

fn parse_tab_def(bytes: &[u8], record: &Record) -> Result<TabDef> {
    let mut reader = Reader::new(bytes);
    let attr = reader
        .u32()
        .ok_or_else(|| malformed(record, None, "TAB_DEF header is truncated"))?;
    if attr & !0x03 != 0 {
        return Err(malformed(
            record,
            None,
            "TAB_DEF has unsupported attribute bits",
        ));
    }
    let count = reader
        .u32()
        .ok_or_else(|| malformed(record, None, "TAB_DEF count is truncated"))?
        as usize;
    let payload = count.checked_mul(8).ok_or_else(|| {
        malformed(
            record,
            None,
            "TAB_DEF item count exceeds the bounded payload",
        )
    })?;
    if reader.remaining() != payload {
        return Err(malformed(
            record,
            None,
            "TAB_DEF count differs from its item payload",
        ));
    }
    for _ in 0..count {
        let _position = reader.u32().expect("payload length checked");
        let tab_type = reader.u8().expect("payload length checked");
        let fill_type = reader.u8().expect("payload length checked");
        let reserved = reader.u16().expect("payload length checked");
        if tab_type > 3 || fill_type > 16 || reserved != 0 {
            return Err(malformed(
                record,
                None,
                "TAB_DEF item has an unsupported type or reserved value",
            ));
        }
    }
    Ok(TabDef {
        custom_count: count,
    })
}

fn parse_numbering(bytes: &[u8], record: &Record) -> Result<NumberingDef> {
    let mut reader = Reader::new(bytes);
    let mut char_shape_refs = Vec::with_capacity(7);
    for _ in 0..7 {
        reader
            .u32()
            .ok_or_else(|| malformed(record, None, "NUMBERING head is truncated"))?;
        reader
            .skip(4)
            .ok_or_else(|| malformed(record, None, "NUMBERING head is truncated"))?;
        char_shape_refs.push(
            reader
                .u32()
                .ok_or_else(|| malformed(record, None, "NUMBERING head is truncated"))?,
        );
        reader
            .hwp_string()
            .ok_or_else(|| malformed(record, None, "NUMBERING format string is invalid"))?;
    }
    reader
        .u16()
        .ok_or_else(|| malformed(record, None, "NUMBERING start value is truncated"))?;
    if reader.remaining() != 0 {
        if reader.remaining() < 28 {
            return Err(malformed(
                record,
                None,
                "NUMBERING has a partial level-start extension",
            ));
        }
        for _ in 0..7 {
            reader.u32().expect("extension length checked");
        }
        if reader.remaining() != 0 {
            // HWP 5.1 stores levels 8–10 as three interleaved extended
            // heads, format strings, and start values. We consume that
            // structure exactly but keep active numbering fail-closed until
            // the extended head semantics are independently owned.
            for _ in 0..3 {
                reader.u32().ok_or_else(|| {
                    malformed(record, None, "NUMBERING extended head is truncated")
                })?;
                reader.skip(8).ok_or_else(|| {
                    malformed(record, None, "NUMBERING extended head is truncated")
                })?;
                reader.hwp_string().ok_or_else(|| {
                    malformed(record, None, "NUMBERING extended format string is invalid")
                })?;
                reader.u32().ok_or_else(|| {
                    malformed(record, None, "NUMBERING extended start value is truncated")
                })?;
            }
            if !reader.is_finished() {
                return Err(malformed(
                    record,
                    None,
                    "NUMBERING has an unknown trailing extension",
                ));
            }
        }
    }
    Ok(NumberingDef { char_shape_refs })
}

fn parse_bullet(bytes: &[u8], record: &Record) -> Result<BulletDef> {
    let mut reader = Reader::new(bytes);
    reader
        .u32()
        .ok_or_else(|| malformed(record, None, "BULLET head is truncated"))?;
    reader
        .skip(4)
        .ok_or_else(|| malformed(record, None, "BULLET head is truncated"))?;
    let char_shape_ref = reader
        .u32()
        .ok_or_else(|| malformed(record, None, "BULLET head is truncated"))?;
    reader
        .u16()
        .ok_or_else(|| malformed(record, None, "BULLET character is truncated"))?;
    match reader.remaining() {
        0 => false,
        10 => {
            let image = reader.u32().expect("extension length checked") != 0;
            reader.skip(4).expect("extension length checked");
            reader.u16().expect("extension length checked");
            image
        }
        _ => {
            return Err(malformed(
                record,
                None,
                "BULLET has a partial or unknown extension",
            ))
        }
    };
    Ok(BulletDef { char_shape_ref })
}

fn validate_support_refs(
    numberings: &[NumberingDef],
    bullets: &[BulletDef],
    char_shapes: usize,
    stream: &StreamProbe,
) -> Result<()> {
    let numbering_records: Vec<_> = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_NUMBERING)
        .collect();
    for (definition, record) in numberings.iter().zip(numbering_records) {
        for &reference in &definition.char_shape_refs {
            if reference != u32::MAX && reference as usize >= char_shapes {
                return Err(invalid_pool_ref(
                    "numbering character shape",
                    reference as usize,
                    char_shapes,
                    record,
                ));
            }
        }
    }
    let bullet_records: Vec<_> = stream
        .records
        .iter()
        .filter(|record| record.tag == TAG_BULLET)
        .collect();
    for (definition, record) in bullets.iter().zip(bullet_records) {
        if definition.char_shape_ref != u32::MAX
            && definition.char_shape_ref as usize >= char_shapes
        {
            return Err(invalid_pool_ref(
                "bullet character shape",
                definition.char_shape_ref as usize,
                char_shapes,
                record,
            ));
        }
    }
    Ok(())
}

fn parse_para_shape(
    bytes: &[u8],
    record: &Record,
    tab_defs: &[TabDef],
    numberings: usize,
    bullets: usize,
    border_fills: usize,
) -> Result<(ParaShape, ParaUsage)> {
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
    if tab_defs.is_empty() {
        if tab_def != 0 {
            return Err(invalid_pool_ref(
                "tab definition",
                tab_def as usize,
                0,
                record,
            ));
        }
    } else if tab_def as usize >= tab_defs.len() {
        return Err(invalid_pool_ref(
            "tab definition",
            tab_def as usize,
            tab_defs.len(),
            record,
        ));
    }
    let head_type = ((attr >> 23) & 0x03) as u8;
    let head_pool = if head_type == 3 { bullets } else { numberings };
    if numbering != 0 && numbering as usize > head_pool {
        return Err(invalid_pool_ref(
            if head_type == 3 {
                "bullet"
            } else {
                "numbering"
            },
            numbering as usize,
            head_pool,
            record,
        ));
    }
    if border != 0 && border as usize > border_fills {
        return Err(invalid_pool_ref(
            "border fill",
            border as usize,
            border_fills,
            record,
        ));
    }
    let shape = ParaShape {
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
        widow_orphan: attr & (1 << 16) != 0,
        keep_with_next: attr & (1 << 17) != 0,
        keep_lines: attr & (1 << 18) != 0,
        page_break_before: attr & (1 << 19) != 0,
        numbering_id: numbering,
        border_fill_id: border,
        ..ParaShape::default()
    };
    Ok((
        shape,
        ParaUsage {
            has_custom_tabs: tab_defs
                .get(tab_def as usize)
                .is_some_and(|definition| definition.custom_count != 0),
            numbering,
            border_fill: border,
            head_type,
        },
    ))
}

fn parse_section(
    stream: &StreamProbe,
    doc: &SemanticDoc,
    para_usage: &[ParaUsage],
    styles: &[StyleDef],
    allow_page_number: bool,
) -> Result<Section> {
    let section = stream.section.expect("caller selected section streams");
    if !allow_page_number {
        if let Some(control) = stream.records.iter().find(|record| {
            record.tag == TAG_CTRL_HEADER
                && matches!(
                    read_u32(data(stream, record), 0),
                    Some(CTRL_PAGE_NUM_POS) | Some(CTRL_NEW_NUMBER)
                )
        }) {
            return Err(malformed(
                control,
                Some(section),
                "multi-section page-number inheritance is not yet supported",
            ));
        }
    }
    let mut blocks = Vec::new();
    let mut page = None;
    let mut page_number = None;
    let mut has_active_columns = false;
    let mut column_zone_count = 0usize;
    let mut separator_zone_seen = false;
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
            reason: "section has no top-level paragraph header",
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
        let mut parsed = parse_paragraph(
            stream,
            &stream.records[start..end],
            doc,
            para_usage,
            styles,
            section,
            page.as_ref(),
            0,
        )?;
        if let Some(parsed_page) = parsed.page {
            if ordinal != 0 || page.replace(parsed_page).is_some() {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "section definition may occur only once and only in the first paragraph",
                ));
            }
        }
        if let Some(parsed_page_number) = parsed.page_number {
            if ordinal != 0 || page_number.replace(parsed_page_number).is_some() {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "page-number position may occur only once and only in the first paragraph",
                ));
            }
        }
        if parsed.paragraph.column_break_before
            && parsed.paragraph.column_layout_before.is_none()
            && !has_active_columns
        {
            return Err(malformed(
                &stream.records[start],
                Some(section),
                "column break appears before an owned column definition",
            ));
        }
        if let Some(layout) = &parsed.paragraph.column_layout_before {
            let has_separator = layout.separator.is_some();
            if has_separator && ordinal != 0 {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "column separator zone must begin with its section",
                ));
            }
            if column_zone_count != 0 && (separator_zone_seen || has_separator) {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "multiple column zones with separators are not yet supported",
                ));
            }
            column_zone_count += 1;
            separator_zone_seen |= has_separator;
            has_active_columns = true;
        }
        if !parsed.tables.is_empty() {
            if parsed.paragraph.runs.iter().any(|run| {
                run.content
                    .iter()
                    .any(|inline| matches!(inline, Inline::Text(text) if !text.is_empty()))
            }) {
                return Err(malformed(
                    &stream.records[start],
                    Some(section),
                    "owned inline table host also contains visible text",
                ));
            }
            parsed.paragraph.is_table_anchor = true;
        }
        blocks.push(Block::Paragraph(parsed.paragraph));
        blocks.extend(parsed.tables.into_iter().map(Block::Table));
    }
    Ok(Section {
        blocks,
        page: page.unwrap_or_default(),
        page_number,
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
    page_number: Option<PageNumberDecoration>,
    tables: Vec<Table>,
}

#[allow(clippy::too_many_arguments)]
fn parse_paragraph(
    stream: &StreamProbe,
    records: &[Record],
    doc: &SemanticDoc,
    para_usage: &[ParaUsage],
    styles: &[StyleDef],
    section: usize,
    _current_page: Option<&PageSetup>,
    table_depth: usize,
) -> Result<ParsedParagraph> {
    let header = records[0];
    let base_level = header.level;
    if header.tag != TAG_PARA_HEADER {
        return Err(unsupported(header, section));
    }
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
    if (styles.is_empty() && style_id != 0)
        || (!styles.is_empty() && style_id as usize >= styles.len())
    {
        return Err(Error::InvalidReference {
            kind: "paragraph style",
            index: style_id as usize,
            pool_len: styles.len(),
            section: Some(section),
            offset: header.head,
        });
    }
    if break_type & !0x0f != 0 {
        return Err(unsupported_reason(
            header,
            section,
            "paragraph break type has unknown bits",
        ));
    }
    if declared_range_tags != 0 {
        return Err(unsupported_reason(
            header,
            section,
            "paragraph range tags are not owned",
        ));
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
    let usage = para_usage
        .get(para_shape_id)
        .ok_or(Error::InvalidReference {
            kind: "paragraph usage",
            index: para_shape_id,
            pool_len: para_usage.len(),
            section: Some(section),
            offset: header.head,
        })?;

    let mut text_record = None;
    let mut shape_record = None;
    let mut line_record = None;
    let mut structural_controls = Vec::new();
    let mut cursor = 1usize;
    while cursor < records.len() {
        let record = records[cursor];
        if record.level != base_level + 1 {
            return Err(unsupported(record, section));
        }
        match record.tag {
            TAG_PARA_TEXT if text_record.is_none() => text_record = Some(record),
            TAG_PARA_CHAR_SHAPE if shape_record.is_none() => shape_record = Some(record),
            TAG_PARA_LINE_SEG if line_record.is_none() => line_record = Some(record),
            TAG_CTRL_HEADER => {
                let Some(control_id) = read_u32(data(stream, &record), 0) else {
                    return Err(malformed(
                        &record,
                        Some(section),
                        "structural CTRL_HEADER is shorter than its control id",
                    ));
                };
                if !matches!(
                    control_id,
                    CTRL_SECTION_DEF
                        | CTRL_COLUMN_DEF
                        | CTRL_PAGE_NUM_POS
                        | CTRL_NEW_NUMBER
                        | CTRL_TABLE
                ) {
                    return Err(unsupported(record, section));
                }
                let start = cursor;
                cursor += 1;
                while cursor < records.len() && records[cursor].level > base_level + 1 {
                    cursor += 1;
                }
                structural_controls.push((&records[start], &records[start + 1..cursor]));
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
    validate_para_usage(usage, &decoded, doc, &header, section)?;
    if decoded.structural_controls.len() != structural_controls.len() {
        return Err(malformed(
            &header,
            Some(section),
            "PARA_TEXT structural markers do not match CTRL_HEADER records",
        ));
    }
    let mut page = None;
    let mut raw_columns = None;
    let mut page_number = None;
    let mut page_number_start = None;
    let mut tables = Vec::new();
    for ((marker_offset, marker_id), (control, children)) in
        decoded.structural_controls.iter().zip(structural_controls)
    {
        let actual_id = read_u32(data(stream, control), 0).expect("control id checked above");
        if *marker_id != actual_id {
            return Err(malformed(
                control,
                Some(section),
                "structural control header does not match PARA_TEXT marker",
            ));
        }
        match actual_id {
            CTRL_SECTION_DEF => {
                if *marker_offset != 0 || page.is_some() {
                    return Err(malformed(
                        control,
                        Some(section),
                        "section definition marker is duplicate or not at paragraph start",
                    ));
                }
                page = Some(parse_section_control(
                    stream, control, children, doc, section,
                )?);
            }
            CTRL_COLUMN_DEF => {
                if !children.is_empty() || raw_columns.is_some() {
                    return Err(malformed(
                        control,
                        Some(section),
                        "column definition has children or is duplicated",
                    ));
                }
                raw_columns = Some(parse_column_control(
                    data(stream, control),
                    control,
                    section,
                )?);
            }
            CTRL_PAGE_NUM_POS => {
                if !children.is_empty() {
                    return Err(malformed(
                        control,
                        Some(section),
                        "page-number position has children",
                    ));
                }
                let candidate = parse_page_number_control(data(stream, control), control, section)?;
                match page_number {
                    Some(existing) if existing == candidate => {}
                    Some(_) => {
                        return Err(malformed(
                            control,
                            Some(section),
                            "page-number positions are duplicated with conflicting semantics",
                        ));
                    }
                    None => page_number = Some(candidate),
                }
            }
            CTRL_NEW_NUMBER => {
                if !children.is_empty() {
                    return Err(malformed(
                        control,
                        Some(section),
                        "page-number restart has children",
                    ));
                }
                let candidate = parse_new_number_control(data(stream, control), control, section)?;
                match page_number_start {
                    Some((existing, _)) if existing == candidate => {}
                    Some(_) => {
                        return Err(malformed(
                            control,
                            Some(section),
                            "page-number restarts are duplicated with conflicting semantics",
                        ));
                    }
                    None => page_number_start = Some((candidate, *control)),
                }
            }
            CTRL_TABLE => {
                if tables.len() == 2 {
                    return Err(unsupported_reason(
                        *control,
                        section,
                        "paragraphs with more than two table controls are not owned",
                    ));
                }
                tables.push(parse_inline_table(
                    stream,
                    control,
                    children,
                    doc,
                    para_usage,
                    styles,
                    section,
                    table_depth,
                )?);
            }
            _ => unreachable!("structural control id filtered above"),
        }
    }
    if let Some((start, control)) = page_number_start {
        let Some(number) = page_number.as_mut() else {
            return Err(malformed(
                &control,
                Some(section),
                "page-number restart requires an owned page-number position",
            ));
        };
        number.start = start;
    }
    if break_type & 0x01 != 0 && page.is_none() {
        return Err(unsupported_reason(
            header,
            section,
            "section break has no matching section definition",
        ));
    }
    if break_type & 0x02 != 0 && raw_columns.is_none() {
        return Err(unsupported_reason(
            header,
            section,
            "multi-column break has no owned column definition",
        ));
    }
    let column_layout = match raw_columns {
        Some(raw) => Some(resolve_columns(
            raw,
            page.as_ref().or(_current_page).ok_or_else(|| {
                malformed(
                    &header,
                    Some(section),
                    "column definition appears before page geometry",
                )
            })?,
            &header,
            section,
        )?),
        None => None,
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
    let paragraph = Paragraph {
        para_shape: para_shape_id + 1,
        page_break_before: break_type & 0x04 != 0,
        column_break_before: break_type & 0x08 != 0,
        column_layout_before: column_layout,
        runs,
        // Stored line boxes are only an authored-height hint for a true blank spacer.
        // They never dictate line breaks for visible text or a control-host paragraph.
        source_line_metrics: if decoded.chars.is_empty() && decoded.structural_controls.is_empty() {
            line_metrics
        } else {
            Vec::new()
        },
        provenance: Provenance {
            source: Some(SourceFormat::Hwp5),
            raw: None,
        },
        ..Paragraph::default()
    };
    if let (Some(page), Some(layout)) = (&mut page, &paragraph.column_layout_before) {
        page.columns = u8::try_from(layout.count()).unwrap_or(u8::MAX);
    }
    Ok(ParsedParagraph {
        paragraph,
        page,
        page_number,
        tables,
    })
}

fn parse_page_number_control(
    bytes: &[u8],
    record: &Record,
    section: usize,
) -> Result<PageNumberDecoration> {
    if bytes.len() != 16 {
        return Err(malformed(
            record,
            Some(section),
            "page-number position is not exactly 16 bytes",
        ));
    }
    if read_u32(bytes, 0) != Some(CTRL_PAGE_NUM_POS) {
        return Err(unsupported(*record, section));
    }
    let attr = read_u32(bytes, 4).expect("exact length checked");
    if attr & !0x0fff != 0 {
        return Err(malformed(
            record,
            Some(section),
            "page-number position has unknown attribute bits",
        ));
    }
    let format = match attr & 0xff {
        0 => PageNumberFormat::Digit,
        1 => PageNumberFormat::CircledDigit,
        2 => PageNumberFormat::RomanUpper,
        3 => PageNumberFormat::RomanLower,
        4 => PageNumberFormat::LatinUpper,
        5 => PageNumberFormat::LatinLower,
        _ => {
            return Err(malformed(
                record,
                Some(section),
                "page-number format is not yet supported",
            ))
        }
    };
    let position = match (attr >> 8) & 0x0f {
        0 => PageNumberPosition::None,
        1 => PageNumberPosition::TopLeft,
        2 => PageNumberPosition::TopCenter,
        3 => PageNumberPosition::TopRight,
        4 => PageNumberPosition::BottomLeft,
        5 => PageNumberPosition::BottomCenter,
        6 => PageNumberPosition::BottomRight,
        7 => PageNumberPosition::OutsideTop,
        8 => PageNumberPosition::OutsideBottom,
        9 => PageNumberPosition::InsideTop,
        10 => PageNumberPosition::InsideBottom,
        _ => {
            return Err(malformed(
                record,
                Some(section),
                "page-number position is not supported",
            ))
        }
    };
    let scalar = |at: usize| -> Result<Option<char>> {
        let unit = read_u16(bytes, at).expect("exact length checked");
        if unit == 0 {
            return Ok(None);
        }
        if (0xd800..=0xdfff).contains(&unit) {
            return Err(malformed(
                record,
                Some(section),
                "page-number decoration contains a surrogate code unit",
            ));
        }
        Ok(char::from_u32(u32::from(unit)))
    };
    if scalar(8)?.is_some() {
        return Err(malformed(
            record,
            Some(section),
            "page-number user-symbol semantics are not yet supported",
        ));
    }
    Ok(PageNumberDecoration {
        start: std::num::NonZeroU16::MIN,
        format,
        position,
        prefix: scalar(10)?,
        suffix: scalar(12)?,
        dash: scalar(14)?,
    })
}

fn parse_new_number_control(
    bytes: &[u8],
    record: &Record,
    section: usize,
) -> Result<std::num::NonZeroU16> {
    if bytes.len() != 10 {
        return Err(malformed(
            record,
            Some(section),
            "new-number control is not exactly 10 bytes",
        ));
    }
    if read_u32(bytes, 0) != Some(CTRL_NEW_NUMBER) {
        return Err(unsupported(*record, section));
    }
    let attr = read_u32(bytes, 4).expect("exact length checked");
    if attr & !0x0f != 0 {
        return Err(malformed(
            record,
            Some(section),
            "new-number control has unknown attribute bits",
        ));
    }
    match attr & 0x0f {
        0 => {}
        1..=5 => {
            return Err(malformed(
                record,
                Some(section),
                "non-page new-number counter is not yet supported",
            ));
        }
        _ => {
            return Err(malformed(
                record,
                Some(section),
                "new-number counter type is not supported",
            ));
        }
    }
    std::num::NonZeroU16::new(read_u16(bytes, 8).expect("exact length checked"))
        .ok_or_else(|| malformed(record, Some(section), "page-number restart must be nonzero"))
}

/// Own the bounded binary-table slices seen at the public first-party boundary: strict inline 1×1,
/// 10×2, 9×8, and 8×5 tables. The 9×8 slice has 34 active cells and one nested 1×1 table; the 8×5
/// slice has 19 active cells, one bounded vertical merge, and nine nested 1×1 tables. A 1×1 cell may
/// use the exact observed cell-own inner-margin bit;
/// protection/header/form bits remain unsupported. Multiple controls in one text-empty host are
/// emitted in marker/header order by `parse_paragraph`. Anything outside these exact source-neutral
/// shapes, including deeper nesting, remains fail-closed rather than being approximated.
#[allow(clippy::too_many_arguments)]
fn parse_inline_table(
    stream: &StreamProbe,
    control: &Record,
    children: &[Record],
    doc: &SemanticDoc,
    para_usage: &[ParaUsage],
    styles: &[StyleDef],
    section: usize,
    table_depth: usize,
) -> Result<Table> {
    if table_depth >= 2 {
        return Err(unsupported_reason(
            *control,
            section,
            "table nesting deeper than one level is not owned",
        ));
    }
    let common = data(stream, control);
    if common.len() != 46 || read_u32(common, 0) != Some(CTRL_TABLE) {
        return Err(malformed(
            control,
            Some(section),
            "inline table CTRL_HEADER is not the owned 46-byte record",
        ));
    }
    // Observed public slice: treat-as-char, para-relative inline placement, top-and-bottom wrapping,
    // and the known storage high bit. Exact matching prevents a floating object from being flattened.
    if read_u32(common, 4) != Some(0x082a_2311) {
        return Err(malformed(
            control,
            Some(section),
            "inline table common-object attributes are not owned",
        ));
    }
    if read_u32(common, 8) != Some(0) || read_u32(common, 12) != Some(0) {
        return Err(malformed(
            control,
            Some(section),
            "inline table offsets must be zero",
        ));
    }
    let width = read_u32(common, 16).expect("exact length checked");
    let height = read_u32(common, 20).expect("exact length checked");
    const MAX_OBJECT_HWPUNIT: u32 = 10_000_000;
    if width == 0 || height == 0 || width > MAX_OBJECT_HWPUNIT || height > MAX_OBJECT_HWPUNIT {
        return Err(malformed(
            control,
            Some(section),
            "inline table dimensions are not positive and bounded",
        ));
    }
    let margin = |at: usize| i16::from_le_bytes(common[at..at + 2].try_into().unwrap());
    let margins = [margin(28), margin(30), margin(32), margin(34)];
    if margins.iter().any(|value| *value < 0) {
        return Err(malformed(
            control,
            Some(section),
            "inline table outer margins must be nonnegative",
        ));
    }
    if read_i32(common, 40) != Some(0) || read_u16(common, 44) != Some(0) {
        return Err(malformed(
            control,
            Some(section),
            "inline table page-break prevention or description is not owned",
        ));
    }
    let child_level = control.level + 1;
    if children.len() < 3 || children[0].tag != TAG_TABLE || children[0].level != child_level {
        return Err(malformed(
            control,
            Some(section),
            "inline table child topology does not begin with an owned TABLE record",
        ));
    }

    let table_record = children[0];
    let table_bytes = data(stream, &table_record);
    if table_bytes.len() < 24 {
        return Err(malformed(
            &table_record,
            Some(section),
            "TABLE attributes or framing are not owned",
        ));
    }
    let rows = read_u16(table_bytes, 4).expect("minimum length checked") as usize;
    let cols = read_u16(table_bytes, 6).expect("minimum length checked") as usize;
    let table_attr = read_u32(table_bytes, 0).expect("minimum length checked");
    let expected_positions = match (table_attr, rows, cols) {
        (0x0400_0006, 1, 1) => vec![(0, 0, 1, 1)],
        (0x0400_0006, 10, 2) => (0..10)
            .flat_map(|row| {
                if matches!(row, 0 | 1 | 5) {
                    vec![(row, 0, 2, 1)]
                } else {
                    vec![(row, 0, 1, 1), (row, 1, 1, 1)]
                }
            })
            .collect(),
        (0x0600_000c, 9, 8) => vec![
            (0, 0, 3, 1),
            (0, 3, 5, 1),
            (1, 0, 3, 1),
            (1, 3, 5, 1),
            (2, 0, 3, 1),
            (2, 3, 2, 1),
            (2, 5, 1, 1),
            (2, 6, 2, 1),
            (3, 0, 8, 1),
            (4, 0, 1, 1),
            (4, 1, 1, 1),
            (4, 2, 2, 1),
            (4, 4, 3, 1),
            (4, 7, 1, 1),
            (5, 0, 1, 1),
            (5, 1, 1, 1),
            (5, 2, 2, 1),
            (5, 4, 3, 1),
            (5, 7, 1, 1),
            (6, 0, 1, 1),
            (6, 1, 1, 1),
            (6, 2, 2, 1),
            (6, 4, 3, 1),
            (6, 7, 1, 1),
            (7, 0, 1, 1),
            (7, 1, 1, 1),
            (7, 2, 2, 1),
            (7, 4, 3, 1),
            (7, 7, 1, 1),
            (8, 0, 1, 1),
            (8, 1, 1, 1),
            (8, 2, 2, 1),
            (8, 4, 3, 1),
            (8, 7, 1, 1),
        ],
        (0x0600_000e, 8, 5) => vec![
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
        ],
        _ => {
            return Err(malformed(
                &table_record,
                Some(section),
                "TABLE attributes or row/column topology are not owned",
            ))
        }
    };
    let expected_cells = expected_positions.len();
    if read_u16(table_bytes, 8) != Some(0) {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE cell spacing must be zero",
        ));
    }
    let expected_table_len = 22usize
        .checked_add(rows.checked_mul(2).ok_or_else(|| {
            malformed(
                &table_record,
                Some(section),
                "TABLE row-size length overflows",
            )
        })?)
        .ok_or_else(|| {
            malformed(
                &table_record,
                Some(section),
                "TABLE record length overflows",
            )
        })?;
    if table_bytes.len() != expected_table_len {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE record length or zone framing differs from its row count",
        ));
    }
    let table_padding = [10usize, 12, 14, 16]
        .map(|at| i16::from_le_bytes(table_bytes[at..at + 2].try_into().unwrap()));
    if table_padding.iter().any(|value| *value < 0) {
        return Err(malformed(
            &table_record,
            Some(section),
            "TABLE padding must be nonnegative",
        ));
    }
    let row_cell_counts = (0..rows)
        .map(|row| read_u16(table_bytes, 18 + row * 2).expect("exact length checked") as HwpUnit)
        .collect::<Vec<_>>();
    let expected_row_cell_counts = (0..rows)
        .map(|row| {
            expected_positions
                .iter()
                .filter(|(cell_row, _, _, _)| *cell_row == row)
                .count() as HwpUnit
        })
        .collect::<Vec<_>>();
    if row_cell_counts != expected_row_cell_counts {
        return Err(malformed(
            &table_record,
            Some(section),
            "TABLE row cell counts differ from its owned active-cell topology",
        ));
    }
    let table_border_at = 18 + rows * 2;
    let table_border_id = read_u16(table_bytes, table_border_at).expect("exact length checked");
    if read_u16(table_bytes, table_border_at + 2) != Some(0) {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE zone count must be zero",
        ));
    }
    let table_fill = table_border(doc, table_border_id, &table_record, section, "table")?;

    let mut cells = Vec::with_capacity(expected_cells);
    let mut cell_heights = Vec::with_capacity(expected_cells);
    let mut nested_table_count = 0usize;
    let mut cursor = 1usize;
    while cursor < children.len() {
        if cells.len() == expected_cells {
            return Err(malformed(
                &children[cursor],
                Some(section),
                "owned TABLE has more active cells than its bounded topology",
            ));
        }
        let list_record = children[cursor];
        if list_record.tag != TAG_LIST_HEADER || list_record.level != child_level {
            return Err(malformed(
                &list_record,
                Some(section),
                "owned TABLE expects a LIST_HEADER before each active cell",
            ));
        }
        let list_bytes = data(stream, &list_record);
        if list_bytes.len() != 47 {
            return Err(malformed(
                &list_record,
                Some(section),
                "owned cell LIST_HEADER is not exactly 47 bytes",
            ));
        }
        let paragraph_count = read_u16(list_bytes, 0).expect("exact length checked") as usize;
        let width_ref = read_u16(list_bytes, 6).expect("exact length checked");
        if !(1..=5).contains(&paragraph_count) || read_u32(list_bytes, 2) != Some(0x0020_0000) {
            return Err(malformed(
                &list_record,
                Some(section),
                "cell LIST_HEADER count, direction, alignment, or width reference is not owned",
            ));
        }
        let col = read_u16(list_bytes, 8).expect("exact length checked") as usize;
        let row = read_u16(list_bytes, 10).expect("exact length checked") as usize;
        let col_span = read_u16(list_bytes, 12).expect("exact length checked") as usize;
        let row_span = read_u16(list_bytes, 14).expect("exact length checked") as usize;
        let cell_width = read_u32(list_bytes, 16).expect("exact length checked");
        let cell_height = read_u32(list_bytes, 20).expect("exact length checked");
        let expected_eight_by_five_width_ref = if (table_attr, rows, cols) == (0x0600_000e, 8, 5) {
            Some(if row == 0 {
                0x0100
            } else if (row, col, col_span, row_span) == (6, 1, 2, 1) {
                0x0400
            } else {
                0x0000
            })
        } else {
            None
        };
        let owned_width_ref = expected_eight_by_five_width_ref.map_or_else(
            || {
                matches!(width_ref, 0x0000 | 0x0100 | 0x0500)
                    || (width_ref == 0x0501 && (rows, cols) == (1, 1))
            },
            |expected| width_ref == expected,
        );
        if !owned_width_ref {
            return Err(malformed(
                &list_record,
                Some(section),
                if expected_eight_by_five_width_ref.is_some() {
                    "cell LIST_HEADER width reference differs from its exact owned topology"
                } else {
                    "cell LIST_HEADER count, direction, alignment, or width reference is not owned"
                },
            ));
        }
        if col_span == 0
            || row_span == 0
            || col.checked_add(col_span).is_none_or(|end| end > cols)
            || row.checked_add(row_span).is_none_or(|end| end > rows)
            || row >= rows
            || cell_width == 0
            || cell_height == 0
            || cell_width > MAX_OBJECT_HWPUNIT
            || cell_height > MAX_OBJECT_HWPUNIT
        {
            return Err(malformed(
                &list_record,
                Some(section),
                "cell coordinates, horizontal span, or dimensions are outside the owned TABLE grid",
            ));
        }
        let list_extra = &list_bytes[34..];
        let zero_legacy_extra = list_extra.iter().all(|byte| *byte == 0);
        let extension_width = read_u32(list_extra, 0).unwrap_or(0);
        let width_extension = extension_width > 0 && list_extra[4..].iter().all(|byte| *byte == 0);
        let stale_core_width_slot = (table_attr, rows, cols, row, col, col_span, row_span)
            == (0x0600_000e, 8, 5, 6, 3, 2, 1);
        if !(zero_legacy_extra
            || (width_extension && (extension_width == cell_width || stale_core_width_slot)))
        {
            return Err(malformed(
                &list_record,
                Some(section),
                "cell LIST_HEADER extension is not zero or an owned layout-width mirror",
            ));
        }
        if stale_core_width_slot && extension_width.checked_sub(cell_width) != Some(176) {
            return Err(malformed(
                &list_record,
                Some(section),
                "owned stale core cell width does not match its bounded layout-width delta",
            ));
        }
        let layout_width = if width_extension {
            extension_width
        } else {
            cell_width
        };
        if layout_width == 0 || layout_width > MAX_OBJECT_HWPUNIT {
            return Err(malformed(
                &list_record,
                Some(section),
                "cell LIST_HEADER layout width is not positive and bounded",
            ));
        }
        let cell_padding = [24usize, 26, 28, 30]
            .map(|at| i16::from_le_bytes(list_bytes[at..at + 2].try_into().unwrap()));
        if cell_padding.iter().any(|value| *value < 0) {
            return Err(malformed(
                &list_record,
                Some(section),
                "cell stored padding must be nonnegative",
            ));
        }
        // The bounded 13-byte extension is either the legacy all-zero form or a layout-width mirror
        // followed by reserved zeros. One exact public slot carries a newer layout width over a stale
        // core width; the global span equations below prove that override instead of trusting it alone.
        debug_assert_eq!(list_extra.len(), 13);
        let cell_border_id = read_u16(list_bytes, 32).expect("exact length checked");
        let cell_fill = table_border(doc, cell_border_id, &list_record, section, "table cell")?;

        cursor += 1;
        let mut blocks = Vec::with_capacity(paragraph_count);
        for paragraph_index in 0..paragraph_count {
            let Some(header) = children.get(cursor).copied() else {
                return Err(malformed(
                    &list_record,
                    Some(section),
                    "cell LIST_HEADER declares missing paragraphs",
                ));
            };
            if header.tag != TAG_PARA_HEADER || header.level != child_level {
                return Err(malformed(
                    &header,
                    Some(section),
                    "cell LIST_HEADER is not followed by its declared paragraph headers",
                ));
            }
            let start = cursor;
            cursor += 1;
            while cursor < children.len() && children[cursor].level > child_level {
                cursor += 1;
            }
            let mut parsed = parse_paragraph(
                stream,
                &children[start..cursor],
                doc,
                para_usage,
                styles,
                section,
                None,
                table_depth + 1,
            )?;
            if parsed.page.is_some()
                || parsed.page_number.is_some()
                || parsed.paragraph.page_break_before
                || parsed.paragraph.column_break_before
                || parsed.paragraph.column_layout_before.is_some()
            {
                return Err(malformed(
                    &header,
                    Some(section),
                    "owned table cell paragraph contains nested layout controls",
                ));
            }
            if !parsed.tables.is_empty() {
                let owned_nested_position = match (table_attr, rows, cols) {
                    (0x0600_000c, 9, 8) => {
                        (row, col, col_span, row_span, paragraph_index) == (1, 3, 5, 1, 1)
                    }
                    (0x0600_000e, 8, 5) => {
                        paragraph_index == 0
                            && matches!(
                                (row, col, col_span, row_span),
                                (0, 1, 1, 1)
                                    | (0, 4, 1, 1)
                                    | (1, 1, 4, 1)
                                    | (2, 1, 4, 1)
                                    | (3, 1, 4, 1)
                                    | (4, 1, 4, 1)
                                    | (5, 1, 4, 1)
                                    | (6, 1, 2, 1)
                                    | (6, 3, 2, 1)
                            )
                    }
                    _ => false,
                } && parsed.tables.len() == 1;
                let has_visible_text = parsed.paragraph.runs.iter().any(|run| {
                    run.content
                        .iter()
                        .any(|inline| matches!(inline, Inline::Text(text) if !text.is_empty()))
                });
                if !owned_nested_position || has_visible_text {
                    return Err(malformed(
                        &header,
                        Some(section),
                        "nested table is not at the exact owned cell paragraph position",
                    ));
                }
                nested_table_count += parsed.tables.len();
                parsed.paragraph.is_table_anchor = true;
            }
            blocks.push(Block::Paragraph(parsed.paragraph));
            blocks.extend(parsed.tables.into_iter().map(Block::Table));
        }
        cell_heights.push(cell_height as HwpUnit);
        cells.push(Cell {
            row,
            col,
            row_span,
            col_span,
            blocks,
            active: true,
            shade_color: cell_fill.shade,
            has_border: cell_fill.has_border,
            borders: cell_fill.borders,
            diagonal: cell_fill.diagonal,
            // The exact observed low bit is HWP's apply-inner-margin flag. Other cell extension
            // bits (protect/header/form) were rejected with the width-reference word above.
            padding: (width_ref == 0x0501).then_some(cell_padding.map(|value| value as HwpUnit)),
            width: Some(layout_width as HwpUnit),
            ..Cell::default()
        });
    }
    if cells.len() != expected_cells {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE active-cell count differs from its exact topology",
        ));
    }
    let expected_nested_tables = match (table_attr, rows, cols) {
        (0x0600_000c, 9, 8) => 1,
        (0x0600_000e, 8, 5) => 9,
        _ => 0,
    };
    if nested_table_count != expected_nested_tables {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE nested-table count differs from its exact topology",
        ));
    }

    if cells
        .iter()
        .zip(&expected_positions)
        .any(|(cell, expected)| (cell.row, cell.col, cell.col_span, cell.row_span) != *expected)
    {
        return Err(malformed(
            &table_record,
            Some(section),
            "owned TABLE cells are not in the exact row-major merge topology",
        ));
    }

    let mut derived_rows = vec![None::<HwpUnit>; rows];
    for (cell, cell_height) in cells.iter().zip(&cell_heights) {
        if cell.row_span != 1 {
            continue;
        }
        match derived_rows[cell.row] {
            Some(existing) if existing != *cell_height => {
                return Err(malformed(
                    &table_record,
                    Some(section),
                    "cell heights disagree within a TABLE row",
                ))
            }
            None => derived_rows[cell.row] = Some(*cell_height),
            _ => {}
        }
    }

    // Recover absolute column boundaries from all cell span equations. This handles the 9×8 slice,
    // where several columns never appear as a standalone cell but the connected span graph still
    // determines every boundary uniquely. Endpoints are pinned to 0 and the common-object width.
    let mut boundaries = vec![None::<i64>; cols + 1];
    boundaries[0] = Some(0);
    boundaries[cols] = Some(i64::from(width));
    for _ in 0..=cells.len() + cols {
        let mut progressed = false;
        for cell in &cells {
            let start = cell.col;
            let end = cell.col + cell.col_span;
            let cell_width = i64::from(cell.width.expect("owned cells always carry width"));
            match (boundaries[start], boundaries[end]) {
                (Some(left), Some(right)) if right - left != cell_width => {
                    return Err(malformed(
                        &table_record,
                        Some(section),
                        "TABLE span equations disagree with common-object geometry",
                    ));
                }
                (Some(left), None) => {
                    boundaries[end] = Some(left + cell_width);
                    progressed = true;
                }
                (None, Some(right)) => {
                    boundaries[start] = Some(right - cell_width);
                    progressed = true;
                }
                _ => {}
            }
        }
        if !progressed {
            break;
        }
    }
    let boundaries = boundaries
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            malformed(
                &table_record,
                Some(section),
                "TABLE column boundaries are not uniquely derivable from active cells",
            )
        })?;
    if boundaries.first() != Some(&0)
        || boundaries.last() != Some(&i64::from(width))
        || boundaries.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(malformed(
            &table_record,
            Some(section),
            "TABLE column boundaries are nonpositive or outside common-object geometry",
        ));
    }
    let col_widths = boundaries
        .windows(2)
        .map(|pair| HwpUnit::try_from(pair[1] - pair[0]))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| {
            malformed(
                &table_record,
                Some(section),
                "TABLE column width exceeds the shared geometry range",
            )
        })?;
    let derived_rows = derived_rows
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            malformed(
                &table_record,
                Some(section),
                "TABLE has a row whose stored height cannot be derived from an active cell",
            )
        })?;
    for (cell, cell_height) in cells.iter().zip(&cell_heights) {
        if cell.row_span <= 1 {
            continue;
        }
        let end = cell.row + cell.row_span;
        let span_height = derived_rows[cell.row..end]
            .iter()
            .try_fold(0i64, |sum, value| sum.checked_add(i64::from(*value)));
        if span_height != Some(i64::from(*cell_height)) {
            return Err(malformed(
                &table_record,
                Some(section),
                "row-spanning cell height disagrees with its covered TABLE rows",
            ));
        }
    }
    let stored_height = derived_rows
        .iter()
        .try_fold(0i64, |sum, value| sum.checked_add(i64::from(*value)));
    let owned_nested_stale_common_height = table_depth == 1
        && (table_attr, rows, cols, height, stored_height)
            == (0x0400_0006, 1, 1, 3_882, Some(1_848));
    if stored_height != Some(i64::from(height)) && !owned_nested_stale_common_height {
        return Err(malformed(
            &table_record,
            Some(section),
            "stored active-cell row heights do not sum to common-object geometry",
        ));
    }

    Ok(Table {
        rows,
        cols,
        cells,
        // The exact 8×5 form follows the current shared row-fragmentation behavior. Its low flag has
        // conflicting legacy descriptions, so this stays bounded to the observed form; the other
        // owned forms retain their already-proven keep-together behavior.
        keep_together: table_attr != 0x0600_000e,
        col_widths,
        row_heights: derived_rows,
        // Both exact large-table attributes carry HWP's no-adjust bit. Their stored row heights are
        // exact clipping geometry, not merely content-size floors.
        fixed_row_heights: matches!(table_attr, 0x0600_000c | 0x0600_000e),
        outer_margin_left: margins[0] as HwpUnit,
        outer_margin_right: margins[1] as HwpUnit,
        outer_margin_top: margins[2] as HwpUnit,
        outer_margin_bottom: margins[3] as HwpUnit,
        padding: Some(table_padding.map(|value| value as HwpUnit)),
        borders: table_fill.borders,
        provenance: Provenance {
            source: Some(SourceFormat::Hwp5),
            raw: None,
        },
        ..Table::default()
    })
}

fn table_border<'a>(
    doc: &'a SemanticDoc,
    id: u16,
    record: &Record,
    section: usize,
    kind: &'static str,
) -> Result<&'a BorderFillDef> {
    if id == 0 {
        return Err(malformed(
            record,
            Some(section),
            "owned table border-fill reference must be nonzero",
        ));
    }
    doc.header_pools
        .border
        .get(&(id as u64))
        .ok_or(Error::InvalidReference {
            kind,
            index: id as usize,
            pool_len: doc.header_pools.border.len(),
            section: Some(section),
            offset: record.head,
        })
}

fn validate_para_usage(
    usage: &ParaUsage,
    decoded: &DecodedText,
    doc: &SemanticDoc,
    header: &Record,
    section: usize,
) -> Result<()> {
    if usage.has_custom_tabs && decoded.chars.iter().any(|(_, value)| *value == '\t') {
        return Err(malformed(
            header,
            Some(section),
            "active custom tab semantics are not supported",
        ));
    }
    if usage.head_type != 0 {
        return Err(malformed(
            header,
            Some(section),
            if usage.numbering == 0 {
                "active paragraph head has no numbering or bullet reference"
            } else {
                "active numbering and bullet semantics are not supported"
            },
        ));
    }
    if usage.border_fill != 0 {
        let border = doc
            .header_pools
            .border
            .get(&(usage.border_fill as u64))
            .ok_or(Error::InvalidReference {
                kind: "paragraph border fill",
                index: usage.border_fill as usize,
                pool_len: doc.header_pools.border.len(),
                section: Some(section),
                offset: header.head,
            })?;
        if border.has_border || border.shade.is_some() || border.diagonal.is_some() {
            return Err(malformed(
                header,
                Some(section),
                "active paragraph border or fill semantics are not supported",
            ));
        }
    }
    Ok(())
}

fn parse_section_control(
    stream: &StreamProbe,
    control: &Record,
    children: &[Record],
    doc: &SemanticDoc,
    section: usize,
) -> Result<PageSetup> {
    let bytes = data(stream, control);
    if !matches!(bytes.len(), 28 | 47) {
        return Err(malformed(
            control,
            Some(section),
            "section CTRL_HEADER is not the owned base or 19-byte extension record",
        ));
    }
    if read_u32(bytes, 0) != Some(CTRL_SECTION_DEF) {
        return Err(unsupported(*control, section));
    }
    if bytes.len() == 47 {
        // HWP 5.0.1.5+: representative language (0 = application default), followed by the
        // pinned-rhwp/Hancom master-page tail marker and 15 reserved zero bytes.
        if read_u16(bytes, 28) != Some(0)
            || !matches!(read_u16(bytes, 30), Some(0 | 1))
            || bytes[32..].iter().any(|byte| *byte != 0)
        {
            return Err(malformed(
                control,
                Some(section),
                "section CTRL_HEADER extension semantics are not owned",
            ));
        }
    }
    if children.is_empty() || children[0].tag != TAG_PAGE_DEF || children[0].level != 2 {
        let offending = children.first().copied().unwrap_or(*control);
        return Err(unsupported(offending, section));
    }
    match children.len() {
        1 => {}
        6 if children[1..3]
            .iter()
            .all(|record| record.tag == 0x4a && record.level == 2)
            && children[3..]
                .iter()
                .all(|record| record.tag == 0x4b && record.level == 2) =>
        {
            for record in &children[1..3] {
                validate_dormant_note_shape(stream, record, section)?;
            }
            for record in &children[3..] {
                validate_inactive_page_border(stream, record, doc, section)?;
            }
        }
        _ => return Err(unsupported(children[1], section)),
    }
    parse_page_def(data(stream, &children[0]), &children[0], section)
}

/// Note-shape records are safe to ignore only in this parser's current lane because no foot/endnote
/// control is accepted. Validate the complete known 28-byte scalar/line framing so malformed dormant
/// metadata cannot ride along; a future note-control slice must promote these values into shared IR.
fn validate_dormant_note_shape(
    stream: &StreamProbe,
    record: &Record,
    section: usize,
) -> Result<()> {
    let bytes = data(stream, record);
    if bytes.len() != 28 {
        return Err(malformed(
            record,
            Some(section),
            "dormant note shape is not exactly 28 bytes",
        ));
    }
    for at in [4usize, 6, 8] {
        let scalar = read_u16(bytes, at).expect("exact length checked");
        if (0xd800..=0xdfff).contains(&scalar) {
            return Err(malformed(
                record,
                Some(section),
                "dormant note shape contains a surrogate code unit",
            ));
        }
    }
    if read_u16(bytes, 10) == Some(0) || border_line_style(bytes[22]).is_none() || bytes[23] > 15 {
        return Err(malformed(
            record,
            Some(section),
            "dormant note shape has invalid numbering or separator line framing",
        ));
    }
    Ok(())
}

/// Page-border records are discarded only when their referenced borderFill is visually inert.
/// Any visible edge, shade, or diagonal remains unsupported rather than silently disappearing.
fn validate_inactive_page_border(
    stream: &StreamProbe,
    record: &Record,
    doc: &SemanticDoc,
    section: usize,
) -> Result<()> {
    let bytes = data(stream, record);
    if bytes.len() != 14 {
        return Err(malformed(
            record,
            Some(section),
            "page border/fill is not exactly 14 bytes",
        ));
    }
    let attr = read_u32(bytes, 0).expect("exact length checked");
    // Spec revision 1.3 owns bits 0..4. The public Hancom-authored slice carries one exact legacy
    // storage word whose low five bits decode normally; pinned-rhwp confirms its referenced fill is
    // fully inert. Keep that word as a narrow allowlist instead of accepting arbitrary high bits.
    if attr & !0x1f != 0 && !matches!(attr, 0x0978_f9c1 | 0x271b_0b81) {
        return Err(malformed(
            record,
            Some(section),
            "page border/fill has unknown attribute bits",
        ));
    }
    let border_id = read_u16(bytes, 12).expect("exact length checked");
    if border_id == 0 {
        return Ok(());
    }
    let border =
        doc.header_pools
            .border
            .get(&(border_id as u64))
            .ok_or(Error::InvalidReference {
                kind: "page border fill",
                index: border_id as usize,
                pool_len: doc.header_pools.border.len(),
                section: Some(section),
                offset: record.head,
            })?;
    if border.has_border || border.shade.is_some() || border.diagonal.is_some() {
        return Err(malformed(
            record,
            Some(section),
            "active page border or fill semantics are not supported",
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct RawColumnLayout {
    kind: ColumnKind,
    direction: ColumnDirection,
    count: usize,
    equal_gap: Option<u16>,
    width_weights: Vec<u16>,
    gap_weights: Vec<u16>,
    separator: Option<ColumnSeparator>,
}

/// Strict HWP5 `cold` control parser. The control id is part of `bytes`; all source-specific
/// proportional values stay private to this stage and are resolved to absolute HWPUNIT by
/// [`resolve_columns`] before entering the shared IR.
fn parse_column_control(bytes: &[u8], record: &Record, section: usize) -> Result<RawColumnLayout> {
    if read_u32(bytes, 0) != Some(CTRL_COLUMN_DEF) {
        return Err(unsupported(*record, section));
    }
    let attr = read_u16(bytes, 4).ok_or_else(|| {
        malformed(
            record,
            Some(section),
            "column definition is shorter than its attributes",
        )
    })?;
    if attr & 0xe000 != 0 {
        return Err(malformed(
            record,
            Some(section),
            "column definition has unknown attribute bits",
        ));
    }
    let kind = match attr & 0x03 {
        0 => ColumnKind::Normal,
        1 | 2 => {
            return Err(malformed(
                record,
                Some(section),
                "column distribution kind is not yet supported",
            ))
        }
        _ => {
            return Err(malformed(
                record,
                Some(section),
                "column definition has an unknown column kind",
            ))
        }
    };
    let count = ((attr >> 2) & 0xff) as usize;
    if !(1..=32).contains(&count) {
        return Err(malformed(
            record,
            Some(section),
            "column definition count is outside the owned range",
        ));
    }
    let direction = match (attr >> 10) & 0x03 {
        0 => ColumnDirection::LeftToRight,
        1 => ColumnDirection::RightToLeft,
        _ => {
            return Err(malformed(
                record,
                Some(section),
                "column definition direction is not supported",
            ))
        }
    };
    let same_width = attr & (1 << 12) != 0;
    let (equal_gap, width_weights, gap_weights, separator_at) = if same_width {
        if bytes.len() != 16 {
            return Err(malformed(
                record,
                Some(section),
                "equal-width column definition is not exactly 16 bytes",
            ));
        }
        let gap = read_u16(bytes, 6).expect("exact length checked");
        if read_u16(bytes, 8) != Some(0) {
            return Err(malformed(
                record,
                Some(section),
                "column definition has unsupported upper attributes",
            ));
        }
        (Some(gap), Vec::new(), Vec::new(), 10)
    } else if count == 1 {
        if bytes.len() != 16 {
            return Err(malformed(
                record,
                Some(section),
                "single-column definition is not exactly 16 bytes",
            ));
        }
        let gap = read_u16(bytes, 6).expect("exact length checked");
        if read_u16(bytes, 8) != Some(0) {
            return Err(malformed(
                record,
                Some(section),
                "column definition has unsupported upper attributes",
            ));
        }
        (Some(gap), Vec::new(), Vec::new(), 10)
    } else {
        let expected = 14usize
            .checked_add(count.checked_mul(4).ok_or_else(|| {
                malformed(record, Some(section), "column definition length overflows")
            })?)
            .ok_or_else(|| {
                malformed(record, Some(section), "column definition length overflows")
            })?;
        if bytes.len() != expected {
            return Err(malformed(
                record,
                Some(section),
                "unequal-width column definition has an unexpected length",
            ));
        }
        if read_u16(bytes, 6) != Some(0) {
            return Err(malformed(
                record,
                Some(section),
                "column definition has unsupported upper attributes",
            ));
        }
        let mut widths = Vec::with_capacity(count);
        let mut gaps = Vec::with_capacity(count.saturating_sub(1));
        for index in 0..count {
            let at = 8 + index * 4;
            let width = read_u16(bytes, at).expect("exact length checked");
            let gap = read_u16(bytes, at + 2).expect("exact length checked");
            if width == 0 {
                return Err(malformed(
                    record,
                    Some(section),
                    "column definition contains a zero width",
                ));
            }
            widths.push(width);
            if index + 1 == count {
                if gap != 0 {
                    return Err(malformed(
                        record,
                        Some(section),
                        "column definition has a trailing gap after the last column",
                    ));
                }
            } else {
                gaps.push(gap);
            }
        }
        (None, widths, gaps, 8 + count * 4)
    };

    let line_type = bytes[separator_at];
    let line_width = bytes[separator_at + 1];
    let line_color = read_u32(bytes, separator_at + 2).expect("exact length checked");
    let separator = if line_type == 0 {
        if line_width != 0 || line_color != 0 {
            return Err(malformed(
                record,
                Some(section),
                "disabled column separator has nonzero style data",
            ));
        }
        None
    } else {
        let style = border_line_style(line_type).ok_or_else(|| {
            malformed(
                record,
                Some(section),
                "column separator has an unknown line type",
            )
        })?;
        if style == LineStyle::None || line_width > 15 {
            return Err(malformed(
                record,
                Some(section),
                "column separator has an unknown line width",
            ));
        }
        Some(ColumnSeparator {
            color: opaque_bgr(line_color),
            style,
            width_px: border_width_px(line_width),
        })
    };
    Ok(RawColumnLayout {
        kind,
        direction,
        count,
        equal_gap,
        width_weights,
        gap_weights,
        separator,
    })
}

fn resolve_columns(
    raw: RawColumnLayout,
    page: &PageSetup,
    record: &Record,
    section: usize,
) -> Result<ColumnLayout> {
    let display_width = if page.landscape && page.width < page.height {
        page.height
    } else {
        page.width
    };
    let body_width = i64::from(display_width)
        - i64::from(page.margin_left)
        - i64::from(page.margin_gutter)
        - i64::from(page.margin_right);
    if body_width <= 0 {
        return Err(malformed(
            record,
            Some(section),
            "column definition has no positive page body width",
        ));
    }

    let (mut widths, gaps) = if let Some(gap) = raw.equal_gap {
        let count = raw.count;
        let gaps = vec![i32::from(gap); count.saturating_sub(1)];
        let gap_total = i64::from(gap) * count.saturating_sub(1) as i64;
        let remaining = body_width - gap_total;
        if remaining < count as i64 {
            return Err(malformed(
                record,
                Some(section),
                "column gaps leave no positive column width",
            ));
        }
        let base = remaining / count as i64;
        let mut widths = vec![base as i32; count];
        *widths.last_mut().expect("positive count") += (remaining % count as i64) as i32;
        (widths, gaps)
    } else {
        let weight_total = raw
            .width_weights
            .iter()
            .chain(&raw.gap_weights)
            .map(|value| u64::from(*value))
            .sum::<u64>();
        if weight_total == 0 {
            return Err(malformed(
                record,
                Some(section),
                "column definition has zero total weight",
            ));
        }
        let scale =
            |value: u16| -> i32 { ((u64::from(value) * body_width as u64) / weight_total) as i32 };
        let widths = raw
            .width_weights
            .iter()
            .copied()
            .map(scale)
            .collect::<Vec<_>>();
        let gaps = raw
            .gap_weights
            .iter()
            .copied()
            .map(scale)
            .collect::<Vec<_>>();
        (widths, gaps)
    };
    let used = widths
        .iter()
        .chain(&gaps)
        .map(|value| i64::from(*value))
        .sum::<i64>();
    let residue = body_width - used;
    if let Some(last) = widths.last_mut() {
        *last = last.saturating_add(residue as i32);
    }
    if widths.iter().any(|width| *width <= 0) {
        return Err(malformed(
            record,
            Some(section),
            "column definition resolves to a non-positive width",
        ));
    }
    Ok(ColumnLayout {
        kind: raw.kind,
        direction: raw.direction,
        widths,
        gaps,
        separator: raw.separator,
    })
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
    structural_controls: Vec<(u32, u32)>,
    stored_units: u32,
    inline_control_mask: u32,
    terminator: Option<u32>,
}

impl DecodedText {
    fn is_boundary(&self, offset: u32) -> bool {
        offset == 0
            || self
                .chars
                .binary_search_by_key(&offset, |(start, _)| *start)
                .is_ok()
            || self
                .structural_controls
                .binary_search_by_key(&offset, |(start, _)| *start)
                .is_ok()
            || self.terminator == Some(offset)
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
    let mut structural_controls = Vec::new();
    let mut cursor = 0usize;
    let mut ended = false;
    let mut terminator = None;
    let mut inline_control_mask = 0u32;
    while cursor < units.len() {
        let start = cursor as u32;
        let unit = units[cursor];
        match unit {
            0x000d => {
                ended = true;
                terminator = Some(start);
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
            0x0002 | 0x000b | 0x0015 => {
                if cursor + 8 > units.len() {
                    return Err(malformed(
                        &record,
                        Some(section),
                        match unit {
                            0x0002 => "PARA_TEXT section control is truncated",
                            0x000b => "PARA_TEXT table control is truncated",
                            _ => "PARA_TEXT page-number control is truncated",
                        },
                    ));
                }
                if units[cursor + 7] != unit || units[cursor + 3..cursor + 7] != [0; 4] {
                    return Err(malformed(
                        &record,
                        Some(section),
                        match unit {
                            0x0002 => "PARA_TEXT section control framing is invalid",
                            0x000b => "PARA_TEXT table control framing is invalid",
                            _ => "PARA_TEXT page-number control framing is invalid",
                        },
                    ));
                }
                let lo = units[cursor + 1].to_le_bytes();
                let hi = units[cursor + 2].to_le_bytes();
                let control_id = u32::from_le_bytes([lo[0], lo[1], hi[0], hi[1]]);
                let owned = match unit {
                    0x0002 => matches!(control_id, CTRL_SECTION_DEF | CTRL_COLUMN_DEF),
                    0x000b => control_id == CTRL_TABLE,
                    0x0015 => matches!(control_id, CTRL_PAGE_NUM_POS | CTRL_NEW_NUMBER),
                    _ => false,
                };
                if !owned {
                    return Err(unsupported(record, section));
                }
                structural_controls.push((start, control_id));
                inline_control_mask |= 1 << unit;
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
        structural_controls,
        stored_units: units.len() as u32,
        inline_control_mask,
        terminator,
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
    if let Some((_, shape)) = decoded
        .terminator
        .and_then(|terminator| effective.iter().find(|(start, _)| *start == terminator))
    {
        runs.push(Run {
            char_shape: *shape,
            content: Vec::new(),
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
    unsupported_reason(record, section, "record semantics are not owned")
}

fn unsupported_reason(record: Record, section: usize, reason: &'static str) -> Error {
    Error::UnsupportedBodyRecord {
        tag: record.tag,
        section,
        start: record.head,
        end: record.end,
        reason,
    }
}

fn invalid_pool_ref(kind: &'static str, index: usize, pool_len: usize, record: &Record) -> Error {
    Error::InvalidReference {
        kind,
        index,
        pool_len,
        section: None,
        offset: record.head,
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

fn opaque_bgr(value: u32) -> Color {
    Color {
        a: 255,
        ..bgr(value)
    }
}

fn nondefault_shade(value: u32) -> Option<Color> {
    let color = opaque_bgr(value);
    ((color.r, color.g, color.b) != (0, 0, 0) && (color.r, color.g, color.b) != (255, 255, 255))
        .then_some(color)
}

fn border_line_style(value: u8) -> Option<LineStyle> {
    Some(match value {
        0 => LineStyle::None,
        2 | 4 | 5 | 6 => LineStyle::Dashed,
        3 | 7 => LineStyle::Dotted,
        8..=11 => LineStyle::Double,
        1 | 12..=16 => LineStyle::Solid,
        _ => return None,
    })
}

fn diagonal_kind(attr: u16, style: LineStyle) -> Option<DiagonalKind> {
    if style == LineStyle::None {
        return None;
    }
    let slash = (attr >> 2) & 0x07 != 0;
    let backslash = (attr >> 5) & 0x07 != 0;
    match (slash, backslash) {
        (true, true) => Some(DiagonalKind::Cross),
        (true, false) => Some(DiagonalKind::Slash),
        (false, true) => Some(DiagonalKind::BackSlash),
        (false, false) => None,
    }
}

fn border_width_px(value: u8) -> f64 {
    const WIDTHS: [f64; 16] = [
        0.5, 0.5, 0.6, 0.75, 1.0, 1.1, 1.5, 1.9, 2.3, 2.6, 3.8, 5.7, 7.6, 11.3, 15.1, 18.9,
    ];
    WIDTHS[value as usize]
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

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.cursor)
    }

    fn is_finished(&self) -> bool {
        self.cursor == self.bytes.len()
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

#[cfg(test)]
mod support_pool_tests {
    use super::*;

    fn record(tag: u16, size: usize) -> Record {
        Record {
            tag,
            level: 0,
            size,
            head: 17,
            data: 21,
            end: 21 + size,
            extended: false,
        }
    }

    fn border_fill(fill_type: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(1u16 << 2).to_le_bytes()); // slash direction
        for (kind, width, color) in [
            (1u8, 0u8, 0x0000_00ffu32),
            (2, 1, 0x0000_ff00),
            (3, 2, 0x00ff_0000),
            (8, 3, 0),
        ] {
            bytes.push(kind);
            bytes.push(width);
            bytes.extend_from_slice(&color.to_le_bytes());
        }
        bytes.push(1); // diagonal solid
        bytes.push(0);
        bytes.extend_from_slice(&0x0000_ff00u32.to_le_bytes());
        bytes.extend_from_slice(&fill_type.to_le_bytes());
        match fill_type {
            0 => bytes.extend_from_slice(&0u32.to_le_bytes()),
            1 => {
                bytes.extend_from_slice(&0x00ff_0000u32.to_le_bytes());
                bytes.extend_from_slice(&0u32.to_le_bytes());
                bytes.extend_from_slice(&(-1i32).to_le_bytes());
                bytes.extend_from_slice(&0u32.to_le_bytes());
                bytes.push(0);
            }
            _ => {}
        }
        bytes
    }

    fn numbering() -> Vec<u8> {
        let mut bytes = Vec::new();
        for _ in 0..7 {
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0i16.to_le_bytes());
            bytes.extend_from_slice(&0i16.to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0u16.to_le_bytes());
        }
        bytes.extend_from_slice(&1u16.to_le_bytes());
        for _ in 0..7 {
            bytes.extend_from_slice(&1u32.to_le_bytes());
        }
        for _ in 0..3 {
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0u32.to_le_bytes());
            bytes.extend_from_slice(&0u16.to_le_bytes());
            bytes.extend_from_slice(&1u32.to_le_bytes());
        }
        bytes
    }

    fn style(kind: u8, next_style: u8, para_shape: u16, char_shape: u16) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&('가' as u16).to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&('A' as u16).to_le_bytes());
        bytes.push(kind);
        bytes.push(next_style);
        bytes.extend_from_slice(&1042u16.to_le_bytes());
        bytes.extend_from_slice(&para_shape.to_le_bytes());
        bytes.extend_from_slice(&char_shape.to_le_bytes());
        bytes
    }

    #[test]
    fn style_parses_exact_base_and_observed_zero_tail() {
        let bytes = style(0, 0, 0, 0);
        let parsed = parse_style(&bytes, &record(TAG_STYLE, bytes.len())).unwrap();
        assert_eq!(parsed.kind, 0);
        assert_eq!(parsed.next_style, 0);
        assert_eq!(parsed.para_shape, 0);

        let mut tailed = bytes;
        tailed.extend_from_slice(&0u16.to_le_bytes());
        assert!(parse_style(&tailed, &record(TAG_STYLE, tailed.len())).is_ok());
        let last = tailed.len() - 1;
        tailed[last] = 1;
        assert!(matches!(
            parse_style(&tailed, &record(TAG_STYLE, tailed.len())),
            Err(Error::MalformedRecord {
                reason: "STYLE reserved tail is nonzero",
                ..
            })
        ));
    }

    #[test]
    fn style_rejects_hostile_lengths_unknown_kinds_and_bad_refs() {
        let hostile = [0xff, 0xff];
        assert!(matches!(
            parse_style(&hostile, &record(TAG_STYLE, hostile.len())),
            Err(Error::MalformedRecord {
                reason: "STYLE local name is invalid UTF-16",
                ..
            })
        ));

        let unknown = style(2, 0, 0, 0);
        assert!(matches!(
            parse_style(&unknown, &record(TAG_STYLE, unknown.len())),
            Err(Error::MalformedRecord {
                reason: "STYLE has an unknown kind or attributes",
                ..
            })
        ));

        let source = record(TAG_STYLE, 0);
        assert!(validate_style_refs(
            &[StyleDef {
                kind: 0,
                next_style: 0,
                para_shape: 0,
                char_shape: 0,
            }],
            &[&source],
            1,
            1,
        )
        .is_ok());
        assert!(matches!(
            validate_style_refs(
                &[StyleDef {
                    kind: 1,
                    next_style: 2,
                    para_shape: 0,
                    char_shape: 0,
                }],
                &[&source],
                1,
                1,
            ),
            Err(Error::InvalidReference {
                kind: "next style",
                ..
            })
        ));
    }

    #[test]
    fn border_fill_maps_known_edges_shade_and_diagonal() {
        let bytes = border_fill(1);
        let parsed = parse_border_fill(&bytes, &record(TAG_BORDER_FILL, bytes.len())).unwrap();
        assert!(parsed.has_border);
        assert_eq!(parsed.borders[0].unwrap().style, LineStyle::Solid);
        assert_eq!(parsed.borders[1].unwrap().style, LineStyle::Dashed);
        assert_eq!(parsed.borders[2].unwrap().style, LineStyle::Dotted);
        assert_eq!(parsed.borders[3].unwrap().style, LineStyle::Double);
        assert_eq!(parsed.borders[0].unwrap().color.r, 255);
        assert_eq!(parsed.shade.unwrap().b, 255);
        assert_eq!(parsed.diagonal.unwrap().kind, DiagonalKind::Slash);
    }

    #[test]
    fn border_fill_refuses_unknown_lines_and_unowned_fills() {
        let mut bad_line = border_fill(0);
        bad_line[2] = 17;
        assert!(matches!(
            parse_border_fill(&bad_line, &record(TAG_BORDER_FILL, bad_line.len())),
            Err(Error::MalformedRecord {
                reason: "BORDER_FILL has an unknown line type",
                ..
            })
        ));

        let image = border_fill(2);
        assert!(matches!(
            parse_border_fill(&image, &record(TAG_BORDER_FILL, image.len())),
            Err(Error::MalformedRecord {
                reason: "BORDER_FILL image, gradient, or mixed fill is not supported",
                ..
            })
        ));
    }

    #[test]
    fn tab_definition_count_is_exact_and_bounded() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&7200u32.to_le_bytes());
        bytes.extend_from_slice(&0u8.to_le_bytes());
        bytes.extend_from_slice(&1u8.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(
            parse_tab_def(&bytes, &record(TAG_TAB_DEF, bytes.len()))
                .unwrap()
                .custom_count,
            1
        );
        bytes.pop();
        assert!(parse_tab_def(&bytes, &record(TAG_TAB_DEF, bytes.len())).is_err());
    }

    #[test]
    fn numbering_510_extension_is_fully_consumed() {
        let bytes = numbering();
        let parsed = parse_numbering(&bytes, &record(TAG_NUMBERING, bytes.len())).unwrap();
        assert_eq!(parsed.char_shape_refs.len(), 7);
        let mut truncated = bytes;
        truncated.pop();
        assert!(parse_numbering(&truncated, &record(TAG_NUMBERING, truncated.len())).is_err());
    }

    #[test]
    fn paragraph_refs_are_range_checked_but_inert_refs_survive() {
        let mut bytes = vec![0; 42];
        bytes[28..30].copy_from_slice(&0u16.to_le_bytes());
        bytes[30..32].copy_from_slice(&1u16.to_le_bytes());
        bytes[32..34].copy_from_slice(&1u16.to_le_bytes());
        let (shape, usage) = parse_para_shape(
            &bytes,
            &record(TAG_PARA_SHAPE, bytes.len()),
            &[TabDef::default()],
            1,
            0,
            1,
        )
        .unwrap();
        assert_eq!(shape.numbering_id, 1);
        assert_eq!(shape.border_fill_id, 1);
        assert_eq!(usage.head_type, 0);

        bytes[30..32].copy_from_slice(&2u16.to_le_bytes());
        assert!(matches!(
            parse_para_shape(
                &bytes,
                &record(TAG_PARA_SHAPE, bytes.len()),
                &[TabDef::default()],
                1,
                0,
                1,
            ),
            Err(Error::InvalidReference {
                kind: "numbering",
                ..
            })
        ));
    }

    #[test]
    fn active_custom_tabs_lists_and_paragraph_borders_fail_closed() {
        let header = record(TAG_PARA_HEADER, 22);
        let mut doc = SemanticDoc::default();
        doc.header_pools.border.insert(
            1,
            BorderFillDef {
                has_border: true,
                ..BorderFillDef::default()
            },
        );
        let tab = DecodedText {
            chars: vec![(0, '\t')],
            ..DecodedText::default()
        };
        assert!(validate_para_usage(
            &ParaUsage {
                has_custom_tabs: true,
                ..ParaUsage::default()
            },
            &tab,
            &doc,
            &header,
            0,
        )
        .is_err());
        assert!(validate_para_usage(
            &ParaUsage {
                numbering: 1,
                head_type: 2,
                ..ParaUsage::default()
            },
            &DecodedText::default(),
            &doc,
            &header,
            0,
        )
        .is_err());
        assert!(validate_para_usage(
            &ParaUsage {
                border_fill: 1,
                ..ParaUsage::default()
            },
            &DecodedText::default(),
            &doc,
            &header,
            0,
        )
        .is_err());
    }

    #[test]
    fn bullet_base_and_extension_are_exact() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0i16.to_le_bytes());
        bytes.extend_from_slice(&0i16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0x2022u16.to_le_bytes());
        let parsed = parse_bullet(&bytes, &record(TAG_BULLET, bytes.len())).unwrap();
        assert_eq!(parsed.char_shape_ref, 0);

        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        assert!(parse_bullet(&bytes, &record(TAG_BULLET, bytes.len())).is_ok());
        bytes.pop();
        assert!(parse_bullet(&bytes, &record(TAG_BULLET, bytes.len())).is_err());
    }
}
