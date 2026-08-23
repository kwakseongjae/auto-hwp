import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFile(join(root, path), "utf8");

test("workspace override passes an explicit Vite mode while the default stays legacy", async () => {
  const defaultConfig = JSON.parse(await read("crates/hwp-viewer/tauri.conf.json"));
  const workspaceConfig = JSON.parse(await read("crates/hwp-viewer/tauri.workspace.conf.json"));

  assert.equal(defaultConfig.build.devUrl, "http://localhost:1420");
  assert.equal(defaultConfig.build.beforeDevCommand.script, "pnpm dev");
  assert.equal(defaultConfig.build.beforeBuildCommand.script, "pnpm build");
  assert.doesNotMatch(defaultConfig.build.beforeDevCommand.script, /workspace/);
  assert.equal(workspaceConfig.build.devUrl, "http://127.0.0.1:1421");
  assert.equal(
    workspaceConfig.build.beforeDevCommand.script,
    "pnpm exec vite --mode workspace --host 127.0.0.1 --port 1421 --strictPort",
  );
  const workspaceBuild = workspaceConfig.build.beforeBuildCommand.script;
  const editorBuild = workspaceBuild.indexOf("pnpm -C ../../../packages/editor-core build");
  const reactBuild = workspaceBuild.indexOf("pnpm -C ../../../packages/react build");
  const uiBuild = workspaceBuild.indexOf("pnpm exec vite build --mode workspace");
  assert.ok(
    editorBuild >= 0 && reactBuild > editorBuild,
    "clean package builds need editor-core before react",
  );
  assert.ok(uiBuild > reactBuild, "the workspace UI must build after its package dist inputs");

  const viteConfig = await read("crates/hwp-viewer/ui/vite.config.ts");
  assert.match(viteConfig, /defineConfig\(\(\{ mode \}\) =>/);
  assert.match(viteConfig, /mode === "workspace"/);
  assert.match(viteConfig, /__WORKSPACE_SHELL__/);
});

test("one launcher builds current JS dist and starts the three-feature override", async () => {
  const launcherPath = join(root, "scripts/app-workspace.sh");
  const launcher = await read("scripts/app-workspace.sh");
  const launcherStat = await stat(launcherPath);

  assert.ok((launcherStat.mode & 0o111) !== 0, "scripts/app-workspace.sh must be executable");
  const editorBuild = launcher.indexOf('pnpm -C "$root/packages/editor-core" build');
  const reactBuild = launcher.indexOf('pnpm -C "$root/packages/react" build');
  const portCheck = launcher.indexOf('node "$root/scripts/assert-port-free.mjs" 1421 127.0.0.1');
  const cargoDev = launcher.indexOf("exec cargo tauri dev --config tauri.workspace.conf.json");
  assert.ok(editorBuild >= 0 && reactBuild > editorBuild, "editor-core must build before react");
  assert.ok(portCheck > reactBuild, "the port guard must run after the JS dist builds");
  assert.ok(cargoDev > portCheck, "the port guard must run before Tauri starts");
  for (const feature of ["rhwp", "shaper", "pdf"]) assert.match(launcher, new RegExp(`-f ${feature}`));
});

test("occupied workspace port fails before Tauri can attach to a stale server", async (t) => {
  const holder = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      holder.once("error", rejectListen);
      holder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("the local filesystem sandbox forbids TCP listeners");
      return;
    }
    throw error;
  }
  t.after(() => holder.close());

  const address = holder.address();
  assert.ok(address && typeof address === "object");
  const result = await new Promise((resolveChild) => {
    const child = spawn(process.execPath, [join(root, "scripts/assert-port-free.mjs"), String(address.port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolveChild({ code, stderr }));
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /already in use/);
});

test("workspace shell is unmistakable and the original evidence is retained honestly", async () => {
  const shell = await read("crates/hwp-viewer/ui/src/WorkspaceShell.tsx");
  const docs = await read("docs/TAURI-CONVERGENCE.md");
  const ci = await read(".github/workflows/ci.yml");

  assert.match(shell, /data-shell-mode="workspace"/);
  assert.match(shell, />\s*WORKSPACE\s*</);
  assert.match(docs, /scripts\/app-workspace\.sh/);
  assert.match(docs, /2026-08-20-d0-workspace-shell\.png/);
  assert.match(docs, /워크스페이스 셸의 빈 상태/);
  assert.match(ci, /node --test[\s\\]+scripts\/tests\/desktop-shell-mode\.test\.mjs/);

  await access(join(root, "docs/launch/evidence/2026-08-20-d0-workspace-shell.png"));
  await assert.rejects(access(join(root, "docs/launch/evidence/2026-08-20-d0-legacy-shell-mislabeled-as-workspace.png")));
});

test("desktop file-open requests converge on one bounded, private, single-instance route", async () => {
  const cargo = await read("crates/hwp-viewer/Cargo.toml");
  const rust = await read("crates/hwp-viewer/src/lib.rs");
  const intake = await read("crates/hwp-viewer/src/open_request.rs");
  const shell = await read("crates/hwp-viewer/ui/src/WorkspaceShell.tsx");

  assert.match(cargo, /tauri-plugin-single-instance/);
  const singleInstance = rust.indexOf("tauri_plugin_single_instance::init");
  const dialogPlugin = rust.indexOf("tauri_plugin_dialog::init");
  assert.ok(singleInstance >= 0 && singleInstance < dialogPlugin, "single-instance must be first");
  assert.match(rust, /RunEvent::Opened/);
  assert.match(rust, /take_open_requests/);
  assert.doesNotMatch(rust, /with_extension\("hwpx"\)/, "opening must not auto-convert beside source");
  assert.match(intake, /const MAX_PENDING_OPEN_REQUESTS: usize = 8/);
  assert.match(intake, /metadata\.is_file\(\)/);
  assert.match(intake, /url\.scheme\(\) == "file"/);

  assert.match(shell, /listen\("desktop-open-request"/);
  assert.match(shell, /invoke<string\[\]>\("take_open_requests"\)/);
  assert.match(shell, /role="dialog"/);
  assert.match(shell, /sessionStatus\.dirty/);
  assert.match(shell, />취소<\/button>/);
  assert.match(shell, />버리기<\/button>/);
  assert.match(shell, />저장<\/button>/);
  assert.match(shell, /write_recovery_snapshot/);
  assert.match(shell, /window\.clearTimeout\(snapshotTimer\.current\)/, "save must cancel a queued recovery write");
  assert.match(shell, /list_recovery_snapshots/);
  assert.match(shell, /!recoveryScanComplete/, "cold-open must wait for the recovery scan");
  assert.match(shell, /EXTERNAL_SOURCE_CHANGED/);
  assert.doesNotMatch(shell, /window\.confirm\s*\(/);
});

test("desktop home keeps nine path-only recents and restores only safe window geometry", async () => {
  const cargo = await read("crates/hwp-viewer/Cargo.toml");
  const config = await read("crates/hwp-viewer/tauri.conf.json");
  const rust = await read("crates/hwp-viewer/src/lib.rs");
  const recent = await read("crates/hwp-viewer/src/recent_documents.rs");
  const shell = await read("crates/hwp-viewer/ui/src/WorkspaceShell.tsx");

  assert.match(cargo, /tauri-plugin-window-state/);
  assert.match(config, /"visible": false/);
  const singleInstance = rust.indexOf("tauri_plugin_single_instance::init");
  const windowState = rust.indexOf("tauri_plugin_window_state::Builder");
  const dialogPlugin = rust.indexOf("tauri_plugin_dialog::init");
  assert.ok(singleInstance >= 0 && singleInstance < windowState && windowState < dialogPlugin);
  assert.match(rust, /StateFlags::SIZE/);
  assert.match(rust, /StateFlags::POSITION/);
  assert.match(rust, /StateFlags::MAXIMIZED/);
  assert.doesNotMatch(rust, /StateFlags::VISIBLE|StateFlags::FULLSCREEN|StateFlags::DECORATIONS/);
  const setupWindow = rust.indexOf('app.get_webview_window("main")');
  const showWindow = rust.indexOf("window.show()?", setupWindow);
  const closeHandler = rust.indexOf("window.on_window_event", setupWindow);
  assert.ok(
    setupWindow >= 0 && showWindow > setupWindow && closeHandler > showWindow,
    "the initially hidden window must be shown explicitly after plugin restoration",
  );

  assert.match(recent, /const MAX_RECENT_DOCUMENTS: usize = 9/);
  assert.match(recent, /pub\(crate\) path: String/);
  assert.match(recent, /pub\(crate\) last_opened_ms: u64/);
  assert.doesNotMatch(recent, /document_bytes|extracted_text|thumbnail_bytes|ai_context:/i);
  assert.match(rust, /reopen_recent_document/);
  assert.match(rust, /SharedRecentDocuments/);
  assert.ok(
    rust.indexOf("apply_intent(&mut s, Intent::Open") < rust.indexOf("store.record(path)"),
    "a failed parse must never enter the recent-document store",
  );
  assert.match(rust, /validated_open_path/);
  assert.match(rust, /queue_open_paths\(&app, vec!\[path\]\)/);

  assert.match(shell, /list_recent_documents/);
  assert.match(shell, /reopen_recent_document/);
  assert.match(shell, /remove_recent_document/);
  assert.match(shell, /clear_recent_documents/);
  assert.match(shell, /최근 목록에는 로컬 경로와 마지막으로 연 시간만 저장됩니다/);
});

test("desktop print uses the own-PDF replay proof and never webview layout", async () => {
  const rust = await read("crates/hwp-viewer/src/lib.rs");
  const nativePrint = await read("crates/hwp-viewer/src/native_print.rs");
  const shell = await read("crates/hwp-viewer/ui/src/WorkspaceShell.tsx");

  assert.match(rust, /hwp_session::emit_pdf\(doc, None\)/);
  assert.match(rust, /native_print::preflight\(&export\)/);
  assert.match(rust, /run_on_main_thread/);
  assert.match(nativePrint, /printOperationForPrintInfo/);
  assert.match(nativePrint, /NSPrintInfo::sharedPrintInfo\(\)/);
  assert.match(nativePrint, /setShowsPrintPanel\(true\)/);
  assert.match(nativePrint, /kPDFPrintPageScaleNone=0/);
  assert.match(nativePrint, /PRINT_REPLAY_UNBALANCED/);
  assert.match(nativePrint, /PRINT_REPLAY_DEGRADED/);
  assert.match(nativePrint, /PRINT_CAPABILITY_DIAGNOSTIC/);
  assert.doesNotMatch(nativePrint, /temp_dir|NamedTempFile|File::create|write_all/);
  assert.doesNotMatch(shell, /window\.print\s*\(/);
  assert.match(shell, /invoke<NativePrintResult>\("print_doc_pdf"\)/);
  assert.match(shell, /event\.key\.toLowerCase\(\) !== "p"/);
});
