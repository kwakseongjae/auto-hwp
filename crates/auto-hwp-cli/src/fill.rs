//! 벌크 채움 (issue 073 v1): 원본 양식 + fill-map + 명단 → 완성본 N부 + zip + 검증 리포트.
//!
//! `inspect`  — 양식에서 라벨→값칸 fill-map **초안**을 유도한다(autohwp.fillmap.v1 JSON). 사람이
//!              검수해 `pin`(명시 주소)을 확정하는 것이 계약이다 — 코퍼스 실측에서 중복 라벨이
//!              37건이라 라벨 매칭만으로는 모호하다(073 §코퍼스 실측).
//! `fill`     — 확정 fill-map + 명단(JSON 배열/단순 CSV)으로 인원별 문서를 만든다. 편집 레인은
//!              웹과 동일한 `hwp_mcp::apply_intent_json`(SetTableCell/Replace)이라 검증·거부
//!              규칙이 앱과 한 벌이다. 산출물마다 재개봉 검증(값 존재 + 쪽수 == 무편집 왕복
//!              기준선)을 돌리고, 문제 행은 조용히 넘기지 않는다: 기본 = 생성 + `needsReview`
//!              (사유코드), `--strict` = 행 스킵. 마지막에 zip + report.json.
//!
//! 정직 노트: 저장 포맷은 HWPX(엔진 계약). `.hwp` 템플릿은 열리고 채워지지만 산출물은 변환본이라
//! 쪽수 기준선도 "무편집 변환 왕복"으로 잡는다(원본 .hwp 쪽수가 아니라 — 073 §타당성 3).

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;

use hwp_mcp::{apply_intent_json, export_bytes, open_bytes, Session};
use serde_json::{json, Map, Value};

/// 인적사항·계약류 라벨 렉시콘(inspect 초안용). 코퍼스 실측 스윕과 동일 목록.
const LEXICON: &[&str] = &[
    "성명",
    "이름",
    "생년월일",
    "연락처",
    "전화번호",
    "휴대전화",
    "주소",
    "이메일",
    "기업명",
    "업체명",
    "회사명",
    "대표자",
    "사업자등록번호",
    "법인등록번호",
    "서명",
    "날짜",
    "작성일",
    "기간",
    "계약기간",
    "소속",
    "직위",
    "부서",
];

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"()·:：'\"※".contains(*c))
        .collect()
}

fn open_session(path: &Path) -> Result<Session, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut s = Session::default();
    open_bytes(&mut s, &bytes, &path.to_string_lossy())?;
    Ok(s)
}

fn doc_of(s: &Session) -> Result<&hwp_model::prelude::SemanticDoc, String> {
    s.doc
        .as_ref()
        .map(|d| d.doc())
        .ok_or_else(|| "no document open".into())
}

fn page_count(s: &Session) -> Result<usize, String> {
    Ok(hwp_session::place(doc_of(s)?, &[]).pages.len())
}

// ── inspect ────────────────────────────────────────────────────────────────────────────────────

/// 라벨 렉시콘으로 fill-map v1 초안을 유도해 JSON을 돌려준다. 중복 라벨은 첫 후보를 pin하고
/// `"ambiguous": N`을 남긴다 — 검수에서 사람이 pin을 확정/수정하는 것이 전제다.
pub fn run_inspect(file: &Path, out: Option<&Path>) -> Result<(), String> {
    let session = open_session(file)?;
    let doc = doc_of(&session)?;
    let profile = hwp_session::doc_profile(doc);

    let mut fields: Vec<Value> = Vec::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for t in &profile.tables_all(doc) {
        let Some(grid) = hwp_session::table_grid(doc, t.0, t.1) else {
            continue;
        };
        for cell in &grid.cells {
            let n = norm(&cell.text);
            if n.is_empty() || n.chars().count() > 20 {
                continue;
            }
            let Some(label) = LEXICON.iter().find(|l| n.starts_with(&norm(l))) else {
                continue;
            };
            *seen.entry((*label).to_string()).or_insert(0) += 1;
            if seen[*label] > 1 {
                continue; // 중복 라벨: 첫 후보만 초안에 — 카운트는 아래 ambiguous로 보고
            }
            // 라벨 우측 첫 셀(빈칸이든 예시든 — 코퍼스 실측: 예시 텍스트가 다수파)
            let Some(right) = grid
                .cells
                .iter()
                .filter(|c| c.row == cell.row && c.col > cell.col)
                .min_by_key(|c| c.col)
            else {
                continue;
            };
            fields.push(json!({
                "key": label,
                "target": { "kind": "label-right", "label": cell.text.trim() },
                "pin": { "section": grid.section, "index": grid.block, "row": right.row, "col": right.col },
                "example": right.text.trim(),
                "required": false,
            }));
        }
    }
    for f in fields.iter_mut() {
        let key = f["key"].as_str().unwrap_or_default().to_string();
        if let Some(n) = seen.get(&key).filter(|n| **n > 1) {
            f["ambiguous"] = json!(n); // 검수 필수 표시
        }
    }
    let map = json!({
        "schema": "autohwp.fillmap.v1",
        "template": { "path": file.to_string_lossy() },
        "fields": fields,
        "note": "초안입니다 — pin(명시 주소)을 검수·확정하세요. ambiguous 표시 필드는 같은 라벨이 여러 곳에 있습니다.",
    });
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    match out {
        Some(p) => std::fs::write(p, &text).map_err(|e| e.to_string())?,
        None => println!("{text}"),
    }
    eprintln!(
        "inspect: 필드 {}개 유도 (중복 라벨 {}종)",
        map["fields"].as_array().map_or(0, Vec::len),
        seen.values().filter(|n| **n > 1).count()
    );
    Ok(())
}

/// doc_profile의 표 목록을 (section, block) 튜플로 — inspect 스캔용 얇은 도우미.
trait TablesAll {
    fn tables_all(&self, doc: &hwp_model::prelude::SemanticDoc) -> Vec<(usize, usize)>;
}
impl TablesAll for hwp_session::DocProfileDto {
    fn tables_all(&self, doc: &hwp_model::prelude::SemanticDoc) -> Vec<(usize, usize)> {
        // 프로필 표 목록은 상한 캡이 있어(컨텍스트 예산) 전 표를 다시 센다 — inspect는 전수 스캔.
        let mut out = Vec::new();
        for (si, sec) in doc.sections.iter().enumerate() {
            for (bi, b) in sec.blocks.iter().enumerate() {
                if matches!(b, hwp_model::prelude::Block::Table(_)) {
                    out.push((si, bi));
                }
            }
        }
        out
    }
}

// ── fill ───────────────────────────────────────────────────────────────────────────────────────

struct RowReport {
    name: String,
    created: bool,
    reasons: Vec<String>,
}

/// 명단 로드: `.json` = 객체 배열(권장), `.csv` = 헤더행 + 단순 콤마 분리(따옴표/콤마 내장 미지원 —
/// 그런 데이터는 JSON으로. 조용한 오파싱 방지를 위해 셀 안 따옴표를 발견하면 정직하게 거부).
fn load_roster(path: &Path) -> Result<Vec<Map<String, Value>>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("roster JSON: {e}"))?;
        return v
            .as_array()
            .ok_or("roster JSON은 객체 배열이어야 합니다")?
            .iter()
            .map(|r| {
                r.as_object()
                    .cloned()
                    .ok_or_else(|| "roster 행은 객체여야 합니다".to_string())
            })
            .collect();
    }
    // 단순 CSV
    if text.contains('"') {
        return Err("CSV에 따옴표가 있습니다 — 내장 콤마/따옴표는 v1 CSV 파서가 지원하지 않습니다. JSON 명단을 사용하세요".into());
    }
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<String> = lines
        .next()
        .ok_or("빈 CSV")?
        .split(',')
        .map(|h| h.trim().to_string())
        .collect();
    let mut rows = Vec::new();
    for (i, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() != header.len() {
            return Err(format!(
                "CSV {}행: 열 수 {} != 헤더 {}",
                i + 2,
                cells.len(),
                header.len()
            ));
        }
        let mut m = Map::new();
        for (h, c) in header.iter().zip(cells) {
            m.insert(h.clone(), Value::String(c.trim().to_string()));
        }
        rows.push(m);
    }
    Ok(rows)
}

/// `{index}`/`{index:03d}`/`{키}` 보간 파일명. 경로 위험 문자는 `_`로.
fn render_name(pattern: &str, index: usize, row: &Map<String, Value>) -> String {
    let mut out = pattern.to_string();
    out = out
        .replace("{index:03d}", &format!("{index:03}"))
        .replace("{index}", &index.to_string());
    for (k, v) in row {
        out = out.replace(&format!("{{{k}}}"), v.as_str().unwrap_or_default());
    }
    out.chars()
        .map(|c| if "/\\:*?\"<>|\n".contains(c) { '_' } else { c })
        .collect()
}

pub struct FillArgs<'a> {
    pub template: &'a Path,
    pub map: &'a Path,
    pub data: &'a Path,
    pub out: &'a Path,
    pub pattern: &'a str,
    pub strict: bool,
}

pub fn run_fill(a: FillArgs) -> Result<(), String> {
    let map: Value = serde_json::from_str(
        &std::fs::read_to_string(a.map).map_err(|e| format!("read {}: {e}", a.map.display()))?,
    )
    .map_err(|e| format!("fill-map JSON: {e}"))?;
    if map["schema"].as_str() != Some("autohwp.fillmap.v1") {
        return Err("fill-map schema가 autohwp.fillmap.v1이 아닙니다".into());
    }
    let fields = map["fields"]
        .as_array()
        .ok_or("fill-map: fields 배열 없음")?
        .clone();
    let rows = load_roster(a.data)?;
    let template_bytes =
        std::fs::read(a.template).map_err(|e| format!("read {}: {e}", a.template.display()))?;

    // 쪽수 기준선 = 무편집 왕복(073 §타당성: .hwp 템플릿은 변환 리플로가 있어 원본 쪽수가 아니라
    // 변환본 쪽수가 정직한 기준). HWPX 템플릿은 왕복이 바이트 동일이라 원본 쪽수와 같다.
    let baseline_pages = {
        let mut s = Session::default();
        open_bytes(&mut s, &template_bytes, "template")?;
        let no_edit = export_bytes(&s)?;
        let mut s2 = Session::default();
        open_bytes(&mut s2, &no_edit, "baseline.hwpx")?;
        page_count(&s2)?
    };

    std::fs::create_dir_all(a.out).map_err(|e| e.to_string())?;
    let mut reports: Vec<RowReport> = Vec::new();
    let mut outputs: Vec<(String, Vec<u8>)> = Vec::new();

    for (i, row) in rows.iter().enumerate() {
        let name = render_name(a.pattern, i + 1, row);
        let mut reasons = Vec::new();
        let mut session = Session::default();
        open_bytes(&mut session, &template_bytes, "template")?;
        let mut filled: Vec<String> = Vec::new();

        for f in &fields {
            let key = f["key"].as_str().unwrap_or_default();
            let Some(value) = row
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            else {
                if f["required"].as_bool().unwrap_or(false) {
                    reasons.push(format!("missing_required:{key}"));
                }
                continue;
            };
            let kind = f["target"]["kind"].as_str().unwrap_or("label-right");
            let intent = if kind == "replace" {
                let Some(query) = f["target"]["query"].as_str() else {
                    reasons.push(format!("bad_target:{key}"));
                    continue;
                };
                json!({"intent":"Replace","query":query,"replacement":value,
                       "case_sensitive":false,"whole_word":false,"all":true})
            } else {
                // label-right/cell 공통 — 실행은 pin만 신뢰(결정론). pin 없는 필드는 검수 미완.
                let Some(pin) = f.get("pin").filter(|p| p.is_object()) else {
                    reasons.push(format!("unpinned:{key}"));
                    continue;
                };
                json!({"intent":"SetTableCell","section":pin["section"],"index":pin["index"],
                       "row":pin["row"],"col":pin["col"],"text":value})
            };
            match apply_intent_json(&mut session, &intent) {
                Ok(_) => filled.push(value.to_string()),
                Err(e) => reasons.push(format!("apply_failed:{key}:{e}")),
            }
        }

        // 산출 + 재개봉 검증(값 존재 + 쪽수 == 기준선) — 조용한 손상 금지.
        let bytes = export_bytes(&session)?;
        {
            let mut check = Session::default();
            open_bytes(&mut check, &bytes, "check.hwpx")?;
            let pages = page_count(&check)?;
            if pages != baseline_pages {
                reasons.push(format!("overflow:pages_{pages}_vs_{baseline_pages}"));
            }
            let text = doc_of(&check)?.plain_text();
            for v in &filled {
                // Replace 다행 값 등도 평문에 나타난다 — 셀/본문 공통의 보수적 존재 검증.
                if !text.contains(v.as_str()) {
                    reasons.push(format!("value_not_found:{v}"));
                }
            }
        }

        let ok_to_emit = reasons.is_empty() || !a.strict;
        if ok_to_emit {
            std::fs::write(a.out.join(&name), &bytes).map_err(|e| e.to_string())?;
            outputs.push((name.clone(), bytes));
        }
        reports.push(RowReport {
            name,
            created: ok_to_emit,
            reasons,
        });
    }

    // report.json + zip (report 동봉 — 제출 증적)
    let report = json!({
        "template": a.template.to_string_lossy(),
        "baselinePages": baseline_pages,
        "rows": reports.iter().map(|r| json!({
            "file": r.name, "created": r.created,
            "needsReview": !r.reasons.is_empty(), "reasons": r.reasons,
        })).collect::<Vec<_>>(),
        "created": reports.iter().filter(|r| r.created).count(),
        "skipped": reports.iter().filter(|r| !r.created).count(),
    });
    let report_text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(a.out.join("report.json"), &report_text).map_err(|e| e.to_string())?;

    let zip_path = a.out.join("output.zip");
    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zw = zip::ZipWriter::new(file);
    let opt = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in &outputs {
        zw.start_file(name.as_str(), opt)
            .map_err(|e| e.to_string())?;
        zw.write_all(bytes).map_err(|e| e.to_string())?;
    }
    zw.start_file("report.json", opt)
        .map_err(|e| e.to_string())?;
    zw.write_all(report_text.as_bytes())
        .map_err(|e| e.to_string())?;
    zw.finish().map_err(|e| e.to_string())?;

    let review = reports.iter().filter(|r| !r.reasons.is_empty()).count();
    println!(
        "fill: {}부 생성 · {}부 스킵 · 검토 필요 {}건 → {} (+report.json)",
        report["created"],
        report["skipped"],
        review,
        zip_path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_name_interpolates_index_and_korean_keys_and_sanitizes() {
        let mut row = Map::new();
        row.insert("성명".into(), Value::String("김/하나".into()));
        assert_eq!(
            render_name("{index:03d}_{성명}.hwpx", 7, &row),
            "007_김_하나.hwpx"
        );
        assert_eq!(render_name("{index}.hwpx", 12, &row), "12.hwpx");
    }

    #[test]
    fn simple_csv_parses_and_quoted_csv_is_honestly_refused() {
        let dir = std::env::temp_dir();
        let ok = dir.join("fill_test_ok.csv");
        std::fs::write(&ok, "성명,기업명\n김하나,하나테크\n이두리,두리소프트\n").unwrap();
        let rows = load_roster(&ok).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["기업명"], Value::String("두리소프트".into()));

        let bad = dir.join("fill_test_bad.csv");
        std::fs::write(&bad, "성명\n\"김,하나\"\n").unwrap();
        assert!(load_roster(&bad).unwrap_err().contains("JSON"));
    }

    #[test]
    fn csv_column_count_mismatch_is_an_error_not_silent_shift() {
        let p = std::env::temp_dir().join("fill_test_cols.csv");
        std::fs::write(&p, "a,b\n1\n").unwrap();
        assert!(load_roster(&p).unwrap_err().contains("열 수"));
    }
}
