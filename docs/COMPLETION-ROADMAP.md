# auto-hwp 완성형 로드맵 (design workflow 산출물, 17 agents)

> Hancom HWP/Hancom Docs 에디터 기능 → OWPML → auto-hwp 합성 아키텍처. 사실검증(adversarial verify) 통과 기준.

## Foundation

The shared foundation is a HEADER-SYNTHESIS LAYER that converts header.xml from "byte-copied verbatim" into "parse → mutate → reserialize", with one interner per pool. Concrete Rust changes:

(1) PARSE SIDE — hwp-hwpx/src/parse.rs. Today parse_semantic hardcodes `Run { char_shape: 0 }` and never fills doc.char_shapes/para_shapes; styles are invisible. Add: (a) parse_header_pools() that reads the existing <hh:charProperties>/<hh:paraProperties>/<hh:borderFills>/<hh:fontfaces>/<hh:numberings>/<hh:bullets>/<hh:styles> into in-memory structs, populating SemanticDoc.char_shapes / para_shapes with the REAL existing entries (so index N == OWPML id N for dense pools), and mapping each parsed run's charPrIDRef → char_shapes index, each hp:p's paraPrIDRef → para_shapes index. (b) A read-only StyleIndex { by_name: BTreeMap<String,StyleRef>, by_eng: ... } where StyleRef={id,para_pr_idref,char_pr_idref,kind} — exact-string keys incl. the U+0020 ("개요 1","Outline 1"). (c) An OutlineIndex resolving requested outline level L → the paraPr id whose <hh:heading type="OUTLINE" level="L"> matches, by SCANNING (never arithmetic — levels are non-contiguous/reversed across docs). Store all three on SemanticDoc (new fields: pub style_index, pub outline_index, pub header_pools: HeaderPools snapshot).

(2) MODEL SIDE — hwp-model/src/style.rs + document.rs. Extend CharShape with the missing OWPML payload: face name(s) per script (Option<PerScript<String>> resolved to face_id via FontInterner), underline_type(NONE/BOTTOM/CENTER/TOP), underline_shape(LineType2 14-enum), strikeout_shape(LineType2), sym_mark, border_fill_id (charPr also carries one). Extend ParaShape with line_wrap(BREAK/SQUEEZE), condense:u8, auto_spacing(eAsianEng/eAsianNum), tab_pr_id, a Border struct {sides,style,width_mm,color} and shade_color. Add Paragraph.style_id: Option<usize> (document.rs) so per-para styleIDRef stops being hardcoded. Add Cell fields: shade_color: Option<Color>, borders: Option<CellBorders>, v_align: VAlign. Add Table.caption: Option<Caption{text,side,auto_num}> and Table.repeat_header: bool; Cell already has row_span/col_span/active.

(3) SYNTH SIDE — hwp-hwpx/src/synth.rs (the load-bearing rewrite). Generalize the existing default_char_pr/max_pool_id/patch_pool/synthesize_char_pr into a HeaderSynth pass that, in ONE patch of header.xml, can append to MULTIPLE pools and bump each itemCnt independently. Build proper INTERNERS keyed on the FULL normalized tuple so a synthesized shape that equals an existing pool entry reuses that id (the parse-side pools seed the interner — this both dedups against Hancom's own entries AND fixes the "bold reuses colored id=7" bug). FontInterner.ensure(face,lang) → adds <hh:font> with dense id to all 7 <hh:fontface>, bumps each fontCnt (fontfaces itemCnt stays 7), prefers reusing an existing face id. CharPrInterner → completes synthesize_char_pr: emit the 4 required children ratio/spacing/relSz/offset EACH with all 7 per-script attrs (defaults 100/0/100/0), strict child order fontRef,ratio,spacing,relSz,offset,[italic],[bold],underline,strikeout,outline,shadow,[emboss],[engrave],[supscript|subscript], emit shadeColor="none" when off, symMark="NONE", useFontSpace/useKerning as 0/1, reuse an existing borderFillIDRef. ParaPrInterner → CharShape's sibling: emit align→heading→breakSetting→autoSpacing→hp:switch(hp:case[required-namespace HwpUnitChar]{margin{intent,left,right,prev,next}, lineSpacing} + hp:default{same, geometry DOUBLED})→border LAST; always emit heading(NONE,0,0)+autoSpacing(0,0); border.borderFillIDRef must resolve to a discovered no-border fill (scan for all-NONE borderFill; never assume 0). BorderFillInterner (SHARED by paraPr borders, charPr, table cells) keyed on (slash,backSlash,4 borders,diagonal,fillBrush); ids base 1. NumberingInterner/BulletInterner for the list domain. A byte/XSD PRE-FILTER must WHITELIST shadeColor="none" and the literal charPrIDRef="4294967295".

(4) OPS SIDE — hwp-ops/src/lib.rs. Implement the already-declared SetCharPr/SetParaPr/ApplyStyle and add per-block shape carrying. Extend RunSpec with the new char fields. Implement apply for the new structural ops (AppendOrderedList/AppendBulletList/AppendMultiLevelList, ApplyStyleByName, SetOutlineLevel, AppendTable-with-spans/shading/caption). apply mutates the AST + marks header AND section dirty.

(5) AI SIDE — hwp-ai/src/content.rs. Grow AiRun (new run fields) and AiBlock (heading{level}, ordered_list, bullet_list, real divider, table with cells[]/caption), update template_brief + compile_to_ops to emit the new ops. parse_content stays serde-validated.

(6) SERIALIZER WIRING — hwp-hwpx/src/serialize.rs. build_synth_plan grows from charPr-only to a multi-pool SynthPlan {char_ref,para_ref,style_ref,...fragments per pool}; the header-patch step calls patch_pool once per dirty pool; patch_section_xml + emit_paragraph stop hardcoding styleIDRef="0"/last_attr paraPrIDRef and instead emit each para's resolved paraPrIDRef + styleIDRef; emit_table reads per-cell shape/span/shade/valign and suppresses fully-covered <hp:tr>.

Without (1)-(3) NOTHING in char/para/style/list domains can be controlled, because every feature reduces to "synthesize a valid header pool entry and reference it"; this is why it is the single P0 prerequisite for all seven domains.

## Phases


### P1. P0 Foundation A — header parse-in + dirty/reserialize plumbing  (deps=[])
- features: Parse existing header pools into SemanticDoc (char_shapes/para_shapes seeded with REAL entries, index==id); Map run charPrIDRef → char_shapes idx, hp:p paraPrIDRef → para_shapes idx (stop hardcoding char_shape:0); Generalize synth::patch_pool to multi-pool single-pass header patch + per-pool itemCnt bump; SynthPlan grows to {char_ref,para_ref,...} with per-pool fragment buffers; Pre-filter whitelist for shadeColor="none" and charPrIDRef="4294967295"
- deliverable: hwp-hwpx/src/parse.rs: new parse_header_pools() + HeaderPools struct populating doc.char_shapes/para_shapes and the IDRef→index maps. hwp-model/src/document.rs: add header_pools snapshot field. hwp-hwpx/src/serialize.rs: SynthPlan becomes multi-pool; build_synth_plan refactored to drive a generic per-pool patch. hwp-hwpx/src/synth.rs: patch_pools(header, Vec<(container, fragments, added)>) one-pass.
- oracle_check: Round-trip FormattingShowcase.hwpx with NO edits → byte-stable-enough that LibreOffice+H2Orestart opens and plain_text matches; then append one plain paragraph and confirm it reuses a real parsed charPrIDRef (not a guessed last_attr) and renders.

### P2. P0 Foundation B — complete CharPr synthesis + interner (fixes #1 bold-blue gap)  (deps=[1])
- features: 글자 크기 (height); 글자색 (textColor); 음영색 (shadeColor, none-default); 진하게 (bold) — pure bold, no inherited color; 기울임 (italic); 밑줄 +종류/모양/색 (underline triple, LineType2 14-enum); 취소선 +모양/색 (strikeout); 외곽선/그림자/양각/음각/위·아래첨자 (tail group, schema order)
- deliverable: hwp-model/src/style.rs: extend CharShape (underline_type/shape, strikeout_shape, sym_mark, border_fill_id, per-script payload). hwp-hwpx/src/synth.rs: rewrite synthesize_char_pr to emit ALL 4 required children (7 per-script attrs each), full strict child order incl tail markers, shadeColor="none", symMark/useFontSpace/useKerning, reused borderFillIDRef; add CharPrInterner seeded from parsed pool (dedup, replaces find_bold_charpr hack). hwp-ops/src/lib.rs: extend RunSpec + RunSpec::to_char_shape with new fields; implement SetCharPr apply. hwp-ai/src/content.rs: extend AiRun + template_brief.
- oracle_check: Author a paragraph with runs {bold}, {bold+color #C00000}, {italic+underline BOTTOM SOLID #0000FF}, {strike}, {size_pt 16}, {highlight #FFF2CC}; render and visually confirm bold is BLACK (not blue), color/underline/strike/highlight/size all correct, child order valid (oracle accepts).

### P3. P0 Foundation C — font family per-script + FontInterner  (deps=[2])
- features: 글꼴(언어별) — Font family per script (hangul/latin/...)
- deliverable: hwp-hwpx/src/synth.rs: FontInterner.ensure(face,lang) adds <hh:font id face type=TTF isEmbedded=0><hh:typeInfo FCAT_GOTHIC.../></hh:font> to each of 7 <hh:fontface>, bumps each fontCnt, dedups by name per pool, prefers reusing existing id 0/1. CharShape.face_id wired through CharPrInterner (fontRef points at resolved ids). hwp-ai/src/content.rs: AiRun.font:Option<String> or fonts:{hangul,latin}.
- oracle_check: Author runs with font "맑은 고딕" (reuse-existing path) and a family NOT in the pool (new-font path); render and confirm the requested face renders without tofu — and if new-font is unreliable in the oracle, gate the feature to reuse-only.

### P4. P1 Core — paragraph shape synthesis (align/spacing/indent/break/border)  (deps=[1])
- features: 정렬 (justify/left/right/center/배분/나눔); 줄 간격 (percent/fixed/atleast); 왼쪽/오른쪽 여백; 첫 줄 들여쓰기/내어쓰기 (intent, doubling); 문단 위/아래 간격 (prev/next); 줄 나눔/글자단위 줄바꿈 (breakSetting 7 attrs); 문단 앞에서 쪽 나눔 (pageBreakBefore); 문단 테두리/배경 음영
- deliverable: hwp-model/src/style.rs: extend ParaShape (line_wrap, condense, auto_spacing, tab_pr_id, Border, shade_color). hwp-hwpx/src/synth.rs: ParaPrInterner emitting strict child order align→heading→breakSetting→autoSpacing→hp:switch(case+DOUBLED default for margin/intent, lineSpacing not doubled)→border LAST; always heading(NONE,0,0)+autoSpacing(0,0); border.borderFillIDRef = discovered no-border fill; BorderFillInterner (shared, base id 1). hwp-ops/src/lib.rs: implement SetParaPr; add per-block ParaShapeSpec on Append*Paragraph. hwp-hwpx/src/serialize.rs: emit_paragraph uses resolved per-para paraPrIDRef. hwp-ai/src/content.rs: block-level align/line_spacing/indent_left/indent_right/first_line/space_*/break_*/page_break_before/border/shade.
- oracle_check: Author paragraphs: center-aligned, 160% line spacing, left-indent 10mm + hanging first-line, 12pt space-before, and one with a SOLID 0.12mm box border + #FFF2CC shade; render and confirm geometry + border + shading; confirm hp:switch default doubling matches Hancom.

### P5. P0 Core — named styles + outline levels (apply by name)  (deps=[1, 2, 4])
- features: 한컴 기본 스타일 이름으로 적용 (바탕글/본문/개요 1..7); 개요 수준 적용 (heading numbering linkage); 개요 번호 형식 (reuse numbering id=1; custom DEFERRED)
- deliverable: hwp-hwpx/src/parse.rs: StyleIndex (exact-string incl space) + OutlineIndex (scan heading type=OUTLINE level). hwp-model/src/document.rs: Paragraph.style_id:Option<usize>. hwp-ops/src/lib.rs: Op::ApplyStyleByName{section,block_idx,style_name} + Op::SetOutlineLevel{section,block_idx,level} resolving via the indices; fall back to 바탕글 on miss (resolved, not hardcoded 0). hwp-hwpx/src/serialize.rs: STOP hardcoding styleIDRef="0" (serialize.rs:192/277/326) — emit per-para resolved styleIDRef + paraPrIDRef. hwp-ai/src/content.rs: AiBlock::Heading{level,text} + paragraph "style" field; compile maps heading→plain runs (no fake bold) + SetOutlineLevel.
- oracle_check: Author a doc applying style "본문" to one para and "개요 1"/"개요 2" to two headings; render and confirm the resolved paraPrIDRef/styleIDRef chain resolves (no dangling), outline paras pick the scanned paraPr ids (verify R3 emission is oracle-accepted), idRef stays 0.

### P6. P1 Core — lists: ordered, bullet, multi-level, indentation  (deps=[1, 4, 5])
- features: 번호 매기기 목록 (single-level ordered); 글머리표 목록 (native hh:bullet, replace fake '• '); 여러 수준 번호 매기기 (multi-level, parent-prefix ^1.^2.); 목록 들여쓰기 (paraPr margin+intent hanging); 번호 다시 시작 (restart — EXPERIMENTAL, oracle-gated)
- deliverable: hwp-hwpx/src/synth.rs: NumberingInterner (10 paraHead levels, numFormat allowlist DIGIT/HANGUL_SYLLABLE/CIRCLED_DIGIT/..., charPrIDRef=4294967295) + BulletInterner (CREATE hh:bullets pool between hh:numberings and hh:paraProperties; empty self-closing paraHead level=0 useInstWidth=0, NO checkedChar, ids base 1) + ensure_list_parapr(kind,idRef,level,indent) reusing ParaPrInterner with heading type=NUMBER|BULLET. hwp-ops/src/lib.rs: Op::AppendOrderedList/AppendBulletList/AppendMultiLevelList{...,restart,start}. hwp-ai/src/content.rs: AiBlock ordered_list/bullet_list (items, numFormat, bulletChar, indent, level), real Divider native.
- oracle_check: Author a numbered list (1.2.3.), a bullet list (❏), and a 2-level nested list; render and confirm native auto-markers appear (NOT '• ' text), bullets non-tofu, hanging indent correct, no empty <hp:tr>/dangling idRef; smoke-test marker layout since linesegarray is omitted.

### P7. P1 Advanced — tables: merge, shading, borders, valign, multi-para, caption, repeat-header  (deps=[1, 2, 4])
- features: 셀 합치기 (colSpan/rowSpan, omit covered, suppress empty tr); 셀 배경색/음영 (per-cell borderFill fillBrush); 셀 테두리 (per-edge LineType, enumerated mm width); 셀 세로 정렬 (subList vertAlign); 셀 가로 정렬 (cell para paraPrIDRef); 셀 안 여러 문단 (multi-para, KEEP linesegarray); 표 캡션 (hp:caption after outMargin); 제목 행 반복 (repeatHeader + tc header=1)
- deliverable: hwp-model/src/document.rs: Cell.shade_color/borders/v_align, Table.caption/repeat_header (Cell span/active already present). hwp-hwpx/src/synth.rs: BorderFillInterner extended for cell fills (winBrush faceColor, always-emit diagonal); width snapped to enumerated mm set. hwp-hwpx/src/serialize.rs: emit_table reads per-cell shape/span/shade/border/valign, emits cellSpan, computes anchor cellSz by summing covered widths, SKIPS covered cells, SUPPRESSES zero-cell <hp:tr>, keeps per-para linesegarray in cells, emits <hp:caption> in correct slot, repeatHeader + header=1. hwp-ops/src/lib.rs: AppendTable variant carrying cells with spans/shade/borders/valign/caption. hwp-ai/src/content.rs: rich table block (cells[] with row/col/colSpan/rowSpan/shade/borders/vAlign/paras, caption, repeatHeader).
- oracle_check: Author a table with a 2x2 merged anchor, a shaded header row (#D9D9D9), per-cell borders, center valign, a multi-paragraph cell, a bottom caption, and repeatHeader; render and confirm merge geometry, shading, borders, caption, no empty row, no dangling borderFillIDRef.

### P8. P2 Polish — custom tab stops + custom outline numbering + restart hardening  (deps=[4, 6])
- features: 탭 설정 (탭 종류/위치/채움, per-stop hp:switch tabItem doubling); 개요/문단 번호 사용자 정의 형식 (custom numFormat strings); 번호 다시 시작 (verified field: numbering@start vs paraHead@start)
- deliverable: hwp-hwpx/src/synth.rs: TabPrInterner (new <hh:tabPr> with per-stop hp:switch-wrapped <hh:tabItem> — case pos+unit=HWPUNIT / default pos DOUBLED no-unit; reuse tabPr 0 for none). Op::SetOutlineNumbering editing paraHead bodies/numFormat in-place in numbering id=1. Resolve restart-field ambiguity by oracle A/B test, then lock. hwp-model/src/style.rs: ParaShape.tab_pr_id wired. hwp-ai/src/content.rs: paragraph "tabs":[{pos_pt,type,leader}] + optional outline_numbering custom.
- oracle_check: Author a paragraph with two custom tab stops (right-align + dash leader) and a list with a custom number format + a restart; render and confirm tab positions/leaders, custom format string, and that restart actually resets the counter (whichever start field the A/B test proved).

## Top correctness risks

- DANGLING IDRef = instant oracle reject. Every synthesized charPrIDRef/paraPrIDRef/styleIDRef/borderFillIDRef/numbering/bullet idRef/fontRef id MUST resolve to a pool entry that the SAME export actually wrote. The no-border borderFill is a DISCOVERED id (scan for all-NONE; =2 in FormattingShowcase/Skeleton, =1 elsewhere) — NEVER hardcode 0 (borderFill ids base 1, referencing 0 dangles). Outline paraPr ids are non-contiguous/reversed — resolve by scanning <hh:heading type=OUTLINE level=L>, never arithmetic.
- STRICT CHILD ORDER is schema-enforced and fatal if wrong. charPr: fontRef,ratio,spacing,relSz,offset,[italic],[bold],underline,strikeout,outline,shadow,[emboss],[engrave],[supscript|subscript] (italic BEFORE bold; supscript XOR subscript). paraPr: align→heading→breakSetting→autoSpacing→hp:switch(margin{intent,left,right,prev,next} then lineSpacing)→border LAST. The 4 charPr children ratio/spacing/relSz/offset are REQUIRED, each with all 7 per-script attrs (empty/attr-short = reject).
- itemCnt drift. Every pool's itemCnt must equal its actual child count AFTER synthesis; fontfaces itemCnt stays 7 but each fontface fontCnt bumps; numberings/bullets/styles/charProperties/paraProperties/borderFills/tabProperties each bump independently in the single header-patch pass. A miss is silently corrupt and oracle-rejects.
- Schema-vs-oracle literals the byte/XSD pre-filter must WHITELIST: shadeColor="none" (violates RGBColorType #[0-9A-Fa-f]{6} but real Hancom writes it 3623x and the oracle reads it) and charPrIDRef="4294967295" (0xFFFFFFFF inherit on numbering/bullet paraHead — emit literal decimal, not -1). A naive strict pre-filter will FALSELY reject valid output.
- linesegarray omission is the largest layout-acceptance unknown and is WORSE for lists/markers. Body-para omission is verified-working, but list paragraphs need the renderer to lay out the AUTO marker and cells render 99.8% with linesegarray in real Hancom (and the existing working ai-table.hwpx KEEPS it). Decision: KEEP minimal linesegarray in table cells; smoke-test list-marker recompute before claiming list features pass.
- Bullet/numbering pool synthesized from scratch — ZERO corpus files have hh:bullets and ZERO bodies reference NUMBER/BULLET headings (chain only confirmed from external samples). High risk: bullet glyph inherits the body run font (charPrIDRef=4294967295) so symbol glyphs (❏●◆) may render TOFU if that font lacks them — byte-check won't catch it, only the oracle render will. The off-by-one differs: NUMBER heading level=0→paraHead level=1; BULLET heading level=0→paraHead level=0 (matches).
- Empty <hp:tr> on full-rowspan coverage. 0/5239 corpus rows are empty; if every cell of a logical row is covered by rowSpans from above, the serializer must SUPPRESS that <hp:tr> (Hancom never emits one) — or the table mis-renders/rejects.
- New-font-family rendering for a non-embedded face is UNVERIFIED in the oracle; prefer reusing an existing fontface id when the requested family is already in the pool, and gate the brand-new-family path behind an oracle smoke test. Same caution for the restart-numbering field (numbering@start vs paraHead@start is unobserved — A/B oracle-test before shipping).
- hp:switch default-branch geometry DOUBLING: nonzero margin/intent/tabItem values are doubled in hp:default (case 7000→default 14000; intent -1310→-2620; tabItem case pos+unit=HWPUNIT / default pos DOUBLED + NO unit attr) while lineSpacing is NOT doubled and keeps unit in both. Emitting identical (non-doubled) defaults is unverified-as-accepted and risks layout drift — replicate Hancom's doubling exactly.

## AiContent v2 schema

// AiContent v2 — the JSON the AI emits (hwp-ai/src/content.rs). All formatting reduces to
// header-pool synthesis on export. Unknown keys rejected by serde.

AiContent = { "version": 2, "blocks": AiBlock[] }

// ---- Run-level (char shape) ----
AiRun = {
  "text": string,
  "bold"?: bool, "italic"?: bool,
  "underline"?: bool | { "type":"BOTTOM"|"CENTER"|"TOP"|"NONE",
                          "shape":"SOLID"|"DOT"|"DASH"|"DASH_DOT"|"DASH_DOT_DOT"|"LONG_DASH"|
                                  "CIRCLE"|"DOUBLE_SLIM"|"SLIM_THICK"|"THICK_SLIM"|
                                  "SLIM_THICK_SLIM"|"WAVE"|"DOUBLEWAVE",
                          "color"?:"#RRGGBB" },
  "strike"?: bool | { "shape": <LineType2-14enum>, "color"?:"#RRGGBB" },
  "outline"?: bool, "shadow"?: bool, "emboss"?: bool, "engrave"?: bool,
  "superscript"?: bool, "subscript"?: bool,           // mutually exclusive
  "size_pt"?: number,                                  // → height = round(pt*100)
  "color"?: "#RRGGBB",                                 // textColor (uppercased)
  "highlight"?: "#RRGGBB" | null,                      // shadeColor; null/omit → "none"
  "font"?: string,                                     // all 7 scripts
  "fonts"?: { "hangul"?:string,"latin"?:string,"hanja"?:string,
              "japanese"?:string,"other"?:string,"symbol"?:string,"user"?:string }
}

// ---- Shared paragraph-shape fields (on any para-ish block) ----
ParaProps = {
  "align"?: "justify"|"left"|"right"|"center"|"distribute"|"divide",
  "valign"?: "baseline"|"top"|"center"|"bottom",
  "line_spacing"?: { "type":"percent"|"fixed"|"atleast", "value":number },
  "indent_left"?: number, "indent_right"?: number,    // mm (compiler→HWPUNIT)
  "first_line"?: { "type":"indent"|"hanging"|"none", "value":number /*pt*/ },
  "space_before"?: number, "space_after"?: number,     // pt
  "break_latin"?: "keep"|"break"|"hyphen",
  "break_non_latin"?: "keep"|"break",
  "line_wrap"?: "break"|"squeeze",
  "widow_orphan"?: bool, "keep_with_next"?: bool, "keep_lines"?: bool,
  "page_break_before"?: bool,
  "border"?: { "sides":"all"|"top"|"bottom"|"left"|"right"|"box", "style":"solid"|"dash"|"dot"|"double"|"none",
               "width_mm":0.1|0.12|0.15|0.2|0.25|0.3|0.4|0.5|0.6|0.7|1.0|2.0, "color":"#RRGGBB" },
  "shade_color"?: "#RRGGBB",
  "tabs"?: [ { "pos_pt":number, "type":"left"|"right"|"center"|"decimal",
               "leader":"none"|"dot"|"dash"|"line" } ],
  "style"?: string                                     // "바탕글"|"본문"|"개요 1".. or eng names
}

// ---- Block-level (discriminated by "type") ----
AiBlock =
  | { "type":"heading", "level":1..10, "text"?:string, "runs"?:AiRun[], ...ParaProps }   // outline level; NO fake bold
  | { "type":"paragraph", "runs":AiRun[], ...ParaProps }
  | { "type":"ordered_list", "items":(string|{text:string,runs?:AiRun[],level?:1..10})[],
      "numFormat"?:"DIGIT"|"HANGUL_SYLLABLE"|"CIRCLED_DIGIT"|"HANGUL_JAMO"|"ROMAN_SMALL"|"ROMAN_CAPITAL",
      "start"?:number, "restart"?:bool, "level_formats"?:string[], "indent"?:{left:number,hanging:number} }
  | { "type":"bullet_list", "items":(string|{text:string,runs?:AiRun[]})[],
      "bulletChar"?:string /* ❏●○■□◆ */, "indent"?:{left:number,hanging:number} }
  | { "type":"divider" }                                // native (thin box-border paragraph), not box-drawing text
  | { "type":"table",
      "rowCnt"?:number, "colCnt"?:number,
      "header"?:string[], "rows"?:string[][],          // shorthand (v1-compatible)
      "cells"?: [ { "row":number, "col":number,
                    "colSpan"?:number, "rowSpan"?:number,
                    "text"?:string, "paras"?:{ text?:string, runs?:AiRun[], align?:string }[],
                    "shade"?:"#RRGGBB"|null,
                    "borders"?:{ left?:Edge, right?:Edge, top?:Edge, bottom?:Edge },
                    "vAlign"?:"top"|"center"|"bottom" } ],
      "border"?: Edge,                                   // table-default per-edge
      "caption"?: { "text":string, "side":"top"|"bottom"|"left"|"right", "autoNum"?:bool },
      "repeatHeader"?: bool }
// Edge = { "type":<LineType2-14enum>, "width":"0.1 mm".."2.0 mm", "color":"#RRGGBB" }