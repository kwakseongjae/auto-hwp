//! tf-hwp CLI. Phase-0 runnable surface: `detect`, `info`, `extract-text`, `oracle`.

use std::path::PathBuf;
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
        Cmd::Edit { file, append, out, verify } => edit(&file, &append, &out, verify)?,
        Cmd::AiFill { file, instruction, provider, out, verify, dry_run } => {
            ai_fill(&file, &instruction, &provider, &out, verify, dry_run)?
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
    std::fs::write(out, &out_bytes).map_err(|e| e.to_string())?;
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
    std::fs::write(out, &out_bytes).map_err(|e| e.to_string())?;
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
    std::fs::write(out, &out_bytes).map_err(|e| e.to_string())?;
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
    let mut pages = String::new();
    for p in 0..n {
        let svg = hwp_core::render_page_svg(&bytes, p).map_err(|e| e.to_string())?;
        pages.push_str("<div class=\"page\">");
        pages.push_str(&svg);
        pages.push_str("</div>\n");
    }
    let title = file.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let html = format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">\
<title>{title} — tf-hwp</title><style>\
body{{background:#525659;margin:0;padding:24px;display:flex;flex-direction:column;\
align-items:center;gap:24px;font-family:sans-serif}}\
.page{{background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4)}}\
.page svg{{display:block;max-width:100%;height:auto}}\
</style></head><body>{pages}</body></html>"
    );
    std::fs::write(out, html).map_err(|e| e.to_string())?;
    println!("rendered {n} pages → {}", out.display());
    Ok(())
}

#[cfg(not(feature = "rhwp"))]
fn view(_file: &PathBuf, _out: &PathBuf) -> Result<(), String> {
    Err("`view` needs the rhwp bootstrap: build with `--features rhwp`".into())
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
