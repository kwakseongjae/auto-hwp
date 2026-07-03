//! `hwp-mcp` — headless MCP server for tf-hwp. Three transports:
//!   * default (stdio): newline-delimited JSON-RPC on stdin/stdout, for `claude mcp add --transport stdio`.
//!   * `--http [--port N]`: loopback HTTP control server (A3) — writes a 0600 `{port}\n{token}\n`
//!     file (path printed to stderr) and serves `POST /mcp`; for `claude mcp add --transport http`.
//!   * `--http-network`: opt-in SERVICE mode (issue 013) — fail-closed env config (`HWP_MCP_TOKEN`,
//!     `HWP_WORKSPACE_ROOT`), workspace path confinement, reopen-force guard, Origin-always-403.
//!     For a container behind a private net / reverse proxy — NEVER the public internet, NO TLS here.

use hwp_mcp::{handle, network, server, Session};
use std::io::{BufRead, Write};
use std::sync::Mutex;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `--http-network` is a distinct, opt-in mode; it must NOT fall through to the loopback `--http`
    // path, so it is matched first. The loopback mode is otherwise byte-for-byte unchanged.
    if args.iter().any(|a| a == "--http-network") {
        run_http_network();
    } else if args.iter().any(|a| a == "--http") {
        run_http(&args);
    } else {
        run_stdio();
    }
}

/// Network SERVICE mode (issue 013): parse the fail-closed env config, then serve. A missing token
/// or workspace root aborts BEFORE binding — a misconfigured service must not come up "open".
fn run_http_network() {
    match network::NetworkConfig::from_env() {
        Ok(cfg) => network::run(cfg),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    }
}

/// stdio transport: one JSON response line per request.
fn run_stdio() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut session = Session::default();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}})
                );
                let _ = out.flush();
                continue;
            }
        };
        if let Some(resp) = handle(&req, &mut session) {
            if writeln!(out, "{resp}").is_err() {
                break;
            }
            let _ = out.flush();
        }
    }
}

/// HTTP control transport (A3): loopback bind + per-launch token in a 0600 file.
fn run_http(args: &[String]) {
    let port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("bind loopback");
    let bound = listener.local_addr().expect("addr").port();
    let token = server::gen_token();
    let path = write_token_file(bound, &token);
    // The agent reads {port,token} from THIS file — never from argv/env/stdout/log.
    eprintln!("hwp-mcp http: 127.0.0.1:{bound} — credentials at {path}");

    let session = Mutex::new(Session::default());
    server::serve(listener, token, move |req| {
        handle(req, &mut session.lock().expect("session"))
    });
}

/// Write `{port}\n{token}\n` to a per-launch 0600 file; return its path.
fn write_token_file(port: u16, token: &str) -> String {
    use std::os::unix::fs::OpenOptionsExt;
    let path = std::env::temp_dir().join(format!("hwp-mcp-{port}.cred"));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .expect("create cred file");
    let _ = write!(f, "{port}\n{token}\n");
    path.to_string_lossy().into_owned()
}
