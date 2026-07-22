//! A3 — embedded loopback control server (Topology A): a terminal/agent drives THIS running editor.
//!
//! Reuses the transport-free [`hwp_mcp::server`] core. On a background thread we bind a loopback
//! port, mint a per-launch token (0600 cred file), and serve JSON-RPC that mutates the shell's
//! managed op-bus `Session`; after each call we `emit("doc-changed")` so the webview can repaint.
//! Tauri's own IPC is webview-scoped and unreachable externally — hence our own server.

use std::net::TcpListener;
use tauri::{AppHandle, Emitter, Manager};

/// Start the control server for this app instance (best-effort; logs and returns on bind failure).
pub fn spawn(app: AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("auto-hwp control server: bind failed ({e}); live control disabled");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = hwp_mcp::server::gen_token();
    let cred = write_cred(port, &token);
    // The agent reads {port,token} from the 0600 file — never from argv/env/log.
    eprintln!("auto-hwp control server: http://127.0.0.1:{port}/mcp — credentials at {cred}");

    std::thread::spawn(move || {
        hwp_mcp::server::serve(listener, token, move |req| {
            let resp = {
                let state = app.state::<crate::SharedSession>();
                let mut sess = state.lock().expect("session poisoned");
                hwp_mcp::handle(req, &mut sess)
            };
            // Tell the webview the live document may have changed (repaint hook).
            let _ = app.emit("doc-changed", ());
            resp
        });
    });
}

/// Write `{port}\n{token}\n` to a per-launch 0600 cred file; return its path.
fn write_cred(port: u16, token: &str) -> String {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = std::env::temp_dir().join(format!("auto-hwp-viewer-{port}.cred"));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
    {
        let _ = write!(f, "{port}\n{token}\n");
    }
    path.to_string_lossy().into_owned()
}
