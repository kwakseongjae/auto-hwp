//! Font fidelity mapping (issue 058): document face name → typographic category → bundled OFL
//! substitute family. This is the classification LAYER — a pure, wasm-safe, `&str`-in `enum`/`&'static
//! str`-out function with no font bytes, no I/O. The renderers consume it:
//!   • own-render (`place::paragraph_glyphs`) stamps the substitute family onto each `PlacedGlyph.font`
//!     so the SVG `font-family` (and the PDF glyph face selection) routes 명조 runs to a serif face and
//!     고딕 runs to the default gothic — the "전 문서가 단일 NanumGothic" fix.
//!   • the React screen (`packages/react/src/fonts.ts`) mirrors these names to bind the matching
//!     `@font-face`, so screen == PDF.
//!
//! ## Why substitute, not the real face
//! 함초롬바탕/함초롬돋움 and the Hancom bundle are **redistribution-forbidden** (`docs/LICENSE-POLICY.md`
//! R8) — we must not embed them. We route to **OFL** stand-ins that a host may serve/inject legally:
//! 명조(serif) → Nanum Myeongjo (a static OFL 나눔명조 — krilla/PDF-subset-friendly and matched to the
//! bundled NanumGothic), 고딕/기타 → the bundled NanumGothic (a 나눔고딕, already the universal default).
//! A user MAY upload their own 함초롬 (their own copy is not redistribution) — that path registers the
//! face by its own name and bypasses substitution.
//!
//! ## Gate safety (V5)
//! This maps DISPLAY only — the glyph advances the layout engine breaks/paginates on are UNCHANGED
//! (the metric provider stays family-blind; Hangul snaps to the EM grid regardless of face). So the
//! `layout-check` page-count gate (benchmark 8==8 · benchmark1 18==18) is untouched by this module.

/// A document face's typographic category, inferred from its name. Drives the OFL substitute pick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FontCategory {
    /// 명조/바탕 계열 — serif (바탕, 명조, Batang, Myeongjo, 궁서, Times, …).
    Serif,
    /// 돋움/고딕 계열 — sans (돋움, 고딕, 굴림, Dotum, Gulim, Gothic, 맑은 고딕, Arial, …).
    Gothic,
    /// Unknown — fall back to the default gothic face (treated like 고딕 for substitution).
    Other,
}

/// The OFL substitute family a 명조/serif document face routes to. MUST match the family name the
/// React catalog (`FONT_CATALOG`) registers and the PDF host injects, so screen == PDF == this token.
pub const SERIF_SUBSTITUTE: &str = "Nanum Myeongjo";

/// The default (bundled) gothic face — 고딕/기타 route here. This is the universal fallback the SVG
/// already falls through to (`font-family="…, NanumGothic, sans-serif"`), so 고딕 runs emit NO explicit
/// substitute (keeping their rendering — and golden bytes — identical to before 058).
pub const GOTHIC_DEFAULT: &str = "NanumGothic";

/// Classify a document font NAME into a [`FontCategory`] by Korean/Latin naming convention. Substring,
/// case-insensitive for Latin. Deliberately conservative: an unrecognized name is [`FontCategory::Other`]
/// (→ the default gothic), never a wrong serif. Most gov-docs name faces 함초롬바탕(명조)/함초롬돋움(고딕).
pub fn classify(name: &str) -> FontCategory {
    let n = name.trim();
    if n.is_empty() {
        return FontCategory::Other;
    }
    // Korean substrings (compared on the raw string — Hangul is case-invariant).
    // Serif markers: 바탕/명조/궁서(고전 serif). 순명조/신명(조) are common HY/Sandoll serif families.
    const SERIF_KO: &[&str] = &["바탕", "명조", "궁서", "순명조", "신명"];
    const GOTHIC_KO: &[&str] = &["돋움", "돋음", "고딕", "굴림", "돋보임", "그래픽", "안상수"];
    for k in SERIF_KO {
        if n.contains(k) {
            return FontCategory::Serif;
        }
    }
    for k in GOTHIC_KO {
        if n.contains(k) {
            return FontCategory::Gothic;
        }
    }
    // Latin markers (lowercased).
    let l = n.to_ascii_lowercase();
    const SERIF_EN: &[&str] = &[
        "batang", "myeongjo", "myungjo", "gungsuh", "gungseo", "serif", "times", "georgia",
        "garamond", "minion",
    ];
    const GOTHIC_EN: &[&str] = &[
        "dotum",
        "gulim",
        "gothic",
        "sans",
        "malgun",
        "arial",
        "helvetica",
        "verdana",
        "tahoma",
        "pretendard",
        "nanum gothic",
        "nanumgothic",
    ];
    for k in SERIF_EN {
        if l.contains(k) {
            return FontCategory::Serif;
        }
    }
    for k in GOTHIC_EN {
        if l.contains(k) {
            return FontCategory::Gothic;
        }
    }
    FontCategory::Other
}

/// Classify a face by its HWP5 FaceName PANOSE (`typeInfo`, 10 bytes) when it is DEFINITIVE. The two
/// load-bearing bytes are PANOSE-1 `Family Kind` (byte 0) and `Serif Style` (byte 1): only the Latin
/// Text family (kind 2) carries a meaningful serif style, where 2..=10 are serif designs (Cove … Triangle)
/// and 11..=15 are the sans-serif designs (Normal/Obtuse/Perpendicular Sans, Flared, Rounded). Everything
/// else — an `Any`/`No Fit` family (kind 0/1, the all-zero PANOSE that unset faces carry), a script /
/// decorative / symbol family (3/4/5), or an `Any`/`No Fit` serif style — is indeterminate → `None`, so
/// the caller falls back to the NAME heuristic. This never guesses serif vs sans from thin evidence.
pub fn classify_panose(panose: &[u8; 10]) -> Option<FontCategory> {
    // PANOSE-1: only Family Kind 2 (Latin Text) defines a serif style; other kinds leave byte 1 unused.
    if panose[0] != 2 {
        return None;
    }
    match panose[1] {
        2..=10 => Some(FontCategory::Serif),
        11..=15 => Some(FontCategory::Gothic),
        _ => None, // 0 = Any, 1 = No Fit → indeterminate.
    }
}

/// Resolve a document face name to the OFL substitute FAMILY the renderers should draw with, or `None`
/// when the name already maps to the default gothic (고딕/기타 → NanumGothic, the universal fallback —
/// returning `None` keeps those runs byte-identical to pre-058). Only 명조/serif faces get an explicit
/// substitute ([`SERIF_SUBSTITUTE`]). The returned name is a `&'static str` so callers never allocate
/// unless they need an owned copy.
pub fn substitute_family(name: &str) -> Option<&'static str> {
    match classify(name) {
        FontCategory::Serif => Some(SERIF_SUBSTITUTE),
        FontCategory::Gothic | FontCategory::Other => None,
    }
}

/// Like [`substitute_family`], but prefers the face's PANOSE (`typeInfo`) hint over the name heuristic
/// (issue 058 classified by name alone). A DEFINITIVE PANOSE wins — so a face whose NAME hides its style
/// (a custom/vendor family the substring table doesn't recognize) still routes 명조→serif / 고딕→default
/// correctly from its typographic metadata; an indeterminate or absent PANOSE falls back to the
/// name-based [`substitute_family`]. Display only (058's metric invariant is untouched).
pub fn substitute_family_with_panose(
    name: &str,
    panose: Option<&[u8; 10]>,
) -> Option<&'static str> {
    match panose.and_then(classify_panose) {
        Some(FontCategory::Serif) => Some(SERIF_SUBSTITUTE),
        Some(_) => None, // definitive gothic → default face (no explicit substitute).
        None => substitute_family(name), // indeterminate/absent PANOSE → name heuristic.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn korean_serif_names_classify_serif() {
        for n in ["함초롬바탕", "바탕", "신명조", "HY명조", "궁서체", "순명조"] {
            assert_eq!(classify(n), FontCategory::Serif, "{n} should be serif");
        }
    }

    #[test]
    fn korean_gothic_names_classify_gothic() {
        for n in [
            "함초롬돋움",
            "돋움",
            "굴림체",
            "맑은 고딕",
            "HY견고딕",
            "나눔고딕",
        ] {
            assert_eq!(classify(n), FontCategory::Gothic, "{n} should be gothic");
        }
    }

    #[test]
    fn latin_names_classify_by_family() {
        assert_eq!(classify("Batang"), FontCategory::Serif);
        assert_eq!(classify("Times New Roman"), FontCategory::Serif);
        assert_eq!(classify("Noto Serif KR"), FontCategory::Serif);
        assert_eq!(classify("Nanum Myeongjo"), FontCategory::Serif);
        assert_eq!(classify("Malgun Gothic"), FontCategory::Gothic);
        assert_eq!(classify("Arial"), FontCategory::Gothic);
        assert_eq!(classify("Pretendard"), FontCategory::Gothic);
    }

    #[test]
    fn unknown_and_empty_are_other() {
        assert_eq!(classify(""), FontCategory::Other);
        assert_eq!(classify("   "), FontCategory::Other);
        assert_eq!(classify("Wingdings"), FontCategory::Other);
        assert_eq!(classify("맑은지붕"), FontCategory::Other);
    }

    #[test]
    fn substitute_routes_serif_only() {
        assert_eq!(substitute_family("함초롬바탕"), Some(SERIF_SUBSTITUTE));
        assert_eq!(substitute_family("바탕"), Some("Nanum Myeongjo"));
        // 고딕/기타 → default gothic (None = no explicit substitute → NanumGothic fallback).
        assert_eq!(substitute_family("함초롬돋움"), None);
        assert_eq!(substitute_family("맑은 고딕"), None);
        assert_eq!(substitute_family("Unknown"), None);
        assert_eq!(substitute_family(""), None);
    }

    #[test]
    fn panose_latin_text_serif_style_classifies() {
        // Family Kind 2 (Latin Text): serif styles 2..=10 → Serif.
        for style in 2..=10u8 {
            let mut p = [0u8; 10];
            p[0] = 2;
            p[1] = style;
            assert_eq!(
                classify_panose(&p),
                Some(FontCategory::Serif),
                "kind=2 serif_style={style} should be serif"
            );
        }
        // 11..=15 (the sans designs) → Gothic.
        for style in 11..=15u8 {
            let mut p = [0u8; 10];
            p[0] = 2;
            p[1] = style;
            assert_eq!(
                classify_panose(&p),
                Some(FontCategory::Gothic),
                "kind=2 serif_style={style} should be gothic"
            );
        }
    }

    #[test]
    fn panose_indeterminate_is_none() {
        // All-zero PANOSE (the unset case) → None (name fallback).
        assert_eq!(classify_panose(&[0; 10]), None);
        // Any/No Fit serif style under Latin Text → None.
        assert_eq!(classify_panose(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]), None);
        assert_eq!(classify_panose(&[2, 1, 0, 0, 0, 0, 0, 0, 0, 0]), None);
        // Non-Latin-Text families (script/decorative/symbol) → None regardless of byte 1.
        for kind in [0u8, 1, 3, 4, 5] {
            assert_eq!(classify_panose(&[kind, 8, 0, 0, 0, 0, 0, 0, 0, 0]), None);
        }
        // The rhwp parser test's real sample: [2, 11, 6, ...] = Latin Text + Normal Sans → Gothic.
        assert_eq!(
            classify_panose(&[2, 11, 6, 0, 0, 1, 1, 1, 1, 1]),
            Some(FontCategory::Gothic)
        );
    }

    #[test]
    fn panose_hint_overrides_name_heuristic() {
        // A face the NAME table can't classify ("MyCustomFace" → Other → no substitute)…
        assert_eq!(substitute_family("MyCustomFace"), None);
        // …but whose PANOSE says serif (kind 2, style 3 = Obtuse Cove) → routes to the serif substitute.
        let serif_panose = [2u8, 3, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(
            substitute_family_with_panose("MyCustomFace", Some(&serif_panose)),
            Some(SERIF_SUBSTITUTE),
            "definitive serif PANOSE beats an unrecognized name"
        );
        // A sans PANOSE (kind 2, style 11) keeps the default gothic even for an unknown name.
        let sans_panose = [2u8, 11, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(
            substitute_family_with_panose("MyCustomFace", Some(&sans_panose)),
            None
        );
        // An indeterminate/absent PANOSE falls back to the name heuristic (058 behavior preserved).
        assert_eq!(
            substitute_family_with_panose("함초롬바탕", Some(&[0; 10])),
            Some(SERIF_SUBSTITUTE),
            "all-zero PANOSE → name heuristic still classifies 바탕 as serif"
        );
        assert_eq!(
            substitute_family_with_panose("함초롬바탕", None),
            Some(SERIF_SUBSTITUTE)
        );
        // PANOSE can also CORRECT a name that would misclassify: a sans face oddly named "…명조" but with
        // a definitive sans PANOSE draws with the default gothic, not the serif substitute.
        assert_eq!(
            substitute_family_with_panose("웹명조고딕", Some(&sans_panose)),
            None,
            "definitive sans PANOSE overrides a serif-looking name"
        );
    }
}
