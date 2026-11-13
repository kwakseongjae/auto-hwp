//! 쪽 번호 전용 자체 추출(S2) — 문서 전체 엄격 파싱([`super::parse_text_only`])과 떼어 낸 좁은 조각.
//!
//! 컨테이너 · 레코드 틀은 [`crate::probe`] 가 모든 구역 스트림에서 검증한다. 해석하는 것은
//! `pgnp`(쪽 번호 위치) · `nwno`(새 번호, 쪽 카운터만) · `pghd`(감추기의 쪽 번호 비트) 세 제어뿐이고,
//! `pgnp` · `nwno` 는 엄격 파서와 **같은 함수**로 읽는다. 받는 자리는 두 가지다.
//!
//! - 최상위 문단의 제어(레코드 깊이 1)
//! - 최상위 문단이 품은 표의 칸 문단의 제어(깊이 3, 그 표의 `TABLE` 레코드 뒤 `LIST_HEADER` 칸)
//!
//! 그 밖의 자리(머리말 · 꼬리말 · 각주 · 글상자 · 캡션 · 표 속 표), 모르는 속성 비트, 같은 구역 안의
//! 서로 다른 쪽 번호 위치는 전부 오류다 — 호출부는 오류면 아무것도 바꾸지 않는다(원자적).
//! 본문 위상(문단 · 표 · 칸)을 rhwp 결과와 맞춰 보는 일은 `hwp-core` 의 몫이다.

use super::{
    data, malformed, parse_new_number_control, parse_page_number_control, read_u16, read_u32,
    unsupported_reason, CTRL_NEW_NUMBER, CTRL_PAGE_NUM_POS, CTRL_SECTION_DEF, CTRL_TABLE,
    TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_PARA_HEADER, TAG_TABLE,
};
use crate::{probe, Record, Result, StreamProbe};
use hwp_model::document::{PageNumberDecoration, PageNumberMark};

const CTRL_PAGE_HIDE: u32 = u32::from_be_bytes(*b"pghd");
/// `pghd` 속성: 머리말 0x01 · 꼬리말 0x02 · 바탕쪽 0x04 · 테두리 0x08 · 배경 0x10 · 쪽 번호 0x20.
const PAGE_HIDE_KNOWN_BITS: u32 = 0x3f;
const PAGE_HIDE_PAGE_NUMBER: u32 = 0x20;

/// 쪽 번호 제어가 놓인 자리 — 최상위 문단 순번과, 칸이면 그 문단이 품은 표 순번 · 칸 주소 · 칸 문단 순번.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageNumberSite {
    Paragraph(usize),
    Cell {
        paragraph: usize,
        table: usize,
        row: usize,
        col: usize,
        cell_paragraph: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnedPageNumberMark {
    pub site: PageNumberSite,
    pub mark: PageNumberMark,
}

/// 한 구역의 쪽 번호 사실.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedSectionPageNumbers {
    /// 구역 안 쪽 번호 위치(같은 값의 반복은 하나로 본다). 시작 번호는 1 — 새 번호는 표지가 맡는다.
    pub decoration: Option<PageNumberDecoration>,
    /// 최상위 문단 수 — 본문과 위상을 맞출 때 쓴다.
    pub top_level_paragraphs: usize,
    pub marks: Vec<OwnedPageNumberMark>,
    /// 구역 정의(`secd`)의 쪽 시작 번호. 0 = 앞 구역에서 이어 센다.
    pub start_page: u16,
    /// 첫 최상위 문단에 직접 놓인 새 번호 — 구역 첫 쪽의 번호를 확정한다.
    pub restart_at_start: bool,
}

impl OwnedSectionPageNumbers {
    /// 이 구역에 그릴 쪽 번호 모양. HWPX 파서와 같은 규칙이다.
    /// - 쪽 시작 번호가 0 이 아니면 끈다(코퍼스로 확인하지 못한 꼴).
    /// - 둘째 구역부터는 첫 문단에 새 번호가 있을 때만 켠다(이어 세는 번호를 지금 조판이 모른다).
    pub fn decoration_for(&self, section_index: usize) -> Option<PageNumberDecoration> {
        if self.start_page != 0 || (section_index > 0 && !self.restart_at_start) {
            return None;
        }
        self.decoration
    }
}

pub(crate) fn page_number_controls(bytes: &[u8]) -> Result<Vec<OwnedSectionPageNumbers>> {
    let inspected = probe(bytes)?;
    inspected
        .streams
        .iter()
        .filter(|stream| stream.section.is_some())
        .map(scan_section)
        .collect()
}

/// 지금 걷고 있는 최상위 문단 안의 위치.
#[derive(Default)]
struct Cursor {
    paragraph: Option<usize>,
    /// 깊이 1 제어 중 가장 최근 것의 id.
    control: Option<u32>,
    /// 이 문단이 품은 표 수(`tbl ` 깊이 1 제어).
    tables: usize,
    /// 지금 표의 `TABLE` 레코드를 지났는가 — 그 앞의 `LIST_HEADER` 는 캡션이다.
    table_body: bool,
    cell: Option<(usize, usize)>,
    cell_paragraph: Option<usize>,
}

fn scan_section(stream: &StreamProbe) -> Result<OwnedSectionPageNumbers> {
    let section = stream.section.expect("caller selected section streams");
    let mut out = OwnedSectionPageNumbers::default();
    let mut at = Cursor::default();
    let mut section_def_seen = false;
    for record in &stream.records {
        match (record.tag, record.level) {
            (TAG_PARA_HEADER, 0) => {
                at = Cursor {
                    paragraph: Some(out.top_level_paragraphs),
                    ..Cursor::default()
                };
                out.top_level_paragraphs += 1;
            }
            (TAG_CTRL_HEADER, 1) => {
                let id = control_id(stream, record, section)?;
                at.control = Some(id);
                at.cell = None;
                at.cell_paragraph = None;
                at.table_body = false;
                if id == CTRL_TABLE {
                    at.tables += 1;
                }
                if id == CTRL_SECTION_DEF && !section_def_seen {
                    section_def_seen = true;
                    // secd: id · 속성 u32 · 단 간격 · 세로 · 가로 격자 · 기본 탭 u32 · 번호 문단 모양 · 쪽 시작 번호.
                    out.start_page = read_u16(data(stream, record), 20).ok_or_else(|| {
                        malformed(record, Some(section), "section definition is too short")
                    })?;
                }
                let site = at.paragraph.map(PageNumberSite::Paragraph);
                let before = out.marks.len();
                read_control(stream, record, section, id, site, &mut out)?;
                if id == CTRL_NEW_NUMBER && at.paragraph == Some(0) && out.marks.len() > before {
                    out.restart_at_start = true;
                }
            }
            (TAG_TABLE, 2) if at.control == Some(CTRL_TABLE) => at.table_body = true,
            (TAG_LIST_HEADER, 2) if at.control == Some(CTRL_TABLE) && at.table_body => {
                let list = data(stream, record);
                // 칸 LIST_HEADER: 문단 수 u16 · 속성 u32 · (2) · 열 주소 u16 · 행 주소 u16 …
                let (Some(col), Some(row)) = (read_u16(list, 8), read_u16(list, 10)) else {
                    return Err(malformed(
                        record,
                        Some(section),
                        "cell LIST_HEADER is too short",
                    ));
                };
                at.cell = Some((usize::from(row), usize::from(col)));
                at.cell_paragraph = None;
            }
            (TAG_PARA_HEADER, 2) if at.cell.is_some() => {
                at.cell_paragraph = Some(at.cell_paragraph.map_or(0, |index| index + 1));
            }
            (TAG_CTRL_HEADER, level) if level >= 2 => {
                let id = control_id(stream, record, section)?;
                if !is_page_number_control(id) {
                    continue;
                }
                let site = match (level, at.paragraph, at.cell, at.cell_paragraph) {
                    (3, Some(paragraph), Some((row, col)), Some(cell_paragraph))
                        if at.control == Some(CTRL_TABLE) =>
                    {
                        PageNumberSite::Cell {
                            paragraph,
                            table: at.tables - 1,
                            row,
                            col,
                            cell_paragraph,
                        }
                    }
                    _ => {
                        return Err(unsupported_reason(
                            *record,
                            section,
                            "page-number control outside a top-level paragraph or table cell is not owned",
                        ))
                    }
                };
                read_control(stream, record, section, id, Some(site), &mut out)?;
            }
            _ => {}
        }
    }
    Ok(out)
}

fn control_id(stream: &StreamProbe, record: &Record, section: usize) -> Result<u32> {
    read_u32(data(stream, record), 0)
        .ok_or_else(|| malformed(record, Some(section), "CTRL_HEADER has no control id"))
}

fn is_page_number_control(id: u32) -> bool {
    matches!(id, CTRL_PAGE_NUM_POS | CTRL_NEW_NUMBER | CTRL_PAGE_HIDE)
}

fn read_control(
    stream: &StreamProbe,
    record: &Record,
    section: usize,
    id: u32,
    site: Option<PageNumberSite>,
    out: &mut OwnedSectionPageNumbers,
) -> Result<()> {
    if !is_page_number_control(id) {
        return Ok(());
    }
    let Some(site) = site else {
        return Err(malformed(
            record,
            Some(section),
            "page-number control appears before any paragraph",
        ));
    };
    let bytes = data(stream, record);
    let mark = match id {
        CTRL_PAGE_NUM_POS => {
            let decoration = parse_page_number_control(bytes, record, section)?;
            match out.decoration {
                Some(existing) if existing != decoration => {
                    return Err(malformed(
                        record,
                        Some(section),
                        "page-number positions in one section have conflicting semantics",
                    ))
                }
                _ => out.decoration = Some(decoration),
            }
            Some(PageNumberMark::Show)
        }
        CTRL_NEW_NUMBER => {
            // 쪽이 아닌 카운터(각주 · 그림 · 표 · 수식 번호)는 쪽 번호와 무관하다.
            let page_counter =
                bytes.len() == 10 && read_u32(bytes, 4).is_some_and(|attr| attr & 0x0f == 0);
            if bytes.len() == 10 && !page_counter {
                None
            } else {
                Some(PageNumberMark::Restart(parse_new_number_control(
                    bytes, record, section,
                )?))
            }
        }
        _ => {
            if bytes.len() != 8 {
                return Err(malformed(
                    record,
                    Some(section),
                    "page-hide control is not exactly 8 bytes",
                ));
            }
            let attr = read_u32(bytes, 4).expect("exact length checked");
            if attr & !PAGE_HIDE_KNOWN_BITS != 0 {
                return Err(malformed(
                    record,
                    Some(section),
                    "page-hide control has unknown attribute bits",
                ));
            }
            (attr & PAGE_HIDE_PAGE_NUMBER != 0).then_some(PageNumberMark::Hide)
        }
    };
    if let Some(mark) = mark {
        out.marks.push(OwnedPageNumberMark { site, mark });
    }
    Ok(())
}
