//! 쪽 번호 전용 자체 추출(S2) — 문서 전체 엄격 파싱([`super::parse_text_only`])과 떼어 낸 좁은 조각.
//!
//! 컨테이너 · 레코드 틀은 [`crate::probe`] 가 모든 구역 스트림에서 검증한다. 해석하는 것은
//! `pgnp`(쪽 번호 위치) · `nwno`(새 번호, 쪽 카운터만) · `pghd`(감추기의 쪽 번호 비트) 세 제어뿐이고,
//! `pgnp` · `nwno` 는 엄격 파서와 **같은 함수**로 읽는다. 받는 자리는 두 가지다.
//!
//! - 최상위 문단의 제어(레코드 깊이 1)
//! - 최상위 문단이 품은 표의 칸 문단의 제어(깊이 3, 그 표의 `TABLE` 레코드 뒤 `LIST_HEADER` 칸)
//!
//! 그 밖의 자리(머리말 · 꼬리말 · 각주 · 글상자 · 캡션 · 표 속 표), 읽을 수 없는 값, 같은 구역 안의 서로 다른
//! 쪽 번호 위치는 그 구역의 쪽 번호를 **끄고 이유를 남긴다**([`PageNumberFacts`] — HWPX 파서와 같은 판단).
//! 오류(`Err`)는 컨테이너 · 레코드 틀이 깨졌을 때뿐이다. 본문 위상(문단 · 표 · 칸)을 rhwp 결과와 맞춰 보는
//! 일은 `hwp-core` 의 몫이다.

use super::{
    data, malformed, parse_new_number_control, parse_page_number_control, read_u16, read_u32,
    CTRL_NEW_NUMBER, CTRL_PAGE_NUM_POS, CTRL_SECTION_DEF, CTRL_TABLE, TAG_CTRL_HEADER,
    TAG_LIST_HEADER, TAG_PARA_HEADER, TAG_TABLE,
};
use crate::{probe, Record, Result, StreamProbe};
use hwp_model::document::{PageNumberFacts, PageNumberMark, PageNumberOff};

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

/// 한 구역의 쪽 번호 사실. 켤지 끌지는 HWPX 파서와 같은 [`PageNumberFacts::resolve`] 가 정한다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedSectionPageNumbers {
    /// 쪽 번호 위치 · 끈 이유 · 구역 시작 번호(`secd`) · 첫 문단의 새 번호.
    pub facts: PageNumberFacts,
    /// 최상위 문단 수 — 본문과 위상을 맞출 때 쓴다.
    pub top_level_paragraphs: usize,
    pub marks: Vec<OwnedPageNumberMark>,
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
                    out.facts.start_page = read_u16(data(stream, record), 20).ok_or_else(|| {
                        malformed(record, Some(section), "section definition is too short")
                    })?;
                }
                let site = at.paragraph.map(PageNumberSite::Paragraph);
                let before = out.marks.len();
                read_control(stream, record, section, id, site, &mut out);
                if id == CTRL_NEW_NUMBER && at.paragraph == Some(0) && out.marks.len() > before {
                    out.facts.restart_at_start = true;
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
                        Some(PageNumberSite::Cell {
                            paragraph,
                            table: at.tables - 1,
                            row,
                            col,
                            cell_paragraph,
                        })
                    }
                    // 머리말 · 꼬리말 · 각주 · 글상자 · 캡션 · 표 속 표 — 받지 않는 자리.
                    _ => None,
                };
                read_control(stream, record, section, id, site, &mut out);
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

/// 쪽 번호 제어 하나를 읽어 표지로 단다. 받지 않는 자리 · 읽을 수 없는 값이면 그 구역을 끈다(이유를 남긴다).
/// `pgnp` · `nwno` 는 엄격 파서의 함수로 읽는다.
fn read_control(
    stream: &StreamProbe,
    record: &Record,
    section: usize,
    id: u32,
    site: Option<PageNumberSite>,
    out: &mut OwnedSectionPageNumbers,
) {
    if !is_page_number_control(id) {
        return;
    }
    let Some(site) = site else {
        out.facts.turn_off(PageNumberOff::OutsideBody);
        return;
    };
    match read_mark(data(stream, record), record, section, id, &mut out.facts) {
        Ok(Some(mark)) => out.marks.push(OwnedPageNumberMark { site, mark }),
        Ok(None) => {}
        Err(reason) => out.facts.turn_off(reason),
    }
}

fn read_mark(
    bytes: &[u8],
    record: &Record,
    section: usize,
    id: u32,
    facts: &mut PageNumberFacts,
) -> std::result::Result<Option<PageNumberMark>, PageNumberOff> {
    let unread = |_| PageNumberOff::UnreadValue;
    match id {
        CTRL_PAGE_NUM_POS => {
            facts.add_position(parse_page_number_control(bytes, record, section).map_err(unread)?);
            Ok(Some(PageNumberMark::Show))
        }
        CTRL_NEW_NUMBER => {
            // 쪽이 아닌 카운터(각주 · 그림 · 표 · 수식 번호)는 쪽 번호와 무관하다.
            let other_counter =
                bytes.len() == 10 && read_u32(bytes, 4).is_some_and(|attr| attr & 0x0f != 0);
            if other_counter {
                return Ok(None);
            }
            let start = parse_new_number_control(bytes, record, section).map_err(unread)?;
            Ok(Some(PageNumberMark::Restart(start)))
        }
        _ => {
            let attr = (bytes.len() == 8)
                .then(|| read_u32(bytes, 4))
                .flatten()
                .filter(|attr| attr & !PAGE_HIDE_KNOWN_BITS == 0)
                .ok_or(PageNumberOff::UnreadValue)?;
            Ok((attr & PAGE_HIDE_PAGE_NUMBER != 0).then_some(PageNumberMark::Hide))
        }
    }
}
