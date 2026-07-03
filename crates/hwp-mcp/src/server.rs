//! A3 — **loopback HTTP control server** (pure `std::net`, no axum/rmcp).
//!
//! Lets an external terminal/agent drive a *running* tf-hwp instance over HTTP JSON-RPC, reusing
//! [`crate::handle`] (the same op-bus dispatch as stdio). Minimal HTTP/1.1: `POST /mcp` with a
//! JSON-RPC body. The Tauri shell embeds this on a background thread; standalone it runs via
//! `hwp-mcp --http`.
//!
//! SECURITY (non-negotiable, fail-closed): bind 127.0.0.1 only; validate **Host** AND **Origin**
//! (DNS-rebinding — loopback ports are reachable by malicious web pages); require a per-launch
//! bearer token compared in **constant time**; reject a MISSING token, not just a wrong one.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use subtle::ConstantTimeEq;

/// Host header allowlist (strip the port): only loopback names.
pub fn host_ok(host: &str) -> bool {
    let h = host.rsplit_once(':').map(|(a, _)| a).unwrap_or(host);
    let h = h.trim_start_matches('[').trim_end_matches(']');
    matches!(h, "localhost" | "127.0.0.1" | "::1")
}

/// Origin allowlist. None ⇒ ok (CLI agents send no Origin). `null` ⇒ reject (opaque/sandboxed).
/// Otherwise only `http(s)://<loopback>[:port]`.
pub fn origin_ok(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true };
    if o == "null" {
        return false;
    }
    let rest = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://"));
    match rest {
        Some(r) => host_ok(r),
        None => false,
    }
}

/// Constant-time bearer token comparison (subtle returns `Choice`, never use `==`).
pub fn token_ok(provided: &[u8], expected: &[u8]) -> bool {
    provided.ct_eq(expected).into()
}

/// A 32-byte CSPRNG token as lowercase hex (per-launch; written to a 0600 file, never logged).
pub fn gen_token() -> String {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).expect("CSPRNG");
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build a raw HTTP/1.1 response.
fn http(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

/// Header lookup (case-insensitive name), from already-split header lines "Name: value".
fn header<'a>(lines: &'a [&'a str], name: &str) -> Option<&'a str> {
    lines.iter().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Process one raw HTTP request → raw HTTP response, enforcing the security order before dispatch.
/// `dispatch` runs the JSON-RPC message (reuses `crate::handle` behind the caller's session).
pub fn process_request(raw: &[u8], token: &str, dispatch: &dyn Fn(&Value) -> Option<Value>) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return http("400 Bad Request", "text/plain", b"malformed request");
    };
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let header_lines: Vec<&str> = lines.collect();
    let mut rl = request_line.split_whitespace();
    let method = rl.next().unwrap_or("");
    let path = rl.next().unwrap_or("");

    // (0) POST /mcp only.
    if path != "/mcp" {
        return http("404 Not Found", "text/plain", b"not found");
    }
    if method != "POST" {
        return http("405 Method Not Allowed", "text/plain", b"POST /mcp only");
    }
    // (1) Host allowlist.
    if !header(&header_lines, "host").map(host_ok).unwrap_or(false) {
        return http("403 Forbidden", "text/plain", b"bad host");
    }
    // (2) Origin allowlist (None ok; null/non-loopback rejected).
    if !origin_ok(header(&header_lines, "origin")) {
        return http("403 Forbidden", "text/plain", b"bad origin");
    }
    // (3) Bearer token present AND constant-time-equal (missing ⇒ 401).
    let bearer = header(&header_lines, "authorization").and_then(|a| a.strip_prefix("Bearer "));
    if !bearer.map(|b| token_ok(b.as_bytes(), token.as_bytes())).unwrap_or(false) {
        return http("401 Unauthorized", "text/plain", b"missing or invalid token");
    }
    // (4) parse JSON-RPC + dispatch.
    let Ok(req) = serde_json::from_str::<Value>(body.trim()) else {
        return http("400 Bad Request", "application/json", br#"{"error":"parse error"}"#);
    };
    match dispatch(&req) {
        Some(resp) => http("200 OK", "application/json", resp.to_string().as_bytes()),
        None => http("202 Accepted", "application/json", b""), // notification, no id
    }
}

fn handle_conn(mut stream: TcpStream, token: &str, dispatch: &dyn Fn(&Value) -> Option<Value>) {
    // Read until end of headers, then the declared Content-Length body. Bounded to 1 MiB.
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let headers_done = buf.windows(4).any(|w| w == b"\r\n\r\n");
        if headers_done {
            let head_len = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            let text = String::from_utf8_lossy(&buf[..head_len]);
            let clen = text
                .lines()
                .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("content-length")))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= head_len + clen {
                break;
            }
        }
        if buf.len() > 1 << 20 {
            let _ = stream.write_all(&http("413 Payload Too Large", "text/plain", b"too large"));
            return;
        }
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        }
    }
    let resp = process_request(&buf, token, dispatch);
    let _ = stream.write_all(&resp);
    let _ = stream.flush();
}

/// Serve the loopback control server forever (sequential accept; agents call one at a time).
/// `dispatch` reuses [`crate::handle`] over the caller's session. Panic-isolated per connection.
pub fn serve(listener: TcpListener, token: String, dispatch: impl Fn(&Value) -> Option<Value>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_conn(stream, &token, &dispatch)
        }));
        if r.is_err() {
            // a panicked connection must not kill the accept loop.
            continue;
        }
    }
}

// ---------------------------------------------------------------------------
// NETWORK (opt-in) mode — issue 013. A SEPARATE request path from the loopback one above; the
// loopback `process_request`/`serve`/`host_ok`/`origin_ok` are byte-for-byte unchanged.
//
// The threat model differs from loopback: the server sits behind a private network / reverse proxy,
// reachable by non-loopback clients, so the loopback Host/Origin allowlist no longer fits:
//   * Host   — allowlisted against `ALLOWED_HOSTS` (empty = skip; the deploy doc mandates a private
//              net / reverse proxy in that case). A configured list is still enforced verbatim.
//   * Origin — a browser has NO business calling this API; any `Origin` header at all ⇒ 403 (CSRF
//              origin block). This is STRICTER than loopback's allowlist, never looser.
//   * token  — the same constant-time [`token_ok`]; a MISSING token is still a 401.
// ---------------------------------------------------------------------------

/// Network-mode Host check: allow when the allowlist is empty (deploy doc requires private-net /
/// reverse-proxy fronting in that case), otherwise the host (port stripped) must be in `allowed`.
pub fn network_host_ok(host: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let h = host.rsplit_once(':').map(|(a, _)| a).unwrap_or(host);
    let h = h.trim_start_matches('[').trim_end_matches(']');
    allowed.iter().any(|a| a.eq_ignore_ascii_case(h))
}

/// Process one raw HTTP request in NETWORK mode. Same shape as [`process_request`], but with the
/// stricter header policy above (Origin present ⇒ 403; Host via `ALLOWED_HOSTS`). `dispatch` is the
/// caller's guarded closure — it enforces workspace path confinement + the reopen-force guard before
/// reaching [`crate::handle`], so those app-level rules live entirely on this network path.
pub fn process_request_network(
    raw: &[u8],
    token: &str,
    allowed_hosts: &[String],
    dispatch: &dyn Fn(&Value) -> Option<Value>,
) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return http("400 Bad Request", "text/plain", b"malformed request");
    };
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let header_lines: Vec<&str> = lines.collect();
    let mut rl = request_line.split_whitespace();
    let method = rl.next().unwrap_or("");
    let path = rl.next().unwrap_or("");

    // (0) POST /mcp only.
    if path != "/mcp" {
        return http("404 Not Found", "text/plain", b"not found");
    }
    if method != "POST" {
        return http("405 Method Not Allowed", "text/plain", b"POST /mcp only");
    }
    // (1) Host allowlist (ALLOWED_HOSTS; empty ⇒ skip — private-net/reverse-proxy fronting per docs).
    if !header(&header_lines, "host").map(|h| network_host_ok(h, allowed_hosts)).unwrap_or(true) {
        return http("403 Forbidden", "text/plain", b"bad host");
    }
    // (2) Origin: a network API is not a browser endpoint — ANY Origin header ⇒ 403 (CSRF block).
    if header(&header_lines, "origin").is_some() {
        return http("403 Forbidden", "text/plain", b"origin not allowed");
    }
    // (3) Bearer token present AND constant-time-equal (missing ⇒ 401).
    let bearer = header(&header_lines, "authorization").and_then(|a| a.strip_prefix("Bearer "));
    if !bearer.map(|b| token_ok(b.as_bytes(), token.as_bytes())).unwrap_or(false) {
        return http("401 Unauthorized", "text/plain", b"missing or invalid token");
    }
    // (4) parse JSON-RPC + dispatch (the guarded closure adds path confinement + reopen guard).
    let Ok(req) = serde_json::from_str::<Value>(body.trim()) else {
        return http("400 Bad Request", "application/json", br#"{"error":"parse error"}"#);
    };
    match dispatch(&req) {
        Some(resp) => http("200 OK", "application/json", resp.to_string().as_bytes()),
        None => http("202 Accepted", "application/json", b""),
    }
}

fn handle_conn_network(
    mut stream: TcpStream,
    token: &str,
    allowed_hosts: &[String],
    dispatch: &dyn Fn(&Value) -> Option<Value>,
) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let headers_done = buf.windows(4).any(|w| w == b"\r\n\r\n");
        if headers_done {
            let head_len = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            let text = String::from_utf8_lossy(&buf[..head_len]);
            let clen = text
                .lines()
                .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("content-length")))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= head_len + clen {
                break;
            }
        }
        if buf.len() > 1 << 20 {
            let _ = stream.write_all(&http("413 Payload Too Large", "text/plain", b"too large"));
            return;
        }
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        }
    }
    let resp = process_request_network(&buf, token, allowed_hosts, dispatch);
    let _ = stream.write_all(&resp);
    let _ = stream.flush();
}

/// Serve the NETWORK control server forever. Same sequential-accept, panic-isolated shape as
/// [`serve`] (v1 keeps single-flight — "1 container = 1 task"; a thread pool would reopen R2), but on
/// the stricter [`process_request_network`] path.
pub fn serve_network(
    listener: TcpListener,
    token: String,
    allowed_hosts: Vec<String>,
    dispatch: impl Fn(&Value) -> Option<Value>,
) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_conn_network(stream, &token, &allowed_hosts, &dispatch)
        }));
        if r.is_err() {
            continue;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Session;
    use std::sync::Mutex;

    #[test]
    fn security_predicates() {
        assert!(host_ok("127.0.0.1:5000") && host_ok("localhost") && host_ok("[::1]:80"));
        assert!(!host_ok("evil.com") && !host_ok("10.0.0.5"));
        assert!(origin_ok(None) && origin_ok(Some("http://127.0.0.1:5000")) && origin_ok(Some("http://localhost")));
        assert!(!origin_ok(Some("null")) && !origin_ok(Some("http://evil.com")));
        assert!(token_ok(b"abc", b"abc") && !token_ok(b"abc", b"abd") && !token_ok(b"", b"abc"));
    }

    fn req(extra_headers: &str, body: &str) -> Vec<u8> {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn dispatch(sess: &Mutex<Session>) -> impl Fn(&Value) -> Option<Value> + '_ {
        move |req: &Value| crate::handle(req, &mut sess.lock().unwrap())
    }

    #[test]
    fn rejects_missing_and_wrong_token() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let no_tok = String::from_utf8_lossy(&process_request(&req("", body), "secret", &d)).into_owned();
        assert!(no_tok.starts_with("HTTP/1.1 401"), "missing token → 401");
        let wrong = String::from_utf8_lossy(&process_request(
            &req("Authorization: Bearer nope\r\n", body), "secret", &d)).into_owned();
        assert!(wrong.starts_with("HTTP/1.1 401"), "wrong token → 401");
    }

    #[test]
    fn rejects_bad_origin_and_method() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let bad_origin = String::from_utf8_lossy(&process_request(
            &req("Authorization: Bearer t\r\nOrigin: http://evil.com\r\n", body), "t", &d)).into_owned();
        assert!(bad_origin.starts_with("HTTP/1.1 403"), "evil origin → 403");
        let get = String::from_utf8_lossy(&process_request(
            b"GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n", "t", &d)).into_owned();
        assert!(get.starts_with("HTTP/1.1 405"), "GET → 405");
    }

    #[test]
    fn authorized_tools_list_dispatches() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let resp = String::from_utf8_lossy(&process_request(
            &req("Authorization: Bearer t\r\n", body), "t", &d)).into_owned();
        assert!(resp.starts_with("HTTP/1.1 200"), "authorized → 200");
        assert!(resp.contains("open_document") && resp.contains("apply_content"), "tools dispatched");
    }

    // ---- Network (opt-in) mode header policy — issue 013 ----

    #[test]
    fn network_host_allowlist() {
        assert!(network_host_ok("anything", &[]), "empty allowlist ⇒ skip (private-net contract)");
        let allow = vec!["svc.internal".to_string()];
        assert!(network_host_ok("svc.internal", &allow) && network_host_ok("svc.internal:8752", &allow));
        assert!(!network_host_ok("evil.com", &allow));
    }

    #[test]
    fn network_origin_present_is_always_403() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        // Even a "loopback" Origin is rejected in network mode — a network API is not a browser API.
        let with_origin = String::from_utf8_lossy(&process_request_network(
            &req("Authorization: Bearer t\r\nOrigin: http://127.0.0.1\r\n", body), "t", &[], &d)).into_owned();
        assert!(with_origin.starts_with("HTTP/1.1 403"), "any Origin → 403: {}", &with_origin[..20]);
    }

    #[test]
    fn network_missing_token_is_401_and_authorized_dispatches() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let no_tok = String::from_utf8_lossy(&process_request_network(
            &req("", body), "secret", &[], &d)).into_owned();
        assert!(no_tok.starts_with("HTTP/1.1 401"), "missing token → 401");
        let ok = String::from_utf8_lossy(&process_request_network(
            &req("Authorization: Bearer secret\r\n", body), "secret", &[], &d)).into_owned();
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("open_document"), "authorized → 200");
    }

    #[test]
    fn network_bad_host_is_403_when_allowlisted() {
        let sess = Mutex::new(Session::default());
        let d = dispatch(&sess);
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        // req() hardcodes Host: 127.0.0.1:1 — not in the allowlist ⇒ 403.
        let allow = vec!["svc.internal".to_string()];
        let resp = String::from_utf8_lossy(&process_request_network(
            &req("Authorization: Bearer t\r\n", body), "t", &allow, &d)).into_owned();
        assert!(resp.starts_with("HTTP/1.1 403"), "host not in allowlist → 403");
    }
}
