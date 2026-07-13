//! Format detection by magic bytes. Pure & wasm-clean (no zip/xml deps here).

/// Untrusted-input hardening: shared resource-limit constants + typed [`limits::DocLimit`] errors
/// + boundary predicates + the (un-wired) layout guard. See the module docs. (issue #014)
pub mod limits;

use hwp_model::types::SourceFormat;

/// OLE2 / Compound File Binary magic.
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
/// ZIP local file header magic.
const ZIP_MAGIC: [u8; 4] = [b'P', b'K', 0x03, 0x04];
/// PDF magic (`%PDF-`). A real PDF may have leading junk before this; we scan a small window.
const PDF_MAGIC: &[u8] = b"%PDF-";
/// HWPX OPC signature (the `mimetype` entry's content).
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";
/// HWPX package marker: every HWPX carries a `Contents/header.xml` part (the charPr/paraPr pools the
/// parser reads). Like any ZIP entry NAME it is stored uncompressed in both the local header and the
/// central directory, so it appears in the clear even when the `mimetype` entry itself is deflated —
/// the fallback the compressed-`mimetype` fast-path miss relies on (issue #065). Same clear-name
/// technique as [`DOCX_MARKER`]; crucially it needs NO inflation, so `detect` stays pure & wasm-clean
/// with zero zip-bomb surface (the #014 decompression caps live in the parse path, not here).
const HWPX_PART_MARKER: &[u8] = b"Contents/header.xml";
/// DOCX (OOXML) marker: the package always contains a `word/document.xml` main part, whose name
/// appears in the clear in the ZIP's central directory / local headers.
const DOCX_MARKER: &[u8] = b"word/document.xml";

/// Detect the source format from the leading bytes.
///
/// - CFB → `Hwp5` (HWP3 vs HWP5 is refined later by reading the FileHeader stream).
/// - ZIP whose `mimetype` is `application/hwp+zip`, OR which contains a `Contents/header.xml`
///   part → `Hwpx` (the latter catches packages whose `mimetype` entry is deflated).
/// - ZIP that references `word/document.xml` → `Docx` (OOXML word-processing).
/// - `%PDF-` (within the first 1 KiB) → `Pdf`.
/// - otherwise → `Unknown`.
pub fn detect(bytes: &[u8]) -> SourceFormat {
    if bytes.len() >= CFB_MAGIC.len() && bytes[..CFB_MAGIC.len()] == CFB_MAGIC {
        return SourceFormat::Hwp5;
    }
    if bytes.len() >= ZIP_MAGIC.len() && bytes[..ZIP_MAGIC.len()] == ZIP_MAGIC {
        // Fast path: the OPC spec RECOMMENDS the `mimetype` entry be first and STORED
        // (uncompressed), so its literal content bytes appear in the clear near the start.
        if window_contains(&bytes[..bytes.len().min(512)], HWPX_MIMETYPE) {
            return SourceFormat::Hwpx;
        }
        // Fallback (issue #065): real-world writers (독스헌터 / Hancom 계열) DEFLATE the `mimetype`
        // entry — it is only RECOMMENDED, not required, to be STORED — so its literal content never
        // appears in the clear and the fast path misses (6/24 real files were rejected). But the ZIP
        // central directory stores every entry NAME uncompressed, so the required `Contents/header.xml`
        // part name is present verbatim even when its data (and the mimetype) is deflated. This is the
        // same clear-name technique the DOCX branch uses, and it needs NO inflation — so detection
        // stays pure & wasm-clean and adds no zip-bomb surface (the #014 decompression caps guard the
        // parse path). Scan the whole buffer: the central directory is at the END of the file.
        if window_contains(bytes, HWPX_PART_MARKER) {
            return SourceFormat::Hwpx;
        }
        // OOXML stores entry NAMES uncompressed in both local headers and the central directory,
        // so `word/document.xml` appears verbatim somewhere in the archive even if its data is
        // deflated. Scan the whole buffer (the central directory is at the END of the file).
        if window_contains(bytes, DOCX_MARKER) {
            return SourceFormat::Docx;
        }
        return SourceFormat::Unknown; // some other zip
    }
    // PDFs occasionally carry a few leading bytes before `%PDF-`; tolerate a small prefix.
    if window_contains(&bytes[..bytes.len().min(1024)], PDF_MAGIC) {
        return SourceFormat::Pdf;
    }
    SourceFormat::Unknown
}

fn window_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfb_is_hwp5() {
        let mut b = CFB_MAGIC.to_vec();
        b.extend_from_slice(&[0u8; 16]);
        assert_eq!(detect(&b), SourceFormat::Hwp5);
    }

    #[test]
    fn zip_with_mimetype_is_hwpx() {
        let mut b = ZIP_MAGIC.to_vec();
        b.extend_from_slice(b"....mimetypeapplication/hwp+zip....");
        assert_eq!(detect(&b), SourceFormat::Hwpx);
    }

    #[test]
    fn plain_zip_is_unknown() {
        let mut b = ZIP_MAGIC.to_vec();
        b.extend_from_slice(b"....just a normal zip....");
        assert_eq!(detect(&b), SourceFormat::Unknown);
    }

    #[test]
    fn zip_with_compressed_mimetype_is_hwpx_via_part_name() {
        // Simulates a package whose `mimetype` entry is DEFLATE'd (issue #065): the literal
        // `application/hwp+zip` never appears in the clear, but the `Contents/header.xml` entry
        // NAME does (ZIP central directory keeps names uncompressed). The fallback must classify
        // it as HWPX. We pad past the 512-byte fast-path window to prove the fallback scans the
        // whole buffer (the central directory lives at the END of a real archive).
        let mut b = ZIP_MAGIC.to_vec();
        b.extend_from_slice(&[0x5a; 1024]); // opaque deflate-looking payload, no literal mimetype
        b.extend_from_slice(b"PK\x01\x02........Contents/header.xml"); // central-dir-style name
        assert!(
            !window_contains(&b[..b.len().min(512)], HWPX_MIMETYPE),
            "guard: literal mimetype must be absent from the fast-path window"
        );
        assert_eq!(detect(&b), SourceFormat::Hwpx);
    }

    #[test]
    fn hwpx_part_name_wins_over_docx_and_beats_512_window() {
        // A pure HWPX carries `Contents/header.xml` but never `word/document.xml`, so the DOCX
        // branch can't steal it; and the marker sits well past byte 512.
        let mut b = ZIP_MAGIC.to_vec();
        b.extend_from_slice(&[0u8; 700]);
        b.extend_from_slice(b"Contents/header.xml");
        assert_eq!(detect(&b), SourceFormat::Hwpx);
    }

    #[test]
    fn zip_with_word_document_is_docx() {
        let mut b = ZIP_MAGIC.to_vec();
        b.extend_from_slice(b"...[Content_Types].xml...word/document.xml...");
        assert_eq!(detect(&b), SourceFormat::Docx);
    }

    #[test]
    fn pdf_magic_is_pdf() {
        assert_eq!(detect(b"%PDF-1.7\n%...."), SourceFormat::Pdf);
    }

    #[test]
    fn pdf_with_leading_junk_is_pdf() {
        let mut b = vec![0u8; 4];
        b.extend_from_slice(b"%PDF-1.4 rest");
        assert_eq!(detect(&b), SourceFormat::Pdf);
    }

    #[test]
    fn garbage_is_unknown() {
        assert_eq!(detect(b"hello"), SourceFormat::Unknown);
    }
}
