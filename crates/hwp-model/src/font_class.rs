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
}
