//! Format detection by magic bytes. Pure & wasm-clean (no zip/xml deps here).

use hwp_model::types::SourceFormat;

/// OLE2 / Compound File Binary magic.
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
/// ZIP local file header magic.
const ZIP_MAGIC: [u8; 4] = [b'P', b'K', 0x03, 0x04];
/// HWPX OPC signature (the `mimetype` entry's content).
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";

/// Detect the source format from the leading bytes.
///
/// - CFB → `Hwp5` (HWP3 vs HWP5 is refined later by reading the FileHeader stream).
/// - ZIP whose `mimetype` is `application/hwp+zip` → `Hwpx`.
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
        return SourceFormat::Unknown; // some other zip
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
    fn garbage_is_unknown() {
        assert_eq!(detect(b"hello"), SourceFormat::Unknown);
    }
}
