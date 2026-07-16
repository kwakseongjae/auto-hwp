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
//! JSON via [`HwpDoc::apply_intent`]. Fonts are **injected, never bundled** (R8): [`HwpDoc::register_font`]
//! now feeds the injected face into the LAYOUT METRICS *and* the PDF embed (issue 022) — the SAME bytes
//! drive screen SVG, pagination and PDF, so the three agree. Un-registered, render/layout use the
//! deterministic Approx fallback and `export_pdf` throws (no silent empty glyphs).
//!
//! ## wasm panic recovery (R4 web variant)
//! A panic on `wasm32` is a trap — it POISONS the instance. `rhwp`'s `catch_unwind` guard is a no-op
//! here. So a malicious/corrupt `.hwp` that panics the parser kills THIS `HwpDoc`'s wasm instance.
//! Containment is the JS loader's job (`packages/engine/index.js`): every call is wrapped in
//! try/catch, and a `WebAssembly.RuntimeError` re-instantiates the module and asks the host to
//! re-open the document. This crate just installs `console_error_panic_hook` for a readable message.

use std::cell::{Cell, RefCell};

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

/// Total paragraph count including table-cell paragraphs (for the normalize report's `total` when the
/// transform is OFF, so the UI always has a denominator).
fn doc_paragraph_count(doc: &hwp_model::prelude::SemanticDoc) -> usize {
    fn walk(b: &hwp_model::prelude::Block, n: &mut usize) {
        match b {
            hwp_model::prelude::Block::Paragraph(_) => *n += 1,
            hwp_model::prelude::Block::Table(t) => {
                for c in &t.cells {
                    for cb in &c.blocks {
                        walk(cb, n);
                    }
                }
            }
        }
    }
    let mut n = 0;
    for s in &doc.sections {
        for b in &s.blocks {
            walk(b, &mut n);
        }
    }
    n
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
    /// Placed-document cache (issue 025): the whole document typeset ONCE, reused by every geometry
    /// query so an UNCHANGED document is never re-typeset on a click / drag / marquee — the body of the
    /// "선택·드래그 딜레이". Keyed by `(edit revision, font fingerprint)` — the two things that change
    /// layout — so it is transparently invalidated at exactly the five mutation points and NEVER on a
    /// read-only query:
    ///   • `open`       → a fresh handle starts with `None`.
    ///   • `applyIntent` that EDITS → `EditSession` bumps the revision → key miss → rebuild. A read-only
    ///     intent (HitTest/CaretRect/PageCount/…) pushes no undo unit → revision unchanged → cache HIT.
    ///   • `undo`/`redo` that changed something → revision bumps → rebuild (a no-op undo/redo returns
    ///     `false` and does NOT bump → cache kept).
    ///   • `registerFont` → the font fingerprint changes → key miss → rebuild.
    /// The fingerprint is `(family, bytes.len())` per injected face (issue §2). See [`HwpDoc::placed_stats`]
    /// for the hit/build counters that PROVE "unchanged document ⇒ placed once".
    #[allow(clippy::type_complexity)]
    placed_cache: RefCell<Option<(u64, Vec<(String, usize)>, hwp_session::PlacedDoc)>>,
    /// How many times the placed cache was actually (re)built — i.e. real `place_doc` runs (issue 025
    /// counter: an unchanged document over N geometry queries must show this at 1).
    place_builds: Cell<u32>,
    /// How many geometry queries were served from the cached placement (no re-typeset).
    place_hits: Cell<u32>,
    /// Opt-in "레이아웃 정리" state (default OFF = faithful render). When ON, the live doc's paragraph
    /// line-spacing has been pulled in by [`hwp_model::normalize_line_spacing`] to recover a lossy
    /// hwp→hwpx conversion's inflated spacing (a Hancom "save as .hwpx" collapses body paragraphs onto
    /// the 160% default; this restores ~130%). See `set_normalize`.
    normalize_on: Cell<bool>,
    /// Snapshot of every `para_shape.line_spacing_value` at OPEN (faithful baseline). Toggling
    /// normalization OFF restores these, so the transform is fully reversible without re-parsing —
    /// and edit-interned shapes (indices ≥ baseline length) are left untouched by the restore.
    ls_baseline: Vec<i32>,
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
        // Faithful baseline of every paragraph shape's line spacing, captured BEFORE any normalization
        // so the "레이아웃 정리" toggle is reversible (see `set_normalize`).
        let ls_baseline: Vec<i32> = session
            .doc
            .as_ref()
            .map(|d| {
                d.doc()
                    .para_shapes
                    .iter()
                    .map(|s| s.line_spacing_value)
                    .collect()
            })
            .unwrap_or_default();
        // OPEN-TIME layout mode. A Hancom "save as .hwpx" DEGRADES the document (body line spacing
        // collapsed onto the 160% default; auto-fit table rows re-floored to nominal heights) — even
        // Hancom renders such a file ~2 pages looser than its .hwp original. What the user expects on
        // upload is the ORIGINAL's look, so when the degraded fingerprint matches we AUTO-APPLY 레이아웃
        // 정리 (line-spacing recovery + content-fit tables ≈ the .hwp look) and report it via
        // `normalize_active`; the faithful Hancom-mirror stays ONE TOGGLE away (`set_normalize(false)`).
        // A genuine document (fingerprint miss) opens FAITHFUL: floors applied, nothing recovered.
        let mut auto_norm = false;
        if let Some(ed) = session.doc.as_mut() {
            let doc = ed.doc_mut();
            let r = hwp_model::normalize::normalize_line_spacing(doc);
            if r.applied {
                hwp_model::normalize::content_fit_autofit_tables(doc);
                auto_norm = true;
            } else {
                hwp_model::normalize::apply_faithful_table_heights(doc);
            }
        }
        Ok(HwpDoc {
            session,
            title,
            fonts: Vec::new(),
            svg_cache: RefCell::new(None),
            placed_cache: RefCell::new(None),
            place_builds: Cell::new(0),
            place_hits: Cell::new(0),
            normalize_on: Cell::new(auto_norm),
            ls_baseline,
        })
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
        // Measure with the injected face when one is registered (issue 022): screen SVG, layout
        // pagination and PDF embed then all use the SAME bytes. No font registered → an empty slice,
        // which `render_svg_with` maps to the un-injected discover/Approx path (backward compat).
        let svgs = hwp_session::render_svg_with(doc, &self.fonts);
        *self.svg_cache.borrow_mut() = Some((rev, svgs.clone()));
        Ok(svgs)
    }

    /// The current injected-font fingerprint `(family, len)` — the second half of the placed-cache key
    /// (issue 025). A registered/replaced face changes it, invalidating the cached placement.
    fn font_fingerprint(&self) -> Vec<(String, usize)> {
        self.fonts
            .iter()
            .map(|(fam, b)| (fam.clone(), b.len()))
            .collect()
    }

    /// Run `f` against the document's placed geometry, TYPESETTING only when the cache is cold or the
    /// `(revision, font fingerprint)` key changed — otherwise the cached [`hwp_session::PlacedDoc`] is
    /// reused (issue 025). This is the single choke point that turns per-click re-typesetting into
    /// "typeset once per document". `f` receives BOTH the live `SemanticDoc` (some queries read model
    /// text back) and the placed geometry.
    fn with_placed<R>(
        &self,
        f: impl FnOnce(&hwp_model::prelude::SemanticDoc, &hwp_session::PlacedDoc) -> R,
    ) -> Result<R, JsValue> {
        let rev = self.revision();
        let fp = self.font_fingerprint();
        // Fast path: a live cache whose key still matches → no typeset.
        if let Some((crev, cfp, placed)) = self.placed_cache.borrow().as_ref() {
            if *crev == rev && *cfp == fp {
                self.place_hits.set(self.place_hits.get() + 1);
                let doc = self.doc()?;
                return Ok(f(doc, placed));
            }
        }
        // Miss: typeset once, run `f`, then store for the next query at this revision/font.
        let doc = self.doc()?;
        let placed = hwp_session::place(doc, &self.fonts);
        self.place_builds.set(self.place_builds.get() + 1);
        let out = f(doc, &placed);
        *self.placed_cache.borrow_mut() = Some((rev, fp, placed));
        Ok(out)
    }

    /// Diagnostics for the layout cache (issue 025): a JSON string `{placeBuilds, placeHits, revision,
    /// fonts}`. `placeBuilds` is how many real `place_doc` runs happened; after opening a document and
    /// firing N geometry queries WITHOUT editing, it must read `1` (the rest are `placeHits`). The node
    /// benchmark reads this to prove "문서 불변 시 place 1회".
    #[wasm_bindgen(js_name = placedStats)]
    pub fn placed_stats(&self) -> String {
        format!(
            "{{\"placeBuilds\":{},\"placeHits\":{},\"revision\":{},\"fonts\":{}}}",
            self.place_builds.get(),
            self.place_hits.get(),
            self.revision(),
            self.fonts.len()
        )
    }

    /// Number of pages in the current document (OUR own-render pagination — no rhwp re-render).
    #[wasm_bindgen(js_name = pageCount)]
    pub fn page_count(&self) -> Result<usize, JsValue> {
        Ok(self.render_all()?.len())
    }

    /// Toggle the opt-in "레이아웃 정리" (layout normalization). Default is OFF = FAITHFUL: the document
    /// renders exactly as the file specifies (how Hancom itself renders it). Turning it ON recovers a
    /// LOSSY hwp→hwpx conversion's inflated line-spacing — a Hancom "save as .hwpx" collapses most body
    /// paragraphs onto the 160% default paragraph shape, so the same document renders ~1.6× looser than
    /// its `.hwp` twin; this pulls those collapsed paragraphs back to the pool's central tight spacing
    /// (~130%), approximating the original.
    ///
    /// Idempotent and reversible: it ALWAYS restores the faithful baseline first, then re-applies the
    /// transform if `on`. It is a RENDER-IR mutation only — the round-trip bytes are untouched (an
    /// unedited paragraph re-emits its original `paraPrIDRef`), so a save round-trips verbatim either
    /// way. Returns a JSON report `{on, applied, loosePct, targetPct, paragraphsTouched, total}` so the
    /// UI can show whether the current document actually looked degraded.
    ///
    /// The revision is deliberately NOT bumped (this is a view choice, not an undoable edit), so the
    /// render/geometry caches are cleared explicitly here to avoid serving stale (pre-transform) layout.
    #[wasm_bindgen(js_name = setNormalize)]
    pub fn set_normalize(&mut self, on: bool) -> Result<String, JsValue> {
        let baseline = self.ls_baseline.clone();
        let edit = self
            .session
            .doc
            .as_mut()
            .ok_or_else(|| js_err("no_document", "no document open (call open first)"))?;
        let doc = edit.doc_mut();
        // Always start from the FAITHFUL baseline so the toggle is stateless w.r.t. the prior state:
        //  • line spacing → the captured per-shape baseline, and
        //  • auto-fit table rows → floored to their stored `<hp:cellSz>` heights (mirror Hancom).
        for (i, &v) in baseline.iter().enumerate() {
            if let Some(s) = doc.para_shapes.get_mut(i) {
                s.line_spacing_value = v;
            }
        }
        hwp_model::normalize::apply_faithful_table_heights(doc);
        let report = if on {
            let r = hwp_model::normalize::normalize_line_spacing(doc);
            // Only recover the .hwp table density when the doc actually looked degraded — a genuine
            // document keeps its faithful (Hancom-mirroring) row heights.
            if r.applied {
                hwp_model::normalize::content_fit_autofit_tables(doc);
            }
            r
        } else {
            hwp_model::normalize::NormalizeReport {
                total_paragraphs: doc_paragraph_count(doc),
                ..Default::default()
            }
        };
        // View change, not an edit → revision unchanged → clear the layout caches by hand.
        *self.svg_cache.borrow_mut() = None;
        *self.placed_cache.borrow_mut() = None;
        self.normalize_on.set(on);
        Ok(format!(
            "{{\"on\":{},\"applied\":{},\"loosePct\":{},\"targetPct\":{},\"paragraphsTouched\":{},\"total\":{}}}",
            on,
            report.applied,
            report.loose_pct,
            report.target_pct,
            report.paragraphs_touched,
            report.total_paragraphs
        ))
    }

    /// Whether "레이아웃 정리" is currently ON.
    #[wasm_bindgen(js_name = normalizeActive)]
    pub fn normalize_active(&self) -> bool {
        self.normalize_on.get()
    }

    /// Own-render SVG **string** for page `n` (0-based). The fidelity surface (issue 012 `render_svg`).
    ///
    /// ⚠️ SECURITY (R7): this is UNTRUSTED, document-derived output. NEVER `innerHTML` it raw — route
    /// through the loader's `sanitizeSvg` (DOMParser + strip `<script>`/`on*`). Full sanitize is 016.
    #[wasm_bindgen(js_name = renderPageSvg)]
    pub fn render_page_svg(&self, n: usize) -> Result<String, JsValue> {
        let svgs = self.render_all()?;
        svgs.get(n).cloned().ok_or_else(|| {
            js_err(
                "out_of_range",
                &format!("page {n} out of range (0..{})", svgs.len()),
            )
        })
    }

    /// Click-to-point hit test on `page` at own-render px `(x, y)` — a JSON **string** of the top-level
    /// block under the point (`section`/`block`/`kind`/box/`text`/`editable`), or **JS `null`** on a
    /// miss (an `Option<String>` → `null`, never the literal string `"null"` — bindings policy 018).
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, page: u32, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        // Served from the cached placement (issue 025) so a click never re-typesets. The `_placed`
        // query agrees with the injected-metric SVG because the cache is built with the SAME injected
        // fonts (a registered font re-paginates — Approx geometry over shaper layout would miss).
        let hit = self
            .with_placed(|doc, placed| hwp_session::own_hit_test_placed(doc, placed, page, x, y))?;
        hit.map(|h| serde_json::to_string(&h).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Click-to-mark table hit test on `page` at own-render px `(x, y)` — a JSON **string** of the
    /// placed table box (`section`/`block`/box/`rows`/`cols`/`first_row`) for marking, or **JS `null`**
    /// on a miss (an `Option<String>` → `null`, never the literal string `"null"` — policy 018).
    #[wasm_bindgen(js_name = tableAt)]
    pub fn table_at(&self, page: u32, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        let t =
            self.with_placed(|_doc, placed| hwp_session::table_at_placed(placed, page, x, y))?;
        t.map(|t| serde_json::to_string(&t).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Click-to-select the ANCHORED IMAGE under `page` at own-render px `(x, y)` — a JSON **string** of the
    /// topmost image's own placed box (`{x,y,w,h,section,block}`) for the 8-handle move/resize overlay
    /// (issue 049), or **JS `null`** on a miss (an `Option<String>` → `null`, never the literal `"null"` —
    /// policy 018). Distinct from `hitTest` (which returns the paragraph BAND that holds the image); this
    /// reads the image's OWN rectangle from the placed `pg.images` list. Served from the cached placement
    /// (issue 025) so a click never re-typesets. Additive wasm binding of the existing
    /// `hwp_session::image_at_placed` (the geometry the desktop `image_at` command already exposes).
    #[wasm_bindgen(js_name = imageAt)]
    pub fn image_at(&self, page: u32, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        let im =
            self.with_placed(|_doc, placed| hwp_session::image_at_placed(placed, page, x, y))?;
        im.map(|im| serde_json::to_string(&im).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// The placed box of the image anchored at `(section, block)` on `page` — a JSON **string** of
    /// `{x,y,w,h,section,block}` (own-render px), or **JS `null`** when that image isn't on the page (an
    /// `Option<String>` → `null` — policy 018). The overlay re-queries this AFTER a move/resize commit to
    /// RE-PLACE the handles on the moved image AND to APPLY-VERIFY the edit (issue 049 §적용-확인). Served
    /// from the cached placement (issue 025). Additive wasm binding of `hwp_session::image_bbox_placed`
    /// (the `image_bbox` command's twin — the desktop had it, wasm didn't).
    #[wasm_bindgen(js_name = imageBbox)]
    pub fn image_bbox(
        &self,
        page: u32,
        section: usize,
        block: usize,
    ) -> Result<Option<String>, JsValue> {
        let b = self.with_placed(|_doc, placed| {
            hwp_session::image_bbox_placed(placed, page, section, block)
        })?;
        b.map(|b| serde_json::to_string(&b).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Cell-level marking hit test on `page` at own-render px `(x, y)` — a JSON **string** of the table
    /// CELL under the point (`section`/`block`/`row`/`col`/`rows`/`cols`/`text`/box) for cell-precise
    /// anchoring (issue 023), or **JS `null`** on a miss (an `Option<String>` → `null`, never the literal
    /// string `"null"` — policy 018). `row`/`col` are MODEL-GLOBAL (already global on a split-table
    /// fragment — do NOT re-add `first_row`). Uses the `_with` metric variant so the cell geometry agrees
    /// with the injected-metric SVG (a registered font re-paginates — Approx geometry over shaper layout
    /// would resolve the wrong cell / miss).
    #[wasm_bindgen(js_name = tableCellAt)]
    pub fn table_cell_at(&self, page: u32, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        let c = self.with_placed(|doc, placed| {
            hwp_session::table_cell_at_placed(doc, placed, page, x, y)
        })?;
        c.map(|c| serde_json::to_string(&c).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Marquee (rubber-band) select on `page`: every top-level block whose placed band intersects the
    /// own-render px rectangle `(x0,y0)-(x1,y1)` (corners in any order), as a JSON **string** of a
    /// `BlockHit[]` array. A miss returns the JSON **`"[]"`** (an EMPTY ARRAY, never `null` — the
    /// caller always gets an iterable). Additive to `hitTest`: same `PlacedBlock` bands, but 2-D AABB
    /// overlap against the rect. Multi-page marquee is out of scope — clip the rect to the start page.
    #[wasm_bindgen(js_name = blocksInRect)]
    pub fn blocks_in_rect(
        &self,
        page: u32,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
    ) -> Result<String, JsValue> {
        let hits = self.with_placed(|doc, placed| {
            hwp_session::blocks_in_rect_placed(doc, placed, page, x0, y0, x1, y1)
        })?;
        serde_json::to_string(&hits).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// Column-boundary x-positions (own-render px) of the table at `(section, block)` on `page` — the
    /// `cols + 1` absolute px the column-resize handles are drawn on, from the table left to its right
    /// (issue 027 열너비 드래그). A JSON **string** of a `number[]`, or **JS `null`** when the table
    /// isn't on the page (an `Option<String>` → `null` — policy 018). Served from the cached placement
    /// (issue 025) so a drag never re-typesets; the boundaries land exactly on the painted grid because
    /// they derive from the SAME `column_offsets` the renderer used. Additive wasm binding of the
    /// existing `hwp_session::table_col_boundaries_placed` (geometry exposure gap — issue 027 §열 경계).
    #[wasm_bindgen(js_name = tableColBoundaries)]
    pub fn table_col_boundaries(
        &self,
        page: u32,
        section: usize,
        block: usize,
    ) -> Result<Option<String>, JsValue> {
        let b = self.with_placed(|doc, placed| {
            hwp_session::table_col_boundaries_placed(doc, placed, page, section, block)
        })?;
        b.map(|b| serde_json::to_string(&b).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Row-boundary y-positions (own-render px) of the table at `(section, block)` on `page` — the
    /// `rows + 1` absolute px the ROW-height resize handles are drawn on, top→bottom (issue 031 행높이
    /// 드래그). A JSON **string** of a `number[]`, or **JS `null`** when the table isn't on the page (an
    /// `Option<String>` → `null` — policy 018). Additive wasm binding of the existing
    /// `hwp_session::table_row_boundaries_placed` — the ROW twin of `tableColBoundaries`. Unlike the
    /// column query, row geometry ALSO needs the font-metrics provider (it re-measures the row content
    /// heights the way `place_table` drew them), so we build the SAME `own_render_fonts_with(&self.fonts)`
    /// the cached placement was built with — otherwise the boundaries wouldn't line up with the grid. On
    /// a SPLIT table `_placed` returns the per-page FRAGMENT's boundaries (already rebased to the fragment
    /// top — 023 규칙), which the host remaps to a whole-table `heights` vector before committing.
    #[wasm_bindgen(js_name = tableRowBoundaries)]
    pub fn table_row_boundaries(
        &self,
        page: u32,
        section: usize,
        block: usize,
    ) -> Result<Option<String>, JsValue> {
        let fonts = hwp_session::own_render_fonts_with(&self.fonts);
        let b = self.with_placed(|doc, placed| {
            hwp_session::table_row_boundaries_placed(
                doc,
                placed,
                fonts.as_ref(),
                page,
                section,
                block,
            )
        })?;
        b.map(|b| serde_json::to_string(&b).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Cell-addressed caret, hit half (issue 053): the TABLE-CELL text caret target under own-render
    /// px `(x, y)` on `page` — a JSON **string** `{section, block, row, col, para, offset, para_len,
    /// caret:{page,x,top,height}}`, or **JS `null`** off any cell text (an `Option<String>` → `null` —
    /// policy 018). Served from the cached placement with THIS handle's injected fonts, so the caret
    /// geometry agrees with the visible SVG exactly (the Intent lane's default-font dispatch would
    /// drift once a font is registered — same reasoning as `tableRowBoundaries`).
    #[wasm_bindgen(js_name = cellTextHit)]
    pub fn cell_text_hit(&self, page: u32, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        let fonts = hwp_session::own_render_fonts_with(&self.fonts);
        let h = self.with_placed(|doc, placed| {
            hwp_session::cell_text_hit_placed(doc, placed, fonts.as_ref(), page, x, y)
        })?;
        h.map(|h| serde_json::to_string(&h).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Cell-addressed caret, geometry half (issue 053): the caret rect at char `offset` of the
    /// `para`-th paragraph of cell `(row, col)` of the table block at `(section, block)` — a JSON
    /// **string** `{page, x, top, height}` (own-render px + the owning fragment's 0-based page), or
    /// **JS `null`** when the address doesn't resolve (policy 018). A PAST-END `offset` CLAMPS to the
    /// paragraph end (a rect, never null — the `CaretRect` contract). Same injected-font placement as
    /// `cellTextHit`, so hit → caret → typing all stay on one geometry.
    #[wasm_bindgen(js_name = cellCaretRect)]
    pub fn cell_caret_rect(
        &self,
        section: usize,
        block: usize,
        row: usize,
        col: usize,
        para: usize,
        offset: usize,
    ) -> Result<Option<String>, JsValue> {
        let fonts = hwp_session::own_render_fonts_with(&self.fonts);
        let c = self.with_placed(|doc, placed| {
            hwp_session::cell_caret_rect_placed(
                doc,
                placed,
                fonts.as_ref(),
                section,
                block,
                row,
                col,
                para,
                offset,
            )
        })?;
        c.map(|c| serde_json::to_string(&c).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Page geometry in own-render px: the page box + printable-area margins of `page`, for the editor
    /// ruler (issue 027 룰러). A JSON **string** `{w,h,ml,mt,mr,mb}` (all px = HWPUNIT/75), or **JS
    /// `null`** when the page is out of range (an `Option<String>` → `null` — policy 018). Additive wasm
    /// binding of the existing `hwp_session::page_geometry_placed` (geometry exposure gap — issue 027).
    #[wasm_bindgen(js_name = pageGeometry)]
    pub fn page_geometry(&self, page: u32) -> Result<Option<String>, JsValue> {
        let g = self.with_placed(|_doc, placed| hwp_session::page_geometry_placed(placed, page))?;
        g.map(|g| serde_json::to_string(&g).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// ALL styled runs of a target paragraph (`row`/`col` = `null`) or the `(row, col)` cell — a JSON
    /// **string** of a `RunSpec[]` (`{text,bold,italic,underline,strike,size_pt,color,highlight,font}`),
    /// a multi-paragraph cell's paragraphs joined by a `"\n"` run. The text-edit popover reads these so a
    /// plain-text edit can INHERIT the existing run styling (issue 027 §함정: 볼드 셀 수정 후 볼드 유지 —
    /// 평문 variant 금지). Additive wasm binding of the existing `hwp_session::block_runs` (the run-preserve
    /// read the edit lane exposed on desktop but never on wasm).
    #[wasm_bindgen(js_name = blockRuns)]
    pub fn block_runs(
        &self,
        section: usize,
        block: usize,
        row: Option<usize>,
        col: Option<usize>,
    ) -> Result<String, JsValue> {
        let runs = hwp_session::block_runs(self.doc()?, section, block, row, col);
        serde_json::to_string(&runs).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// ALL styled runs of a (possibly NESTED) cell addressed by its descending `CellPath` (issue 064
    /// Tier-2) — a JSON **string** of a `RunSpec[]`, the nested-cell twin of [`Self::block_runs`]. `path_json`
    /// is the `CellHit.path` array (`[{block,row,col}]`) the editor prefills a nested LEAF cell from; a
    /// length-1 path is exactly the flat `blockRuns(section, block, row, col)` cell → back-compat. Bad
    /// JSON → an error; an unresolved path → `"[]"`.
    #[wasm_bindgen(js_name = blockRunsPath)]
    pub fn block_runs_path(&self, section: usize, path_json: &str) -> Result<String, JsValue> {
        let path: Vec<hwp_session::CellAddrDto> =
            serde_json::from_str(path_json).map_err(|e| js_err("parse path", &e.to_string()))?;
        let runs = hwp_session::block_runs_path(self.doc()?, section, &path);
        serde_json::to_string(&runs).map_err(|e| js_err("serialize", &e.to_string()))
    }

    /// The cell GRID of the table block at `(section, block)` — a JSON **string** of `{section, block,
    /// rows, cols, cells:[{row, col, text}]}` (only ACTIVE/uncovered cells), or **JS `null`** when the
    /// block isn't a table (an `Option<String>` → `null`, never the literal `"null"` — bindings policy
    /// 018). The vibe-editing doc-context source (issue 066): the AI reads each cell's MODEL address +
    /// current text so "표 채워줘"/라벨-기반 셀 지정이 정확해진다. Coordinates are the SAME `(row, col)`
    /// `SetTableCell` writes (`edit_target` inner table — issue 066 §좌표계). Pure MODEL read (no
    /// placement / no fonts), so it never re-typesets and agrees with the edit lane on binary .hwp too.
    #[wasm_bindgen(js_name = tableGrid)]
    pub fn table_grid(&self, section: usize, block: usize) -> Result<Option<String>, JsValue> {
        hwp_session::table_grid(self.doc()?, section, block)
            .map(|g| serde_json::to_string(&g).map_err(|e| js_err("serialize", &e.to_string())))
            .transpose()
    }

    /// Document outline for the left nav panel (issue 046) — the gov-doc's top-level headings (□/■-prefixed
    /// section labels + numbered section-band tables), each with the 0-based `page` it starts on, as a JSON
    /// **string** of an `OutlineItem[]` (`{section, block, level, text, page}`). Returns the JSON **`"[]"`**
    /// for a document with no detected heading (an EMPTY ARRAY, never null — the caller always gets an
    /// iterable and falls back to a plain page list). Additive wasm binding of the existing
    /// [`hwp_session::outline`] — the SAME heading source the desktop `doc_outline` command uses, so cell
    /// text is never mistaken for a heading (issue §셀 텍스트 오인 금지) and both shells agree.
    #[wasm_bindgen(js_name = outline)]
    pub fn outline(&self) -> Result<String, JsValue> {
        let items = hwp_session::outline(self.doc()?);
        serde_json::to_string(&items).map_err(|e| js_err("serialize", &e.to_string()))
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

    /// Inject a font face `(family, bytes)` used for BOTH the layout metrics AND the PDF embed (issue
    /// 022 — mirrors 018's PDF byte-injection into the metric path). `bytes` is a **single-face
    /// TTF/OTF** (e.g. NanumGothic/Noto Sans KR, OFL); a **TTC collection is rejected** with
    /// `{code:"ttc_unsupported"}` (krilla's simple-text can't subset a collection and our shaper takes
    /// face index 0 only) — no silent wrong-glyph fallback (issue §함정).
    ///
    /// ## Contract: registering a font RE-LAYOUTS the document; faces ACCUMULATE by family (issue 058)
    /// The FIRST registered face is the body face — it backs the layout metrics (`own_render_fonts_with`
    /// takes the first parseable face) and the PDF gothic body. Registering a DIFFERENT family ADDS it
    /// (e.g. a "Noto Serif KR" serif substitute so 명조 runs draw serif — issue 058); registering the
    /// SAME family again REPLACES its bytes. So a host injects the gothic body first, then optionally a
    /// serif face. Because real metrics differ from the Approx fallback, the first registration can
    /// change the page count and line breaks, so this **invalidates the SVG cache**; the host MUST
    /// re-query [`HwpDoc::page_count`] and re-render after calling it (the `@tf-hwp/react` workspace
    /// bumps its refresh token on `registerFont`). Until a font is registered, render/layout use the
    /// deterministic Approx fallback (backward compatible) and `export_pdf` throws `font_missing`.
    #[wasm_bindgen(js_name = registerFont)]
    pub fn register_font(&mut self, family: String, bytes: Vec<u8>) -> Result<(), JsValue> {
        if bytes.starts_with(b"ttcf") {
            return Err(js_err(
                "ttc_unsupported",
                "TTC(글꼴 컬렉션)는 지원하지 않습니다 — 단일 TTF/OTF 파일을 선택하세요 (krilla 서브셋 제약)",
            ));
        }
        // Upsert by family (issue 058): replace this family's bytes in place if present (so re-picking a
        // face takes effect immediately), else append (so a serif substitute coexists with the gothic
        // body — the first-registered body still backs metrics). Invalidate the revision-keyed SVG cache
        // — the new metrics re-paginate, and a stale cache would make the screen disagree with the PDF
        // (issue §함정: 캐시 무효화).
        match self.fonts.iter_mut().find(|(f, _)| *f == family) {
            Some(slot) => slot.1 = bytes,
            None => self.fonts.push((family, bytes)),
        }
        *self.svg_cache.borrow_mut() = None;
        // The placed-cache key already carries the font fingerprint (so it would rebuild on the next
        // query anyway), but drop it explicitly here too — registerFont is one of the five documented
        // invalidation points and the new metrics re-paginate (issue 025 §함정: registerFont 무효화).
        *self.placed_cache.borrow_mut() = None;
        Ok(())
    }

    /// Export the live document to PDF bytes (krilla, via `hwp-session::emit_pdf_with_fonts`). Throws
    /// `{code:"font_missing"}` if no font was registered (no silent empty glyphs — issue §함정). The
    /// registered `(family, bytes)` faces are handed to krilla, which subsets the injected face to the
    /// glyphs actually drawn.
    #[wasm_bindgen(js_name = exportPdf)]
    pub fn export_pdf(&self) -> Result<Vec<u8>, JsValue> {
        if self.fonts.is_empty() {
            return Err(js_err(
                "font_missing",
                "exportPdf requires a font — call registerFont(family, bytes) first (no bundled fonts, R8)",
            ));
        }
        let doc = self.doc()?;
        let out = hwp_session::emit_pdf_with_fonts(doc, self.title.clone(), &self.fonts)
            .map_err(engine_err)?;
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
        Opened {
            format,
            editable,
            sections,
        } => {
            json!({ "kind": "opened", "format": format, "editable": editable, "sections": sections })
        }
        PageCount(n) => json!({ "kind": "pageCount", "pages": n }),
        Rendered(svg) => json!({ "kind": "rendered", "svg": svg }),
        Applied { blocks, ops } => json!({ "kind": "applied", "blocks": blocks, "ops": ops }),
        Exported { bytes, open_safe } => {
            json!({ "kind": "exported", "bytes": bytes, "openSafe": open_safe })
        }
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
        Replaced { replaced, pages } => {
            json!({ "kind": "replaced", "replaced": replaced, "pages": pages })
        }
        Hit(hit) => {
            json!({ "kind": "hit", "hit": serde_json::to_value(hit).unwrap_or(serde_json::Value::Null) })
        }
        Caret(caret) => {
            json!({ "kind": "caret", "caret": serde_json::to_value(caret).unwrap_or(serde_json::Value::Null) })
        }
        Edited { pages } => json!({ "kind": "edited", "pages": pages }),
        HitCell(hit) => {
            json!({ "kind": "hitCell", "hit": serde_json::to_value(hit).unwrap_or(serde_json::Value::Null) })
        }
        CaretCell(caret) => {
            json!({ "kind": "caretCell", "caret": serde_json::to_value(caret).unwrap_or(serde_json::Value::Null) })
        }
    }
}
