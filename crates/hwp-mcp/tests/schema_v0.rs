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
use hwp_ops::{CellSpec, EditSession, Op, ParaSpec, RunSpec};
use hwp_model::prelude::{SemanticDoc, Section};
use serde_json::{json, Value};

fn showcase() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx").into()
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
        runs: vec![RunSpec { text: "본문 문단".into(), ..Default::default() }],
        para: ParaSpec::default(),
    })
    .expect("insert paragraph @0");
    let cell = |t: &str| CellSpec { text: t.into(), ..Default::default() };
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
    let e = |intent, json, dispatch| Example { intent, json, dispatch };
    vec![
        // ---- lifecycle / query ----
        e("Open", r#"{"intent":"Open","path":"corpus/hwpx/FormattingShowcase.hwpx"}"#, DeserializeOnly),
        e("PageCount", r#"{"intent":"PageCount"}"#, Showcase),
        e("Render", r#"{"intent":"Render","page":0}"#, DeserializeOnly),
        e("ApplyContent", r#"{"intent":"ApplyContent","json":"{\"blocks\":[{\"type\":\"paragraph\",\"runs\":[{\"text\":\"에이전트 추가\"}]}]}"}"#, Showcase),
        e("Export", r#"{"intent":"Export","path":"/tmp/hwp_intent_schema_out.hwpx"}"#, Showcase),
        e("Undo", r#"{"intent":"Undo"}"#, Showcase),
        e("Redo", r#"{"intent":"Redo"}"#, Showcase),
        e("ExtractText", r#"{"intent":"ExtractText"}"#, Showcase),
        // ---- proposal loop ----
        e("Propose", r#"{"intent":"Propose","json":"{\"blocks\":[{\"type\":\"heading\",\"text\":\"제안\",\"align\":\"center\"}]}"}"#, Showcase),
        e("Commit", r#"{"intent":"Commit"}"#, DeserializeOnly),
        e("DiscardProposal", r#"{"intent":"DiscardProposal"}"#, Showcase),
        // ---- find / replace ----
        e("Find", r#"{"intent":"Find","query":"문서","case_sensitive":false,"whole_word":false}"#, Showcase),
        e("Replace", r#"{"intent":"Replace","query":"문서","replacement":"파일","case_sensitive":false,"whole_word":false,"all":true}"#, Showcase),
        // ---- WYSIWYG caret geometry (rhwp/live-node gated) ----
        e("HitTest", r#"{"intent":"HitTest","page":0,"x":120.0,"y":90.0}"#, DeserializeOnly),
        e("CaretRect", r#"{"intent":"CaretRect","page":0,"node":7,"offset":3}"#, DeserializeOnly),
        e("InsertText", r#"{"intent":"InsertText","node":7,"offset":0,"text":"끼움"}"#, DeserializeOnly),
        e("DeleteBack", r#"{"intent":"DeleteBack","node":7,"offset":1}"#, DeserializeOnly),
        // ---- image overlay (live image gated) ----
        e("SetImageSize", r#"{"intent":"SetImageSize","section":0,"index":2,"width":12000,"height":9000}"#, DeserializeOnly),
        e("MoveImage", r#"{"intent":"MoveImage","section":0,"from":2,"to":0,"width":12000,"height":9000}"#, DeserializeOnly),
        // ---- block / table structure (synthetic targets) ----
        e("MoveBlock", r#"{"intent":"MoveBlock","section":0,"from":0,"to":1}"#, Synthetic),
        e("TableInsertRows", r#"{"intent":"TableInsertRows","section":0,"index":1,"at":2,"count":1,"cols":3}"#, Synthetic),
        e("SetTableCell", r#"{"intent":"SetTableCell","section":0,"index":1,"row":0,"col":0,"text":"셀 값"}"#, Synthetic),
        e("TableAppendRow", r#"{"intent":"TableAppendRow","section":0,"index":1}"#, Synthetic),
        e("SetParagraphText", r#"{"intent":"SetParagraphText","section":0,"block":0,"text":"바뀐 문단"}"#, Synthetic),
        e("SetTableColWidths", r#"{"intent":"SetTableColWidths","section":0,"index":1,"widths":[2,1,1]}"#, Synthetic),
        e("SetTableRowHeights", r#"{"intent":"SetTableRowHeights","section":0,"index":1,"heights":[0,0]}"#, Synthetic),
        e("SetPageMargins", r#"{"intent":"SetPageMargins","section":0,"left_mm":20.0,"right_mm":20.0,"top_mm":20.0,"bottom_mm":15.0}"#, Showcase),
        // ---- character / paragraph formatting (synthetic targets) ----
        e("SetCharFmt", r#"{"intent":"SetCharFmt","section":0,"block":0,"cell":null,"bold":true,"italic":null,"size_pt":14.0,"font":"맑은 고딕"}"#, Synthetic),
        e("SetRunCharFmt", r#"{"intent":"SetRunCharFmt","section":0,"block":0,"cell":null,"start":0,"end":2,"bold":true,"italic":false}"#, Synthetic),
        e("SetTableCellRuns", r#"{"intent":"SetTableCellRuns","section":0,"index":1,"row":0,"col":0,"runs":[{"text":"강조","bold":true},{"text":" 일반"}]}"#, Synthetic),
        e("SetParagraphRuns", r#"{"intent":"SetParagraphRuns","section":0,"block":0,"runs":[{"text":"굵게","bold":true}]}"#, Synthetic),
        // ---- shading / range format (synthetic targets) ----
        e("SetTableCellShade", r##"{"intent":"SetTableCellShade","section":0,"index":1,"sel":"cell","row":0,"col":0,"shade":"#FFFF00"}"##, Synthetic),
        e("SetCellRangeShade", r##"{"intent":"SetCellRangeShade","section":0,"index":1,"r0":0,"c0":0,"r1":1,"c1":2,"shade":"#EEEEEE"}"##, Synthetic),
        e("SetCellRangeFmt", r##"{"intent":"SetCellRangeFmt","section":0,"index":1,"r0":0,"c0":0,"r1":1,"c1":2,"bold":true,"italic":null,"size_pt":null,"font":null,"color":"#0000FF","align":"center"}"##, Synthetic),
        e("DeleteBlock", r#"{"intent":"DeleteBlock","section":0,"index":0}"#, Synthetic),
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
    assert_eq!(examples().len(), 35, "one JSON example per Intent variant (see INTENT-SCHEMA.md)");
}

/// Drift guard: every documented example deserializes into the REAL `Intent` (deny_unknown_fields
/// means this also proves each field name/type in the doc matches the code exactly).
#[test]
fn all_documented_examples_deserialize() {
    for ex in examples() {
        let v = parse(ex.json);
        deserialize_intent(&v)
            .unwrap_or_else(|e| panic!("example `{}` failed to deserialize: {e}\n  json = {}", ex.intent, ex.json));
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
        assert!(after > before, "`{}` should mutate the doc (revision {before} → {after})", ex.intent);
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
    assert!(err.contains("unknown variant"), "error names the bad tag: {err}");
}

/// An unknown/mistyped FIELD on an otherwise-valid Intent is a HARD ERROR (a typo'd `widht` must not
/// silently drop). Locks the `deny_unknown_fields` contract for both the Intent and its nested runs.
#[test]
fn unknown_field_is_rejected() {
    let err = de_err(json!({"intent":"SetImageSize","section":0,"index":1,"width":10,"height":10,"bogus":1}));
    assert!(err.contains("unknown field") && err.contains("bogus"), "error names the bad field: {err}");

    // …and inside a nested RunSpec too.
    let err = de_err(json!({
        "intent":"SetParagraphRuns","section":0,"block":0,
        "runs":[{"text":"x","weight":900}]
    }));
    assert!(err.contains("unknown field") && err.contains("weight"), "nested run rejects unknown field: {err}");
}

/// A missing tag / missing required field are explicit errors (not defaulted).
#[test]
fn missing_tag_or_required_field_is_rejected() {
    let err = de_err(json!({"path":"a.hwpx"}));
    assert!(err.contains("intent"), "missing-tag error mentions the tag field: {err}");

    let err = de_err(json!({"intent":"SetImageSize","section":0}));
    assert!(err.contains("missing field"), "missing-required error: {err}");
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
    match deserialize_intent(&json!({"intent_version":0,"intent":"SetImageSize","section":1,"index":2,"width":10,"height":20})) {
        Ok(_) => {}
        Err(e) => panic!("versioned intent should decode: {e}"),
    }

    // out-of-range → explicit error
    let err = de_err(json!({"intent_version":1,"intent":"Undo"}));
    assert!(err.contains("unsupported intent_version") && err.contains("1"), "range error: {err}");

    // non-integer → error
    let err = de_err(json!({"intent_version":"zero","intent":"Undo"}));
    assert!(err.contains("intent_version"), "type error mentions the field: {err}");
}
