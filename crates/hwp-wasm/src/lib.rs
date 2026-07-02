//! wasm-bindgen bindings for the tf-hwp engine — **Shell C** (issue 015).
//!
//! This crate is a THIN consumer of two existing lanes and reimplements neither:
//! - **edit lane** = `hwp-mcp` (issue 012 LEAF decision): [`hwp_mcp::Session`] +
//!   [`hwp_mcp::open_bytes`] + [`hwp_mcp::apply_intent_json`] (Intent JSON schema v0, issue 008) +
//!   [`hwp_mcp::export_bytes`]. `default-features = false` drops the loopback HTTP server's
//!   `std::net`/`getrandom`/`subtle` so the lib is wasm-safe (issue 017).
//! - **render / geometry / export lane** = `hwp-session` (issue 012): own-render SVG, hit-test/table
//!   geometry (px space), and HTML/PDF projection.
//!
//! No LLM lives here (R6): the host app runs the AI server-side and applies the resulting Intent
//! JSON via [`HwpDoc::apply_intent`]. Fonts are **injected, never bundled** (R8): the PDF path needs a
//! font registered first ([`HwpDoc::register_font`]) or `export_pdf` throws (no silent empty glyphs).
//!
//! ## wasm panic recovery (R4 web variant)
//! A panic on `wasm32` is a trap — it POISONS the instance. `rhwp`'s `catch_unwind` guard is a no-op
//! here. So a malicious/corrupt `.hwp` that panics the parser kills THIS `HwpDoc`'s wasm instance.
//! Containment is the JS loader's job (`packages/engine/index.js`): every call is wrapped in
//! try/catch, and a `WebAssembly.RuntimeError` re-instantiates the module and asks the host to
//! re-open the document. This crate just installs `console_error_panic_hook` for a readable message.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

/// Install a readable panic hook once at module load (browser console shows the Rust message + a JS
/// stack instead of "unreachable"). This does NOT make panics recoverable — the instance is still
/// dead after a trap; recovery is the JS loader's re-instantiation (see the crate docs / README).
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Build a structured JS `Error` carrying a `.code` (so the host can branch) plus the message.
fn js_err(code: &str, message: &str) -> JsValue {
    let e = js_sys::Error::new(message);
    // Best-effort: attach a machine-readable code. Ignore the (never-failing) set result.
    let _ = js_sys::Reflect::set(&e, &JsValue::from_str("code"), &JsValue::from_str(code));
    e.into()
}

/// Classify an engine error string (the edit/render lanes return `String`, issue 008 §4) into a
/// coarse `code` so the JS side can distinguish "re-open needed" from "bad request" without string
/// matching. The raw message is preserved verbatim as `.message`.
fn engine_err(message: String) -> JsValue {
    let code = if message.contains("no document open") {
        "no_document"
    } else if message.contains("intent_version") {
        "bad_intent_version"
    } else if message.starts_with("unknown variant")
        || message.starts_with("unknown field")
        || message.contains("missing field")
        || message.contains("intent envelope must be")
    {
        "bad_intent"
    } else if message.contains("needs a build with --features rhwp") {
        "needs_rhwp"
    } else if message.contains("out of range") {
        "out_of_range"
    } else {
        "engine"
    };
    js_err(code, &message)
}

/// One open document + its edit history — the wasm handle the host holds. Wraps a single
/// [`hwp_mcp::Session`] (the edit lane's live doc/undo/redo) and threads the SAME live `SemanticDoc`
/// into `hwp-session` for render/geometry/export.
///
/// ## Lifetime (R13)
/// `open` is a constructor: the host OWNS the returned handle and MUST call `.free()` when swapping
/// documents, or the wasm-side allocation (incl. the original file bytes + up to 50 undo snapshots)
/// leaks. The JS loader adds a `FinalizationRegistry` safety net, but explicit `free()` is the
/// contract.
#[wasm_bindgen]
pub struct HwpDoc {
    session: hwp_mcp::Session,
    /// Display title (the uploaded filename stem) used for HTML/PDF metadata.
    title: Option<String>,
    /// Injected font faces `(family, bytes)` (R8). Presence is REQUIRED before `export_pdf`; see the
    /// note on `export_pdf` for the current embedding limitation.
    fonts: Vec<(String, Vec<u8>)>,
    /// Own-render SVG cache keyed by the edit-session revision, so scrolling all pages is O(pages)
    /// not O(pages²) and an edit transparently invalidates it (the revision bumps).
    svg_cache: RefCell<Option<(u64, Vec<String>)>>,
}

#[wasm_bindgen]
impl HwpDoc {
    /// Open a document from raw bytes — `.hwp` (HWP5, needs the `hwp5`/rhwp feature) or `.hwpx` are
    /// auto-detected ([`hwp_mcp::open_bytes`], 007 A안). `name` is a display/source hint (the uploaded
    /// filename); its stem seeds HTML/PDF titles. Throws `{code:"unrecognized"…}` on an unknown format.
    #[wasm_bindgen(js_name = open)]
    pub fn open(bytes: &[u8], name: Option<String>) -> Result<HwpDoc, JsValue> {
        let mut session = hwp_mcp::Session::default();
        let display = name.clone().unwrap_or_else(|| "document".to_string());
        hwp_mcp::open_bytes(&mut session, bytes, &display).map_err(engine_err)?;
        let title = name.map(|n| {
            std::path::Path::new(&n)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or(n)
        });
        Ok(HwpDoc { session, title, fonts: Vec::new(), svg_cache: RefCell::new(None) })
    }

    /// Borrow the live `SemanticDoc` from the edit session (render/geometry/export read this).
    fn doc(&self) -> Result<&hwp_model::prelude::SemanticDoc, JsValue> {
        Ok(self
            .session
            .doc
            .as_ref()
            .ok_or_else(|| js_err("no_document", "no document open (call open first)"))?
            .doc())
    }

    /// Current edit-session revision (bumps on every applied edit / undo / redo).
    fn revision(&self) -> u64 {
        self.session.doc.as_ref().map(|d| d.revision()).unwrap_or(0)
    }

    /// All pages' own-render SVG, using the revision-keyed cache (re-renders only after an edit).
    fn render_all(&self) -> Result<Vec<String>, JsValue> {
        let rev = self.revision();
        if let Some((cached_rev, svgs)) = self.svg_cache.borrow().as_ref() {
            if *cached_rev == rev {
                return Ok(svgs.clone());
            }
        }
        let doc = self.doc()?;
        let svgs = hwp_session::render_svg(doc);
        *self.svg_cache.borrow_mut() = Some((rev, svgs.clone()));
        Ok(svgs)
    }

    /// Number of pages in the current document (OUR own-render pagination — no rhwp re-render).
    #[wasm_bindgen(js_name = pageCount)]
    pub fn page_count(&self) -> Result<usize, JsValue> {
        Ok(self.render_all()?.len())
    }

    /// Own-render SVG **string** for page `n` (0-based). The fidelity surface (issue 012 `render_svg`).
    ///
    /// ⚠️ SECURITY (R7): this is UNTRUSTED, document-derived output. NEVER `innerHTML` it raw — route
    /// through the loader's `sanitizeSvg` (DOMParser + strip `<script>`/`on*`). Full sanitize is 016.
    #[wasm_bindgen(js_name = renderPageSvg)]
    pub fn render_page_svg(&self, n: usize) -> Result<String, JsValue> {
        let svgs = self.render_all()?;
        svgs.get(n)
            .cloned()
            .ok_or_else(|| js_err("out_of_range", &format!("page {n} out of range (0..{})", svgs.len())))
    }

    /// Click-to-point hit test on `page` at own-render px `(x, y)` — JSON of the top-level block under
    /// the point (`section`/`block`/`kind`/box/`text`/`editable`), or the string `"null"` on a miss.
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, page: u32, x: f64, y: f64) -> Result<String, JsValue> {
        let doc = self.doc()?;
        let hit = hwp_session::own_hit_test(doc, page, x, y);
        serde_json::to_string(&hit).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// Click-to-mark table hit test on `page` at own-render px `(x, y)` — JSON of the placed table box
    /// (`section`/`block`/box/`rows`/`cols`/`first_row`) for marking, or `"null"` on a miss.
    #[wasm_bindgen(js_name = tableAt)]
    pub fn table_at(&self, page: u32, x: f64, y: f64) -> Result<String, JsValue> {
        let doc = self.doc()?;
        let t = hwp_session::table_at(doc, page, x, y);
        serde_json::to_string(&t).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// Apply one Intent-JSON envelope (schema v0, issue 008) via the SAME op-bus the desktop uses
    /// ([`hwp_mcp::apply_intent_json`]) — Propose/Commit/Undo/Redo and every edit variant included.
    /// Returns a JSON `Outcome` (`{kind, …}`). Throws a `{code, message}` error on a bad envelope or a
    /// refused edit (the typed error string is carried verbatim in `.message`).
    #[wasm_bindgen(js_name = applyIntent)]
    pub fn apply_intent(&mut self, intent_json: &str) -> Result<String, JsValue> {
        let value: serde_json::Value = serde_json::from_str(intent_json)
            .map_err(|e| js_err("bad_json", &format!("intent is not valid JSON: {e}")))?;
        let outcome = hwp_mcp::apply_intent_json(&mut self.session, &value).map_err(engine_err)?;
        let json = outcome_to_json(&outcome);
        serde_json::to_string(&json).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// Undo the last edit. Returns `true` if something was undone (graceful `false` no-op otherwise).
    pub fn undo(&mut self) -> bool {
        self.session.doc.as_mut().map(|d| d.undo()).unwrap_or(false)
    }

    /// Redo the last undone edit. Returns `true` if something was redone.
    pub fn redo(&mut self) -> bool {
        self.session.doc.as_mut().map(|d| d.redo()).unwrap_or(false)
    }

    /// Inject a font face `(family, bytes)` for PDF export (R8 — fonts are NEVER bundled). Call this
    /// before `export_pdf`. `bytes` is a TTF/OTF face (e.g. Noto Sans KR, OFL).
    ///
    /// ⚠️ Current embedding limitation (issue-code gap, reported): the underlying
    /// `hwp_export::pdf::export_pdf` still discovers its embedded face via `std::fs` candidates, which
    /// return nothing on wasm — so on wasm the exported PDF's GLYPHS are stub boxes (geometry is
    /// faithful). Threading these injected bytes into krilla needs a `font bytes` parameter on
    /// `hwp-export` (out of 015's "pure consumer" scope). Presence is still enforced so the contract
    /// and demo flow are correct the day that parameter lands.
    #[wasm_bindgen(js_name = registerFont)]
    pub fn register_font(&mut self, family: String, bytes: Vec<u8>) {
        self.fonts.push((family, bytes));
    }

    /// Export the live document to PDF bytes (krilla, via `hwp-session::emit_pdf`). Throws
    /// `{code:"font_missing"}` if no font was registered (no silent empty glyphs — issue §함정).
    #[wasm_bindgen(js_name = exportPdf)]
    pub fn export_pdf(&self) -> Result<Vec<u8>, JsValue> {
        if self.fonts.is_empty() {
            return Err(js_err(
                "font_missing",
                "exportPdf requires a font — call registerFont(family, bytes) first (no bundled fonts, R8)",
            ));
        }
        let doc = self.doc()?;
        let out = hwp_session::emit_pdf(doc, self.title.clone()).map_err(engine_err)?;
        Ok(out.bytes)
    }

    /// Export the live document to a self-contained HTML string (JSX/CSS projection, issue 012
    /// `emit_html`). Byte-identical to the CLI `export-html`.
    #[wasm_bindgen(js_name = exportHtml)]
    pub fn export_html(&self) -> Result<String, JsValue> {
        let doc = self.doc()?;
        Ok(hwp_session::emit_html(doc, self.title.clone()))
    }

    /// Serialize the live (possibly edited) document to round-trip-safe HWPX bytes
    /// ([`hwp_mcp::export_bytes`]).
    #[wasm_bindgen(js_name = toHwpx)]
    pub fn to_hwpx(&self) -> Result<Vec<u8>, JsValue> {
        hwp_mcp::export_bytes(&self.session).map_err(engine_err)
    }
}

/// Shape an [`hwp_mcp::Outcome`] into a tagged JSON object (`{kind, …}`). `Outcome` is not itself
/// `Serialize`, but its payload DTOs (`FindMatch`/`HitResult`/`CaretRect`) are, so nested results are
/// serialized through serde. Kept exhaustive so a new Outcome variant fails to compile here (drift
/// guard) rather than silently emitting nothing.
fn outcome_to_json(o: &hwp_mcp::Outcome) -> serde_json::Value {
    use hwp_mcp::Outcome::*;
    use serde_json::json;
    match o {
        Opened { format, editable, sections } => {
            json!({ "kind": "opened", "format": format, "editable": editable, "sections": sections })
        }
        PageCount(n) => json!({ "kind": "pageCount", "pages": n }),
        Rendered(svg) => json!({ "kind": "rendered", "svg": svg }),
        Applied { blocks, ops } => json!({ "kind": "applied", "blocks": blocks, "ops": ops }),
        Exported { bytes, open_safe } => json!({ "kind": "exported", "bytes": bytes, "openSafe": open_safe }),
        Undone(changed) => json!({ "kind": "undone", "changed": changed }),
        Redone(changed) => json!({ "kind": "redone", "changed": changed }),
        Text(text) => json!({ "kind": "text", "text": text }),
        Proposed { rationale, preview } => {
            json!({ "kind": "proposed", "rationale": rationale, "preview": preview })
        }
        Committed { ops } => json!({ "kind": "committed", "ops": ops }),
        Discarded(discarded) => json!({ "kind": "discarded", "discarded": discarded }),
        Found { matches } => {
            json!({ "kind": "found", "matches": serde_json::to_value(matches).unwrap_or(serde_json::Value::Null) })
        }
        Replaced { replaced, pages } => json!({ "kind": "replaced", "replaced": replaced, "pages": pages }),
        Hit(hit) => json!({ "kind": "hit", "hit": serde_json::to_value(hit).unwrap_or(serde_json::Value::Null) }),
        Caret(caret) => {
            json!({ "kind": "caret", "caret": serde_json::to_value(caret).unwrap_or(serde_json::Value::Null) })
        }
        Edited { pages } => json!({ "kind": "edited", "pages": pages }),
    }
}
