//! Intent-schema-v0 snapshot test (issue 008).
//!
//! This is the CANONICAL, drift-proof link between `docs/INTENT-SCHEMA.md` and the code: every
//! Intent documented there has one JSON example here, and this test proves each example
//!
//!   1. deserializes into the REAL `hwp_mcp::Intent` (via `deserialize_intent`), and
//!   2. for the dispatchable subset, feeds `apply_intent_json` and produces an edit (no error).
//!
//! It also LOCKS the compatibility contract that the issue demands: an unknown `intent` tag and an
//! unknown/mistyped field are HARD ERRORS (never silently ignored), and the optional
//! `intent_version` envelope is honored (absent → 0, in-range → ok, out-of-range → explicit error).
//!
//! Runs under the default (no-rhwp) workspace build: the fixtures are HWPX + a synthetic doc, so
//! `cargo test -p hwp-mcp` exercises the whole schema without the rhwp bootstrap.

use hwp_mcp::{apply_intent_json, deserialize_intent, Session, INTENT_VERSION};
use hwp_model::prelude::{Section, SemanticDoc};
use hwp_ops::{CellSpec, EditSession, Op, ParaSpec, RunSpec};
use serde_json::{json, Value};

fn showcase() -> String {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    )
    .into()
}

/// A deterministic session whose section 0 is exactly `[paragraph@0, table(3×2)@1]`, built through
/// the op-bus so the dispatch examples target KNOWN indices independent of any fixture geometry.
fn synthetic_session() -> Session {
    let mut doc = SemanticDoc::default();
    doc.sections.push(Section::default()); // one empty section (block indices start at 0)
    let mut es = EditSession::new(doc);
    es.do_op(&Op::InsertParagraphAt {
        section: 0,
        index: 0,
        runs: vec![RunSpec {
            text: "본문 문단".into(),
            ..Default::default()
        }],
        para: ParaSpec::default(),
    })
    .expect("insert paragraph @0");
    let cell = |t: &str| CellSpec {
        text: t.into(),
        ..Default::default()
    };
    es.do_op(&Op::InsertTableAt {
        section: 0,
        index: 1,
        rows: vec![
            vec![cell("A1"), cell("B1"), cell("C1")],
            vec![cell("A2"), cell("B2"), cell("C2")],
        ],
    })
    .expect("insert 3×2 table @1");
    let mut s = Session::default();
    s.doc = Some(es);
    s
}

/// One canonical JSON example per `Intent` variant — the SAME strings documented in
/// `docs/INTENT-SCHEMA.md`. `dispatch` flags whether the snapshot test also runs it through the
/// op-bus (mutators/queries with fixture-independent targets) or only asserts it deserializes
/// (geometry-/rhwp-gated intents: HitTest/CaretRect/Render need a live glyph render; InsertText/
/// DeleteBack/SetImageSize/MoveImage need a live NodeId/image the schema test can't synthesize).
struct Example {
    intent: &'static str,
    json: &'static str,
    dispatch: Dispatch,
}

#[derive(PartialEq)]
enum Dispatch {
    /// Deserialize only (documented, but geometry/rhwp-gated — dispatch needs a live render/node).
    DeserializeOnly,
    /// Deserialize + dispatch on the synthetic 3×2-table doc; assert Ok + a revision bump.
    Synthetic,
    /// Deserialize + dispatch on the opened showcase HWPX; assert Ok.
    Showcase,
}

use Dispatch::*;

fn examples() -> Vec<Example> {
    let e = |intent, json, dispatch| Example {
        intent,
        json,
        dispatch,
    };
    vec![
        // ---- lifecycle / query ----
        e(
            "Open",
            r#"{"intent":"Open","path":"corpus/hwpx/FormattingShowcase.hwpx"}"#,
            DeserializeOnly,
        ),
        e("PageCount", r#"{"intent":"PageCount"}"#, Showcase),
        e("Render", r#"{"intent":"Render","page":0}"#, DeserializeOnly),
        e(
            "ApplyContent",
            r#"{"intent":"ApplyContent","json":"{\"blocks\":[{\"type\":\"paragraph\",\"runs\":[{\"text\":\"에이전트 추가\"}]}]}"}"#,
            Showcase,
        ),
        e(
            "Export",
            r#"{"intent":"Export","path":"/tmp/hwp_intent_schema_out.hwpx"}"#,
            Showcase,
        ),
        e("Undo", r#"{"intent":"Undo"}"#, Showcase),
        e("Redo", r#"{"intent":"Redo"}"#, Showcase),
        e("ExtractText", r#"{"intent":"ExtractText"}"#, Showcase),
        // ---- proposal loop ----
        e(
            "Propose",
            r#"{"intent":"Propose","json":"{\"blocks\":[{\"type\":\"heading\",\"text\":\"제안\",\"align\":\"center\"}]}"}"#,
            Showcase,
        ),
        e("Commit", r#"{"intent":"Commit"}"#, DeserializeOnly),
        e(
            "DiscardProposal",
            r#"{"intent":"DiscardProposal"}"#,
            Showcase,
        ),
        // ---- find / replace ----
        e(
            "Find",
            r#"{"intent":"Find","query":"문서","case_sensitive":false,"whole_word":false}"#,
            Showcase,
        ),
        e(
            "Replace",
            r#"{"intent":"Replace","query":"문서","replacement":"파일","case_sensitive":false,"whole_word":false,"all":true}"#,
            Showcase,
        ),
        // ---- WYSIWYG caret geometry (rhwp/live-node gated) ----
        e(
            "HitTest",
            r#"{"intent":"HitTest","page":0,"x":120.0,"y":90.0}"#,
            DeserializeOnly,
        ),
        e(
            "CaretRect",
            r#"{"intent":"CaretRect","page":0,"node":7,"offset":3}"#,
            DeserializeOnly,
        ),
        e(
            "InsertText",
            r#"{"intent":"InsertText","node":7,"offset":0,"text":"끼움"}"#,
            DeserializeOnly,
        ),
        e(
            "DeleteBack",
            r#"{"intent":"DeleteBack","node":7,"offset":1}"#,
            DeserializeOnly,
        ),
        // ---- image overlay (live image gated) ----
        e(
            "SetImageSize",
            r#"{"intent":"SetImageSize","section":0,"index":2,"width":12000,"height":9000}"#,
            DeserializeOnly,
        ),
        e(
            "MoveImage",
            r#"{"intent":"MoveImage","section":0,"from":2,"to":0,"width":12000,"height":9000}"#,
            DeserializeOnly,
        ),
        // ---- image insert (issue 050 — drop/upload; bytes-based, magic-byte validated) ----
        // `data_b64` is the canonical 1×1 PNG; `block:null` appends at the section end (synthetic doc has
        // a section 0, so it dispatches and bumps the revision — proving the base64→validate→embed lane).
        e(
            "InsertImage",
            r#"{"intent":"InsertImage","section":0,"block":null,"data_b64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","width":34016,"height":25512}"#,
            Synthetic,
        ),
        // ---- block / table structure (synthetic targets) ----
        e(
            "MoveBlock",
            r#"{"intent":"MoveBlock","section":0,"from":0,"to":1}"#,
            Synthetic,
        ),
        e(
            "TableInsertRows",
            r#"{"intent":"TableInsertRows","section":0,"index":1,"at":2,"count":1,"cols":3}"#,
            Synthetic,
        ),
        e(
            "SetTableCell",
            r#"{"intent":"SetTableCell","section":0,"index":1,"row":0,"col":0,"text":"셀 값"}"#,
            Synthetic,
        ),
        e(
            "TableAppendRow",
            r#"{"intent":"TableAppendRow","section":0,"index":1}"#,
            Synthetic,
        ),
        e(
            "SetParagraphText",
            r#"{"intent":"SetParagraphText","section":0,"block":0,"text":"바뀐 문단"}"#,
            Synthetic,
        ),
        e(
            "SetTableColWidths",
            r#"{"intent":"SetTableColWidths","section":0,"index":1,"widths":[2,1,1]}"#,
            Synthetic,
        ),
        e(
            "SetTableRowHeights",
            r#"{"intent":"SetTableRowHeights","section":0,"index":1,"heights":[0,0]}"#,
            Synthetic,
        ),
        e(
            "SetPageMargins",
            r#"{"intent":"SetPageMargins","section":0,"left_mm":20.0,"right_mm":20.0,"top_mm":20.0,"bottom_mm":15.0}"#,
            Showcase,
        ),
        // ---- character / paragraph formatting (synthetic targets) ----
        e(
            "SetCharFmt",
            r#"{"intent":"SetCharFmt","section":0,"block":0,"cell":null,"bold":true,"italic":null,"size_pt":14.0,"font":"맑은 고딕"}"#,
            Synthetic,
        ),
        e(
            "SetRunCharFmt",
            r#"{"intent":"SetRunCharFmt","section":0,"block":0,"cell":null,"start":0,"end":2,"bold":true,"italic":false}"#,
            Synthetic,
        ),
        e(
            "SetTableCellRuns",
            r#"{"intent":"SetTableCellRuns","section":0,"index":1,"row":0,"col":0,"runs":[{"text":"강조","bold":true},{"text":" 일반"}]}"#,
            Synthetic,
        ),
        e(
            "SetParagraphRuns",
            r#"{"intent":"SetParagraphRuns","section":0,"block":0,"runs":[{"text":"굵게","bold":true}]}"#,
            Synthetic,
        ),
        // ---- shading / range format (synthetic targets) ----
        e(
            "SetTableCellShade",
            r##"{"intent":"SetTableCellShade","section":0,"index":1,"sel":"cell","row":0,"col":0,"shade":"#FFFF00"}"##,
            Synthetic,
        ),
        e(
            "SetCellRangeShade",
            r##"{"intent":"SetCellRangeShade","section":0,"index":1,"r0":0,"c0":0,"r1":1,"c1":2,"shade":"#EEEEEE"}"##,
            Synthetic,
        ),
        e(
            "SetCellRangeFmt",
            r##"{"intent":"SetCellRangeFmt","section":0,"index":1,"r0":0,"c0":0,"r1":1,"c1":2,"bold":true,"italic":null,"size_pt":null,"font":null,"color":"#0000FF","align":"center"}"##,
            Synthetic,
        ),
        e(
            "DeleteBlock",
            r#"{"intent":"DeleteBlock","section":0,"index":0}"#,
            Synthetic,
        ),
        // ---- structural inserts (issue 051 — chat structural edit; Intent exposure of the EXISTING
        //      InsertTableAt / InsertParagraphAt ops). `index` may be an int (at that block; == len
        //      appends) or null/absent (section END — the InsertImage anchor precedent). ----
        e(
            "InsertTableAt",
            r#"{"intent":"InsertTableAt","section":0,"index":1,"rows":[[{"text":"머리","bold":true},{"text":"칸"}],[{"text":"A2"},{"text":"B2"}]]}"#,
            Synthetic,
        ),
        e(
            "InsertParagraphAt",
            r#"{"intent":"InsertParagraphAt","section":0,"index":0,"runs":[{"text":"새 문단","bold":true}],"para":{"align":"center"}}"#,
            Synthetic,
        ),
        // ---- AI-generated data chart (issue 062-follow) — a bar/pie/line chart built from data,
        //      inserted as an Inline::Chart on the issue-062 PaintOp::Image.svg render channel. ----
        e(
            "InsertChartAt",
            r#"{"intent":"InsertChartAt","section":0,"index":1,"chart":{"type":"bar","title":"연도별 매출","categories":["2024","2025","2026"],"series":[{"name":"매출","values":[10,18,30]}]}}"#,
            Synthetic,
        ),
        // ---- cell-addressed caret (issue 053 — own-render geometry, no rhwp gate). READ-ONLY
        //      queries (no revision bump), so they are exercised by the dedicated round-trip test
        //      `cell_caret_intents_dispatch_and_roundtrip` below instead of the Synthetic mutator lane. ----
        e(
            "HitTestCell",
            r#"{"intent":"HitTestCell","page":0,"x":120.0,"y":90.0}"#,
            DeserializeOnly,
        ),
        e(
            "CaretRectCell",
            r#"{"intent":"CaretRectCell","section":0,"block":1,"row":0,"col":0,"para":0,"offset":1}"#,
            DeserializeOnly,
        ),
    ]
}

fn parse(s: &str) -> Value {
    serde_json::from_str(s).expect("example is valid JSON")
}

/// Deserialize `v` and require it to FAIL, returning the error string (avoids needing `Intent: Debug`
/// for `Result::expect_err`).
fn de_err(v: Value) -> String {
    match deserialize_intent(&v) {
        Err(e) => e,
        Ok(_) => panic!("expected a deserialize error for {v}"),
    }
}

/// The whole Intent surface has an example (a sentinel so a NEW variant without a documented
/// example trips the snapshot test). Keep in lockstep with the `Intent` enum count.
#[test]
fn every_intent_variant_has_a_documented_example() {
    assert_eq!(
        examples().len(),
        41,
        "one JSON example per Intent variant (see INTENT-SCHEMA.md)"
    );
}

/// Issue 053 — the cell-addressed caret intents are READ-ONLY queries, so the Synthetic mutator lane
/// (which asserts a revision bump) can't cover them. Dispatch both against the deterministic 3×2-table
/// doc and assert the real contract: a hit inside the table resolves to a cell caret target whose
/// address round-trips through `CaretRectCell` to the SAME geometry; a miss and an unresolvable
/// address are `null` (018), never an error; and neither query bumps the revision.
#[test]
fn cell_caret_intents_dispatch_and_roundtrip() {
    use hwp_mcp::Outcome;
    let mut s = synthetic_session();
    let before = s.doc.as_ref().unwrap().revision();
    // The synthetic table is block 1 of section 0; its placed box is discoverable via CaretRectCell
    // itself (offset 0 of cell (0,0)'s first paragraph = the cell text origin).
    let caret = match apply_intent_json(
        &mut s,
        &parse(
            r#"{"intent":"CaretRectCell","section":0,"block":1,"row":0,"col":0,"para":0,"offset":0}"#,
        ),
    ) {
        Ok(Outcome::CaretCell(Some(c))) => c,
        Ok(Outcome::CaretCell(None)) => panic!("cell (0,0) must have caret geometry"),
        Ok(_) => panic!("CaretRectCell returned a non-caret outcome"),
        Err(e) => panic!("CaretRectCell errored: {e}"),
    };
    assert!(caret.height > 0.0, "caret has a line height");
    // Hit exactly on the caret line → the same cell address + offset 0, same geometry.
    let hit_json = format!(
        r#"{{"intent":"HitTestCell","page":{},"x":{},"y":{}}}"#,
        caret.page,
        caret.x + 0.1,
        caret.top + caret.height / 2.0
    );
    match apply_intent_json(&mut s, &parse(&hit_json)) {
        Ok(Outcome::HitCell(Some(h))) => {
            assert_eq!(
                (h.section, h.block, h.row, h.col, h.para, h.offset),
                (0, 1, 0, 0, 0, 0)
            );
            assert!(h.para_len >= 2, "cell A1 has text");
            assert!(
                (h.caret.x - caret.x).abs() < 0.01,
                "hit caret x == addressed caret x"
            );
        }
        Ok(Outcome::HitCell(None)) => panic!("hit on the caret line must resolve"),
        Ok(_) => panic!("HitTestCell returned a non-hit outcome"),
        Err(e) => panic!("HitTestCell errored: {e}"),
    }
    // 018 null policy: a click off any table and an unresolvable address are null, never an error.
    match apply_intent_json(
        &mut s,
        &parse(r#"{"intent":"HitTestCell","page":0,"x":0.5,"y":0.5}"#),
    ) {
        Ok(Outcome::HitCell(hit)) => {
            assert!(hit.is_none(), "top-left page corner is off the table")
        }
        Ok(_) => panic!("HitTestCell returned a non-hit outcome"),
        Err(e) => panic!("HitTestCell (miss) errored: {e}"),
    }
    match apply_intent_json(
        &mut s,
        &parse(
            r#"{"intent":"CaretRectCell","section":0,"block":1,"row":9,"col":9,"para":0,"offset":0}"#,
        ),
    ) {
        Ok(Outcome::CaretCell(c)) => assert!(c.is_none(), "unknown cell address is null"),
        Ok(_) => panic!("CaretRectCell returned a non-caret outcome"),
        Err(e) => panic!("CaretRectCell (unknown cell) errored: {e}"),
    }
    // Past-end offset CLAMPS to the paragraph end (a rect, never null) — the CaretRect contract.
    match apply_intent_json(
        &mut s,
        &parse(
            r#"{"intent":"CaretRectCell","section":0,"block":1,"row":0,"col":0,"para":0,"offset":9999}"#,
        ),
    ) {
        Ok(Outcome::CaretCell(c)) => assert!(c.is_some(), "past-end offset clamps, never null"),
        Ok(_) => panic!("CaretRectCell returned a non-caret outcome"),
        Err(e) => panic!("CaretRectCell (past-end) errored: {e}"),
    }
    // Read-only: no revision bump.
    assert_eq!(
        s.doc.as_ref().unwrap().revision(),
        before,
        "caret queries never mutate"
    );
}

/// Drift guard: every documented example deserializes into the REAL `Intent` (deny_unknown_fields
/// means this also proves each field name/type in the doc matches the code exactly).
#[test]
fn all_documented_examples_deserialize() {
    for ex in examples() {
        let v = parse(ex.json);
        deserialize_intent(&v).unwrap_or_else(|e| {
            panic!(
                "example `{}` failed to deserialize: {e}\n  json = {}",
                ex.intent, ex.json
            )
        });
    }
}

/// Dispatch guard: the examples marked `Synthetic` deserialize AND run through the op-bus against a
/// deterministic 3×2-table doc, producing an edit (Ok + revision bump). This is the "doc example ==
/// code behavior" link for the mutating intents (incl. the cell-formatting family the issue calls out).
#[test]
fn synthetic_examples_dispatch_and_mutate() {
    for ex in examples().into_iter().filter(|e| e.dispatch == Synthetic) {
        let mut s = synthetic_session(); // fresh doc per intent (indices stay valid)
        let before = s.doc.as_ref().unwrap().revision();
        let v = parse(ex.json);
        apply_intent_json(&mut s, &v)
            .unwrap_or_else(|e| panic!("dispatch of `{}` errored: {e}", ex.intent));
        let after = s.doc.as_ref().unwrap().revision();
        assert!(
            after > before,
            "`{}` should mutate the doc (revision {before} → {after})",
            ex.intent
        );
    }
}

/// Dispatch guard for the query/lifecycle examples that need a real document: open the showcase and
/// run each `Showcase` example end-to-end (deserialize → apply_intent_json → Ok).
#[test]
fn showcase_examples_dispatch_without_error() {
    let mut s = Session::default();
    apply_intent_json(&mut s, &json!({"intent":"Open","path": showcase()})).expect("open showcase");
    for ex in examples().into_iter().filter(|e| e.dispatch == Showcase) {
        let v = parse(ex.json);
        apply_intent_json(&mut s, &v)
            .unwrap_or_else(|e| panic!("showcase dispatch of `{}` errored: {e}", ex.intent));
    }
}

// ---- Compatibility contract (issue 008 acceptance): unknown tag/field + version envelope ----

/// An unknown `intent` tag is a HARD ERROR (never a silent no-op that an agent mistakes for success).
#[test]
fn unknown_intent_tag_is_rejected() {
    let err = de_err(json!({"intent":"NoSuchIntent","x":1}));
    assert!(
        err.contains("unknown variant"),
        "error names the bad tag: {err}"
    );
}

/// An unknown/mistyped FIELD on an otherwise-valid Intent is a HARD ERROR (a typo'd `widht` must not
/// silently drop). Locks the `deny_unknown_fields` contract for both the Intent and its nested runs.
#[test]
fn unknown_field_is_rejected() {
    let err = de_err(
        json!({"intent":"SetImageSize","section":0,"index":1,"width":10,"height":10,"bogus":1}),
    );
    assert!(
        err.contains("unknown field") && err.contains("bogus"),
        "error names the bad field: {err}"
    );

    // …and inside a nested RunSpec too.
    let err = de_err(json!({
        "intent":"SetParagraphRuns","section":0,"block":0,
        "runs":[{"text":"x","weight":900}]
    }));
    assert!(
        err.contains("unknown field") && err.contains("weight"),
        "nested run rejects unknown field: {err}"
    );
}

/// Issue 050: `InsertImage` DESERIALIZES fine but the DISPATCH validates the payload — a base64 blob
/// whose bytes are NOT a PNG/JPEG signature is REJECTED honestly (never a silent no-op that leaves the
/// user thinking a non-image "inserted"). The synthetic doc's revision must NOT move on the rejected op.
#[test]
fn insert_image_rejects_a_non_image_payload() {
    // A well-formed InsertImage envelope carrying base64 of plain text (not an image).
    let not_an_image = "bm90IGFuIGltYWdl"; // base64("not an image")
    let env = json!({"intent":"InsertImage","section":0,"block":null,"data_b64":not_an_image,"width":1000,"height":1000});
    // It deserializes (shape is valid)…
    deserialize_intent(&env).expect("InsertImage shape deserializes");
    // …but dispatching it on a real doc errors with an honest format message and mutates nothing.
    let mut s = Session::default();
    apply_intent_json(&mut s, &json!({"intent":"Open","path": showcase()})).expect("open showcase");
    let before = s.doc.as_ref().unwrap().revision();
    let err = match apply_intent_json(&mut s, &env) {
        Err(e) => e,
        Ok(_) => panic!("non-image payload must be rejected"),
    };
    assert!(
        err.contains("PNG") || err.contains("형식") || err.contains("이미지"),
        "honest format error: {err}"
    );
    assert_eq!(
        s.doc.as_ref().unwrap().revision(),
        before,
        "a rejected insert does NOT mutate the doc"
    );
}

/// Issue 051: the structural-insert Intents honor the `index: null`/absent anchor — the insert lands
/// at the SECTION END (the `InsertImage` precedent), and a PAST-END explicit index is an honest
/// op-bus error that mutates nothing (no clamp, no silent no-op).
#[test]
fn structural_insert_index_anchor_semantics() {
    // null index → append at the section end (synthetic doc: [para@0, table@1] → table lands @2).
    let mut s = synthetic_session();
    apply_intent_json(
        &mut s,
        &json!({"intent":"InsertTableAt","section":0,"index":null,"rows":[[{"text":"끝"}]]}),
    )
    .expect("null index appends at the section end");

    // absent index → same append semantics (Option field: omitted → None).
    let mut s = synthetic_session();
    apply_intent_json(
        &mut s,
        &json!({"intent":"InsertParagraphAt","section":0,"runs":[{"text":"끝 문단"}]}),
    )
    .expect("absent index appends at the section end");

    // past-end explicit index → honest error, revision unchanged.
    let mut s = synthetic_session();
    let before = s.doc.as_ref().unwrap().revision();
    let err = match apply_intent_json(
        &mut s,
        &json!({"intent":"InsertTableAt","section":0,"index":99,"rows":[[{"text":"x"}]]}),
    ) {
        Err(e) => e,
        Ok(_) => panic!("a past-end insert index must be rejected"),
    };
    assert!(err.contains("out of range"), "honest past-end error: {err}");
    assert_eq!(
        s.doc.as_ref().unwrap().revision(),
        before,
        "a rejected insert does NOT mutate the doc"
    );
}

/// Issue 051: the nested `CellSpec` (InsertTableAt rows) and `ParaSpec` (InsertParagraphAt para)
/// inherit the `deny_unknown_fields` contract — a misspelled key is a HARD error, never a silently
/// dropped span/override.
#[test]
fn structural_insert_nested_specs_reject_unknown_fields() {
    let err = de_err(json!({
        "intent":"InsertTableAt","section":0,"index":0,
        "rows":[[{"text":"x","colspan":2}]]
    }));
    assert!(
        err.contains("unknown field") && err.contains("colspan"),
        "nested CellSpec rejects unknown field: {err}"
    );

    let err = de_err(json!({
        "intent":"InsertParagraphAt","section":0,"index":0,"runs":[],
        "para":{"alignment":"center"}
    }));
    assert!(
        err.contains("unknown field") && err.contains("alignment"),
        "nested ParaSpec rejects unknown field: {err}"
    );
}

/// A missing tag / missing required field are explicit errors (not defaulted).
#[test]
fn missing_tag_or_required_field_is_rejected() {
    let err = de_err(json!({"path":"a.hwpx"}));
    assert!(
        err.contains("intent"),
        "missing-tag error mentions the tag field: {err}"
    );

    let err = de_err(json!({"intent":"SetImageSize","section":0}));
    assert!(
        err.contains("missing field"),
        "missing-required error: {err}"
    );
}

/// `intent_version` envelope: absent → treated as 0 (legacy callers keep working); explicit 0 → ok;
/// out-of-range → explicit error naming the supported range; non-integer → error.
#[test]
fn intent_version_envelope_is_honored() {
    assert_eq!(INTENT_VERSION, 0, "v0 is frozen");

    // absent → ok (backward compatible)
    deserialize_intent(&json!({"intent":"Undo"})).expect("absent version is legacy 0");

    // explicit in-range 0 → ok, and does NOT leak into deny_unknown_fields
    deserialize_intent(&json!({"intent_version":0,"intent":"Undo"})).expect("version 0 ok");

    // a versioned intent still decodes its own fields
    match deserialize_intent(
        &json!({"intent_version":0,"intent":"SetImageSize","section":1,"index":2,"width":10,"height":20}),
    ) {
        Ok(_) => {}
        Err(e) => panic!("versioned intent should decode: {e}"),
    }

    // out-of-range → explicit error
    let err = de_err(json!({"intent_version":1,"intent":"Undo"}));
    assert!(
        err.contains("unsupported intent_version") && err.contains("1"),
        "range error: {err}"
    );

    // non-integer → error
    let err = de_err(json!({"intent_version":"zero","intent":"Undo"}));
    assert!(
        err.contains("intent_version"),
        "type error mentions the field: {err}"
    );
}
