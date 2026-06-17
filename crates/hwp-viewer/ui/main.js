// No-build frontend: uses the global Tauri API (app.withGlobalTauri = true). All __TAURI__
// access is deferred to `load` to avoid the documented top-level injection race.
window.addEventListener("load", () => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const dialogOpen = T.dialog.open;
  const $ = (id) => document.getElementById(id);
  const status = (t) => ($("status").textContent = t);
  const log = (t) => ($("log").textContent = t);

  let currentPath = null;

  // Render the LIVE document: ask for the current page count, then paint each page's SVG.
  async function renderAll() {
    const pages = $("pages");
    try {
      const count = await invoke("doc_page_count");
      pages.innerHTML = "";
      for (let p = 0; p < count; p++) {
        const svg = await invoke("render_page", { page: p });
        const div = document.createElement("div");
        div.className = "page";
        div.innerHTML = svg;
        pages.appendChild(div);
      }
      if (count === 0) status("열림 (렌더는 --features rhwp 빌드 필요).");
    } catch (e) {
      status(`렌더 실패: ${e}`);
    }
  }

  $("open").addEventListener("click", async () => {
    const sel = await dialogOpen({
      filters: [{ name: "한글 문서 (HWP/HWPX)", extensions: ["hwp", "hwpx"] }],
      multiple: false,
    });
    // single-select returns a string (or {path} / null) depending on version — handle defensively.
    const path = typeof sel === "string" ? sel : sel && sel.path ? sel.path : null;
    if (!path) return;
    currentPath = path;
    try {
      const n = await invoke("open_doc", { path });
      status(`${path.split("/").pop()} — ${n} page(s)`);
      await renderAll();
    } catch (e) {
      status(`열기 실패: ${e}`);
    }
  });

  $("toggle-ai").addEventListener("click", () => $("ai").classList.toggle("hidden"));

  $("apply").addEventListener("click", async () => {
    try {
      const msg = await invoke("apply_content", { content: $("content").value });
      log(`적용: ${msg}`);
      await renderAll(); // show the edit live
    } catch (e) {
      log(`적용 실패: ${e}`);
    }
  });

  $("export").addEventListener("click", async () => {
    const out = currentPath ? currentPath.replace(/\.hwpx$/i, ".edited.hwpx") : "out.hwpx";
    try {
      const msg = await invoke("export_hwpx", { path: out });
      log(`내보내기: ${msg}`);
    } catch (e) {
      log(`내보내기 실패: ${e}`);
    }
  });

  // Repaint when the embedded control server (A3) mutates the live document.
  if (T.event && T.event.listen) {
    T.event.listen("doc-changed", async () => {
      status("외부 에이전트가 문서를 수정함 — 다시 렌더링.");
      await renderAll();
    });
  }
});
