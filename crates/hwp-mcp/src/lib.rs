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
        }
    ])
}

/// Render the current document's page to SVG (live HWPX, or the original bytes for HW5).
#[cfg(feature = "rhwp")]
fn render_current(session: &Session, page: u32) -> Result<String, String> {
    let bytes = renderable_bytes(session)?;
    hwp_core::render_page_svg(&bytes, page).map_err(|e| e.to_string())
}
#[cfg(not(feature = "rhwp"))]
fn render_current(_session: &Session, _page: u32) -> Result<String, String> {
    Err("render_page needs a build with --features rhwp".into())
}

/// Rendered page count of the current document.
#[cfg(feature = "rhwp")]
fn page_count_current(session: &Session) -> Result<String, String> {
    let bytes = renderable_bytes(session)?;
    Ok(hwp_core::page_count(&bytes).map_err(|e| e.to_string())?.to_string())
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

/// Dispatch a tool call. Ok = result text, Err = error text (surfaced as MCP `isError`).
fn call_tool(name: &str, args: &Value, session: &mut Session) -> Result<String, String> {
    let arg_str = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        "open_document" => {
            use hwp_model::types::SourceFormat;
            let path = arg_str("path").ok_or("missing `path`")?;
            let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
            let fmt = hwp_core::Engine::detect(&bytes);
            // HWP5/HWPX both open for VIEWING; only HWPX round-trips to an edited export.
            let label = match fmt {
                SourceFormat::Hwpx => "HWPX (editable)",
                SourceFormat::Hwp5 => "HWP5 (view-only — export needs HWPX)",
                SourceFormat::Hwp3 => "HWP3 (view-only)",
                SourceFormat::Unknown => return Err("unrecognized format (not HWP/HWPX)".into()),
            };
            let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
            let n = doc.sections.len();
            session.doc = Some(EditSession::new(doc));
            session.source_path = Some(path.clone());
            session.source_bytes = Some(bytes);
            Ok(format!("opened {path} ({label}, {n} section(s))"))
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
            let sess = session.doc.as_mut().ok_or("no document open (call open_document first)")?;
            let ai = hwp_ai::content::parse_content(&content).map_err(|e| e.to_string())?;
            let ops = hwp_ai::content::compile_to_ops(&ai);
            for op in &ops {
                sess.do_op(op).map_err(|e| e.to_string())?;
            }
            Ok(format!("applied {} block(s) → {} op(s)", ai.blocks.len(), ops.len()))
        }
        "export_hwpx" => {
            let path = arg_str("path").ok_or("missing `path`")?;
            let doc = session.doc.as_ref().ok_or("no document open (call open_document first)")?.doc();
            let bytes = hwp_core::serialize_hwpx(doc).map_err(|e| e.to_string())?;
            std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))?;
            let report = hwp_core::validate_hwpx(&bytes);
            Ok(format!(
                "exported {} ({} bytes); editor-open-safety: {}",
                path,
                bytes.len(),
                if report.ok { "OK" } else { "FAIL" }
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
