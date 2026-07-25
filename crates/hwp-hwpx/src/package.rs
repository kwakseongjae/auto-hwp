//! OPC/ZIP package reading. An HWPX is a ZIP with `mimetype` first (STORED).
//!
//! HARDENING (issue #014): every inflate is **byte-counted** against
//! [`limits::MAX_DECOMPRESSED_TOTAL`] — we never trust an entry's declared `size()` (an attacker
//! forges it), so a single high-ratio deflate stream (the realistic zip bomb; the zip crate is
//! deflate-only) is stopped at the cap instead of exhausting memory. The legacy [`Package::open`] /
//! [`Package::read_part`] path is protected too (mapping the typed limit into the crate's flat
//! `Error` so the live app is safe today), while [`Package::open_guarded`] surfaces the typed
//! [`limits::DocLimit`] for the future service (013).

use hwp_ingest::limits::{self, DocLimit, HardenedError};
use hwp_model::error::{Error, Result};
use std::cell::Cell;
use std::io::{Cursor, Read};

/// A read view over an HWPX package.
pub struct Package {
    pub mimetype: Option<String>,
    pub part_names: Vec<String>,
    raw: Vec<u8>,
    /// Remaining decompression budget (bytes) shared across every part read of this package, so the
    /// cap is **cumulative** across `read_part` calls, not merely per-entry. Initialised to
    /// [`limits::MAX_DECOMPRESSED_TOTAL`]. `Cell` because `read_part` is `&self`.
    budget: Cell<u64>,
}

/// Per-part read failure, before mapping to either the legacy `Error` or the typed `HardenedError`.
enum PartError {
    /// A resource limit tripped (decompressed budget exhausted).
    Limit(DocLimit),
    /// The entry is missing / the archive is malformed / an IO error occurred mid-inflate.
    Malformed(String),
}

impl Package {
    /// Open from in-memory bytes (legacy path — used by the live app via `hwp_core::Engine`).
    /// Hardened in place: raw-size + entry-count checks, and every part read is byte-capped. Limit
    /// failures are surfaced as `Error::Parse`/`Error::Io` (the crate's flat error) so existing
    /// callers keep working; the **typed** limit lives on [`Package::open_guarded`].
    pub fn open(bytes: &[u8]) -> Result<Self> {
        limits::check_raw_size(bytes.len()).map_err(limit_to_error)?;

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| Error::Parse(format!("zip open: {e}")))?;
        // The zip crate reads the central directory eagerly in `new`, so `len()` is trustworthy here.
        limits::check_entry_count(zip.len()).map_err(limit_to_error)?;

        let mut part_names = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip
                .by_index(i)
                .map_err(|e| Error::Parse(format!("zip entry {i}: {e}")))?;
            part_names.push(f.name().to_string());
        }

        let mut budget = limits::MAX_DECOMPRESSED_TOTAL;
        let mimetype = Self::read_entry(&mut zip, "mimetype", &mut budget)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());

        Ok(Package {
            mimetype,
            part_names,
            raw: bytes.to_vec(),
            budget: Cell::new(budget),
        })
    }

    /// Hardened open for untrusted input (the service path — 013 wires it). Identical parsing to
    /// [`Package::open`] but returns the **typed** [`HardenedError`] so a caller can switch on
    /// `HardenedError::Limit(DocLimit::…)` vs `HardenedError::Malformed(_)`.
    pub fn open_guarded(bytes: &[u8]) -> std::result::Result<Self, HardenedError> {
        limits::check_raw_size(bytes.len())?;

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| HardenedError::Malformed(format!("zip open: {e}")))?;
        limits::check_entry_count(zip.len())?;

        let mut part_names = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip
                .by_index(i)
                .map_err(|e| HardenedError::Malformed(format!("zip entry {i}: {e}")))?;
            part_names.push(f.name().to_string());
        }

        let mut budget = limits::MAX_DECOMPRESSED_TOTAL;
        // mimetype is a tiny STORED entry (~19 bytes); reading it here consumes a negligible slice of
        // the budget and any malformation is tolerated (mimetype is optional in our model).
        let mimetype = Self::read_entry(&mut zip, "mimetype", &mut budget)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());

        Ok(Package {
            mimetype,
            part_names,
            raw: bytes.to_vec(),
            budget: Cell::new(budget),
        })
    }

    /// Read a single part's bytes by name (legacy path). Decrements the shared cumulative budget.
    pub fn read_part(&self, name: &str) -> Result<Vec<u8>> {
        self.read_part_inner(name).map_err(part_to_error)
    }

    /// Read a single part's bytes by name (typed path — decrements the shared cumulative budget and
    /// surfaces [`HardenedError`]).
    pub fn read_part_guarded(&self, name: &str) -> std::result::Result<Vec<u8>, HardenedError> {
        self.read_part_inner(name).map_err(part_to_hardened)
    }

    fn read_part_inner(&self, name: &str) -> std::result::Result<Vec<u8>, PartError> {
        let mut zip = zip::ZipArchive::new(Cursor::new(self.raw.clone()))
            .map_err(|e| PartError::Malformed(format!("zip reopen: {e}")))?;
        let mut budget = self.budget.get();
        let out = Self::read_entry(&mut zip, name, &mut budget);
        self.budget.set(budget);
        out
    }

    /// The header part (`Contents/header.xml`) bytes, if present — holds the charPr/paraPr pools.
    pub fn read_header(&self) -> Option<Vec<u8>> {
        let name = self.header_part_name()?;
        self.read_part(&name).ok()
    }

    /// Name of the header part (`…header.xml`), if any.
    pub fn header_part_name(&self) -> Option<String> {
        self.part_names
            .iter()
            .find(|n| n.to_ascii_lowercase().ends_with("header.xml"))
            .cloned()
    }

    /// Names of body section parts (`Contents/section*.xml`) **in document order**.
    ///
    /// 정본은 `Contents/content.hpf` 의 `<opf:spine><opf:itemref idref="section0"/>…` 순서다.
    /// manifest(`<opf:manifest>`)는 header·masterpage·image·section 을 뒤섞어 나열하므로 순서
    /// 근거가 되지 못한다. spine 이 없거나(비표준 패키지) 파싱에 실패하면 글롭 폴백으로
    /// 돌아가되 **숫자 순**으로 정렬한다 — 사전식이면 `section10.xml` 이 `section2.xml` 앞으로
    /// 와서 10섹션 이상 문서의 본문 순서가 조용히 뒤집힌다(현재 코퍼스는 최대 4섹션이라 미발현).
    ///
    /// 사용자 콘텐츠 삭제 금지: spine 이 어떤 섹션을 빠뜨렸더라도(손상/변종 패키지) 남은
    /// 섹션은 숫자 순으로 뒤에 이어 붙인다 — spine 을 신뢰하되 섹션을 버리지는 않는다.
    pub fn section_part_names(&self) -> Vec<String> {
        let globbed = self.section_parts_numeric();
        let mut ordered = self.spine_section_order(&globbed);
        for n in &globbed {
            if !ordered.iter().any(|o| o == n) {
                ordered.push(n.clone());
            }
        }
        ordered
    }

    /// Glob fallback: every `…/section*.xml` part, sorted by the NUMERIC suffix (then by name so the
    /// order is total/deterministic even for unnumbered oddities).
    fn section_parts_numeric(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .part_names
            .iter()
            .filter(|n| is_section_part(n))
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            section_index(a)
                .cmp(&section_index(b))
                .then_with(|| a.cmp(b))
        });
        v
    }

    /// Section part names in `<opf:spine>` order. Empty when there is no readable spine (→ caller
    /// falls back to the numeric glob). Non-section spine entries (`header`, `settings`, …) are
    /// skipped; an unknown `idref` is skipped rather than fabricated.
    fn spine_section_order(&self, known: &[String]) -> Vec<String> {
        let Some(hpf) = self.read_content_hpf() else {
            return Vec::new();
        };
        let href_of = manifest_hrefs(&hpf);
        let mut out = Vec::new();
        for idref in spine_itemrefs(&hpf) {
            let Some(href) = href_of.get(&idref) else {
                continue;
            };
            if !is_section_part(href) {
                continue;
            }
            // href 는 패키지 경로와 표기가 다를 수 있다(대소문자/`./` 접두). 실제 part 이름으로 정규화.
            if let Some(actual) = known
                .iter()
                .find(|n| same_part(n, href))
                .or_else(|| known.iter().find(|n| basename_eq(n, href)))
            {
                if !out.iter().any(|o: &String| o == actual) {
                    out.push(actual.clone());
                }
            }
        }
        out
    }

    /// `Contents/content.hpf` as text (the OPF package descriptor), if present/readable.
    pub(crate) fn read_content_hpf(&self) -> Option<String> {
        let name = self
            .part_names
            .iter()
            .find(|n| n.to_ascii_lowercase().ends_with("content.hpf"))?;
        let bytes = self.read_part(name).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// `…/section<N>.xml` (case-insensitive dir + extension).
fn is_section_part(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".xml")
        && lower
            .rsplit('/')
            .next()
            .map(|f| f.starts_with("section"))
            .unwrap_or(false)
}

/// The numeric suffix of a section part (`Contents/section10.xml` → 10) for numeric ordering.
/// `None` (sorts first) when the file has no digits after `section`.
fn section_index(name: &str) -> Option<u64> {
    let file = name.rsplit('/').next()?.to_ascii_lowercase();
    let digits: String = file
        .strip_prefix("section")?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn same_part(part: &str, href: &str) -> bool {
    let norm = |s: &str| {
        s.trim_start_matches("./")
            .trim_start_matches('/')
            .to_ascii_lowercase()
    };
    norm(part) == norm(href)
}

fn basename_eq(part: &str, href: &str) -> bool {
    let base = |s: &str| s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase();
    base(part) == base(href)
}

/// `<opf:item id=… href=…>` manifest → id→href. Namespace-agnostic (`opf:item` / bare `item`),
/// substring-scanned because the OPF is tiny and we only need two attributes.
pub(crate) fn manifest_hrefs(hpf: &str) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for tag in tags_named(hpf, "item") {
        if let (Some(id), Some(href)) = (tag_attr(&tag, "id"), tag_attr(&tag, "href")) {
            out.insert(id.to_string(), href.to_string());
        }
    }
    out
}

/// `<opf:spine><opf:itemref idref=…/>…` in document order.
fn spine_itemrefs(hpf: &str) -> Vec<String> {
    let Some(start) = hpf.find("<opf:spine").or_else(|| hpf.find("<spine")) else {
        return Vec::new();
    };
    let rest = &hpf[start..];
    let end = rest
        .find("</opf:spine")
        .or_else(|| rest.find("</spine"))
        .unwrap_or(rest.len());
    tags_named(&rest[..end], "itemref")
        .iter()
        .filter_map(|t| tag_attr(t, "idref").map(str::to_string))
        .collect()
}

/// Every `<[ns:]name …>` OPEN tag body in `xml`, in document order (the trailing `>` excluded).
/// Closing tags (`</…>`) are skipped, and `name` must match the WHOLE local name — so asking for
/// `item` never returns `<opf:itemref>`.
fn tags_named(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut idx = 0usize;
    while let Some(rel) = xml[idx..].find('<') {
        let start = idx + rel;
        let Some(gt) = xml[start..].find('>') else {
            break;
        };
        let tag = &xml[start..start + gt];
        idx = start + gt + 1;
        let body = &tag[1..];
        if body.starts_with('/') || body.starts_with('?') || body.starts_with('!') {
            continue; // 닫는 태그/선언/주석은 대상이 아니다
        }
        // 태그 이름은 첫 공백/`/` 앞까지 — 그 뒤(속성값)의 ':' 에 속으면 안 된다.
        let name_end = body
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(body.len());
        let qname = &body[..name_end];
        let local = qname.rsplit(':').next().unwrap_or(qname);
        if local == name {
            out.push(tag.to_string());
        }
    }
    out
}

/// First `name="…"` value inside a single XML open-tag substring.
pub(crate) fn tag_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let s = tag.find(&pat)? + pat.len();
    let e = tag[s..].find('"')? + s;
    Some(&tag[s..e])
}

impl Package {
    /// Inflate one entry, counting the **actual** decompressed bytes against `budget` (never the
    /// declared `size()`). Reads at most `budget + 1` bytes: the moment the stream would exceed the
    /// remaining budget we stop and reject, so a deflate bomb cannot allocate past the cap. `budget`
    /// is decremented by the bytes consumed so the caller can thread a cumulative total.
    fn read_entry<R: Read + std::io::Seek>(
        zip: &mut zip::ZipArchive<R>,
        name: &str,
        budget: &mut u64,
    ) -> std::result::Result<Vec<u8>, PartError> {
        let f = zip
            .by_name(name)
            .map_err(|e| PartError::Malformed(format!("zip part '{name}': {e}")))?;
        // take(budget+1): if inflation would produce more than the remaining budget, read_to_end
        // stops at budget+1 bytes and we reject — bounded memory, no OOM.
        let cap = budget.saturating_add(1);
        let mut buf = Vec::new();
        f.take(cap)
            .read_to_end(&mut buf)
            .map_err(|e| PartError::Malformed(format!("read part '{name}': {e}")))?;
        let produced = buf.len() as u64;
        if produced > *budget {
            return Err(PartError::Limit(DocLimit::DecompressedTooLarge {
                limit: limits::MAX_DECOMPRESSED_TOTAL,
            }));
        }
        *budget -= produced;
        Ok(buf)
    }
}

fn limit_to_error(l: DocLimit) -> Error {
    Error::Parse(format!("hwpx input rejected: {l}"))
}

fn part_to_error(e: PartError) -> Error {
    match e {
        PartError::Limit(l) => Error::Parse(format!("hwpx input rejected: {l}")),
        PartError::Malformed(s) => Error::Io(s),
    }
}

fn part_to_hardened(e: PartError) -> HardenedError {
    match e {
        PartError::Limit(l) => HardenedError::Limit(l),
        PartError::Malformed(s) => HardenedError::Malformed(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// 12 섹션짜리 최소 HWPX. `hpf` 가 Some 이면 그 내용으로 `Contents/content.hpf` 를 넣는다.
    /// ZIP 엔트리는 일부러 **사전식으로 정렬된** 순서로 써서, 순서가 spine 에서 오는지 글롭에서
    /// 오는지가 갈리게 한다.
    fn pkg_with_sections(hpf: Option<&str>) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("mimetype", opts).unwrap();
            zw.write_all(b"application/hwp+zip").unwrap();
            zw.start_file("Contents/header.xml", opts).unwrap();
            zw.write_all(b"<hh:head/>").unwrap();
            let mut names: Vec<String> = (0..12)
                .map(|i| format!("Contents/section{i}.xml"))
                .collect();
            names.sort(); // 사전식: section0, section1, section10, section11, section2, …
            for n in &names {
                zw.start_file(n.as_str(), opts).unwrap();
                zw.write_all(b"<hs:sec/>").unwrap();
            }
            if let Some(h) = hpf {
                zw.start_file("Contents/content.hpf", opts).unwrap();
                zw.write_all(h.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    fn spine_hpf(order: &[usize]) -> String {
        let items: String = (0..12)
            .map(|i| {
                format!(
                    r#"<opf:item id="section{i}" href="Contents/section{i}.xml" media-type="application/xml"/>"#
                )
            })
            .collect();
        let refs: String = order
            .iter()
            .map(|i| format!(r#"<opf:itemref idref="section{i}" linear="yes"/>"#))
            .collect();
        format!(
            r#"<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>{items}<opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/>{refs}</opf:spine></opf:package>"#
        )
    }

    fn idx(names: &[String]) -> Vec<usize> {
        names
            .iter()
            .filter_map(|n| section_index(n))
            .map(|n| n as usize)
            .collect()
    }

    #[test]
    fn section_order_follows_the_content_hpf_spine() {
        // 정본은 spine 순서 — 사전식(0,1,10,11,2,…)도, 숫자순(0,1,2,…)도 아닌 순서를 넣어
        // "우연히 맞은 것"이 아님을 잠근다.
        let order: Vec<usize> = vec![3, 0, 11, 7, 1, 2, 10, 4, 5, 6, 8, 9];
        let bytes = pkg_with_sections(Some(&spine_hpf(&order)));
        let pkg = Package::open(&bytes).unwrap();
        assert_eq!(idx(&pkg.section_part_names()), order);
    }

    #[test]
    fn spineless_package_falls_back_to_numeric_not_lexicographic_order() {
        // 폴백이 사전식이면 section10 이 section2 앞에 온다 = 10섹션+ 문서가 조용히 뒤집힌다.
        let bytes = pkg_with_sections(None);
        let pkg = Package::open(&bytes).unwrap();
        assert_eq!(idx(&pkg.section_part_names()), (0..12).collect::<Vec<_>>());
    }

    #[test]
    fn spine_omitting_a_section_still_keeps_it() {
        // 사용자 콘텐츠 삭제 금지: spine 에 빠진 섹션은 버리지 않고 뒤에 숫자순으로 붙인다.
        let bytes = pkg_with_sections(Some(&spine_hpf(&[5, 4, 3])));
        let pkg = Package::open(&bytes).unwrap();
        let got = idx(&pkg.section_part_names());
        assert_eq!(&got[..3], &[5, 4, 3]);
        assert_eq!(got.len(), 12, "누락 섹션이 사라졌다: {got:?}");
        let mut rest = got[3..].to_vec();
        let sorted = rest.clone();
        rest.sort();
        assert_eq!(rest, sorted, "잔여 섹션은 숫자순이어야 한다: {got:?}");
    }

    #[test]
    fn tags_named_matches_whole_local_name_and_skips_close_tags() {
        let xml = r#"<opf:manifest><opf:item id="a" href="x"/></opf:manifest><opf:spine><opf:itemref idref="a"/></opf:spine>"#;
        assert_eq!(
            tags_named(xml, "item").len(),
            1,
            "itemref 를 item 으로 오인"
        );
        assert_eq!(tags_named(xml, "itemref").len(), 1);
        assert_eq!(tags_named(xml, "manifest").len(), 1, "</manifest> 를 셌다");
    }
}
