//! First-sheet `.xlsx` roster reader (issue #40).
//!
//! Contract shared with `apps/hwp-lab/src/lib/xlsxRoster.ts`:
//! - exactly one worksheet; extra sheets are an error, not a silent sheet-0 pick
//! - row 1 is keys (한글 헤더 허용); later rows are documents
//! - trailing all-empty rows are ignored
//! - any merged cell is an error (no silent shift)
//! - a value past the last header column is an error
//!
//! Uses workspace `zip` + `quick-xml` only — no extra native runtime, no calamine.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{Map, Value};

pub fn load_path(path: &Path) -> Result<Vec<Map<String, Value>>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_xlsx_roster(&bytes)
}

pub fn parse_xlsx_roster(bytes: &[u8]) -> Result<Vec<Map<String, Value>>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("xlsx를 읽지 못했습니다: {e}"))?;

    let workbook = read_zip(&mut zip, "xl/workbook.xml")?;
    let sheet_ids = workbook_sheet_rids(&workbook)?;
    if sheet_ids.is_empty() {
        return Err("xlsx 시트가 없습니다".into());
    }
    if sheet_ids.len() != 1 {
        return Err(format!(
            "xlsx 시트가 {}개입니다 — 첫 시트만 지원합니다. 나머지 시트를 지우거나 JSON/CSV로 보내주세요",
            sheet_ids.len()
        ));
    }

    let rels = read_zip(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let rel_map = parse_rels(&rels);
    let target = rel_map
        .get(&sheet_ids[0])
        .ok_or_else(|| format!("xlsx를 읽지 못했습니다: 시트 관계 {} 없음", sheet_ids[0]))?;
    let sheet_path = resolve_xl_target(target);

    let sst = read_zip(&mut zip, "xl/sharedStrings.xml")
        .ok()
        .map(|xml| parse_shared_strings(&xml))
        .transpose()?
        .unwrap_or_default();

    let sheet = read_zip(&mut zip, &sheet_path)?;
    rows_from_sheet(&sheet, &sst)
}

fn read_zip(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<String, String> {
    let mut file = zip
        .by_name(name)
        .map_err(|_| format!("xlsx를 읽지 못했습니다: {name} 없음"))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("xlsx를 읽지 못했습니다: {name}: {e}"))?;
    if buf.starts_with('\u{feff}') {
        buf = buf.trim_start_matches('\u{feff}').to_string();
    }
    Ok(buf)
}

fn local_name(q: &[u8]) -> &[u8] {
    match q.iter().rposition(|b| *b == b':') {
        Some(i) => &q[i + 1..],
        None => q,
    }
}

fn workbook_sheet_rids(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut ids = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e) | Event::Start(e)) => {
                let qn = e.name();
                if local_name(qn.as_ref()) == b"sheet" {
                    let mut rid = None;
                    for a in e.attributes().flatten() {
                        let key = local_name(a.key.as_ref());
                        if key == b"id" {
                            rid = Some(
                                a.decode_and_unescape_value(reader.decoder())
                                    .map_err(|err| err.to_string())?
                                    .into_owned(),
                            );
                        }
                    }
                    ids.push(rid.ok_or("xlsx를 읽지 못했습니다: 시트 r:id 없음")?);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xlsx를 읽지 못했습니다: workbook.xml: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(ids)
}

fn parse_rels(xml: &str) -> BTreeMap<String, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut map = BTreeMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e) | Event::Start(e)) => {
                let qn = e.name();
                if local_name(qn.as_ref()) == b"Relationship" {
                    let mut id = None;
                    let mut target = None;
                    for a in e.attributes().flatten() {
                        let key = local_name(a.key.as_ref());
                        let val = a
                            .decode_and_unescape_value(reader.decoder())
                            .map(|v| v.into_owned())
                            .unwrap_or_default();
                        if key == b"Id" {
                            id = Some(val);
                        } else if key == b"Target" {
                            target = Some(val);
                        }
                    }
                    if let (Some(id), Some(target)) = (id, target) {
                        map.insert(id, target);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    map
}

fn resolve_xl_target(target: &str) -> String {
    let t = target.replace('\\', "/");
    if t.starts_with("/xl/") {
        t.trim_start_matches('/').to_string()
    } else if t.starts_with("xl/") {
        t
    } else if t.starts_with('/') {
        format!("xl{}", t)
    } else {
        format!("xl/{t}")
    }
}

fn parse_shared_strings(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_si = false;
    let mut in_t = false;
    let mut in_rph = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qn = e.name();
                let name = local_name(qn.as_ref());
                if name == b"si" {
                    in_si = true;
                    cur.clear();
                } else if name == b"rPh" {
                    in_rph = true;
                } else if name == b"t" && in_si && !in_rph {
                    in_t = true;
                }
            }
            Ok(Event::Empty(e)) => {
                let qn = e.name();
                if local_name(qn.as_ref()) == b"si" {
                    out.push(String::new());
                }
            }
            Ok(Event::Text(t)) if in_t => {
                cur.push_str(&t.unescape().map_err(|e| e.to_string())?);
            }
            Ok(Event::CData(t)) if in_t => {
                cur.push_str(&String::from_utf8_lossy(&t.into_inner()));
            }
            Ok(Event::End(e)) => {
                let qn = e.name();
                let name = local_name(qn.as_ref());
                if name == b"t" {
                    in_t = false;
                } else if name == b"rPh" {
                    in_rph = false;
                } else if name == b"si" {
                    out.push(std::mem::take(&mut cur));
                    in_si = false;
                    in_t = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xlsx를 읽지 못했습니다: sharedStrings.xml: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn rows_from_sheet(xml: &str, sst: &[String]) -> Result<Vec<Map<String, Value>>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();

    let mut cells: BTreeMap<(u32, u32), String> = BTreeMap::new();
    let mut merges: Vec<(u32, u32, u32, u32)> = Vec::new();

    let mut cell_ref = String::new();
    let mut cell_type = String::new();
    let mut in_v = false;
    let mut in_t = false;
    let mut in_is = false;
    let mut text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let qn = e.name();
                let name = local_name(qn.as_ref());
                if name == b"c" {
                    cell_ref.clear();
                    cell_type.clear();
                    text.clear();
                    in_is = false;
                    for a in e.attributes().flatten() {
                        let key = local_name(a.key.as_ref());
                        let val = a
                            .decode_and_unescape_value(reader.decoder())
                            .map(|v| v.into_owned())
                            .unwrap_or_default();
                        if key == b"r" {
                            cell_ref = val;
                        } else if key == b"t" {
                            cell_type = val;
                        }
                    }
                } else if name == b"v" {
                    in_v = true;
                    text.clear();
                } else if name == b"is" {
                    in_is = true;
                } else if name == b"t" && in_is {
                    in_t = true;
                } else if name == b"mergeCell" {
                    for a in e.attributes().flatten() {
                        if local_name(a.key.as_ref()) == b"ref" {
                            let val = a
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(|err| err.to_string())?;
                            merges.push(parse_merge(&val)?);
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let qn = e.name();
                if local_name(qn.as_ref()) == b"mergeCell" {
                    for a in e.attributes().flatten() {
                        if local_name(a.key.as_ref()) == b"ref" {
                            let val = a
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(|err| err.to_string())?;
                            merges.push(parse_merge(&val)?);
                        }
                    }
                }
            }
            Ok(Event::Text(t)) if in_v || in_t => {
                text.push_str(&t.unescape().map_err(|e| e.to_string())?);
            }
            Ok(Event::CData(t)) if in_v || in_t => {
                text.push_str(&String::from_utf8_lossy(&t.into_inner()));
            }
            Ok(Event::End(e)) => {
                let qn = e.name();
                let name = local_name(qn.as_ref());
                if name == b"v" {
                    in_v = false;
                } else if name == b"t" {
                    in_t = false;
                } else if name == b"is" {
                    in_is = false;
                } else if name == b"c" {
                    if !cell_ref.is_empty() {
                        if let Some((row, col)) = parse_cell_ref(&cell_ref) {
                            let value = decode_cell(&cell_type, &text, sst)?;
                            if !value.is_empty() {
                                cells.insert((row, col), value);
                            }
                        }
                    }
                    cell_ref.clear();
                    cell_type.clear();
                    text.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xlsx를 읽지 못했습니다: sheet: {e}")),
            _ => {}
        }
        buf.clear();
    }

    if !merges.is_empty() {
        return Err("xlsx에 병합 셀이 있습니다 — 병합을 풀거나 JSON으로 보내주세요".into());
    }

    table_from_cells(&cells)
}

fn decode_cell(kind: &str, raw: &str, sst: &[String]) -> Result<String, String> {
    match kind {
        "s" => {
            let i: usize = raw
                .trim()
                .parse()
                .map_err(|_| format!("xlsx를 읽지 못했습니다: 공유 문자열 인덱스 {raw}"))?;
            sst.get(i)
                .cloned()
                .ok_or_else(|| format!("xlsx를 읽지 못했습니다: 공유 문자열 {i} 없음"))
        }
        "b" => Ok(if raw.trim() == "1" {
            "TRUE".into()
        } else {
            "FALSE".into()
        }),
        "e" => Ok(raw.trim().to_string()),
        "inlineStr" | "str" | "" => Ok(raw.trim_end().to_string()),
        _ => Ok(raw.trim_end().to_string()),
    }
}

fn table_from_cells(
    cells: &BTreeMap<(u32, u32), String>,
) -> Result<Vec<Map<String, Value>>, String> {
    if cells.is_empty() {
        return Err("xlsx 헤더가 비어 있습니다".into());
    }
    let min_row = cells.keys().map(|(r, _)| *r).min().unwrap();
    let header_cols: Vec<u32> = cells
        .keys()
        .filter(|(r, _)| *r == min_row)
        .map(|(_, c)| *c)
        .collect();
    let max_header = *header_cols.iter().max().unwrap();
    let mut headers = Vec::new();
    for col in 0..=max_header {
        let Some(name) = cells.get(&(min_row, col)).map(|s| s.trim().to_string()) else {
            return Err(format!(
                "xlsx 헤더 {}열이 비어 있습니다 — 빈 헤더는 JSON으로 보내주세요",
                col + 1
            ));
        };
        if name.is_empty() {
            return Err(format!(
                "xlsx 헤더 {}열이 비어 있습니다 — 빈 헤더는 JSON으로 보내주세요",
                col + 1
            ));
        }
        headers.push(name);
    }

    let max_row = cells.keys().map(|(r, _)| *r).max().unwrap();
    let mut rows = Vec::new();
    for row in (min_row + 1)..=max_row {
        if let Some((_, col)) = cells.keys().find(|(r, c)| *r == row && *c > max_header) {
            return Err(format!(
                "xlsx {}행: 헤더 밖의 값이 있습니다 ({}열)",
                row,
                col + 1
            ));
        }
        let mut map = Map::new();
        let mut any = false;
        for (i, key) in headers.iter().enumerate() {
            let val = cells.get(&(row, i as u32)).cloned().unwrap_or_default();
            if !val.is_empty() {
                any = true;
            }
            map.insert(key.clone(), Value::String(val));
        }
        if any {
            rows.push(map);
        }
    }
    if rows.is_empty() {
        return Err("xlsx 데이터 행이 없습니다".into());
    }
    Ok(rows)
}

fn parse_cell_ref(r: &str) -> Option<(u32, u32)> {
    let r = r.trim_start_matches('$');
    let split = r.find(|c: char| c.is_ascii_digit())?;
    let (col_s, row_s) = r.split_at(split);
    let col_s = col_s.replace('$', "");
    let row: u32 = row_s.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row, col_index(&col_s)?))
}

fn col_index(letters: &str) -> Option<u32> {
    if letters.is_empty() {
        return None;
    }
    let mut n: u32 = 0;
    for c in letters.chars() {
        let u = c.to_ascii_uppercase();
        if !u.is_ascii_uppercase() {
            return None;
        }
        n = n.checked_mul(26)?.checked_add(u as u32 - b'A' as u32 + 1)?;
    }
    n.checked_sub(1)
}

fn parse_merge(ref_: &str) -> Result<(u32, u32, u32, u32), String> {
    let (a, b) = ref_
        .split_once(':')
        .ok_or_else(|| format!("xlsx를 읽지 못했습니다: 병합 {ref_}"))?;
    let (r1, c1) =
        parse_cell_ref(a).ok_or_else(|| format!("xlsx를 읽지 못했습니다: 병합 {ref_}"))?;
    let (r2, c2) =
        parse_cell_ref(b).ok_or_else(|| format!("xlsx를 읽지 못했습니다: 병합 {ref_}"))?;
    Ok((r1, c1, r2, c2))
}
