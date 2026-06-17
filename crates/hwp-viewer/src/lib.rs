//! tf-hwp Tauri 2 viewer shell (milestone A2).
//!
//! Opens an HWPX, renders pages faithfully (rhwp → SVG, behind `--features rhwp`), and runs
//! AI content through the **same op-bus** the CLI/MCP use — by reusing [`hwp_mcp::handle`] so
//! there is one mutation surface. The GUI window is launched by the user (`cargo run -p
//! hwp-viewer --features rhwp`, or `cargo tauri dev`); the command *logic* is factored into pure
//! functions so it is unit-testable headless. The A3 embedded control server lives in [`server`].

pub mod server;

use serde_json::{json, Value};
use std::sync::Mutex;

/// Shared op-bus session (the open document), mutated by `apply_content`/`export_hwpx` and by the
/// embedded A3 control server — so the window renders the LIVE edited document, not a stale copy.
pub type SharedSession = Mutex<hwp_mcp::Session>;

/// Call an MCP tool through the shared op-bus dispatch ([`hwp_mcp::handle`]) — the single mutation
/// surface. Returns the tool's text on success, or its error text (MCP `isError`).
pub fn mcp_call(session: &mut hwp_mcp::Session, name: &str, args: Value) -> Result<String, String> {
    let req = json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": { "name": name, "arguments": args }
    });
    let resp = hwp_mcp::handle(&req, session).ok_or("no response from op-bus")?;
    let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("").to_string();
    if resp["result"]["isError"].as_bool().unwrap_or(true) {
        Err(text)
    } else {
        Ok(text)
    }
}

// ---- Tauri commands: typed `Intent` lane (no prose parsing; same op-bus core as the MCP lane) ----

use hwp_mcp::{apply_intent, Intent, Outcome};

/// Live page count via the typed Intent lane (0 if unavailable, e.g. no rhwp render).
fn pages(s: &mut hwp_mcp::Session) -> u32 {
    match apply_intent(s, Intent::PageCount) {
        Ok(Outcome::PageCount(n)) => n,
        _ => 0,
    }
}

#[tauri::command]
fn open_doc(path: String, sess: tauri::State<'_, SharedSession>) -> Result<Value, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    let original = path.clone();
    // accepts .hwp (view) and .hwpx; surface the 2-tier capability (editable) + format for the chip.
    let (format, editable) = match apply_intent(&mut s, Intent::Open { path })? {
        Outcome::Opened { format, editable, .. } => (format, editable),
        _ => return Err("unexpected outcome".into()),
    };

    // Auto-convert a binary .hwp: save an editable `.hwpx` beside the original so the user gets a
    // round-trip-safe copy to work in. Best-effort — a write failure (e.g. read-only folder) must
    // NOT break opening the view, which keeps rendering the faithful native .hwp until an edit.
    let mut converted_path = Value::Null;
    if format.starts_with("HWP5") {
        let hwpx = std::path::Path::new(&original).with_extension("hwpx");
        if hwpx.as_os_str() != std::path::Path::new(&original).as_os_str() {
            let dest = hwpx.to_string_lossy().into_owned();
            if let Ok(Outcome::Exported { open_safe: true, .. }) =
                apply_intent(&mut s, Intent::Export { path: dest.clone() })
            {
                converted_path = json!(dest);
            }
        }
    }

    Ok(json!({
        "pages": pages(&mut s),
        "editable": editable,
        "format": format,
        "convertedPath": converted_path,
    }))
}

#[tauri::command]
fn render_page(page: u32, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    match apply_intent(&mut s, Intent::Render { page })? {
        Outcome::Rendered(svg) => Ok(svg),
        _ => Err("unexpected outcome".into()),
    }
}

/// Current page count of the live document (used by the frontend to re-render after edits).
#[tauri::command]
fn doc_page_count(sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    Ok(pages(&mut s))
}

/// Apply AI content; returns the new page count so the frontend re-renders.
#[tauri::command]
fn apply_content(content: String, sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    apply_intent(&mut s, Intent::ApplyContent { json: content })?;
    Ok(pages(&mut s))
}

#[tauri::command]
fn export_hwpx(path: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    match apply_intent(&mut s, Intent::Export { path })? {
        Outcome::Exported { bytes, open_safe } => {
            Ok(format!("{bytes} bytes · editor-open-safety {}", if open_safe { "OK" } else { "FAIL" }))
        }
        _ => Err("unexpected outcome".into()),
    }
}

/// Dry-run AI content into a preview (rationale + per-op diff) WITHOUT mutating the document.
#[tauri::command]
fn propose(content: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    match apply_intent(&mut s, Intent::Propose { json: content })? {
        Outcome::Proposed { rationale, preview } => Ok(format!("{rationale}\n\n{preview}")),
        _ => Err("unexpected outcome".into()),
    }
}

/// Commit the pending proposal (one undo unit); returns the new page count.
#[tauri::command]
fn commit_proposal(sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    apply_intent(&mut s, Intent::Commit)?;
    Ok(pages(&mut s))
}

/// Drop the pending proposal without applying it.
#[tauri::command]
fn discard_proposal(sess: tauri::State<'_, SharedSession>) -> Result<(), String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    apply_intent(&mut s, Intent::DiscardProposal)?;
    Ok(())
}

/// Natural-language AI authoring: a provider turns the prompt + document context into rich
/// AiContent, dry-run into a pending proposal; returns the rationale + diff preview for review.
/// `commit_proposal` then applies it (one undo unit). Needs `--features ai`.
#[cfg(feature = "ai")]
#[tauri::command]
fn ai_generate(prompt: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    let provider = pick_provider();
    let doc = s.doc.as_ref().ok_or("no document open")?.doc();
    let proposal = hwp_ai::propose(doc, &*provider, &prompt).map_err(|e| e.to_string())?;
    let preview = format!("{}\n\n{}", proposal.rationale, proposal.preview());
    s.pending = Some(proposal);
    Ok(format!("[{}]\n{preview}", provider.name()))
}

#[cfg(not(feature = "ai"))]
#[tauri::command]
fn ai_generate(_prompt: String, _sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    Err("AI 생성은 `--features ai` 빌드가 필요합니다 (cargo tauri dev -f rhwp ai)".into())
}

/// Pick an AI provider: a local model (Ollama) we control if reachable, else cloud BYOK
/// (Anthropic key from env/keychain), else the deterministic Mock — so it never hard-fails.
#[cfg(feature = "ai")]
fn pick_provider() -> Box<dyn hwp_ai::LlmProvider> {
    // OpenRouter (BYOK) first when its key is set, then a local Ollama, then Anthropic, then Mock.
    if hwp_ai::secret::has_openrouter_key() {
        if let Ok(p) = hwp_ai::openrouter::OpenRouterProvider::from_env() {
            return Box::new(p);
        }
    }
    if hwp_ai::ollama::OllamaProvider::available() {
        return Box::new(hwp_ai::ollama::OllamaProvider::from_env());
    }
    if hwp_ai::secret::has_anthropic_key() {
        if let Ok(p) = hwp_ai::anthropic::AnthropicProvider::from_env() {
            return Box::new(p);
        }
    }
    Box::new(hwp_ai::MockProvider)
}

/// Undo / redo the last edit; returns the new page count so the frontend re-renders.
#[tauri::command]
fn undo(sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    apply_intent(&mut s, Intent::Undo)?;
    Ok(pages(&mut s))
}

#[tauri::command]
fn redo(sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    apply_intent(&mut s, Intent::Redo)?;
    Ok(pages(&mut s))
}

/// Build + run the viewer window. Manages the shared session + cached bytes, registers commands,
/// and (in `setup`) spawns the A3 loopback control server so an external agent can drive this
/// running instance.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SharedSession::default())
        .setup(|app| {
            server::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_doc,
            render_page,
            doc_page_count,
            apply_content,
            export_hwpx,
            propose,
            commit_proposal,
            discard_proposal,
            ai_generate,
            undo,
            redo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tf-hwp viewer");
}

/// Lock in the invariant the A3 server relies on: the session is shared across threads ONLY behind
/// `SharedSession` (a `Mutex`), so that is the type that must be `Send + Sync`. The inner `Session`
/// need only be `Send` — its render cache (engine seam 1) holds a non-`Sync` parsed document, which
/// is safe behind the `Mutex`.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync + 'static>() {}
    assert_send_sync::<SharedSession>();
};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "rhwp")]
    #[test]
    fn opens_and_renders_hwp5_benchmark() {
        // The core goal: open an uploaded .hwp (HW5) and render it faithfully (view-only).
        let mut sess = hwp_mcp::Session::default();
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
        let msg = mcp_call(&mut sess, "open_document", json!({ "path": bench })).unwrap();
        assert!(msg.contains("HWP5"), "opened as HW5 view: {msg}");
        let count: u32 = mcp_call(&mut sess, "page_count", json!({})).unwrap().trim().parse().unwrap();
        assert!(count >= 8, "benchmark has 8 pages, got {count}");
        let svg = mcp_call(&mut sess, "render_page", json!({ "page": 0 })).unwrap();
        assert!(svg.contains("<svg"), "HW5 page renders to SVG");
    }

    /// Track A: opening a .hwp can now export an open-safe HWPX — the substance behind open_doc's
    /// auto-save of a `.hwpx` beside the original. (open_doc itself needs a Tauri State; this drives
    /// the same Open→Export path through the session.)
    #[cfg(feature = "rhwp")]
    #[test]
    fn hwp5_open_exports_open_safe_hwpx_beside() {
        let mut sess = hwp_mcp::Session::default();
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
        let msg = mcp_call(&mut sess, "open_document", json!({ "path": bench })).unwrap();
        assert!(msg.contains("HWP5"), "{msg}");
        let dest = std::env::temp_dir().join("viewer-autoconvert.hwpx");
        let out = mcp_call(&mut sess, "export_hwpx", json!({ "path": dest.to_str().unwrap() })).unwrap();
        assert!(out.contains("OK"), "auto-converted .hwpx must be open-safe: {out}");
        let reopened = hwp_core::Engine::open(&std::fs::read(&dest).unwrap()).unwrap();
        assert!(!reopened.plain_text().trim().is_empty(), "converted .hwpx reopens with text");
    }

    #[test]
    fn apply_and_export_via_op_bus() {
        // The command logic path: open → apply → export, all through hwp_mcp::handle.
        let mut sess = hwp_mcp::Session::default();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
        mcp_call(&mut sess, "open_document", json!({ "path": path })).unwrap();
        let content = r#"{"blocks":[{"type":"heading","text":"뷰어에서 추가","style":"개요 1"}]}"#;
        mcp_call(&mut sess, "apply_content", json!({ "content": content })).unwrap();
        let out = std::env::temp_dir().join("hwp_viewer_test.hwpx");
        let msg = mcp_call(&mut sess, "export_hwpx", json!({ "path": out.to_str().unwrap() })).unwrap();
        assert!(msg.contains("OK"), "editor-open-safety OK: {msg}");
        let doc = hwp_core::Engine::open(&std::fs::read(&out).unwrap()).unwrap();
        assert!(doc.plain_text().contains("뷰어에서 추가"));
    }
}
