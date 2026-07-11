//! Real text shaper behind [`FontMetricsProvider`] — a rustybuzz (pure-Rust HarfBuzz port)
//! glyph-advance path plus real font metrics (ascent/descent/line-gap) from an embedded/system
//! font. Enabled by the `shaper` Cargo feature; the DEFAULT build keeps [`crate::ApproxFontMetrics`]
//! (no `rustybuzz`/`ttf-parser` deps, network-safe).
//!
//! STATUS (P2 increment): real per-glyph advances (Hangul ≈ 1 EM, Latin proportional from the
//! actual font) scaled to HWPUNIT, real vertical metrics, and 자간/장평 advance scaling from the
//! [`CharShape`] via [`RealFontMetrics::advance_scaled`]. NOT YET: cluster/ligature-aware line
//! breaking (we shape per-char so the greedy breaker keeps its current contract), 금칙 (kinsoku),
//! 배분/나눔 justification — those layer on this seam (see lib.rs TODOs).

use std::cell::RefCell;
use std::collections::HashMap;

use hwp_model::prelude::*;

use crate::is_full_width;

/// System font candidates probed at runtime, Korean-capable first. The first that parses wins; if
/// none is present we fall back to the per-script approximation (so this never panics headless/CI).
/// We deliberately prefer a FULL-EM Korean face (AppleGothic packs Hangul at exactly 1 EM, like
/// Hancom's 전각 grid) over the tighter proportional AppleSDGothicNeo (~0.865 EM) — Hancom lays
/// Hangul out on the EM grid regardless of the glyph's own advance, so a full-EM face keeps our
/// line breaks aligned with Hancom's. (The EM-grid snap below makes the choice robust either way.)
const FONT_CANDIDATES: &[(&str, u32)] = &[
    // Vendored FREE font (OFL) — the preferred face so the own-render uses ONE consistent, bundled,
    // redistributable family for BOTH metrics and drawing (NanumGothic carries Hangul AND Latin, so
    // the drawn glyph shapes match these metrics exactly — no AppleGothic-shape fallback). Lives at
    // the workspace-root assets/fonts so every crate resolves the same file.
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ),
        0,
    ),
    // macOS — Korean-capable system faces (the .ttc needs a face index).
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0),
    ("/System/Library/Fonts/Supplemental/AppleMyungjo.ttf", 0),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
    // Linux — Noto / Nanum, if installed or vendored.
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    (
        "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
        0,
    ),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", 0),
    // Vendored fallback (drop a Noto Sans KR here to make CI deterministic).
    (
        concat!(env!("CARGO_MANIFEST_DIR"), "/assets/NotoSansKR-Regular.ttf"),
        0,
    ),
];

/// Proportional Latin/serif faces probed for Latin/digit/punctuation glyphs. The Korean system face
/// (AppleGothic etc.) packs Latin too wide — '(Solution)' overflows a narrow cell — because it lays
/// Latin on a near-full-width grid. A real proportional Latin face gives the tight advances Hancom
/// uses for the default Latin font (a Times/serif family in most gov-docs). Probed Korean-first slot
/// is empty → we use the Korean face for Latin (the old behavior), so this never regresses headless.
const LATIN_FONT_CANDIDATES: &[(&str, u32)] = &[
    // Same vendored NanumGothic — its Latin is PROPORTIONAL (tight 'i', wide 'W'), so Latin metrics
    // come from the SAME face we draw with (positions match the drawn glyphs, no Times/NanumGothic
    // split). This is the whole point of bundling one consistent free font for the own-render.
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ),
        0,
    ),
    // macOS — Hancom's default Latin face in most gov-docs is a serif (Times-like); Helvetica is the
    // common sans fallback. Either is far tighter than AppleGothic's Latin.
    ("/System/Library/Fonts/Supplemental/Times New Roman.ttf", 0),
    ("/System/Library/Fonts/Times.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 0),
    // Linux — Liberation Serif/Sans (metric-compatible with Times/Arial), then DejaVu.
    (
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        0,
    ),
    (
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        0,
    ),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
];

/// Real font metrics in font units, normalized to the EM (`units_per_em`). Advances/line metrics
/// scale by `size_hwpunit` at query time so one loaded face serves every point size.
struct LoadedFont {
    /// Owned font bytes — kept alive for the lifetime of `face`/`shape_face` (self-referential).
    _data: Box<[u8]>,
    /// ttf-parser face for metrics (ascent/descent/line-gap), `'static` over `_data`.
    face: ttf_parser::Face<'static>,
    /// rustybuzz face for shaping advances, `'static` over `_data`.
    shape_face: rustybuzz::Face<'static>,
    units_per_em: f64,
    path: String,
}

impl LoadedFont {
    /// Load the first parseable candidate; `None` if no Korean-capable font is on this machine.
    fn discover() -> Option<LoadedFont> {
        Self::discover_from(FONT_CANDIDATES)
    }

    /// Load the first parseable candidate from `candidates` (shared by the Korean + Latin slots).
    fn discover_from(candidates: &[(&str, u32)]) -> Option<LoadedFont> {
        for &(path, index) in candidates {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if let Some(f) =
                LoadedFont::from_bytes(bytes.into_boxed_slice(), index, path.to_string())
            {
                return Some(f);
            }
        }
        None
    }

    /// Build a self-referential face over owned bytes. SAFETY: `face`/`shape_face` borrow `_data`,
    /// which is boxed (stable heap address) and never mutated/moved out while they live; we extend
    /// the borrow to `'static` and keep `_data` in the same struct so it outlives both faces.
    fn from_bytes(data: Box<[u8]>, index: u32, path: String) -> Option<LoadedFont> {
        let slice: &'static [u8] = unsafe { std::slice::from_raw_parts(data.as_ptr(), data.len()) };
        let face = ttf_parser::Face::parse(slice, index).ok()?;
        let shape_face = rustybuzz::Face::from_slice(slice, index)?;
        let units_per_em = face.units_per_em() as f64;
        if units_per_em <= 0.0 {
            return None;
        }
        Some(LoadedFont {
            _data: data,
            face,
            shape_face,
            units_per_em,
            path,
        })
    }

    /// Real advance of a single glyph in font units (HarfBuzz-shaped). Falls back to ttf-parser's
    /// nominal advance, then 0 if the glyph is absent.
    fn raw_advance(&self, ch: char) -> f64 {
        let mut buf = rustybuzz::UnicodeBuffer::new();
        buf.push_str(ch.encode_utf8(&mut [0u8; 4]));
        let glyphs = rustybuzz::shape(&self.shape_face, &[], buf);
        let pos = glyphs.glyph_positions();
        if pos.is_empty() {
            return 0.0;
        }
        pos.iter().map(|p| p.x_advance as f64).sum()
    }
}

/// rustybuzz/ttf-parser-backed [`FontMetricsProvider`]. Caches per-`(char, size)` advances so the
/// greedy line-breaker (which queries the same glyphs repeatedly) stays cheap. When no Korean font
/// is present it transparently falls back to the per-script approximation — same numbers as
/// [`crate::ApproxFontMetrics`] — so the default contract is never violated.
pub struct RealFontMetrics {
    /// Korean/CJK face — Hangul/Hanja/Japanese + the no-Latin-font fallback for Latin too.
    font: Option<LoadedFont>,
    /// Proportional Latin/serif face for Latin/digit/punctuation. `None` → route Latin to `font`
    /// (the old single-face behavior), so a machine without a Latin face is never worse than before.
    latin: Option<LoadedFont>,
    /// (char, size_hwpunit) → advance HWPUNIT. RefCell: the trait method is `&self`.
    cache: RefCell<HashMap<(char, i32), f64>>,
}

impl Default for RealFontMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl RealFontMetrics {
    /// Discover a system/embedded Korean font and build the shaper. Always succeeds — falls back to
    /// the per-script approximation if no font is found (check [`RealFontMetrics::is_real`]).
    pub fn new() -> RealFontMetrics {
        RealFontMetrics {
            font: LoadedFont::discover(),
            latin: LoadedFont::discover_from(LATIN_FONT_CANDIDATES),
            cache: RefCell::new(HashMap::new()),
        }
    }

    /// Build the shaper from CALLER-INJECTED font bytes — the wasm/web path where `std::fs` has no
    /// fonts to discover (issue 022: metric injection, mirroring 018's PDF byte-injection). The SAME
    /// injected face backs BOTH the Korean/CJK slot and the Latin slot (`latin: None` routes Latin to
    /// `font` — NanumGothic and every catalog OFL face carry Latin too), so ONE injected TTF/OTF
    /// drives every glyph. This is byte-for-byte equivalent to [`RealFontMetrics::new`] when the same
    /// NanumGothic-Regular.ttf is injected as the native discover path finds (both slots resolve to the
    /// same bytes → identical advances). Bytes that don't parse fall back to the per-script
    /// approximation (never panics). TTF/OTF single-face only (face index 0); a TTC isn't accepted.
    pub fn from_bytes(bytes: &[u8]) -> RealFontMetrics {
        let font = LoadedFont::from_bytes(
            bytes.to_vec().into_boxed_slice(),
            0,
            "<injected>".to_string(),
        );
        RealFontMetrics {
            font,
            latin: None,
            cache: RefCell::new(HashMap::new()),
        }
    }

    /// True when a real font backs the metrics (a Korean-capable face was found). False = the
    /// approximate fallback is active (no font on this machine / CI).
    pub fn is_real(&self) -> bool {
        self.font.is_some()
    }

    /// Path of the loaded font, or `None` when falling back to approximate metrics. Diagnostics.
    pub fn font_path(&self) -> Option<&str> {
        self.font.as_ref().map(|f| f.path.as_str())
    }

    /// Path of the loaded proportional Latin face, or `None` when Latin routes to the Korean face
    /// (no separate Latin font present). Diagnostics.
    pub fn latin_font_path(&self) -> Option<&str> {
        self.latin.as_ref().map(|f| f.path.as_str())
    }

    /// Real vertical metrics in HWPUNIT for a line at `size_hwpunit`: (ascent, descent, line_gap).
    /// Scaled from the font's `units_per_em`. Falls back to Hancom's 850/150/0 split if no font.
    /// Retained for a future Fixed/Minimum (고정/최소) line-spacing floor — Percent spacing (the common
    /// case) multiplies the bare EM, so `line_height` no longer consults the leading.
    #[allow(dead_code)]
    pub fn vmetrics(&self, size_hwpunit: i32) -> (f64, f64, f64) {
        let em = size_hwpunit.max(1) as f64;
        match &self.font {
            Some(f) => {
                let s = em / f.units_per_em;
                (
                    f.face.ascender() as f64 * s,
                    (-f.face.descender() as f64) * s,
                    f.face.line_gap() as f64 * s,
                )
            }
            // Hancom convention: baseline at 0.85 of the EM (see BASELINE_RATIO).
            None => (em * 0.85, em * 0.15, 0.0),
        }
    }

    /// Base advance (no 자간/장평) in HWPUNIT — the [`FontMetricsProvider`] contract value.
    fn base_advance(&self, ch: char, size_hwpunit: i32) -> f64 {
        let em = size_hwpunit.max(1) as f64;
        let key = (ch, size_hwpunit);
        if let Some(&v) = self.cache.borrow().get(&key) {
            return v;
        }
        let adv = match &self.font {
            // Full-width glyphs (Hangul/CJK/fullwidth, 전각) snap to the 1-EM grid: Hancom spaces
            // them on the EM grid regardless of the font's own (often tighter) advance, so snapping
            // keeps our line breaks aligned with Hancom's.
            Some(_) if is_full_width(ch) => em,
            // Proportional glyphs (Latin/digit/punct) get the REAL HarfBuzz-shaped advance from the
            // PROPORTIONAL LATIN face when present (Times/Helvetica/Liberation) — the Korean face
            // packs Latin too wide (overflows narrow cells). The Latin face falls back to the Korean
            // face, then the per-script approximation, so an absent glyph never collapses to zero.
            Some(kor) => {
                let latin = self.latin.as_ref().unwrap_or(kor);
                let raw = latin.raw_advance(ch);
                if raw > 0.0 {
                    raw / latin.units_per_em * em
                } else if self.latin.is_some() {
                    // Glyph absent in the Latin face — try the Korean face before approximating.
                    let kraw = kor.raw_advance(ch);
                    if kraw > 0.0 {
                        kraw / kor.units_per_em * em
                    } else {
                        approx_advance(ch, em)
                    }
                } else {
                    approx_advance(ch, em)
                }
            }
            None => approx_advance(ch, em),
        };
        self.cache.borrow_mut().insert(key, adv);
        adv
    }

    /// Advance in HWPUNIT with 자간/장평 from the [`CharShape`] applied (the layout engine's job per
    /// the trait doc). 장평 (`ratio`, 50–200%) scales the glyph box; 자간 (`spacing`, −50–50%) adds a
    /// per-glyph gap as a fraction of the EM. `script` picks the per-script slot; default = Hangul.
    pub fn advance_scaled(&self, ch: char, size_hwpunit: i32, cs: &CharShape) -> f64 {
        let script = script_of(ch);
        let base = self.base_advance(ch, size_hwpunit);
        // 0 = unset → 100% (no scaling); otherwise clamp to HWP's 50–200% range. Remap BEFORE the
        // clamp so a default (0) shape is full-width, not clamped up to the 50% floor.
        let ratio = match *cs.ratio.get(script) {
            0 => 100,
            r => r.clamp(MIN_RATIO, MAX_RATIO),
        } as f64
            / 100.0;
        let spacing = (*cs.spacing.get(script)).clamp(MIN_SPACING, MAX_SPACING) as f64 / 100.0;
        let em = size_hwpunit.max(1) as f64;
        base * ratio + spacing * em
    }
}

/// 장평 clamp (HWP: 50–200%).
const MIN_RATIO: u8 = 50;
const MAX_RATIO: u8 = 200;
/// 자간 clamp (HWP: −50–50%).
const MIN_SPACING: i8 = -50;
const MAX_SPACING: i8 = 50;

/// Per-script approximation (mirrors [`crate::ApproxFontMetrics`]): full-width ≈ 1 EM, half-width
/// ≈ 0.5 EM, space ≈ 0.3 EM. Used as the no-font fallback and for glyphs absent from the face.
fn approx_advance(ch: char, em: f64) -> f64 {
    if ch == ' ' || ch == '\t' {
        em * 0.3
    } else if is_full_width(ch) {
        em
    } else {
        em * 0.5
    }
}

/// Coarse Unicode → [`ScriptClass`] mapping for picking the per-script 자간/장평 slot. Good enough
/// for advance scaling; a full BCP-47/Unicode script run-splitter is a follow-up.
fn script_of(ch: char) -> ScriptClass {
    let c = ch as u32;
    match c {
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xD7B0..=0xD7FF => {
            ScriptClass::Hangul
        }
        0x2E80..=0x2FDF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => ScriptClass::Hanja,
        0x3040..=0x30FF => ScriptClass::Japanese,
        0x0000..=0x024F => ScriptClass::Latin,
        _ => ScriptClass::Other,
    }
}

impl FontMetricsProvider for RealFontMetrics {
    fn advance_width(&self, _font: &FontKey, ch: char, size_hwpunit: i32) -> f64 {
        self.base_advance(ch, size_hwpunit)
    }

    /// Real line height from the Korean face's vertical metrics (ascent + descent + line_gap),
    /// scaled to `size_hwpunit`. A line's natural box is the CJK face's leading (it dominates a
    /// mixed Korean line). Falls back to the flat EM (default trait impl semantics) with no font, so
    /// headless/CI matches the approximation exactly. Clamped to ≥ 1 EM so a tight face never makes
    /// rows SHORTER than the historical baseline (which would only worsen the too-tight pagination).
    fn line_height(&self, size_hwpunit: i32) -> f64 {
        // HWP percent line spacing (줄간격 N%) multiplies the EM (font size), NOT the font leading:
        // Hancom's measured real per-line advance = N% × EM (rhwp LineSeg vertical_pos confirms 1.60 for
        // 160% on BOTH benchmarks). Returning the leading (asc+desc+gap ≈ 1.25em) here made the advance
        // (line_height × ratio) ≈ 1.25em×1.6 = 1.92em — ~25% too tall, the dominant table over-reservation.
        // Bare EM matches Hancom + ApproxFontMetrics. (The font leading is not applied to Percent spacing;
        // a Fixed/Minimum-spacing floor can be reintroduced per-type later if needed.)
        size_hwpunit.max(1) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_panics_and_advances_are_positive() {
        let m = RealFontMetrics::new();
        // Whether a real font is found (dev mac) or not (bare CI), advances must be sane.
        for ch in ['가', '한', '漢', 'a', '1', '!', ' '] {
            let a = m.advance_width(
                &FontKey {
                    family: String::new(),
                    bold: false,
                    italic: false,
                },
                ch,
                1000,
            );
            assert!(a >= 0.0, "advance for {ch:?} must be non-negative, got {a}");
        }
        // A non-space, in-font glyph always advances something.
        let g = m.advance_width(
            &FontKey {
                family: String::new(),
                bold: false,
                italic: false,
            },
            '가',
            1000,
        );
        assert!(g > 0.0, "Hangul must advance, got {g}");
    }

    #[test]
    fn fallback_matches_approx_when_no_font() {
        // Force the no-font path by constructing a fallback-only provider.
        let m = RealFontMetrics {
            font: None,
            latin: None,
            cache: RefCell::new(HashMap::new()),
        };
        let f = FontKey {
            family: String::new(),
            bold: false,
            italic: false,
        };
        assert_eq!(m.advance_width(&f, '가', 1000), 1000.0);
        assert_eq!(m.advance_width(&f, 'a', 1000), 500.0);
        assert_eq!(m.advance_width(&f, ' ', 1000), 300.0);
    }

    #[test]
    fn hangul_is_full_em_in_a_real_font() {
        let m = RealFontMetrics::new();
        if !m.is_real() {
            eprintln!("skip: no Korean system font on this machine");
            return;
        }
        // Korean faces space Hangul on a full EM grid — the real advance must be ~1 EM (±2%).
        let a = m.advance_width(
            &FontKey {
                family: String::new(),
                bold: false,
                italic: false,
            },
            '한',
            1000,
        );
        assert!(
            (a - 1000.0).abs() < 20.0,
            "Hangul advance should be ~1 EM, got {a}"
        );
    }

    #[test]
    fn jangpyeong_scales_advance() {
        let m = RealFontMetrics::new();
        let mut cs = CharShape::default();
        let base = m.advance_scaled('가', 1000, &cs);
        // 장평 200% doubles the glyph box; 자간 0.
        for s in cs.ratio.0.iter_mut() {
            *s = 200;
        }
        let wide = m.advance_scaled('가', 1000, &cs);
        assert!(
            (wide - base * 2.0).abs() < 1.0,
            "장평200% should double advance: {base} → {wide}"
        );
    }

    #[test]
    fn jagan_adds_per_glyph_gap() {
        let m = RealFontMetrics::new();
        let mut cs = CharShape::default();
        let base = m.advance_scaled('가', 1000, &cs);
        for s in cs.spacing.0.iter_mut() {
            *s = 50; // +50% EM
        }
        let spaced = m.advance_scaled('가', 1000, &cs);
        assert!(
            (spaced - (base + 500.0)).abs() < 1.0,
            "자간+50% adds 0.5 EM: {base} → {spaced}"
        );
    }

    #[test]
    fn vmetrics_are_ordered() {
        let m = RealFontMetrics::new();
        let (asc, desc, gap) = m.vmetrics(1000);
        assert!(asc > 0.0 && desc >= 0.0 && gap >= 0.0);
        // ascent + descent should be near one EM (Korean faces run a touch over).
        assert!(
            asc + desc >= 900.0 && asc + desc <= 1400.0,
            "asc {asc} + desc {desc} ~ EM"
        );
    }

    #[test]
    fn line_height_is_bare_em_for_percent_spacing() {
        // HWP 줄간격 N% multiplies the EM, NOT the font leading. So line_height returns the bare EM
        // (per-line advance = line_height × ratio = EM × N%, matching Hancom's measured 1.60 for 160%).
        // Using the leading here double-counted it (~25% over-tall rows). vmetrics() is retained for a
        // future Fixed/Minimum-spacing floor but no longer drives the Percent-spacing line box.
        let m = RealFontMetrics::new();
        assert_eq!(
            m.line_height(1000),
            1000.0,
            "line height = bare EM (percent spacing scales the EM)"
        );
        assert_eq!(m.line_height(1200), 1200.0);
    }

    #[test]
    fn from_bytes_injection_matches_native_discover() {
        // Inject the SAME vendored NanumGothic the native discover path finds. The metric injection
        // (wasm/web path) must produce byte-for-byte identical advances to `new()` — that equivalence
        // is what makes the cross-golden (wasm vs native --features shaper) hold.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        );
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("skip: vendored NanumGothic not present");
            return;
        };
        let injected = RealFontMetrics::from_bytes(&bytes);
        assert!(
            injected.is_real(),
            "injected NanumGothic must back real metrics"
        );
        let native = RealFontMetrics::new();
        if !(native.is_real()
            && native
                .font_path()
                .map(|p| p.ends_with("NanumGothic-Regular.ttf"))
                .unwrap_or(false))
        {
            eprintln!("skip: native discover didn't resolve the vendored NanumGothic");
            return;
        }
        let f = FontKey {
            family: String::new(),
            bold: false,
            italic: false,
        };
        // Hangul (EM-grid), Latin (proportional), digit, punctuation — the full advance surface.
        for ch in ['한', '가', 'A', 'i', 'W', '1', '.', '(', ')'] {
            for size in [1000, 1200, 900] {
                let a = injected.advance_width(&f, ch, size);
                let b = native.advance_width(&f, ch, size);
                assert!(
                    (a - b).abs() < 1e-9,
                    "injected vs native advance for {ch:?}@{size}: {a} vs {b}"
                );
            }
        }
    }

    #[test]
    fn from_bytes_garbage_falls_back_to_approx() {
        // Unparseable bytes → approximate fallback (never panics), same numbers as ApproxFontMetrics.
        let m = RealFontMetrics::from_bytes(&[0, 1, 2, 3, 4]);
        assert!(!m.is_real(), "garbage bytes must NOT back a real font");
        let f = FontKey {
            family: String::new(),
            bold: false,
            italic: false,
        };
        assert_eq!(m.advance_width(&f, '가', 1000), 1000.0);
        assert_eq!(m.advance_width(&f, 'a', 1000), 500.0);
    }

    #[test]
    fn latin_uses_proportional_face_when_present() {
        let m = RealFontMetrics::new();
        // Only meaningful when BOTH a Korean and a separate Latin face are present (dev mac).
        if !(m.is_real() && m.latin_font_path().is_some()) {
            eprintln!("skip: need both a Korean and a separate Latin font");
            return;
        }
        let f = FontKey {
            family: String::new(),
            bold: false,
            italic: false,
        };
        // A proportional Latin 'i' is FAR narrower than an 'W' — a Korean face packing Latin
        // near-full-width would make them nearly equal. The proportional face keeps the ratio wide.
        let i = m.advance_width(&f, 'i', 1000);
        let w = m.advance_width(&f, 'W', 1000);
        assert!(i > 0.0 && w > 0.0, "both Latin glyphs advance");
        assert!(w > i * 2.0, "proportional Latin: 'W' ≫ 'i' ({w} vs {i})");
        // And Latin stays well under the full-width EM (the overflow bug was Latin ≈ 1 EM).
        assert!(i < 700.0, "proportional 'i' is narrow, got {i}");
    }
}
