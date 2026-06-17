//! Declarative typography style — the *separable* half of the typography subsystem.
//!
//! `CharShape`/`ParaShape` are pure inputs (HWP5 ↔ HWPX map 1:1) referenced by index
//! from runs/paragraphs (mirroring OWPML's `header.xml` dedup pools via
//! `charPrIDRef`/`paraPrIDRef`). The *layout* half (line breaking, justification,
//! kinsoku, pagination) lives in `hwp-typeset` behind the `LayoutEngine` trait.
//!
//! Field/enum names follow the HWP 5.0 / OWPML model. Bit layouts and exact value
//! ranges must be cross-checked against the official spec before freezing the binary
//! decoder (see PLAN §3.1 open risks).

use crate::types::{Color, HwpUnit};

/// The 7 per-script slots HWP carries for character formatting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptClass {
    Hangul = 0,
    Latin = 1,
    Hanja = 2,
    Japanese = 3,
    Other = 4,
    Symbol = 5,
    User = 6,
}

/// A value per script class (font face, 자간, 장평, …). HWP stores these as `[T; 7]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerScript<T>(pub [T; 7]);

impl<T: Copy + Default> Default for PerScript<T> {
    fn default() -> Self {
        PerScript([T::default(); 7])
    }
}

impl<T> PerScript<T> {
    pub fn get(&self, s: ScriptClass) -> &T {
        &self.0[s as usize]
    }
    pub fn get_mut(&mut self, s: ScriptClass) -> &mut T {
        &mut self.0[s as usize]
    }
}

impl<T: Copy> PerScript<T> {
    pub fn uniform(v: T) -> Self {
        PerScript([v; 7])
    }
}

/// 글자 모양 (character shape). All "requested" attributes are present and enumerable.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CharShape {
    /// Base size in HWPUNIT (pt*100).
    pub height: HwpUnit,
    /// Per-script font face id (into the font pool).
    pub face_id: PerScript<u16>,
    /// 장평 — character width scaling, 50–200 (%). NOTE: anisotropic advance/outline
    /// scale, NOT a synthetic point-size change (see PLAN §3.1).
    pub ratio: PerScript<u8>,
    /// 자간 — character spacing, -50–50 (%).
    pub spacing: PerScript<i8>,
    /// Relative size, 10–250 (%).
    pub rel_size: PerScript<u8>,
    /// Vertical offset, -100–100 (%).
    pub offset: PerScript<i8>,

    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    pub outline: bool,
    pub shadow: bool,
    pub emboss: bool,
    pub engrave: bool,
    pub superscript: bool,
    pub subscript: bool,
    pub use_kerning: bool,
    pub use_font_space: bool,

    pub text_color: Color,
    pub shade_color: Color,
    pub underline_color: Color,

    /// Requested font family name (e.g. "맑은 고딕"), applied to all scripts. None = inherit.
    /// Resolved to per-script `face_id`s by the serializer's font interner on export.
    pub font_family: Option<String>,

    /// Per-script font NAMES (HWP's 7 [`ScriptClass`] slots: Hangul, Latin, …), `None` = inherit the
    /// document default for that script. Empty Vec = no per-script fonts requested (the common case).
    /// Takes precedence over `font_family` on export — the serializer interns each script's font into
    /// its own `<hh:fontface lang>` pool so Hangul/Latin/Hanja keep distinct faces (not one family
    /// forced onto all scripts). Lifted from a binary `.hwp`'s per-script char-shape font ids.
    pub fonts: Vec<Option<String>>,
}

impl CharShape {
    /// True when no formatting overrides are set (maps to the document's default charPr —
    /// the serializer references the existing default rather than synthesizing a new entry).
    pub fn is_default(&self) -> bool {
        *self == CharShape::default()
    }
}

/// 정렬 — three full-width modes (배분/나눔) are NOT reducible to CSS text-align.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HorizontalAlign {
    /// 양쪽
    #[default]
    Justify,
    Left,
    Right,
    Center,
    /// 배분 — distribute incl. last line, even per-char spacing.
    Distribute,
    /// 나눔 — distribute spaces only.
    DistributeSpace,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VerticalAlign {
    #[default]
    Baseline,
    Top,
    Center,
    Bottom,
}

/// 줄 간격 mode (W3C klreq 4-model).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineSpacingType {
    /// %
    #[default]
    Percent,
    /// 고정값
    Fixed,
    /// 줄 사이 간격만
    BetweenLines,
    /// 최소
    AtLeast,
}

/// 줄나눔 기준 (Latin run).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineBreakLatin {
    /// 단어
    #[default]
    KeepWord,
    /// 하이픈
    Hyphenation,
    /// 글자
    BreakWord,
}

/// 줄나눔 기준 (non-Latin / Hangul run). Hangul never hyphenates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineBreakNonLatin {
    /// 어절
    #[default]
    KeepWord,
    /// 글자
    BreakWord,
}

/// 문단 모양 (paragraph shape).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParaShape {
    pub align: HorizontalAlign,
    pub vertical_align: VerticalAlign,

    pub line_spacing_type: LineSpacingType,
    /// Interpreted per `line_spacing_type` (e.g. 160 for 160%).
    pub line_spacing_value: i32,

    pub left_margin: HwpUnit,
    pub right_margin: HwpUnit,
    /// 들여/내어쓰기 (negative = hanging).
    pub indent: HwpUnit,
    pub space_before: HwpUnit,
    pub space_after: HwpUnit,

    pub break_latin: LineBreakLatin,
    pub break_non_latin: LineBreakNonLatin,

    pub widow_orphan: bool,
    pub keep_with_next: bool,
    pub keep_lines: bool,
    pub page_break_before: bool,

    /// 0 = none. Index into a numbering pool (filled by the parser).
    pub numbering_id: u16,
    pub border_fill_id: u16,
}

impl ParaShape {
    /// True when no overrides are set (maps to the document's default paraPr).
    pub fn is_default(&self) -> bool {
        *self == ParaShape::default()
    }
}
