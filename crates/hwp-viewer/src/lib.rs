//! tf-hwp Tauri 2 viewer shell (milestone A2).
//!
//! Opens an HWPX, renders pages faithfully (rhwp → SVG, behind `--features rhwp`), and runs
//! AI content through the **same op-bus** the CLI/MCP use — by reusing [`hwp_mcp::handle`] so
//! there is one mutation surface. The GUI window is launched by the user (`cargo run -p
//! hwp-viewer --features rhwp`, or `cargo tauri dev`); the command *logic* is factored into pure
//! functions so it is unit-testable headless. The A3 embedded control server lives in [`server`].

pub mod server;

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Shared op-bus session (the open document), mutated by `apply_content`/`export_hwpx` and by the
/// embedded A3 control server — so the window renders the LIVE edited document, not a stale copy.
/// `Arc` so the heavy commands can clone a handle out of `State` and move it into a
/// `spawn_blocking` worker, keeping the parse/serialize/render off the async/IPC thread.
pub type SharedSession = Arc<Mutex<hwp_mcp::Session>>;

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

// The heavy commands (parse/serialize/render) run on a `spawn_blocking` worker so the webview/event
// loop stays responsive on tens-of-MB files; the `Mutex` lock is taken INSIDE the worker (cloning the
// `Arc` out of `State` first), never on the async runtime thread.
#[tauri::command]
async fn open_doc(path: String, sess: tauri::State<'_, SharedSession>) -> Result<Value, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn render_page(page: u32, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::Render { page })? {
            Outcome::Rendered(svg) => Ok(svg),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Render the LIVE document through the JSX(content)/CSS(design) → HTML path (the pivot's render):
/// `hwp_jsx::emit` projects the SemanticDoc to a JsxCssProject, `hwp_export::emit_html` combines the
/// two into one self-contained HTML document. This is the SAME output as `export-html`, so the in-app
/// preview matches the export byte-for-byte. Edits repaint via the existing `doc-changed` event.
#[tauri::command]
async fn render_doc_html(sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::emit_html(doc, None))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Render ONE page of the LIVE document through OUR OWN engine (the self-owned faithful render):
/// `hwp_typeset::place_doc` paginates+places the SemanticDoc, `hwp_render` lowers each page to our
/// paint IR, and `SvgSink` emits standalone SVG. This is the SAME path as the CLI `own-render`
/// subcommand (`render_doc_svg`), so the in-app "자체 렌더" view matches `tf-hwp own-render`. Unlike
/// the rhwp "원본 보기" this regenerates from the live IR, so an EDITED doc renders faithfully too.
/// Under `--features shaper` the glyph x-positions are real (rustybuzz advances).
#[tauri::command]
async fn render_own_page(page: u32, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        let svgs = hwp_session::render_svg(doc);
        svgs.get(page as usize)
            .cloned()
            .ok_or_else(|| format!("page {page} out of range (0..{})", svgs.len()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Page count of the LIVE document as paginated by OUR OWN engine (may differ from `doc_page_count`,
/// which uses the rhwp paginator) — drives the "자체 렌더" virtualized page list. 0 if no document.
#[tauri::command]
async fn own_page_count(sess: tauri::State<'_, SharedSession>) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = match s.doc.as_ref() {
            Some(d) => d.doc(),
            None => return Ok(0),
        };
        Ok(hwp_session::render_svg(doc).len() as u32)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Document outline for the left nav panel: the gov-doc's top-level headings — □-prefixed section
/// labels and numbered section bands ("1. 문제 인식 …") — each with the 0-based page it starts on.
/// Delegates to [`hwp_session::outline`]; empty when no doc is open.
#[tauri::command]
async fn doc_outline(sess: tauri::State<'_, SharedSession>) -> Result<Vec<hwp_session::OutlineItem>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = match s.doc.as_ref() {
            Some(d) => d.doc(),
            None => return Ok(Vec::new()),
        };
        Ok(hwp_session::outline(doc))
    })
    .await
    .map_err(|e| e.to_string())?
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
async fn export_hwpx(path: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::Export { path })? {
            Outcome::Exported { bytes, open_safe } => {
                Ok(format!("{bytes} bytes · editor-open-safety {}", if open_safe { "OK" } else { "FAIL" }))
            }
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Export the LIVE document to a self-contained HTML file at `path` (the pivot's web render): the
/// SAME `hwp_jsx::emit` → `hwp_export::emit_html` path as the in-app HTML preview (`render_doc_html`)
/// and the CLI `export-html`, so the written file matches what the viewer shows byte-for-byte.
/// Edits are reflected because we project the live SemanticDoc, not a stale copy.
#[tauri::command]
async fn export_doc_html(path: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        let title = std::path::Path::new(&path)
            .file_stem()
            .map(|t| t.to_string_lossy().into_owned());
        let html = hwp_session::emit_html(doc, title);
        std::fs::write(&path, html.as_bytes()).map_err(|e| format!("write {path}: {e}"))?;
        Ok(format!("{} bytes · HTML 저장됨", html.len()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Export the LIVE document to a PDF file at `path` through OUR OWN engine (NOT a browser print):
/// the SAME path as the CLI `export-pdf` — `hwp_export::pdf::export_pdf` paginates+places the live
/// SemanticDoc (`place_doc` → PageLayerTree → krilla), embedding a subset of the discovered Korean
/// face. Under `--features shaper` the real rustybuzz advances drive placement, so the PDF matches
/// the in-app "자체 렌더" view. Needs `--features pdf`; without it returns a clear, actionable error.
#[cfg(feature = "pdf")]
#[tauri::command]
async fn export_doc_pdf(path: String, sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        let title = std::path::Path::new(&path)
            .file_stem()
            .map(|t| t.to_string_lossy().into_owned());
        let result = hwp_session::emit_pdf(doc, title)?;
        std::fs::write(&path, &result.bytes).map_err(|e| format!("write {path}: {e}"))?;
        let font = match &result.font_path {
            Some(_) => "한글 글꼴 임베드됨",
            None => "한글 글꼴 없음 — 글자는 빈 박스 (기하만)",
        };
        Ok(format!(
            "{} pages · {} KB · {font}",
            result.pages,
            result.bytes.len() / 1024
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Without `--features pdf` the krilla backend isn't compiled in — return an actionable error rather
/// than silently writing a wrong/empty file (mirrors the CLI `export-pdf` interim message).
#[cfg(not(feature = "pdf"))]
#[tauri::command]
async fn export_doc_pdf(_path: String, _sess: tauri::State<'_, SharedSession>) -> Result<String, String> {
    Err("PDF 내보내기는 `--features pdf` 빌드가 필요합니다 (cargo tauri dev -f \"rhwp ai pdf\"). \
         대안: HTML로 내보낸 뒤 브라우저에서 인쇄 ▸ PDF로 저장."
        .into())
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

/// Vibe-docs chat-edit: the provider sees the LIVE document as an anchored `[s/b]` outline and
/// proposes TARGETED edits (insert table/image near an anchor, shade a column, delete a block),
/// dry-run into a pending proposal; returns the rationale + per-op diff for review. `commit_proposal`
/// then applies it (one undo unit). Needs `--features ai`.
///
/// `scopeSection`/`scopeBlock` = an optional click-resolved target the user pointed at in the viewer;
/// when present we prepend a directive so the model anchors its edits there ("이거 바꿔줘" → that block).
/// `anchors` = the marked anchor chips' JSON (issue #009); when non-empty they take priority and scope
/// the edit to exactly those spots (their structure coords), else we fall back to the click-scope.
/// `guardTableHeader` (issue #011 "표 채우기" preset) = when true, strip any fill op that would overwrite
/// a protected header/음영 row of a marked table — a STRUCTURAL backstop behind the prompt instruction.
#[cfg(feature = "ai")]
#[allow(non_snake_case)]
#[tauri::command]
fn ai_edit_propose(
    instruction: String,
    scopeSection: Option<usize>,
    scopeBlock: Option<usize>,
    anchors: Option<String>,
    guardTableHeader: Option<bool>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Value, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    let provider = pick_provider();
    let doc = s.doc.as_ref().ok_or("no document open")?.doc();
    // Marked anchors (issue #009) take priority over the single click-scope: they carry exact structure
    // coords (row/col, first_row-corrected) and scope the edit to just those spots. Fall back to the
    // legacy click-scope directive when no anchors ride along (keeps the no-chip flow byte-identical).
    let scoped = match hwp_session::anchor_directive(anchors.as_deref(), &instruction) {
        Some(d) => d,
        None => match (scopeSection, scopeBlock) {
            (Some(sec), Some(blk)) => format!(
                "[편집 대상 위치: 섹션 {sec}, 블록 {blk} — 앵커 [s{sec}/b{blk}]. 사용자가 이 위치를 가리켰으니, \
                 다른 단서가 없으면 이 블록(또는 바로 그 아래)을 기준으로 편집하세요.]\n사용자 요청: {instruction}"
            ),
            (Some(sec), None) => format!(
                "[편집 대상 위치: 섹션 {sec} 근처를 사용자가 가리켰습니다. 이 섹션을 기준으로 편집하세요.]\n\
                 사용자 요청: {instruction}"
            ),
            _ => instruction.clone(),
        },
    };
    let mut proposal = hwp_ai::propose_edits(doc, &*provider, &scoped).map_err(|e| e.to_string())?;
    // Preset "표 채우기" (issue #011): the prompt already tells the model to preserve the header/음영
    // rows, but this makes it structural — drop any text-fill op that targets a protected row so a model
    // that ignores the prompt can never clobber them. All `doc` reads finish here (before s.pending).
    if guardTableHeader == Some(true) {
        let blocked = hwp_session::protect_table_header_rows(doc, &mut proposal.ops, anchors.as_deref());
        if blocked > 0 {
            proposal.rationale.push_str(&format!(
                "\n※ 헤더/음영 행 보존: 보호된 행을 덮어쓰려는 편집 {blocked}건을 제외했습니다."
            ));
        }
    }
    let out = hwp_session::proposal_json(provider.name(), &proposal);
    s.pending = Some(proposal);
    Ok(out)
}

#[cfg(not(feature = "ai"))]
#[allow(non_snake_case)]
#[tauri::command]
fn ai_edit_propose(
    _instruction: String,
    _scopeSection: Option<usize>,
    _scopeBlock: Option<usize>,
    _anchors: Option<String>,
    _guardTableHeader: Option<bool>,
    _sess: tauri::State<'_, SharedSession>,
) -> Result<Value, String> {
    Err("AI 편집은 `--features ai` 빌드가 필요합니다 (cargo tauri dev -f rhwp ai)".into())
}

/// The active AI provider's name ("anthropic" / "ollama" / "openrouter" / "mock"), so the chat can
/// show an honest badge — mock is a deterministic DEMO that ignores the request (no real edits).
#[cfg(feature = "ai")]
#[tauri::command]
fn ai_provider_name() -> String {
    pick_provider().name().to_string()
}

#[cfg(not(feature = "ai"))]
#[tauri::command]
fn ai_provider_name() -> String {
    "none".into()
}

/// Insert a CHAT-ATTACHED image deterministically (no provider needed) at the user's pointed target:
/// decode the base64 bytes to a temp file, then route ONE `InsertImage` edit through the SAME
/// validated op-bus path the AI uses (`propose_from_edit_script`), leaving it pending for review.
/// `scopeSection`/`scopeBlock` = the click-resolved target (insert AFTER that block, else section end).
/// `widthMm`/`heightMm` come from the image's natural aspect (computed in the webview).
#[allow(non_snake_case)]
#[tauri::command]
fn propose_insert_image(
    name: String,
    dataB64: String,
    scopeSection: Option<usize>,
    scopeBlock: Option<usize>,
    widthMm: Option<f32>,
    heightMm: Option<f32>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Value, String> {
    let (path, safe) = hwp_session::stash_image(&name, Some(&dataB64), None)?;
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    let doc = s.doc.as_ref().ok_or("no document open")?.doc();
    let proposal =
        hwp_session::build_insert_image_proposal(doc, &path, scopeSection, scopeBlock, widthMm, heightMm)?;
    // No provider on the deterministic image path — label the rationale with the filename so the
    // card reads "📎 <name>"; the structured op carries the anchored target like any other.
    let mut out = hwp_session::proposal_json("deterministic", &proposal);
    out["rationale"] = json!(format!("📎 {safe}"));
    s.pending = Some(proposal);
    Ok(out)
}

/// DIRECT-MANIPULATION image insert (a native OS file drop onto a page): read the source file's
/// bytes in Rust (a drop gives a PATH, not bytes), compile ONE `InsertImage` edit through the same
/// validated op-bus path, and COMMIT it IMMEDIATELY as one undoable op via `do_ops` — mirroring how
/// the caret edits apply (no propose→review). Returns the new page count so the UI re-renders.
/// `srcPath` is the dropped file; `dataB64` is an alternate in-memory payload (tests / non-native
/// drops). `scopeSection`/`scopeBlock` = the hit-tested target (insert AFTER that block, else end).
#[allow(non_snake_case)]
#[tauri::command]
async fn apply_insert_image(
    name: String,
    srcPath: Option<String>,
    dataB64: Option<String>,
    scopeSection: Option<usize>,
    scopeBlock: Option<usize>,
    widthMm: Option<f32>,
    heightMm: Option<f32>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let (path, _safe) = hwp_session::stash_image(&name, dataB64.as_deref(), srcPath.as_deref())?;
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        let proposal =
            hwp_session::build_insert_image_proposal(doc, &path, scopeSection, scopeBlock, widthMm, heightMm)?;
        let edit = s.doc.as_mut().ok_or("no document open")?;
        edit.do_ops(&proposal.ops).map_err(|e| e.to_string())?; // ONE undo unit
        Ok::<u32, String>(pages(&mut s))
    })
    .await
    .map_err(|e| e.to_string())?
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

// ---- FIND / REPLACE (typed Intent lane; same op-bus core as the MCP `find_text`/`replace_text`) ----

/// One search hit crossing the Tauri boundary (mirror of `hwp_mcp::FindMatch`). `node`/`start`/`len`
/// are CHAR (Unicode-scalar) coordinates over the paragraph's concatenated run text.
#[derive(serde::Serialize)]
struct FindMatchDto {
    node: u64,
    start: usize,
    len: usize,
    section: usize,
    block: usize,
}

/// Result of a replace: occurrences replaced + the live page count (so the frontend re-renders).
#[derive(serde::Serialize)]
struct ReplaceResult {
    replaced: usize,
    pages: u32,
}

/// Find occurrences of `query` in the open document's editable simple paragraphs (read-only; sync —
/// find is cheap and does not serialize). Returns the matches for UI navigation/highlight.
// camelCase params match the JS keys api.ts passes (Tauri binds by exact name).
#[allow(non_snake_case)]
#[tauri::command]
fn find_text(
    query: String,
    caseSensitive: bool,
    wholeWord: bool,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Vec<FindMatchDto>, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    match apply_intent(
        &mut s,
        Intent::Find { query, case_sensitive: caseSensitive, whole_word: wholeWord },
    )? {
        Outcome::Found { matches } => Ok(matches
            .into_iter()
            .map(|m| FindMatchDto { node: m.node, start: m.start, len: m.len, section: m.section, block: m.block })
            .collect()),
        _ => Err("unexpected outcome".into()),
    }
}

/// Replace `query` → `replacement` as ONE undo unit (replace-all when `all`, else the first match).
/// Returns the count replaced + the new page count.
#[allow(non_snake_case)]
#[tauri::command]
fn replace_text(
    query: String,
    replacement: String,
    caseSensitive: bool,
    wholeWord: bool,
    all: bool,
    sess: tauri::State<'_, SharedSession>,
) -> Result<ReplaceResult, String> {
    let mut s = sess.lock().map_err(|_| "session poisoned")?;
    match apply_intent(
        &mut s,
        Intent::Replace {
            query,
            replacement,
            case_sensitive: caseSensitive,
            whole_word: wholeWord,
            all,
        },
    )? {
        Outcome::Replaced { replaced, pages } => Ok(ReplaceResult { replaced, pages }),
        _ => Err("unexpected outcome".into()),
    }
}

// ---- WYSIWYG caret: engine half (typed Intent lane; same op-bus/render cache as render_page) ----
//
// These are the COMMANDS the future interactive caret UI will call; the interactive half (caret
// rendering, selection drag, Korean IME composition) is out of scope here. Both run on a
// `spawn_blocking` worker (they parse/walk the layer tree) and reuse the session render cache, so
// the geometry matches the SVG the view shows.

/// The editable model target a click resolved to. `node`/`block` are null for a table-cell run or a
/// doc without NodeIds (an unedited binary .hwp) — geometry is available, the editable target is not.
/// `offset` is the caret position in PARAGRAPH chars (Unicode scalars).
#[allow(non_snake_case)]
#[derive(serde::Serialize)]
struct HitDto {
    node: Option<u64>,
    block: Option<usize>,
    offset: usize,
    section: usize,
    paraOrd: usize,
    inCell: bool,
    paraLen: usize,
}

/// A caret rectangle in page (unscaled) coordinates. Scale by the SVG zoom factor on the frontend.
#[derive(serde::Serialize)]
struct CaretDto {
    x: f64,
    top: f64,
    height: f64,
}

/// Map a page-space click `(x, y)` to an editable model target (or `null` for a click off any text).
#[tauri::command]
async fn hit_test(
    page: u32,
    x: f64,
    y: f64,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<HitDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::HitTest { page, x, y })? {
            Outcome::Hit(hit) => Ok(hit.map(|h| HitDto {
                node: h.node,
                block: h.block,
                offset: h.offset,
                section: h.section,
                paraOrd: h.para_ord,
                inCell: h.in_cell,
                paraLen: h.para_len,
            })),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Map an editable model target (NodeId + paragraph char offset) to a page-space caret rectangle on
/// `page` (or `null` if that paragraph doesn't render on the queried page).
#[tauri::command]
async fn caret_rect(
    page: u32,
    node: u64,
    offset: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<CaretDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::CaretRect { page, node, offset })? {
            Outcome::Caret(c) => Ok(c.map(|r| CaretDto { x: r.x, top: r.top, height: r.height })),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Own-engine geometry (overlays + point-to-block): the px↔HWPUNIT conversion + DTO assembly all
// ---- live in `hwp_session` now (the ONLY place the ~75× unit boundary is crossed). These commands
// ---- just hand the live `&SemanticDoc` to the matching `hwp_session` query and forward its DTO. ----

// ---- Image move/resize overlay: bbox query (hwp_session geometry) + commit ops (op-bus lane) ----

/// Locate the placed box of the image anchored at `(section, block)` on `page` (own-render px).
/// Delegates to [`hwp_session::image_bbox`]; `null` if that image isn't on the page.
#[tauri::command]
async fn image_bbox(
    page: u32,
    section: usize,
    block: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::ImageBoxDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::image_bbox(doc, page, section, block))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Click-to-select: the topmost image whose placed box contains page-space `(x, y)` on `page`.
/// Delegates to [`hwp_session::image_at`]; `null` if the click misses every image.
#[tauri::command]
async fn image_at(
    page: u32,
    x: f64,
    y: f64,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::ImageBoxDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::image_at(doc, page, x, y))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resize the image anchored at `(section, block)` to `width`×`height` HWPUNIT as ONE undo unit
/// (`SetImageSize` via the op-bus). The resize handle's pointerup commit; returns the new page count
/// so the frontend repaints, mirroring `insert_text`/`replace_text`.
#[allow(non_snake_case)]
#[tauri::command]
async fn set_image_size(
    section: usize,
    block: usize,
    width: i32,
    height: i32,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetImageSize { section, index: block, width, height })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move the image anchored at block `from` to block `to` in `section` as ONE undo unit (`DeleteBlock`
/// + `InsertImageAt` batched; size preserved). Returns the new page count so the frontend repaints.
#[allow(non_snake_case)]
#[tauri::command]
async fn move_image(
    section: usize,
    from: usize,
    to: usize,
    width: i32,
    height: i32,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::MoveImage { section, from, to, width, height })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Table drag-to-move overlay: bbox/hit-test queries (own-engine geometry) + MoveBlock commit +
// ---- table quick-edits (add row / delete / edit cell). Mirrors the image overlay lane exactly. ----

/// Locate the placed outer box of the table anchored at `(section, block)` on `page` (own-render px).
/// Delegates to [`hwp_session::table_bbox`]; `null` if that table isn't on the page.
#[tauri::command]
async fn table_bbox(
    page: u32,
    section: usize,
    block: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::TableBoxDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_bbox(doc, page, section, block))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Click-to-select: the topmost table whose placed outer box contains page-space `(x, y)` on `page`.
/// Delegates to [`hwp_session::table_at`]; `null` if the click misses every table.
#[tauri::command]
async fn table_at(
    page: u32,
    x: f64,
    y: f64,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::TableBoxDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_at(doc, page, x, y))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move the block (table or paragraph) at `(section, from)` to block index `to` as ONE undo unit
/// (`MoveBlock`). The drag-to-move drop commit; returns the new page count so the frontend repaints.
#[tauri::command]
async fn move_table(
    section: usize,
    from: usize,
    to: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::MoveBlock { section, from, to })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append `count` empty body rows to the `index`-th table at logical row `at` as ONE undo unit
/// (`TableInsertRows`). The hover toolbar's 행 추가 verb. Returns the new page count.
#[tauri::command]
async fn table_add_rows(
    section: usize,
    index: usize,
    at: usize,
    count: usize,
    cols: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::TableInsertRows { section, index, at, count, cols })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append ONE empty body row to the `index`-th table, REPLICATING the last row's column layout (so a
/// merged-column table stays aligned) as ONE undo unit (`TableAppendEmptyRow`). The "+행" verb.
#[tauri::command]
async fn table_append_row(
    section: usize,
    index: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::TableAppendRow { section, index })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace a SIMPLE paragraph's text (the `block`-th block of `section`), preserving its char/para
/// shape, as ONE undo unit (`SetParagraphText`). Inline paragraph editing / "무에서 텍스트 추가". The
/// op refuses a structural paragraph (image/field) and that message is surfaced for the UI to toast.
#[tauri::command]
async fn set_paragraph_text(
    section: usize,
    block: usize,
    text: String,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetParagraphText { section, block, text })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the text of the cell at `(row, col)` of the `index`-th table as ONE undo unit
/// (`SetTableCell`). The hover toolbar / popover's 칸 편집 verb. Returns the new page count.
#[tauri::command]
async fn set_table_cell(
    section: usize,
    index: usize,
    row: usize,
    col: usize,
    text: String,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetTableCell { section, index, row, col, text })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the `index`-th table's column-width proportions as ONE undo unit (`SetTableColWidths`). The
/// column-resize drag commit. `widths.len()` must equal the table's column count.
#[tauri::command]
async fn set_table_col_widths(
    section: usize,
    index: usize,
    widths: Vec<i32>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetTableColWidths { section, index, widths })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the `index`-th table's per-row minimum-height OVERRIDE as ONE undo unit (`SetTableRowHeights`).
/// The row-resize drag commit. `heights.len()` must equal the table's row count; a `0` entry leaves
/// that row content-sized, a `> 0` entry is a floor (HWPUNIT) honored as `max(content, override)`.
#[tauri::command]
async fn set_table_row_heights(
    section: usize,
    index: usize,
    heights: Vec<i32>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetTableRowHeights { section, index, heights })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set `section`'s page margins (mm) as ONE undo unit (`SetPageLayout`, margins only) — the 한컴식
/// ruler's draggable margin markers. The UI passes all four (undragged edges keep their current value);
/// the whole document re-flows to the new printable width. Returns the new page count.
#[tauri::command]
async fn set_page_margins(
    section: usize,
    left_mm: f32,
    right_mm: f32,
    top_mm: f32,
    bottom_mm: f32,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetPageMargins { section, left_mm, right_mm, top_mm, bottom_mm })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shade (background-color) cells of the `index`-th table as ONE undo unit (`SetTableCellShade`).
/// `sel` picks the target — "row"/"col"/"cell"/"all" using `(row, col)`; `shade` is "#RRGGBB" or null
/// to clear. The 배경색 verb (header-row / column tinting).
#[allow(non_snake_case)]
#[tauri::command]
async fn set_table_cell_shade(
    section: usize,
    index: usize,
    sel: String,
    row: usize,
    col: usize,
    shade: Option<String>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetTableCellShade { section, index, sel, row, col, shade })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Multi-cell batch BACKGROUND — set/clear the shade of every cell overlapping the rectangle
/// `[r0..=r1] × [c0..=c1]` of the `index`-th table as ONE undo unit. Returns the new page count.
#[tauri::command]
async fn set_cell_range_shade(
    section: usize,
    index: usize,
    r0: usize,
    c0: usize,
    r1: usize,
    c1: usize,
    shade: Option<String>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetCellRangeShade { section, index, r0, c0, r1, c1, shade })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Multi-cell batch CHARACTER/ALIGNMENT format over the rectangle `[r0..=r1] × [c0..=c1]` of the
/// `index`-th table as ONE undo unit (볼드/이태릭/크기/글꼴/글자색/정렬). Each `Some` field applies.
/// Returns the new page count.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn set_cell_range_fmt(
    section: usize,
    index: usize,
    r0: usize,
    c0: usize,
    r1: usize,
    c1: usize,
    bold: Option<bool>,
    italic: Option<bool>,
    size_pt: Option<f32>,
    font: Option<String>,
    color: Option<String>,
    align: Option<String>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::SetCellRangeFmt { section, index, r0, c0, r1, c1, bold, italic, size_pt, font, color, align })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read the OS clipboard as text (own-mode ⌘V). Empty string when the clipboard holds no text.
#[tauri::command]
fn clipboard_read() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .or_else(|_| Ok::<String, arboard::Error>(String::new()))
        .map_err(|e| e.to_string())
}

/// Write text to the OS clipboard (own-mode ⌘C).
#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

/// Delete the block at `(section, index)` (e.g. 표 삭제) as ONE undo unit (`DeleteBlock`). Returns
/// the new page count so the frontend repaints.
#[tauri::command]
async fn delete_block(
    section: usize,
    index: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::DeleteBlock { section, index })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Own-render point-to-block: the general counterpart to image_at/table_at. ----

/// Click-to-point (own-render only): resolve a page-space click to the top-level block under it.
/// Unlike [`image_at`]/[`table_at`] this resolves PARAGRAPHS too. Delegates to
/// [`hwp_session::own_hit_test`]; `null` only when the page has no placed blocks.
#[tauri::command]
async fn own_hit_test(
    page: u32,
    x: f64,
    y: f64,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::BlockHitDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::own_hit_test(doc, page, x, y))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Click-to-edit (own-render only): the table cell under a page-space double-click. Delegates to
/// [`hwp_session::table_cell_at`]; `null` when the point isn't over any table cell.
#[tauri::command]
async fn table_cell_at(
    page: u32,
    x: f64,
    y: f64,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::CellHitDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_cell_at(doc, page, x, y))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The PX box + page of the cell at `(section, block, row, col)`, looked up BY ADDRESS across all
/// pages. Delegates to [`hwp_session::table_cell_box`]; `None` if the cell isn't placed.
#[tauri::command]
async fn table_cell_box(
    section: usize,
    block: usize,
    row: usize,
    col: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::CellBox>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_cell_box(doc, section, block, row, col))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Column-boundary x-positions (PX, own SVG space) of the table at `(section, block)` on `page`.
/// Delegates to [`hwp_session::table_col_boundaries`]; `null` if the table isn't on the page.
#[tauri::command]
async fn table_col_boundaries(
    page: u32,
    section: usize,
    block: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<Vec<f64>>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_col_boundaries(doc, page, section, block))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Row-resize geometry (own-render only) — `rows + 1` absolute px y-boundaries of the `block`-th table
/// on `page`. Delegates to [`hwp_session::table_row_boundaries`]; `None` when the table isn't on the page.
#[tauri::command]
async fn table_row_boundaries(
    page: u32,
    section: usize,
    block: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<Vec<f64>>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::table_row_boundaries(doc, page, section, block))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Page geometry in CSS px (own-render only): the page box + the printable-area margins of `page`, for
/// the editor chrome (한글식 모서리 영역 표시 + 줄자). Delegates to [`hwp_session::page_geometry`];
/// `None` when the page is out of range. NOT baked into the SVG, so the guides/ruler never leak into export.
#[tauri::command]
async fn page_geometry(page: u32, sess: tauri::State<'_, SharedSession>) -> Result<Option<hwp_session::PageGeom>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::page_geometry(doc, page))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Patch the character format (볼드/이태릭/크기/글꼴) of a target's runs as ONE undo unit (`SetCharFmt`),
/// preserving every other attribute. Target = the `block`-th paragraph (row/col both `None`), or the
/// `(row, col)` cell of that table. Each `Some` field applies; `size_pt` in points; `font` sets the
/// family ("" clears it). Returns the new page count. Surfaces the op-bus error string as `Err`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn set_char_fmt(
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
    bold: Option<bool>,
    italic: Option<bool>,
    size_pt: Option<f32>,
    font: Option<String>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        let cell = row.zip(col);
        match apply_intent(&mut s, Intent::SetCharFmt { section, block, cell, bold, italic, size_pt, font })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Patch 볼드/이태릭 on the char RANGE `[start, end)` of a target paragraph/cell as ONE undo unit
/// (`SetRunCharFmt`) — the dragged-selection (⌘B/⌘I) twin of `set_char_fmt`. `start`/`end` are CHAR
/// offsets into the target's text. Returns the new page count.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn set_run_char_fmt(
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
    start: usize,
    end: usize,
    bold: Option<bool>,
    italic: Option<bool>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        let cell = row.zip(col);
        match apply_intent(&mut s, Intent::SetRunCharFmt { section, block, cell, start, end, bold, italic })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The CURRENT character format of a target's first run — so the manual format bar can show + toggle
/// the right state. Delegates to [`hwp_session::char_fmt`]; `None` if the target/run can't be resolved.
#[tauri::command]
async fn char_fmt(
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Option<hwp_session::CharFmt>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::char_fmt(doc, section, block, row, col))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read ALL styled runs of a target paragraph/cell (per-run shapes) so the WYSIWYG editor can render
/// them as styled spans. Delegates to [`hwp_session::block_runs`].
#[tauri::command]
async fn get_block_runs(
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<Vec<hwp_session::RunDto>, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::block_runs(doc, section, block, row, col))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The target cell/paragraph's BACKGROUND fill + horizontal alignment + per-paragraph indent — the
/// WYSIWYG inline editor paints itself to MATCH the original. Delegates to [`hwp_session::block_style`].
#[tauri::command]
async fn block_style(
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<hwp_session::BlockStyleDto, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = sess.lock().map_err(|_| "session poisoned")?;
        let doc = s.doc.as_ref().ok_or("no document open")?.doc();
        Ok(hwp_session::block_style(doc, section, block, row, col))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The WYSIWYG commit for a CELL — replace it with STYLED runs (preserves per-run formatting; the
/// run-based `SetTableCell`). Returns the new page count.
#[tauri::command]
async fn set_table_cell_runs(
    section: usize,
    index: usize,
    row: usize,
    col: usize,
    runs: Vec<hwp_session::RunDto>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        let rs = hwp_session::run_specs(&runs);
        match apply_intent(&mut s, Intent::SetTableCellRuns { section, index, row, col, runs: rs })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The WYSIWYG commit for a PARAGRAPH — replace it with STYLED runs (`SetParagraphRuns`).
#[tauri::command]
async fn set_paragraph_runs(
    section: usize,
    block: usize,
    runs: Vec<hwp_session::RunDto>,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        let rs = hwp_session::run_specs(&runs);
        match apply_intent(&mut s, Intent::SetParagraphRuns { section, block, runs: rs })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Interactive caret: in-place edit commands (typed Intent lane; same op-bus core as the MCP
// ---- lane). The per-keystroke / IME-commit mutations the caret UI calls. Async/spawn_blocking like
// ---- the other mutating commands; each is ONE undo unit (do_op) and returns the new page count so
// ---- the frontend re-renders (reusing the invalidate() path), mirroring undo/redo/replace_text. ----

/// Insert `text` at a char-offset caret inside one simple paragraph as ONE undo unit. Returns the
/// new page count. On a structural / out-of-range target the op-bus error string is surfaced as an
/// `Err` the UI toasts (no panic) — e.g. "paragraph N has structural content and cannot be edited in
/// place". `node`/`offset`/`text` are already snake-free so Tauri binds them by exact JS key name.
#[tauri::command]
async fn insert_text(
    node: u64,
    offset: usize,
    text: String,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::InsertText { node, offset, text })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete the single char ENDING at `offset` (Backspace) as ONE undo unit; returns the new page
/// count. `offset == 0` is a graceful no-op. Surfaces op-bus errors as an `Err` the UI toasts.
#[tauri::command]
async fn delete_back(
    node: u64,
    offset: usize,
    sess: tauri::State<'_, SharedSession>,
) -> Result<u32, String> {
    let sess = sess.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sess.lock().map_err(|_| "session poisoned")?;
        match apply_intent(&mut s, Intent::DeleteBack { node, offset })? {
            Outcome::Edited { pages } => Ok(pages),
            _ => Err("unexpected outcome".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
            render_doc_html,
            render_own_page,
            own_page_count,
            doc_page_count,
            doc_outline,
            apply_content,
            export_hwpx,
            export_doc_html,
            export_doc_pdf,
            propose,
            commit_proposal,
            discard_proposal,
            ai_generate,
            ai_edit_propose,
            ai_provider_name,
            propose_insert_image,
            apply_insert_image,
            undo,
            redo,
            find_text,
            replace_text,
            hit_test,
            caret_rect,
            insert_text,
            delete_back,
            image_bbox,
            image_at,
            set_image_size,
            move_image,
            table_bbox,
            table_at,
            own_hit_test,
            table_cell_at,
            table_cell_box,
            table_col_boundaries,
            table_row_boundaries,
            page_geometry,
            move_table,
            table_add_rows,
            table_append_row,
            set_paragraph_text,
            set_table_cell,
            set_table_col_widths,
            set_page_margins,
            set_table_row_heights,
            set_char_fmt,
            set_run_char_fmt,
            char_fmt,
            get_block_runs,
            block_style,
            set_table_cell_runs,
            set_paragraph_runs,
            set_table_cell_shade,
            set_cell_range_shade,
            set_cell_range_fmt,
            clipboard_read,
            clipboard_write,
            delete_block
        ])
        .run(tauri::generate_context!())
        .expect("error while running tf-hwp viewer");
}

/// Lock in the invariant the A3 server (and the `spawn_blocking` workers) rely on: the session is
/// shared across threads ONLY behind `SharedSession` (an `Arc<Mutex<_>>`), so that is the type that
/// must be `Send + Sync`. The inner `Session` need only be `Send` — its render cache (engine seam 1)
/// holds a non-`Sync` parsed document, which is safe behind the `Mutex`.
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
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmarks/benchmark.hwp");
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
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmarks/benchmark.hwp");
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

    /// PHASE C: the `export_doc_html` command body — project the LIVE (edited) doc through
    /// `hwp_jsx::emit` → `hwp_export::emit_html` and write it. Drives the same logic the async Tauri
    /// command runs (which needs a `State` we can't build headless), so the written HTML carries the
    /// edit and is a self-contained document. Feature-free (no `pdf`/`rhwp`), like the path it tests.
    #[test]
    fn export_doc_html_writes_live_doc() {
        let mut sess = hwp_mcp::Session::default();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
        mcp_call(&mut sess, "open_document", json!({ "path": path })).unwrap();
        let content = r#"{"blocks":[{"type":"heading","text":"HTML로 내보내기","style":"개요 1"}]}"#;
        mcp_call(&mut sess, "apply_content", json!({ "content": content })).unwrap();

        let doc = sess.doc.as_ref().expect("doc open").doc();
        let proj = hwp_jsx::emit(doc);
        let html = hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title: Some("t".into()) });
        let out = std::env::temp_dir().join("hwp_viewer_export.html");
        std::fs::write(&out, html.as_bytes()).unwrap();

        let written = std::fs::read_to_string(&out).unwrap();
        assert!(written.starts_with("<!doctype html>"), "self-contained HTML document");
        assert!(written.contains("HTML로 내보내기"), "the live edit is in the export");
    }

    /// M1 drag-drop: a native file DROP gives a PATH (not bytes), so the apply path must read the
    /// file in Rust and commit ONE undoable op that embeds those bytes and references them — mirroring
    /// hwp-ops' `insert_image_at_embeds_bindata_and_references_it`. Drives the same pure logic the
    /// `apply_insert_image` command runs (the command itself needs a Tauri `State` we can't build
    /// headless): `stash_image(srcPath)` → `build_insert_image_proposal` → `do_ops` (one undo unit).
    #[test]
    fn apply_insert_image_from_path_embeds_bytes_and_references_it() {
        use hwp_model::prelude::{Block, Inline};
        // A real PNG-signature file on disk is what a native drop hands us (a path, not bytes).
        let png = vec![0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let src = std::env::temp_dir().join("tfhwp_drop_src.png");
        std::fs::write(&src, &png).unwrap();

        let mut sess = hwp_mcp::Session::default();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
        mcp_call(&mut sess, "open_document", json!({ "path": path })).unwrap();

        // Read bytes from the PATH (no base64) exactly as the drop lane does (now in hwp_session).
        let (stashed, safe) =
            hwp_session::stash_image("ignored.png", None, Some(src.to_str().unwrap())).unwrap();
        assert!(safe.ends_with(".png"), "basename comes from the dropped path: {safe}");
        assert_eq!(std::fs::read(&stashed).unwrap(), png, "stash copies the dropped bytes verbatim");

        let before_pages = pages(&mut sess);
        let proposal = {
            let doc = sess.doc.as_ref().unwrap().doc();
            hwp_session::build_insert_image_proposal(doc, &stashed, Some(0), Some(0), Some(40.0), Some(30.0))
                .unwrap()
        };
        // Commit immediately as ONE undo unit (the direct-manipulation contract).
        let edit = sess.doc.as_mut().unwrap();
        edit.do_ops(&proposal.ops).unwrap();

        // The dropped bytes are embedded in bin_data and referenced by an inserted Image inline.
        let doc = sess.doc.as_ref().unwrap().doc();
        let bin = doc.bin_data.iter().find(|b| b.bytes == png).expect("dropped bytes embedded");
        let found = doc.sections[0].blocks.iter().any(|blk| {
            if let Block::Paragraph(p) = blk {
                p.runs.iter().flat_map(|r| &r.content).any(|c| {
                    matches!(c, Inline::Image(img) if img.bin_ref == bin.bin_ref)
                })
            } else {
                false
            }
        });
        assert!(found, "an Image inline references the embedded dropped bytes");

        // One undo reverts the whole drop (single undoable op), and pages recompute.
        let _ = before_pages;
        assert!(sess.doc.as_mut().unwrap().undo(), "the drop is a single undoable op");
        let doc = sess.doc.as_ref().unwrap().doc();
        assert!(!doc.bin_data.iter().any(|b| b.bytes == png), "undo removes the embedded image");
    }

    /// own_hit_test (point-to-block) speaks the own-render SVG's PX space: the clicks `screenToPage`
    /// sends + the boxes the overlays draw are HWPUNIT/HWPUNIT_PER_PX, so the command converts px→HWPUNIT
    /// before resolving and px on the way out. This locks that boundary on the real gov-doc: a PX click
    /// over a block's center must resolve back to that block (a sign/scale slip here = "clicks never
    /// land", the bug behind dead own-mode selection).
    #[cfg(feature = "rhwp")]
    #[test]
    fn own_hit_test_resolves_a_px_click_to_the_pointed_block() {
        let bench = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmarks/benchmark.hwp");
        let doc = hwp_core::Engine::open(&std::fs::read(bench).unwrap()).unwrap();
        let fonts = hwp_session::own_render_fonts();
        let placed = hwp_typeset::place_doc(&doc, fonts.as_ref());
        let k = hwp_session::HWPUNIT_PER_PX;
        // A page with content → take its first band; click its center in PX (what the frontend sends).
        let (pi, b) = placed
            .pages
            .iter()
            .enumerate()
            .find_map(|(i, p)| p.blocks.first().map(|b| (i, b.clone())))
            .expect("a placed block exists");
        let (px, py) = ((b.x + b.w / 2.0) / k, (b.y + b.h / 2.0) / k);
        // Mirror the command body: px click → HWPUNIT → block_at.
        let hit = placed.pages[pi].block_at(px * k, py * k).expect("a px click resolves a block");
        assert_eq!((hit.section, hit.block), (b.section, b.block), "px click resolves to the pointed block");
        // And a click far to the LEFT margin at the same row still snaps to a block (row-based pointing).
        assert!(placed.pages[pi].block_at(1.0 * k, py * k).is_some(), "margin click still snaps to a block");
    }
}
