//! **Network (opt-in) service mode** — issue 013. A SEPARATE surface from the loopback control
//! server ([`crate::server`]): the loopback mode's code, behavior, and tests are unchanged. The
//! security posture here is fail-closed and stricter, because the server is now reachable by
//! non-loopback clients (behind a private network / reverse proxy — NEVER the public internet, and
//! we do NOT terminate TLS here; that is the proxy's job, see docs/SERVICE-DEPLOY.md):
//!
//!   * **token** — `HWP_MCP_TOKEN` env is REQUIRED. No env ⇒ the server refuses to start (there is
//!     no per-launch cred-file fallback in network mode; a missing secret must never mean "open").
//!   * **path confinement** — `HWP_WORKSPACE_ROOT` env is REQUIRED and canonicalized; every
//!     `open_document`/`export_*` path is canonicalized and must stay inside it (a symlink that
//!     points out of the tree is resolved BEFORE the check, so it cannot escape).
//!   * **reopen guard** — opening a second document while one is open needs `force: true`, so an
//!     agent bug cannot silently swap the working document mid-task ("1 container = 1 task").
//!   * **Origin** — enforced in [`crate::server::process_request_network`] (any Origin ⇒ 403).
//!
//! The reusable, socket-free pieces ([`NetworkConfig::from_getter`], [`confine_path`],
//! [`guarded_dispatch`]) are unit-tested; [`run`] only wires them to a real `TcpListener`.

use crate::Session;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Default bind address when `BIND_ADDR` is unset. `0.0.0.0` is deliberate for a container (its
/// network namespace is the isolation boundary); the deploy doc mandates a private net / reverse
/// proxy in front — direct public exposure is unsupported.
const DEFAULT_BIND: &str = "0.0.0.0:8752";

/// Fail-closed configuration for `--http-network`, parsed from the environment. Constructing this
/// successfully is itself a security gate: no token or no workspace root ⇒ [`from_getter`] errors
/// and the server never binds.
pub struct NetworkConfig {
    /// `BIND_ADDR` (default `0.0.0.0:8752`).
    pub bind_addr: String,
    /// `HWP_MCP_TOKEN` — the bearer secret (required; never logged).
    pub token: String,
    /// `HWP_WORKSPACE_ROOT`, canonicalized — every doc path must resolve inside this.
    pub workspace_root: PathBuf,
    /// `ALLOWED_HOSTS` (comma-separated; empty = skip the Host check, per docs behind a private net).
    pub allowed_hosts: Vec<String>,
}

// A manual `Debug` that REDACTS the token — the "로그에 토큰/키 절대 금지" discipline holds even if a
// config is ever `{:?}`-printed (e.g. an unwrap on the other arm). Never derive Debug here.
impl std::fmt::Debug for NetworkConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkConfig")
            .field("bind_addr", &self.bind_addr)
            .field("token", &"<redacted>")
            .field("workspace_root", &self.workspace_root)
            .field("allowed_hosts", &self.allowed_hosts)
            .finish()
    }
}

impl NetworkConfig {
    /// Parse from the real process environment (fail-closed). See [`from_getter`] for the rules.
    pub fn from_env() -> Result<Self, String> {
        Self::from_getter(|k| std::env::var(k).ok())
    }

    /// Parse from an injectable env getter (so tests never mutate the process environment).
    /// Fail-closed: a missing/empty `HWP_MCP_TOKEN` or `HWP_WORKSPACE_ROOT` is a hard error.
    pub fn from_getter(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let token = get("HWP_MCP_TOKEN").filter(|t| !t.is_empty()).ok_or(
            "network mode refused to start: HWP_MCP_TOKEN env is required (fail-closed — a missing \
             token must never mean an open server).",
        )?;
        let root_raw = get("HWP_WORKSPACE_ROOT").filter(|t| !t.is_empty()).ok_or(
            "network mode refused to start: HWP_WORKSPACE_ROOT env is required (all document paths \
             are confined under it).",
        )?;
        // Canonicalize the root ONCE so containment checks compare real (symlink-resolved) paths.
        let workspace_root = std::fs::canonicalize(&root_raw)
            .map_err(|e| format!("HWP_WORKSPACE_ROOT {root_raw:?} is not an accessible directory: {e}"))?;
        let bind_addr = get("BIND_ADDR").filter(|t| !t.is_empty()).unwrap_or_else(|| DEFAULT_BIND.into());
        let allowed_hosts = get("ALLOWED_HOSTS")
            .map(|s| s.split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect())
            .unwrap_or_default();
        Ok(Self { bind_addr, token, workspace_root, allowed_hosts })
    }
}

/// Resolve `requested` against the workspace `root` and refuse anything that lands outside it.
///
/// `must_exist` distinguishes an INPUT (`open_document`: the file must exist, so canonicalize the
/// WHOLE path — a symlink is resolved to its real target before the containment test, blocking a
/// symlink escape) from an OUTPUT (`export_*`: the file may not exist yet, so canonicalize the
/// PARENT directory and rejoin the file name — the parent's canonicalization still resolves a
/// symlinked directory out of the tree). `root` is already canonical, so [`Path::starts_with`]
/// (component-wise) is a sound containment predicate (`/work` never matches `/work2`).
pub fn confine_path(root: &Path, requested: &str, must_exist: bool) -> Result<PathBuf, String> {
    let req = Path::new(requested);
    let resolved = if must_exist {
        std::fs::canonicalize(req).map_err(|e| format!("cannot open {requested:?}: {e}"))?
    } else {
        let parent = req.parent().filter(|p| !p.as_os_str().is_empty());
        let dir = match parent {
            Some(p) => std::fs::canonicalize(p)
                .map_err(|e| format!("output directory for {requested:?} is not accessible: {e}"))?,
            None => root.to_path_buf(), // a bare filename lands directly in the root
        };
        let file = req
            .file_name()
            .ok_or_else(|| format!("invalid output path {requested:?} (no file name)"))?;
        dir.join(file)
    };
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(format!(
            "path {requested:?} is outside the workspace root {} — refused",
            root.display()
        ))
    }
}

/// A JSON-RPC tool-error RESULT (isError) mirroring [`crate::handle`]'s own error shape, so a guard
/// rejection reaches the agent as a normal, recoverable tool failure (not a transport error).
fn tool_error(req: &Value, message: &str) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "content": [{ "type": "text", "text": message }], "isError": true }
    })
}

/// Extract `(tool_name, arguments)` from a `tools/call` request, or `None` for any other message.
fn tool_call(req: &Value) -> Option<(&str, &Value)> {
    if req.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    let params = req.get("params")?;
    let name = params.get("name")?.as_str()?;
    let args = params.get("arguments").unwrap_or(&Value::Null);
    Some((name, args))
}

/// Wrap [`crate::handle`] with the network-mode app-level guards (reopen-force + workspace path
/// confinement). Everything else passes straight through to the shared dispatch, so the tool
/// semantics are identical to loopback/stdio — only open/export paths are policed. On a guard
/// rejection it returns a tool-error result carrying an actionable message; otherwise it rewrites
/// the path argument to the confined, canonical path (closing a symlink-swap TOCTOU) and dispatches.
pub fn guarded_dispatch(root: &Path, req: &Value, session: &mut Session) -> Option<Value> {
    let Some((name, args)) = tool_call(req) else {
        return crate::handle(req, session);
    };

    // Reopen guard: refuse a second open unless force:true (silent cross-contamination is worse than
    // an explicit error — "1 container = 1 task").
    if name == "open_document" && session.doc.is_some() {
        let forced = args.get("force").and_then(Value::as_bool).unwrap_or(false);
        if !forced {
            return Some(tool_error(
                req,
                "a document is already open — pass \"force\": true to replace it (guards against \
                 silently swapping the working document mid-task).",
            ));
        }
    }

    // Path confinement on the paths the tools touch. open = input (must exist); export = output.
    let confine = match name {
        "open_document" => Some(true),
        "export_hwpx" | "export_pdf" => Some(false),
        _ => None,
    };
    if let Some(must_exist) = confine {
        if let Some(requested) = args.get("path").and_then(Value::as_str) {
            match confine_path(root, requested, must_exist) {
                Ok(resolved) => {
                    // Rewrite the request so `handle` operates on exactly the validated path.
                    let mut rewritten = req.clone();
                    if let Some(p) = rewritten
                        .get_mut("params")
                        .and_then(|p| p.get_mut("arguments"))
                        .and_then(|a| a.get_mut("path"))
                    {
                        *p = Value::String(resolved.to_string_lossy().into_owned());
                    }
                    return crate::handle(&rewritten, session);
                }
                Err(msg) => return Some(tool_error(req, &msg)),
            }
        }
    }

    crate::handle(req, session)
}

/// Bind and serve the network service forever (sequential accept; "1 container = 1 task"). Logs the
/// bound address, workspace root, and Host policy to stderr — but NEVER the token (same discipline
/// as the loopback cred file). Panics only on an un-bindable address (a fatal startup error).
pub fn run(cfg: NetworkConfig) {
    let listener = std::net::TcpListener::bind(&cfg.bind_addr)
        .unwrap_or_else(|e| panic!("network mode: cannot bind {}: {e}", cfg.bind_addr));
    let bound = listener.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| cfg.bind_addr.clone());
    eprintln!(
        "hwp-mcp http-network: bound {bound} — workspace {} — Host policy: {}",
        cfg.workspace_root.display(),
        if cfg.allowed_hosts.is_empty() {
            "ALLOWED_HOSTS unset (require a private net / reverse proxy)".to_string()
        } else {
            format!("ALLOWED_HOSTS={:?}", cfg.allowed_hosts)
        }
    );
    let session = Mutex::new(Session::default());
    let root = cfg.workspace_root.clone();
    crate::server::serve_network(listener, cfg.token, cfg.allowed_hosts, move |req| {
        let mut sess = session.lock().expect("session");
        guarded_dispatch(&root, req, &mut sess)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_env(_k: &str) -> Option<String> {
        None
    }

    // ① fail-closed: network mode + no token → refuse to start.
    #[test]
    fn missing_token_refuses_startup() {
        let err = NetworkConfig::from_getter(empty_env).unwrap_err();
        assert!(err.contains("HWP_MCP_TOKEN"), "missing token must be named: {err}");
    }

    #[test]
    fn missing_workspace_root_refuses_startup() {
        let err = NetworkConfig::from_getter(|k| (k == "HWP_MCP_TOKEN").then(|| "secret".to_string()))
            .unwrap_err();
        assert!(err.contains("HWP_WORKSPACE_ROOT"), "missing root must be named: {err}");
    }

    #[test]
    fn full_env_parses_with_defaults() {
        let dir = std::env::temp_dir();
        let cfg = NetworkConfig::from_getter(|k| match k {
            "HWP_MCP_TOKEN" => Some("secret".into()),
            "HWP_WORKSPACE_ROOT" => Some(dir.to_string_lossy().into_owned()),
            _ => None,
        })
        .unwrap();
        assert_eq!(cfg.bind_addr, DEFAULT_BIND);
        assert!(cfg.allowed_hosts.is_empty());
        // canonicalize resolves /tmp → /private/tmp on macOS; just assert it is absolute + a prefix.
        assert!(cfg.workspace_root.is_absolute());
    }

    #[test]
    fn allowed_hosts_and_bind_override() {
        let dir = std::env::temp_dir();
        let cfg = NetworkConfig::from_getter(|k| match k {
            "HWP_MCP_TOKEN" => Some("secret".into()),
            "HWP_WORKSPACE_ROOT" => Some(dir.to_string_lossy().into_owned()),
            "BIND_ADDR" => Some("127.0.0.1:9000".into()),
            "ALLOWED_HOSTS" => Some("svc.internal, hwp.svc".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(cfg.bind_addr, "127.0.0.1:9000");
        assert_eq!(cfg.allowed_hosts, vec!["svc.internal".to_string(), "hwp.svc".to_string()]);
    }

    // ③ path confinement (incl. symlink escape).
    fn tmp_root() -> PathBuf {
        let base = std::env::temp_dir().join(format!("hwpmcp_confine_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        std::fs::canonicalize(&base).unwrap()
    }

    #[test]
    fn confine_accepts_inside_and_rejects_outside() {
        let root = tmp_root();
        let inside = root.join("doc.hwpx");
        std::fs::write(&inside, b"x").unwrap();
        assert!(confine_path(&root, inside.to_str().unwrap(), true).is_ok());
        // An output path (need not exist) inside root is fine.
        assert!(confine_path(&root, root.join("out.pdf").to_str().unwrap(), false).is_ok());
        // Absolute path outside root is refused.
        assert!(confine_path(&root, "/etc/hosts", true).is_err());
        // Output whose parent is outside root is refused.
        assert!(confine_path(&root, "/etc/evil.pdf", false).is_err());
        let _ = std::fs::remove_file(&inside);
    }

    #[test]
    fn confine_blocks_symlink_escape() {
        let root = tmp_root();
        let link = root.join("escape");
        let _ = std::fs::remove_file(&link);
        // A symlink INSIDE the root pointing OUT of it must not smuggle an outside target in.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", &link).unwrap();
            let res = confine_path(&root, link.to_str().unwrap(), true);
            assert!(res.is_err(), "symlink escaping the root must be refused: {res:?}");
            let _ = std::fs::remove_file(&link);
        }
    }

    // ④ reopen guard: open twice without force → tool error; with force → ok.
    fn showcase_bytes() -> &'static [u8] {
        include_bytes!("../../../corpus/hwpx/FormattingShowcase.hwpx")
    }

    fn call(name: &str, args: Value, root: &Path, s: &mut Session) -> Value {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        guarded_dispatch(root, &req, s).unwrap()
    }

    #[test]
    fn reopen_requires_force_and_confines_path() {
        let root = tmp_root();
        let doc = root.join("show.hwpx");
        std::fs::write(&doc, showcase_bytes()).unwrap();
        let p = doc.to_str().unwrap().to_string();
        let mut s = Session::default();

        // first open: ok
        let r = call("open_document", json!({ "path": p }), &root, &mut s);
        assert_eq!(r["result"]["isError"], false, "first open: {r}");
        // second open WITHOUT force: tool error, doc unchanged
        let r = call("open_document", json!({ "path": p }), &root, &mut s);
        assert_eq!(r["result"]["isError"], true, "reopen without force must error: {r}");
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("force"));
        // second open WITH force: ok
        let r = call("open_document", json!({ "path": p, "force": true }), &root, &mut s);
        assert_eq!(r["result"]["isError"], false, "forced reopen: {r}");
        // opening a path OUTSIDE the root: tool error (confinement)
        let r = call("open_document", json!({ "path": "/etc/hosts", "force": true }), &root, &mut s);
        assert_eq!(r["result"]["isError"], true, "outside-root open must error: {r}");
        let _ = std::fs::remove_file(&doc);
    }
}
