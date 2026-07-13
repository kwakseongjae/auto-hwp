//! Minimal, dependency-free BMP → RGBA8 decoder for the PDF export path (feature `pdf`).
//!
//! krilla ships no `from_bmp`, so before this a BMP image drew an empty stub box in the exported PDF
//! even though the SVG sink embeds it as `data:image/bmp` (a WebView renders BMP natively). This closes
//! that parity gap by decoding the common **uncompressed** BMP variants HWP actually embeds into raw
//! RGBA8, which the caller hands to [`krilla::image::Image::from_rgba8`]:
//!   • BITMAPINFOHEADER-family DIBs (header size ≥ 40, incl. V2–V5 supersets),
//!   • 24 bpp (BGR) and 32 bpp (BGRA/BGRX) `BI_RGB`, plus 32 bpp `BI_BITFIELDS` with the standard
//!     little-endian B,G,R byte order (the only layout seen in the wild),
//!   • 8 bpp indexed (palette), and 1/4 bpp indexed.
//!
//! Anything we can't decode faithfully — RLE compression, a 12-byte BITMAPCOREHEADER, JPEG/PNG-in-BMP,
//! a truncated/inconsistent file — returns `None`, so the caller keeps the honest stub-box fallback
//! instead of drawing garbage. Everything is bounds-checked; no input can panic the decoder.

/// Cap the decoded pixel count so a corrupt header can't request a multi-gigabyte allocation. 64M px
/// (≈256 MB RGBA) is far above any real embedded raster yet bounds the worst case.
const MAX_PIXELS: u64 = 64 * 1024 * 1024;

/// Decode an uncompressed BMP into `(rgba8, width, height)` with 4 bytes/pixel, row-major, top-down
/// (the layout [`krilla::image::Image::from_rgba8`] expects). `None` for any unsupported or malformed
/// input → the caller draws a stub box (parity with the pre-BMP-embed behavior).
pub fn decode_bmp_to_rgba8(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    // BITMAPFILEHEADER (14 bytes) + at least a BITMAPINFOHEADER (40 bytes).
    if bytes.len() < 54 || &bytes[0..2] != b"BM" {
        return None;
    }
    let pixel_offset = read_u32(bytes, 10)? as usize;
    let dib_size = read_u32(bytes, 14)? as usize;
    // Only the BITMAPINFOHEADER family (≥ 40); its width/height/bpp/compression fields sit at fixed
    // offsets shared by every V2–V5 superset. The 12-byte BITMAPCOREHEADER uses a different layout → skip.
    if dib_size < 40 {
        return None;
    }

    let width = read_i32(bytes, 18)?;
    let height_raw = read_i32(bytes, 22)?;
    let planes = read_u16(bytes, 26)?;
    let bpp = read_u16(bytes, 28)?;
    let compression = read_u32(bytes, 30)?;
    let clr_used = read_u32(bytes, 46)?;

    if planes != 1 || width <= 0 || height_raw == 0 {
        return None;
    }
    // A negative height means the rows are stored top-down; positive is the usual bottom-up.
    let top_down = height_raw < 0;
    let width = width as u32;
    let height = height_raw.unsigned_abs();

    if (width as u64) * (height as u64) > MAX_PIXELS {
        return None;
    }

    // Accept BI_RGB (0) and BI_BITFIELDS (3, 32 bpp only, standard BGRA order). Decline RLE/JPEG/PNG.
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    match (bpp, compression) {
        (24, BI_RGB) | (32, BI_RGB) | (32, BI_BITFIELDS) => {
            decode_true_color(bytes, pixel_offset, width, height, bpp, top_down)
        }
        (1, BI_RGB) | (4, BI_RGB) | (8, BI_RGB) => decode_indexed(
            bytes,
            pixel_offset,
            dib_size,
            clr_used,
            width,
            height,
            bpp,
            top_down,
        ),
        _ => None,
    }
}

/// 24/32 bpp true-color rows. Bytes are little-endian B,G,R(,X); alpha is forced opaque because the
/// `BI_RGB` 4th byte is undefined and real HWP BMPs don't carry straight alpha (avoids a fully
/// transparent image when the X byte happens to be 0).
fn decode_true_color(
    bytes: &[u8],
    pixel_offset: usize,
    width: u32,
    height: u32,
    bpp: u16,
    top_down: bool,
) -> Option<(Vec<u8>, u32, u32)> {
    let bytes_per_px = (bpp / 8) as usize;
    let row_size = row_stride(width, bpp)?;
    let mut out = vec![
        0u8;
        (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)?
    ];

    for y in 0..height {
        let src_y = if top_down { y } else { height - 1 - y };
        let row_start = pixel_offset.checked_add((src_y as usize).checked_mul(row_size)?)?;
        for x in 0..width as usize {
            let p = row_start.checked_add(x * bytes_per_px)?;
            let b = *bytes.get(p)?;
            let g = *bytes.get(p + 1)?;
            let r = *bytes.get(p + 2)?;
            let o = ((y as usize) * width as usize + x) * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = 255;
        }
    }
    Some((out, width, height))
}

/// 1/4/8 bpp indexed rows resolved through the palette (4-byte B,G,R,reserved entries that follow the
/// DIB header). Palette indices out of range map to black (defensive, never panics).
#[allow(clippy::too_many_arguments)]
fn decode_indexed(
    bytes: &[u8],
    pixel_offset: usize,
    dib_size: usize,
    clr_used: u32,
    width: u32,
    height: u32,
    bpp: u16,
    top_down: bool,
) -> Option<(Vec<u8>, u32, u32)> {
    let palette_start = 14usize.checked_add(dib_size)?;
    let max_colors = 1usize << bpp; // 2 / 16 / 256
    let n_colors = if clr_used == 0 {
        max_colors
    } else {
        (clr_used as usize).min(max_colors)
    };
    // Each palette entry is 4 bytes (BGRA/BGRX); the table must fit before the pixel data.
    let palette_end = palette_start.checked_add(n_colors.checked_mul(4)?)?;
    if palette_end > bytes.len() {
        return None;
    }
    let palette = &bytes[palette_start..palette_end];

    let row_size = row_stride(width, bpp)?;
    let mut out = vec![
        0u8;
        (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)?
    ];

    for y in 0..height {
        let src_y = if top_down { y } else { height - 1 - y };
        let row_start = pixel_offset.checked_add((src_y as usize).checked_mul(row_size)?)?;
        for x in 0..width as usize {
            let idx = read_index(bytes, row_start, x, bpp)?;
            let (r, g, b) = palette_rgb(palette, idx, n_colors);
            let o = ((y as usize) * width as usize + x) * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = 255;
        }
    }
    Some((out, width, height))
}

/// The palette index for pixel `x` on a row starting at `row_start`, unpacking sub-byte 1/4 bpp packing
/// (MSB-first, as BMP stores it). Returns `None` if the byte is past the buffer.
fn read_index(bytes: &[u8], row_start: usize, x: usize, bpp: u16) -> Option<usize> {
    match bpp {
        8 => Some(*bytes.get(row_start + x)? as usize),
        4 => {
            let byte = *bytes.get(row_start + x / 2)?;
            let nibble = if x.is_multiple_of(2) {
                byte >> 4
            } else {
                byte & 0x0F
            };
            Some(nibble as usize)
        }
        1 => {
            let byte = *bytes.get(row_start + x / 8)?;
            let bit = 7 - (x % 8);
            Some(((byte >> bit) & 1) as usize)
        }
        _ => None,
    }
}

/// Look up an `(R, G, B)` from a 4-byte-per-entry BGRX palette; out-of-range → black.
fn palette_rgb(palette: &[u8], idx: usize, n_colors: usize) -> (u8, u8, u8) {
    if idx >= n_colors {
        return (0, 0, 0);
    }
    let p = idx * 4;
    match (palette.get(p), palette.get(p + 1), palette.get(p + 2)) {
        (Some(&b), Some(&g), Some(&r)) => (r, g, b),
        _ => (0, 0, 0),
    }
}

/// 4-byte-aligned row stride in bytes for a `bpp`-deep, `width`-wide row (BMP pads every row to a
/// 32-bit boundary).
fn row_stride(width: u32, bpp: u16) -> Option<usize> {
    let bits = (width as u64).checked_mul(bpp as u64)?;
    Some((bits.div_ceil(32) * 4) as usize)
}

fn read_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}
fn read_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}
fn read_i32(b: &[u8], off: usize) -> Option<i32> {
    read_u32(b, off).map(|v| v as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal BITMAPFILEHEADER + BITMAPINFOHEADER around raw pixel rows.
    fn bmp(
        width: i32,
        height: i32,
        bpp: u16,
        compression: u32,
        palette: &[[u8; 4]],
        rows: &[u8],
    ) -> Vec<u8> {
        let dib_size = 40usize;
        let palette_bytes = palette.len() * 4;
        let pixel_offset = 14 + dib_size + palette_bytes;
        let mut v = Vec::new();
        v.extend_from_slice(b"BM");
        let file_size = (pixel_offset + rows.len()) as u32;
        v.extend_from_slice(&file_size.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes()); // reserved
        v.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
        // BITMAPINFOHEADER
        v.extend_from_slice(&(dib_size as u32).to_le_bytes());
        v.extend_from_slice(&width.to_le_bytes());
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // planes
        v.extend_from_slice(&bpp.to_le_bytes());
        v.extend_from_slice(&compression.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes()); // image size
        v.extend_from_slice(&2835i32.to_le_bytes()); // x ppm
        v.extend_from_slice(&2835i32.to_le_bytes()); // y ppm
        v.extend_from_slice(&(palette.len() as u32).to_le_bytes()); // clr used
        v.extend_from_slice(&0u32.to_le_bytes()); // clr important
        for c in palette {
            v.extend_from_slice(c);
        }
        v.extend_from_slice(rows);
        v
    }

    #[test]
    fn decodes_24bpp_bottom_up() {
        // 2x2, bottom-up. BMP stores the BOTTOM row first. Rows padded to 4 bytes (2px*3B = 6 → 8).
        // Bottom row: red, green. Top row: blue, white.
        let bottom = [0, 0, 255, /*R*/ 0, 255, 0, /*G*/ 0, 0]; // pad to 8
        let top = [255, 0, 0, /*B*/ 255, 255, 255, /*W*/ 0, 0];
        let mut rows = Vec::new();
        rows.extend_from_slice(&bottom);
        rows.extend_from_slice(&top);
        let data = bmp(2, 2, 24, 0, &[], &rows);
        let (rgba, w, h) = decode_bmp_to_rgba8(&data).expect("24bpp decodes");
        assert_eq!((w, h), (2, 2));
        // Output is top-down: first pixel = top-left = blue.
        assert_eq!(&rgba[0..4], &[0, 0, 255, 255], "top-left blue");
        assert_eq!(&rgba[4..8], &[255, 255, 255, 255], "top-right white");
        assert_eq!(&rgba[8..12], &[255, 0, 0, 255], "bottom-left red");
        assert_eq!(&rgba[12..16], &[0, 255, 0, 255], "bottom-right green");
    }

    #[test]
    fn decodes_32bpp_top_down_forces_opaque() {
        // 1x2 top-down (negative height). BGRX; the X byte is 0 but alpha must come out opaque.
        let rows = [
            10, 20, 30, 0, /*px0 BGR*/ 40, 50, 60, 0, /*px1 BGR*/
        ];
        let data = bmp(1, -2, 32, 0, &[], &rows);
        let (rgba, w, h) = decode_bmp_to_rgba8(&data).expect("32bpp decodes");
        assert_eq!((w, h), (1, 2));
        assert_eq!(&rgba[0..4], &[30, 20, 10, 255], "px0 R,G,B opaque");
        assert_eq!(&rgba[4..8], &[60, 50, 40, 255], "px1 R,G,B opaque");
    }

    #[test]
    fn decodes_8bpp_indexed() {
        // 2x1, one row (2 bytes → padded to 4). Palette: idx0 = red, idx1 = green (BGRX).
        let palette = [[0, 0, 255, 0], [0, 255, 0, 0]];
        let rows = [0u8, 1, 0, 0]; // idx0, idx1, pad
        let data = bmp(2, 1, 8, 0, &palette, &rows);
        let (rgba, w, h) = decode_bmp_to_rgba8(&data).expect("8bpp decodes");
        assert_eq!((w, h), (2, 1));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255], "idx0 red");
        assert_eq!(&rgba[4..8], &[0, 255, 0, 255], "idx1 green");
    }

    #[test]
    fn rejects_non_bmp_and_truncated() {
        assert!(decode_bmp_to_rgba8(b"").is_none());
        assert!(decode_bmp_to_rgba8(b"not a bmp at all........").is_none());
        // "BM" but far too short for the headers.
        assert!(decode_bmp_to_rgba8(b"BM\x00\x00").is_none());
    }

    #[test]
    fn rejects_rle_compression() {
        // 8bpp declared with RLE8 (compression = 1) → declined (honest stub fallback).
        let palette = [[0, 0, 0, 0]];
        let data = bmp(2, 1, 8, 1, &palette, &[0, 0, 0, 0]);
        assert!(decode_bmp_to_rgba8(&data).is_none());
    }
}
