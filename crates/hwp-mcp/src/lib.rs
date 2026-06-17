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
use serde_json::{json, Value};

/// MCP protocol revision we advertise (widely supported by current clients).
pub const PROTOCOL_VERSION: &str = "2024-11-05";

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

/// The bytes to render: the LIVE edited HWPX if the doc serializes, else the original source
/// (HW5 sources are view-only — they don't round-trip to HWPX, so we render the original).
#[cfg(feature = "rhwp")]
fn renderable_bytes(session: &Session) -> Result<Vec<u8>, String> {
    let serialized = session.doc.as_ref().and_then(|d| hwp_core::serialize_hwpx(d.doc()).ok());
    serialized.or_else(|| session.source_bytes.clone()).ok_or("no document open".into())
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

/// Render the current document's page to SVG (live HWPX, or the original bytes for HW5). Reuses the
/// session render cache: re-serialize only on edit, parse only once per revision (scroll is cheap).
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

/// Rendered page count of the current document (reuses the same cached parse as `render_current`).
#[cfg(feature = "rhwp")]
fn page_count_u32(session: &mut Session) -> Result<u32, String> {
    ensure_render_bytes(session)?;
    let RenderState { bytes, cache } = &mut session.render;
    let bytes = &bytes.as_ref().expect("ensured above").1;
    cache.page_count(bytes).map_err(|e| e.to_string())
}
#[cfg(feature = "rhwp")]
fn page_count_current(session: &mut Session) -> Result<String, String> {
    Ok(page_count_u32(session)?.to_string())
}
#[cfg(not(feature = "rhwp"))]
fn page_count_current(_session: &Session) -> Result<String, String> {
    Err("page_count needs a build with --features rhwp".into())
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
        SourceFormat::Hwp5 => ("HWP5 (view-only — export needs HWPX)", false),
        SourceFormat::Hwp3 => ("HWP3 (view-only)", false),
        SourceFormat::Unknown => return Err("unrecognized format (not HWP/HWPX)".into()),
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
    std::fs::write(path, &bytes).map_err(|e| format!("write {path}: {e}"))?;
    Ok((bytes.len(), hwp_core::validate_hwpx(&bytes).ok))
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
        Intent::PageCount => {
            #[cfg(feature = "rhwp")]
            {
                Ok(Outcome::PageCount(page_count_u32(session)?))
            }
            #[cfg(not(feature = "rhwp"))]
            {
                Err("page_count needs a build with --features rhwp".into())
            }
        }
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

    /// Engine seam 1 wired into the session: render the same page twice → identical SVG (the
    /// cache serves a consistent result), and rendering still works after an edit (revision bump
    /// re-serializes + re-parses once). Needs the rhwp render bootstrap.
    #[cfg(feature = "rhwp")]
    #[test]
    fn render_cache_is_consistent_across_pages_and_edits() {
        let mut s = Session::default();
        let call = |name: &str, args: Value, s: &mut Session| {
            handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}), s)
                .unwrap()
        };
        let text = |r: &Value| r["result"]["content"][0]["text"].as_str().unwrap().to_string();

        let open = call("open_document", json!({"path": showcase()}), &mut s);
        assert_eq!(open["result"]["isError"], false, "{open}");

        // Two renders of page 0 return byte-identical SVG (cache serves a consistent result).
        let a = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(a["result"]["isError"], false, "render: {a}");
        let first = text(&a);
        assert!(!first.is_empty(), "non-empty SVG");
        let b = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(text(&b), first, "second render is identical (cache hit)");

        // After an edit (revision bumps → cache invalidates), rendering still succeeds.
        let content = r#"{"blocks":[{"type":"paragraph","runs":[{"text":"렌더 캐시 편집"}]}]}"#;
        call("apply_content", json!({"content": content}), &mut s);
        let c = call("render_page", json!({"page": 0}), &mut s);
        assert_eq!(c["result"]["isError"], false, "render after edit: {c}");
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
