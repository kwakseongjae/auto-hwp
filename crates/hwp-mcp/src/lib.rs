//! Headless **MCP stdio server** for tf-hwp (Topology A, milestone A1).
//!
//! A coding agent (Claude Code, Cursor, …) speaks the Model Context Protocol — JSON-RPC 2.0 over
//! newline-delimited stdin/stdout — to drive the engine: open an HWPX, read the template + document
//! context, apply AI-authored content through the **same op-bus** a human edit uses, and export a
//! round-trip-safe HWPX. We implement the protocol ourselves (no `rmcp`) to avoid that crate's
//! version churn and keep the dependency surface license-clean — the project's "own where deps
//! block us" principle. The dispatch is pure (`handle`) so it is unit-testable without a real pipe.

pub mod server;

use hwp_ops::EditSession;
use serde::Serialize;
use serde_json::{json, Value};

/// MCP protocol revision we advertise (widely supported by current clients).
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// Serializable mirror of [`hwp_ops::find::Match`] for the typed/JSON boundary (`NodeId` is not
/// `Serialize` in the model, so we expose its inner `u64`). Built via [`FindMatch::from`].
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct FindMatch {
    pub node: u64,
    pub start: usize,
    pub len: usize,
    pub section: usize,
    pub block: usize,
}

impl From<&hwp_ops::find::Match> for FindMatch {
    fn from(m: &hwp_ops::find::Match) -> Self {
        FindMatch { node: m.node.0, start: m.start, len: m.len, section: m.section, block: m.block }
    }
}

/// The model target a click resolved to (the editable half of the WYSIWYG caret). `node`/`block` are
/// `None` for a click inside a table cell or on a doc whose paragraphs carry no NodeId (an unedited
/// binary .hwp) — geometry is still available, but there is no editable target in v1. `offset` is the
/// caret position in PARAGRAPH chars; `section`/`para_ord` index the geometry side.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct HitResult {
    pub node: Option<u64>,
    pub block: Option<usize>,
    pub offset: usize,
    pub section: usize,
    pub para_ord: usize,
    pub in_cell: bool,
    /// Editable char length of the resolved paragraph (0 if unaddressed) — the frontend clamps caret
    /// moves to it, since caret_rect clamps past-end offsets rather than returning None (so the UI
    /// must NOT infer end-of-paragraph from a null rect).
    pub para_len: usize,
}

/// A caret rectangle in page (unscaled) coordinates — the geometry half of the WYSIWYG caret. If the
/// frontend zooms the SVG it must scale these by the same factor.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CaretRect {
    pub x: f64,
    pub top: f64,
    pub height: f64,
}

/// Server-side session: the currently-open document with its undo/redo history
/// (mutated by `apply_content`; reverted by the `undo`/`redo` tools).
#[derive(Default)]
pub struct Session {
    pub doc: Option<EditSession>,
    pub source_path: Option<String>,
    /// Original file bytes — for rendering HW5 (view-only) sources that can't be serialized to HWPX.
    pub source_bytes: Option<Vec<u8>>,
    /// A validated-but-uncommitted edit from `propose_content`, awaiting `commit_proposal`.
    pub pending: Option<hwp_ai::Proposal>,
    /// Persistent render state (engine seam 1): serialized bytes cached at a doc revision + a
    /// parse-once `RenderCache`, so repeated page renders (scrolling) do not re-serialize/re-parse.
    #[cfg(feature = "rhwp")]
    render: RenderState,
}

/// Render-side cache for one open document (engine seam 1). Reset on `open_document`.
#[cfg(feature = "rhwp")]
#[derive(Default)]
struct RenderState {
    /// `(EditSession revision, serialized bytes)` — re-serialize only when the revision changes.
    bytes: Option<(u64, Vec<u8>)>,
    /// Parse-once cache over those bytes (reuses one parsed `DocumentCore` across pages).
    cache: hwp_core::RenderCache,
}

/// True if the open document has been edited (any block marked dirty since the original parse).
#[cfg(feature = "rhwp")]
fn doc_is_edited(session: &Session) -> bool {
    session.doc.as_ref().is_some_and(|d| d.doc().any_dirty())
}

/// The bytes to feed the rhwp SVG render path — **the UNEDITED ORIGINAL ONLY** (P1: rhwp is
/// parse + faithful-original render; it must never re-render an EDITED document).
///
/// rhwp's native render is the faithful "원본 보기" of an uploaded file (true to Hancom's page
/// geometry/fonts, more faithful than our still-maturing conversion). But once the user edits, the
/// ONLY safe display is the IR → `emit_html` projection (or our own renderer): synthesizing an HWPX
/// from the edited `SemanticDoc` and re-rendering it through rhwp can silently DROP edited content
/// (issue #196 — Hancom-incompatible round-trip), the exact foot-gun P1 removes. So:
///   * UNEDITED → the original `source_bytes` (a `.hwp` OR a `.hwpx`), rendered faithfully by rhwp;
///   * EDITED   → refuse here, so the SVG path cannot show edited content (the app uses HTML mode).
#[cfg(feature = "rhwp")]
fn renderable_bytes(session: &Session) -> Result<Vec<u8>, String> {
    if doc_is_edited(session) {
        return Err(
            "원본(SVG) 렌더는 편집 전 문서에만 제공됩니다 — 편집된 문서는 HTML 미리보기로 표시됩니다 \
             (edited docs display from the IR via emit_html, not an rhwp re-render)"
                .into(),
        );
    }
    // Unedited: render the faithful original. Both .hwp and .hwpx originals are rhwp-renderable.
    session.source_bytes.clone().ok_or("no document open".into())
}

/// The tools we expose. Kept in one place so `tools/list` and `tools/call` agree.
fn tools() -> Value {
    json!([
        {
            "name": "open_document",
            "description": "Open an HWPX file into the session (required before context/apply/export).",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Path to a .hwpx file" } },
                "required": ["path"]
            }
        },
        {
            "name": "get_context",
            "description": "Return the AI content TEMPLATE (the JSON schema to author) plus the open document's text context. Call this first, then author a content JSON for apply_content.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "apply_content",
            "description": "Apply template-conformant AI content JSON to the open document via the op-bus (synthesizes header.xml styles). Pass the JSON as a string in `content`.",
            "inputSchema": {
                "type": "object",
                "properties": { "content": { "type": "string", "description": "AiContent JSON (see get_context template)" } },
                "required": ["content"]
            }
        },
        {
            "name": "export_hwpx",
            "description": "Serialize the (edited) document to a round-trip-safe HWPX at `path` and report editor-open-safety.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Output .hwpx path" } },
                "required": ["path"]
            }
        },
        {
            "name": "extract_text",
            "description": "Return the open document's plain text (reading order).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "render_page",
            "description": "Render the CURRENT document's page to SVG — the live view (HWPX shows edits; HW5 shows the original). Lets a controller capture the render over HTTP. Needs --features rhwp.",
            "inputSchema": {
                "type": "object",
                "properties": { "page": { "type": "integer", "description": "0-based page index", "default": 0 } }
            }
        },
        {
            "name": "page_count",
            "description": "Number of rendered pages in the current document (needs --features rhwp).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "undo",
            "description": "Undo the last applied edit on the open document. No-op if there is nothing to undo.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "redo",
            "description": "Redo the last undone edit on the open document. No-op if there is nothing to redo.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "propose_content",
            "description": "Validate template-conformant AI content JSON into a PROPOSAL (compiled ops, dry-run on a scratch copy) and return a human-readable preview + rationale WITHOUT changing the document. Then call commit_proposal to apply, or call propose_content again to replace it.",
            "inputSchema": {
                "type": "object",
                "properties": { "content": { "type": "string", "description": "AiContent JSON (see get_context template)" } },
                "required": ["content"]
            }
        },
        {
            "name": "commit_proposal",
            "description": "Apply the pending proposal (from propose_content) to the document via the undoable op-bus. Errors if there is no pending proposal; reversible with undo.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "find_text",
            "description": "Find occurrences of `query` in the open document's editable simple paragraphs (read-only). Searches top-level simple body paragraphs only (table cells / headers/footers / notes are out). Returns a count + one line per match.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for" },
                    "case_sensitive": { "type": "boolean", "description": "Match case exactly (default false)" },
                    "whole_word": { "type": "boolean", "description": "Match whole words only (default false)" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "replace_text",
            "description": "Replace `query` with `replacement` in the open document's editable simple paragraphs as ONE undo unit. With `all` true replaces every occurrence; otherwise only the first. Returns how many were replaced.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for" },
                    "replacement": { "type": "string", "description": "Replacement text" },
                    "case_sensitive": { "type": "boolean", "description": "Match case exactly (default false)" },
                    "whole_word": { "type": "boolean", "description": "Match whole words only (default false)" },
                    "all": { "type": "boolean", "description": "Replace all occurrences (default false = first only)" }
                },
                "required": ["query", "replacement"]
            }
        }
    ])
}

/// Ensure `render.bytes` holds the serialized document for its CURRENT revision — re-serializing
/// only when the doc changed (engine seam 1). The revision comes from `EditSession`, which bumps it
/// on every mutation, so this never serves stale bytes.
#[cfg(feature = "rhwp")]
fn ensure_render_bytes(session: &mut Session) -> Result<(), String> {
    let rev = session
        .doc
        .as_ref()
        .ok_or("no document open (call open_document first)")?
        .revision();
    if !matches!(&session.render.bytes, Some((r, _)) if *r == rev) {
        let bytes = renderable_bytes(session)?;
        session.render.bytes = Some((rev, bytes));
    }
    Ok(())
}

/// Render the current document's page to faithful SVG via rhwp — **the UNEDITED ORIGINAL ONLY**
/// (P1). `renderable_bytes` refuses an edited doc, so this surfaces the "edited docs use HTML" error
/// rather than re-rendering synthesized HWPX. Reuses the session render cache (parse once per
/// revision; scrolling the original is cheap).
#[cfg(feature = "rhwp")]
fn render_current(session: &mut Session, page: u32) -> Result<String, String> {
    ensure_render_bytes(session)?;
    let RenderState { bytes, cache } = &mut session.render;
    let bytes = &bytes.as_ref().expect("ensured above").1;
    cache.render_page_svg(bytes, page).map_err(|e| e.to_string())
}
#[cfg(not(feature = "rhwp"))]
fn render_current(_session: &Session, _page: u32) -> Result<String, String> {
    Err("render_page needs a build with --features rhwp".into())
}

/// Live page count of the current document — the single display path's count.
///
/// P1 split: an EDITED document counts pages via OUR engine (`hwp_core::own_page_count` over the
/// live IR) — never by serializing the edited model to HWPX and re-rendering through rhwp. The
/// UNEDITED original keeps rhwp's faithful page count (matches the "원본 보기" SVG). Without the
/// `rhwp` feature there is no original render, so we always use the own-engine count.
fn page_count_u32(session: &mut Session) -> Result<u32, String> {
    let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?;
    #[cfg(feature = "rhwp")]
    if !doc.doc().any_dirty() {
        // Unedited original → rhwp's faithful page count (same cached parse as the SVG view).
        ensure_render_bytes(session)?;
        let RenderState { bytes, cache } = &mut session.render;
        let bytes = &bytes.as_ref().expect("ensured above").1;
        return cache.page_count(bytes).map_err(|e| e.to_string());
    }
    Ok(hwp_core::own_page_count(doc.doc()))
}
fn page_count_current(session: &mut Session) -> Result<String, String> {
    Ok(page_count_u32(session)?.to_string())
}

/// WYSIWYG caret — hit-test: map a page-space click `(x, y)` to an editable model target. Reuses the
/// session render cache (the SAME parsed bytes the view renders), so the geometry matches the SVG.
/// Resolves the run's stable key `(section, para_ord)` → NodeId against the LIVE editable doc
/// (`session.doc.doc()`); `node`/`block` are `None` for a cell run or a doc without NodeIds (an
/// unedited binary .hwp), in which case geometry is available but the editable target is not.
#[cfg(feature = "rhwp")]
fn hit_test_current(session: &mut Session, page: u32, x: f64, y: f64) -> Result<Option<HitResult>, String> {
    ensure_render_bytes(session)?;
    // Glyph boxes from the cached parse (clone the small result so the session borrow is released
    // before we re-borrow `session.doc` for the resolver).
    let boxes = {
        let RenderState { bytes, cache } = &mut session.render;
        let bytes = &bytes.as_ref().expect("ensured above").1;
        cache.page_glyph_boxes(bytes, page).map_err(|e| e.to_string())?
    };
    let Some(hit) = hwp_core::hit_test_page(&boxes, x, y) else { return Ok(None) };
    // Resolve to a NodeId against the live editable doc. Gated: cell runs AND unanchored runs (no
    // stable_key — e.g. a note-body run with para_index=None) stay node:None in v1 so a click never
    // mis-targets the first body paragraph.
    let (node, block, offset, para_len) = if hit.in_cell || hit.stable_key.is_none() {
        (None, None, hit.char_offset, 0)
    } else {
        let doc = session.doc.as_ref().ok_or("no document open")?.doc();
        match hwp_core::resolve_key_to_node(doc, hit.section, hit.para_ord) {
            // Clamp the geometry offset to the paragraph's editable Text length: rhwp counts
            // note-ref/inline-object chars the model stores as 0-width inlines, so the raw offset can
            // exceed it — clamping keeps a future edit op in-bounds.
            Some((id, bi)) => {
                let len = para_text_len(doc, hit.section, bi);
                (Some(id.0), Some(bi), hit.char_offset.min(len), len)
            }
            None => (None, None, hit.char_offset, 0),
        }
    };
    Ok(Some(HitResult {
        node,
        block,
        offset,
        section: hit.section,
        para_ord: hit.para_ord,
        in_cell: hit.in_cell,
        para_len,
    }))
}

/// Editable Text length (in chars) of the paragraph at `section`/`block` — used to clamp a
/// geometry-derived caret offset that rhwp may report past the model's 0-width-inline-excluded text.
#[cfg(feature = "rhwp")]
fn para_text_len(doc: &hwp_model::document::SemanticDoc, section: usize, block: usize) -> usize {
    use hwp_model::document::{Block, Inline};
    match doc.sections.get(section).and_then(|s| s.blocks.get(block)) {
        Some(Block::Paragraph(p)) => p
            .runs
            .iter()
            .flat_map(|r| &r.content)
            .filter_map(|i| if let Inline::Text(t) = i { Some(t.chars().count()) } else { None })
            .sum(),
        _ => 0,
    }
}
#[cfg(not(feature = "rhwp"))]
fn hit_test_current(_session: &mut Session, _page: u32, _x: f64, _y: f64) -> Result<Option<HitResult>, String> {
    Err("hit_test needs a build with --features rhwp".into())
}

/// WYSIWYG caret — caret rect: map an editable model target (NodeId + paragraph char offset) to a
/// page-space caret rectangle on `page`. Inverse of `hit_test_current`: NodeId → `(section, para_ord)`
/// via a doc walk, then interpolate over the page's glyph boxes. `None` if that paragraph does not
/// render on the queried page (the caller should query the page where it does).
#[cfg(feature = "rhwp")]
fn caret_rect_current(session: &mut Session, page: u32, node: u64, offset: usize) -> Result<Option<CaretRect>, String> {
    // Resolve NodeId → (section, para_ord) on the live editable doc first (immutable borrow).
    let (section, para_ord) = {
        let doc = session.doc.as_ref().ok_or("no document open")?.doc();
        match hwp_core::node_to_section_para_ord(doc, hwp_model::types::NodeId(node)) {
            Some(sp) => sp,
            None => return Ok(None),
        }
    };
    ensure_render_bytes(session)?;
    let boxes = {
        let RenderState { bytes, cache } = &mut session.render;
        let bytes = &bytes.as_ref().expect("ensured above").1;
        cache.page_glyph_boxes(bytes, page).map_err(|e| e.to_string())?
    };
    Ok(hwp_core::caret_rect_in_page(&boxes, section, para_ord, offset)
        .map(|r| CaretRect { x: r.x, top: r.top, height: r.height }))
}
#[cfg(not(feature = "rhwp"))]
fn caret_rect_current(_session: &mut Session, _page: u32, _node: u64, _offset: usize) -> Result<Option<CaretRect>, String> {
    Err("caret_rect needs a build with --features rhwp".into())
}

/// Handle one JSON-RPC message. Returns `Some(response)` for requests, `None` for notifications.
pub fn handle(req: &Value, session: &mut Session) -> Option<Value> {
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");

    // Notifications have no `id` and expect no response (`?` returns None from `handle`).
    let id = req.get("id").cloned()?;

    Some(match method {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "hwp-mcp", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": tools() })),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(name, &args, session) {
                Ok(text) => ok(id, tool_text(&text, false)),
                Err(text) => ok(id, tool_text(&text, true)),
            }
        }
        _ => err(id, -32601, &format!("method not found: {method}")),
    })
}

// ---- Shared op-bus core (one implementation behind BOTH the typed `Intent` lane used by the GUI
// ---- and the JSON `call_tool` lane used by agents — so they can never drift). ----

/// Result of opening a document.
pub(crate) struct OpenInfo {
    pub format: &'static str,
    pub editable: bool,
    pub sections: usize,
}

/// Open `path` into the session (HWP5/HWPX both view; only HWPX round-trips to an edited export).
fn do_open(session: &mut Session, path: &str) -> Result<OpenInfo, String> {
    use hwp_model::types::SourceFormat;
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let fmt = hwp_core::Engine::detect(&bytes);
    let (format, editable) = match fmt {
        SourceFormat::Hwpx => ("HWPX (editable)", true),
        // HW5 now converts to HWPX (Track A): editable + serializable. The faithful native render
        // still drives the VIEW until an edit (see renderable_bytes); editing/export use the
        // converted HWPX.
        SourceFormat::Hwp5 => ("HWP5 → HWPX (converted, editable)", true),
        SourceFormat::Hwp3 => ("HWP3 (view-only)", false),
        // P5 foreign ingest: DOCX is a full-ish editable mapping; PDF is VIEW-MOSTLY (positioned
        // glyphs + overlay), so it is not treated as round-trip-editable.
        SourceFormat::Docx => ("DOCX → SemanticDoc (editable)", true),
        SourceFormat::Pdf => ("PDF (view-mostly)", false),
        SourceFormat::Unknown => return Err("unrecognized format (not HWP/HWPX/DOCX/PDF)".into()),
    };
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    let sections = doc.sections.len();
    session.doc = Some(EditSession::new(doc));
    session.source_path = Some(path.to_string());
    session.source_bytes = Some(bytes);
    session.pending = None; // a fresh document drops any stale proposal
    #[cfg(feature = "rhwp")]
    {
        // Revisions restart per EditSession, so a new doc must drop the render cache.
        session.render = RenderState::default();
    }
    Ok(OpenInfo { format, editable, sections })
}

/// Compile + apply template-conformant content as ONE undo unit. Returns `(blocks, ops)`.
fn do_apply_content(session: &mut Session, json: &str) -> Result<(usize, usize), String> {
    let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
    let ai = hwp_ai::content::parse_content(json).map_err(|e| e.to_string())?;
    let ops = hwp_ai::content::compile_to_ops(&ai);
    sess.do_ops(&ops).map_err(|e| e.to_string())?;
    Ok((ai.blocks.len(), ops.len()))
}

/// Serialize the live doc to `path`. Returns `(byte_len, editor_open_safe)`.
fn do_export(session: &Session, path: &str) -> Result<(usize, bool), String> {
    let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
    let bytes = hwp_core::serialize_hwpx(doc).map_err(|e| e.to_string())?;
    // Crash-safe: temp+fsync+rename so a mid-write crash never corrupts the user's original file.
    hwp_core::atomic_write(std::path::Path::new(path), &bytes).map_err(|e| format!("write {path}: {e}"))?;
    Ok((bytes.len(), hwp_core::validate_hwpx(&bytes).ok))
}

/// Find every match of `query` (read-only; no mutation, no rev bump). Reused by BOTH the typed
/// `Intent::Find` lane and the `find_text` JSON tool so they can never drift.
fn do_find(
    session: &Session,
    query: &str,
    opts: hwp_ops::find::FindOptions,
) -> Result<Vec<hwp_ops::find::Match>, String> {
    let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
    Ok(hwp_ops::find::find_matches(doc, query, opts))
}

/// Replace `query` → `replacement` as ONE undo unit (replace-all when `all`, else the FIRST match).
/// Returns the number replaced. Reused by `Intent::Replace` and the `replace_text` JSON tool.
fn do_replace(
    session: &mut Session,
    query: &str,
    replacement: &str,
    opts: hwp_ops::find::FindOptions,
    all: bool,
) -> Result<usize, String> {
    let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
    // Read matches/build ops against an immutable borrow first; ops own their data, so the mutable
    // `do_ops` borrow below is borrow-checker-safe.
    let ops = if all {
        hwp_ops::find::replace_all_ops(sess.doc(), query, replacement, opts)
    } else {
        match hwp_ops::find::find_matches(sess.doc(), query, opts).first() {
            Some(m) => hwp_ops::find::replace_one_ops(sess.doc(), m, replacement),
            None => Vec::new(),
        }
    };
    // Count distinct matches replaced (robust against the op-builder's ops-per-match ratio).
    let replaced = if all {
        hwp_ops::find::find_count(sess.doc(), query, opts)
    } else {
        (!ops.is_empty()) as usize
    };
    sess.do_ops(&ops).map_err(|e| e.to_string())?; // one undo unit; no-op if empty
    Ok(replaced)
}

/// Insert `text` at a char-offset caret inside one simple paragraph as ONE undo unit (`do_op`). The
/// interactive caret's per-keystroke / IME-commit edit. Surfaces the op-bus error string verbatim
/// (e.g. "paragraph N has structural content and cannot be edited in place" on an image/equation
/// paragraph, or "caret offset X past paragraph end Y") so the UI can toast it without crashing.
fn do_insert_text(session: &mut Session, node: u64, offset: usize, text: &str) -> Result<(), String> {
    use hwp_model::types::NodeId;
    use hwp_ops::{Caret, Op};
    let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
    let op = Op::InsertText { at: Caret { node: NodeId(node), offset }, text: text.to_string() };
    sess.do_op(&op).map_err(|e| e.to_string()) // one undo unit
}

/// Delete the single char ENDING at `offset` (Backspace) as ONE undo unit. `offset == 0` is a
/// graceful no-op (nothing precedes the caret). Otherwise builds `DeleteRange{offset-1, offset}`.
/// Surfaces the op-bus error string verbatim (structural / out-of-range) so the UI can toast it.
fn do_delete_back(session: &mut Session, node: u64, offset: usize) -> Result<(), String> {
    use hwp_model::types::NodeId;
    use hwp_ops::{Caret, Op};
    if offset == 0 {
        return Ok(()); // nothing before the caret — no-op, no rev bump
    }
    let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
    let op = Op::DeleteRange {
        start: Caret { node: NodeId(node), offset: offset - 1 },
        end: Caret { node: NodeId(node), offset },
    };
    sess.do_op(&op).map_err(|e| e.to_string()) // one undo unit
}

/// A typed editor command/query — the GUI's mutation+query surface (no prose round-trips). The
/// JSON `tools/*` lane (agents) is a separate transport; both drive the same op-bus core above.
pub enum Intent {
    Open { path: String },
    PageCount,
    Render { page: u32 },
    ApplyContent { json: String },
    Export { path: String },
    Undo,
    Redo,
    ExtractText,
    /// Dry-run AI content into a previewable proposal WITHOUT mutating the doc (stashes it pending).
    Propose { json: String },
    /// Commit the pending proposal as one undo unit. Errors if none is pending.
    Commit,
    /// Drop the pending proposal without applying it.
    DiscardProposal,
    /// Read-only search of the open document's editable simple paragraphs.
    Find { query: String, case_sensitive: bool, whole_word: bool },
    /// Replace `query` → `replacement` as ONE undo unit. `all: true` = replace-all; `all: false` =
    /// replace the FIRST match only.
    Replace { query: String, replacement: String, case_sensitive: bool, whole_word: bool, all: bool },
    /// WYSIWYG caret (engine half) — map a page-space click to an editable model target.
    HitTest { page: u32, x: f64, y: f64 },
    /// WYSIWYG caret (engine half) — map a model target (NodeId + paragraph char offset) to a caret
    /// rectangle on `page`.
    CaretRect { page: u32, node: u64, offset: usize },
    /// Interactive caret — insert `text` at a char-offset caret inside one simple paragraph as ONE
    /// undo unit (the per-keystroke / IME-commit edit). Surfaces the op-bus refusal verbatim (e.g. a
    /// structural paragraph or an out-of-range offset) so the UI can toast it.
    InsertText { node: u64, offset: usize, text: String },
    /// Interactive caret — delete the single char ENDING at `offset` (Backspace) as ONE undo unit
    /// (`DeleteRange{offset-1, offset}`). `offset == 0` is a graceful no-op.
    DeleteBack { node: u64, offset: usize },
}

/// The typed result of an [`Intent`].
pub enum Outcome {
    Opened { format: &'static str, editable: bool, sections: usize },
    PageCount(u32),
    Rendered(String),
    Applied { blocks: usize, ops: usize },
    Exported { bytes: usize, open_safe: bool },
    Undone(bool),
    Redone(bool),
    Text(String),
    /// A validated, uncommitted proposal: human-readable rationale + per-op diff preview.
    Proposed { rationale: String, preview: String },
    Committed { ops: usize },
    Discarded(bool),
    /// Search results (read-only).
    Found { matches: Vec<FindMatch> },
    /// Replace result: number of occurrences replaced + the new page count (0 if no rhwp render).
    Replaced { replaced: usize, pages: u32 },
    /// Hit-test result: the editable model target, or `None` for a click off any text line.
    Hit(Option<HitResult>),
    /// Caret-rect result: the caret geometry, or `None` if the target doesn't render on that page.
    Caret(Option<CaretRect>),
    /// In-place edit result (InsertText / DeleteBack): the new page count so the UI re-renders,
    /// mirroring `Replaced` (0 when no rhwp render is available).
    Edited { pages: u32 },
}

/// Apply a typed [`Intent`] against the session, returning a typed [`Outcome`] (no string parsing).
pub fn apply_intent(session: &mut Session, intent: Intent) -> Result<Outcome, String> {
    match intent {
        Intent::Open { path } => {
            let i = do_open(session, &path)?;
            Ok(Outcome::Opened { format: i.format, editable: i.editable, sections: i.sections })
        }
        Intent::ApplyContent { json } => {
            let (blocks, ops) = do_apply_content(session, &json)?;
            Ok(Outcome::Applied { blocks, ops })
        }
        Intent::Export { path } => {
            let (bytes, open_safe) = do_export(session, &path)?;
            Ok(Outcome::Exported { bytes, open_safe })
        }
        Intent::Undo => {
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            Ok(Outcome::Undone(sess.undo()))
        }
        Intent::Redo => {
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            Ok(Outcome::Redone(sess.redo()))
        }
        Intent::ExtractText => {
            let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
            Ok(Outcome::Text(doc.plain_text()))
        }
        Intent::Propose { json } => {
            let ai = hwp_ai::content::parse_content(&json).map_err(|e| e.to_string())?;
            let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
            let proposal =
                hwp_ai::propose_from_content(doc, &ai, "GUI 제안").map_err(|e| e.to_string())?;
            let rationale = proposal.rationale.clone();
            let preview = proposal.preview();
            session.pending = Some(proposal);
            Ok(Outcome::Proposed { rationale, preview })
        }
        Intent::Commit => {
            let proposal =
                session.pending.take().ok_or("대기 중인 제안이 없습니다 (propose first)")?;
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            let ops = proposal.ops.len();
            sess.do_ops(&proposal.ops).map_err(|e| e.to_string())?;
            Ok(Outcome::Committed { ops })
        }
        Intent::DiscardProposal => Ok(Outcome::Discarded(session.pending.take().is_some())),
        Intent::Find { query, case_sensitive, whole_word } => {
            let opts = hwp_ops::find::FindOptions { case_sensitive, whole_word };
            let matches = do_find(session, &query, opts)?.iter().map(FindMatch::from).collect();
            Ok(Outcome::Found { matches })
        }
        Intent::Replace { query, replacement, case_sensitive, whole_word, all } => {
            let opts = hwp_ops::find::FindOptions { case_sensitive, whole_word };
            let replaced = do_replace(session, &query, &replacement, opts, all)?;
            // Live page count via OUR engine after the edit (P1: edited docs count from the IR).
            let pages = page_count_u32(session).unwrap_or(0);
            Ok(Outcome::Replaced { replaced, pages })
        }
        Intent::PageCount => Ok(Outcome::PageCount(page_count_u32(session)?)),
        Intent::Render { page } => {
            #[cfg(feature = "rhwp")]
            {
                Ok(Outcome::Rendered(render_current(session, page)?))
            }
            #[cfg(not(feature = "rhwp"))]
            {
                let _ = page;
                Err("render needs a build with --features rhwp".into())
            }
        }
        Intent::HitTest { page, x, y } => Ok(Outcome::Hit(hit_test_current(session, page, x, y)?)),
        Intent::CaretRect { page, node, offset } => {
            Ok(Outcome::Caret(caret_rect_current(session, page, node, offset)?))
        }
        Intent::InsertText { node, offset, text } => {
            do_insert_text(session, node, offset, &text)?;
            // Live page count after the reflow, via OUR engine (P1: edited docs count from the IR).
            let pages = page_count_u32(session).unwrap_or(0);
            Ok(Outcome::Edited { pages })
        }
        Intent::DeleteBack { node, offset } => {
            do_delete_back(session, node, offset)?;
            let pages = page_count_u32(session).unwrap_or(0);
            Ok(Outcome::Edited { pages })
        }
    }
}

/// Dispatch a tool call. Ok = result text, Err = error text (surfaced as MCP `isError`).
fn call_tool(name: &str, args: &Value, session: &mut Session) -> Result<String, String> {
    let arg_str = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        "open_document" => {
            let path = arg_str("path").ok_or("missing `path`")?;
            let i = do_open(session, &path)?;
            Ok(format!("opened {path} ({}, {} section(s))", i.format, i.sections))
        }
        "get_context" => {
            let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
            let ctx = hwp_ai::to_markdown(doc).unwrap_or_default();
            Ok(format!(
                "{}\n\n--- 문서 맥락 (DOCUMENT CONTEXT) ---\n{}",
                hwp_ai::content::template_brief(),
                ctx
            ))
        }
        "apply_content" => {
            let content = arg_str("content").ok_or("missing `content`")?;
            let (blocks, ops) = do_apply_content(session, &content)?;
            Ok(format!("applied {blocks} block(s) → {ops} op(s)"))
        }
        "export_hwpx" => {
            let path = arg_str("path").ok_or("missing `path`")?;
            let (bytes, open_safe) = do_export(session, &path)?;
            Ok(format!(
                "exported {path} ({bytes} bytes); editor-open-safety: {}",
                if open_safe { "OK" } else { "FAIL" }
            ))
        }
        "extract_text" => {
            let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
            Ok(doc.plain_text())
        }
        "undo" => {
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            Ok(if sess.undo() { "undid the last edit".into() } else { "nothing to undo".into() })
        }
        "redo" => {
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            Ok(if sess.redo() { "redid the last undone edit".into() } else { "nothing to redo".into() })
        }
        "propose_content" => {
            let content = arg_str("content").ok_or("missing `content`")?;
            let sess = session.doc.as_ref().ok_or("no document open (call open_document first)")?;
            let ai = hwp_ai::content::parse_content(&content).map_err(|e| e.to_string())?;
            let proposal =
                hwp_ai::propose_from_content(sess.doc(), &ai, "MCP 제안").map_err(|e| e.to_string())?;
            let n = proposal.ops.len();
            let preview = proposal.preview();
            session.pending = Some(proposal);
            Ok(format!("제안 준비됨 ({n} op) — 적용하려면 commit_proposal.\n\n미리보기:\n{preview}"))
        }
        "commit_proposal" => {
            let proposal =
                session.pending.take().ok_or("대기 중인 제안이 없습니다 (call propose_content first)")?;
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            let n = proposal.ops.len();
            sess.do_ops(&proposal.ops).map_err(|e| e.to_string())?;
            Ok(format!("적용 완료 ({n} op) — undo 로 되돌릴 수 있습니다"))
        }
        "render_page" => {
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(0) as u32;
            if session.doc.is_none() {
                return Err("no document open (call open_document first)".into());
            }
            render_current(session, page)
        }
        "page_count" => {
            if session.doc.is_none() {
                return Err("no document open (call open_document first)".into());
            }
            page_count_current(session)
        }
        "find_text" => {
            let query = arg_str("query").ok_or("missing `query`")?;
            let arg_bool = |k: &str| args.get(k).and_then(Value::as_bool).unwrap_or(false);
            let opts = hwp_ops::find::FindOptions {
                case_sensitive: arg_bool("case_sensitive"),
                whole_word: arg_bool("whole_word"),
            };
            let matches = do_find(session, &query, opts)?;
            let mut out = format!("{} match(es) for {query:?}", matches.len());
            for m in &matches {
                out.push_str(&format!(
                    "\nsection {} block {} node {} @ char {} len {}",
                    m.section, m.block, m.node.0, m.start, m.len
                ));
            }
            Ok(out)
        }
        "replace_text" => {
            let query = arg_str("query").ok_or("missing `query`")?;
            let replacement = arg_str("replacement").ok_or("missing `replacement`")?;
            let arg_bool = |k: &str| args.get(k).and_then(Value::as_bool).unwrap_or(false);
            let opts = hwp_ops::find::FindOptions {
                case_sensitive: arg_bool("case_sensitive"),
                whole_word: arg_bool("whole_word"),
            };
            let replaced = do_replace(session, &query, &replacement, opts, arg_bool("all"))?;
            Ok(format!("replaced {replaced} occurrence(s)"))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn showcase() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx").into()
    }

    #[test]
    fn initialize_and_list_tools() {
        let mut s = Session::default();
        let init = handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}), &mut s).unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(init["result"]["serverInfo"]["name"], "hwp-mcp");

        let list = handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &mut s).unwrap();
        let names: Vec<&str> =
            list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"open_document") && names.contains(&"apply_content") && names.contains(&"export_hwpx"));
    }

    #[test]
    fn notifications_get_no_response() {
        let mut s = Session::default();
        assert!(handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), &mut s).is_none());
    }

    #[test]
    fn full_open_apply_export_loop() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        // open
        let r = call("open_document", json!({"path": showcase()}), &mut s);
        assert_eq!(r["result"]["isError"], false, "open: {r}");
        // context includes the template
        let r = call("get_context", json!({}), &mut s);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("템플릿"));
        // apply content (styled heading + a paragraph)
        let content = r#"{"blocks":[{"type":"heading","text":"MCP로 추가","style":"개요 1"},{"type":"paragraph","runs":[{"text":"에이전트가 작성","bold":true}]}]}"#;
        let r = call("apply_content", json!({"content": content}), &mut s);
        assert_eq!(r["result"]["isError"], false, "apply: {r}");
        // export to a temp path + open-safety OK
        let out = std::env::temp_dir().join("hwp_mcp_test.hwpx");
        let r = call("export_hwpx", json!({"path": out.to_str().unwrap()}), &mut s);
        assert_eq!(r["result"]["isError"], false, "export: {r}");
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("OK"), "open-safety: {r}");
        // the exported doc reparses with our added text
        let bytes = std::fs::read(&out).unwrap();
        let doc = hwp_core::Engine::open(&bytes).unwrap();
        assert!(doc.plain_text().contains("MCP로 추가") && doc.plain_text().contains("에이전트가 작성"));
    }

    #[test]
    fn undo_redo_round_trip_through_mcp() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();

        call("open_document", json!({"path": showcase()}), &mut s);
        let content = r#"{"blocks":[{"type":"paragraph","runs":[{"text":"되돌리기 테스트"}]}]}"#;
        call("apply_content", json!({"content": content}), &mut s);
        assert!(text(&call("extract_text", json!({}), &mut s)).contains("되돌리기 테스트"));

        // undo removes the appended paragraph
        let u = call("undo", json!({}), &mut s);
        assert!(text(&u).contains("undid"), "{u}");
        assert!(!text(&call("extract_text", json!({}), &mut s)).contains("되돌리기 테스트"));

        // redo brings it back
        let rd = call("redo", json!({}), &mut s);
        assert!(text(&rd).contains("redid"), "{rd}");
        assert!(text(&call("extract_text", json!({}), &mut s)).contains("되돌리기 테스트"));

        // undo with nothing more is a graceful no-op (after one undo we're at the bottom)
        call("undo", json!({}), &mut s);
        let empty = call("undo", json!({}), &mut s);
        assert!(text(&empty).contains("nothing to undo"), "{empty}");
    }

    #[test]
    fn apply_intent_typed_lane_open_edit_undo_redo() {
        let mut s = Session::default();
        match apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap() {
            Outcome::Opened { editable, sections, .. } => {
                assert!(editable, "showcase is HWPX (editable)");
                assert!(sections >= 1);
            }
            _ => panic!("expected Opened"),
        }
        let text = |s: &mut Session| match apply_intent(s, Intent::ExtractText).unwrap() {
            Outcome::Text(t) => t,
            _ => panic!("expected Text"),
        };
        assert!(!text(&mut s).contains("인텐트 레인"));

        let content = r#"{"blocks":[{"type":"paragraph","runs":[{"text":"인텐트 레인"}]}]}"#.to_string();
        match apply_intent(&mut s, Intent::ApplyContent { json: content }).unwrap() {
            Outcome::Applied { blocks, ops } => {
                assert_eq!(blocks, 1);
                assert!(ops >= 1);
            }
            _ => panic!("expected Applied"),
        }
        assert!(text(&mut s).contains("인텐트 레인"), "typed apply mutates the doc");

        // ApplyContent is ONE undo unit (do_ops): a single undo reverts it.
        match apply_intent(&mut s, Intent::Undo).unwrap() {
            Outcome::Undone(c) => assert!(c),
            _ => panic!("expected Undone"),
        }
        assert!(!text(&mut s).contains("인텐트 레인"), "one undo reverts the whole apply");
        match apply_intent(&mut s, Intent::Redo).unwrap() {
            Outcome::Redone(c) => assert!(c),
            _ => panic!("expected Redone"),
        }
        assert!(text(&mut s).contains("인텐트 레인"));
    }

    #[test]
    fn apply_intent_propose_preview_commit_loop() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let text = |s: &mut Session| match apply_intent(s, Intent::ExtractText).unwrap() {
            Outcome::Text(t) => t,
            _ => unreachable!(),
        };

        // Propose: returns a preview, does NOT mutate the document.
        let content = r#"{"blocks":[{"type":"heading","text":"제안 미리보기","align":"center"}]}"#.to_string();
        match apply_intent(&mut s, Intent::Propose { json: content }).unwrap() {
            Outcome::Proposed { preview, .. } => assert!(preview.contains("문단")),
            _ => panic!("expected Proposed"),
        }
        assert!(!text(&mut s).contains("제안 미리보기"), "propose must not commit");

        // Commit: applies the pending proposal as one undo unit.
        match apply_intent(&mut s, Intent::Commit).unwrap() {
            Outcome::Committed { ops } => assert!(ops >= 1),
            _ => panic!("expected Committed"),
        }
        assert!(text(&mut s).contains("제안 미리보기"));
        match apply_intent(&mut s, Intent::Undo).unwrap() {
            Outcome::Undone(c) => assert!(c),
            _ => panic!(),
        }
        assert!(!text(&mut s).contains("제안 미리보기"), "one undo reverts the committed proposal");

        // Commit with nothing pending errors.
        assert!(apply_intent(&mut s, Intent::Commit).is_err());
    }

    #[test]
    fn propose_then_commit_proposal_loop() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();

        call("open_document", json!({"path": showcase()}), &mut s);
        let content = r#"{"blocks":[{"type":"heading","text":"제안 제목","align":"center"},{"type":"paragraph","runs":[{"text":"검증","bold":true}]}]}"#;

        // propose_content previews WITHOUT mutating the doc.
        let p = call("propose_content", json!({"content": content}), &mut s);
        assert_eq!(p["result"]["isError"], false, "{p}");
        assert!(text(&p).contains("미리보기"), "{}", text(&p));
        assert!(!text(&call("extract_text", json!({}), &mut s)).contains("제안 제목"), "propose must not commit");

        // commit_proposal applies it.
        let c = call("commit_proposal", json!({}), &mut s);
        assert_eq!(c["result"]["isError"], false, "{c}");
        assert!(text(&call("extract_text", json!({}), &mut s)).contains("제안 제목"));

        // committed via the undoable op-bus → undo reverts it.
        call("undo", json!({}), &mut s);
        assert!(!text(&call("extract_text", json!({}), &mut s)).contains("제안 제목"));

        // commit with nothing pending errors gracefully.
        let empty = call("commit_proposal", json!({}), &mut s);
        assert_eq!(empty["result"]["isError"], true, "{empty}");
    }

    /// P1 contract: the rhwp SVG render is the faithful "원본 보기" of the UNEDITED original — the
    /// same page renders byte-identically twice (cache hit). Once the doc is EDITED, the SVG path
    /// REFUSES (edited content must display from the IR via emit_html, not an rhwp re-render of a
    /// synthesized HWPX), while `page_count` keeps working off OUR engine. Needs the rhwp bootstrap.
    #[cfg(feature = "rhwp")]
    #[test]
    fn render_svg_is_original_only_edited_docs_refuse() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();

        let open = call("open_document", json!({"path": showcase()}), &mut s);
        assert_eq!(open["result"]["isError"], false, "{open}");

        // Two renders of page 0 (unedited original) return byte-identical SVG (cache hit).
        let a = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(a["result"]["isError"], false, "render unedited original: {a}");
        let first = text(&a);
        assert!(!first.is_empty() && first.contains("<svg"), "non-empty original SVG");
        let b = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(text(&b), first, "second render is identical (cache hit)");

        // After an edit, the SVG path REFUSES (no rhwp re-render of edited content).
        let content = r#"{"blocks":[{"type":"paragraph","runs":[{"text":"렌더 캐시 편집"}]}]}"#;
        call("apply_content", json!({"content": content}), &mut s);
        let c = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(c["result"]["isError"], true, "edited doc must NOT render via rhwp: {c}");
        assert!(text(&c).contains("HTML"), "the refusal points the user to the HTML preview: {}", text(&c));

        // …but page_count still works (via OUR engine over the edited IR), so the UI keeps a count.
        let pc = call("page_count", json!({}), &mut s);
        assert_eq!(pc["result"]["isError"], false, "page_count works on an edited doc: {pc}");
        assert!(text(&pc).trim().parse::<u32>().unwrap() >= 1, "edited page count ≥ 1: {}", text(&pc));
    }

    /// P1: `page_count` works on an EDITED doc even WITHOUT the rhwp feature (own-engine pagination),
    /// since the edited display path is IR→html, not rhwp. (Default workspace build has no rhwp.)
    #[test]
    fn page_count_uses_own_engine_after_edit() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        // Edit, then ask the page count — must succeed (own engine), regardless of the rhwp feature.
        apply_intent(
            &mut s,
            Intent::ApplyContent {
                json: r#"{"blocks":[{"type":"paragraph","runs":[{"text":"자체 엔진 페이지수"}]}]}"#.into(),
            },
        )
        .unwrap();
        match apply_intent(&mut s, Intent::PageCount).unwrap() {
            Outcome::PageCount(n) => assert!(n >= 1, "own-engine page count ≥ 1 after edit"),
            _ => panic!("expected PageCount"),
        }
    }

    #[test]
    fn find_and_replace_typed_lane() {
        // Searches the showcase's REAL parsed paragraphs (which carry NodeIds + are simple). Note:
        // paragraphs appended via apply_content have `id: None`, so they are intentionally NOT
        // searchable in v1 — find/replace operates on the existing editable body, the documented scope.
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let text = |s: &mut Session| match apply_intent(s, Intent::ExtractText).unwrap() {
            Outcome::Text(t) => t,
            _ => unreachable!(),
        };
        // '문서' appears twice in the showcase body (two different paragraphs).
        let baseline = text(&mut s).matches("문서").count();
        assert_eq!(baseline, 2, "showcase has two '문서' to search");

        // Find: both occurrences, each len 2.
        match apply_intent(
            &mut s,
            Intent::Find { query: "문서".into(), case_sensitive: false, whole_word: false },
        )
        .unwrap()
        {
            Outcome::Found { matches } => {
                assert_eq!(matches.len(), 2, "two '문서' across the showcase body");
                assert!(matches.iter().all(|m| m.len == 2));
            }
            _ => panic!("expected Found"),
        }

        // Replace-all → 2 replaced, then a SINGLE undo reverts the whole thing.
        let replaced = match apply_intent(
            &mut s,
            Intent::Replace {
                query: "문서".into(),
                replacement: "파일".into(),
                case_sensitive: false,
                whole_word: false,
                all: true,
            },
        )
        .unwrap()
        {
            Outcome::Replaced { replaced, .. } => replaced,
            _ => panic!("expected Replaced"),
        };
        assert_eq!(replaced, 2);
        assert_eq!(text(&mut s).matches("파일").count(), 2, "both '문서' became '파일'");
        assert_eq!(text(&mut s).matches("문서").count(), 0);
        match apply_intent(&mut s, Intent::Undo).unwrap() {
            Outcome::Undone(c) => assert!(c),
            _ => panic!(),
        }
        assert_eq!(text(&mut s).matches("문서").count(), 2, "one undo reverts the whole replace-all");
        assert_eq!(text(&mut s).matches("파일").count(), 0);
    }

    #[test]
    fn replace_empty_query_is_noop_no_rev_bump() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let rev = s.doc.as_ref().unwrap().revision();
        match apply_intent(
            &mut s,
            Intent::Replace {
                query: "".into(),
                replacement: "X".into(),
                case_sensitive: false,
                whole_word: false,
                all: true,
            },
        )
        .unwrap()
        {
            Outcome::Replaced { replaced, .. } => assert_eq!(replaced, 0),
            _ => panic!("expected Replaced"),
        }
        assert_eq!(s.doc.as_ref().unwrap().revision(), rev, "empty replace pushes no undo unit");
    }

    #[test]
    fn find_replace_json_tools() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();

        call("open_document", json!({"path": showcase()}), &mut s);

        // '문서' occurs twice in the showcase's existing (NodeId-bearing) paragraphs.
        let f = call("find_text", json!({"query": "문서"}), &mut s);
        assert_eq!(f["result"]["isError"], false, "{f}");
        assert!(text(&f).contains("2 match"), "{}", text(&f));

        let r = call("replace_text", json!({"query": "문서", "replacement": "파일", "all": true}), &mut s);
        assert_eq!(r["result"]["isError"], false, "{r}");
        assert!(text(&r).contains("replaced 2"), "{}", text(&r));
        let after = text(&call("extract_text", json!({}), &mut s));
        assert_eq!(after.matches("파일").count(), 2);
        assert_eq!(after.matches("문서").count(), 0);
    }

    /// WYSIWYG caret engine half through the typed Intent lane: open the showcase, hit-test a click
    /// at a KNOWN glyph (the title run "형식 테스트 문서"), confirm it resolves to that paragraph's
    /// NodeId, then round-trip the NodeId+offset back to a caret rect inside the page. Needs rhwp.
    #[cfg(feature = "rhwp")]
    #[test]
    fn hit_test_and_caret_rect_intents_round_trip() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();

        // Find the title run's box (page 0) to get a click point + its expected node.
        let bytes = renderable_bytes(&s).unwrap();
        let boxes = hwp_core::page_glyph_boxes(&bytes, 0).unwrap();
        let title = boxes
            .iter()
            .find(|b| !b.in_cell && b.char_len > 0 && b.stable_key.is_some())
            .expect("a body run on page 0");
        let click_x = (title.x0 + title.x1) / 2.0;
        let click_y = title.top + title.height / 2.0;

        let hit = match apply_intent(&mut s, Intent::HitTest { page: 0, x: click_x, y: click_y }).unwrap() {
            Outcome::Hit(h) => h.expect("a click on a glyph hits a target"),
            _ => panic!("expected Hit"),
        };
        assert!(!hit.in_cell, "title is a body run");
        let node = hit.node.expect("body run resolves to a NodeId");
        assert_eq!(hit.section, title.section);
        assert_eq!(hit.para_ord, title.para_ord);
        // offset is within the run's char span.
        assert!(hit.offset <= title.char_start + title.char_len);

        // Round-trip: NodeId + offset → caret rect on the same page, inside page bounds.
        let caret = match apply_intent(&mut s, Intent::CaretRect { page: 0, node, offset: hit.offset }).unwrap() {
            Outcome::Caret(c) => c.expect("the target renders on page 0"),
            _ => panic!("expected Caret"),
        };
        // The caret x equals the same interpolation hit_test used (within one char cell).
        let cell = (title.x1 - title.x0) / title.char_len.max(1) as f64;
        let want_x = title.x0 + cell * (hit.offset.saturating_sub(title.char_start)) as f64;
        assert!((caret.x - want_x).abs() < cell + 1e-6, "caret x {} ~ {want_x}", caret.x);
        assert_eq!(caret.top, title.top);
        assert!(caret.height > 0.0);
    }

    /// Non-rhwp honesty: the caret intents report the capability gate (the default workspace build
    /// compiles without rhwp). This always compiles; the arm differs by feature.
    #[test]
    fn caret_intents_gated_without_rhwp() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let r = apply_intent(&mut s, Intent::HitTest { page: 0, x: 0.0, y: 0.0 });
        #[cfg(not(feature = "rhwp"))]
        assert!(r.is_err(), "hit_test errors without rhwp");
        #[cfg(feature = "rhwp")]
        let _ = r; // with rhwp it's a valid (possibly None) result
    }

    // ---- Interactive caret: in-place InsertText / DeleteBack intents (per-keystroke edits) ----
    //
    // These drive the showcase's REAL parsed paragraphs, which carry NodeIds and are simple. We grab
    // a body paragraph's NodeId via a hit-test so the offset/node are real (mirrors how the UI gets
    // them from a click). rhwp-gated because the NodeId comes from the glyph-box hit-test.

    /// The NodeId + a known piece of text of the first editable body paragraph on page 0.
    #[cfg(feature = "rhwp")]
    fn first_body_node(s: &Session) -> (u64, usize) {
        let bytes = renderable_bytes(s).unwrap();
        let boxes = hwp_core::page_glyph_boxes(&bytes, 0).unwrap();
        let title = boxes
            .iter()
            .find(|b| !b.in_cell && b.char_len > 0 && b.stable_key.is_some())
            .expect("a body run on page 0");
        let doc = s.doc.as_ref().unwrap().doc();
        let (id, _bi) =
            hwp_core::resolve_key_to_node(doc, title.section, title.para_ord).expect("body run → NodeId");
        (id.0, title.char_start)
    }

    /// InsertText at a caret advances the doc text + returns a page count, and a SINGLE undo reverts
    /// the one keystroke (do_op = one undo unit). Offset-past-end is an Err, not a panic.
    #[cfg(feature = "rhwp")]
    #[test]
    fn insert_text_intent_advances_and_single_undo_reverts() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let text = |s: &mut Session| match apply_intent(s, Intent::ExtractText).unwrap() {
            Outcome::Text(t) => t,
            _ => unreachable!(),
        };
        let (node, offset) = first_body_node(&s);
        assert!(!text(&mut s).contains("끼움글자"));

        // Insert a multi-scalar Korean string at the run's start.
        match apply_intent(&mut s, Intent::InsertText { node, offset, text: "끼움글자".into() }).unwrap() {
            Outcome::Edited { pages } => assert!(pages >= 1, "page count after insert"),
            _ => panic!("expected Edited"),
        }
        assert!(text(&mut s).contains("끼움글자"), "insert advances doc text");

        // One keystroke = one undo unit: a single undo reverts it.
        match apply_intent(&mut s, Intent::Undo).unwrap() {
            Outcome::Undone(c) => assert!(c),
            _ => panic!("expected Undone"),
        }
        assert!(!text(&mut s).contains("끼움글자"), "one undo reverts a single insert");

        // Offset way past the paragraph end is an Err (surfaced to the UI), never a panic.
        let r = apply_intent(&mut s, Intent::InsertText { node, offset: 100_000, text: "X".into() });
        assert!(r.is_err(), "offset past paragraph end errors, not panics");
    }

    /// DeleteBack at offset 0 is a graceful no-op (Edited, text unchanged, no rev bump); at offset N
    /// it removes the preceding scalar; a single undo reverts that one deletion.
    #[cfg(feature = "rhwp")]
    #[test]
    fn delete_back_intent_noop_at_zero_and_deletes_preceding_scalar() {
        let mut s = Session::default();
        apply_intent(&mut s, Intent::Open { path: showcase() }).unwrap();
        let text = |s: &mut Session| match apply_intent(s, Intent::ExtractText).unwrap() {
            Outcome::Text(t) => t,
            _ => unreachable!(),
        };
        let (node, _start) = first_body_node(&s);

        // offset 0 → no-op: text unchanged AND no undo unit pushed (revision unchanged).
        let rev0 = s.doc.as_ref().unwrap().revision();
        let before = text(&mut s);
        match apply_intent(&mut s, Intent::DeleteBack { node, offset: 0 }).unwrap() {
            Outcome::Edited { .. } => {}
            _ => panic!("expected Edited"),
        }
        assert_eq!(text(&mut s), before, "delete-back at offset 0 changes nothing");
        assert_eq!(s.doc.as_ref().unwrap().revision(), rev0, "offset-0 delete pushes no undo unit");

        // Insert a sentinel char, then DeleteBack ending right after it removes exactly that scalar.
        apply_intent(&mut s, Intent::InsertText { node, offset: 0, text: "Z".into() }).unwrap();
        assert!(text(&mut s).contains('Z'), "sentinel inserted");
        let count_before = text(&mut s).matches('Z').count();
        match apply_intent(&mut s, Intent::DeleteBack { node, offset: 1 }).unwrap() {
            Outcome::Edited { .. } => {}
            _ => panic!("expected Edited"),
        }
        assert_eq!(text(&mut s).matches('Z').count(), count_before - 1, "delete-back removed the scalar");

        // One undo reverts the single deletion (the 'Z' comes back).
        match apply_intent(&mut s, Intent::Undo).unwrap() {
            Outcome::Undone(c) => assert!(c),
            _ => panic!("expected Undone"),
        }
        assert_eq!(text(&mut s).matches('Z').count(), count_before, "one undo reverts the deletion");
    }

    /// P0-3 contract: InsertText on a non-simple (structural: image/equation/ctrl/…) paragraph
    /// returns the verbatim 'structural content cannot be edited in place' Err string — never panics.
    /// The op-bus gates on `ParaSource.simple == false` (the parser sets it for any `<hp:p>` carrying
    /// non-text children), so we build a NodeId'd paragraph whose source is marked non-simple.
    #[test]
    fn insert_text_on_structural_paragraph_errors_not_panics() {
        use hwp_model::document::{Block, Inline, ParaSource, Paragraph, Run, Section};
        use hwp_model::types::NodeId;

        // A one-section doc whose only paragraph is marked structural (source.simple == false) + has
        // a NodeId. Text content is irrelevant — the refusal triggers on the non-simple source flag.
        let mut doc = hwp_model::document::SemanticDoc::default();
        let para = Paragraph {
            id: Some(NodeId(7)),
            source: Some(ParaSource { simple: false, ..Default::default() }),
            runs: vec![Run { content: vec![Inline::Text("그림".into())], ..Default::default() }],
            ..Default::default()
        };
        doc.sections.push(Section { blocks: vec![Block::Paragraph(para)], ..Default::default() });
        let mut s = Session { doc: Some(EditSession::new(doc)), ..Default::default() };

        let err = match apply_intent(&mut s, Intent::InsertText { node: 7, offset: 0, text: "X".into() }) {
            Err(e) => e,
            Ok(_) => panic!("structural paragraph must refuse in-place edit"),
        };
        assert!(
            err.contains("structural content") && err.contains("cannot be edited in place"),
            "verbatim op-bus refusal surfaced: {err}"
        );
    }

    #[test]
    fn tool_error_is_reported_not_panicked() {
        let mut s = Session::default();
        // apply before open → isError true, no panic
        let r = handle(
            &json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"extract_text","arguments":{}}}),
            &mut s,
        )
        .unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
