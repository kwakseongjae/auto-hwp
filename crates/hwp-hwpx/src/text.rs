//! `<hp:t>` text extraction from HWPX section parts. A real, runnable Phase-0 demo
//! (and the seed of the structure-preserving AST→text projection used for AI/RAG).

use crate::package::Package;
use hwp_model::error::Result;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

/// Extract document text from an HWPX byte buffer, one paragraph per line.
pub fn extract_text(bytes: &[u8]) -> Result<String> {
    let pkg = Package::open(bytes)?;
    let mut out = String::new();
    for name in pkg.section_part_names() {
        let xml = pkg.read_part(&name)?;
        let s = String::from_utf8_lossy(&xml);
        extract_section_text(&s, &mut out);
    }
    Ok(out)
}

fn extract_section_text(xml: &str, out: &mut String) {
    let mut reader = Reader::from_str(xml);
    let mut in_t = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"t" => in_t = true,
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(e)) if in_t => {
                if let Ok(t) = e.unescape() {
                    out.push_str(&t);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
}
