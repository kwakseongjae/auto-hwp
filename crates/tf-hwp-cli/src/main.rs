//! tf-hwp CLI. Phase-0 runnable surface: `detect`, `info`, `extract-text`, `oracle`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use hwp_model::types::SourceFormat;

#[derive(Parser)]
#[command(name = "tf-hwp", version, about = "HWP/HWPX view·edit·export engine (CLI)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Detect the source format from magic bytes.
    Detect { file: PathBuf },
    /// Show document info (format; for HWPX: mimetype + parts).
    Info { file: PathBuf },
    /// Extract plain text (HWPX `<hp:t>`, one paragraph per line).
    ExtractText { file: PathBuf },
    /// Render a reference PDF via the LibreOffice + H2Orestart oracle.
    Oracle {
        file: PathBuf,
        /// Output directory (default: current dir).
        #[arg(long, default_value = ".")]
        out: PathBuf,
    },
    /// Report the benchmark fidelity gate status (prerequisites + what can run now).
    Fidelity {
        /// File to check (default: the repo-root benchmark.hwp).
        file: Option<PathBuf>,
    },
    /// Render a page to SVG via the rhwp bootstrap (build with `--features rhwp`).
    Render {
        file: PathBuf,
        /// Page index (0-based).
        #[arg(long, default_value = "0")]
        page: u32,
        /// Output SVG path.
        #[arg(long, default_value = "page.svg")]
        out: PathBuf,
    },
    /// Render ALL pages into a single self-contained HTML viewer (build with `--features rhwp`).
    View {
        file: PathBuf,
        /// Output HTML path.
        #[arg(long, default_value = "view.html")]
        out: PathBuf,
    },
    /// AI-fill: an LLM proposes paragraph(s) → applied via the op-bus → export HWPX.
    /// Default provider `mock` (no key). Anthropic BYOK: build `--features ai` + set ANTHROPIC_API_KEY.
    AiFill {
        file: PathBuf,
        /// Instruction for the AI (e.g. "결론 문단을 추가해줘").
        #[arg(long)]
        instruction: String,
        /// Provider: auto | mock | anthropic.
        #[arg(long, default_value = "auto")]
        provider: String,
        /// Output HWPX path.
        #[arg(long, default_value = "out.hwpx")]
        out: PathBuf,
        /// Verify Hancom-acceptability by opening the output in the oracle.
        #[arg(long)]
        verify: bool,
        /// Preview the proposed change (rationale + per-op diff) and STOP — do not write output.
        #[arg(long)]
        dry_run: bool,
    },
    /// AI chat-edit ("vibe docs"): the LLM sees the doc as an anchored [s/b] outline and proposes
    /// targeted edits (insert table/image/heading near an anchor, shade a column, delete a block).
    /// Applied via the op-bus → export. Output format by extension: .html (browser) or .hwpx.
    AiEdit {
        file: PathBuf,
        /// What to do, in natural language (e.g. "목차 아래에 표 만들어줘", "표의 좌측열을 헤더 색으로").
        #[arg(long)]
        instruction: String,
        /// Provider: auto | mock | anthropic | local.
        #[arg(long, default_value = "auto")]
        provider: String,
        /// Output path. `.html` → standalone HTML (vibe-docs view); otherwise round-trip-safe HWPX.
        #[arg(long, default_value = "out.hwpx")]
        out: PathBuf,
        /// Preview the proposed edits (rationale + per-op diff) and STOP — do not write output.
        #[arg(long)]
        dry_run: bool,
    },
    /// Manage the stored Anthropic BYOK key in the OS keychain (`--features ai`).
    /// `set` reads the key from stdin (not argv); `status` shows the source; `clear` removes it.
    AiKey {
        /// Action: set | clear | status
        action: String,
    },
    /// Print the AI content template + the document context (the "read" tool of the AI loop).
    /// A coding agent (Claude Code) reads this, then authors a content JSON for `ai-apply`.
    AiContext { file: PathBuf },
    /// Apply AI-authored structured content (template JSON) → preprocess to ops → export HWPX.
    /// Keyless: an agent (or `ai-fill`) produces the JSON; this is the "write" tool.
    AiApply {
        file: PathBuf,
        /// Path to the AI content JSON (template-conformant).
        #[arg(long)]
        content: PathBuf,
        /// Output HWPX path.
        #[arg(long, default_value = "out.hwpx")]
        out: PathBuf,
        /// Verify Hancom-acceptability via the oracle.
        #[arg(long)]
        verify: bool,
    },
    /// Convert a binary .hwp (HW5) to editable .hwpx — text + formatting + tables + page geometry.
    /// Needs `--features rhwp` to lift .hwp; HWPX input is normalized (re-serialized). Output defaults
    /// to the input path with a .hwpx extension (same folder), so `convert report.hwp` writes
    /// `report.hwpx` beside it.
    Convert {
        file: PathBuf,
        /// Output .hwpx path (default: input path with .hwpx extension).
        #[arg(long)]
        out: Option<PathBuf>,
        /// Verify Hancom-acceptability by opening the output in the oracle (soffice+H2Orestart).
        #[arg(long)]
        verify: bool,
    },
    /// Visual self-verification: convert <in.hwp> → .hwpx, then render BOTH the original .hwp and
    /// our converted .hwpx via rhwp into a side-by-side HTML — so you can eyeball conversion fidelity
    /// independent of LibreOffice (and on equation-dense docs LibreOffice can't even load).
    /// Needs `--features rhwp`.
    VerifyConvert {
        file: PathBuf,
        /// Output HTML path.
        #[arg(long, default_value = "verify.html")]
        out: PathBuf,
    },
    /// Score our own layout engine against Hancom's actual layout: parse <file.hwp>, then compare
    /// our line-breaking + pagination to the `<hp:lineseg>`s Hancom authored (page count, per-
    /// paragraph line-count match %). The measurable oracle for the layout engine. Needs
    /// `--features rhwp`; run on an ORIGINAL .hwp (which carries Hancom's linesegs).
    LayoutCheck { file: PathBuf },
    /// PIVOT M0: project an HWPX into a JSX(content)+CSS(design) project directory
    /// (project.json, document.jsx, sections/, styles/document.css, assets/). HWPX-only.
    OpenProject {
        file: PathBuf,
        /// Output project directory.
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// PIVOT M1: render a document to ONE self-contained .html the browser lays out (semantic-
    /// reflow, framing B). `.hwpx` works in the default build; `.hwp` needs `--features rhwp`.
    /// Open the output in any browser — your HWP as a clean web page. Doubles as the HTML export.
    ExportHtml {
        file: PathBuf,
        /// Output HTML path.
        #[arg(long, short, default_value = "out.html")]
        out: PathBuf,
    },
    /// PIVOT M0: apply ONE CSS-only AI-routing op (CssSetDecl) to a project dir, proving
    /// content/design separation — only styles/document.css is re-written; the .jsx are untouched.
    EditOp {
        /// Project directory (written by `open-project`).
        proj: PathBuf,
        /// Target node id (e.g. "n1"), or a class ("c1"/"p1") via --class.
        #[arg(long)]
        node: Option<String>,
        /// Target a CSS class directly (e.g. "c1").
        #[arg(long)]
        class: Option<String>,
        /// CSS property (e.g. "font-size").
        #[arg(long)]
        prop: String,
        /// CSS value (e.g. "14pt").
        #[arg(long)]
        value: String,
    },
    /// Edit an HWPX (append paragraphs) and export round-trip-safe HWPX. (No rhwp needed.)
    Edit {
        file: PathBuf,
        /// Paragraph text to append (repeatable).
        #[arg(long)]
        append: Vec<String>,
        /// Output HWPX path.
        #[arg(long, default_value = "out.hwpx")]
        out: PathBuf,
        /// Verify real Hancom-acceptability by opening the output in the oracle (soffice+H2Orestart).
        #[arg(long)]
        verify: bool,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Detect { file } => {
            let bytes = read(&file)?;
            println!("{}", hwp_core::Engine::detect(&bytes).as_str());
        }
        Cmd::Info { file } => info(&file)?,
        Cmd::ExtractText { file } => {
            let bytes = read(&file)?;
            match hwp_core::Engine::detect(&bytes) {
                SourceFormat::Hwpx => {
                    let text = hwp_hwpx::text::extract_text(&bytes).map_err(|e| e.to_string())?;
                    print!("{text}");
                }
                SourceFormat::Hwp5 | SourceFormat::Hwp3 => {
                    // Lift via rhwp → SemanticDoc → reading-order text (needs --features rhwp).
                    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
                    print!("{}", doc.plain_text());
                }
                SourceFormat::Unknown => return Err("unrecognized format".into()),
            }
        }
        Cmd::Oracle { file, out } => {
            if !hwp_oracle::soffice_available() {
                return Err("soffice not found on PATH (install LibreOffice)".into());
            }
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let pdf = hwp_oracle::convert_to_pdf(&file, &out).map_err(|e| e.to_string())?;
            println!("oracle PDF: {}", pdf.display());
        }
        Cmd::Fidelity { file } => fidelity(file)?,
        Cmd::Render { file, page, out } => render(&file, page, &out)?,
        Cmd::View { file, out } => view(&file, &out)?,
        Cmd::Convert { file, out, verify } => convert(&file, out, verify)?,
        Cmd::VerifyConvert { file, out } => verify_convert(&file, &out)?,
        Cmd::LayoutCheck { file } => layout_check(&file)?,
        Cmd::OpenProject { file, out_dir } => open_project(&file, &out_dir)?,
        Cmd::ExportHtml { file, out } => export_html(&file, &out)?,
        Cmd::EditOp { proj, node, class, prop, value } => {
            edit_op(&proj, node, class, &prop, &value)?
        }
        Cmd::Edit { file, append, out, verify } => edit(&file, &append, &out, verify)?,
        Cmd::AiFill { file, instruction, provider, out, verify, dry_run } => {
            ai_fill(&file, &instruction, &provider, &out, verify, dry_run)?
        }
        Cmd::AiEdit { file, instruction, provider, out, dry_run } => {
            ai_edit(&file, &instruction, &provider, &out, dry_run)?
        }
        Cmd::AiKey { action } => ai_key(&action)?,
        Cmd::AiContext { file } => ai_context(&file)?,
        Cmd::AiApply { file, content, out, verify } => ai_apply(&file, &content, &out, verify)?,
    }
    Ok(())
}

fn ai_context(file: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    println!("{}", hwp_ai::content::template_brief());
    println!("\n--- 문서 맥락 (DOCUMENT CONTEXT) ---");
    print!("{}", hwp_ai::to_markdown(&doc).unwrap_or_default());
    Ok(())
}

fn ai_apply(file: &PathBuf, content: &PathBuf, out: &PathBuf, verify: bool) -> Result<(), String> {
    let bytes = read(file)?;
    if hwp_core::Engine::detect(&bytes) != SourceFormat::Hwpx {
        return Err("ai-apply operates on HWPX (.hwpx).".into());
    }
    let json = std::fs::read_to_string(content)
        .map_err(|e| format!("read {}: {e}", content.display()))?;
    let ai = hwp_ai::content::parse_content(&json).map_err(|e| e.to_string())?;
    let ops = hwp_ai::content::compile_to_ops(&ai);
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    let mut session = hwp_ops::EditSession::new(doc);
    for op in &ops {
        session.do_op(op).map_err(|e| e.to_string())?;
    }
    let doc = session.into_doc();
    let out_bytes = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;
    hwp_core::atomic_write(out, &out_bytes).map_err(|e| e.to_string())?;
    let report = hwp_core::validate_hwpx(&out_bytes);
    println!(
        "ai-apply: {} block(s) → {} op(s) → {} ({} bytes)",
        ai.blocks.len(),
        ops.len(),
        out.display(),
        out_bytes.len()
    );
    println!("editor-open-safety (cheap gate): {}", if report.ok { "OK ✓" } else { "FAIL ✗" });
    if verify {
        if !hwp_oracle::soffice_available() {
            println!("verify: skipped (soffice not available)");
            return Ok(());
        }
        let dir = std::env::temp_dir().join("tfhwp_aiapply_verify");
        match hwp_oracle::convert_to_pdf(out, &dir) {
            Ok(pdf) => println!("verify: ORACLE OPENS IT ✓ ({})", pdf.display()),
            Err(e) => println!("verify: ORACLE REJECTS IT ✗ ({e})"),
        }
    }
    Ok(())
}

fn pick_provider(name: &str) -> Result<Box<dyn hwp_ai::LlmProvider>, String> {
    match name {
        "mock" => Ok(Box::new(hwp_ai::MockProvider)),
        "anthropic" => anthropic_provider(),
        "local" => local_provider(),
        "auto" => {
            // Prefer a local model we control, then cloud BYOK, then the deterministic mock — so a
            // test/CI machine with neither still gets our controlled generation.
            if local_available() {
                local_provider()
            } else if hwp_ai::secret::has_anthropic_key() {
                anthropic_provider().or_else(|_| Ok(Box::new(hwp_ai::MockProvider)))
            } else {
                Ok(Box::new(hwp_ai::MockProvider))
            }
        }
        other => Err(format!("unknown provider '{other}' (use auto | mock | anthropic | local)")),
    }
}

#[cfg(feature = "ai")]
fn anthropic_provider() -> Result<Box<dyn hwp_ai::LlmProvider>, String> {
    hwp_ai::anthropic::AnthropicProvider::from_env()
        .map(|p| Box::new(p) as Box<dyn hwp_ai::LlmProvider>)
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "ai"))]
fn anthropic_provider() -> Result<Box<dyn hwp_ai::LlmProvider>, String> {
    Err("the anthropic provider needs a build with `--features ai` (then set a key via `ai-key set` or ANTHROPIC_API_KEY)".into())
}

#[cfg(feature = "ai")]
fn local_provider() -> Result<Box<dyn hwp_ai::LlmProvider>, String> {
    Ok(Box::new(hwp_ai::ollama::OllamaProvider::from_env()) as Box<dyn hwp_ai::LlmProvider>)
}

#[cfg(not(feature = "ai"))]
fn local_provider() -> Result<Box<dyn hwp_ai::LlmProvider>, String> {
    Err("the local (Ollama) provider needs a build with `--features ai`".into())
}

#[cfg(feature = "ai")]
fn local_available() -> bool {
    hwp_ai::ollama::OllamaProvider::available()
}

#[cfg(not(feature = "ai"))]
fn local_available() -> bool {
    false
}

#[cfg(feature = "ai")]
fn ai_key(action: &str) -> Result<(), String> {
    use std::io::Read;
    match action {
        "status" => {
            println!("BYOK 키 소스: {}", hwp_ai::secret::key_source().label());
            Ok(())
        }
        "set" => {
            eprintln!("Anthropic API 키를 입력하고 Ctrl-D (stdin → OS 키체인에 저장):");
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| e.to_string())?;
            hwp_ai::secret::store_anthropic_key(buf.trim()).map_err(|e| e.to_string())?;
            println!("키를 OS 키체인에 저장했습니다 (service=tf-hwp). 이후 ai-fill에서 자동 사용됩니다.");
            Ok(())
        }
        "clear" => {
            hwp_ai::secret::clear_anthropic_key().map_err(|e| e.to_string())?;
            println!("키체인에서 키를 제거했습니다.");
            Ok(())
        }
        other => Err(format!("unknown ai-key action '{other}' (use set | clear | status)")),
    }
}

#[cfg(not(feature = "ai"))]
fn ai_key(_action: &str) -> Result<(), String> {
    Err("ai-key needs a build with `--features ai` (OS keychain support)".into())
}

fn ai_fill(
    file: &PathBuf,
    instruction: &str,
    provider: &str,
    out: &PathBuf,
    verify: bool,
    dry_run: bool,
) -> Result<(), String> {
    let bytes = read(file)?;
    if hwp_core::Engine::detect(&bytes) != SourceFormat::Hwpx {
        return Err("ai-fill operates on HWPX (.hwpx). Convert .hwp to HWPX first.".into());
    }
    let provider = pick_provider(provider)?;
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;

    // PROPOSE: the provider authors rich content, validated on a scratch copy (doc untouched).
    let proposal = hwp_ai::propose(&doc, &*provider, instruction).map_err(|e| e.to_string())?;
    println!("ai-fill via '{}' — 제안 (rationale):\n{}", provider.name(), proposal.rationale);
    println!("\n변경 미리보기 ({} op):\n{}", proposal.ops.len(), proposal.preview());

    if dry_run {
        println!("dry-run: 출력은 쓰지 않았습니다. 적용하려면 --dry-run 없이 다시 실행하세요.");
        return Ok(());
    }

    // COMMIT: apply the approved ops as ONE undoable change (same op-bus a human edit uses).
    let mut session = hwp_ops::EditSession::new(doc);
    session.do_ops(&proposal.ops).map_err(|e| e.to_string())?;
    let doc = session.into_doc();
    let out_bytes = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;
    hwp_core::atomic_write(out, &out_bytes).map_err(|e| e.to_string())?;
    let report = hwp_core::validate_hwpx(&out_bytes);
    println!(
        "\ncommitted (+{} op) → {} ({} bytes)",
        proposal.ops.len(),
        out.display(),
        out_bytes.len()
    );
    println!("editor-open-safety (cheap gate): {}", if report.ok { "OK ✓" } else { "FAIL ✗" });
    if verify {
        if !hwp_oracle::soffice_available() {
            println!("verify: skipped (soffice not available)");
            return Ok(());
        }
        let dir = std::env::temp_dir().join("tfhwp_aifill_verify");
        match hwp_oracle::convert_to_pdf(out, &dir) {
            Ok(pdf) => println!("verify: ORACLE OPENS IT ✓ ({})", pdf.display()),
            Err(e) => println!("verify: ORACLE REJECTS IT ✗ ({e})"),
        }
    }
    Ok(())
}

fn ai_edit(
    file: &PathBuf,
    instruction: &str,
    provider: &str,
    out: &Path,
    dry_run: bool,
) -> Result<(), String> {
    let bytes = read(file)?;
    // Engine::open handles .hwpx (default) + .hwp lift (--features rhwp).
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    let provider = pick_provider(provider)?;

    // PROPOSE: the provider sees the anchored [s/b] outline and authors an EditScript, compiled to
    // anchored ops + dry-run on a scratch clone (doc untouched until commit).
    let proposal = hwp_ai::propose_edits(&doc, &*provider, instruction).map_err(|e| e.to_string())?;
    println!("ai-edit via '{}' — 제안 (rationale):\n{}", provider.name(), proposal.rationale);
    println!("\n[문서 개요]\n{}", hwp_ai::to_markdown(&doc).unwrap_or_default());
    println!("변경 미리보기 ({} op):\n{}", proposal.ops.len(), proposal.preview());

    if dry_run {
        println!("dry-run: 출력은 쓰지 않았습니다. 적용하려면 --dry-run 없이 다시 실행하세요.");
        return Ok(());
    }

    // COMMIT: apply the approved ops as ONE undoable change (same op-bus a human edit uses).
    let mut session = hwp_ops::EditSession::new(doc);
    session.do_ops(&proposal.ops).map_err(|e| e.to_string())?;
    let doc = session.into_doc();

    // Output format by extension: .html → vibe-docs standalone HTML; else round-trip-safe HWPX.
    if out.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("html")) == Some(true) {
        let proj = hwp_jsx::emit(&doc);
        let title = file.file_stem().map(|s| s.to_string_lossy().into_owned());
        let html = hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title });
        std::fs::write(out, &html).map_err(|e| format!("write {}: {e}", out.display()))?;
        println!(
            "\ncommitted (+{} op) → {} ({} KB) — open in any browser.",
            proposal.ops.len(),
            out.display(),
            html.len() / 1024
        );
    } else {
        let out_bytes = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;
        hwp_core::atomic_write(out, &out_bytes).map_err(|e| e.to_string())?;
        let report = hwp_core::validate_hwpx(&out_bytes);
        println!(
            "\ncommitted (+{} op) → {} ({} bytes)",
            proposal.ops.len(),
            out.display(),
            out_bytes.len()
        );
        println!("editor-open-safety (cheap gate): {}", if report.ok { "OK ✓" } else { "FAIL ✗" });
    }
    Ok(())
}

fn convert(file: &PathBuf, out: Option<PathBuf>, verify: bool) -> Result<(), String> {
    let bytes = read(file)?;
    // Lifts .hwp (needs --features rhwp) or parses .hwpx; serialize_hwpx then produces the package
    // (from-scratch synthesis for a lifted .hwp, verbatim round-trip for HWPX).
    let (doc, was_converted) = hwp_core::open_as_hwpx(&bytes).map_err(|e| e.to_string())?;

    let mut out_path = out.unwrap_or_else(|| file.with_extension("hwpx"));
    if out_path == *file {
        // Input was already .hwpx and no --out given: never overwrite the source.
        let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        out_path = file.with_file_name(format!("{stem}-converted.hwpx"));
    }

    let out_bytes = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;
    hwp_core::atomic_write(&out_path, &out_bytes).map_err(|e| e.to_string())?;
    let report = hwp_core::validate_hwpx(&out_bytes);
    println!("{} → {} ({} bytes)", file.display(), out_path.display(), out_bytes.len());
    println!("editor-open-safety: {}", if report.ok { "OK ✓" } else { "FAIL ✗" });
    for b in &report.blocking {
        println!("  blocking: {b}");
    }
    if was_converted {
        println!("\n참고: {}", hwp_core::HWP5_CONVERSION_NOTICE);
    }
    if verify {
        if !hwp_oracle::soffice_available() {
            println!("verify: skipped (soffice not available)");
            return Ok(());
        }
        let dir = std::env::temp_dir().join("tfhwp_convert_verify");
        match hwp_oracle::convert_to_pdf(&out_path, &dir) {
            Ok(pdf) => println!("verify: ORACLE OPENS IT ✓ ({})", pdf.display()),
            Err(e) => println!("verify: ORACLE REJECTS IT ✗ ({e})"),
        }
    }
    Ok(())
}

fn export_html(file: &PathBuf, out: &Path) -> Result<(), String> {
    let bytes = read(file)?;
    // Engine::open handles both: .hwpx parse (default build) + .hwp lift (needs --features rhwp).
    let doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    let proj = hwp_jsx::emit(&doc);
    let title = file.file_stem().map(|s| s.to_string_lossy().into_owned());
    let html = hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title });
    std::fs::write(out, &html).map_err(|e| format!("write {}: {e}", out.display()))?;
    println!(
        "wrote {} ({} KB) — open it in any browser (semantic-reflow; not pixel-identical to 한글).",
        out.display(),
        html.len() / 1024
    );
    Ok(())
}

fn open_project(file: &PathBuf, out_dir: &Path) -> Result<(), String> {
    let bytes = read(file)?;
    if hwp_core::Engine::detect(&bytes) != SourceFormat::Hwpx {
        return Err("open-project operates on HWPX (.hwpx) for M0.".into());
    }
    let doc = hwp_hwpx::parse::parse_semantic(&bytes).map_err(|e| e.to_string())?;
    let proj = hwp_jsx::emit(&doc);
    // Self-check the M0 invariant before writing (fail loud if the projection is lossy).
    let back = hwp_jsx::parse(&proj).map_err(|e| e.to_string())?;
    if !hwp_jsx::equality::doc_value_eq(&doc, &back) {
        return Err("round-trip invariant FAILED for this file (projection is lossy)".into());
    }
    hwp_jsx::write_project_dir(&proj, out_dir).map_err(|e| e.to_string())?;
    println!(
        "open-project: {} → {} ({} section(s), {} CSS rule(s), {} asset(s)) [round-trip OK ✓]",
        file.display(),
        out_dir.display(),
        proj.sections.len(),
        proj.styles.rules.len(),
        proj.assets.len()
    );
    Ok(())
}

fn edit_op(
    proj_dir: &Path,
    node: Option<String>,
    class: Option<String>,
    prop: &str,
    value: &str,
) -> Result<(), String> {
    use hwp_jsx::op::{css_set_decl, CssSetDecl, CssTarget};
    let mut proj = hwp_jsx::read_project_dir(proj_dir).map_err(|e| e.to_string())?;
    let target = match (node, class) {
        (Some(n), _) => CssTarget::Node(n),
        (None, Some(c)) => CssTarget::Class(c),
        (None, None) => return Err("provide --node <id> or --class <name>".into()),
    };
    let sel = css_set_decl(&mut proj, &CssSetDecl { target, prop: prop.into(), value: value.into() })
        .map_err(|e| e.to_string())?;
    // Dirty-only re-emit: rewrite ONLY styles/document.css; .jsx files stay byte-identical on disk.
    let css = hwp_jsx::css::emit_css(&proj.styles);
    std::fs::write(proj_dir.join("styles/document.css"), &css)
        .map_err(|e| format!("write css: {e}"))?;
    println!(
        "edit-op: 🎨 {} {{ {prop}: {value} }} (CSS only) → styles/document.css rewritten; .jsx untouched",
        sel.render()
    );
    Ok(())
}

fn edit(file: &PathBuf, append: &[String], out: &PathBuf, verify: bool) -> Result<(), String> {
    let bytes = read(file)?;
    if hwp_core::Engine::detect(&bytes) != SourceFormat::Hwpx {
        return Err("edit/export operates on HWPX (.hwpx). Convert .hwp to HWPX first.".into());
    }
    let mut doc = hwp_core::Engine::open(&bytes).map_err(|e| e.to_string())?;
    for text in append {
        hwp_ops::apply(&mut doc, &hwp_ops::Op::AppendParagraph { section: 0, text: text.clone() })
            .map_err(|e| e.to_string())?;
    }
    let out_bytes = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;
    hwp_core::atomic_write(out, &out_bytes).map_err(|e| e.to_string())?;
    let report = hwp_core::validate_hwpx(&out_bytes);
    println!(
        "edited (+{} paragraph(s)) → {} ({} bytes)",
        append.len(),
        out.display(),
        out_bytes.len()
    );
    println!("editor-open-safety (cheap gate): {}", if report.ok { "OK ✓" } else { "FAIL ✗" });
    for b in &report.blocking {
        println!("  blocking: {b}");
    }
    if verify {
        // The authoritative gate: does the oracle (LibreOffice+H2Orestart) actually open it?
        if !hwp_oracle::soffice_available() {
            println!("verify: skipped (soffice not available)");
            return Ok(());
        }
        let dir = std::env::temp_dir().join("tfhwp_edit_verify");
        match hwp_oracle::convert_to_pdf(out, &dir) {
            Ok(pdf) => println!("verify: ORACLE OPENS IT ✓ ({})", pdf.display()),
            Err(e) => println!("verify: ORACLE REJECTS IT ✗ ({e})"),
        }
    }
    Ok(())
}

#[cfg(feature = "rhwp")]
fn render(file: &PathBuf, page: u32, out: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let n = hwp_core::page_count(&bytes).map_err(|e| e.to_string())?;
    let svg = hwp_core::render_page_svg(&bytes, page).map_err(|e| e.to_string())?;
    std::fs::write(out, svg).map_err(|e| e.to_string())?;
    println!("pages: {n}; wrote page {page} → {}", out.display());
    Ok(())
}

#[cfg(not(feature = "rhwp"))]
fn render(_file: &PathBuf, _page: u32, _out: &PathBuf) -> Result<(), String> {
    Err("`render` needs the rhwp bootstrap: ./scripts/vendor-rhwp.sh then \
         `cargo run -p tf-hwp-cli --features rhwp -- render <file>`"
        .into())
}

#[cfg(feature = "rhwp")]
fn view(file: &PathBuf, out: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let n = hwp_core::page_count(&bytes).map_err(|e| e.to_string())?;
    // Faithful "한컴 독스처럼 열어보기" paged preview: each HWP page is rhwp's own pixel-faithful SVG
    // (exact tables + pagination + the doc's footer page numbers), shown as a white A4 sheet on a
    // gray canvas — the layout-preserve VIEW (the JSX/CSS HTML export is the separate semantic-reflow
    // form). rhwp paginates the document exactly (page breaks honored), so this matches 한컴.
    let mut pages = String::new();
    for p in 0..n {
        let svg = sanitize_svg(&hwp_core::render_page_svg(&bytes, p).map_err(|e| e.to_string())?);
        pages.push_str(&format!(
            "<div class=\"sheet\"><div class=\"page\">{svg}</div><div class=\"pnum\">{} / {n}</div></div>\n",
            p + 1
        ));
    }
    let title = esc_html(&file.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
    let html = format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>{title} — tf-hwp 미리보기</title><style>\
:root{{color-scheme:dark}}\
*{{box-sizing:border-box}}\
body{{margin:0;background:#5b5e63;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}}\
.bar{{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;\
height:44px;padding:0 16px;background:rgba(32,33,36,.92);backdrop-filter:blur(8px);\
color:#e8eaed;font-size:13px;border-bottom:1px solid rgba(255,255,255,.08)}}\
.bar b{{font-weight:600}} .bar .sp{{flex:1}} .bar .muted{{color:#9aa0a6}}\
.doc{{display:flex;flex-direction:column;align-items:center;gap:24px;padding:28px 12px 60px}}\
.sheet{{display:flex;flex-direction:column;align-items:center;gap:9px}}\
.page{{background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.45);max-width:96vw}}\
.page svg{{display:block;max-width:100%;height:auto}}\
.pnum{{color:#cdd0d4;font-size:12px;letter-spacing:.02em}}\
</style></head><body>\
<div class=\"bar\"><b>{title}</b><span class=\"muted\">한컴 독스 미리보기</span>\
<span class=\"sp\"></span><span class=\"muted\">{n}쪽</span></div>\
<div class=\"doc\">{pages}</div></body></html>"
    );
    std::fs::write(out, html).map_err(|e| e.to_string())?;
    println!("rendered {n} pages → {} (open in a browser — 한컴 독스처럼 보입니다)", out.display());
    Ok(())
}

/// HTML-escape text for the viewer chrome (filename/title).
#[cfg(feature = "rhwp")]
fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Minimal SVG safety for the embedded page render: strip <script>…</script> and on* handlers so an
/// untrusted document can't run JS in the preview (P0-4 discipline; rhwp emits text/paths only, this
/// is defense-in-depth). Coarse but sufficient for a trusted-renderer SVG.
#[cfg(feature = "rhwp")]
fn sanitize_svg(svg: &str) -> String {
    let mut out = svg.to_string();
    while let Some(a) = out.to_ascii_lowercase().find("<script") {
        let end = out[a..]
            .to_ascii_lowercase()
            .find("</script>")
            .map(|e| a + e + "</script>".len())
            .unwrap_or(out.len());
        out.replace_range(a..end, "");
    }
    out
}

#[cfg(not(feature = "rhwp"))]
fn view(_file: &PathBuf, _out: &PathBuf) -> Result<(), String> {
    Err("`view` needs the rhwp bootstrap: build with `--features rhwp`".into())
}

#[cfg(feature = "rhwp")]
fn verify_convert(file: &PathBuf, out: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let (doc, converted) = hwp_core::open_as_hwpx(&bytes).map_err(|e| e.to_string())?;
    let hwpx = hwp_core::serialize_hwpx(&doc).map_err(|e| e.to_string())?;

    // Render every page of a doc via rhwp into a labeled column.
    let column = |label: &str, b: &[u8]| -> Result<(u32, String), String> {
        let n = hwp_core::page_count(b).map_err(|e| e.to_string())?;
        let mut pages = String::new();
        for p in 0..n {
            let svg = hwp_core::render_page_svg(b, p).map_err(|e| e.to_string())?;
            pages.push_str(&format!("<div class=\"page\">{svg}</div>"));
        }
        Ok((n, format!("<div class=\"col\"><h2>{label} · {n}쪽</h2>{pages}</div>")))
    };

    let (lpages, left) = column("원본 .hwp (rhwp)", &bytes)?;
    let (rpages, right) = column("변환 .hwpx (rhwp)", &hwpx)?;

    let html = format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>verify-convert — tf-hwp</title>\
<style>body{{background:#525659;margin:0;font-family:sans-serif;color:#eee}}\
.cols{{display:flex;gap:24px;align-items:flex-start;padding:24px}}\
.col{{flex:1;display:flex;flex-direction:column;gap:16px;align-items:center;min-width:0}}\
.col h2{{position:sticky;top:0;background:#333;width:100%;text-align:center;margin:0;padding:8px;font-size:14px;z-index:1}}\
.page{{background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4)}}\
.page svg{{display:block;max-width:100%;height:auto}}</style></head>\
<body><div class=\"cols\">{left}{right}</div></body></html>"
    );
    std::fs::write(out, &html).map_err(|e| e.to_string())?;
    println!(
        "verify-convert: {}{} → {} (원본 {lpages}쪽 | 변환 {rpages}쪽, rhwp 렌더)",
        file.display(),
        if converted { " [HWP5→HWPX]" } else { "" },
        out.display()
    );
    if lpages != rpages {
        println!(
            "  ⚠ rhwp 쪽수 차이 {lpages}→{rpages}: 변환 .hwpx는 linesegarray(레이아웃 캐시)가 비어 있어 \
rhwp가 페이지를 못 끊고 reflow/overflow합니다(내용은 보존). 깨끗한 레이아웃은 아래 LibreOffice 렌더로 확인하세요."
        );
    }

    // ALSO emit LibreOffice+H2Orestart's render of the converted .hwpx — it RE-COMPUTES layout (no
    // linesegarray needed), so it's the faithful clean render of our output. (Can't load
    // equation-dense docs, which Hancom's own files also can't in LibreOffice.)
    if hwp_oracle::soffice_available() {
        let dir = out.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
        let hwpx_path = dir.join("verify-converted.hwpx");
        std::fs::write(&hwpx_path, &hwpx).map_err(|e| e.to_string())?;
        match hwp_oracle::convert_to_pdf(&hwpx_path, &dir) {
            Ok(pdf) => println!("  깨끗한 변환 렌더(LibreOffice): {}", pdf.display()),
            Err(_) => println!("  (LibreOffice 변환 렌더 실패 — 수식 밀집 문서는 한컴 원본도 LibreOffice로 안 열림)"),
        }
        // The original, for a clean side reference too.
        if let Ok(pdf) = hwp_oracle::convert_to_pdf(file, &dir) {
            println!("  원본 렌더(LibreOffice): {}", pdf.display());
        }
    }
    println!("  → HTML(rhwp, 내용 대조) + PDF(LibreOffice, 깔끔한 레이아웃)로 시각 검증하세요.");
    Ok(())
}

#[cfg(not(feature = "rhwp"))]
fn verify_convert(_file: &PathBuf, _out: &PathBuf) -> Result<(), String> {
    Err("`verify-convert` needs the rhwp bootstrap: build with `--features rhwp`".into())
}

#[cfg(feature = "rhwp")]
fn layout_check(file: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let f = hwp_core::layout_fidelity(&bytes).map_err(|e| e.to_string())?;
    let pct = |n: usize| if f.paragraphs == 0 { 0.0 } else { 100.0 * n as f64 / f.paragraphs as f64 };
    println!("레이아웃 엔진 대조 (vs 한컴 실제 레이아웃): {}", file.display());
    println!(
        "  쪽수      우리 {:>4}  ·  한컴(rhwp) {:>4}  ({})",
        f.our_pages,
        f.oracle_pages,
        if f.our_pages as u32 == f.oracle_pages { "일치" } else { "차이" }
    );
    println!(
        "  총 줄수    우리 {:>6}  ·  한컴 {:>6}  (비율 {:.2})",
        f.our_lines,
        f.oracle_lines,
        if f.oracle_lines == 0 { 0.0 } else { f.our_lines as f64 / f.oracle_lines as f64 }
    );
    println!(
        "  블록 구성   표 {} (행 {}) · 이미지 {} · 수식 {} · 본문높이 {} HWPUNIT",
        f.tables, f.table_rows, f.images, f.equations, f.body_height
    );
    println!("  문단       {} 개 대조", f.paragraphs);
    println!("    줄수 정확 일치   {:>5} ({:.1}%)", f.line_exact, pct(f.line_exact));
    println!("    줄수 ±1 이내     {:>5} ({:.1}%)", f.line_within1, pct(f.line_within1));
    println!(
        "  → 근사 메트릭(전각1·반각0.5·공백0.3 EM)의 줄바꿈 충실도. 실제 셰이퍼(harfrust)로 좁힐 목표."
    );
    Ok(())
}

#[cfg(not(feature = "rhwp"))]
fn layout_check(_file: &PathBuf) -> Result<(), String> {
    Err("`layout-check` needs the rhwp bootstrap (한컴 linesegs 파싱): build with `--features rhwp`".into())
}

fn fidelity(file: Option<PathBuf>) -> Result<(), String> {
    let path = file.unwrap_or_else(hwp_fidelity::benchmark_path);
    let pre = hwp_fidelity::Prerequisites::detect();
    let mark = |b: bool| if b { "✓" } else { "✗" };
    println!("benchmark: {}", path.display());
    if let Ok(bytes) = std::fs::read(&path) {
        println!("format:    {}", hwp_core::Engine::detect(&bytes).as_str());
    }
    println!("prerequisites for the \"원본 그대로\" gate:");
    println!("  {} soffice (LibreOffice)", mark(pre.soffice));
    println!("  {} H2Orestart extension (modern HWP)   scripts/install-h2orestart.sh", mark(pre.h2orestart));
    println!("  {} engine render path                  scripts/vendor-rhwp.sh + --features rhwp", mark(pre.engine_render));
    let ground_truth = hwp_fidelity::reference_pdf_for(&path);
    if let Some(p) = &ground_truth {
        println!("  ✓ ground-truth PDF                    {}", p.display());
    }
    println!(
        "status: reference render {} · full fidelity compare {}",
        if pre.can_reference() || ground_truth.is_some() { "READY" } else { "blocked" },
        if pre.engine_render && (pre.can_reference() || ground_truth.is_some()) { "READY" } else { "blocked" },
    );

    #[cfg(feature = "rhwp")]
    if pre.engine_render && (pre.can_reference() || ground_truth.is_some()) {
        let band = |b: hwp_fidelity::FidelityBand| match b {
            hwp_fidelity::FidelityBand::Green => "GREEN",
            hwp_fidelity::FidelityBand::Yellow => "YELLOW",
            hwp_fidelity::FidelityBand::Red => "RED",
        };
        println!("\nrunning fidelity compare (ours=rhwp)…");
        match hwp_fidelity::compare(&path) {
            Ok(r) => {
                let (refname, note) = match r.reference {
                    hwp_fidelity::ReferenceKind::GroundTruthPdf => {
                        ("ground-truth PDF", "ABSOLUTE fidelity vs the authoritative PDF")
                    }
                    hwp_fidelity::ReferenceKind::Oracle => {
                        ("oracle (LibreOffice+H2Orestart)", "cross-renderer agreement; not Hancom ground-truth")
                    }
                };
                println!("  reference: {refname}");
                if r.our_pages != r.ref_pages {
                    println!("  ⚠ page-count divergence: ours={} vs ref={} (structural)", r.our_pages, r.ref_pages);
                }
                for p in &r.pages {
                    match p.similarity {
                        Some(s) => println!("  page {:>2}: {:>6}  ({:.1}% match)", p.index + 1, band(p.band), s * 100.0),
                        None => println!("  page {:>2}: {:>6}  (page exists in only one render)", p.index + 1, band(p.band)),
                    }
                }
                println!("  overall: {}  ({note})", band(r.overall));
            }
            Err(e) => println!("  compare failed: {e}"),
        }
    }
    Ok(())
}

fn info(file: &PathBuf) -> Result<(), String> {
    let bytes = read(file)?;
    let fmt = hwp_core::Engine::detect(&bytes);
    println!("file:   {}", file.display());
    println!("size:   {} bytes", bytes.len());
    println!("format: {}", fmt.as_str());

    if fmt == SourceFormat::Hwpx {
        let pkg = hwp_hwpx::package::Package::open(&bytes).map_err(|e| e.to_string())?;
        println!("mimetype: {}", pkg.mimetype.as_deref().unwrap_or("(none)"));
        println!("parts ({}):", pkg.part_names.len());
        for n in &pkg.part_names {
            println!("  - {n}");
        }
        let sections = pkg.section_part_names();
        println!("body sections: {}", sections.len());
    }
    Ok(())
}

fn read(p: &PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))
}
