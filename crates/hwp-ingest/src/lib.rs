//! Format detection by magic bytes. Pure & wasm-clean (no zip/xml deps here).

use hwp_model::types::SourceFormat;

/// OLE2 / Compound File Binary magic.
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
/// ZIP local file header magic.
const ZIP_MAGIC: [u8; 4] = [b'P', b'K', 0x03, 0x04];
/// PDF magic (`%PDF-`). A real PDF may have leading junk before this; we scan a small window.
const PDF_MAGIC: &[u8] = b"%PDF-";
/// HWPX OPC signature (the `mimetype` entry's content).
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";
/// DOCX (OOXML) marker: the package always contains a `word/document.xml` main part, whose name
/// appears in the clear in the ZIP's central directory / local headers.
const DOCX_MARKER: &[u8] = b"word/document.xml";

/// Detect the source format from the leading bytes.
///
/// - CFB → `Hwp5` (HWP3 vs HWP5 is refined later by reading the FileHeader stream).
/// - ZIP whose `mimetype` is `application/hwp+zip` → `Hwpx`.
/// - ZIP that references `word/document.xml` → `Docx` (OOXML word-processing).
/// - `%PDF-` (within the first 1 KiB) → `Pdf`.
/// - otherwise → `Unknown`.
pub fn detect(bytes: &[u8]) -> SourceFormat {
    if bytes.len() >= CFB_MAGIC.len() && bytes[..CFB_MAGIC.len()] == CFB_MAGIC {
        return SourceFormat::Hwp5;
    }
    if bytes.len() >= ZIP_MAGIC.len() && bytes[..ZIP_MAGIC.len()] == ZIP_MAGIC {
        // The OPC `mimetype` is the first, STORED (uncompressed) entry, so its literal
        // content bytes appear in the clear near the start of the archive.
        if window_contains(&bytes[..bytes.len().min(512)], HWPX_MIMETYPE) {
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
