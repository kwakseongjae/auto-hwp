//! Typography / layout engine — the separable "(B) layout" half of the typography subsystem.
//!
//! Pure function: (paragraphs + resolved char/para shapes + page setup + injected font metrics) →
//! line segments + pagination. This is THE production critical path (PLAN §3.1, GUI memory seam #1):
//! it gates faithful in-app rendering, our own `linesegarray` emission (so rhwp/Hancom paginate our
//! converted .hwpx correctly), and the WYSIWYG caret (screen↔doc coordinate mapping).
//!
//! STATUS: a real greedy line-breaker + vertical-accumulation paginator. The DEFAULT build runs on
//! per-script APPROXIMATE metrics ([`ApproxFontMetrics`]); the `shaper` feature swaps in a real
//! rustybuzz (pure-Rust HarfBuzz) advance/metrics path ([`shaper::RealFontMetrics`]) with 자간/장평
//! scaling from the [`CharShape`]. NOT YET: Korean 금칙 (kinsoku), 배분/나눔 justification,
//! cluster-aware line breaking, vertical text. Those layer on this skeleton.

use hwp_model::prelude::*;

#[cfg(feature = "shaper")]
pub mod shaper;
#[cfg(feature = "shaper")]
pub use shaper::RealFontMetrics;

/// Hanyang-PUA 옛한글 → 첫가끝 자모 매핑 (이슈 062-2, KTUG Public Domain 표). 텍스트 처리 지점
/// (`subst_glyph` 측정 프록시 + `place::paragraph_glyphs` 그리기 확장)에서 소비된다.
mod old_hangul;

/// Content-free differential diagnostics for two already-positioned documents. This never replaces
/// layout or rendering; it only classifies evidence produced by the shared typesetter.
pub mod diagnostic;
pub use diagnostic::{
    compare_placed_docs, GeometryDeltaSummary, PagePlacementDelta, PlacedDocDeltaReport,
};

/// Positioned layout (glyphs/images/boxes per page) — the paint-IR bridge consumed by `hwp-render`.
pub mod place;
pub use place::{
    block_pages, cell_caret_rect, cell_caret_rect_path, cell_text_hit, column_offsets, place_doc,
    row_offsets, BlockKind, CellAddr, CellCaretRect, CellTextHit, PlacedBlock, PlacedCell,
    PlacedDoc, PlacedGlyph, PlacedImage, PlacedPage, PlacedRect, PlacedTable,
};

/// Half the EM for half-width glyphs.
const HALF: f64 = 0.5;
/// Space advance as a fraction of the EM.
const SPACE: f64 = 0.3;
/// Default line advance as a fraction of the line's max glyph size (≈ 160% line spacing) when a
/// paragraph carries no explicit percent line spacing.
const DEFAULT_LINESPACE: f64 = 1.6;
/// Baseline as a fraction of the line height (matches Hancom's 850/1000 convention).
pub(crate) const BASELINE_RATIO: f64 = 0.85;
/// Stored HWPX lineseg caches are untrusted hints, never authority to manufacture unbounded pages.
/// Real public fixtures need single digits; this ceiling is intentionally generous and fail-closed.
const MAX_SOURCE_CELL_PAGE_SEGMENTS: usize = 256;

/// 본문 상자(HWPUNIT) — `(원점_x, 원점_y, 너비, 높이)`. **쪽수 계산의 단일 진실**이라
/// `NaiveLayout`·`place_doc`·`block_pages` 셋이 전부 이걸 거쳐야 LOCKSTEP 이 깨지지 않는다.
///
/// 왜 별도 함수인가(이슈 074): 한컴의 본문 상자는 `여백 top/bottom` 만으로 정해지지 않는다.
/// **머리말/꼬리말 여백은 위/아래 여백에 더해지고, 제본 여백은 왼쪽 여백에 더해진다**
/// (한컴 도움말 = rhwp `PageAreas::from_page_def_for_page`: `content_top = margin_header +
/// margin_top`, `content_bottom = height − margin_footer − margin_bottom`). 이 셋을 빼먹으면
/// 본문이 실제보다 길어져 페이지를 덜 넘긴다 — benchmark1 기준 본문 높이 77103 vs 실제 71435
/// (+7.9%), benchmark1.hwpx 는 77103 vs 68599 (+12.4%) 였고 그만큼 쪽수가 모자랐다.
///
/// 한컴 실측 대조(benchmark1.hwp): 한컴이 저장한 `<hp:lineseg>` 의 최대 세로 위치가 71891 로
/// **71435 짜리 본문 상자에 맞고 77103 에는 한참 못 미친다** — 즉 71435 가 한컴이 실제로 쓴
/// 본문 높이다.
/// Paper size used for layout/paint. HWP5 stores unswapped A4 + `landscape=true`;
/// rhwp swaps at render (`PageAreas::from_page_def_for_page`). OWPML likewise stores
/// short/long paper edges plus a separate NARROWLY/WIDELY orientation token, so we
/// swap only when the landscape flag is set and the stored box is still portrait.
pub fn display_paper(page: &PageSetup) -> (i32, i32) {
    if page.landscape && page.width < page.height {
        (page.height, page.width)
    } else {
        (page.width, page.height)
    }
}

pub fn body_box(page: &PageSetup) -> (f64, f64, f64, f64) {
    let (pw, ph) = display_paper(page);
    let left = page.margin_left + page.margin_gutter.max(0);
    let top = page.margin_top + page.margin_header.max(0);
    let bottom = page.margin_bottom + page.margin_footer.max(0);
    let w = (pw - left - page.margin_right).max(1) as f64;
    let h = (ph - top - bottom).max(1) as f64;
    (left as f64, top as f64, w, h)
}

/// One column body box relative to the section body's left edge. Returned in **flow order**; an RTL
/// layout therefore yields the physically rightmost box first while every `x` remains page-relative.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColumnBox {
    pub x: f64,
    pub width: f64,
}

/// Resolve source-neutral absolute column geometry against the actual body width. The empty/default
/// layout is exactly the historic single-column body. Invalid editor-created geometry degrades to a
/// single bounded column; strict file parsers reject it before it reaches this defensive layer.
pub fn column_boxes(layout: &ColumnLayout, body_w: f64) -> Vec<ColumnBox> {
    if layout.widths.is_empty()
        || layout.widths.iter().any(|width| *width <= 0)
        || layout.gaps.len() + 1 != layout.widths.len()
        || layout.gaps.iter().any(|gap| *gap < 0)
    {
        return vec![ColumnBox {
            x: 0.0,
            width: body_w.max(1.0),
        }];
    }

    let raw_total = layout.widths.iter().map(|value| *value as f64).sum::<f64>()
        + layout.gaps.iter().map(|value| *value as f64).sum::<f64>();
    if raw_total <= 0.0 {
        return vec![ColumnBox {
            x: 0.0,
            width: body_w.max(1.0),
        }];
    }
    // Small integer-rounding residue is absorbed by the same scale as a defensive over-wide input;
    // this guarantees the final box cannot escape the body right edge.
    let scale = body_w.max(1.0) / raw_total;
    let mut x = 0.0;
    let mut boxes = Vec::with_capacity(layout.widths.len());
    for (index, width) in layout.widths.iter().enumerate() {
        let width = *width as f64 * scale;
        boxes.push(ColumnBox { x, width });
        if let Some(gap) = layout.gaps.get(index) {
            x += width + *gap as f64 * scale;
        }
    }
    if layout.direction == ColumnDirection::RightToLeft {
        boxes.reverse();
    }
    boxes
}

/// Shared vertical/column cursor used by all three pagination paths. Keeping transitions here makes
/// page-count LOCKSTEP structural instead of relying on three hand-copied interpretations.
#[derive(Clone, Debug)]
pub(crate) struct ColumnFlow {
    boxes: Vec<ColumnBox>,
    column: usize,
    zone_top: f64,
    vert: f64,
    max_vert: f64,
}

impl ColumnFlow {
    pub(crate) fn new(body_w: f64) -> Self {
        Self {
            boxes: column_boxes(&ColumnLayout::default(), body_w),
            column: 0,
            zone_top: 0.0,
            vert: 0.0,
            max_vert: 0.0,
        }
    }

    pub(crate) fn box_now(&self) -> ColumnBox {
        self.boxes[self.column]
    }

    pub(crate) fn column_index(&self) -> usize {
        self.column
    }

    pub(crate) fn min_width(&self) -> f64 {
        self.boxes
            .iter()
            .map(|column| column.width)
            .fold(f64::INFINITY, f64::min)
            .max(1.0)
    }

    pub(crate) fn y(&self) -> f64 {
        self.zone_top + self.vert
    }

    pub(crate) fn vert(&self) -> f64 {
        self.vert
    }

    pub(crate) fn add(&mut self, value: f64) {
        self.vert += value;
        self.max_vert = self.max_vert.max(self.vert);
    }

    pub(crate) fn available_height(&self, body_h: f64) -> f64 {
        (body_h - self.zone_top).max(1.0)
    }

    /// Advance to the next flow column. Returns true when the caller must create a fresh page.
    pub(crate) fn advance_column(&mut self) -> bool {
        self.max_vert = self.max_vert.max(self.vert);
        if self.column + 1 < self.boxes.len() {
            self.column += 1;
            self.vert = 0.0;
            false
        } else {
            self.reset_page();
            true
        }
    }

    pub(crate) fn reset_page(&mut self) {
        self.column = 0;
        self.zone_top = 0.0;
        self.vert = 0.0;
        self.max_vert = 0.0;
    }

    /// Close the current column zone at its greatest consumed height and activate new geometry.
    /// Returns true when the new zone cannot start on this page and must begin on a fresh page.
    pub(crate) fn start_zone(&mut self, layout: &ColumnLayout, body_w: f64, body_h: f64) -> bool {
        self.max_vert = self.max_vert.max(self.vert);
        self.zone_top += self.max_vert;
        self.boxes = column_boxes(layout, body_w);
        self.column = 0;
        self.vert = 0.0;
        self.max_vert = 0.0;
        if self.zone_top >= body_h {
            self.reset_page();
            true
        } else {
            false
        }
    }
}

fn uses_column_flow(doc: &SemanticDoc) -> bool {
    doc.sections.iter().any(|section| {
        section.blocks.iter().any(|block| {
            matches!(
                block,
                Block::Paragraph(paragraph)
                    if paragraph.column_layout_before.is_some() || paragraph.column_break_before
            )
        })
    })
}

/// 강제 쪽 나누기("쪽 나누기 앞에서")의 **블록 단위 단일 진실** — `sec.blocks[i]` 앞에서 쪽을
/// 넘겨야 하면 `out[i] == true`. `NaiveLayout`·[`place_doc`]·[`block_pages`] 셋이 전부 이 하나를
/// 거쳐야 LOCKSTEP 이 구조적으로 보장된다(불변식 #2 — 세 경로에 같은 판정을 세 번 손으로 적으면
/// 언젠가 갈린다).
///
/// 왜 단순히 `Paragraph::page_break_before` 를 보면 안 되나(이슈 080):
/// HWPX 파서는 왕복 바이트 보존 해자 때문에 표 호스트 문단을 `[Table, 호스트문단]` 순서로 낸다
/// (`</hp:tbl>` 이 `</hp:p>` 보다 먼저 닫힌다 — parse.rs 주석 참조). 그래서 `<hp:p pageBreak="1">`
/// 이 표만 품은 호스트 문단에 걸려 있으면, 그 문단 자리에서 break 를 실행할 경우 쪽이 표 **뒤**에서
/// 넘어간다(원본은 표 **앞**). 여기서 그 break 를 자기 표의 첫 블록으로 **끌어올린다**.
///
/// 판정은 추측이 아니라 소스 스팬 포함 관계다: 호스트 문단의 `<hp:p>` 스팬이 그 표의 `<hp:tbl>`
/// 스팬을 감싸고 있으면 그 표는 이 문단의 소유다. 스팬이 없는 .hwp lift 경로는 애초에 순서가
/// `[앵커, Table]` 라 끌어올릴 것이 없고, 이 판정도 자연히 false 가 된다(무해).
pub fn section_page_breaks(sec: &Section, doc: &SemanticDoc) -> Vec<bool> {
    let mut out = vec![false; sec.blocks.len()];
    for (i, b) in sec.blocks.iter().enumerate() {
        let Block::Paragraph(p) = b else { continue };
        let ps = doc.para_shapes.get(p.para_shape);
        // per-instance 플래그(HWP column_type Page/Section · HWPX `hp:p pageBreak`) OR
        // 공유 para_shape 의 attr1 bit19.
        if !(p.page_break_before || ps.map(|s| s.page_break_before).unwrap_or(false)) {
            continue;
        }
        out[hoist_to_owned_table(sec, i, p)] = true;
    }
    out
}

/// [`section_page_breaks`] 의 보정 한 줄: 표만 품은 앵커 문단이면 **자기 표들의 첫 블록** 인덱스를,
/// 아니면 자기 인덱스를 돌려준다. 앵커 자체에서는 같은 break 를 다시 실행하지 않는다(끌어올린
/// 자리에만 표시된다).
fn hoist_to_owned_table(sec: &Section, i: usize, p: &Paragraph) -> usize {
    if !p.is_table_anchor {
        return i;
    }
    let Some(span) = p.source.as_ref().map(|s| s.span) else {
        return i;
    };
    let mut first = i;
    while first > 0 {
        // 바로 앞 블록이 이 문단의 XML 스팬 **안에** 있는 표인 동안 계속 끌어올린다
        // (한 호스트 문단이 표를 여러 개 품을 수 있다).
        match &sec.blocks[first - 1] {
            Block::Table(t) => match t.src_span {
                Some((ts, te)) if ts >= span.0 && te <= span.1 => first -= 1,
                _ => break,
            },
            _ => break,
        }
    }
    first
}

/// A plain (no family/style) font key — metrics here are per-script, family-independent.
fn plain_font() -> FontKey {
    FontKey {
        family: String::new(),
        bold: false,
        italic: false,
    }
}

/// True for full-width glyphs (Hangul, CJK, fullwidth forms) — ~1 EM advance; others are ~half EM.
pub fn is_full_width(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF |   // Hangul Jamo
        0x2E80..=0x2FDF |   // CJK radicals / Kangxi
        0x3000..=0x303F |   // CJK symbols & punctuation
        0x3040..=0x30FF |   // Hiragana + Katakana
        0x3130..=0x318F |   // Hangul Compatibility Jamo
        0x3400..=0x4DBF |   // CJK Ext-A
        0x4E00..=0x9FFF |   // CJK Unified Ideographs
        0xA960..=0xA97F |   // Hangul Jamo Ext-A
        0xAC00..=0xD7A3 |   // Hangul Syllables
        0xD7B0..=0xD7FF |   // Hangul Jamo Ext-B
        0xF900..=0xFAFF |   // CJK Compatibility Ideographs
        0xFF00..=0xFFEF     // Halfwidth/Fullwidth Forms (approx as full)
    )
}

// ── 금칙 (kinsoku) line-break rules ──────────────────────────────────────────────────────────────
// Character sets ported verbatim from external/rhwp (MIT)
// `src/renderer/composer/line_breaking.rs::{is_line_start_forbidden, is_line_end_forbidden}`.
// rhwp reimplements Hancom's 금칙 처리: a small closed set of glyphs that may not begin a line (줄머리
// 금칙 — closing brackets, trailing punctuation, trailing marks) or end one (줄꼬리 금칙 — opening
// brackets, leading currency signs). We re-derive the sets here rather than call across the vendored
// crate (rhwp is not a production layout engine and its submodule is not modified), so
// `layout_paragraph` — the ONE break truth shared by NaiveLayout (oracle) and place_doc (renderer) —
// stays in lockstep for both paths.

/// 줄머리 금칙: this char may NOT start a line (닫는 괄호·구두점·후행 부호). rhwp set, verbatim.
fn is_line_start_forbidden(ch: char) -> bool {
    matches!(
        ch,
        ')' | ']'
            | '}'
            | ','
            | '.'
            | '!'
            | '?'
            | ';'
            | ':'
            | '\''
            | '"'
            | '\u{3001}' // 、
            | '\u{3002}' // 。
            | '\u{2026}' // …
            | '\u{00B7}' // ·
            | '\u{2015}' // ―
            | '\u{30FC}' // ー
            | '\u{300B}' // 》
            | '\u{300D}' // 」
            | '\u{300F}' // 』
            | '\u{3011}' // 】
            | '\u{FF09}' // ）
            | '\u{FF5D}' // ｝
            | '\u{3015}' // 〕
            | '\u{3009}' // 〉
            | '\u{FF1E}' // ＞
            | '\u{226B}' // ≫
            | '\u{FF3D}' // ］
            | '\u{FE5E}' // ﹞
            | '\u{301E}' // 〞
            | '\u{2019}' // ’
            | '\u{201D}' // ”
            | '\u{FF0C}' // ，
            | '\u{FF0E}' // ．
            | '\u{FF01}' // ！
            | '\u{FF1F}' // ？
            | '\u{FF1B}' // ；
            | '\u{FF1A}' // ：
            | '%'
            | '\u{2030}' // ‰
            | '\u{2103}' // ℃
            | '\u{00B0}' // °
            | '\u{FF05}' // ％
    )
}

/// 줄꼬리 금칙: this char may NOT end a line (여는 괄호·선행 통화기호). rhwp set, verbatim.
fn is_line_end_forbidden(ch: char) -> bool {
    matches!(
        ch,
        '(' | '['
            | '{'
            | '\''
            | '"'
            | '\u{300A}' // 《
            | '\u{300C}' // 「
            | '\u{300E}' // 『
            | '\u{3010}' // 【
            | '\u{FF08}' // （
            | '\u{FF5B}' // ｛
            | '\u{3014}' // 〔
            | '\u{3008}' // 〈
            | '\u{FF1C}' // ＜
            | '\u{226A}' // ≪
            | '\u{FF3B}' // ［
            | '\u{301D}' // 〝
            | '\u{2018}' // ‘
            | '\u{201C}' // “
            | '$'
            | '\u{20A9}' // ₩
            | '\u{00A3}' // £
            | '\u{20AC}' // €
            | '\u{00A5}' // ¥
            | '\u{FF04}' // ＄
            | '\u{FFE5}' // ￥
    )
}

/// Cap on how many chars a 줄머리 금칙 hang may pull up past the greedy break, so a pathological run of
/// forbidden glyphs can't collapse a whole paragraph onto one line. Real text hangs 1–2 (e.g. `.)`).
const KINSOKU_MAX_HANG: usize = 8;

/// Adjust a *width-driven* greedy break at `line_end` (the position the NEXT line would begin at) so it
/// honors 금칙. rhwp glues a 줄머리 금칙 char as a suffix onto its preceding 어절 token, so the forbidden
/// char rides with its word and is never isolated at a line head; our breaker shapes per-char, so we
/// reproduce that by HANGING (끌어올리기) the forbidden char(s) up onto this line. Symmetrically, a 줄꼬리
/// 금칙 char at this line's tail is PUSHED (밀어내기) down to the next line. 줄머리 takes precedence so the
/// two straight-quote chars that live in BOTH sets can't ping-pong. Never empties the line, never runs
/// off the paragraph — so a break with no forbidden char at either edge is returned unchanged (exact
/// no-op, preserving byte-identical layout for text without kinsoku boundaries).
fn kinsoku_adjust(chars: &[(char, i32)], start: usize, line_end: usize, n: usize) -> usize {
    // No following line, or the line is already empty → nothing to move.
    if line_end >= n || line_end <= start {
        return line_end;
    }
    // 줄머리 금칙 — hang trailing forbidden char(s) UP onto this line (they follow their word).
    if is_line_start_forbidden(chars[line_end].0) {
        let mut e = line_end;
        let cap = (line_end + KINSOKU_MAX_HANG).min(n);
        while e < cap && is_line_start_forbidden(chars[e].0) {
            e += 1;
        }
        return e;
    }
    // 줄꼬리 금칙 — push trailing forbidden char(s) DOWN to the next line (they lead their content).
    if is_line_end_forbidden(chars[line_end - 1].0) {
        let mut e = line_end;
        while e > start + 1 && is_line_end_forbidden(chars[e - 1].0) {
            e -= 1;
        }
        return e;
    }
    line_end
}

/// Per-script APPROXIMATE metrics so we can break lines + paginate before a real shaper lands:
/// full-width glyph ≈ 1 EM, half-width (Latin/digit/punct) ≈ 0.5 EM, space ≈ 0.3 EM. Never fidelity.
#[derive(Default)]
pub struct ApproxFontMetrics;

impl FontMetricsProvider for ApproxFontMetrics {
    fn advance_width(&self, _font: &FontKey, ch: char, size_hwpunit: i32) -> f64 {
        let em = size_hwpunit.max(1) as f64;
        if ch == ' ' || ch == '\t' {
            em * SPACE
        } else if is_full_width(ch) {
            em
        } else {
            em * HALF
        }
    }
}

/// Real layout engine: greedy line-breaking + vertical-accumulation pagination over the injected
/// metrics. Replaces the old no-op stub.
#[derive(Default)]
pub struct NaiveLayout;

impl LayoutEngine for NaiveLayout {
    fn layout(&self, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Result<LayoutResult> {
        if uses_column_flow(doc) {
            return Ok(layout_columns(doc, fonts));
        }
        let mut pages = vec![PageLayout::default()];
        for sec in &doc.sections {
            let page = &sec.page;
            let (_, _, body_w, body_h) = body_box(page);
            // Each section starts on a fresh page (matches OWPML section→page).
            if !pages.last().map(|p| p.lines.is_empty()).unwrap_or(true) {
                pages.push(PageLayout::default());
            }
            if let Some(p) = pages.last_mut() {
                let (w, h) = display_paper(page);
                p.width = w as f64;
                p.height = h as f64;
            }
            // "쪽 나누기 앞에서" — 블록별 강제 개쪽 플래그. place_doc/block_pages 와 **같은 함수**를
            // 거쳐야 LOCKSTEP 이 유지된다(이슈 080).
            let brk = crate::section_page_breaks(sec, doc);
            let mut vert = 0.0f64; // page-relative vertical cursor

            for (blk_idx, block) in sec.blocks.iter().enumerate() {
                match block {
                    Block::Paragraph(p) => {
                        let ps = doc.para_shapes.get(p.para_shape);
                        if brk[blk_idx] && vert > 0.0 {
                            pages.push(new_page(page));
                            vert = 0.0;
                        }
                        // A pure table anchor reserves NO height (Hancom hangs the table off it with no
                        // line); the following Table block accounts for the space. Skip its line + spacing.
                        if p.is_table_anchor {
                            continue;
                        }
                        // 문단 위 간격 — Hancom adds it before the paragraph (suppressed at page top).
                        if vert > 0.0 {
                            vert += ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
                        }
                        let ratio = line_spacing_ratio(p, doc);
                        for ls in layout_paragraph(p, doc, body_w, fonts) {
                            if vert + ls.vert_size > body_h && vert > 0.0 {
                                pages.push(new_page(page));
                                vert = 0.0;
                            }
                            let adv = ls.vert_size * ratio;
                            pages.last_mut().unwrap().lines.push(LineSeg {
                                vert_pos: vert,
                                ..ls
                            });
                            vert += adv;
                        }
                        // 문단 아래 간격.
                        vert += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                    }
                    // Real table layout for pagination: each row is sized to its tallest cell's
                    // laid-out content (cells break lines at an equal-split width). A row that doesn't
                    // fit the remaining body flows to the NEXT page (한글식 row-level split) instead of
                    // jumping the whole table (which left big white gaps). IDENTICAL accounting to
                    // place_doc/place_table — outer top margin (suppressed at page top), the row-level
                    // split (an over-tall row draws and leaves vert>body_h for the NEXT block to break,
                    // NO trailing page-slice), then the outer bottom margin — so this page count stays
                    // in LOCKSTEP with place_doc's fragment placement (oracle can't drift).
                    Block::Table(t) => {
                        // 표 앞 강제 개쪽(이슈 080): HWPX 는 표를 품은 호스트 문단의 pageBreak 를 여기로
                        // 끌어올린다. 바깥 여백보다 먼저 — 새 쪽 맨 위에는 여백을 두지 않는다.
                        if brk[blk_idx] && vert > 0.0 {
                            pages.push(new_page(page));
                            vert = 0.0;
                        }
                        // Promote a 1×1 frame-wrapper to its inner table so a tall nested grid splits at
                        // row granularity (자가진단표) instead of bumping whole. Identical in place_doc +
                        // block_pages → lockstep. (NaiveLayout only sizes, so the frame is discarded here.)
                        let unwrapped = unwrap_frame_table(t);
                        let t = unwrapped.as_ref().map(|(it, _)| it).unwrap_or(t);
                        if vert > 0.0 {
                            vert += t.outer_margin_top.max(0) as f64;
                        }
                        let rows = table_page_flow_row_heights(t, body_w, body_h, doc, fonts);
                        let caption_metrics = table_caption_metrics(t, body_w, doc, fonts);
                        if let Some((_, caption_height)) = caption_metrics {
                            if keep_captioned_table_on_fresh_lane(
                                t,
                                &rows,
                                caption_height,
                                vert,
                                body_h,
                            ) {
                                pages.push(new_page(page));
                                vert = 0.0;
                            }
                        } else if keep_table_on_fresh_lane(t, &rows, vert, body_h) {
                            pages.push(new_page(page));
                            vert = 0.0;
                        }
                        if t.caption
                            .as_ref()
                            .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                        {
                            vert = flow_caption_naive(
                                t.caption.as_ref().expect("checked caption"),
                                doc,
                                fonts,
                                body_w,
                                body_h,
                                vert,
                                &mut pages,
                                page,
                            );
                            vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                        }
                        let repeated_header = if t.repeat_first_row {
                            rows.first().copied().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        for (row, rh) in rows.into_iter().enumerate() {
                            let header = if row > 0 { repeated_header } else { 0.0 };
                            let continued = (body_h - header).max(1.0);
                            let first_available = (body_h - vert).max(1.0);
                            if let Some(fragments) =
                                over_tall_cell_fragments(t, row, rh, first_available, continued)
                            {
                                for (index, fragment) in fragments.iter().enumerate() {
                                    if index > 0 {
                                        pages.push(new_page(page));
                                        vert = header;
                                    }
                                    vert += fragment;
                                }
                                continue;
                            }
                            // `rh <= body_h`: a row taller than the whole body never triggers a break — it
                            // can't fit a fresh page either, so a break would only waste the current page
                            // (the 자가진단표 1×1 mega-cell). Mirrors place_table + block_pages for lockstep.
                            if vert + rh > body_h && vert > 0.0 && rh <= body_h {
                                pages.push(new_page(page));
                                vert = 0.0;
                            }
                            vert += rh;
                        }
                        if t.caption
                            .as_ref()
                            .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                        {
                            vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                            vert = flow_caption_naive(
                                t.caption.as_ref().expect("checked caption"),
                                doc,
                                fonts,
                                body_w,
                                body_h,
                                vert,
                                &mut pages,
                                page,
                            );
                        }
                        vert += t.outer_margin_bottom.max(0) as f64;
                    }
                }
            }
        }
        Ok(LayoutResult { pages })
    }
}

/// Column-enabled pagination lane. The historic lane above remains byte-for-byte untouched and is
/// selected for every document without an explicit column-zone/break signal.
fn layout_columns(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> LayoutResult {
    let mut pages = vec![PageLayout::default()];
    for section in &doc.sections {
        let page = &section.page;
        let (_, _, body_w, body_h) = body_box(page);
        if !pages
            .last()
            .map(|value| value.lines.is_empty())
            .unwrap_or(true)
        {
            pages.push(PageLayout::default());
        }
        if let Some(output) = pages.last_mut() {
            let (width, height) = display_paper(page);
            output.width = width as f64;
            output.height = height as f64;
        }
        let breaks = section_page_breaks(section, doc);
        let mut flow = ColumnFlow::new(body_w);
        for (block_index, block) in section.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(paragraph) => {
                    let shape = doc.para_shapes.get(paragraph.para_shape);
                    if let Some(columns) = &paragraph.column_layout_before {
                        if flow.start_zone(columns, body_w, body_h) {
                            pages.push(new_page(page));
                        }
                    }
                    if breaks[block_index] && flow.y() > 0.0 {
                        pages.push(new_page(page));
                        flow.reset_page();
                    } else if paragraph.column_break_before && flow.advance_column() {
                        pages.push(new_page(page));
                    }
                    if paragraph.is_table_anchor {
                        continue;
                    }
                    if flow.vert() > 0.0 {
                        flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                    }
                    let ratio = line_spacing_ratio(paragraph, doc);
                    for mut line in layout_paragraph(paragraph, doc, flow.min_width(), fonts) {
                        if flow.vert() + line.vert_size > flow.available_height(body_h)
                            && flow.vert() > 0.0
                            && flow.advance_column()
                        {
                            pages.push(new_page(page));
                        }
                        line.horz_pos += flow.box_now().x;
                        let advance = line.vert_size * ratio;
                        pages.last_mut().expect("page exists").lines.push(LineSeg {
                            vert_pos: flow.y(),
                            ..line
                        });
                        flow.add(advance);
                    }
                    flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
                }
                Block::Table(table) => {
                    if breaks[block_index] && flow.y() > 0.0 {
                        pages.push(new_page(page));
                        flow.reset_page();
                    }
                    let promoted = unwrap_frame_table(table);
                    let table = promoted.as_ref().map(|(inner, _)| inner).unwrap_or(table);
                    if flow.vert() > 0.0 {
                        flow.add(table.outer_margin_top.max(0) as f64);
                    }
                    let rows = table_row_heights(table, flow.min_width(), doc, fonts);
                    let caption_metrics =
                        table_caption_metrics(table, flow.min_width(), doc, fonts);
                    let should_advance = if let Some((_, caption_height)) = caption_metrics {
                        keep_captioned_table_on_fresh_lane(
                            table,
                            &rows,
                            caption_height,
                            flow.vert(),
                            flow.available_height(body_h),
                        )
                    } else {
                        keep_table_on_fresh_lane(
                            table,
                            &rows,
                            flow.vert(),
                            flow.available_height(body_h),
                        )
                    };
                    if should_advance && flow.advance_column() {
                        pages.push(new_page(page));
                    }
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                    {
                        flow_caption_columns_naive(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_h,
                            &mut flow,
                            &mut pages,
                            page,
                        );
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                    }
                    for row_height in rows {
                        let available = flow.available_height(body_h);
                        if flow.vert() + row_height > available
                            && flow.vert() > 0.0
                            && row_height <= available
                            && flow.advance_column()
                        {
                            pages.push(new_page(page));
                        }
                        flow.add(row_height);
                    }
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                    {
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                        flow_caption_columns_naive(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_h,
                            &mut flow,
                            &mut pages,
                            page,
                        );
                    }
                    flow.add(table.outer_margin_bottom.max(0) as f64);
                }
            }
        }
    }
    LayoutResult { pages }
}

fn new_page(page: &PageSetup) -> PageLayout {
    let (w, h) = display_paper(page);
    PageLayout {
        width: w as f64,
        height: h as f64,
        lines: Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn flow_caption_naive(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    avail_w: f64,
    body_h: f64,
    mut vert: f64,
    pages: &mut Vec<PageLayout>,
    page: &PageSetup,
) -> f64 {
    let width = if caption.max_width > 0 {
        avail_w.min(caption.max_width as f64)
    } else {
        avail_w
    }
    .max(1.0);
    for block in &caption.blocks {
        match block {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if vert > 0.0 {
                    vert += shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64;
                }
                let ratio = line_spacing_ratio(paragraph, doc);
                for line in layout_paragraph(paragraph, doc, width, fonts) {
                    if vert + line.vert_size > body_h && vert > 0.0 {
                        pages.push(new_page(page));
                        vert = 0.0;
                    }
                    let advance = line.vert_size * ratio;
                    pages.last_mut().expect("page exists").lines.push(LineSeg {
                        vert_pos: vert,
                        ..line
                    });
                    vert += advance;
                }
                vert += shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64;
            }
            Block::Table(table) => {
                let height = table_height(table, width, doc, fonts);
                if vert + height > body_h && vert > 0.0 && height <= body_h {
                    pages.push(new_page(page));
                    vert = 0.0;
                }
                vert += height;
            }
        }
    }
    vert
}

#[allow(clippy::too_many_arguments)]
fn flow_caption_columns_naive(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    body_h: f64,
    flow: &mut ColumnFlow,
    pages: &mut Vec<PageLayout>,
    page: &PageSetup,
) {
    let width = if caption.max_width > 0 {
        flow.min_width().min(caption.max_width as f64)
    } else {
        flow.min_width()
    }
    .max(1.0);
    for block in &caption.blocks {
        match block {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if flow.vert() > 0.0 {
                    flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                }
                let ratio = line_spacing_ratio(paragraph, doc);
                for mut line in layout_paragraph(paragraph, doc, width, fonts) {
                    if flow.vert() + line.vert_size > flow.available_height(body_h)
                        && flow.vert() > 0.0
                        && flow.advance_column()
                    {
                        pages.push(new_page(page));
                    }
                    line.horz_pos += flow.box_now().x;
                    let advance = line.vert_size * ratio;
                    pages.last_mut().expect("page exists").lines.push(LineSeg {
                        vert_pos: flow.y(),
                        ..line
                    });
                    flow.add(advance);
                }
                flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
            }
            Block::Table(table) => {
                let height = table_height(table, width, doc, fonts);
                if flow.vert() + height > flow.available_height(body_h)
                    && flow.vert() > 0.0
                    && height <= flow.available_height(body_h)
                    && flow.advance_column()
                {
                    pages.push(new_page(page));
                }
                flow.add(height);
            }
        }
    }
}

/// Vertical cell padding (HWPUNIT) — HWP's default top+bottom cell insets (~141 HWPUNIT ≈ 0.49 mm each
/// = ~280 total), measured from rhwp's parsed cell geometry (277.8 on benchmark1 / 281.4 on benchmark).
/// Was 600 (≈2.15× too high), which over-reserved every table row; safe to correct now that the gate's
/// page count is anchored by structural 쪽 나누기 (column_type) rather than inflated row heights.
pub(crate) const CELL_PAD: f64 = 280.0;

/// If `t` is a 1×1 "frame" table whose only active cell wraps exactly ONE multi-row nested table (plus
/// optional empty paragraphs), promote that inner table to the top level so the NORMAL row-level page
/// split applies — instead of collapsing all its rows into one atomic outer row that gets bumped whole to
/// the next page (the 자가진단표: a 17×3 grid wrapped in a 1×1 → page 1 went blank below the heading, the
/// whole grid jumped to page 2). Returns `(inner_table, outer_frame)`: the outer cell's uniform border
/// rides along as `frame` so `place_table`/`flush_fragment` redraws the box around each page fragment (it
/// continues across the split). `None` when `t` isn't such a wrapper — the predicate is deliberately
/// narrow so it fires only on real single-cell frame wrappers, and it is applied IDENTICALLY in place_doc,
/// NaiveLayout and block_pages, so the three page counts stay in lockstep.
pub fn unwrap_frame_table(t: &Table) -> Option<(Table, Option<CellEdge>)> {
    if t.rows != 1 || t.cols != 1 {
        return None;
    }
    let cell = t
        .cells
        .iter()
        .find(|c| c.active && c.row == 0 && c.col == 0)?;
    let mut inner: Option<&Table> = None;
    for b in &cell.blocks {
        match b {
            Block::Table(nt) => {
                if inner.is_some() {
                    return None; // two nested tables → not a simple frame wrapper
                }
                inner = Some(nt);
            }
            Block::Paragraph(p) => {
                // real text beside the table means the cell has its own content → keep it whole
                let has_text = p.runs.iter().any(|r| {
                    r.content
                        .iter()
                        .any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
                });
                if has_text {
                    return None;
                }
            }
        }
    }
    let inner = inner?;
    if inner.rows <= 1 {
        return None; // a 1-row inner gains nothing (still atomic)
    }
    let mut inner = inner.clone();
    // Preserve the outer table's breathing room (바깥 여백) if the inner didn't carry its own.
    if inner.outer_margin_top == 0 {
        inner.outer_margin_top = t.outer_margin_top;
    }
    if inner.outer_margin_bottom == 0 {
        inner.outer_margin_bottom = t.outer_margin_bottom;
    }
    // The outer cell's frame edge (the box around the wrapped table). Prefer a real per-edge border;
    // fall back to a default hairline only when the cell merely flags a legacy box.
    let frame = cell
        .borders
        .iter()
        .flatten()
        .find(|e| e.style != LineStyle::None)
        .copied()
        .or_else(|| {
            cell.has_border.then_some(CellEdge {
                color: Color {
                    r: 0,
                    g: 0,
                    b: 0,
                    a: 255,
                },
                style: LineStyle::Solid,
                width_px: 1.0,
            })
        });
    Some((inner, frame))
}

/// Reserved height (HWPUNIT) of ONE paragraph INSIDE A TABLE CELL at `width`: 위/아래 간격 +
/// (n−1 inter-line gaps at `vert_size × linespace`) + the LAST line's bare box. Hancom's line-spacing
/// leading sits BETWEEN lines, not below the last one, so a cell paragraph reserves `Σ vert_size×ratio`
/// MINUS the last line's extra leading `vert_size_last × (ratio−1)`. We used to leave that trailing
/// leading in every cell row — a per-row over-reservation (≈ one line's leading) that accumulated tens
/// of thousands of HWPUNIT across benchmark1's page-1 checklist grid and spilled it to a 19th page
/// (issue 020; measured in docs/BENCHMARK1-ROW-AUDIT.md). The last line's leading is empty space BELOW
/// its ink, so dropping it from the reserve never clips the glyphs — it just tightens the row to the
/// text the way 한글 does. Shared by both sizing twins ([`block_height`] + `place::block_height_for_place`)
/// so the pagination reserve and the drawn cell stay in LOCKSTEP. Body pagination does NOT use this
/// (NaiveLayout stacks body lines directly), so this change is scoped to table-cell content only.
pub(crate) fn cell_paragraph_height(
    p: &Paragraph,
    doc: &SemanticDoc,
    width: f64,
    fonts: &dyn FontMetricsProvider,
) -> f64 {
    let ps = doc.para_shapes.get(p.para_shape);
    let sb = ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
    let sa = ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
    let ratio = line_spacing_ratio(p, doc);
    let lines = layout_cell_paragraph(p, doc, width, fonts);
    let text: f64 = lines.iter().map(|l| l.vert_size * ratio).sum();
    let last_leading = lines
        .last()
        .map(|l| l.vert_size * (ratio - 1.0))
        .unwrap_or(0.0)
        .max(0.0);
    sb + (text - last_leading) + sa
}

/// Laid-out height of one block (HWPUNIT) at the given content width — paragraph (lines×spacing +
/// 위/아래 간격, trailing leading trimmed per [`cell_paragraph_height`]) or a nested table (recursive).
/// Drives table-row sizing + pagination accounting.
fn block_height(b: &Block, doc: &SemanticDoc, width: f64, fonts: &dyn FontMetricsProvider) -> f64 {
    match b {
        Block::Paragraph(p) => cell_paragraph_height(p, doc, width, fonts),
        Block::Table(t) => table_height(t, width, doc, fonts),
    }
}

/// Whether a caption participates in today's vertical table flow. Side captions are preserved in
/// the IR, but require a horizontal lane model and therefore remain deliberately unplaced.
pub(crate) fn has_flow_caption(table: &Table) -> bool {
    table.caption.as_ref().is_some_and(|caption| {
        matches!(
            caption.position,
            TableCaptionPosition::Top | TableCaptionPosition::Bottom
        )
    })
}

/// Text width and measured block height for a top/bottom caption. This is shared by both pagination
/// twins; actual glyph placement still goes through the ordinary paragraph placer.
pub(crate) fn table_caption_metrics(
    table: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Option<(f64, f64)> {
    let caption = table.caption.as_ref()?;
    if !matches!(
        caption.position,
        TableCaptionPosition::Top | TableCaptionPosition::Bottom
    ) {
        return None;
    }
    let width = if caption.max_width > 0 {
        avail_w.min(caption.max_width as f64)
    } else {
        avail_w
    }
    .max(1.0);
    // Caption paragraphs use the ordinary body-flow accounting (not the trimmed cell-height
    // heuristic): full line advance plus paragraph spacing. This is the same formula consumed by
    // `flow_caption_naive` and `place_caption`, so keep-together never decides from a shorter proxy.
    let height = caption
        .blocks
        .iter()
        .map(|block| match block {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                let lines = layout_paragraph(paragraph, doc, width, fonts);
                let ratio = line_spacing_ratio(paragraph, doc);
                shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64
                    + lines.iter().map(|line| line.vert_size * ratio).sum::<f64>()
                    + shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64
            }
            Block::Table(table) => table_height(table, width, doc, fonts),
        })
        .sum();
    Some((width, height))
}

pub(crate) fn keep_captioned_table_on_fresh_lane(
    table: &Table,
    row_heights: &[f64],
    caption_height: f64,
    vert: f64,
    available: f64,
) -> bool {
    let spacing = table
        .caption
        .as_ref()
        .map(|caption| caption.spacing.max(0) as f64)
        .unwrap_or(0.0);
    let total = row_heights.iter().sum::<f64>() + caption_height + spacing;
    table.keep_together
        && vert > 0.0
        && total > 0.0
        && total <= available
        && vert + total > available
}

/// Estimated height of a table (HWPUNIT): Σ row heights, each row = max content height of the cells
/// occupying it (a row-spanning cell distributes its height evenly across the rows it covers).
/// Cells break lines at an equal-split column width (`avail / cols × col_span`) — no per-column
/// widths yet, but enough for faithful page accounting.
pub fn table_height(
    t: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> f64 {
    table_row_heights(t, avail_w, doc, fonts).iter().sum()
}

/// Effective left/right cell inset (HWPUNIT). A parsed cell with its own `padding` wins; otherwise
/// the table-level `<hp:inMargin>` applies. Inserted/legacy tables with neither keep the calibrated
/// fallback [`crate::place::CELL_PAD_X`] on each side.
pub fn cell_horizontal_padding(t: &Table, c: &Cell) -> (f64, f64) {
    match c.padding.as_ref().or(t.padding.as_ref()) {
        Some(p) => (p[0].max(0) as f64, p[1].max(0) as f64),
        None => (crate::place::CELL_PAD_X, crate::place::CELL_PAD_X),
    }
}

/// The horizontal width at which cell `cell_idx` is actually line-broken (HWPUNIT).
///
/// This is intentionally a public diagnostic seam: the layout-fidelity oracle in `hwp-rhwp`
/// must score cell paragraphs at the SAME width the own renderer uses. It therefore shares the
/// ragged-row cell-box calculation from issue 074 and the effective horizontal inset from
/// [`cell_horizontal_padding`], rather than rebuilding either rule in the oracle.
pub fn table_cell_text_width(t: &Table, avail_w: f64, cell_idx: usize) -> f64 {
    if cell_idx >= t.cells.len() || t.cols == 0 {
        return 1.0;
    }
    let xs = crate::place::column_offsets(t, avail_w);
    let boxes = crate::place::cell_boxes(t, avail_w);
    let (_, cw) = crate::place::cell_box_at(t, &boxes, &xs, cell_idx);
    let (left, right) = cell_horizontal_padding(t, &t.cells[cell_idx]);
    (cw - left - right).max(1.0)
}

/// Line-break one paragraph inside a table cell at the same usable width as
/// `place::place_cell_content`.
///
/// `cell_text_w` is the value returned by [`table_cell_text_width`]. Paragraph left/right margins
/// further shrink the wrapping box; this mirrors `place::indent_of` (the positive first-line indent
/// shifts the line origin but, for backward compatibility, does not change the greedy break width).
/// Keeping this helper beside [`layout_paragraph`] gives the cell-lineseg oracle a single,
/// renderer-identical width contract.
pub fn layout_cell_paragraph(
    p: &Paragraph,
    doc: &SemanticDoc,
    cell_text_w: f64,
    fonts: &dyn FontMetricsProvider,
) -> Vec<LineSeg> {
    let ps = doc.para_shapes.get(p.para_shape);
    let left = ps.map(|s| s.left_margin).unwrap_or(0).max(0) as f64;
    let right = ps.map(|s| s.right_margin).unwrap_or(0).max(0) as f64;
    layout_paragraph(p, doc, (cell_text_w - left - right).max(1.0), fonts)
}

/// Per-row heights (HWPUNIT) — the SINGLE sizing truth shared by the pagination reserve
/// ([`table_height`] = their sum), the row-level page split in [`NaiveLayout`], and the cell placer
/// ([`crate::place`] uses an identical computation). Each row = max content height of its cells
/// (a spanning cell distributes evenly) + [`CELL_PAD`], with any `Table::row_heights` override applied
/// as a floor. Column offsets honor the captured `col_widths` — the SAME widths place_table draws with,
/// so the RESERVATION equals the DRAWN height (an equal-split estimate over-reserved a wide-then-narrow
/// gov-doc table by ~1.5×, shoving it onto the next page with the rest empty).
///
/// 행 높이 결정은 **2단계**다(이슈 074): ① 한 행짜리 셀이 각 행을 정하고 ② 세로 병합 셀은 덮는
/// 행들의 합이 모자랄 때만 부족분을 마지막 행에 더한다. 셀 폭은 저장된 실폭
/// ([`crate::place::cell_boxes`])을 우선한다 — 열 격자는 ragged 표에서 폭을 최대 2배 틀리게 잡는다.
pub(crate) fn table_row_heights(
    t: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<f64> {
    if t.rows == 0 {
        return Vec::new();
    }
    let mut row_h = vec![0.0f64; t.rows];
    // 셀 하나의 예약 높이 (내용 + 세로 안쪽 여백).
    let need = |i: usize| -> f64 {
        let c = &t.cells[i];
        // LOCKSTEP with the cell placer: stored cell/table inMargin and ragged-row geometry determine
        // the exact text width. Using the old fixed 80+80 inset made 510+510-margin cells up to
        // 860 HWPUNIT too wide, hiding Hancom-authored wraps from the row reservation.
        let tw = table_cell_text_width(t, avail_w, i);
        c.blocks
            .iter()
            .map(|b| block_height(b, doc, tw, fonts))
            .sum::<f64>()
            + CELL_PAD
    };
    // ① 한 행짜리 셀만으로 각 행 높이를 정한다.
    for (i, c) in t.cells.iter().enumerate() {
        if c.active && c.row_span.max(1) == 1 && c.row < t.rows {
            row_h[c.row] = row_h[c.row].max(need(i));
        }
    }
    // ② 세로 병합 셀은 **덮는 행들의 합이 모자랄 때만** 부족분을 마지막 덮는 행에 더한다.
    //
    // 왜 균등 분배가 아닌가(이슈 074): 예전엔 병합 셀 높이를 span 으로 나눠 각 행에 `max` 로
    // 깔았다. 그러면 짧은 행이 병합 셀의 평균치까지 억지로 부풀려진다 — benchmark.hwp 3쪽 표에서
    // 한컴 실측(rhwp 레이아웃 트리)은 r6=11918 / r7=1845 인데 우리는 11921 / 6884(=13768÷2) 로
    // 5042 HWPUNIT 을 과다 예약했고, 그 한 행이 페이지를 넘겨 뒤따르는 쪽 나누기 때문에 한 쪽이
    // 통째로 낭비됐다. 실제 한글은 행을 제 셀로 먼저 재고, 병합 셀은 **전체 높이 하한**으로만
    // 작용한다(CSS 표 알고리즘과 같은 규칙).
    let mut spans: Vec<usize> = (0..t.cells.len())
        .filter(|&i| t.cells[i].active && t.cells[i].row_span.max(1) > 1 && t.cells[i].row < t.rows)
        .collect();
    // 좁은 병합부터 처리해야 넓은 병합이 이미 채워진 높이를 보고 부족분만 더한다.
    spans.sort_by_key(|&i| t.cells[i].row_span);
    for i in spans {
        let c = &t.cells[i];
        let end = (c.row + c.row_span.max(1)).min(t.rows);
        if end <= c.row {
            continue;
        }
        let sum: f64 = row_h[c.row..end].iter().sum();
        let want = need(i);
        if want > sum {
            row_h[end - 1] += want - sum;
        }
    }
    apply_row_overrides(&mut row_h, t);
    row_h
}

/// Whether a keep-together table should advance before row 0. The whole measured table must fit a
/// fresh lane; over-tall tables deliberately return false and retain bounded row fragmentation.
/// `vert > 0` also suppresses pointless blank-page/blank-column advances at a lane top.
pub(crate) fn keep_table_on_fresh_lane(
    table: &Table,
    row_heights: &[f64],
    vert: f64,
    available: f64,
) -> bool {
    let total: f64 = row_heights.iter().sum();
    table.keep_together
        && vert > 0.0
        && total > 0.0
        && total <= available
        && vert + total > available
}

/// Return page-body slices for an HWPX `pageBreak="CELL"` row that is taller than every fresh
/// continuation lane. `first_available` is the remainder of the page where the row begins;
/// `continued_available` excludes a repeated header row. This is deliberately fail-closed: only a
/// single, text-only row can be continued. Nested tables and paint objects keep bounded overflow
/// until their clipping/replay semantics are modeled.
pub(crate) fn over_tall_cell_fragments(
    table: &Table,
    row: usize,
    row_height: f64,
    first_available: f64,
    continued_available: f64,
) -> Option<Vec<f64>> {
    if !table.split_over_tall_cells
        || row >= table.rows
        || !row_height.is_finite()
        || !first_available.is_finite()
        || !continued_available.is_finite()
        || row_height <= continued_available
        || first_available <= 0.0
        || continued_available <= 0.0
    {
        return None;
    }
    let participating: Vec<&Cell> = table
        .cells
        .iter()
        .filter(|cell| {
            cell.active && cell.row <= row && row < cell.row.saturating_add(cell.row_span.max(1))
        })
        .collect();
    if participating.is_empty()
        || participating.iter().any(|cell| {
            cell.row != row
                || cell.row_span.max(1) != 1
                || cell.fill_image.is_some()
                || cell.blocks.iter().any(|block| match block {
                    Block::Paragraph(paragraph) => paragraph.runs.iter().any(|run| {
                        run.content.iter().any(|inline| {
                            !matches!(
                                inline,
                                Inline::Text(_)
                                    | Inline::FieldBegin(_)
                                    | Inline::FieldEnd(_)
                                    | Inline::Bookmark(_)
                            )
                        })
                    }),
                    Block::Table(_) => true,
                })
        })
    {
        return None;
    }

    let mut fragments = Vec::new();
    let mut remaining = row_height;
    let first = remaining.min(first_available);
    fragments.push(first);
    remaining -= first;
    while remaining > continued_available {
        fragments.push(continued_available);
        remaining -= continued_available;
    }
    if remaining > 0.0 {
        fragments.push(remaining);
    }
    let source_minimum = if table.geometry_edited || table.dirty.is_dirty() {
        0
    } else {
        participating
            .iter()
            .filter(|cell| !cell.dirty.is_dirty())
            .map(|cell| cell.source_page_segments)
            .max()
            .unwrap_or(0)
    };
    if source_minimum > fragments.len()
        && source_minimum > 1
        && source_minimum <= MAX_SOURCE_CELL_PAGE_SEGMENTS
    {
        let capacity =
            first_available + continued_available * source_minimum.saturating_sub(1) as f64;
        if row_height <= capacity {
            fragments.clear();
            let mut remaining = row_height;
            for index in 0..source_minimum {
                let slots = (source_minimum - index) as f64;
                let cap = if index == 0 {
                    first_available
                } else {
                    continued_available
                };
                let later_capacity =
                    continued_available * source_minimum.saturating_sub(index + 1) as f64;
                let minimum_here = (remaining - later_capacity).max(f64::EPSILON);
                let slice = (remaining / slots).max(minimum_here).min(cap);
                fragments.push(slice);
                remaining -= slice;
            }
            if let Some(last) = fragments.last_mut() {
                *last += remaining;
            }
        }
    }
    (fragments.len() > 1).then_some(fragments)
}

/// Row heights used only for `pageBreak="CELL"` pagination. A stored HWPX row normally retains
/// its parsed height; when its text itself is taller than a fresh continuation lane, however,
/// CELL flow must paginate that text. Re-measure only those overflowing rows from content while
/// leaving every ordinary/fitting row exact. Paint geometry and serialization remain untouched.
pub(crate) fn table_page_flow_row_heights(
    table: &Table,
    avail_w: f64,
    body_h: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<f64> {
    let mut rows = table_row_heights(table, avail_w, doc, fonts);
    if !table.split_over_tall_cells || rows.is_empty() {
        return rows;
    }
    let header = if table.repeat_first_row && table.rows > 1 {
        rows[0]
    } else {
        0.0
    };
    let continued_available = (body_h - header).max(1.0);
    for (row, measured_height) in rows.iter_mut().enumerate() {
        let Some(content_height) = continued_text_row_height(table, row, avail_w, doc, fonts)
        else {
            continue;
        };
        if over_tall_cell_fragments(
            table,
            row,
            content_height,
            continued_available,
            continued_available,
        )
        .is_some()
        {
            *measured_height = content_height;
        }
    }
    rows
}

/// Text stack height for a row that continues through a page boundary. Ordinary cell sizing trims
/// the last line's leading from every paragraph; in one continued cell, that leading remains the
/// inter-paragraph gap and only the final paragraph trims it. This distinction is activated only
/// after the stack exceeds a continuation lane, so the established row-height gates stay untouched.
fn continued_text_row_height(
    table: &Table,
    row: usize,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Option<f64> {
    let mut maximum = 0.0f64;
    let mut seen = false;
    for (cell_index, cell) in table.cells.iter().enumerate() {
        if !cell.active || cell.row != row || cell.row_span.max(1) != 1 || cell.fill_image.is_some()
        {
            continue;
        }
        if cell
            .blocks
            .iter()
            .any(|block| !matches!(block, Block::Paragraph(_)))
        {
            return None;
        }
        let text_width = table_cell_text_width(table, avail_w, cell_index);
        let paragraph_count = cell.blocks.len();
        let mut height = 0.0;
        for (index, block) in cell.blocks.iter().enumerate() {
            let Block::Paragraph(paragraph) = block else {
                unreachable!("checked above")
            };
            height += cell_paragraph_height(paragraph, doc, text_width, fonts);
            if index + 1 < paragraph_count {
                let ratio = line_spacing_ratio(paragraph, doc);
                if let Some(last) = layout_cell_paragraph(paragraph, doc, text_width, fonts).last()
                {
                    height += (last.vert_size * (ratio - 1.0)).max(0.0);
                }
            }
        }
        maximum = maximum.max(height + CELL_PAD);
        seen = true;
    }
    seen.then_some(maximum)
}

/// Apply per-row MINIMUM-height overrides (HWPUNIT) from [`Table::row_heights`] as a FLOOR on the
/// content-derived heights (drag-to-resize 행 높이). An empty vec or a `0` slot leaves the content
/// size untouched — so the default path (every parsed table, which never sets `row_heights`) is
/// byte-for-byte identical and the layout oracle is unaffected. Used by both the pagination
/// reservation (`table_height`) and the cell placer (`place::row_heights`) so they stay in lockstep.
pub(crate) fn apply_row_overrides(row_h: &mut [f64], t: &Table) {
    for (r, slot) in row_h.iter_mut().enumerate() {
        // 명시 행 높이(드래그 리사이즈/noAdjust=1)가 우선, 없으면 **저장된 행 높이**를 바닥으로.
        //
        // 이슈 074 — #196 의 판단을 뒤집는다. 그때는 `stored_row_heights`(자동 맞춤 표의
        // `<hp:cellSz height>`)를 바닥으로 깔면 benchmark1.hwpx 가 +2쪽이 된다고 회귀로 봤다.
        // 근거: `.hwp` 경로(rhwp lift)는 **원래부터** 저장 높이를 무조건 바닥으로 깔고, 그 경로가
        // 게이트(8==8·18==18·24==24)를 통과한다. 같은 문서를 포맷만 바꿔 읽었다고 표 높이가
        // 달라질 이유가 없으므로 HWPX 경로도 같은 규칙으로 맞춘다 — 실제로 이걸 켜야 교차포맷
        // 파리티(`hwpx_rhwp_parity`: 우리 파서 22쪽 == rhwp lift 22쪽)가 성립한다. 한컴 저작 hwpx
        // 표본에서도 오라클 대비 맞아 들어간다(광화문 3==3, 추경 4==4, pps 4==4 — 전부 이전엔 −1).
        // (`row_heights` 를 건드리지 않으므로 라운드트립 코덱은 그대로다.)
        let h = match t.row_heights.get(r) {
            Some(&h) if h > 0 => h,
            _ => t.stored_row_heights.get(r).copied().unwrap_or(0),
        };
        if h > 0 {
            // 자동 맞춤 안 함(`<hp:tbl noAdjust="1">`, HWPX 파서만 세운다)이면 저장 높이가 **정확값**
            // 이다 — 한컴은 넘치는 내용을 자르지 행을 늘리지 않는다(이슈 080). 그 외에는 종전대로
            // 바닥(floor): 드래그 리사이즈 · 자동 맞춤 표의 저장 높이 · .hwp lift 전부 여기로 온다.
            *slot = if t.fixed_row_heights && t.row_heights.get(r).is_some_and(|&v| v > 0) {
                h as f64
            } else {
                slot.max(h as f64)
            };
        }
    }
}

/// Per-row decomposition of OUR reserved table-row height (issue 020 diagnostic — kept tracked as the
/// standing fidelity tool). Mirrors [`table_row_heights`] EXACTLY (same column offsets, same padded
/// text width, same span distribution, same override floor) but also records the *determining* cell's
/// term breakdown so the row-audit can attribute an over/under-reservation to a specific term:
/// `lines` × (`raw_em` bare-EM box) × `linespace` = `spaced` line advance, + `space_ba` (문단 위/아래),
/// + [`CELL_PAD`] vertical inset. `reserved` is the final row height (post span-max + override).
#[derive(Clone, Debug, Default)]
pub struct RowTermBreakdown {
    pub reserved: f64,
    /// Total laid-out lines in the determining cell.
    pub lines: usize,
    /// Σ bare-EM line boxes (vert_size) of the determining cell (pre-linespace).
    pub raw_em: f64,
    /// The linespace ratio of the determining cell's first text paragraph (representative).
    pub linespace: f64,
    /// Σ (vert_size × linespace) — the actual stacked line advance of the determining cell.
    pub spaced: f64,
    /// 문단 위/아래 간격 (space_before + space_after) summed across the determining cell's paragraphs.
    pub space_ba: f64,
    /// The constant vertical cell padding term ([`CELL_PAD`]).
    pub cell_pad: f64,
    /// Determining cell's row span (content is divided by this before the per-row max).
    pub row_span: usize,
}

/// One cell's content decomposition at a padded text width — the per-cell half of [`row_term_breakdown`].
/// `spaced` is the ACTUAL reserved line advance (per-paragraph trailing leading trimmed, exactly like
/// [`cell_paragraph_height`]), so `spaced + space_ba + cell_pad` reconciles with the reserved row height.
fn cell_term_breakdown(
    c: &Cell,
    tw: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> RowTermBreakdown {
    let mut b = RowTermBreakdown {
        cell_pad: CELL_PAD,
        row_span: c.row_span.max(1),
        ..Default::default()
    };
    let mut first_ratio: Option<f64> = None;
    for blk in &c.blocks {
        match blk {
            Block::Paragraph(p) => {
                let ps = doc.para_shapes.get(p.para_shape);
                b.space_ba += ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
                b.space_ba += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                let ratio = line_spacing_ratio(p, doc);
                if first_ratio.is_none() {
                    first_ratio = Some(ratio);
                }
                let lines = layout_cell_paragraph(p, doc, tw, fonts);
                let raw: f64 = lines.iter().map(|l| l.vert_size).sum();
                let spaced: f64 = lines.iter().map(|l| l.vert_size * ratio).sum();
                let last_leading = lines
                    .last()
                    .map(|l| l.vert_size * (ratio - 1.0))
                    .unwrap_or(0.0)
                    .max(0.0);
                b.lines += lines.len();
                b.raw_em += raw;
                b.spaced += spaced - last_leading;
            }
            // Nested table: fold its whole height into `spaced` as one "line" so the totals reconcile
            // (it is measured, not text — the audit flags it via a jump in raw_em vs spaced).
            Block::Table(nt) => {
                let h = table_height(nt, tw, doc, fonts);
                b.spaced += h;
                b.raw_em += h;
                b.lines += 1;
            }
        }
    }
    b.linespace = first_ratio.unwrap_or(DEFAULT_LINESPACE);
    b
}

/// Per-row term breakdown for a table, LOCKSTEP with [`table_row_heights`]. The reserved height of
/// each row is set by the cell whose `(content)/span` is largest; that cell's decomposition is what
/// the audit reports for the row.
pub fn row_term_breakdown(
    t: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<RowTermBreakdown> {
    if t.rows == 0 {
        return Vec::new();
    }
    let heights = table_row_heights(t, avail_w, doc, fonts);
    let mut per_row: Vec<(f64, RowTermBreakdown)> =
        vec![(0.0, RowTermBreakdown::default()); t.rows];
    for (i, c) in t.cells.iter().enumerate() {
        if !c.active {
            continue;
        }
        let tw = table_cell_text_width(t, avail_w, i);
        let bd = cell_term_breakdown(c, tw, doc, fonts);
        let content = bd.spaced + bd.space_ba + bd.cell_pad;
        let span = c.row_span.max(1);
        let per = content / span as f64;
        let end = (c.row + span).min(t.rows);
        for slot in per_row.iter_mut().take(end).skip(c.row) {
            if per > slot.0 {
                *slot = (per, bd.clone());
            }
        }
    }
    per_row
        .into_iter()
        .enumerate()
        .map(|(r, (_, mut bd))| {
            bd.reserved = heights[r];
            bd
        })
        .collect()
}

/// A Hanyang-PUA 옛한글 음절은 HWP에서 전각 한 칸을 차지한다. 조판(줄바꿈/페이지네이션)에서는
/// 이 대표 전각 음절('가')의 어드밴스로 측정한다 — ApproxFontMetrics도, 실 셰이퍼도(둘 다 PUA
/// 글리프가 없어 직접 재면 notdef) 전각 한 칸으로 일치시키기 위함. 실제 그리기는 자모 시퀀스로
/// 확장한다(`place::paragraph_glyphs`의 `cluster`). '가'가 화면에 그려지지는 않는다(프록시일 뿐).
pub(crate) const OLD_HANGUL_METRIC_PROXY: char = '\u{AC00}';

/// Substitute a few typographic chars that common free Korean faces (e.g. NanumGothic) lack with a
/// present, visually-equivalent glyph, so a missing glyph renders as the intended mark instead of a
/// blank .notdef gap. Applied at glyph-build time in BOTH the line-breaker and the placer so advances
/// and drawing stay in lockstep. Currently: dot-leader / katakana middle dots → the middle dot (·),
/// all used as separators (e.g. "제품·서비스") in gov-doc forms; PLUS Hanyang-PUA 옛한글 → the
/// full-width Hangul metric proxy (issue 062-2 — the drawer expands it to a jamo cluster).
pub(crate) fn subst_glyph(ch: char) -> char {
    match ch {
        // U+2024 ONE DOT LEADER, U+30FB KATAKANA MIDDLE DOT, U+FF65 HALFWIDTH KATAKANA MIDDLE DOT.
        '\u{2024}' | '\u{30FB}' | '\u{FF65}' => '\u{00B7}',
        // Hanyang-PUA 옛한글: cheap BMP-PUA range gate before the table binary-search so all normal
        // text pays only a range compare. The exact table lookup runs solely for PUA-range chars.
        _ if matches!(ch as u32, 0xE000..=0xF8FF) && old_hangul::is_pua_old_hangul(ch) => {
            OLD_HANGUL_METRIC_PROXY
        }
        _ => ch,
    }
}

/// The KS X 1026-1 첫가끝 자모 시퀀스 to DRAW for a Hanyang-PUA 옛한글 음절 (issue 062-2), or `None`
/// for any ordinary char. The drawer substitutes this string for the glyph's metric-proxy `ch`; the
/// range gate keeps normal text off the table binary-search. Mirrors `subst_glyph`'s gate so the two
/// stay in step (a char returning `Some` here is exactly one `subst_glyph` maps to the proxy).
pub(crate) fn old_hangul_cluster(ch: char) -> Option<String> {
    if !matches!(ch as u32, 0xE000..=0xF8FF) {
        return None;
    }
    old_hangul::map_pua_old_hangul(ch).map(|jamos| jamos.iter().collect())
}

/// Lay out a single paragraph into [`LineSeg`]s (vert_pos left at 0 — the caller stacks them). Greedy
/// break: fill the line, then for a Latin word that straddles the edge back up to the last space;
/// Hangul/CJK break anywhere. Exposed for per-paragraph `linesegarray` emission.
pub fn layout_paragraph(
    p: &Paragraph,
    doc: &SemanticDoc,
    line_width: f64,
    fonts: &dyn FontMetricsProvider,
) -> Vec<LineSeg> {
    // One ordered flow slot per text glyph or embedded object. U+FFFC is only an internal metric
    // proxy: the placer walks the identical Inline order and draws the actual object at that slot.
    let mut chars: Vec<(char, i32)> = Vec::new();
    let mut advs: Vec<f64> = Vec::new();
    let mut object_heights: Vec<f64> = Vec::new();
    for run in &p.runs {
        let cs = doc.char_shapes.get(run.char_shape);
        let size = cs.map(|c| c.height).filter(|&h| h > 0).unwrap_or(1000);
        for inl in &run.content {
            match inl {
                Inline::Text(t) => {
                    for ch in t.chars() {
                        let sch = subst_glyph(ch);
                        let font = resolved_font_key(cs, sch, fonts);
                        chars.push((sch, size));
                        advs.push(scaled_advance(sch, size, cs, &font, fonts));
                        object_heights.push(0.0);
                    }
                }
                Inline::Image(image) => {
                    chars.push(('\u{FFFC}', 1));
                    advs.push(if image.treat_as_char {
                        image.width.max(0) as f64
                    } else {
                        0.0
                    });
                    object_heights.push(if image.treat_as_char {
                        image.height.max(0) as f64
                    } else {
                        0.0
                    });
                }
                Inline::Equation(equation) => {
                    chars.push(('\u{FFFC}', 1));
                    advs.push(if equation.treat_as_char {
                        equation.width.max(0) as f64
                    } else {
                        0.0
                    });
                    object_heights.push(if equation.treat_as_char {
                        equation.height.max(0) as f64
                    } else {
                        0.0
                    });
                }
                Inline::Chart(chart) => {
                    chars.push(('\u{FFFC}', 1));
                    advs.push(if chart.treat_as_char {
                        chart.width.max(0) as f64
                    } else {
                        0.0
                    });
                    object_heights.push(if chart.treat_as_char {
                        chart.height.max(0) as f64
                    } else {
                        0.0
                    });
                }
                _ => {}
            }
        }
    }
    let n = chars.len();
    let adv = |i: usize| advs[i];

    if n == 0 {
        // An empty paragraph still occupies one line — height = the object's if it anchors one.
        // (Measured: Hancom gives blank lines this full leading-based height too — the layout-check
        // oracle drops 8→7 pages if we shrink it to the bare EM, so the leading is load-bearing for
        // pagination.)
        //
        // 이슈 074: 빈 줄의 EM 은 **그 문단의 글자 크기**다 — 1000(10pt) 고정이 아니다. 한컴 실측
        // (benchmark1 page 2, 빈 문단): vpos 7665→8317 = 652 = 500(5pt) × 130%. 우리는 1000×130%
        // = 1300 을 잡아 빈 줄마다 두 배로 부풀렸고, 표가 많은 양식에서 누적돼 페이지가 밀렸다.
        let lh = fonts.line_height(empty_para_size(p, doc));
        let mut lines = vec![mk_line(0, lh, 0.0)];
        apply_source_line_metrics(p, &mut lines);
        return lines;
    }

    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < n {
        let mut w = 0.0;
        let mut end = start;
        let mut last_space: Option<usize> = None; // index AFTER a space within this line
        let mut forced = false; // hit a '\n' (HWP forced line break within the paragraph)
        while end < n {
            // A '\n' is a hard line break (강제 줄나눔, shift+enter): end the line BEFORE it and
            // consume it (it draws nothing). Without this the breaker flows "라벨\n(Problem)" as one
            // run and wraps by width, producing the wrong line split.
            if chars[end].0 == '\n' {
                forced = true;
                break;
            }
            let a = adv(end);
            if w + a > line_width && end > start {
                break;
            }
            w += a;
            end += 1;
            // A break opportunity follows an ASCII space OR a 전각 공백 (U+3000, `<hp:fwSpace/>`) — the
            // full-width space HWPX uses to separate a Korean label from its Latin gloss ("문제인식
            // (Problem)"). Without U+3000 here the mid-word Latin backup below has no space to retreat
            // to and wraps "(Proble"/"m)"; with it, the line breaks at the space like Hancom.
            if matches!(chars[end - 1].0, ' ' | '\u{3000}') {
                last_space = Some(end);
            }
        }
        // Forced break: the line is [start, end); the '\n' at `end` is consumed (skipped) below.
        let raw_end = if forced {
            end
        // Mid-word Latin break → back up to the last space (Hangul/CJK break anywhere).
        } else if end < n && !is_full_width(chars[end].0) {
            match last_space.filter(|&s| s > start) {
                Some(s) => s,
                // No space to back up to, mid Latin word. Extend to the word end (next space /
                // full-width char) and keep it whole IF it fits the line — but if the whole token is
                // wider than the line itself (a long Latin word in a narrow label cell, e.g.
                // "(Solution)"), keeping it whole would spill PAST the cell border into the neighbour.
                // Hancom wraps such a token inside the box, so char-break at the last glyph that fit.
                None => {
                    let mut e = end;
                    while e < n && chars[e].0 != ' ' && !is_full_width(chars[e].0) {
                        e += 1;
                    }
                    let e = e.max(start + 1);
                    let (whole_w, _) = measure(&chars, &advs, start, e);
                    if whole_w > line_width {
                        end.max(start + 1) // char-break: keep the line within line_width
                    } else {
                        e
                    }
                }
            }
        } else {
            end.max(start + 1)
        };
        // 금칙 (kinsoku): keep 줄머리 금칙 chars off the next line's head (hang them up) and 줄꼬리 금칙
        // chars off this line's tail (push them down). Width-driven breaks only — a forced '\n'
        // boundary is explicit, so it is left exactly where the author put it.
        let line_end = if forced {
            raw_end
        } else {
            kinsoku_adjust(&chars, start, raw_end, n)
        };
        let (lw, measured_size) = measure(&chars, &advs, start, line_end);
        // An empty line (a '\n' at the line start → blank line) has no glyph to size from; use the
        // break char's own font size so the blank line gets a real height, not a collapsed sliver.
        let max_size = if line_end == start {
            chars.get(start).map(|c| c.1).unwrap_or(1000).max(1)
        } else {
            measured_size
        };
        // Line box height = the font's real leading for the tallest glyph (real shaper) or flat EM
        // (approximation), NOT the bare EM — so rows match the actual face's line height.
        let object_height = object_heights[start..line_end]
            .iter()
            .copied()
            .fold(0.0f64, f64::max);
        lines.push(mk_line(
            start as u32,
            fonts.line_height(max_size).max(object_height),
            lw,
        ));
        // Consume the '\n' itself on a forced break so the next line starts after it (it draws
        // nothing — the place step skips '\n'). Otherwise advance to the computed break point.
        start = if forced && line_end < n {
            line_end + 1
        } else {
            line_end
        };
    }
    lines
}

/// Reuse Hancom's stored line-box metrics for an empty paragraph while it is structurally safe. This
/// helper is deliberately called only from the `n == 0` branch above: applying source line boxes to
/// normal text would turn stored layout into a second typesetter and break HWP→HWPX page-count parity.
/// Empty spacers have no glyph/char-shape evidence from which to reconstruct their authored height, so
/// the cache is both necessary and unambiguous there.
fn apply_source_line_metrics(p: &Paragraph, lines: &mut [LineSeg]) {
    if p.dirty.is_dirty()
        || p.source_line_metrics.is_empty()
        || p.source_line_metrics.len() != lines.len()
    {
        return;
    }
    for (line, source) in lines.iter_mut().zip(&p.source_line_metrics) {
        if source.height > 0 {
            line.vert_size = source.height as f64;
        }
        if source.text_height > 0 {
            line.text_height = source.text_height as f64;
        }
        if source.baseline > 0 {
            line.baseline = source.baseline as f64;
        }
    }
}

/// Sum of (pre-scaled) advances + max glyph size over `[a, b)`. `advs` parallels `chars` and already
/// carries each glyph's 장평/자간-scaled advance (see `scaled_advance`).
fn measure(chars: &[(char, i32)], advs: &[f64], a: usize, b: usize) -> (f64, i32) {
    let mut w = 0.0;
    let mut sz = 0;
    for i in a..b {
        w += advs[i];
        sz = sz.max(chars[i].1);
    }
    (w, sz.max(1))
}

/// Per-glyph advance (HWPUNIT) with 장평 (width ratio) + 자간 (letter spacing) from the run's char shape
/// applied — a pure geometric transform on the font's base advance, face-independent. 장평 scales the
/// advance (50–200%; 0/unset = 100%); 자간 adds a per-glyph gap as a fraction of the EM (−50…50%). A
/// `None` shape or the default 0/0 is an EXACT no-op, so paragraphs with no 장평/자간 break byte-for-byte
/// as before. Mirrors `shaper::RealFontMetrics::advance_scaled` so the breaker, NaiveLayout and the
/// placer share ONE width truth.
fn scaled_advance(
    ch: char,
    size: i32,
    cs: Option<&CharShape>,
    font: &FontKey,
    fonts: &dyn FontMetricsProvider,
) -> f64 {
    let base = fonts.advance_width(font, ch, size);
    let Some(cs) = cs else { return base };
    let script = script_slot(ch);
    let ratio = match *cs.ratio.get(script) {
        0 => 100,
        r => r.clamp(50, 200),
    } as f64
        / 100.0;
    let spacing = (*cs.spacing.get(script)).clamp(-50, 50) as f64 / 100.0;
    base * ratio + spacing * size as f64
}

/// Coarse Unicode → [`ScriptClass`] for picking the per-script 장평/자간 slot (mirrors the shaper's
/// `script_of`). Most docs set the 7 slots uniformly, so the exact split rarely matters. `pub(crate)`
/// so the placer (place.rs) resolves the same slot when it scales the DRAWN glyph advance.
pub(crate) fn script_slot(ch: char) -> ScriptClass {
    match ch as u32 {
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xD7B0..=0xD7FF => {
            ScriptClass::Hangul
        }
        0x2E80..=0x2FDF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => ScriptClass::Hanja,
        0x3040..=0x30FF => ScriptClass::Japanese,
        0x0000..=0x024F => ScriptClass::Latin,
        _ => ScriptClass::Other,
    }
}

/// Resolve one glyph to the same display family/style that the placer and PDF exporter use. An
/// explicitly registered document family wins; otherwise the deterministic OFL substitute name is
/// carried in the key so a matching injected serif/sans face can drive both metrics and realization.
pub(crate) fn resolved_font_key(
    cs: Option<&CharShape>,
    ch: char,
    fonts: &dyn FontMetricsProvider,
) -> FontKey {
    let Some(cs) = cs else { return plain_font() };
    let slot = script_slot(ch);
    let requested = cs
        .fonts
        .get(slot as usize)
        .and_then(|name| name.as_deref())
        .or(cs.font_family.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let family = requested
        .and_then(|name| {
            if fonts.has_family(name) {
                Some(name.to_string())
            } else {
                let panose = cs.font_panose.get(slot as usize).and_then(Option::as_ref);
                hwp_model::font_class::substitute_family_with_panose(name, panose)
                    .map(str::to_string)
            }
        })
        .unwrap_or_default();
    FontKey {
        family,
        bold: cs.bold,
        italic: cs.italic,
    }
}

/// One line at `text_pos` with line `height` (HWPUNIT, already resolved via the metrics provider's
/// `line_height`), content `width` (vert_pos filled by the caller).
fn mk_line(text_pos: u32, height: f64, width: f64) -> LineSeg {
    let h = height.max(1.0);
    LineSeg {
        text_pos,
        vert_pos: 0.0,
        vert_size: h,
        text_height: h,
        baseline: h * BASELINE_RATIO,
        horz_pos: 0.0,
        horz_size: width,
    }
}

/// 글자 없는 문단의 줄 높이 기준 EM (HWPUNIT) — 그 문단이 **가지고 있는** 글자 모양의 크기를
/// 쓴다(빈 문단도 charPr 참조는 남는다). 런이 하나도 없으면 10pt(1000) 기본값.
///
/// 왜 필요한가(074): 빈 줄을 무조건 1000 으로 잡으면 5pt 짜리 간격 문단(정부 양식이 표 사이를
/// 벌릴 때 흔히 쓴다)이 2배로 부풀어, 표가 많은 문서에서 페이지가 통째로 밀린다.
fn empty_para_size(p: &Paragraph, doc: &SemanticDoc) -> i32 {
    p.runs
        .iter()
        .filter_map(|r| doc.char_shapes.get(r.char_shape))
        .map(|c| c.height)
        .find(|&h| h > 0)
        .unwrap_or(1000)
}

/// Line advance as a multiple of the glyph size, from the paragraph's percent line spacing
/// (default ≈ 160%). Fixed/min spacing types fall back to the default for now.
pub(crate) fn line_spacing_ratio(p: &Paragraph, doc: &SemanticDoc) -> f64 {
    match doc.para_shapes.get(p.para_shape) {
        Some(s) if s.line_spacing_type == LineSpacingType::Percent && s.line_spacing_value > 0 => {
            s.line_spacing_value as f64 / 100.0
        }
        _ => DEFAULT_LINESPACE,
    }
}

/// Placeholder metrics provider (flat ~0.5em). Prefer [`ApproxFontMetrics`] (per-script).
#[derive(Default)]
pub struct NullFontMetrics;

impl FontMetricsProvider for NullFontMetrics {
    fn advance_width(&self, _font: &FontKey, _ch: char, size_hwpunit: i32) -> f64 {
        size_hwpunit as f64 * 0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text(text.into())],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn full_width_classification() {
        assert!(is_full_width('가') && is_full_width('한') && is_full_width('漢'));
        assert!(!is_full_width('a') && !is_full_width('1') && !is_full_width(' '));
    }

    #[test]
    fn approx_metrics_per_script() {
        let m = ApproxFontMetrics;
        let f = plain_font();
        assert_eq!(m.advance_width(&f, '가', 1000), 1000.0); // full EM
        assert_eq!(m.advance_width(&f, 'a', 1000), 500.0); // half EM
        assert_eq!(m.advance_width(&f, ' ', 1000), 300.0); // space
    }

    #[test]
    fn hangul_breaks_to_expected_line_count() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // index 0 default → size 1000
                                                    // 30 Hangul syllables at 1000 (1 EM each) → 30000 HWPUNIT of text.
        let p = para(&"가".repeat(30));
        // line width 10000 → 10 full-width glyphs/line → 3 lines.
        let lines = layout_paragraph(&p, &doc, 10000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 3, "30 glyphs / 10 per line = 3 lines");
        assert_eq!(lines[0].text_pos, 0);
        assert_eq!(lines[1].text_pos, 10);
        assert_eq!(lines[2].text_pos, 20);
    }

    #[test]
    fn jangpyeong_ratio_compresses_advances_and_fits_more_per_line() {
        // 장평 (CharShape.ratio) scales the line-break advance: at 50% each full-width glyph advances
        // 500 (not 1000), so twice as many fit per line → fewer lines. Regression for the dense gov-doc
        // cell over-wrap (consent/자가진단 tables compress to ratio 90–98%). 자간 0 here isolates 장평.
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape {
            ratio: PerScript::uniform(50),
            ..Default::default()
        }); // 50% 장평
        let p = para(&"가".repeat(30));
        // width 10000: at 50% 장평, 20 glyphs/line → 2 lines (vs 3 lines at 100% — see hangul_breaks_*).
        let lines = layout_paragraph(&p, &doc, 10000.0, &ApproxFontMetrics);
        assert_eq!(
            lines.len(),
            2,
            "50% 장평 packs 20 glyphs/line → 2 lines (3 at full width)"
        );
        assert_eq!(lines[1].text_pos, 20);
    }

    #[test]
    fn newline_is_a_forced_line_break() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // "1. 문제 인식\n(Problem)" — the '\n' must split into exactly two lines regardless of width,
        // and must NOT be drawn (it's consumed). A wide line_width proves the break is forced, not
        // width-driven.
        let p = para("문제\n(Problem)");
        let lines = layout_paragraph(&p, &doc, 100000.0, &ApproxFontMetrics);
        assert_eq!(
            lines.len(),
            2,
            "'\\n' forces a second line even when everything fits one line"
        );
        assert_eq!(lines[0].text_pos, 0, "line 1 starts at the beginning");
        // chars: 문(0) 제(1) \n(2) ((3)... → line 2 starts AFTER the '\n', at index 3.
        assert_eq!(
            lines[1].text_pos, 3,
            "line 2 starts after the consumed '\\n'"
        );
    }

    #[test]
    fn kinsoku_char_sets_match_rhwp() {
        // 줄머리 금칙 (may NOT begin a line) — sampled from the rhwp set.
        assert!(is_line_start_forbidden(')'));
        assert!(is_line_start_forbidden('.'));
        assert!(is_line_start_forbidden(','));
        assert!(is_line_start_forbidden('!'));
        assert!(is_line_start_forbidden('%'));
        assert!(is_line_start_forbidden('\u{3002}')); // 。
        assert!(is_line_start_forbidden('\u{FF09}')); // ）
        assert!(!is_line_start_forbidden('가'));
        assert!(!is_line_start_forbidden('A'));
        // '(' is a TAIL rule, not a head rule.
        assert!(!is_line_start_forbidden('('));
        // 줄꼬리 금칙 (may NOT end a line) — sampled from the rhwp set.
        assert!(is_line_end_forbidden('('));
        assert!(is_line_end_forbidden('['));
        assert!(is_line_end_forbidden('$'));
        assert!(is_line_end_forbidden('\u{20A9}')); // ₩
        assert!(is_line_end_forbidden('\u{300C}')); // 「
        assert!(is_line_end_forbidden('\u{FF08}')); // （
        assert!(!is_line_end_forbidden('가'));
        assert!(!is_line_end_forbidden(')')); // closing bracket is a HEAD rule, not a tail rule
    }

    #[test]
    fn kinsoku_is_a_noop_without_boundary_chars() {
        // Plain Hangul: neither the next line's head nor this line's tail is a 금칙 char → unchanged.
        let chars: Vec<(char, i32)> = "가나다라".chars().map(|c| (c, 1000)).collect();
        assert_eq!(kinsoku_adjust(&chars, 0, 2, chars.len()), 2);
        // A trailing break (no following line) is always left alone.
        assert_eq!(kinsoku_adjust(&chars, 0, 4, chars.len()), 4);
    }

    #[test]
    fn line_head_kinsoku_hangs_closing_paren_up() {
        let mut doc = SemanticDoc::default();
        // size 1000 → 1 EM per full-width glyph. 가나다 fills width 3000; the greedy break would put
        // the fullwidth ） (U+FF09) at the head of the next line — 줄머리 금칙 hangs it UP with its word.
        doc.char_shapes.push(CharShape::default());
        let p = para("가나다）라");
        let lines = layout_paragraph(&p, &doc, 3000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text_pos, 0);
        // Without 금칙 the break is at index 3 (next line "）라"); 금칙 pulls ） up → line 2 starts at 라.
        assert_eq!(lines[1].text_pos, 4);
    }

    #[test]
    fn line_tail_kinsoku_pushes_opening_paren_down() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // 가나（ fills width 3000; the greedy break would leave the fullwidth 여는 괄호 （ (U+FF08) at
        // the tail of this line. 줄꼬리 금칙 pushes it DOWN so it leads the next line.
        let p = para("가나（다라");
        let lines = layout_paragraph(&p, &doc, 3000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text_pos, 0);
        // Without 금칙 line 1 = "가나（"; 금칙 pushes （ down → line 2 starts at index 2 (the （).
        assert_eq!(lines[1].text_pos, 2);
    }

    #[test]
    fn missing_glyph_dot_variants_map_to_middle_dot() {
        // NanumGothic lacks U+2024 (one-dot leader) / U+30FB (katakana middle dot); they're used as
        // separators ("제품·서비스") in gov forms. subst_glyph maps them to U+00B7 so they render.
        assert_eq!(subst_glyph('\u{2024}'), '·');
        assert_eq!(subst_glyph('\u{30FB}'), '·');
        assert_eq!(
            subst_glyph('·'),
            '·',
            "an already-present middle dot is unchanged"
        );
        assert_eq!(subst_glyph('가'), '가', "ordinary glyphs pass through");
    }

    #[test]
    fn latin_breaks_at_word_boundary() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // "aaaa bbbb cccc": each letter 500, space 300.
        let p = para("aaaa bbbb cccc");
        // width 5000: "aaaa "(2300) + "bbbb "(2300) = 4600 fits; "cccc"(2000)→6600 > 5000 → wrap.
        let lines = layout_paragraph(&p, &doc, 5000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2, "wraps at a space, not mid-word");
        assert_eq!(
            lines[1].text_pos, 10,
            "line 2 starts at 'cccc' (after 'aaaa bbbb ')"
        );
    }

    #[test]
    fn approx_line_height_is_bare_em() {
        // The DEFAULT provider keeps the flat-EM line height (no calibration) so the default build's
        // pagination is byte-for-byte what it was before the shaper's vmetrics path landed.
        let m = ApproxFontMetrics;
        assert_eq!(m.line_height(1000), 1000.0);
        assert_eq!(m.line_height(1200), 1200.0);
    }

    /// A metrics provider that reports a taller-than-EM line height (like a real Korean face),
    /// to verify `layout_paragraph` honors `line_height` for the line box.
    struct TallLines;
    impl FontMetricsProvider for TallLines {
        fn advance_width(&self, _f: &FontKey, ch: char, size: i32) -> f64 {
            ApproxFontMetrics.advance_width(_f, ch, size)
        }
        fn line_height(&self, size: i32) -> f64 {
            size.max(1) as f64 * 1.2 // 1.2 EM leading
        }
    }

    #[test]
    fn line_height_provider_drives_lineseg_height() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // size 1000
        let p = para("가나다");
        let flat = layout_paragraph(&p, &doc, 10000.0, &ApproxFontMetrics);
        let tall = layout_paragraph(&p, &doc, 10000.0, &TallLines);
        assert_eq!(flat.len(), 1);
        assert_eq!(tall.len(), 1);
        assert!(
            (flat[0].vert_size - 1000.0).abs() < 1.0,
            "flat = 1 EM, got {}",
            flat[0].vert_size
        );
        assert!(
            (tall[0].vert_size - 1200.0).abs() < 1.0,
            "tall = 1.2 EM, got {}",
            tall[0].vert_size
        );
        // Line breaking (advances) is identical — only the box height changed.
        assert_eq!(flat[0].text_pos, tall[0].text_pos);
    }

    #[test]
    fn table_height_sums_row_content() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // size 1000
                                                    // 3-row × 1-col table, one short line per cell. A SINGLE-line cell has no inter-line gap, so
                                                    // Hancom reserves just the bare EM + CELL_PAD — the line-spacing leading is NOT applied to a
                                                    // lone/last line (issue 020: `cell_paragraph_height` trims the trailing leading).
        let mut t = Table {
            rows: 3,
            cols: 1,
            ..Default::default()
        };
        for r in 0..3 {
            t.cells.push(Cell {
                row: r,
                col: 0,
                row_span: 1,
                col_span: 1,
                active: true,
                blocks: vec![Block::Paragraph(para("셀"))],
                ..Default::default()
            });
        }
        let h = table_height(&t, 40000.0, &doc, &ApproxFontMetrics);
        let per_row = 1000.0 + CELL_PAD; // one bare EM (no trailing leading) + vertical padding
        assert!(
            (h - 3.0 * per_row).abs() < 1.0,
            "3 rows × (EM+pad): got {h}"
        );
    }

    // ── 이슈 074 회귀 ────────────────────────────────────────────────────────────────────────
    // 세 갈래를 잠근다: ① 본문 상자(머리말/꼬리말/제본 여백) ② 병합 셀 행 높이 ③ 저장 행높이 바닥
    // ④ 빈 문단 EM. 넷 다 "쪽수를 조용히 줄이던" 과소 계산이었다.

    #[test]
    fn body_box_subtracts_header_footer_and_gutter() {
        // 한컴 규칙: 본문 위 = top + header, 아래 = bottom + footer, 왼쪽 = left + gutter
        // (rhwp `PageAreas::from_page_def_for_page` 와 동일). benchmark1 실측값으로 확인.
        let page = PageSetup {
            width: 59528,
            height: 84188,
            margin_left: 5669,
            margin_right: 5669,
            margin_top: 4251,
            margin_bottom: 2834,
            margin_header: 2834,
            margin_footer: 2834,
            margin_gutter: 0,
            landscape: false,
            columns: 1,
        };
        let (x, y, w, h) = body_box(&page);
        assert_eq!(
            (x, y),
            (5669.0, 7085.0),
            "본문 원점 = (left+gutter, top+header)"
        );
        assert_eq!(w, 48190.0);
        assert_eq!(h, 71435.0, "84188 − (4251+2834) − (2834+2834)");
        // 머리말/꼬리말이 0이면 예전(단순 위/아래 여백) 계산과 동일 — 기존 문서 회귀 없음.
        let plain = PageSetup {
            margin_header: 0,
            margin_footer: 0,
            ..page
        };
        assert_eq!(body_box(&plain).3, 77103.0);
        // 제본 여백은 왼쪽으로 들어간다.
        let bound = PageSetup {
            margin_gutter: 1000,
            ..page
        };
        assert_eq!((body_box(&bound).0, body_box(&bound).2), (6669.0, 47190.0));
    }

    #[test]
    fn display_paper_swaps_hwp5_landscape_portrait_box() {
        let mut page = PageSetup {
            width: 59528,
            height: 84188,
            landscape: true,
            ..Default::default()
        };
        assert_eq!(display_paper(&page), (84188, 59528));
        page.landscape = false;
        assert_eq!(display_paper(&page), (59528, 84188));
        // HWPX already stores display size — do not double-swap.
        page.width = 84188;
        page.height = 59528;
        page.landscape = true;
        assert_eq!(display_paper(&page), (84188, 59528));
    }

    /// 세로 병합 셀은 **덮는 행들의 합이 모자랄 때만** 부족분을 더한다 — 균등 분배 금지.
    #[test]
    fn row_span_cell_tops_up_instead_of_averaging() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // 1000 EM
        let mut t = Table {
            rows: 2,
            cols: 2,
            ..Default::default()
        };
        // c0: 2행 병합, 저장 높이 20000(=한 줄 내용보다 훨씬 큼) → 두 행의 하한 총합만 만든다.
        t.cells.push(Cell {
            row: 0,
            col: 0,
            row_span: 2,
            col_span: 1,
            active: true,
            blocks: vec![Block::Paragraph(para("병합"))],
            ..Default::default()
        });
        // 각 행의 오른쪽 칸: 한 줄짜리.
        for r in 0..2 {
            t.cells.push(Cell {
                row: r,
                col: 1,
                row_span: 1,
                col_span: 1,
                active: true,
                blocks: vec![Block::Paragraph(para("한줄"))],
                ..Default::default()
            });
        }
        // 행 하한(저장 높이): r0 = 9000, r1 = 1500 (한컴이 실제로 이렇게 저장한다 — 균등하지 않다)
        t.row_heights = vec![9000, 1500];
        let rows = table_row_heights(&t, 40000.0, &doc, &ApproxFontMetrics);
        assert_eq!(
            (rows[0], rows[1]),
            (9000.0, 1500.0),
            "병합 셀이 짧은 행(1500)을 평균치로 부풀리면 안 된다 — 균등 분배 시 둘 다 5250이 된다"
        );
        // 병합 셀이 두 행 합보다 크면 그때만 마지막 행이 늘어난다.
        let mut tall = t.clone();
        tall.cells[0].blocks = vec![Block::Paragraph(para(&"가".repeat(60)))]; // 여러 줄
        let rows2 = table_row_heights(&tall, 40000.0, &doc, &ApproxFontMetrics);
        assert_eq!(rows2[0], 9000.0, "부족분은 마지막 덮는 행에만 더한다");
        assert!(rows2[1] > 1500.0, "합이 모자라면 마지막 행이 늘어난다");
    }

    /// `row_heights` 가 비어 있어도 `stored_row_heights`(자동 맞춤 표의 저장 높이)가 바닥이 된다.
    /// #196 은 이 바닥을 껐다가 HWPX 경로 쪽수를 20% 과소 계산했다(이슈 074).
    #[test]
    fn stored_row_heights_are_a_floor_when_row_heights_is_empty() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        let mut t = Table {
            rows: 1,
            cols: 1,
            ..Default::default()
        };
        t.cells.push(Cell {
            row: 0,
            col: 0,
            row_span: 1,
            col_span: 1,
            active: true,
            blocks: vec![Block::Paragraph(para("짧음"))],
            ..Default::default()
        });
        let bare = table_height(&t, 40000.0, &doc, &ApproxFontMetrics);
        assert!(bare < 5000.0, "내용 기준 높이는 작다: {bare}");
        t.stored_row_heights = vec![9000];
        let floored = table_height(&t, 40000.0, &doc, &ApproxFontMetrics);
        assert_eq!(floored, 9000.0, "저장 행높이가 바닥으로 걸려야 한다");
        // 명시 row_heights 가 있으면 그쪽이 우선.
        t.row_heights = vec![12000];
        assert_eq!(table_height(&t, 40000.0, &doc, &ApproxFontMetrics), 12000.0);
    }

    /// 빈 문단의 줄 높이는 **그 문단의 글자 크기** × 줄간격 — 1000 고정이 아니다.
    #[test]
    fn empty_paragraph_uses_its_own_char_size() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // 0: 1000
        doc.char_shapes.push(CharShape {
            height: 500,
            ..Default::default()
        }); // 1: 500 (5pt 간격 문단)
        let small = Paragraph {
            runs: vec![Run {
                char_shape: 1,
                content: Vec::new(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let lines = layout_paragraph(&small, &doc, 10000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].vert_size, 500.0, "빈 줄 = 그 문단 글자 크기");
        // 런이 아예 없으면 10pt 기본값(예전 동작) 유지.
        let bare = Paragraph::default();
        assert_eq!(
            layout_paragraph(&bare, &doc, 10000.0, &ApproxFontMetrics)[0].vert_size,
            1000.0
        );
    }

    #[test]
    fn cell_paragraph_trims_only_the_trailing_leading() {
        // A cell paragraph reserves (n−1) inter-line gaps at `ratio` + the last line's BARE box, so a
        // 2-line cell = EM + EM×ratio (one gap), NOT 2×EM×ratio. Guards the issue-020 mechanism against
        // regressing back to the "leading on every line" over-reservation. Width forces exactly 2 lines.
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // size 1000, full-width glyph advance = 1000
        let p = para("가나"); // two full-width glyphs
        let two_line_w = 1500.0; // one glyph per line (1000 fits, 2000 doesn't)
        let lines = layout_paragraph(&p, &doc, two_line_w, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2, "width forces two lines");
        let h = cell_paragraph_height(&p, &doc, two_line_w, &ApproxFontMetrics);
        let ratio = DEFAULT_LINESPACE; // 1.6 (no explicit percent spacing)
        let want = 1000.0 * ratio + 1000.0; // one gap at ratio + last bare box
        assert!(
            (h - want).abs() < 1.0,
            "2-line cell = EM×ratio + EM ({want}); got {h}"
        );
        // Sanity: strictly less than the old "ratio on every line" reserve.
        assert!(
            h < 2.0 * 1000.0 * ratio,
            "trimmed height is below the untrimmed 2×EM×ratio"
        );
    }

    #[test]
    fn page_break_before_forces_a_new_page() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default()); // index 0 = plain default
                                                    // ParaShape index 1 carries 쪽-나누기-앞에서.
        doc.para_shapes.push(ParaShape {
            page_break_before: true,
            ..Default::default()
        });
        let mut sec = Section::default();
        sec.blocks.push(Block::Paragraph(para("first")));
        let mut second = para("second");
        second.para_shape = 1;
        sec.blocks.push(Block::Paragraph(second));
        doc.sections.push(sec);
        let res = NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap();
        assert_eq!(
            res.pages.len(),
            2,
            "page-break-before splits two short paragraphs onto 2 pages"
        );
    }

    #[test]
    fn paginates_when_content_exceeds_body_height() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // A4 portrait body ≈ 84188 - 2*7200 = 69788; line advance ≈ 1000*1.6 = 1600 → ~43 lines/page.
        let mut sec = Section::default();
        for _ in 0..100 {
            sec.blocks.push(Block::Paragraph(para("한 줄")));
        }
        doc.sections.push(sec);
        let res = NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap();
        assert!(
            res.pages.len() >= 2,
            "100 lines must paginate: got {} pages",
            res.pages.len()
        );
        for pg in &res.pages {
            for ls in &pg.lines {
                assert!(
                    ls.vert_pos < pg.height,
                    "every line sits within its page body"
                );
            }
        }
    }

    /// Issue 062-follow (AI-generated charts): an inserted `Inline::Chart` reserves its FIXED box in
    /// BOTH `NaiveLayout` (the oracle, via `object_height`) and `place_doc` (via `paragraph_object`), so
    /// their page counts stay in LOCKSTEP — the same fixed-box discipline a lifted OOXML chart (062-7)
    /// gets. A tall chart sandwiched in body text must paginate identically in both engines, and the
    /// chart must actually land on the own-render surface as a `PlacedImage` carrying its SVG.
    #[test]
    fn inserted_chart_box_keeps_place_doc_and_naive_layout_in_lockstep() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let mut sec = Section::default();
        for _ in 0..30 {
            sec.blocks.push(Block::Paragraph(para("한 줄")));
        }
        // A tall chart box (40000 HWPUNIT) — the SAME shape a generated chart produces (empty bin_ref +
        // precomputed SVG on the object channel).
        let mut chart_para = Paragraph::default();
        chart_para.runs.push(Run {
            char_shape: 0,
            content: vec![Inline::Chart(ChartRef {
                width: 30000,
                height: 40000,
                treat_as_char: true,
                rendered_svg: Some("<g class=\"hwp-gen-chart\"><rect/></g>".into()),
            })],
            ..Default::default()
        });
        sec.blocks.push(Block::Paragraph(chart_para));
        for _ in 0..30 {
            sec.blocks.push(Block::Paragraph(para("한 줄")));
        }
        doc.sections.push(sec);

        let oracle = NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(
            oracle,
            placed.pages.len(),
            "chart box reserved identically in NaiveLayout and place_doc (LOCKSTEP)"
        );
        assert!(
            oracle >= 2,
            "the tall chart forces pagination: {oracle} pages"
        );

        // The chart lands as a PlacedImage on the object channel (empty bin_ref) carrying its SVG.
        let chart_img = placed
            .pages
            .iter()
            .flat_map(|p| &p.images)
            .find(|im| {
                im.svg
                    .as_deref()
                    .map(|s| s.contains("hwp-gen-chart"))
                    .unwrap_or(false)
            })
            .expect("chart placed as a PlacedImage carrying its precomputed SVG");
        assert!(
            chart_img.bin_ref.is_empty(),
            "chart rides the empty-bin_ref object channel (like a 062 OOXML chart)"
        );
        assert!(
            (chart_img.h - 40000.0).abs() < 1.0,
            "the reserved box height is honored on the placed surface"
        );
    }

    #[test]
    fn mixed_inline_objects_wrap_in_source_order_with_per_line_height() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        let equation = |script: &str, height| {
            Inline::Equation(EquationRef {
                script: script.into(),
                font: String::new(),
                base_unit: 1000,
                baseline: 0,
                color: Color::default(),
                width: 900,
                height,
                treat_as_char: true,
                version: String::new(),
                rendered_svg: None,
            })
        };
        let paragraph = Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![
                    Inline::Text("A".into()),
                    equation("EqA", 1300),
                    Inline::Text("B".into()),
                    equation("EqB", 1800),
                    Inline::Text("C".into()),
                    Inline::Chart(ChartRef {
                        width: 900,
                        height: 1600,
                        treat_as_char: true,
                        rendered_svg: None,
                    }),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };

        let lines = layout_paragraph(&paragraph, &doc, 2000.0, &ApproxFontMetrics);
        assert_eq!(
            lines.len(),
            3,
            "objects take width and wrap as ordered atoms"
        );
        assert_eq!(
            lines.iter().map(|line| line.text_pos).collect::<Vec<_>>(),
            [0, 3, 5]
        );
        assert_eq!(lines[0].vert_size, 1300.0);
        assert_eq!(lines[1].vert_size, 1800.0);
        assert_eq!(lines[2].vert_size, 1600.0);
    }

    #[test]
    fn floating_equation_keeps_anchor_without_affecting_line_metrics() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        let paragraph = Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![
                    Inline::Text("A".into()),
                    Inline::Equation(EquationRef {
                        script: "floating".into(),
                        font: String::new(),
                        base_unit: 1000,
                        baseline: 0,
                        color: Color::default(),
                        width: 5000,
                        height: 9000,
                        treat_as_char: false,
                        version: String::new(),
                        rendered_svg: None,
                    }),
                    Inline::Text("B".into()),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let lines = layout_paragraph(&paragraph, &doc, 1100.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].horz_size, 1000.0);
        assert_eq!(lines[0].vert_size, 1000.0);
    }

    /// A doc with NO chart is byte-identical to before (the chart path is purely additive): the two
    /// engines agree on the same page count as they did pre-062-follow.
    #[test]
    fn no_chart_doc_pagination_is_unchanged() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        let mut sec = Section::default();
        for _ in 0..100 {
            sec.blocks.push(Block::Paragraph(para("한 줄")));
        }
        doc.sections.push(sec);
        let oracle = NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        let placed = place_doc(&doc, &ApproxFontMetrics).pages.len();
        assert_eq!(oracle, placed, "no-chart doc stays in lockstep");
    }
}
