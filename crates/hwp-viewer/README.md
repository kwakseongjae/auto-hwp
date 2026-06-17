# hwp-viewer — Tauri 2 viewer shell (A2) + embedded live-control server (A3)

A native desktop shell that opens an HWPX, renders pages faithfully (rhwp → SVG), and runs AI
content through the op-bus. It also embeds a loopback control server so an external agent can drive
the *running* editor (A3).

## Run the window (your machine)
The CLI build verifies headlessly, but launching the window needs the Tauri dev runner:

```bash
# rhwp render is a DEFAULT feature now — plain run just works:
cargo run -p hwp-viewer

#   …or, for proper macOS app activation (Dock icon, focus), the dev runner:
cargo install tauri-cli            # one-time
cargo tauri dev                    # from crates/hwp-viewer
```

Open an `.hwpx`, scroll the rendered pages, toggle the **AI 패널**, paste a template-conformant
content JSON (see `hwp_ai::content::template_brief`), then **적용 (op-bus)** → **내보내기 (.hwpx)**.

## Drive the live editor from a terminal/agent (A3)
On launch the shell prints a line like:

```
tf-hwp control server: http://127.0.0.1:54321/mcp — credentials at /…/tf-hwp-viewer-54321.cred
```

The cred file (mode `0600`) holds `port` then `token`. Register it with a coding agent:

```bash
TOK=$(sed -n 2p /…/tf-hwp-viewer-54321.cred)
claude mcp add --transport http tf-hwp-live http://127.0.0.1:54321/mcp \
  --header "Authorization: Bearer $TOK"
```

The agent can then call `open_document` / `get_context` / `apply_content` / `export_hwpx`; each
mutating call emits `doc-changed` so the window can repaint.

## Headless equivalent (no GUI)
The same control server runs standalone for CI/scripts:

```bash
hwp-mcp --http --port 38217      # writes a 0600 cred file; serves POST /mcp
hwp-mcp                          # stdio transport (claude mcp add --transport stdio)
```

Security (enforced by the server, fail-closed): loopback-only bind, Host + Origin allowlist,
per-launch bearer token (constant-time compare; a missing token is rejected too).
