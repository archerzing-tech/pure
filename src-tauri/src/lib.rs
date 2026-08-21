// src-tauri/src/lib.rs
// v0.7 — Full IPC backend with file tools, git, session, LLM streaming, MCP, secrets, file watching.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

fn build_http_client(timeout: std::time::Duration, proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        // Force HTTP/1.1: corporate TLS-intercepting gateways (netentsec et al.)
        // frequently break ALPN-negotiated HTTP/2, while plain HTTP/1.1 CONNECT
        // + streaming works everywhere. curl speaks HTTP/1.1 by default, which
        // is exactly why it succeeds through such proxies where the h2 client
        // fails.
        .http1_only();
    if let Some(url) = effective_proxy_url(proxy_url.unwrap_or("")) {
        if !valid_proxy_url(&url) {
            return Err("proxy: URL must start with http://, https://, socks5://, or socks5h://".to_string());
        }
        let proxy = reqwest::Proxy::all(&url).map_err(|e| format!("proxy: {}", e))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("client: {}", e))
}

/// The sentinel the WebView sends in "system proxy" mode (mirrors
/// SYSTEM_PROXY_MARKER on the TS side). It is resolved here at request time
/// and must never be treated as a real URL.
const SYSTEM_PROXY_MARKER: &str = "system://";

/// Resolve a WebView proxy spec into a concrete, auth-injected proxy URL, or
/// None for direct. Empty → None (reqwest / child processes then fall back to
/// the standard proxy env vars automatically). `system://` → the OS system
/// proxy (macOS scutil / Windows registry), or None when unset. Anything else
/// → the literal manual URL. Auth injection reuses resolve_proxy_auth so a
/// manual username/password still applies; the OS proxy URL carries no
/// username, so it passes through untouched.
fn effective_proxy_url(spec: &str) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let resolved = if spec == SYSTEM_PROXY_MARKER {
        resolve_system_proxy_url()?
    } else {
        spec.to_string()
    };
    Some(resolve_proxy_auth(&resolved))
}

/// Read the OS system proxy (macOS `scutil --proxy` / Windows WinINET registry)
/// as a `scheme://host:port` URL. Env-var proxies are intentionally NOT read
/// here: reqwest already honors HTTP(S)_PROXY/NO_PROXY when no explicit proxy
/// is configured, so returning None lets those apply naturally.
fn resolve_system_proxy_url() -> Option<String> {
    #[cfg(target_os = "macos")]
    let os = detect_macos_proxy();
    #[cfg(target_os = "windows")]
    let os = detect_windows_proxy();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let os: Option<(String, String, String, &'static str)> = None;
    let (scheme, host, port, _) = os?;
    Some(if port.is_empty() {
        format!("{scheme}{host}")
    } else {
        format!("{scheme}{host}:{port}")
    })
}

fn valid_proxy_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://", "socks5://", "socks5h://"].iter().any(|prefix| lower.starts_with(prefix))
}

/// Shared cookie jar for the HTML search backends. Reusing session cookies
/// (Baidu's BAIDUID, Bing's MUID, Sogou's SUV, …) across searches within the
/// process is the single cheapest captcha-avoidance lever there is: a fresh
/// cookie-less client trips anti-bot challenges on the very first request,
/// which is exactly how "经常搜不到" happens. The jar is process-global and
/// intentionally carries no credentials (proxy auth lives in the secrets
/// store, never in cookies).
static SEARCH_COOKIE_JAR: std::sync::OnceLock<Arc<reqwest::cookie::Jar>> = std::sync::OnceLock::new();

fn search_cookie_jar() -> &'static Arc<reqwest::cookie::Jar> {
    SEARCH_COOKIE_JAR.get_or_init(|| Arc::new(reqwest::cookie::Jar::default()))
}

/// Lazily warmed-up flag: the first Baidu search first fetches the homepage so
/// the shared jar picks up a BAIDUID cookie before the real query — Baidu
/// serves a captcha page to cookie-less clients and the warm-up is the
/// documented workaround. Best-effort (a failed warm-up just means the search
/// may hit the captcha and degrade to the next backend).
static BAIDU_WARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn ensure_baidu_cookies(proxy_url: Option<&str>) {
    if BAIDU_WARMED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if let Ok(client) = build_search_client(std::time::Duration::from_secs(4), proxy_url) {
        let _ = client
            .get("https://www.baidu.com/")
            .header("User-Agent", BROWSER_UA)
            .send()
            .await;
    }
}

/// Search-specific HTTP client: same HTTP/1.1 + proxy handling as
/// build_http_client, plus the shared cookie jar so session cookies persist
/// across searches (see SEARCH_COOKIE_JAR). API backends (Serper/Tavily/
/// SearXNG) don't need cookies and keep using build_http_client.
fn build_search_client(timeout: std::time::Duration, proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .http1_only()
        .cookie_provider(search_cookie_jar().clone());
    if let Some(url) = effective_proxy_url(proxy_url.unwrap_or("")) {
        if !valid_proxy_url(&url) {
            return Err("proxy: URL must start with http://, https://, socks5://, or socks5h://".to_string());
        }
        let proxy = reqwest::Proxy::all(&url).map_err(|e| format!("proxy: {}", e))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("client: {}", e))
}

/// Rust secret slot holding the proxy password (desktop only). The username
/// travels with the proxy URL from the WebView; the password never does — it
/// is stored in ~/.pure/secrets.json and injected here just before use.
const PROXY_PASSWORD_SECRET_KEY: &str = "proxy.password";

/// Fill the missing password into a proxy URL whose username is already
/// embedded (`scheme://user@host:port` → `scheme://user:pass@host:port`).
/// Leaves the URL untouched when it already carries a password, has no
/// username, or no password is stored. reqwest percent-decodes the embedded
/// credentials, so reserved characters round-trip correctly.
fn resolve_proxy_auth(proxy_url: &str) -> String {
    let trimmed = proxy_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let secrets = load_secrets().unwrap_or_else(|_| serde_json::json!({}));
    let password = secrets
        .get(PROXY_PASSWORD_SECRET_KEY)
        .and_then(|v| v.as_str());
    inject_proxy_password(trimmed, password)
}

/// Pure URL edit: fill a missing password into a username-bearing proxy URL.
/// Split from resolve_proxy_auth so it is unit-testable without touching the
/// on-disk secrets file.
fn inject_proxy_password(proxy_url: &str, password: Option<&str>) -> String {
    let mut url = match reqwest::Url::parse(proxy_url) {
        Ok(u) => u,
        Err(_) => return proxy_url.to_string(),
    };
    if url.password().is_some() || url.username().is_empty() {
        return proxy_url.to_string();
    }
    let Some(password) = password.filter(|p| !p.is_empty()) else {
        return proxy_url.to_string();
    };
    if url.set_password(Some(password)).is_ok() {
        return url.to_string();
    }
    proxy_url.to_string()
}

// ── LLM connection probe (Settings → LLM → 测试连接) ──
// Desktop probing goes through the SAME Rust network path as real chat_stream
// calls (reqwest + the configured proxy + secrets resolution), so a provider
// that works in chat can never fail the test — and a test failure is a real
// failure of the exact path the app will use. The WebView-fetch fallback stays
// for browser dev mode, where CORS is not an issue for the user.

#[derive(serde::Serialize)]
struct LlmConnectionProbe {
    ok: bool,
    status: Option<u16>,
    latency_ms: u64,
    error: String,
}

/// GET {base}/models with the resolved key; 2xx is the only success. Split out
/// of the command so tests can drive it against a local mock server.
async fn probe_llm_endpoint(client: reqwest::Client, url: &str, api_key: &str) -> LlmConnectionProbe {
    let started = std::time::Instant::now();
    let mut request = client.get(url).header("User-Agent", BROWSER_UA);
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            return LlmConnectionProbe {
                ok: false,
                status: None,
                latency_ms: started.elapsed().as_millis() as u64,
                error: format!("network error: {}", e),
            };
        }
    };
    let status = response.status().as_u16();
    let latency_ms = started.elapsed().as_millis() as u64;
    if status >= 200 && status < 300 {
        LlmConnectionProbe { ok: true, status: Some(status), latency_ms, error: String::new() }
    } else if status == 401 || status == 403 {
        LlmConnectionProbe {
            ok: false,
            status: Some(status),
            latency_ms,
            error: format!("HTTP {} — API key rejected", status),
        }
    } else {
        LlmConnectionProbe { ok: false, status: Some(status), latency_ms, error: format!("HTTP {}", status) }
    }
}

/// Test an LLM endpoint exactly like chat_stream would use it: same client
/// builder (timeout + proxy), same key resolution (explicit key wins, else the
/// named secret), same proxy bypass rules. The GUI shows the probe result.
#[tauri::command]
async fn test_llm_connection(
    base_url: String,
    api_key: Option<String>,
    secret_key: Option<String>,
    proxy_url: Option<String>,
    proxy_bypass_providers: Option<Vec<String>>,
    provider: Option<String>,
) -> Result<LlmConnectionProbe, String> {
    let api_key = api_key.unwrap_or_default();
    let secret_key = secret_key.unwrap_or_default();
    let proxy_url = proxy_url.unwrap_or_default();
    let proxy_bypass_providers = proxy_bypass_providers.unwrap_or_default();
    let provider = provider.unwrap_or_default();
    let secrets = load_secrets()?;
    let resolved_key = resolve_api_key(&secrets, &api_key, &secret_key);
    let effective_proxy = if proxy_url.trim().is_empty()
        || proxy_matches(&provider, &proxy_bypass_providers)
    {
        None
    } else {
        Some(proxy_url.trim())
    };
    let client = build_http_client(std::time::Duration::from_secs(8), effective_proxy)?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    Ok(probe_llm_endpoint(client, &url, &resolved_key).await)
}

#[cfg(test)]
mod llm_probe_tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    /// Minimal one-shot HTTP server serving a canned status line + JSON body.
    fn spawn_mock_server(status_line: &'static str, body: &'static str) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                if let Ok(mut s) = stream {
                    // Read the request first (the client waits for its bytes to
                    // be consumed before trusting the response), then reply.
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf);
                    let resp = format!(
                        "{}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                        status_line,
                        body.len(),
                        body
                    );
                    let _ = s.write_all(resp.as_bytes());
                    let _ = s.shutdown(std::net::Shutdown::Write);
                }
            }
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn reports_2xx_as_ok_with_latency() {
        let (addr, handle) = spawn_mock_server("HTTP/1.1 200 OK", "{\"data\":[]}");
        let client = build_http_client(std::time::Duration::from_secs(5), None).unwrap();
        let probe = probe_llm_endpoint(client, &format!("http://{}/v1/models", addr), "sk-test").await;
        handle.join().unwrap();
        assert!(probe.ok, "probe error: {}", probe.error);
        assert_eq!(probe.status, Some(200));
        assert!(probe.error.is_empty());
    }

    #[tokio::test]
    async fn reports_401_as_key_rejected() {
        let (addr, handle) = spawn_mock_server("HTTP/1.1 401 Unauthorized", "{}");
        let client = build_http_client(std::time::Duration::from_secs(5), None).unwrap();
        let probe = probe_llm_endpoint(client, &format!("http://{}/v1/models", addr), "sk-bad").await;
        handle.join().unwrap();
        assert!(!probe.ok, "probe error: {}", probe.error);
        assert_eq!(probe.status, Some(401));
        assert!(probe.error.contains("API key rejected"));
    }

    #[tokio::test]
    async fn reports_5xx_and_network_errors_as_failures() {
        let (addr, handle) = spawn_mock_server("HTTP/1.1 500 Internal Server Error", "{}");
        let client = build_http_client(std::time::Duration::from_secs(5), None).unwrap();
        let probe = probe_llm_endpoint(client, &format!("http://{}/v1/models", addr), "sk-test").await;
        handle.join().unwrap();
        assert!(!probe.ok);
        assert_eq!(probe.status, Some(500));

        // Connection refused → network error, no status.
        let client = build_http_client(std::time::Duration::from_secs(5), None).unwrap();
        let probe = probe_llm_endpoint(client, "http://127.0.0.1:1/models", "sk-test").await;
        assert!(!probe.ok);
        assert_eq!(probe.status, None);
        assert!(probe.error.contains("network error"));
    }

    #[tokio::test]
    async fn resolves_key_from_secrets_when_not_passed() {
        // The command-level resolution (resolve_api_key) must prefer the
        // explicit key and fall back to the named secret — mirroring chat_stream.
        let secrets = serde_json::json!({ "llm.apiKey": "secret-key" });
        assert_eq!(resolve_api_key(&secrets, "", ""), "secret-key");
        assert_eq!(resolve_api_key(&secrets, "explicit", ""), "explicit");
        assert_eq!(resolve_api_key(&secrets, "", "llm.apiKey.custom"), "");
        let secrets2 = serde_json::json!({ "llm.apiKey.custom": "custom-key" });
        assert_eq!(resolve_api_key(&secrets2, "", "llm.apiKey.custom"), "custom-key");
    }
}

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};

use base64::Engine as _;

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyObject, Bool};
#[cfg(target_os = "macos")]
use objc2::ClassType;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
#[cfg(target_os = "macos")]
use objc2_av_foundation::{
    AVCaptureDevice, AVAuthorizationStatus, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo,
};
#[cfg(target_os = "macos")]
use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDictionary, NSString};
#[cfg(target_os = "macos")]
use block2::RcBlock;

#[cfg(target_os = "windows")]
use png::{BitDepth, ColorType, Encoder};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

// ── Silent child processes ──
// A Windows GUI app has no attached console, so every console child (cmd,
// git, node, powershell, …) spawns a fresh console window that flashes on
// screen for each tool call. CREATE_NO_WINDOW hides it. Both wrappers are
// no-ops on Unix/macOS, so call sites use them everywhere.
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

// CREATE_NO_WINDOW — Windows flag that suppresses the console window a child
// process would otherwise open when the parent GUI app has no console.
#[allow(dead_code)] // only referenced from cfg(windows) bodies
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[allow(unused_mut)] // mut is only used by the cfg(windows) body
fn silent_child(mut cmd: std::process::Command) -> std::process::Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[allow(unused_mut)] // mut is only used by the cfg(windows) body
fn silent_child_tokio(mut cmd: TokioCommand) -> TokioCommand {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP Subprocess Manager
// ═══════════════════════════════════════════════════════════════════════════════

struct McpHandle {
    child: tokio::sync::Mutex<Child>,
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    stdout: tokio::sync::Mutex<BufReader<tokio::process::ChildStdout>>,
}

type McpRegistry = tokio::sync::Mutex<BTreeMap<String, Arc<McpHandle>>>;

fn mcp_key(session_id: &str, name: &str) -> String {
    format!("{}:{}", session_id, name)
}

/// Augment a PATH with the common per-user runtime dirs (bun, npm global,
/// Homebrew, nvm/cargo/volta/fnm/asdf installs) plus the system defaults. A
/// Finder-launched app inherits a minimal PATH (/usr/bin:/bin:…) that omits
/// per-user runtimes, so MCP servers launched with bunx/npx would fail to
/// spawn without this. `existing` is the caller-supplied or inherited PATH to
/// preserve as the base.
fn augmented_mcp_path(existing: Option<&str>) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![
        format!("{}/.bun/bin", home),
        format!("{}/.npm-global/bin", home),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    // nvm / cargo / volta / fnm / asdf installs — the minimal PATH misses
    // these too (see probe_extra_path_dirs). Unix-only: Windows GUI apps
    // inherit the full system PATH.
    #[cfg(unix)]
    dirs.extend(probe_extra_path_dirs());
    if let Some(base) = existing.filter(|s| !s.is_empty()) {
        dirs.push(base.to_string());
    }
    // Dedupe while preserving priority order (first occurrence wins).
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs.join(":")
}

async fn mcp_call_inner(handle: &McpHandle, request: &str) -> Result<String, String> {
    // Write request to stdin
    {
        let mut stdin = handle.stdin.lock().await;
        stdin
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("write newline: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush stdin: {}", e))?;
    }

    // Read response from stdout (one line = one JSON-RPC response)
    let mut line = String::new();
    {
        let mut stdout = handle.stdout.lock().await;
        stdout
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read stdout: {}", e))?;
    }

    Ok(line.trim().to_string())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File Tools
// ═══════════════════════════════════════════════════════════════════════════════

/// Resolve a tool path below `workspace`.
///
/// Tool schemas describe paths relative to the workspace, but models sometimes
/// echo the selected absolute workspace path back in `path`. `Path::join`
/// treats an absolute second argument as a replacement, so handle that case
/// explicitly and accept it only when it still resolves inside the workspace.
/// The nearest existing ancestor is canonicalized before missing children are
/// appended; this keeps new-file writes safe even when an intermediate
/// directory is a symlink.
fn resolve(workspace: &str, path: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(workspace.trim());
    if base.as_os_str().is_empty() {
        return Err("workspace is required".to_string());
    }
    let base_canonical =
        fs::canonicalize(&base).map_err(|e| format!("invalid workspace '{}': {}", workspace, e))?;
    if !base_canonical.is_dir() {
        return Err(format!("workspace is not a directory: {}", workspace));
    }

    let raw = path.trim();
    if raw.is_empty() {
        return Err("path is required".to_string());
    }
    let requested = PathBuf::from(raw);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        base_canonical.join(requested)
    };
    // Lexically collapse `.` / `..` (a `..` that climbs above the filesystem
    // root is an error). No workspace containment is enforced: absolute paths
    // outside the workspace are allowed.
    let normalized =
        normalize_lexical(&candidate).map_err(|_| format!("path cannot be resolved: {}", path))?;

    // Canonicalize the deepest existing ancestor, then append the missing
    // components in reverse order. This resolves existing symlinks while still
    // allowing write_file to target a file that does not exist yet.
    let mut existing = normalized.clone();
    let mut missing: Vec<PathBuf> = Vec::new();
    while !existing.exists() {
        // `Path::exists()` follows symlinks and returns false for a dangling
        // link. Inspect metadata before climbing so a broken link cannot be
        // treated as an ordinary missing directory and later followed by a
        // write into an arbitrary target.
        if let Ok(meta) = fs::symlink_metadata(&existing) {
            if meta.file_type().is_symlink() {
                return Err(format!("path uses an unresolved symlink: {}", path));
            }
        }
        let Some(name) = existing.file_name().map(PathBuf::from) else {
            return Err(format!("path cannot be resolved: {}", path));
        };
        missing.push(name);
        if !existing.pop() {
            return Err(format!("path cannot be resolved: {}", path));
        }
    }

    let canonical_existing =
        fs::canonicalize(&existing).map_err(|e| format!("resolve '{}': {}", path, e))?;

    let mut resolved = canonical_existing;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn has_symlink_component(workspace: &str, path: &str) -> bool {
    let base = PathBuf::from(workspace.trim());
    let requested = PathBuf::from(path.trim());
    let candidate = if requested.is_absolute() { requested } else { base.join(requested) };
    let Ok(normalized) = normalize_lexical(&candidate) else { return false };
    // Workspace confinement is removed: outside paths are allowed, so this only
    // guards against an ACTUAL symlink component in the path itself. Paths
    // inside the workspace are checked relative to the workspace root (original
    // behavior — catches a middle-component symlink like workspace/link -> elsewhere).
    if let Ok(relative) = normalized.strip_prefix(&base) {
        let mut current = base;
        for component in relative.components() {
            if let std::path::Component::Normal(value) = component {
                current.push(value);
                if fs::symlink_metadata(&current)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return true;
                }
            }
        }
        false
    } else {
        // Outside the workspace: only the deepest existing ancestor can still
        // be a symlink the caller could traverse through (everything above it
        // is a system directory — flagging /var on macOS would break every
        // temp path). Missing tail components cannot be symlinks yet.
        let mut existing = normalized.clone();
        while !existing.exists() {
            if !existing.pop() {
                break;
            }
        }
        fs::symlink_metadata(&existing)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
    }
}

/// Lexically normalize `.` and `..` without touching the filesystem. The
/// filesystem-aware containment check in `resolve` runs after this step.
fn normalize_lexical(path: &std::path::Path) -> Result<PathBuf, ()> {
    let mut normalized = PathBuf::new();
    let mut root_seen = false;
    let mut normal_depth = 0usize;
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if normal_depth > 0 {
                    normalized.pop();
                    normal_depth -= 1;
                } else if root_seen {
                    return Err(());
                } else {
                    normalized.push(component.as_os_str());
                }
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                normalized.push(component.as_os_str());
                root_seen = true;
            }
            std::path::Component::Normal(value) => {
                normalized.push(value);
                normal_depth += 1;
            }
        }
    }
    Ok(normalized)
}

#[tauri::command]
fn read_file(workspace: String, path: String) -> Result<String, String> {
    let full = resolve(&workspace, &path)?;
    let meta = fs::metadata(&full).map_err(|e| format!("read_file: {}", e))?;
    if meta.is_dir() {
        return Err(format!(
            "read_file: '{}' 是目录，不是文件——请用 list_files 查看目录内容，或补全到具体文件名。",
            path
        ));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "read_file: 文件 {}MB 超过读取上限 64MB；可以改用 search_files 搜索其中的内容，或用 execute_command 分段读取。",
            meta.len() / 1024 / 1024
        ));
    }
    let bytes = fs::read(&full).map_err(|e| format!("read_file: {}", e))?;
    let (text, note) = extract_file_text(&bytes, &full);
    let text = text.trim().to_string();
    if text.is_empty() && !note.is_empty() {
        return Err(format!("read_file: '{}' — {}", path, note));
    }
    if text.is_empty() {
        return Ok("(empty file)".to_string());
    }
    Ok(text)
}

#[tauri::command]
fn path_info(workspace: String, path: String) -> Result<serde_json::Value, String> {
    let full = resolve(&workspace, &path)?;
    Ok(serde_json::json!({
        "exists": full.exists(),
        "isDirectory": full.is_dir(),
        "size": full.metadata().map(|metadata| metadata.len()).unwrap_or(0),
        "isSymlink": has_symlink_component(&workspace, &path),
    }))
}

#[tauri::command]
fn remove_path(workspace: String, path: String, recursive: Option<bool>) -> Result<String, String> {
    if has_symlink_component(&workspace, &path) {
        return Err(format!("refusing to remove a symlink path: {}", path));
    }
    let full = resolve(&workspace, &path)?;
    let base = fs::canonicalize(&workspace).map_err(|e| format!("invalid workspace: {}", e))?;
    if full == base {
        return Err("refusing to remove the workspace root".to_string());
    }
    if !full.exists() {
        return Ok(format!("Path already absent: {}", path));
    }
    if full.is_dir() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(&full).map_err(|e| format!("remove_path: {}", e))?;
        } else {
            fs::remove_dir(&full).map_err(|e| format!("remove_path: {}", e))?;
        }
    } else {
        fs::remove_file(&full).map_err(|e| format!("remove_path: {}", e))?;
    }
    Ok(format!("Removed: {}", path))
}

#[tauri::command]
fn write_file(workspace: String, path: String, content: String) -> Result<String, String> {
    let full = resolve(&workspace, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::write(&full, &content).map_err(|e| format!("write_file: {}", e))?;
    Ok(format!("Wrote {} bytes to {}", content.len(), path))
}

/// Write a file with live progress events over a Channel — the GUI tool row
/// shows "正在写入 … 45% (230/512 KB)" instead of a silent "等待输出" wait
/// until the whole (possibly large) write completes. The content is written
/// in 64 KB chunks; after each chunk a JSON `{ "type": "progress",
/// "written", "total" }` event is pushed. Small files emit a single 100%
/// event and finish instantly — the frontend treats it as an immediate status
/// update. The return value mirrors write_file ("Wrote N bytes to path") so
/// callers can't tell the two apart.
#[tauri::command]
async fn write_file_stream(
    workspace: String,
    path: String,
    content: String,
    on_progress: Channel<String>,
) -> Result<String, String> {
    write_file_stream_inner(&workspace, &path, &content, &on_progress).await
}

/// Core of write_file_stream, split out for unit testing (a Tauri Channel
/// built via Channel::new works in a plain test, but keeping the command
/// wrapper tiny mirrors the execute_command_stream_inner convention).
async fn write_file_stream_inner(
    workspace: &str,
    path: &str,
    content: &str,
    on_progress: &Channel<String>,
) -> Result<String, String> {
    let full = resolve(workspace, path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let bytes = content.as_bytes();
    let total = bytes.len();
    let mut file = fs::File::create(&full).map_err(|e| format!("create: {}", e))?;
    use std::io::Write as _;
    const CHUNK: usize = 64 * 1024;
    let mut written = 0usize;
    while written < total {
        let end = (written + CHUNK).min(total);
        file.write_all(&bytes[written..end])
            .map_err(|e| format!("write: {}", e))?;
        written = end;
        let evt = serde_json::json!({ "type": "progress", "written": written, "total": total });
        let _ = on_progress.send(evt.to_string());
    }
    Ok(format!("Wrote {} bytes to {}", total, path))
}

/// Save a code block to an absolute path chosen by the user via the GUI's
/// save dialog (see markdown.ts addCodeBlockActions). Unlike write_file this
/// takes the path verbatim — no workspace resolution, no traversal guard —
/// because the dialog path is user-chosen, not LLM-supplied.
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
    }
    fs::write(&p, &content).map_err(|e| format!("save_file: {}", e))?;
    Ok(())
}

/// Write raw bytes (base64-encoded over IPC) to a user-chosen path. Used for
/// PNG image exports, where the payload isn't UTF-8 text. Mirrors save_file's
/// mkdir-parent behavior; the payload is decoded by the same helper that
/// handles pasted screenshots, so malformed input can never persist garbage.
#[tauri::command]
fn save_file_binary(path: String, data_base64: String) -> Result<(), String> {
    let bytes = decode_paste_image(&data_base64)?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
    }
    fs::write(&p, &bytes).map_err(|e| format!("save_file_binary: {}", e))?;
    Ok(())
}

#[tauri::command]
fn edit_file(
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
    allow_multiple: Option<bool>,
) -> Result<String, String> {
    let full = resolve(&workspace, &path)?;
    let text = fs::read_to_string(&full).map_err(|e| format!("read: {}", e))?;

    let crlf_file = text.contains("\r\n");
    let normalized_old = old_string.replace("\r\n", "\n");
    let line_ending_adjusted = crlf_file
        && old_string.contains('\n')
        && !old_string.contains("\r\n")
        && text.replace("\r\n", "\n").contains(&normalized_old);
    let old_for_match = if line_ending_adjusted {
        normalized_old.replace('\n', "\r\n")
    } else {
        old_string.clone()
    };

    if !text.contains(&old_for_match) {
        let preview: String = old_string.chars().take(160).collect();
        let preview = preview.replace('\r', "\\r").replace('\n', "\\n");
        return Err(format!(
            "String not found in file: {}. The file may have changed since it was read. Re-read {} and do not retry this identical edit; use a shorter exact context.",
            preview, path
        ));
    }

    let occurrences = text.matches(&old_for_match).count();
    let multi = allow_multiple.unwrap_or(false);

    if occurrences > 1 && !multi {
        return Err(format!(
            "Found {} occurrences. Set allow_multiple:true or provide more context.",
            occurrences
        ));
    }

    let replacement = if crlf_file {
        new_string.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        new_string.clone()
    };
    let new_text = if multi {
        text.replace(&old_for_match, &replacement)
    } else {
        text.replacen(&old_for_match, &replacement, 1)
    };

    fs::write(&full, &new_text).map_err(|e| format!("write: {}", e))?;
    Ok(format!(
        "Replaced {} occurrence(s) in {}",
        if multi { occurrences } else { 1 },
        path
    ))
}

/// Search one file's extracted text for the pattern (literal, optionally
/// case-insensitive). Returns (matches, skipped_reason) — the reason is Some
/// when the file could not be read as text at all.
fn search_one_file(
    entry_path: &std::path::Path,
    search_dir: &std::path::Path,
    needle: &str,
    ignore_case: bool,
    max: usize,
) -> (Vec<String>, Option<String>) {
    let Ok(meta) = fs::metadata(entry_path) else {
        return (Vec::new(), Some("无法读取文件信息".to_string()));
    };
    if !meta.is_file() {
        return (Vec::new(), None);
    }
    if meta.len() > MAX_SEARCH_FILE_BYTES {
        return (
            Vec::new(),
            Some(format!("文件 {:.1}MB 超过搜索上限 32MB", meta.len() as f64 / 1024.0 / 1024.0)),
        );
    }
    let Ok(bytes) = fs::read(entry_path) else {
        return (Vec::new(), Some("无法读取文件".to_string()));
    };
    let (text, note) = extract_file_text(&bytes, entry_path);
    if text.is_empty() && !note.is_empty() {
        return (Vec::new(), Some(note));
    }
    let rel_path = entry_path
        .strip_prefix(search_dir)
        .unwrap_or(entry_path)
        .to_string_lossy()
        .to_string();
    let mut matches: Vec<String> = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        if matches.len() >= max {
            break;
        }
        let hay = if ignore_case { line.to_lowercase() } else { line.to_string() };
        if hay.contains(needle) {
            matches.push(format!("{}:{}: {}", rel_path, line_no + 1, line.trim()));
        }
    }
    (matches, None)
}

#[tauri::command]
fn search_files(
    workspace: String,
    pattern: String,
    path: Option<String>,
    file_pattern: Option<String>,
    max_results: Option<usize>,
    case_sensitive: Option<bool>,
) -> Result<String, String> {
    let search_dir = match &path {
        Some(p) if !p.trim().is_empty() => resolve(&workspace, p)?,
        _ => resolve(&workspace, ".")?,
    };
    if !search_dir.exists() {
        return Err(format!(
            "search_files: '{}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。",
            path.as_deref().unwrap_or(".")
        ));
    }
    let max = max_results.unwrap_or(50).clamp(1, 500);
    let ignore_case = !case_sensitive.unwrap_or(false);
    let needle = if ignore_case {
        pattern.to_lowercase()
    } else {
        pattern.clone()
    };
    let mut results: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // A `path` pointing at a single FILE searches that file directly — models
    // often point search_files at the document they think contains the answer.
    if search_dir.is_file() {
        // Base = parent so the match lines carry the file name, not an empty
        // relative path (strip_prefix against the file itself yields "").
        let base = search_dir.parent().unwrap_or(&search_dir);
        let (matches, reason) = search_one_file(&search_dir, base, &needle, ignore_case, max);
        results.extend(matches);
        if let Some(reason) = reason {
            skipped.push(format!("{}（{}）", search_dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), reason));
        }
    } else {
        let mut glob_pattern = file_pattern.unwrap_or_else(|| "**/*".to_string());
        // Models echo Windows paths (D:\tmp\*.docx) verbatim; on non-Windows
        // platforms backslashes are literal filename characters, so normalize.
        #[cfg(not(windows))]
        {
            glob_pattern = glob_pattern.replace('\\', "/");
        }
        let glob_pattern = format!("{}/{}", search_dir.to_string_lossy(), glob_pattern);

        for entry in glob::glob(&glob_pattern).map_err(|e| format!("glob: {}", e))? {
            let entry_path = match entry {
                Ok(p) => p,
                Err(_) => continue,
            };
            if results.len() >= max {
                break;
            }
            let (matches, reason) = search_one_file(&entry_path, &search_dir, &needle, ignore_case, max);
            if let Some(reason) = reason {
                skipped.push(format!("{}（{}）", entry_path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), reason));
                continue;
            }
            if results.len() >= max {
                break;
            }
            results.extend(matches);
        }
    }

    let mut out = if results.is_empty() {
        format!("No matches found for \"{}\"", pattern)
    } else {
        results.join("\n")
    };
    if !skipped.is_empty() {
        let mut display: Vec<String> = skipped.iter().take(8).cloned().collect();
        let more = skipped.len().saturating_sub(8);
        if more > 0 {
            display.push(format!("…等共 {} 个", skipped.len()));
        }
        out.push_str(&format!(
            "\n\n[提示] {} 个文件无法解析文本内容（扫描版 PDF / 加密文档 / 旧版二进制 / 超大文件），已跳过：{}\n如需读取这些文件，请单独 read_file 它们查看具体原因。",
            skipped.len(),
            display.join("、")
        ));
    }
    Ok(out)
}

/// CJK single characters that are grammatical particles / pronouns, never
/// content words. Bigrams containing any of these are dropped from find_files
/// queries, so "学历" survives tokenizing "我的学历" while noise pairs
/// ("我的" / "的学") do not. Mirrors `CJK_STOP_CHARS` in NodeToolAdapter.ts.
fn is_cjk_stop_char(c: char) -> bool {
    matches!(
        c,
        '的' | '了' | '在' | '是' | '我' | '你' | '他' | '她' | '它' | '们' | '与' | '和' | '及'
            | '都' | '这' | '那' | '个' | '要' | '就' | '还' | '而' | '或' | '没' | '有' | '不'
            | '把' | '被' | '对' | '从' | '到' | '以' | '中' | '里' | '上' | '下' | '之' | '等'
            | '什' | '么' | '谁'
    )
}

/// Turn a free-form find_files query into searchable needle tokens. Latin
/// queries are lowercased words (len >= 3); CJK queries become length-2
/// bigrams that survive the stop-char filter. Returns sorted, de-duplicated.
/// Mirrors `tokenizeFindQuery` in NodeToolAdapter.ts.
fn tokenize_find_query(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut flush = |seg: &str| {
        if seg.is_empty() {
            return;
        }
        if is_chinese_query(seg) {
            if seg.chars().count() >= 2 {
                let lowered = seg.to_lowercase();
                let chars: Vec<char> = lowered.chars().collect();
                for i in 0..chars.len().saturating_sub(1) {
                    let pair: String = chars[i..i + 2].iter().collect();
                    if pair.chars().any(is_cjk_stop_char) {
                        continue;
                    }
                    if !out.contains(&pair) {
                        out.push(pair);
                    }
                }
            }
        } else {
            let word = seg.to_lowercase();
            if word.chars().count() >= 3 || word.chars().any(|c| c.is_ascii_digit()) {
                if !out.contains(&word) {
                    out.push(word);
                }
            }
        }
    };
    for c in query.chars() {
        if c.is_whitespace() || matches!(c, ',' | '，' | '。' | ';' | '；' | ':' | '：' | '、' | '|' | '/' | '\\' | '(' | ')' | '（' | '）' | '"' | '\'') {
            flush(&current);
            current.clear();
        } else {
            current.push(c);
        }
    }
    flush(&current);
    out.sort();
    out
}

/// find_files: smartly locate files most likely to contain a topic/keyword
/// without reading every file. Strategy (mirrors NodeToolAdapter.handleFindFiles):
/// 1) filename scan first (cheap — no content extraction), 2) ranked content
/// scan of filename-matches first, then smallest files, with a scan budget,
/// 3) return top files each with up to 3 snippet lines (never full content),
/// 4) actionable fallback guidance when nothing matches.
#[tauri::command]
fn find_files(
    workspace: String,
    query: String,
    path: Option<String>,
    file_pattern: Option<String>,
    max_results: Option<usize>,
    case_sensitive: Option<bool>,
) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("find_files: query 不能为空。请给出要查找的主题词，例如 \"学历\" 或 \"education\"。".to_string());
    }
    let search_dir = match &path {
        Some(p) if !p.trim().is_empty() => resolve(&workspace, p)?,
        _ => resolve(&workspace, ".")?,
    };
    if !search_dir.exists() {
        return Err(format!(
            "find_files: '{}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。",
            path.as_deref().unwrap_or(".")
        ));
    }

    let max = max_results.unwrap_or(10).clamp(1, 30);
    let ignore_case = !case_sensitive.unwrap_or(false);
    let needles = tokenize_find_query(&query);
    if needles.is_empty() {
        return Err(format!(
            "find_files: 无法从查询 \"{}\" 中提取有效关键词（只剩助词/停用词）。请换更具体的词，例如 \"学历\"、\"毕业证\" 或 \"education\"。",
            query
        ));
    }

    struct Candidate {
        rel: String,
        name_score: usize,
        hits: usize,
        snippets: Vec<String>,
        skip_note: Option<String>,
    }

    // Scan one file for content hits, capturing up to 3 snippet lines. Never
    // returns full file content — that's what read_file is for.
    fn scan_one_file(
        entry_path: &std::path::Path,
        base: &std::path::Path,
        needles: &[String],
        ignore_case: bool,
    ) -> Option<Candidate> {
        let meta = fs::metadata(entry_path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let rel_path = entry_path
            .strip_prefix(base)
            .unwrap_or(entry_path)
            .to_string_lossy()
            .to_string();
        let file_name = entry_path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folded_name = if ignore_case { file_name.to_lowercase() } else { file_name.clone() };
        let name_score = needles.iter().filter(|n| folded_name.contains(n.as_str())).count();

        if meta.len() > MAX_SEARCH_FILE_BYTES {
            let note = format!("文件 {:.1}MB 超过搜索上限 32MB", meta.len() as f64 / 1024.0 / 1024.0);
            return Some(Candidate {
                rel: rel_path,
                name_score,
                hits: 0,
                snippets: Vec::new(),
                skip_note: Some(note),
            });
        }
        let bytes = fs::read(entry_path).ok()?;
        let (text, note) = extract_file_text(&bytes, entry_path);
        if text.is_empty() && !note.is_empty() {
            return Some(Candidate {
                rel: rel_path,
                name_score,
                hits: 0,
                snippets: Vec::new(),
                skip_note: Some(note),
            });
        }
        let mut hits = 0usize;
        let mut snippets: Vec<String> = Vec::new();
        for (idx, line) in text.lines().enumerate() {
            let hay = if ignore_case { line.to_lowercase() } else { line.to_string() };
            if needles.iter().any(|n| hay.contains(n.as_str())) {
                hits += 1;
                if snippets.len() < 3 {
                    snippets.push(format!("{}:{}: {}", rel_path, idx + 1, line.trim().chars().take(200).collect::<String>()));
                }
            }
        }
        Some(Candidate {
            rel: rel_path,
            name_score,
            hits,
            snippets,
            skip_note: None,
        })
    }

    // Consider one file as a candidate: skip if already seen or if `max`
    // candidates are already collected; otherwise scan and keep it when it has
    // content hits or a filename match (recording skip reasons otherwise).
    fn consider(
        entry_path: &std::path::Path,
        base: &std::path::Path,
        candidates: &mut Vec<Candidate>,
        seen: &mut std::collections::HashSet<std::path::PathBuf>,
        skipped: &mut Vec<String>,
        needles: &[String],
        ignore_case: bool,
        max: usize,
    ) {
        if candidates.len() >= max {
            return;
        }
        if !seen.insert(entry_path.to_path_buf()) {
            return;
        }
        match scan_one_file(entry_path, base, needles, ignore_case) {
            Some(cand) => {
                let skip_note = cand.skip_note.clone();
                let is_empty_hit = cand.snippets.is_empty() && cand.hits == 0 && cand.name_score == 0;
                if cand.hits > 0 || cand.name_score > 0 {
                    candidates.push(cand);
                }
                if is_empty_hit {
                    if let Some(note) = skip_note {
                        skipped.push(format!("{}（{}）", entry_path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), note));
                    }
                }
            }
            None => {}
        }
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    let budget = max * 6 + 20;

    // A `path` pointing at a single FILE searches that file directly.
    if search_dir.is_file() {
        let base = search_dir.parent().unwrap_or(&search_dir).to_path_buf();
        consider(&search_dir, &base, &mut candidates, &mut seen, &mut skipped, &needles, ignore_case, max);
    } else {
        let mut glob_pattern = file_pattern.unwrap_or_else(|| "**/*".to_string());
        #[cfg(not(windows))]
        {
            glob_pattern = glob_pattern.replace('\\', "/");
        }
        let glob_pattern = format!("{}/{}", search_dir.to_string_lossy(), glob_pattern);
        let mut all_files: Vec<(std::path::PathBuf, usize)> = Vec::new();
        for entry in glob::glob(&glob_pattern).map_err(|e| format!("glob: {}", e))? {
            let entry_path = match entry {
                Ok(p) => p,
                Err(_) => continue,
            };
            // find_files is about FILES — skip directories so they cannot
            // consume scan-budget slots or leak into filename hints (matches
            // NodeToolAdapter's files-only Bun.Glob.scan default).
            if !entry_path.is_file() {
                continue;
            }
            let file_name = entry_path
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            let folded_name = if ignore_case { file_name.to_lowercase() } else { file_name.clone() };
            let name_score = needles.iter().filter(|n| folded_name.contains(n.as_str())).count();
            all_files.push((entry_path, name_score));
        }
        // 1) Filename matches only — content-scan just the files whose NAME
        //    contains a needle (typically a handful). The long tail is left to
        //    the budgeted phase below, so a no-match query can never degenerate
        //    into a full-tree content scan.
        all_files.sort_by(|a, b| b.1.cmp(&a.1));
        for (p, score) in &all_files {
            if candidates.len() >= max || *score == 0 {
                break;
            }
            consider(p, &search_dir, &mut candidates, &mut seen, &mut skipped, &needles, ignore_case, max);
        }
        // 2) Fall back to scanning until budget exhausts, size-ascending so
        //    cheap files are checked before slow multi-MB documents.
        let mut unscanned: Vec<&std::path::PathBuf> = all_files
            .iter()
            .filter(|(p, _)| !seen.contains(p))
            .map(|(p, _)| p)
            .collect();
        unscanned.sort_by_key(|p| fs::metadata(p.as_path()).map(|m| m.len()).unwrap_or(u64::MAX));
        for p in unscanned {
            if candidates.len() >= max || seen.len() >= budget {
                break;
            }
            consider(p, &search_dir, &mut candidates, &mut seen, &mut skipped, &needles, ignore_case, max);
        }
        // Content-hit files first (strongest proof), then filename-only
        // matches; within a tier, more hits wins.
        candidates.sort_by(|a, b| {
            let a_proof = if a.hits > 0 { 1 } else { 0 };
            let b_proof = if b.hits > 0 { 1 } else { 0 };
            b_proof.cmp(&a_proof).then(b.hits.cmp(&a.hits)).then(a.rel.cmp(&b.rel))
        });
        candidates.truncate(max);
    }

    let mut out = if candidates.is_empty() {
        let mut s = format!("find_files \"{}\": 在 {} 未找到匹配文件。", query, search_dir.to_string_lossy());
        s.push_str(&format!("\n已扫描 {} 个文件（{} 个无法解析文本，已跳过）。", seen.len(), skipped.len()));
        s.push_str(&format!(
            "\n[兜底建议] 换更宽泛的关键词（如 \"学历\" 的同类词：毕业证/学位/education），关闭大小写（caseSensitive:false），或用 filePattern 缩小范围（如 \"*.{{docx,pdf,txt}}\"）；若文件在子目录，可先 list_files 查看目录结构。"
        ));
        s
    } else {
        let mut s = format!("find_files \"{}\": 找到 {} 个候选文件（扫描 {} 个文件，{} 个跳过）。以下为最可能包含 \"{}\" 的文件，按相关度排序，每个仅附前 3 行命中片段：", query, candidates.len(), seen.len(), skipped.len(), query);
        for (i, c) in candidates.iter().enumerate() {
            let tag = if c.hits > 0 {
                format!("{} 处命中", c.hits)
            } else {
                "仅文件名命中".to_string()
            };
            let name_tag = if c.name_score > 0 { " · 文件名包含关键词" } else { "" };
            s.push_str(&format!("\n\n{}. {}（{}{}）", i + 1, c.rel, tag, name_tag));
            for snip in &c.snippets {
                s.push_str(&format!("\n   {}", snip));
            }
            if c.snippets.is_empty() {
                s.push_str(&format!("\n   （{}）", c.skip_note.clone().unwrap_or_else(|| "文件名包含关键词，但内容无命中".to_string())));
            }
        }
        s.push_str("\n\n[提示] 需查看完整内容时，用 read_file 读取以上文件（可用 startLine/endLine 只读片段）。");
        s
    };

    if !skipped.is_empty() {
        let mut display: Vec<String> = skipped.iter().take(8).cloned().collect();
        let more = skipped.len().saturating_sub(8);
        if more > 0 {
            display.push(format!("…等共 {} 个", skipped.len()));
        }
        out.push_str(&format!(
            "\n\n[提示] {} 个文件无法解析文本内容（扫描版 PDF / 加密文档 / 旧版二进制 / 超大文件），已跳过：{}\n如需读取这些文件，请单独 read_file 它们查看具体原因。",
            skipped.len(),
            display.join("、")
        ));
    }

    Ok(out)
}

#[tauri::command]
async fn code_searcher(
    workspace: String,
    query: String,
    path: Option<String>,
    globs: Option<Vec<String>>,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
    global_max_results: Option<usize>,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let timeout = timeout_seconds.unwrap_or(10).clamp(1, 30);
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        code_searcher_inner(
            workspace,
            query,
            path,
            globs,
            case_sensitive,
            max_results,
            global_max_results,
            Some(timeout),
        ),
    )
    .await
    .map_err(|_| format!("code_searcher timed out after {}s", timeout))?
}

async fn code_searcher_inner(
    workspace: String,
    query: String,
    path: Option<String>,
    globs: Option<Vec<String>>,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
    global_max_results: Option<usize>,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let search_timeout = std::time::Duration::from_secs(timeout_seconds.unwrap_or(10).clamp(1, 30));
    let deadline = Instant::now() + search_timeout;
    let search_dir = match &path {
        Some(p) if !p.is_empty() => resolve(&workspace, p)?,
        _ => resolve(&workspace, ".")?,
    };
    let workspace_root =
        fs::canonicalize(&workspace).map_err(|e| format!("invalid workspace: {}", e))?;
    let expression = regex::RegexBuilder::new(&query)
        .case_insensitive(!case_sensitive.unwrap_or(true))
        .build()
        .map_err(|e| format!("invalid regular expression: {}", e))?;
    let per_file = max_results.unwrap_or(15).clamp(1, 100);
    let global_max = global_max_results.unwrap_or(250).clamp(1, 1000);
    let mut include_globs: Vec<glob::Pattern> = Vec::new();
    let mut exclude_globs: Vec<glob::Pattern> = Vec::new();
    for raw in globs.unwrap_or_default() {
        let pattern = raw.trim();
        if pattern.is_empty() {
            continue;
        }
        let (exclude, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern), |p| (true, p));
        let compiled = glob::Pattern::new(pattern)
            .map_err(|e| format!("invalid glob '{}': {}", pattern, e))?;
        if exclude {
            exclude_globs.push(compiled);
        } else {
            include_globs.push(compiled);
        }
    }

    let scope = search_dir
        .strip_prefix(&workspace_root)
        .unwrap_or(&search_dir)
        .to_string_lossy()
        .replace('\\', "/");
    let scope = if scope.is_empty() {
        ".".to_string()
    } else {
        scope
    };
    const MAX_SEARCH_FILE_BYTES: u64 = 8 * 1024 * 1024;
    let mut matches: Vec<serde_json::Value> = Vec::new();
    let mut diagnostics: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in walkdir::WalkDir::new(&search_dir)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        if matches.len() >= global_max {
            truncated = true;
            break;
        }
        let entry_path = entry.into_path();
        if !entry_path.is_file() {
            continue;
        }
        let relative = entry_path
            .strip_prefix(&workspace_root)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = match fs::metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            truncated = true;
            diagnostics.push(format!(
                "Skipped {}: file exceeds the 8 MB search limit",
                relative
            ));
            continue;
        }
        if relative
            .split('/')
            .any(|part| matches!(part, ".git" | "node_modules" | "dist" | "build" | "target"))
        {
            continue;
        }
        let matches_glob = |pattern: &glob::Pattern| {
            pattern.matches(&relative)
                || relative
                    .rsplit('/')
                    .next()
                    .map_or(false, |name| pattern.matches(name))
        };
        if include_globs.iter().any(|pattern| !matches_glob(pattern))
            || exclude_globs.iter().any(matches_glob)
        {
            continue;
        }
        let content = match tokio::fs::read_to_string(&entry_path).await {
            Ok(content) => content,
            Err(_) => continue,
        };
        let mut file_matches = 0usize;
        for (line_no, line) in content.lines().enumerate() {
            tokio::task::yield_now().await;
            if Instant::now() >= deadline {
                truncated = true;
                break;
            }
            if let Some(found) = expression.find(line) {
                if file_matches >= per_file {
                    truncated = true;
                    break;
                }
                matches.push(serde_json::json!({
                    "path": relative,
                    "line": line_no + 1,
                    "column": found.start() + 1,
                    "text": line,
                }));
                file_matches += 1;
                if matches.len() >= global_max {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }

    Ok(serde_json::json!({
        "kind": "code_search",
        "query": query,
        "scope": scope,
        "matches": matches,
        "truncated": truncated,
        "diagnostics": diagnostics,
        "fileSizeLimitBytes": MAX_SEARCH_FILE_BYTES,
        "searchedAt": format!("{:?}", std::time::SystemTime::now()),
    })
    .to_string())
}

#[cfg(test)]
mod code_searcher_tests {
    use super::*;

    #[tokio::test]
    async fn returns_regex_matches_with_scope_and_global_cap() {
        let workspace =
            std::env::temp_dir().join(format!("pure-code-search-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("create test workspace");
        fs::write(
            workspace.join("app.ts"),
            "const answer = 1;\nconst answerAgain = 2;\nconst other = 3;\n",
        )
        .expect("write test file");

        let result = code_searcher(
            workspace.to_string_lossy().to_string(),
            "answer".to_string(),
            None,
            None,
            Some(true),
            Some(10),
            Some(1),
            None,
        )
        .await
        .expect("code search succeeds");
        let payload: serde_json::Value = serde_json::from_str(&result).expect("valid result JSON");
        assert_eq!(payload["matches"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["matches"][0]["path"], "app.ts");
        assert_eq!(payload["matches"][0]["line"], 1);
        assert_eq!(payload["matches"][0]["column"], 7);
        assert_eq!(payload["truncated"], true);

        fs::remove_dir_all(&workspace).expect("remove test workspace");
    }
}

#[cfg(test)]
mod find_files_tests {
    use super::*;

    fn seed_workspace(name: &str) -> (std::path::PathBuf, String) {
        let ws = std::env::temp_dir().join(format!("pure-find-files-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("docs")).expect("create test workspace");
        fs::write(ws.join("学历证明.pdf"), "certificate of education").expect("write file");
        fs::write(ws.join("docs/resume.txt"), "我的学历：清华大学硕士\n工作经历：五年\n").expect("write file");
        fs::write(ws.join("docs/notes.txt"), "无相关内容").expect("write file");
        let ws_str = ws.to_string_lossy().to_string();
        (ws, ws_str)
    }

    #[test]
    fn finds_content_hit_after_stripping_cjk_stop_words() {
        let (ws, workspace) = seed_workspace("cjk");
        let result = find_files(workspace.clone(), "我的学历".to_string(), None, None, None, None).expect("find_files succeeds");
        assert!(result.contains("resume.txt"), "content hit listed: {}", result);
        assert!(result.contains("1 处命中"), "hit count shown: {}", result);
        fs::remove_dir_all(&ws).expect("remove test workspace");
    }

    #[test]
    fn ranks_content_hit_above_filename_only_match() {
        let (ws, workspace) = seed_workspace("rank");
        let result = find_files(workspace.clone(), "学历".to_string(), None, None, None, None).expect("find_files succeeds");
        assert!(result.contains("resume.txt"), "content hit listed: {}", result);
        assert!(result.contains("仅文件名命中"), "filename-only tier labeled: {}", result);
        let content_idx = result.find("resume.txt").expect("resume.txt present");
        let name_idx = result.find("学历证明.pdf").expect("pdf present");
        assert!(content_idx < name_idx, "content hit ranks above filename-only: {}", result);
        fs::remove_dir_all(&ws).expect("remove test workspace");
    }

    #[test]
    fn reports_fallback_when_nothing_matches() {
        let (ws, workspace) = seed_workspace("miss");
        let result = find_files(workspace.clone(), "太空旅行".to_string(), None, None, None, None).expect("find_files succeeds");
        assert!(result.contains("未找到匹配文件"), "fallback headline: {}", result);
        assert!(result.contains("兜底建议"), "fallback guidance: {}", result);
        fs::remove_dir_all(&ws).expect("remove test workspace");
    }

    #[test]
    fn rejects_empty_query() {
        let (ws, workspace) = seed_workspace("empty");
        let err = find_files(workspace.clone(), "   ".to_string(), None, None, None, None).unwrap_err();
        assert!(err.contains("query 不能为空"), "empty-query message: {}", err);
        fs::remove_dir_all(&ws).expect("remove test workspace");
    }

    #[test]
    fn rejects_query_that_tokenizes_to_only_stop_words() {
        let (ws, workspace) = seed_workspace("stops");
        let err = find_files(workspace.clone(), "的的的".to_string(), None, None, None, None).unwrap_err();
        assert!(err.contains("无法从查询"), "stop-word message: {}", err);
        fs::remove_dir_all(&ws).expect("remove test workspace");
    }
}

#[cfg(test)]
mod tokenize_find_query_tests {
    use super::tokenize_find_query;

    fn check(input: &str, expected: &[&str]) {
        assert_eq!(
            tokenize_find_query(input),
            expected.iter().map(|s| s.to_string()).collect::<Vec<String>>(),
            "tokenize_find_query({:?})",
            input
        );
    }

    #[test]
    fn matches_node_tokenize_find_query() {
        check("我的学历", &["学历"]);
        check("毕业证", &["业证", "毕业"]);
        check("太空旅行", &["太空", "旅行", "空旅"]);
        check("education", &["education"]);
        check("Education", &["education"]);
        check("abc", &["abc"]);
        check("ab", &[]);
        check("a1", &["a1"]);
        check("123", &["123"]);
        check("发票 学历", &["发票", "学历"]);
        check("的的的", &[]);
        check("abc学历", &["ab", "bc", "c学", "学历"]);
    }
}

#[tauri::command]
fn list_files(
    workspace: String,
    path: String,
    recursive: Option<bool>,
    max_results: Option<usize>,
) -> Result<String, String> {
    const DEFAULT_MAX_LIST_RESULTS: usize = 2000;
    const ABSOLUTE_MAX_LIST_RESULTS: usize = 5000;
    let dir = resolve(&workspace, &path)?;
    if dir.is_file() {
        return Err(format!(
            "list_files: '{}' 是文件而不是目录——读取文件内容请用 read_file，按名字查找请用 glob_files。",
            path
        ));
    }
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}（路径不存在或不是目录）", path));
    }

    let max = max_results
        .unwrap_or(DEFAULT_MAX_LIST_RESULTS)
        .clamp(1, ABSOLUTE_MAX_LIST_RESULTS);
    let mut items: Vec<String> = Vec::new();
    let mut truncated = false;

    if recursive.unwrap_or(false) {
        for entry in walkdir::WalkDir::new(&dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if items.len() >= max {
                truncated = true;
                break;
            }
            let rel = entry.path().strip_prefix(&dir).unwrap_or(entry.path());
            items.push(rel.to_string_lossy().to_string());
        }
    } else {
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))?;
        for entry in read_dir {
            if items.len() >= max {
                truncated = true;
                break;
            }
            let entry = entry.map_err(|e| format!("entry: {}", e))?;
            items.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    items.sort();
    if items.is_empty() {
        Ok("(empty directory)".to_string())
    } else {
        let listing = items.join("\n");
        if truncated {
            Ok(format!(
                "{}\n\n[截断] 仅显示前 {} 项；目录还有更多内容，请缩小 path 或使用 search_files/glob_files。",
                listing, max
            ))
        } else {
            Ok(listing)
        }
    }
}

#[tauri::command]
fn glob_files(
    workspace: String,
    pattern: String,
    path: Option<String>,
    max_results: Option<usize>,
) -> Result<String, String> {
    let search_dir = match &path {
        Some(p) if !p.is_empty() => resolve(&workspace, p)?,
        _ => resolve(&workspace, ".")?,
    };

    // Models echo Windows paths (D:\tmp\**) verbatim; on non-Windows platforms
    // backslashes are literal filename characters, so normalize.
    let mut pattern = pattern;
    #[cfg(not(windows))]
    {
        pattern = pattern.replace('\\', "/");
    }
    let glob_pattern = format!("{}/{}", search_dir.to_string_lossy(), pattern);
    let max = max_results.unwrap_or(200);

    let mut results: Vec<String> = Vec::new();

    for entry in glob::glob(&glob_pattern).map_err(|e| format!("glob: {}", e))? {
        if results.len() >= max {
            break;
        }
        let entry_path = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Only include files, skip directories
        if !entry_path.is_file() {
            continue;
        }
        let rel_path = entry_path
            .strip_prefix(&search_dir)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .to_string();
        results.push(rel_path);
    }

    results.sort();
    if results.is_empty() {
        Ok(format!("No files matching \"{}\"", pattern))
    } else {
        Ok(results.join("\n"))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Format-aware file text extraction
//  ═══════════════════════════════════════════════════════════════════════════════
//  read_file / search_files used to run bare fs::read_to_string: every non-UTF-8
//  file (GBK-encoded txt on Chinese Windows, UTF-16 exports) errored, and binary
//  formats (pdf / docx / xlsx) were either unreadable or silently skipped in
//  search. This module extracts human-readable text from the common local
//  formats so the model can actually read and search the user's files.

/// Hard cap for read_file. A file above this gets an actionable error (search
/// or a shell one-liner) instead of a multi-hundred-MB dump into the prompt.
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;
/// search_files skips files above this size (they would dominate the scan).
const MAX_SEARCH_FILE_BYTES: u64 = 32 * 1024 * 1024;

fn hex_digit(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => 16,
    }
}

/// Decode plain-text bytes with BOM detection and a CJK-friendly fallback
/// chain: UTF-8 strict → GB18030 (covers GBK, the ANSI default on Chinese
/// Windows) → Big5 → lossy Latin-1. encoding_rs decode never fails, so the
/// GB18030 step effectively catches every legacy-CJK file.
fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (cow, used, had_errors) = encoding_rs::GB18030.decode(bytes);
    if !had_errors || used == encoding_rs::GB18030 {
        return cow.into_owned();
    }
    let (cow, _, _) = encoding_rs::BIG5.decode(bytes);
    cow.into_owned()
}

/// Collect the text content inside every `<tag>…</tag>` element of an XML
/// document (docx `<w:t>`, xlsx `<t>`, pptx `<a:t>`, odt `<text:p>`). Nested
/// tags are flattened; XML entities are decoded; paragraphs joined with \n.
fn xml_text_in_tag(xml: &str, tag: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let mut reader = Reader::from_str(xml);
    let mut out: Vec<String> = Vec::new();
    let mut in_tag = false;
    let mut depth = 0usize;
    let mut pending = String::new();
    let mut buf = Vec::new();
    // quick-xml 0.38+ does NOT decode entities in the reader: `&amp;` arrives
    // as its own Event::GeneralRef and splits the surrounding text into
    // separate Text events. Accumulate fragments + refs verbatim and unescape
    // once per tag close, or the entity is lost entirely.
    let flush = |pending: &mut String, out: &mut Vec<String>| {
        let raw = std::mem::take(pending);
        let text = quick_xml::escape::unescape(&raw)
            .map(|cow| cow.into_owned())
            .unwrap_or(raw);
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    };
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if e.name().as_ref() == tag.as_bytes() {
                    in_tag = true;
                    depth = 1;
                } else if in_tag {
                    depth += 1;
                }
            }
            Ok(Event::End(_)) => {
                if in_tag {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        in_tag = false;
                        flush(&mut pending, &mut out);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if in_tag {
                    if let Ok(text) = t.decode() {
                        pending.push_str(&text);
                    }
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if in_tag {
                    // BytesRef carries only the entity NAME (`amp`, `#x1F`) —
                    // delimiters stripped. Normalize to `&name;` so the
                    // flush-time unescape can decode it.
                    let mut name = String::from_utf8_lossy(&r).into_owned();
                    if name.starts_with('&') {
                        name.remove(0);
                    }
                    if name.ends_with(';') {
                        name.pop();
                    }
                    pending.push('&');
                    pending.push_str(&name);
                    pending.push(';');
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    if in_tag {
        flush(&mut pending, &mut out);
    }
    out.join("\n")
}

/// Extract text from a single named XML entry of a ZIP container (docx/xlsx).
fn zip_entry_xml_text(bytes: &[u8], entry: &str, tag: &str) -> Option<String> {
    use std::io::Read as _;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut file = archive.by_name(entry).ok()?;
    let mut xml = String::new();
    file.read_to_string(&mut xml).ok()?;
    Some(xml_text_in_tag(&xml, tag))
}

/// Extract text from every XML entry whose name matches `predicate` (pptx
/// slides, odt content). Returns None when the archive or all entries fail.
fn zip_entries_xml_text(bytes: &[u8], predicate: impl Fn(&str) -> bool, tag: &str) -> Option<String> {
    use std::io::Read as _;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut out = String::new();
    let mut any = false;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).ok()?;
        let name = file.name().to_string();
        if !predicate(&name) {
            continue;
        }
        let mut xml = String::new();
        if file.read_to_string(&mut xml).is_err() {
            continue;
        }
        let text = xml_text_in_tag(&xml, tag);
        if !text.trim().is_empty() {
            out.push_str(&text);
            out.push('\n');
            any = true;
        }
    }
    if any {
        Some(out)
    } else {
        None
    }
}

/// Locate every `stream … endstream` body in a PDF byte buffer (raw scan —
/// the lossy-string conversion would corrupt binary stream data).
fn pdf_streams(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 6 <= bytes.len() {
        if &bytes[i..i + 6] == b"stream" {
            let mut j = i + 6;
            if j < bytes.len() && bytes[j] == b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                j += 1;
            }
            let start = j;
            if let Some(rel) = bytes[j..]
                .windows(9)
                .position(|w| w == b"endstream")
            {
                let mut end = j + rel;
                while end > start && matches!(bytes[end - 1], b'\n' | b'\r') {
                    end -= 1;
                }
                out.push(bytes[start..end].to_vec());
                i = j + rel + 9;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Inflate a PDF stream: try zlib-wrapped first, then raw deflate (some
/// producers skip the zlib header).
fn inflate_pdf_stream(stream: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::{DeflateDecoder, ZlibDecoder};
    use std::io::Read as _;
    let mut out = Vec::new();
    if ZlibDecoder::new(stream).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    out.clear();
    if DeflateDecoder::new(stream).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    None
}

fn is_ascii_text(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes.iter().all(|&b| b == b'\n' || b == b'\r' || b == b'\t' || (0x20..=0x7E).contains(&b))
}

fn looks_like_pdf_content(text: &str) -> bool {
    text.contains("Tj") || text.contains("TJ") || text.contains("BT") || text.contains("Tf")
}

fn hex_to_units(hex: &str) -> Vec<u16> {
    let bytes: Vec<u8> = hex.as_bytes().to_vec();
    let mut units = Vec::new();
    let mut i = 0usize;
    // Two hex chars = one byte; two bytes = one big-endian code unit (CID
    // codes and UTF-16BE mappings are 2-byte units, e.g. <C4E3> → 0xC4E3).
    // A trailing lone byte (odd count) becomes a unit on its own.
    let mut pending: Option<u8> = None;
    while i + 1 < bytes.len() {
        let hi = hex_digit(bytes[i]);
        let lo = hex_digit(bytes[i + 1]);
        if hi < 16 && lo < 16 {
            let byte = (hi << 4) | lo;
            match pending.take() {
                Some(first) => units.push(((first as u16) << 8) | byte as u16),
                None => pending = Some(byte),
            }
        }
        i += 2;
    }
    if let Some(b) = pending {
        units.push(b as u16);
    }
    units
}

fn parse_pdf_cmap(data: &[u8]) -> BTreeMap<u16, Vec<u16>> {
    let text = String::from_utf8_lossy(data);
    let mut map: BTreeMap<u16, Vec<u16>> = BTreeMap::new();
    let re_bfchar = regex::Regex::new(r"(?s)beginbfchar(.*?)endbfchar").unwrap();
    for caps in re_bfchar.captures_iter(&text) {
        let pair = regex::Regex::new(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>").unwrap();
        for m in pair.captures_iter(&caps[1]) {
            if let Some(src) = hex_to_units(&m[1]).first().copied() {
                map.insert(src, hex_to_units(&m[2]));
            }
        }
    }
    let re_bfrange = regex::Regex::new(r"(?s)beginbfrange(.*?)endbfrange").unwrap();
    let range = regex::Regex::new(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])").unwrap();
    for caps in re_bfrange.captures_iter(&text) {
        for m in range.captures_iter(&caps[1]) {
            let Some(lo) = hex_to_units(&m[1]).first().copied() else { continue };
            let Some(hi) = hex_to_units(&m[2]).first().copied() else { continue };
            if let Some(single) = m.get(3) {
                let mut dst = hex_to_units(single.as_str());
                let mut code = lo;
                while code <= hi {
                    map.insert(code, dst.clone());
                    // dst increments as a big-endian number for the next code
                    for unit in dst.iter_mut().rev() {
                        let next = unit.wrapping_add(1);
                        *unit = next;
                        if next != 0 {
                            break;
                        }
                    }
                    code = code.wrapping_add(1);
                }
            } else if let Some(arr) = m.get(4) {
                let list = regex::Regex::new(r"<([0-9A-Fa-f]+)>").unwrap();
                for (k, item) in list.captures_iter(arr.as_str()).enumerate() {
                    let code = lo.wrapping_add(k as u16);
                    if code <= hi {
                        map.insert(code, hex_to_units(&item[1]));
                    }
                }
            }
        }
    }
    map
}

/// Read one PDF string starting at `i` (`(` literal or `<` hex). Returns the
/// decoded text and the index just past the closing delimiter.
fn read_pdf_string(bytes: &[u8], i: usize, cmaps: &[BTreeMap<u16, Vec<u16>>]) -> (String, usize) {
    if bytes[i] == b'(' {
        let mut out = Vec::new();
        let mut j = i + 1;
        while j < bytes.len() {
            match bytes[j] {
                b'\\' => {
                    j += 1;
                    if j >= bytes.len() {
                        break;
                    }
                    match bytes[j] {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut octal = 0u32;
                            for _ in 0..3 {
                                if j < bytes.len() && (b'0'..=b'7').contains(&bytes[j]) {
                                    octal = octal * 8 + (bytes[j] - b'0') as u32;
                                    j += 1;
                                } else {
                                    break;
                                }
                            }
                            out.push(octal as u8);
                            j -= 1;
                        }
                        other => out.push(other),
                    }
                    j += 1;
                }
                b')' => return (String::from_utf8_lossy(&out).into_owned(), j + 1),
                other => {
                    out.push(other);
                    j += 1;
                }
            }
        }
        return (String::from_utf8_lossy(&out).into_owned(), j);
    }
    // hex string <…> — codes map through the document's ToUnicode CMaps
    let close = bytes[i..]
        .iter()
        .position(|&b| b == b'>')
        .map(|rel| i + rel)
        .unwrap_or(bytes.len());
    let hex = String::from_utf8_lossy(&bytes[i + 1..close]);
    let units = hex_to_units(&hex);
    let mut out = String::new();
    let mut k = 0usize;
    while k < units.len() {
        let code = units[k];
        if let Some(mapped) = cmaps.iter().find_map(|cmap| cmap.get(&code)) {
            if mapped.len() >= 2 && (0xD800..=0xDBFF).contains(&mapped[0]) && (0xDC00..=0xDFFF).contains(&mapped[1]) {
                let cp = 0x10000 + (((mapped[0] - 0xD800) as u32) << 10) + (mapped[1] - 0xDC00) as u32;
                out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                k += 2;
                continue;
            }
            for &u in mapped {
                out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            }
            k += 1;
            continue;
        }
        if code < 256 {
            out.push(code as u8 as char);
        }
        k += 1;
    }
    (out, close + 1)
}

/// Extract the text of one PDF content stream: literal `(…)` and hex `<…>`
/// strings, TJ arrays, with newlines at positioning operators (Td/TD/T*/Tm)
/// and block boundaries (BT/ET).
fn pdf_content_text(content: &[u8], cmaps: &[BTreeMap<u16, Vec<u16>>]) -> String {
    let mut out = String::new();
    let mut line = String::new();
    let flush = |line: &mut String, out: &mut String| {
        if !line.is_empty() {
            out.push_str(line);
            out.push('\n');
            line.clear();
        }
    };
    let mut i = 0usize;
    let n = content.len();
    while i < n {
        let b = content[i];
        match b {
            b'(' | b'<' => {
                let (text, next) = read_pdf_string(content, i, cmaps);
                line.push_str(&text);
                i = next;
            }
            b'[' => {
                // TJ array: strings (and kerning numbers) until the closing ]
                i += 1;
                while i < n && content[i] != b']' {
                    if content[i] == b'(' || content[i] == b'<' {
                        let (text, next) = read_pdf_string(content, i, cmaps);
                        line.push_str(&text);
                        i = next;
                    } else {
                        i += 1;
                    }
                }
                if i < n {
                    i += 1;
                }
            }
            b'A'..=b'Z' | b'a'..=b'z' => {
                let start = i;
                while i < n && content[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let op = &content[start..i];
                // positioning operators end the current visual line
                if matches!(op, b"Tj" | b"TJ" | b"Td" | b"TD" | b"T*" | b"Tm" | b"TL" | b"BT" | b"ET" | b"'" | b"\"") {
                    flush(&mut line, &mut out);
                }
            }
            _ => i += 1,
        }
    }
    flush(&mut line, &mut out);
    out
}

/// Best-effort PDF text extraction. Collects streams, separates ToUnicode
/// CMaps from content streams, inflates both, and extracts strings (CID fonts
/// resolve through the CMaps — the usual way Chinese PDFs encode text).
/// Returns (text, note) where note is only set when nothing usable was found.
fn pdf_extract_text(bytes: &[u8]) -> (String, String) {
    let streams = pdf_streams(bytes);
    let mut cmaps: Vec<BTreeMap<u16, Vec<u16>>> = Vec::new();
    let mut contents: Vec<Vec<u8>> = Vec::new();
    for raw in &streams {
        let inflated = inflate_pdf_stream(raw).filter(|data| !data.is_empty()).or_else(|| {
            if is_ascii_text(raw) {
                Some(raw.clone())
            } else {
                None
            }
        });
        let Some(data) = inflated else { continue };
        let text = String::from_utf8_lossy(&data);
        if text.contains("beginbfchar") || text.contains("beginbfrange") {
            cmaps.push(parse_pdf_cmap(&data));
        } else if looks_like_pdf_content(&text) {
            contents.push(data);
        }
    }
    let mut extracted = String::new();
    for content in &contents {
        extracted.push_str(&pdf_content_text(content, &cmaps));
    }
    let text = extracted.trim().to_string();
    if text.is_empty() {
        (
            String::new(),
            "PDF 未提取到文本：可能是扫描/图片型 PDF（无文本层），或使用了无法解析的字体编码。可尝试用 OCR 工具，或把 PDF 转成文本/图片后再读取。".to_string(),
        )
    } else {
        (text, String::new())
    }
}

/// Extract readable text from RTF (Chinese WordPad/WPS RTF escapes text as
/// `\'hh` GBK bytes; newer files use `\uN` unicode escapes — both handled).
fn rtf_extract_text(bytes: &[u8]) -> String {
    let mut ansi_bytes: Vec<u8> = Vec::new();
    let mut unicode: String = String::new();
    let mut is_gbk = false;
    let mut i = 0usize;
    let n = bytes.len();
    while i < n {
        match bytes[i] {
            b'\\' => {
                i += 1;
                if i >= n {
                    break;
                }
                if bytes[i] == b'\'' {
                    i += 1;
                    if i + 1 < n {
                        let hi = hex_digit(bytes[i]);
                        let lo = hex_digit(bytes[i + 1]);
                        if hi < 16 && lo < 16 {
                            ansi_bytes.push(hi * 16 + lo);
                        }
                        i += 2;
                    }
                } else if bytes[i] == b'u' {
                    i += 1;
                    let mut sign = 1i64;
                    if i < n && bytes[i] == b'-' {
                        sign = -1;
                        i += 1;
                    }
                    let mut num = 0i64;
                    while i < n && bytes[i].is_ascii_digit() {
                        num = num * 10 + (bytes[i] - b'0') as i64;
                        i += 1;
                    }
                    let mut cp = num * sign;
                    if cp < 0 {
                        cp += 65536;
                    }
                    if let Some(c) = char::from_u32(cp as u32) {
                        unicode.push(c);
                    }
                    // `\uN?` — the single ANSI fallback char follows; skip it
                    if i < n && bytes[i] != b'\\' {
                        i += 1;
                    }
                } else {
                    let start = i;
                    while i < n && bytes[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = &bytes[start..i];
                    let mut arg = 0i64;
                    if i < n && bytes[i] == b'-' {
                        i += 1;
                    }
                    while i < n && bytes[i].is_ascii_digit() {
                        arg = arg * 10 + (bytes[i] - b'0') as i64;
                        i += 1;
                    }
                    if word == b"ansicpg" && arg == 936 {
                        is_gbk = true;
                    }
                    // delimiter space is part of the control word
                    if i < n && bytes[i] == b' ' {
                        i += 1;
                    }
                }
            }
            b'{' | b'}' | b'\r' => i += 1,
            _ => {
                ansi_bytes.push(bytes[i]);
                i += 1;
            }
        }
    }
    let mut decoded = if is_gbk || std::str::from_utf8(&ansi_bytes).is_err() {
        let (cow, _, _) = encoding_rs::GB18030.decode(&ansi_bytes);
        cow.into_owned()
    } else {
        String::from_utf8_lossy(&ansi_bytes).into_owned()
    };
    if !unicode.is_empty() {
        if !decoded.trim().is_empty() {
            decoded.push('\n');
        }
        decoded.push_str(&unicode);
    }
    decoded.trim().to_string()
}

/// True when the bytes are a NUL-heavy or mostly non-printable blob (i.e. a
/// binary file rather than any text encoding).
fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let sample_len = bytes.len().min(8192);
    let sample = &bytes[..sample_len];
    if sample.contains(&0) {
        return true;
    }
    let printable = sample
        .iter()
        .filter(|&&b| b == b'\n' || b == b'\r' || b == b'\t' || (0x20..=0x7E).contains(&b) || b >= 0x80)
        .count();
    printable * 10 < sample_len * 9
}

fn describe_binary(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "PNG 图片"
    } else if bytes.starts_with(b"\xFF\xD8") {
        "JPEG 图片"
    } else if bytes.starts_with(b"GIF8") {
        "GIF 图片"
    } else if bytes.starts_with(b"\x89JFIF") || bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        "TIFF 图片"
    } else if bytes.starts_with(b"\x1F\x8B") {
        "GZIP 压缩文件"
    } else if bytes.starts_with(b"7z\xBC\xAF\x27\x1C") {
        "7z 压缩文件"
    } else if bytes.starts_with(b"Rar!") {
        "RAR 压缩文件"
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        "ICO 图片"
    } else if bytes.starts_with(b"\x25\x50\x44\x46") {
        "PDF"
    } else if bytes.starts_with(b"PK") {
        "ZIP 压缩包（可能是 .docx/.xlsx 或普通压缩文件）"
    } else if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        "OLE2 复合文档（旧版 .doc/.xls）"
    } else {
        "未知二进制文件"
    }
}

/// The main dispatcher: turn a local file's bytes into readable text.
/// Returns (text, note) — note is ONLY set when nothing usable was extracted
/// and carries an actionable hint (conversion suggestion / OCR advice) instead
/// of the old bare UTF-8 error.
fn extract_file_text(bytes: &[u8], path: &std::path::Path) -> (String, String) {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // ZIP-based office formats (docx / xlsx / pptx / odt…)
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        let (text, note): (Option<String>, String) = match ext.as_str() {
            "docx" | "docm" => (zip_entry_xml_text(bytes, "word/document.xml", "w:t"), String::new()),
            "xlsx" | "xlsm" => (zip_entry_xml_text(bytes, "xl/sharedStrings.xml", "t"), String::new()),
            "pptx" | "pptm" => (zip_entries_xml_text(bytes, |name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"), "a:t"), String::new()),
            "odt" | "ods" | "odp" => (zip_entries_xml_text(bytes, |name| name == "content.xml", "text:p"), String::new()),
            _ => (None, format!("文件扩展名 .{} 不是支持的文档格式（支持 docx/xlsx/pptx/odt/ods/odp）。", ext)),
        };
        match text {
            Some(t) if !t.trim().is_empty() => return (t, String::new()),
            Some(_) => return (String::new(), format!("{} 未提取到文本内容（文档可能为空或内容为图片）。", ext.to_uppercase())),
            None => return (String::new(), note),
        }
    }
    // PDF
    if bytes.starts_with(b"%PDF") {
        return pdf_extract_text(bytes);
    }
    // RTF
    if bytes.starts_with(b"{\\rtf") {
        return (rtf_extract_text(bytes), String::new());
    }
    // OLE2 compound documents (.doc / .xls) — not directly parseable
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        return (
            String::new(),
            format!("{} 是旧版二进制文档（.doc/.xls），无法直接解析文本。请用 Word/WPS 另存为 .docx/.xlsx/.txt，或执行转换命令（例如 soffice --headless --convert-to txt \"{}\"）。", name, name),
        );
    }
    // Everything else: text with encoding detection, or a clear binary note
    if looks_binary(bytes) {
        return (String::new(), format!("二进制文件（{}），不是文本文件，无法读取内容。", describe_binary(bytes)));
    }
    (decode_text_bytes(bytes), String::new())
}
// ═══════════════════════════════════════════════════════════════════════════════

/// Windows PowerShell 5.1 exits 0 after `-Command` unless the script calls
/// `exit` itself — a failing command would otherwise report as success. Wrap
/// every command with an explicit exit: `$?` is false for BOTH a failing
/// native command ($LASTEXITCODE set) and a failing cmdlet, so the wrapper
/// reports either as non-zero. The specific code is normalized to 1, which is
/// all the execute_command contract needs (0 vs non-zero; stderr carries the
/// details).
#[cfg(windows)]
fn powershell_command_wrapped(command: &str) -> String {
    format!("{}; if ($?) {{ exit $LASTEXITCODE }} else {{ exit 1 }}", command)
}

/// Encode text as base64 of its UTF-16LE bytes — the transport PowerShell's
/// `-EncodedCommand` expects. Kept available in tests on every platform; the
/// production helper is compiled only where the Windows caller exists.
#[cfg(any(windows, test))]
fn utf16le_base64(text: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

/// Encode a command for `powershell.exe -EncodedCommand` (base64 of UTF-16LE).
/// Passing the command as a plain `-Command` argument subjects it to the
/// Windows command-line quoting rules (CommandLineToArgvW-style `\"` escaping),
/// which PowerShell re-parses differently — double quotes inside the command
/// can silently break it. The encoded form carries the raw bytes untouched.
/// The exit-code wrapper from powershell_command_wrapped rides along.
#[cfg(windows)]
fn powershell_encoded_command(command: &str) -> String {
    utf16le_base64(&powershell_command_wrapped(command))
}

#[cfg(test)]
mod powershell_command_tests {
    use super::*;

    #[test]
    fn utf16le_base64_round_trips_ascii_and_double_quotes() {
        let original = "Write-Output \"hello world\"";
        let encoded = utf16le_base64(original);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("base64 decodes");
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), original);
    }

    #[test]
    fn utf16le_base64_handles_cjk() {
        let original = "中文路径 \"C:\\数据\".txt";
        let encoded = utf16le_base64(original);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("base64 decodes");
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), original);
    }
}

#[cfg(test)]
mod sys_info_cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn fake_volatile(marker: &str) -> SysInfoVolatile {
        SysInfoVolatile {
            system_proxy: format!("proxy-{}", marker),
            env_proxy: "none".to_string(),
            vpn: "none".to_string(),
            reach: "domestic ok, international ok".to_string(),
        }
    }

    fn make_probe(
        calls: Arc<AtomicUsize>,
        marker: &'static str,
    ) -> impl std::future::Future<Output = SysInfoVolatile> {
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            fake_volatile(marker)
        }
    }

    /// The GUI regression the TTL exists for: a proxy toggle must NOT show up
    /// in sys_info immediately (the cached block serves), but MUST after the
    /// TTL elapses (the next call re-probes).
    #[tokio::test]
    async fn volatile_cache_serves_within_ttl_and_refreshes_after() {
        let cache: tokio::sync::Mutex<Option<(std::time::Instant, SysInfoVolatile)>> =
            tokio::sync::Mutex::const_new(None);
        let ttl = Duration::from_secs(300);
        let t0 = std::time::Instant::now();
        let calls = Arc::new(AtomicUsize::new(0));

        // Cold call: probes once.
        let v1 = cached_sys_info_volatile_impl(&cache, t0, ttl, make_probe(calls.clone(), "a")).await;
        assert_eq!(v1.system_proxy, "proxy-a");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Just inside the TTL (proxy toggled 1s ago): cached block, no probe.
        let v2 = cached_sys_info_volatile_impl(
            &cache,
            t0 + Duration::from_secs(299),
            ttl,
            make_probe(calls.clone(), "b"),
        )
        .await;
        assert_eq!(v2.system_proxy, "proxy-a");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Just past the TTL: re-probes and refreshes the cache.
        let v3 = cached_sys_info_volatile_impl(
            &cache,
            t0 + Duration::from_secs(301),
            ttl,
            make_probe(calls.clone(), "c"),
        )
        .await;
        assert_eq!(v3.system_proxy, "proxy-c");
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // The refreshed block now serves inside its own TTL window.
        let v4 = cached_sys_info_volatile_impl(
            &cache,
            t0 + Duration::from_secs(400),
            ttl,
            make_probe(calls.clone(), "d"),
        )
        .await;
        assert_eq!(v4.system_proxy, "proxy-c");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// A stale probe result from a concurrent slow path must not clobber a
    /// cache line another caller just refreshed.
    #[tokio::test]
    async fn concurrent_slow_path_keeps_the_fresher_cache_line() {
        let cache: tokio::sync::Mutex<Option<(std::time::Instant, SysInfoVolatile)>> =
            tokio::sync::Mutex::const_new(None);
        let ttl = Duration::from_secs(300);
        let t0 = std::time::Instant::now();
        let calls = Arc::new(AtomicUsize::new(0));

        let (v1, v2) = tokio::join!(
            cached_sys_info_volatile_impl(&cache, t0, ttl, make_probe(calls.clone(), "a")),
            cached_sys_info_volatile_impl(&cache, t0, ttl, make_probe(calls.clone(), "b")),
        );
        // Both callers get a coherent result (either probe's)…
        assert!(v1.system_proxy == "proxy-a" || v1.system_proxy == "proxy-b");
        assert!(v2.system_proxy == "proxy-a" || v2.system_proxy == "proxy-b");
        // …and the cache holds the last writer's value for the rest of the TTL.
        let v3 = cached_sys_info_volatile_impl(
            &cache,
            t0 + Duration::from_secs(60),
            ttl,
            make_probe(calls.clone(), "c"),
        )
        .await;
        assert_eq!(v3.system_proxy, v1.system_proxy);
    }
}

#[cfg(test)]
mod sys_info_manual_regression {
    use super::*;

    /// Manual GUI regression for the caching work: two real sys_info calls
    /// through the same command path the frontend uses. Everything except the
    /// live `time:` line must be identical (the second call is served from the
    /// process-level caches), and the per-call timings are printed for a
    /// sanity check (cold ≈ seconds, hot ≈ ms). Hits the network (ip geo +
    /// reachability), so it is #[ignore]d by default:
    ///   cargo test -- --ignored sys_info_manual
    #[tokio::test]
    #[ignore = "network: manual GUI sys_info regression"]
    async fn real_sys_info_second_call_hits_cache() {
        let t0 = std::time::Instant::now();
        let first = sys_info(String::new(), None).await.expect("first sys_info succeeds");
        let t1 = std::time::Instant::now();
        let second = sys_info(String::new(), None).await.expect("second sys_info succeeds");
        let t2 = std::time::Instant::now();
        eprintln!(
            "sys_info regression — first call: {:?}, second call: {:?}",
            t1 - t0,
            t2 - t1
        );
        fn strip_time(s: &str) -> Vec<&str> {
            s.lines().filter(|l| !l.starts_with("time:")).collect()
        }
        assert_eq!(strip_time(&first), strip_time(&second));
        assert!(first.contains("runtimes: ") && second.contains("runtimes: "));
        assert!(first.contains("network:   proxy:") && second.contains("network:   proxy:"));
    }
}

/// Execute a shell command and return all output at once.
/// Uses tokio::process::Command so it does NOT block the async runtime.
/// Returns structured `{ exitCode, stdout, stderr }` so the frontend can tell
/// a failed command (non-zero exit) apart from a successful one instead of
/// squashing everything into a `success: true` string.
#[tauri::command]
async fn execute_command(workspace: String, command: String, proxy_url: Option<String>) -> Result<serde_json::Value, String> {
    // Unix shells run `sh -c`, Windows runs PowerShell (whose directory/file
    // commands and quoting rules are the ones the model is instructed to use).
    let output = {
        #[cfg(unix)]
        let mut cmd = silent_child_tokio(TokioCommand::new("sh"));
        #[cfg(windows)]
        let mut cmd = silent_child_tokio(TokioCommand::new("powershell"));
        #[cfg(unix)]
        cmd.arg("-c");
        #[cfg(windows)]
        cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        // -EncodedCommand (base64 UTF-16LE) bypasses the Windows command-line
        // quoting mangling; the encoding also carries the exit-code wrapper.
        #[cfg(windows)]
        cmd.arg(powershell_encoded_command(&command));
        #[cfg(not(windows))]
        cmd.arg(&command);
        // A Finder-launched app inherits a minimal PATH; inject the extended
        // probe PATH so `node` / `bun` / `python3` / nvm / Homebrew commands
        // actually resolve (see probe_extra_path_dirs).
        #[cfg(unix)]
        cmd.env("PATH", probe_path());
        cmd.current_dir(&workspace);
        if let Some(resolved) = effective_proxy_url(proxy_url.as_deref().unwrap_or("")) {
            if !valid_proxy_url(&resolved) {
                return Err("proxy: URL must start with http://, https://, socks5://, or socks5h://".to_string());
            }
            cmd.env("HTTP_PROXY", &resolved)
                .env("HTTPS_PROXY", &resolved)
                .env("ALL_PROXY", &resolved)
                .env("NO_PROXY", "localhost,127.0.0.1,::1");
        }
        cmd.output()
            .await
            .map_err(|e| format!("execute_command: {}", e))?
    };

    Ok(serde_json::json!({
        "exitCode": output.status.code().unwrap_or(-1),
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
    }))
}

/// Track running shell commands (keyed by the LLM tool-call id) so the GUI can
/// cancel one mid-run: execute_command_stream registers the child pid when it
/// starts and removes it when it exits; kill_command SIGKILLs the process
/// group. The child is spawned with process_group(0), so its pgid equals its
/// pid and killing the group takes down sh plus any grandchildren (npm
/// install, cargo build, …) instead of orphaning them.
type CommandRegistry = StdMutex<BTreeMap<String, u32>>;

// Track in-flight LLM streaming requests (keyed by a per-call request id) so
// the GUI can abort one mid-stream: chat_stream registers a oneshot cancel
// Sender under `requestId` when it starts and removes it when it finishes
// (via ChatCancelGuard, which fires on every exit path); a Stop click calls
// cancel_chat_stream, which sends on that channel. The stream loop then
// selects on it and bails out of the SSE read immediately — instead of the
// abandoned task lingering (generating AND billing output tokens) until the
// idle timeout. Mirror of the CommandRegistry pattern above.
type ChatStreamRegistry = Arc<StdMutex<BTreeMap<String, tokio::sync::oneshot::Sender<()>>>>;

/// Spawn `sh -c <command>` in its own process group (Unix) so a cancellation
/// can kill the whole command tree. process_group(0) makes the child its own
/// group leader (pgid == pid), which is what kill_process_group targets.
fn spawn_shell_command(workspace: &str, command: &str, proxy_url: Option<&str>) -> std::io::Result<Child> {
    // Unix shells run `sh -c`, Windows runs PowerShell (whose directory/file
    // commands and quoting rules are the ones the model is instructed to use).
    #[cfg(unix)]
    let mut cmd = {
        let mut c = silent_child_tokio(TokioCommand::new("sh"));
        c.arg("-c");
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = silent_child_tokio(TokioCommand::new("powershell"));
        c.args(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        c
    };
    // -EncodedCommand (base64 UTF-16LE) bypasses the Windows command-line
    // quoting mangling; the encoding also carries the exit-code wrapper.
    #[cfg(windows)]
    let encoded_command = powershell_encoded_command(command);
    #[cfg(windows)]
    cmd.arg(&encoded_command);
    #[cfg(not(windows))]
    cmd.arg(command);
    // A Finder-launched app inherits a minimal PATH; inject the extended
    // probe PATH so `node` / `bun` / `python3` / nvm / Homebrew commands
    // actually resolve (see probe_extra_path_dirs).
    #[cfg(unix)]
    cmd.env("PATH", probe_path());
    cmd.current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    if let Some(resolved) = effective_proxy_url(proxy_url.unwrap_or("")) {
        if !valid_proxy_url(&resolved) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "proxy URL must start with http://, https://, socks5://, or socks5h://"));
        }
        cmd.env("HTTP_PROXY", &resolved)
            .env("HTTPS_PROXY", &resolved)
            .env("ALL_PROXY", &resolved)
            .env("NO_PROXY", "localhost,127.0.0.1,::1");
    }
    cmd.spawn()
}

/// Send SIGKILL to the process group led by `pid` (negative pgid kills the
/// whole group on Unix — the child was spawned with process_group(0), so its
/// pgid equals its pid).
#[cfg(unix)]
fn kill_process_group(pid: i32) -> std::io::Result<()> {
    let ret = unsafe { libc::kill(-pid, libc::SIGKILL) };
    if ret == 0 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        // ESRCH: the process already exited (normal race between command
        // completion and a kill arriving) — nothing to kill, treat as success.
        if err.kind() == std::io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(err)
        }
    }
}

#[cfg(windows)]
fn kill_process_group(pid: i32) -> std::io::Result<()> {
    // Windows has no POSIX process groups; terminate the whole command tree
    // (/T) forcibly (/F) via taskkill. A missing process (normal race between
    // command completion and a kill arriving) is treated as success.
    let status = silent_child(std::process::Command::new("taskkill"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()?;
    if status.success() {
        Ok(())
    } else if status.code() == Some(128) {
        // ERROR_PROC_NOT_FOUND: the process already exited (normal race between
        // command completion and a kill arriving) — treat as success, mirroring
        // the Unix ESRCH handling.
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("taskkill exit {:?}", status.code()),
        ))
    }
}

/// Core of execute_command_stream, split out for unit testing (a Tauri
/// CommandRegistry State can't be constructed inside a plain test).
async fn execute_command_stream_inner(
    registry: &StdMutex<BTreeMap<String, u32>>,
    id: &str,
    workspace: &str,
    command: &str,
    on_output: &Channel<String>,
    proxy_url: Option<&str>,
) -> Result<i32, String> {
    let mut child = spawn_shell_command(workspace, command, proxy_url).map_err(|e| format!("spawn: {}", e))?;

    // Take the pipes BEFORE registering so an early return on a missing pipe
    // (practically impossible with Stdio::piped, but the API allows it) can't
    // leave a stale pid in the registry.
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Register the running process under the tool-call id so the GUI can
    // cancel it mid-run (kill_command). An empty id (legacy callers) skips
    // registration — the command still runs, just uncancellable.
    let pid = child.id().unwrap_or(0);
    if !id.is_empty() {
        let mut reg = registry.lock().map_err(|e| format!("lock: {}", e))?;
        reg.insert(id.to_string(), pid);
    }

    let ch_stdout = on_output.clone();
    let ch_stderr = on_output.clone();

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let chunk = serde_json::json!({ "type": "stdout", "content": line.trim_end() });
                    if ch_stdout.send(chunk.to_string()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let chunk = serde_json::json!({ "type": "stderr", "content": line.trim_end() });
                    if ch_stderr.send(chunk.to_string()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Wait for both readers to finish independently
    let _ = tokio::join!(stdout_task, stderr_task);

    let wait_result = child.wait().await;

    // Always unregister, even when wait failed (the process may already be
    // gone) — a stale entry would make a later kill_command target a reused
    // pid and kill an unrelated process.
    if !id.is_empty() {
        let mut reg = registry.lock().map_err(|e| format!("lock: {}", e))?;
        reg.remove(id);
    }

    // Now get the exit code (on_output is still available since only clones were moved)
    let exit_code = wait_result
        .map_err(|e| format!("wait: {}", e))?
        .code()
        .unwrap_or(-1);
    let done = serde_json::json!({ "type": "exit", "code": exit_code });
    let _ = on_output.send(done.to_string());

    Ok(exit_code)
}

/// Execute a shell command with streaming output via Channel (safe concurrent reader pattern).
/// Uses `tokio::spawn` + `tokio::join!` so both stdout and stderr are read independently
/// — no data loss when one pipe closes before the other. The command is registered in the
/// CommandRegistry under `id` while it runs, so the GUI can cancel it (kill_command) when
/// the user stops the turn.
#[tauri::command]
async fn execute_command_stream(
    state: tauri::State<'_, CommandRegistry>,
    id: String,
    workspace: String,
    command: String,
    on_output: Channel<String>,
    proxy_url: Option<String>,
) -> Result<i32, String> {
    execute_command_stream_inner(&state, &id, &workspace, &command, &on_output, proxy_url.as_deref()).await
}

/// Kill a running command started via execute_command_stream. The GUI calls
/// this when the turn is cancelled (Stop button): the shell tree is SIGKILLed
/// as a process group so grandchildren don't survive as background orphans.
/// No-op when the id is unknown (already exited or never registered).
#[tauri::command]
async fn kill_command(state: tauri::State<'_, CommandRegistry>, id: String) -> Result<(), String> {
    let pid = {
        let mut reg = state.lock().map_err(|e| format!("lock: {}", e))?;
        reg.remove(&id)
    };
    if let Some(pid) = pid {
        kill_process_group(pid as i32).map_err(|e| format!("kill: {}", e))?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Git Tools
// ═══════════════════════════════════════════════════════════════════════════════

fn run_git(workspace: &str, args: &[String]) -> Result<String, String> {
    let output = silent_child(std::process::Command::new("git"))
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|e| format!("git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git failed: {}", msg.trim()));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

#[tauri::command]
fn git_diff(
    workspace: String,
    staged: Option<bool>,
    path: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["diff".into()];
    if staged.unwrap_or(false) {
        args.push("--staged".into());
    }
    args.push("--".into());
    if let Some(p) = path {
        args.push(p);
    }
    run_git(&workspace, &args)
}

#[tauri::command]
fn git_log(
    workspace: String,
    max_count: Option<u32>,
    oneline: Option<bool>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["log".into()];
    let n = max_count
        .map(|n| n.to_string())
        .unwrap_or_else(|| "10".into());
    args.push("-n".into());
    args.push(n);
    if oneline.unwrap_or(true) {
        args.push("--oneline".into());
    }
    run_git(&workspace, &args)
}

#[tauri::command]
fn git_status(workspace: String) -> Result<String, String> {
    run_git(&workspace, &["status".into(), "--short".into()])
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Create Directory
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn create_directory(workspace: String, path: String) -> Result<String, String> {
    let full = resolve(&workspace, &path)?;
    fs::create_dir_all(&full).map_err(|e| format!("mkdir: {}", e))?;
    Ok(format!("Created directory: {}", path))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Diff Files
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn diff_files(workspace: String, path_a: String, path_b: String) -> Result<String, String> {
    let full_a = resolve(&workspace, &path_a)?;
    let full_b = resolve(&workspace, &path_b)?;

    // Windows ships no `diff` binary; fall back to `git diff --no-index` (Git
    // for Windows ships git.exe) which reports differences with the same
    // exit-code convention (0 identical / 1 differs).
    let output = match silent_child(std::process::Command::new("diff"))
        .arg("-u")
        .arg(&full_a)
        .arg(&full_b)
        .output()
    {
        Ok(o) => o,
        Err(_) => silent_child(std::process::Command::new("git"))
            .args(["diff", "--no-index", "--"])
            .arg(&full_a)
            .arg(&full_b)
            .output()
            .map_err(|e| format!("diff: {}", e))?,
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    match output.status.code() {
        Some(0) => Ok("(files are identical)".to_string()),
        Some(1) => Ok(if stdout.is_empty() { stderr } else { stdout }),
        _ => Err(if stderr.is_empty() {
            "diff failed".to_string()
        } else {
            stderr
        }),
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Web Search (multi-backend, Chinese-priority: cn.bing.com → DuckDuckGo → Bing)
// ═══════════════════════════════════════════════════════════════════════════════
// DuckDuckGo is unreachable on some networks (connection timeouts / blocks),
// which used to make EVERY search fail with a generic request error — the
// agent then saw a wall of identical failures with no way out. The search now
// tries backends in order and stops at the first one that yields results, so
// a dead backend degrades to a working one instead of a hard failure.
//
// CJK queries get a Chinese-priority order: international Bing frequently
// serves a block page and DuckDuckGo returns IRRELEVANT results for Chinese
// (tested: "西安到重庆 机票" → unrelated education/tax sites), which pushed
// the agent into repeated searches. cn.bing.com returns real Chinese results
// with the SAME b_algo markup, so it is tried FIRST for CJK queries. A
// browser User-Agent + redirect following keeps the endpoints responsive.
// Platform-appropriate: Windows IP sending a macOS UA is a contradiction
// signal that advanced bot detection (Cloudflare, etc.) flags.
// Chrome version tracks current stable (verified via Google versionhistory API).
#[cfg(target_os = "windows")]
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.54 Safari/537.36";

#[cfg(not(target_os = "windows"))]
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.54 Safari/537.36";

// ── Charset-aware HTTP body decoding ──
// `Response::text()` only honors a Content-Type charset when one is declared
// and silently assumes UTF-8 otherwise — GBK/GB2312 pages (common on Chinese
// sites) then decode as mojibake. The charset is resolved in priority order:
// Content-Type header charset → HTML <meta> charset sniff → UTF-8. Mirrors
// readResponseText in src/adapter/node/NodeToolAdapter.ts.

/// Extract the charset parameter from a Content-Type header, if declared.
fn charset_from_content_type(content_type: &str) -> Option<String> {
    let lower = content_type.to_lowercase();
    let idx = lower.find("charset")?;
    // Skip whitespace around the `=` (nonstandard `charset = gb2312` headers)
    // so the Rust parse mirrors the Node regex `charset\s*=\s*`.
    let after_eq = lower[idx + "charset".len()..]
        .trim_start()
        .strip_prefix('=')?;
    let mut rest = after_eq.trim_start();
    if rest.starts_with('"') || rest.starts_with('\'') {
        rest = &rest[1..];
    }
    let end = rest.find([';', '"', '\'']).unwrap_or(rest.len());
    let label = rest[..end].trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// Sniff `<meta charset=…>` / `<meta http-equiv="Content-Type" content="…charset=…">`
/// from the first bytes of an HTML page. The meta tag is ASCII, so scanning a
/// lossily-UTF-8-decoded head slice is safe even when the body is GBK.
fn sniff_html_charset(head: &[u8]) -> Option<String> {
    let lower = String::from_utf8_lossy(head).to_lowercase();
    let start = lower.find("<meta")?;
    let tag_end = lower[start..].find('>')? + start;
    let tag = &lower[start..tag_end];
    let cs = tag.find("charset=")?;
    let after = &tag[cs + "charset=".len()..];
    let stop = after
        .find(|c: char| c == '"' || c == '\'' || c == ' ' || c == ';' || c == '/')
        .unwrap_or(after.len());
    let label: String = after[..stop]
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

/// Decode bytes with a resolved charset label, falling back to UTF-8.
/// encoding_rs normalizes WHATWG labels (gb2312/gb_2312-80 → GBK), so the
/// declared label is passed through; utf-8-family and latin1 labels (the
/// common mislabel for actually-UTF-8 pages) skip re-decoding to avoid
/// regressions. A leading BOM is stripped on both paths (mirrors the Node
/// TextDecoder and the old reqwest .text() behavior).
fn decode_bytes_with_label(bytes: &[u8], label: Option<&str>) -> String {
    let encoding = label
        .filter(|l| !is_utf8_family_label(l))
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()));
    let (decoded, _) = match encoding {
        Some(enc) => enc.decode_with_bom_removal(bytes),
        None => encoding_rs::UTF_8.decode_with_bom_removal(bytes),
    };
    decoded.into_owned()
}

async fn response_text_with_charset(resp: reqwest::Response) -> Result<String, String> {
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("read: {}", e))?;
    let label = charset_from_content_type(&content_type)
        .or_else(|| sniff_html_charset(&bytes[..bytes.len().min(2048)]));
    Ok(decode_bytes_with_label(&bytes, label.as_deref()))
}

fn is_utf8_family_label(label: &str) -> bool {
    matches!(
        label.to_ascii_lowercase().as_str(),
        "utf-8" | "utf8" | "us-ascii" | "ascii" | "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1"
    )
}

async fn fetch_search_page(url: &str, proxy_url: Option<&str>) -> Result<String, String> {
    // Search pages go through the cookie-jar client: session cookies from
    // earlier searches (or the Baidu warm-up) ride along, which is what keeps
    // anti-bot challenges at bay.
    let client = build_search_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    response_text_with_charset(resp).await
}

async fn search_backend_duckduckgo(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_duckduckgo_results(&html, max))
}

async fn search_backend_bing(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    // CJK queries pin the market to zh-CN so the international Bing serves
    // Chinese results instead of its English-biased block page.
    let mkt = if is_chinese_query(query) { "&mkt=zh-CN&setlang=zh-hans" } else { "" };
    let url = format!(
        "https://www.bing.com/search?q={}&count={}{}",
        urlencoding(query),
        max,
        mkt
    );
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_bing_results(&html, max))
}

/// True when the query contains CJK ideographs (CJK Unified Ideographs, CJK
/// Extension A, and CJK Compatibility Ideographs) — the trigger for routing a
/// search through the China Bing backend (cn.bing.com) first. Mirrored by
/// NodeToolAdapter.ts `containsCJK`; both sides have matching tests.
fn is_chinese_query(query: &str) -> bool {
    query.chars().any(|c| {
        matches!(c as u32,
            0x3400..=0x4DBF   // CJK Extension A
            | 0x4E00..=0x9FFF // CJK Unified Ideographs
            | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        )
    })
}

/// China Bing: real Chinese results with the same b_algo markup as
/// www.bing.com, so it reuses `parse_bing_results` unchanged.
async fn search_backend_bing_cn(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://cn.bing.com/search?q={}&count={}",
        urlencoding(query),
        max
    );
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_bing_results(&html, max))
}

/// Sogou — the only major Chinese engine that reliably returns relevant
/// results without a captcha (it is the CLI's CJK workhorse; the desktop GUI
/// previously lacked it entirely). CJK-only.
async fn search_backend_sogou(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://www.sogou.com/web?query={}",
        urlencoding(query)
    );
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_sogou_results(&html, max))
}

/// 360 Search (so.com) — China-native, no captcha for low volume, parseable
/// res-list markup. CJK-only.
async fn search_backend_so360(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.so.com/s?q={}", urlencoding(query));
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_so360_results(&html, max))
}

/// Baidu — the dominant Chinese engine. Captcha-prone (especially for
/// cookie-less or foreign clients), so the first search warms up a BAIDUID
/// cookie and any captcha page simply yields empty results → next backend.
/// CJK-only.
async fn search_backend_baidu(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    ensure_baidu_cookies(proxy_url).await;
    let url = format!("https://www.baidu.com/s?wd={}&ie=utf-8", urlencoding(query));
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_baidu_results(&html, max))
}

/// Brave Search — free HTML, no API key, works globally (block pages appear
/// only at high volume). Non-CJK.
async fn search_backend_brave(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://search.brave.com/search?q={}",
        urlencoding(query)
    );
    let html = fetch_search_page(&url, proxy_url).await?;
    Ok(parse_brave_results(&html, max))
}

/// Last-resort universal backend: Bing rendered through Jina Reader
/// (`r.jina.ai`, free tier ~20 req/min, no key). Jina fetches Bing from its
/// own infrastructure, so this works when every local engine is blocked or
/// rate-limited (China / restrictive networks), as long as r.jina.ai itself
/// is reachable. Used only after all other backends have failed, because it
/// is rate-limited and slower. PURE_JINA_API_KEY (if set) raises the limits.
async fn search_backend_jina_bing(query: &str, max: usize, proxy_url: Option<&str>) -> Result<Vec<SearchResult>, String> {
    let jina_key = std::env::var("PURE_JINA_API_KEY").ok().filter(|k| !k.is_empty());
    let mut req = build_search_client(std::time::Duration::from_secs(15), proxy_url)?
        .get(format!(
            "https://r.jina.ai/https://www.bing.com/search?q={}",
            urlencoding(query)
        ))
        .header("User-Agent", BROWSER_UA)
        .header("X-Return-Format", "markdown")
        .header("Accept", "text/plain");
    if let Some(k) = jina_key {
        req = req.header("Authorization", format!("Bearer {}", k));
    }
    let resp = req.send().await.map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| format!("read: {}", e))?;
    Ok(parse_jina_markdown_results(&text, max))
}

/// SearXNG metasearch backend (intranet / self-hosted / power users): a JSON
/// endpoint aggregates dozens of upstream engines and is the standard answer
/// for corporate or offline networks where the public engines are blocked.
/// Configured via the `searxng_url` arg (GUI Settings → Tools → Web Tools) or
/// `SEARXNG_URL` (CLI). Tried right after the API backends, before scraping.
async fn search_backend_searxng(
    query: &str,
    max: usize,
    base_url: &str,
    proxy_url: Option<&str>,
) -> Result<Vec<SearchResult>, String> {
    let client = build_http_client(std::time::Duration::from_secs(10), proxy_url)?;
    let base = base_url.trim().trim_end_matches('/');
    let url = format!("{}/search?q={}&format=json&safesearch=0", base, urlencoding(query));
    let resp = client
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("read: {}", e))?;
    Ok(parse_searxng_results(&body, max))
}

fn parse_searxng_results(body: &serde_json::Value, max: usize) -> Vec<SearchResult> {
    let mut out: Vec<SearchResult> = Vec::new();
    if let Some(results) = body.get("results").and_then(|v| v.as_array()) {
        for item in results {
            if out.len() >= max {
                break;
            }
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let snippet = item.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !title.is_empty() && !url.is_empty() {
                out.push(SearchResult {
                    title,
                    snippet,
                    url,
                });
            }
        }
    }
    out
}

/// Strip search operators / quotes / punctuation for a lighter retry query.
/// When every backend fails on a syntactically heavy query (quotes, colons,
/// parens, site: filters), one normalized retry often succeeds — engines are
/// picky about operators and punctuation, and the model shouldn't have to
/// rephrase by hand. Returns None when nothing would change.
fn normalize_query_for_retry(query: &str) -> Option<String> {
    const REPLACE: [char; 22] = [
        '"', '\'', '(', ')', '（', '）', '[', ']', '{', '}', ':', '|', '~', '!', '?', '，', '。', '？', '！', '、', '；', '：',
    ];
    // Operator words (site:/filetype:/…: ) are dropped on the RAW query
    // before the colon replacement turns `site:foo` into two words — the
    // operator filter must see the operator intact.
    let filtered: Vec<&str> = query
        .split_whitespace()
        .filter(|w| {
            let lower = w.to_lowercase();
            !(lower.starts_with("site:")
                || lower.starts_with("filetype:")
                || lower.starts_with("inurl:")
                || lower.starts_with("intitle:")
                || lower.starts_with("intext:")
                || lower.starts_with("lang:")
                || lower.starts_with("before:")
                || lower.starts_with("after:")
                || lower.starts_with("define:"))
        })
        .collect();
    let mut cleaned = filtered.join(" ");
    for c in REPLACE {
        cleaned = cleaned.replace(c, " ");
    }
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let joined = joined.trim();
    if joined.is_empty() || joined == query {
        None
    } else {
        Some(joined.to_string())
    }
}

/// Human-readable list of the configured search backends (API keys that were
/// passed in plus the always-available free HTML backends) for the error /
/// no-results guidance the model feeds back on.
fn configured_backend_names(serper_api_key: Option<&str>, api_key: Option<&str>) -> String {
    let mut names: Vec<&str> = Vec::new();
    if serper_api_key.map_or(false, |k| !k.is_empty()) {
        names.push("Serper");
    }
    if api_key.map_or(false, |k| !k.is_empty()) {
        names.push("Tavily");
    }
    names.extend(["Sogou", "cn.bing.com", "360", "Baidu", "DuckDuckGo", "Bing", "Brave"]);
    names.join(", ")
}

/// Serper.dev Google SERP API backend (opt-in via the `serper_api_key` arg):
/// a real Google index — excellent for BOTH Chinese and English, captcha-free.
/// ~2500 free trial queries, then prepaid credits (~$0.3–1 per 1k). Mirrors
/// the Node serperSearch() in NodeToolAdapter.ts.
async fn search_backend_serper(
    query: &str,
    max: usize,
    api_key: &str,
    proxy_url: Option<&str>,
) -> Result<Vec<SearchResult>, String> {
    let client = build_http_client(std::time::Duration::from_secs(10), proxy_url)?;
    let (gl, hl) = if is_chinese_query(query) {
        ("cn", "zh-cn")
    } else {
        ("us", "en")
    };
    let resp = client
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", api_key)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "q": query, "gl": gl, "hl": hl, "num": max }))
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("read: {}", e))?;
    Ok(parse_serper_results(&body, max))
}

fn parse_serper_results(body: &serde_json::Value, max: usize) -> Vec<SearchResult> {
    let mut out: Vec<SearchResult> = Vec::new();
    if let Some(organic) = body.get("organic").and_then(|v| v.as_array()) {
        for item in organic {
            if out.len() >= max {
                break;
            }
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let link = item
                .get("link")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let snippet = item
                .get("snippet")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !title.is_empty() && !link.is_empty() {
                out.push(SearchResult {
                    title,
                    snippet,
                    url: link,
                });
            }
        }
    }
    out
}

/// Tavily Search API backend (opt-in via the `api_key` arg — Settings → Tools
/// in the GUI, TAVILY_API_KEY in the CLI). The desktop app has been passing
/// this key to web_search for a while but Rust never read the arg — now it is
/// honored here, mirroring the Node tavilySearch() in NodeToolAdapter.ts.
async fn search_backend_tavily(
    query: &str,
    max: usize,
    api_key: &str,
    proxy_url: Option<&str>,
) -> Result<Vec<SearchResult>, String> {
    let client = build_http_client(std::time::Duration::from_secs(10), proxy_url)?;
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "query": query,
            "max_results": max,
            "search_depth": "basic",
            "include_answer": false,
        }))
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("read: {}", e))?;
    Ok(parse_tavily_results(&body, max))
}

fn parse_tavily_results(body: &serde_json::Value, max: usize) -> Vec<SearchResult> {
    let mut out: Vec<SearchResult> = Vec::new();
    if let Some(results) = body.get("results").and_then(|v| v.as_array()) {
        for item in results {
            if out.len() >= max {
                break;
            }
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = item
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let snippet = item
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !title.is_empty() && !url.is_empty() {
                out.push(SearchResult {
                    title,
                    snippet,
                    url,
                });
            }
        }
    }
    out
}

/// Grace window granted to cn.bing.com (the CJK-relevant backend) after a
/// faster DuckDuckGo/Bing race win, so a Chinese query isn't answered with
/// English-biased results just because cn.bing.com was a few hundred ms
/// slower. Only adds latency when cn.bing.com is still in flight.
const CN_BING_GRACE_MS: std::time::Duration = std::time::Duration::from_millis(1500);

/// Tier-2 fast path + search backends, shared by the `web_search` command and
/// `web_public_api`'s auto-fallback (searchOnMiss). Mirrors the Node
/// handleWebSearch + web_search dispatch in NodeToolAdapter.ts.
async fn web_search_inner(
    query: &str,
    max_results: Option<usize>,
    api_key: Option<&str>,
    serper_api_key: Option<&str>,
    location: Option<&str>,
    proxy_url: Option<&str>,
    searxng_url: Option<&str>,
) -> Result<String, String> {
    let max = max_results.unwrap_or(10).min(20);

    // Result cache: identical queries inside an agent loop (or across CLI/GUI
    // sessions) hit the shared ~/.pure/cache/web-cache.json instead of burning
    // free-tier quota or re-hitting rate-limited backends. TTL is 15 minutes;
    // PURE_WEB_CACHE=off disables. The Tier-2 fast path is cached separately
    // (cached_direct_public_api) with per-intent TTLs.
    let search_key = search_cache_key(query, max);
    if let Some(hit) = web_cache().lock().unwrap().get(&search_key) {
        return Ok(format!("[cached] {}", hit));
    }

    // Tier-2 fast path: structured intents (weather/geocode/news/wiki/IP/FX/
    // stock/GitHub) are answered directly from curated no-key public
    // APIs instead of hitting search backends — mirrors the Node web_search
    // dispatch. General queries fall through to the search backends below.
    let mut failed: Vec<String> = Vec::new();
    match cached_direct_public_api(query, None, location, proxy_url).await {
        Ok((Some(outcome), cached)) => {
            return Ok(format!("{}[{}] {}", if cached { "[cached] " } else { "" }, outcome.source, outcome.text));
        }
        Ok((None, _)) => {}
        Err(e) => failed.push(format!("public API: {}", e)),
    }

    let mut results: Vec<SearchResult> = Vec::new();
    let mut any_empty = false;

    // API backends first (opt-in): Serper — a real Google index, the best
    // quality for BOTH Chinese and English — then Tavily. Each degrades to
    // the free HTML backends below on failure or an empty result set.
    //
    // NB: unlike the Node side (which applies a CJK relevance gate to API
    // results because its scraping backends return garbage for Chinese), the
    // Rust side accepts API results unconditionally — Serper is a real Google
    // index, so the gate's benefit there is marginal and duplicating the
    // bigram logic here isn't worth it. The free HTML backends below are
    // likewise ungated on the Rust side.
    if let Some(k) = serper_api_key.filter(|k| !k.is_empty()) {
        match search_backend_serper(query, max, k, proxy_url).await {
            Ok(r) if !r.is_empty() => results = r,
            Ok(_) => any_empty = true,
            Err(e) => failed.push(format!("Serper: {}", e)),
        }
    }
    if results.is_empty() {
        if let Some(k) = api_key.filter(|k| !k.is_empty()) {
            match search_backend_tavily(query, max, k, proxy_url).await {
                Ok(r) if !r.is_empty() => results = r,
                Ok(_) => any_empty = true,
                Err(e) => failed.push(format!("Tavily: {}", e)),
            }
        }
    }

    // SearXNG metasearch backend (opt-in): intranet / self-hosted instances
    // aggregate dozens of upstream engines behind one JSON endpoint — the
    // standard answer for corporate or offline networks where every public
    // engine is blocked. Tried right after the API backends, before scraping.
    if results.is_empty() {
        if let Some(base) = searxng_url.filter(|u| !u.trim().is_empty()) {
            match search_backend_searxng(query, max, base, proxy_url).await {
                Ok(r) if !r.is_empty() => results = r,
                Ok(_) => any_empty = true,
                Err(e) => failed.push(format!("SearXNG: {}", e)),
            }
        }
    }

    // Free HTML backends — probed ONLY when the API backends produced nothing
    // (a successful Serper hit no longer triggers wasted scrapes), and then IN
    // PARALLEL with first-success-returns (probe_html_backends). Each backend
    // keeps its own bounded request timeout (8s via fetch_search_page), so the
    // effective latency is the FIRST backend to deliver a non-empty result,
    // not the slowest.
    if results.is_empty() {
        let chinese = is_chinese_query(query);
        let (html_results, html_failed, html_empty) =
            probe_html_backends(query, max, proxy_url, chinese).await;
        results = html_results;
        any_empty = any_empty || html_empty;
        failed.extend(html_failed);
    }

    // One normalized retry: syntactically heavy queries (quotes, operators,
    // Chinese punctuation) make engines fail or return nothing even when the
    // intent is findable — strip the noise once and re-probe before giving up.
    if results.is_empty() {
        if let Some(simplified) = normalize_query_for_retry(query) {
            let chinese = is_chinese_query(&simplified);
            let (html_results, html_failed, html_empty) =
                probe_html_backends(&simplified, max, proxy_url, chinese).await;
            results = html_results;
            any_empty = any_empty || html_empty;
            failed.extend(html_failed);
        }
    }

    // Last resort: Bing rendered through Jina Reader (r.jina.ai, free tier).
    // Jina fetches Bing from its own infrastructure, so this works when every
    // local engine is blocked / rate-limited (China, restrictive networks) as
    // long as r.jina.ai is reachable. Slower + rate-limited, hence last.
    if results.is_empty() {
        match search_backend_jina_bing(query, max, proxy_url).await {
            Ok(r) if !r.is_empty() => results = r,
            Ok(_) => any_empty = true,
            Err(e) => failed.push(format!("Bing via Jina: {}", e)),
        }
    }

    if results.is_empty() {
        // At least one backend answered with an empty result set: the search
        // infrastructure works, the query just has no hits — rephrase, don't
        // repeat. (Other backends may have been unreachable; either way the
        // actionable guidance is the same.)
        if any_empty {
            return Ok(format!(
                "No results found for \"{}\" on the available search backends ({}). Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch / web_scrape on a URL you expect to contain the information.",
                query, configured_backend_names(serper_api_key, api_key)
            ));
        }
        // Every backend errored (none returned empty): almost always network /
        // rate-limit / geo-block, NOT a bad query — tell the model not to
        // blindly retry, and how to recover. This is the message the failure
        // policy feeds back on.
        let details = if failed.is_empty() {
            "all backends unreachable".to_string()
        } else {
            failed.join("; ")
        };
        return Err(format!(
            "Web search failed on all backends ({}). This looks like a network or rate-limit issue rather than a bad query — do NOT retry web_search immediately with the same or similar queries. Retry later, or use web_fetch on a URL you expect to contain the information.",
            details
        ));
    }

    let output: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}\n   {}\n   {}", i + 1, r.title, r.snippet, r.url))
        .collect();
    let joined = output.join("\n\n");
    web_cache().lock().unwrap().set(&search_key, &joined, SEARCH_TTL_MS);

    Ok(joined)
}

/// Race the free HTML backends IN PARALLEL, first non-empty result wins. CJK
/// queries probe the China-relevant engines (Sogou, cn.bing.com, 360, Baidu)
/// plus the international ones as safety nets; non-CJK probes DuckDuckGo,
/// Bing and Brave. When an international backend wins while a Chinese-relevant
/// one is still in flight, the Chinese backend gets a short grace window
/// (CN_BING_GRACE_MS) — international engines return irrelevant results for
/// Chinese queries, and the point of the sweep is to hand the model results it
/// can actually use, not the fastest English-biased set. Errors and empty sets
/// are accumulated for the degraded-error message. Returns (results, failures,
/// any_empty).
async fn probe_html_backends(
    query: &str,
    max: usize,
    proxy_url: Option<&str>,
    chinese: bool,
) -> (Vec<SearchResult>, Vec<String>, bool) {
    use futures_util::stream::FuturesUnordered;
    use futures_util::StreamExt;

    let mut probes: Vec<(
        String,
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<SearchResult>, String>> + Send>>,
    )> = Vec::new();
    if chinese {
        probes.push(("Sogou".into(), Box::pin(search_backend_sogou(query, max, proxy_url))));
        probes.push(("cn.bing.com".into(), Box::pin(search_backend_bing_cn(query, max, proxy_url))));
        probes.push(("360".into(), Box::pin(search_backend_so360(query, max, proxy_url))));
        probes.push(("Baidu".into(), Box::pin(search_backend_baidu(query, max, proxy_url))));
        probes.push(("DuckDuckGo".into(), Box::pin(search_backend_duckduckgo(query, max, proxy_url))));
        probes.push(("Bing".into(), Box::pin(search_backend_bing(query, max, proxy_url))));
    } else {
        probes.push(("DuckDuckGo".into(), Box::pin(search_backend_duckduckgo(query, max, proxy_url))));
        probes.push(("Bing".into(), Box::pin(search_backend_bing(query, max, proxy_url))));
        probes.push(("Brave".into(), Box::pin(search_backend_brave(query, max, proxy_url))));
    }

    let mut pending: FuturesUnordered<_> = probes
        .into_iter()
        .map(|(label, fut)| async move { (label, fut.await) })
        .collect();
    let mut failed: Vec<String> = Vec::new();
    let mut any_empty = false;
    while let Some((label, outcome)) = pending.next().await {
        match outcome {
            Ok(r) if !r.is_empty() => {
                let chinese_relevant =
                    matches!(label.as_str(), "Sogou" | "cn.bing.com" | "360" | "Baidu");
                if chinese && !chinese_relevant && !pending.is_empty() {
                    // An international backend won while Chinese engines are
                    // still in flight: grant a short grace window so a
                    // relevant result can preempt it.
                    if let Ok(Some((cn_label, cn_outcome))) =
                        tokio::time::timeout(CN_BING_GRACE_MS, pending.next()).await
                    {
                        if let Ok(cn_r) = cn_outcome {
                            if !cn_r.is_empty()
                                && matches!(cn_label.as_str(), "Sogou" | "cn.bing.com" | "360" | "Baidu")
                            {
                                return (cn_r, failed, any_empty);
                            }
                        }
                    }
                }
                return (r, failed, any_empty);
            }
            Ok(_) => any_empty = true,
            Err(e) => failed.push(format!("{}: {}", label, e)),
        }
    }
    (Vec::new(), failed, any_empty)
}

#[tauri::command]
async fn web_search(
    _workspace: String,
    query: String,
    max_results: Option<usize>,
    api_key: Option<String>,
    serper_api_key: Option<String>,
    location: Option<String>,
    proxy_url: Option<String>,
    searxng_url: Option<String>,
) -> Result<String, String> {
    web_search_inner(
        &query,
        max_results,
        api_key.as_deref(),
        serper_api_key.as_deref(),
        location.as_deref(),
        proxy_url.as_deref(),
        searxng_url.as_deref(),
    )
    .await
}

fn urlencoding(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            b' ' => encoded.push_str("%20"),
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

#[derive(Debug)]
struct SearchResult {
    title: String,
    snippet: String,
    url: String,
}

fn parse_duckduckgo_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();

    // Simple state-machine parser for DuckDuckGo HTML results
    let mut in_result = false;
    let mut current_block = String::new();

    for line in html.lines() {
        if line.contains("class=\"result\"") || line.contains("class='result'") {
            in_result = true;
            current_block = line.to_string();
        } else if in_result {
            current_block.push_str(line);
            if line.contains("</div>") {
                in_result = false;
                if let Some(result) = parse_result_block(&current_block) {
                    results.push(result);
                    if results.len() >= max {
                        break;
                    }
                }
                current_block.clear();
            }
        }
    }

    results
}

fn parse_result_block(block: &str) -> Option<SearchResult> {
    // Extract link: <a ... class="result__a" href="URL">
    let href_start = block.find("class=\"result__a\"")?;

    let url = extract_href(block, href_start)?;
    // Title lives in the anchor text (after the `result__a` tag's '>'), the
    // same way URL and snippet are targeted. Note: must NOT be `"a"` — that
    // finds the FIRST 'a' in the block (inside the div's `class`) and grabs
    // whatever text sits right after the div tag instead of the title.
    let title = extract_tag_content(block, "result__a").unwrap_or_default();
    let snippet = extract_tag_content(block, "result__snippet").unwrap_or_default();

    let title = strip_html_tags(&title);
    let snippet = strip_html_tags(&snippet);

    // Decode THEN trim — mirrors the Node parser (strip → decode → trim). The
    // order matters: &nbsp; decodes to a space, so trimming before decoding
    // would leave a trailing space on titles ending in &nbsp;. Trimming before
    // the empty-check also skips whitespace-only titles the same way the Node
    // side skips them (its `if (!title)` runs after trim).
    let title = html_decode(&title).trim().to_string();
    let snippet = html_decode(&snippet).trim().to_string();

    if title.is_empty() || url.is_empty() {
        return None;
    }

    Some(SearchResult {
        title,
        snippet,
        // TS trims the href before decoding (decodeHtmlEntities(linkMatch[1]
        // .trim())); trim here too so a malformed `href=" url "` doesn't
        // diverge the mirror.
        url: html_decode(&url.trim()),
    })
}

fn extract_href(block: &str, from: usize) -> Option<String> {
    let rest = &block[from..];
    let href_idx = rest.find("href=")?;
    let after_href = &rest[href_idx + 5..];
    let quote = after_href.chars().next()?;
    let start = 1;
    let end = after_href[start..].find(quote)?;
    Some(after_href[start..start + end].to_string())
}

fn extract_tag_content(block: &str, class_hint: &str) -> Option<String> {
    let class_idx = block.find(class_hint)?;
    let rest = &block[class_idx..];
    let tag_end = rest.find('>')?;
    let after_tag = &rest[tag_end + 1..];
    let close_tag = after_tag.find('<')?;
    Some(after_tag[..close_tag].to_string())
}

fn strip_html_tags(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }
    }
    result
}

fn html_decode(s: &str) -> String {
    let named = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&ensp;", " ");
    decode_numeric_entities(&named)
}

/// Decode `&#\d+;` numeric character references (common in Bing snippets,
/// e.g. `&#0183;` for a middle dot) into their actual characters.
fn decode_numeric_entities(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' && i + 1 < chars.len() && chars[i + 1] == '#' {
            let mut j = i + 2;
            let mut digits = String::new();
            while j < chars.len() && chars[j].is_ascii_digit() {
                digits.push(chars[j]);
                j += 1;
            }
            if j < chars.len() && chars[j] == ';' && !digits.is_empty() {
                if let Some(c) = digits.parse::<u32>().ok().and_then(char::from_u32) {
                    result.push(c);
                    i = j + 1;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

/// Parse Bing HTML results (`<li class="b_algo">` blocks). Bing markup:
/// `<h2><a href="URL" h="…">TITLE</a></h2>` plus a `<p>…</p>` snippet. The
/// same lightweight approach as the DuckDuckGo parser: scan for blocks, then
/// pull href/title/snippet out with string finds (no full HTML parser).
fn parse_bing_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();
    let mut rest = html;
    while results.len() < max {
        let Some(idx) = rest.find("<li class=\"b_algo") else {
            break;
        };
        let tail = &rest[idx..];
        let Some(li_end) = tail.find("</li>") else {
            break;
        };
        let block = &tail[..li_end + "</li>".len()];
        if let Some(r) = parse_bing_block(block) {
            results.push(r);
        }
        rest = &tail[li_end + "</li>".len()..];
    }
    results
}

fn parse_bing_block(block: &str) -> Option<SearchResult> {
    // Result link lives inside <h2>: find <h2>, then the first <a after it.
    let h2 = block.find("<h2")?;
    let after_h2 = &block[h2..];
    let a_idx = after_h2.find("<a")?;
    let url = extract_href(after_h2, a_idx)?;

    // Title: text between the anchor's '>' and the next '<'.
    let after_a = &after_h2[a_idx..];
    let gt = after_a.find('>')?;
    let after_gt = &after_a[gt + 1..];
    let title_end = after_gt.find('<')?;
    let title = strip_html_tags(&after_gt[..title_end]);

    // Snippet: first <p ...>…</p> in the block.
    let snippet = block
        .find("<p")
        .and_then(|p| {
            let after_p = &block[p..];
            let gt = after_p.find('>')?;
            let content = &after_p[gt + 1..];
            let end = content.find("</p>")?;
            Some(strip_html_tags(&content[..end]))
        })
        .unwrap_or_default();

    // Decode → trim BEFORE the empty-check — same restructure as the DDG
    // parser: trims whitespace-only titles (skipping them, like the Node
    // side) and must decode first because &nbsp; decodes to a space.
    let title = html_decode(&title).trim().to_string();
    let snippet = html_decode(&snippet).trim().to_string();

    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(SearchResult {
        title,
        snippet,
        url: html_decode(&url),
    })
}

/// Sogou results: `<h3 class="vr-title">` blocks with the anchor inside and
/// the snippet container (`<p class="star-wiki">` / `.text-layout` / `.fz-mid`)
/// right after `</h3>`. Mirrors NodeToolAdapter.ts `parseSogouResults` — the
/// desktop GUI previously had NO Sogou backend at all (only the CLI did), so
/// this closes the biggest China-coverage gap. Relative `/link?url=…` links
/// are absolutized to https://www.sogou.com/… so the model can still web_fetch
/// them.
fn parse_sogou_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();
    let mut pos = 0;
    while results.len() < max {
        let Some(rel_h3) = html[pos..].find("<h3") else {
            break;
        };
        let h3 = pos + rel_h3;
        // Block = this <h3> through the start of the next <h3> (or end of
        // page): the anchor/title live inside the h3, while the snippet
        // container sits right AFTER </h3>, before the next result block.
        let after_h3 = h3 + 3;
        let next = html[after_h3..].find("<h3").map(|i| after_h3 + i).unwrap_or(html.len());
        let block = &html[h3..next];
        if let Some(r) = parse_sogou_block(block) {
            if !results.iter().any(|x| x.url == r.url || x.title == r.title) {
                results.push(r);
            }
        }
        pos = next;
    }
    results
}

fn parse_sogou_block(block: &str) -> Option<SearchResult> {
    let a_idx = block.find("<a")?;
    let mut url = extract_href(block, a_idx)?;
    // Absolutize Sogou's relative redirect links (/link?url=…, //www.sogou.com/…).
    if url.starts_with("//") {
        url = format!("https:{}", url);
    } else if url.starts_with('/') {
        url = format!("https://www.sogou.com{}", url);
    }

    // Title: anchor text, stripped to </a> — Sogou bolds matched terms with
    // <em> INSIDE the title text, so stripping to the first '<' would cut the
    // title short; strip tags and keep everything up to </a>.
    let after_a = &block[a_idx..];
    let gt = after_a.find('>')?;
    let after_gt = &after_a[gt + 1..];
    let anchor_end = after_gt.find("</a>")?;
    let title = html_decode(&strip_html_tags(&after_gt[..anchor_end])).trim().to_string();

    // Snippet: star-wiki <p> first (organic results), else the fz-mid div
    // (zhihu/other layouts). Both sit after the anchor inside the h3 block.
    let region = &after_gt[anchor_end + "</a>".len()..];
    let mut snippet = String::new();
    if let Some(star) = region.find("<p class=\"star-wiki") {
        if let Some(gt) = region[star..].find('>') {
            let content = &region[star + gt + 1..];
            if let Some(end) = content.find("</p>") {
                snippet = content[..end].to_string();
            }
        }
    } else if let Some(fz) = region.find("fz-mid") {
        if let Some(gt) = region[fz..].find('>') {
            let content = &region[fz + gt + 1..];
            if let Some(end) = content.find("</div>") {
                snippet = content[..end].to_string();
            }
        }
    }
    let snippet = html_decode(&strip_html_tags(&snippet)).trim().to_string();

    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(SearchResult {
        title,
        snippet,
        url: html_decode(&url),
    })
}

/// 360 Search (so.com) results: `<li class="res-list">` blocks with a
/// `<h3 class="res-title"><a data-mdurl="REAL_URL" href="…">TITLE</a></h3>`
/// title and a `<p class="res-desc">` snippet. `data-mdurl` carries the real
/// destination (the href is a /link?m=… redirect), so it wins; otherwise the
/// href is absolutized.
fn parse_so360_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();
    let mut rest = html;
    while results.len() < max {
        let Some(idx) = rest.find("<li class=\"res-list") else {
            break;
        };
        let tail = &rest[idx..];
        let next = tail["<li class=\"res-list".len()..].find("<li class=\"res-list");
        let (block, consumed) = match next {
            Some(rel) => (&tail[.."<li class=\"res-list".len() + rel], "<li class=\"res-list".len() + rel),
            None => (tail, tail.len()),
        };
        if let Some(r) = parse_so360_block(block) {
            results.push(r);
        }
        rest = &rest[idx + consumed..];
    }
    results
}

fn parse_so360_block(block: &str) -> Option<SearchResult> {
    // Title + URL: the first <a> after res-title.
    let title_start = block.find("res-title")?;
    let a_idx = block[title_start..].find("<a")? + title_start;
    let raw_href = extract_href(block, a_idx)?;
    // data-mdurl holds the real URL when present (modern markup); else the
    // href is a /link?m=… redirect we absolutize.
    let url = if let Some(md) = extract_attr(block, "data-mdurl") {
        md
    } else if raw_href.starts_with("//") {
        format!("https:{}", raw_href)
    } else if raw_href.starts_with('/') {
        format!("https://www.so.com{}", raw_href)
    } else {
        raw_href
    };

    let after_a = &block[a_idx..];
    let gt = after_a.find('>')?;
    let after_gt = &after_a[gt + 1..];
    let anchor_end = after_gt.find("</a>")?;
    let title = html_decode(&strip_html_tags(&after_gt[..anchor_end])).trim().to_string();

    // Snippet: <p class="res-desc">…</p> (organic) — the span inside is
    // stripped too. res-desc IS the <p> tag's class, so the content starts at
    // the tag's '>' after the class name.
    let mut snippet = String::new();
    if let Some(d) = block.find("res-desc") {
        let after_d = &block[d..];
        if let Some(gt) = after_d.find('>') {
            let content = &after_d[gt + 1..];
            if let Some(end) = content.find("</p>") {
                snippet = content[..end].to_string();
            }
        }
    }
    let snippet = html_decode(&strip_html_tags(&snippet)).trim().to_string();

    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(SearchResult {
        title,
        snippet,
        url: html_decode(&url),
    })
}

/// Extract a bare attribute value (unquoted or double-quoted) from HTML, e.g.
/// `data-mdurl="https://…"`. Used where `<a>` hrefs are redirect wrappers.
fn extract_attr(block: &str, attr: &str) -> Option<String> {
    let idx = block.find(attr)?;
    let rest = &block[idx + attr.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let quote = rest.chars().next()?;
    let start = 1;
    if quote == '"' || quote == '\'' {
        let end = rest[start..].find(quote)?;
        Some(rest[start..start + end].to_string())
    } else {
        let end = rest.find([' ', '>']).unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

/// Baidu results (best-effort — Baidu serves a captcha to cookie-less or
/// foreign clients, so this backend degrades gracefully to the next one).
/// Blocks are `<div class="result c-container …">`; title from
/// `<h3 class="t"><a href="…">TITLE</a></h3>` (or the `data-tools` JSON on
/// some blocks), snippet from `.content-right_…` / `.c-abstract` / `.c-span-last`.
fn parse_baidu_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();
    let mut rest = html;
    while results.len() < max {
        let Some(idx) = rest.find("class=\"result c-container") else {
            break;
        };
        let tail = &rest[idx..];
        let next = tail["class=\"result c-container".len()..].find("class=\"result c-container");
        let (block, consumed) = match next {
            Some(rel) => {
                let end = "class=\"result c-container".len() + rel;
                (&tail[..end], end)
            }
            None => (tail, tail.len()),
        };
        if let Some(r) = parse_baidu_block(block) {
            results.push(r);
        }
        rest = &rest[idx + consumed..];
    }
    results
}

fn parse_baidu_block(block: &str) -> Option<SearchResult> {
    // data-tools="{"title":"…","url":"…"}" is the most reliable source on
    // modern Baidu markup; fall back to the h3 anchor.
    let mut title = String::new();
    let mut url = String::new();
    if let Some(tools) = extract_attr(block, "data-tools") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&tools) {
            title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
            url = v.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
        }
    }
    if url.is_empty() {
        if let Some(h3) = block.find("<h3") {
            let after_h3 = &block[h3..];
            if let Some(a) = after_h3.find("<a") {
                let a_idx = a;
                url = extract_href(after_h3, a_idx).unwrap_or_default();
                let after_a = &after_h3[a_idx..];
                if let Some(gt) = after_a.find('>') {
                    let after_gt = &after_a[gt + 1..];
                    if let Some(end) = after_gt.find("</a>") {
                        title = html_decode(&strip_html_tags(&after_gt[..end])).trim().to_string();
                    }
                }
            }
        }
    }
    // Snippet: content-right… / c-abstract / c-span-last containers.
    let mut snippet = String::new();
    for needle in ["content-right", "c-abstract", "c-span-last"] {
        if let Some(i) = block.find(needle) {
            let after = &block[i..];
            if let Some(gt) = after.find('>') {
                let content = &after[gt + 1..];
                let end = content.find("</div>").or_else(|| content.find("</span>")).unwrap_or(content.len());
                snippet = content[..end].to_string();
                if !snippet.trim().is_empty() {
                    break;
                }
            }
        }
    }
    let snippet = html_decode(&strip_html_tags(&snippet)).trim().to_string();
    let title = title.trim().to_string();
    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(SearchResult {
        title,
        snippet,
        url: html_decode(&url),
    })
}

/// Brave Search results: `<div class="snippet …" data-type="web">` blocks with
/// a `title search-snippet-title` div (the anchor URL lives earlier in the
/// block) and a `generic-snippet` paragraph. The svelte hash suffixes rotate
/// across Brave builds, so blocks are matched on the stable `class=\"snippet `
/// prefix and the `search-snippet-title` / `generic-snippet` substrings.
fn parse_brave_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = Vec::new();
    let mut rest = html;
    while results.len() < max {
        let Some(idx) = rest.find("class=\"snippet ") else {
            break;
        };
        let tail = &rest[idx..];
        let next = tail["class=\"snippet ".len()..].find("class=\"snippet ");
        let (block, consumed) = match next {
            Some(rel) => {
                let end = "class=\"snippet ".len() + rel;
                (&tail[..end], end)
            }
            None => (tail, tail.len()),
        };
        if let Some(r) = parse_brave_block(block) {
            results.push(r);
        }
        rest = &rest[idx + consumed..];
    }
    results
}

fn parse_brave_block(block: &str) -> Option<SearchResult> {
    let a_idx = block.find("<a")?;
    let url = extract_href(block, a_idx)?;

    let title = block
        .find("search-snippet-title")
        .and_then(|ti| {
            let rest = &block[ti..];
            let gt = rest.find('>')?;
            let content = &rest[gt + 1..];
            let end = content.find('<')?;
            Some(strip_html_tags(&content[..end]))
        })
        .unwrap_or_default();

    let snippet = block
        .find("generic-snippet")
        .and_then(|si| {
            let rest = &block[si..];
            let gt = rest.find('>')?;
            let content = &rest[gt + 1..];
            let end = content.find("</p>")?;
            Some(strip_html_tags(&content[..end]))
        })
        .unwrap_or_default();

    let title = html_decode(&title).trim().to_string();
    let snippet = html_decode(&snippet).trim().to_string();
    if title.is_empty() || url.is_empty() {
        return None;
    }
    Some(SearchResult {
        title,
        snippet,
        url: html_decode(&url),
    })
}

/// Jina Reader (r.jina.ai) markdown output parser — the last-resort backend
/// renders `https://www.bing.com/search?q=…` from Jina's infrastructure and
/// returns clean markdown, so it works even when every local engine is
/// blocked (China / restrictive networks) as long as r.jina.ai is reachable.
/// Results are `## [Title](url)` headings followed by a snippet paragraph.
fn parse_jina_markdown_results(text: &str, max: usize) -> Vec<SearchResult> {
    let heading_re = regex::Regex::new(r"^\s*(?:\d+\.\s+)?#{1,4}\s*\[([^\]]+)\]\(([^)]+)\)\s*$").unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<SearchResult> = Vec::new();
    let mut i = 0;
    while i < lines.len() && out.len() < max {
        if let Some(caps) = heading_re.captures(lines[i]) {
            let title = caps.get(1).unwrap().as_str().replace("**", "").trim().to_string();
            let url = resolve_bing_ck_url(caps.get(2).unwrap().as_str());
            // Snippet: the next non-empty, non-heading line.
            let mut snippet = String::new();
            let mut j = i + 1;
            while j < lines.len() {
                let t = lines[j].trim();
                if t.is_empty() {
                    j += 1;
                    continue;
                }
                if t.starts_with('#') {
                    break;
                }
                snippet = t.to_string();
                break;
            }
            if !title.is_empty() && !url.is_empty() {
                out.push(SearchResult {
                    title,
                    snippet,
                    url,
                });
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// Bing wraps result URLs in `/ck/a` redirects: `…&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1`.
/// The `u=` param holds the base64 (URL-safe, sometimes prefixed `a1`) real
/// URL. Decode it when present so the model gets the actual destination
/// (fetchable via web_fetch) instead of a bing.com redirect.
fn resolve_bing_ck_url(url: &str) -> String {
    let Some(idx) = url.find("u=") else {
        return url.to_string();
    };
    let after = &url[idx + 2..];
    let end = after.find(['&', '#']).unwrap_or(after.len());
    let b64 = after[..end].trim();
    if b64.is_empty() {
        return url.to_string();
    }
    // URL-decode first (the base64 may be percent-encoded), then try STANDARD
    // and, on failure, a leading-"a1"-stripped + base64url variant.
    let decoded = percent_decode(b64);
    let candidates = [
        decoded.clone(),
        decoded.strip_prefix("a1").unwrap_or("").to_string(),
    ];
    for cand in candidates.iter() {
        let normalized = cand.replace('-', "+").replace('_', "/");
        let padded = format!("{}{}", normalized, "=".repeat((4 - normalized.len() % 4) % 4));
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(padded) {
            if let Ok(s) = String::from_utf8(bytes) {
                if s.starts_with("http") {
                    return s;
                }
            }
        }
    }
    url.to_string()
}

/// Percent-decode a string (`%2F` → `/`, `+` kept literal). Used to unwrap the
/// `u=` base64 param in Bing redirect URLs before base64-decoding it.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod web_search_tests {
    use super::*;

    #[test]
    fn parses_bing_result_blocks() {
        // Titles/snippets padded with stray whitespace — both parsers
        // strip → decode → trim, so it must not leak into the output.
        let html = r#"<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://rust-lang.org/" h="ID=SERP,5039.1"> Rust Programming Language </a></h2><div class="b_caption"><p> Rust is blazingly fast and memory-efficient. </p></div></li>
<li class="b_algo b_algo_big"><h2><a href="https://www.runoob.com/rust/rust-tutorial.html"> Rust &#10148; 教程 </a></h2><div class="b_caption"><p> Rust 教程 &ensp;&#0183;&ensp;由 Mozilla 主导开发。 </p></div></li>
</ol></body></html>"#;
        let results = parse_bing_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://rust-lang.org/");
        assert!(results[0].snippet.contains("memory-efficient"));
        assert!(results[1].title.contains("教程"));
        assert!(results[1].snippet.contains("Mozilla"));
        // Numeric + named entities decoded out of the raw markup — in BOTH
        // the title (&#10148; arrow) and the snippet (&#0183; / &ensp;). The
        // Node parser (NodeToolAdapter.ts) mirrors these assertions.
        assert!(!results[1].title.contains("&#10148;"));
        assert!(!results[1].snippet.contains("&#"));
        assert!(!results[1].snippet.contains("&ensp;"));
    }

    #[test]
    fn bing_parser_stops_at_max() {
        let html = r#"<li class="b_algo"><h2><a href="https://a.com">A</a></h2><p>a</p></li><li class="b_algo"><h2><a href="https://b.com">B</a></h2><p>b</p></li><li class="b_algo"><h2><a href="https://c.com">C</a></h2><p>c</p></li>"#;
        let results = parse_bing_results(html, 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://a.com");
        assert_eq!(results[1].url, "https://b.com");
    }

    #[test]
    fn bing_parser_skips_blocks_without_links() {
        let html = r#"<li class="b_algo"><div>no link here</div></li><li class="b_algo"><h2><a href="https://ok.com">OK</a></h2><p>snippet</p></li>"#;
        let results = parse_bing_results(html, 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://ok.com");
    }

    #[test]
    fn bing_parser_accepts_single_quoted_hrefs() {
        let html = r#"<li class="b_algo"><h2><a href='https://single-quoted.example/x'>Single</a></h2><p>s</p></li>"#;
        let results = parse_bing_results(html, 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://single-quoted.example/x");
    }

    // ── DuckDuckGo parser (same mirror contract as the Bing tests) ──
    // DDG markup is `<div class="result">` blocks containing
    // `<a class="result__a" href="…">TITLE</a>` plus a
    // `<div class="result__snippet">…</div>`. The Node parser
    // (NodeToolAdapter.ts) mirrors these fixtures and assertions exactly.

    #[test]
    fn parses_duckduckgo_results_with_entity_decoding() {
        // The title/snippet are intentionally padded with stray whitespace:
        // BOTH parsers strip → decode → trim, so the padding must not leak
        // into the parsed output. Locked here so the mirror holds even when
        // real HTML has ragged spacing inside the anchor/snippet tags.
        let html = r#"<div class="result"><a class="result__a" href="https://rust-lang.org/"> Rust Programming Language </a>
<div class="result__snippet"> Rust is blazingly fast and memory-efficient. </div>
</div>
<div class="result"><a class="result__a" href="https://www.runoob.com/rust/rust-tutorial.html?a=1&amp;b=2"> Rust &#10148; 教程 </a>
<div class="result__snippet"> Rust 教程 &ensp;&#0183;&ensp;由 Mozilla 主导开发。 </div>
</div>"#;
        let results = parse_duckduckgo_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://rust-lang.org/");
        assert!(results[0].snippet.contains("memory-efficient"));
        assert!(results[1].title.contains("教程"));
        assert!(results[1].snippet.contains("Mozilla"));
        // Numeric + named entities decoded out of the raw markup — the title
        // (&#10148; arrow), the snippet (&#0183; middle dot / &ensp;), and
        // &amp; in the URL. The Node parser mirrors these assertions.
        assert!(results[1].title.contains('➤'));
        assert!(!results[1].title.contains("&#10148;"));
        assert!(results[1].snippet.contains('·'));
        assert!(!results[1].snippet.contains("&#"));
        assert!(!results[1].snippet.contains("&ensp;"));
        assert_eq!(
            results[1].url,
            "https://www.runoob.com/rust/rust-tutorial.html?a=1&b=2"
        );
    }

    #[test]
    fn duckduckgo_parser_stops_at_max() {
        let html = r#"<div class="result"><a class="result__a" href="https://a.com/x">A</a>
<div class="result__snippet">a</div>
</div>
<div class="result"><a class="result__a" href="https://b.com/x">B</a>
<div class="result__snippet">b</div>
</div>
<div class="result"><a class="result__a" href="https://c.com/x">C</a>
<div class="result__snippet">c</div>
</div>"#;
        let results = parse_duckduckgo_results(html, 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://a.com/x");
        assert_eq!(results[1].url, "https://b.com/x");
    }

    #[test]
    fn duckduckgo_parser_skips_blocks_without_links() {
        let html = r#"<div class="result"><div class="result__snippet">No link here</div>
</div>
<div class="result"><a class="result__a" href="https://ok.com/x">OK Title</a>
<div class="result__snippet">snippet</div>
</div>"#;
        let results = parse_duckduckgo_results(html, 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://ok.com/x");
    }

    #[test]
    fn parses_cn_bing_markup_with_shared_parser() {
        // cn.bing.com serves the SAME b_algo structure as www.bing.com — this
        // locks that the China backend can reuse parse_bing_results unchanged.
        // Mirrors the Node fixture (searchParser.test.ts).
        let html = r#"<li class="b_algo"><h2><a href="https://baike.baidu.com/item/西安"> 西安市（Xi'an City） </a></h2><div class="b_caption"><p> 陕西省省会、副省级市、特大城市。 </p></div></li>"#;
        let results = parse_bing_results(html, 10);
        assert_eq!(results.len(), 1);
        assert!(results[0].title.contains("西安"));
        assert!(results[0].snippet.contains("省会"));
        assert_eq!(results[0].url, "https://baike.baidu.com/item/西安");
    }

    #[test]
    fn chinese_query_detection_mirrors_node() {
        // The CJK detection that routes Chinese queries to cn.bing.com FIRST.
        // NodeToolAdapter.ts `containsCJK` must agree on every case.
        assert!(is_chinese_query("查机票，从西安到重庆"));
        assert!(is_chinese_query("西安到重庆 机票 航班 价格"));
        assert!(is_chinese_query("繁體中文"));
        assert!(!is_chinese_query("flights Xi'an to Chongqing"));
        assert!(!is_chinese_query("rust programming language"));
        assert!(!is_chinese_query(""));
    }

    #[test]
    fn charset_from_content_type_extracts_declared_charset() {
        // The Content-Type header charset is the first authority for decoding
        // a fetched page — mirrors Node charsetFromContentType (including the
        // `charset = x` spacing tolerance and quoted values).
        assert_eq!(
            charset_from_content_type("text/html; charset=gb2312").as_deref(),
            Some("gb2312")
        );
        assert_eq!(
            charset_from_content_type("text/html; charset = gb2312").as_deref(),
            Some("gb2312")
        );
        assert_eq!(
            charset_from_content_type("text/html; charset=\"utf-8\"").as_deref(),
            Some("utf-8")
        );
        assert_eq!(charset_from_content_type("text/html").as_deref(), None);
    }

    #[test]
    fn sniff_html_charset_finds_meta_tag() {
        // Pages without a header charset (very common on Chinese sites) are
        // decoded via their <meta> tag — mirrors Node sniffHtmlCharset.
        let head = br#"<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head>"#;
        assert_eq!(sniff_html_charset(head).as_deref(), Some("gb2312"));
        assert_eq!(
            sniff_html_charset(br"<meta charset=UTF-8>").as_deref(),
            Some("utf-8")
        );
        assert_eq!(
            sniff_html_charset(b"<html><body>no meta</body></html>").as_deref(),
            None
        );
    }

    #[test]
    fn gbk_body_decodes_to_chinese() {
        // 中文 in GBK — the exact bytes a Sogou-style GBK page carries. UTF-8
        // decoding these bytes is mojibake; the charset-aware decode must not
        // be (this is the mechanism behind web_fetch / fetch_search_page).
        let bytes: &[u8] = &[0xd6, 0xd0, 0xce, 0xc4];
        assert_eq!(decode_bytes_with_label(bytes, Some("gb2312")), "中文");
        // utf-8-family labels skip re-decoding (a latin1 mislabel must not
        // garble an actually-UTF-8 page into windows-1252 mojibake).
        assert_eq!(
            decode_bytes_with_label(bytes, Some("utf-8")),
            String::from_utf8_lossy(bytes)
        );
        assert!(is_utf8_family_label("utf-8"));
        assert!(is_utf8_family_label("iso-8859-1"));
        assert!(!is_utf8_family_label("gb2312"));
        assert!(!is_utf8_family_label("big5"));
    }

    #[test]
    fn utf8_bom_is_stripped_on_decode() {
        // A UTF-8 BOM must not leak into the output — mirrors the Node
        // TextDecoder (strips per spec) and the old reqwest .text() path.
        let bytes: &[u8] = &[0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_eq!(decode_bytes_with_label(bytes, None), "hi");
        assert_eq!(decode_bytes_with_label(bytes, Some("utf-8")), "hi");
    }

    #[test]
    fn parses_serper_organic_results() {
        // Serper returns `organic[]` with title/link/snippet. Entries missing
        // a title or link are skipped; snippet may be empty and is kept.
        let body = serde_json::json!({
            "organic": [
                { "title": "Rust 编程语言", "link": "https://www.rust-lang.org/zh-CN/", "snippet": "Rust 是一门系统编程语言", "position": 1 },
                { "title": "No link", "snippet": "x" },
                { "title": "", "link": "https://x.com", "snippet": "y" },
                { "title": "B", "link": "https://b.com/", "snippet": "" }
            ]
        });
        let results = parse_serper_results(&body, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust 编程语言");
        assert_eq!(results[0].url, "https://www.rust-lang.org/zh-CN/");
        assert!(results[0].snippet.contains("系统编程"));
        assert_eq!(results[1].url, "https://b.com/");
        assert_eq!(results[1].snippet, "");
    }

    #[test]
    fn serper_parser_respects_max() {
        let body = serde_json::json!({
            "organic": [
                { "title": "A", "link": "https://a.com" },
                { "title": "B", "link": "https://b.com" },
                { "title": "C", "link": "https://c.com" }
            ]
        });
        let results = parse_serper_results(&body, 2);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn parses_tavily_results_mirroring_node() {
        // Tavily returns `results[]` with title/url/content. The Node
        // tavilySearch() (NodeToolAdapter.ts) mirrors these assertions.
        let body = serde_json::json!({
            "results": [
                { "title": "西安到重庆机票", "url": "https://flights.example.com/xian-chongqing", "content": "航班时刻表与价格" },
                { "title": "", "url": "https://bad.example", "content": "x" },
                { "title": "B", "url": "https://b.example", "content": "" }
            ]
        });
        let results = parse_tavily_results(&body, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "西安到重庆机票");
        assert!(results[0].snippet.contains("航班时刻表"));
        assert_eq!(results[1].url, "https://b.example");
        assert_eq!(results[1].snippet, "");
    }

    #[test]
    fn configured_backend_names_reflects_api_keys() {
        assert_eq!(
            configured_backend_names(None, None),
            "Sogou, cn.bing.com, 360, Baidu, DuckDuckGo, Bing, Brave"
        );
        assert_eq!(
            configured_backend_names(Some("k"), None),
            "Serper, Sogou, cn.bing.com, 360, Baidu, DuckDuckGo, Bing, Brave"
        );
        assert_eq!(
            configured_backend_names(Some("k"), Some("")),
            "Serper, Sogou, cn.bing.com, 360, Baidu, DuckDuckGo, Bing, Brave"
        );
        assert_eq!(
            configured_backend_names(Some("k"), Some("t")),
            "Serper, Tavily, Sogou, cn.bing.com, 360, Baidu, DuckDuckGo, Bing, Brave"
        );
    }

    #[test]
    fn parses_sogou_results_with_redirect_absolutization() {
        // vr-title h3 blocks: anchor inside the h3, star-wiki <p> snippet
        // right after </h3>; <em> highlights INSIDE the title; relative
        // /link?url=… hrefs absolutized. Mirrors the Node fixture.
        let html = r#"<h3 class="vr-title"><a name="dttl" href="/link?url=abc123" id="sogou_vr_1">为什么要使用 <em>Rust</em> <em>语言</em>？</a></h3><div class="star-wiki"><p class="star-wiki base-ellipsis clamp3 space-txt">Rust 语言的优势在哪里？</p></div>
<h3 class="vr-title"><a href="//www.sogou.com/link?url=def">第二条 <em>结果</em></a></h3><p class="star-wiki">摘要二</p>"#;
        let results = parse_sogou_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "为什么要使用 Rust 语言？");
        assert_eq!(results[0].url, "https://www.sogou.com/link?url=abc123");
        assert!(results[0].snippet.contains("Rust 语言的优势"));
        assert_eq!(results[1].url, "https://www.sogou.com/link?url=def");
    }

    #[test]
    fn sogou_parser_skips_duplicates_and_bad_blocks() {
        let html = r#"<h3 class="vr-title"><a href="/link?url=x">唯一 <em>结果</em></a></h3><p class="star-wiki">s</p>
<h3 class="vr-title"><a href="/link?url=x">唯一 结果</a></h3><p class="star-wiki">dup</p>
<h3 class="vr-title"><div>no anchor here</div></h3>"#;
        let results = parse_sogou_results(html, 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "唯一 结果");
    }

    #[test]
    fn parses_so360_results_with_data_mdurl() {
        // res-list <li> blocks: data-mdurl carries the real URL; res-desc <p>
        // holds the snippet (span inside stripped). Mirrors real so.com markup.
        let html = r#"<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://blog.csdn.net/rust/123" rel="noopener">了解<em>Rust语言</em>-CSDN博客</a></h3><div class="res-rich so-rich-blog clearfix"><div class="res-comm-con"><p class="res-desc"><span class="res-list-summary">Rust 是一门系统编程语言。</span></p></div></div></li>
<li class="res-list"><h3 class="res-title"><a href="/link?m=def">无 mdurl 的结果</a></h3><p class="res-desc">摘要</p></li>"#;
        let results = parse_so360_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "了解Rust语言-CSDN博客");
        assert_eq!(results[0].url, "https://blog.csdn.net/rust/123");
        assert!(results[0].snippet.contains("系统编程语言"));
        assert_eq!(results[1].url, "https://www.so.com/link?m=def");
    }

    #[test]
    fn parses_baidu_results_with_data_tools_and_h3_fallback() {
        let html = r#"<div class="result c-container" id="1"><h3 class="t"><a href="https://baike.baidu.com/item/rust">Rust语言百科</a></h3><div class="c-abstract">Rust 是一门系统编程语言。</div></div>
<div class="result c-container" id="2" data-tools='{"title":"百度百科","url":"https://baike.example/2"}'><div class="content-right_8Zs40">工具摘要</div></div>"#;
        let results = parse_baidu_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust语言百科");
        assert_eq!(results[0].url, "https://baike.baidu.com/item/rust");
        assert!(results[0].snippet.contains("系统编程"));
        assert_eq!(results[1].title, "百度百科");
        assert_eq!(results[1].url, "https://baike.example/2");
    }

    #[test]
    fn parses_brave_results_with_rotating_svelte_classes() {
        // The svelte hash suffixes rotate across Brave builds — matching must
        // ride on the stable class prefixes only.
        let html = r#"<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web"><div class="result-wrapper svelte-1rq4ngz"><div class="result-content svelte-1rq4ngz"><a href="https://rust-lang.org/" target="_self" class="svelte-14r20fy l1"><div class="site-name-wrapper svelte-on1hvy">rust-lang.org</div></a><div class="title search-snippet-title line-clamp-1 svelte-14r20fy">Rust Programming Language</div><p class="generic-snippet svelte-1cwdgg3">A language empowering everyone to build reliable software.</p></div></div></div>
<div class="snippet svelte-jmfu5f" data-pos="1" data-type="web"><div class="result-wrapper svelte-1rq4ngz"><a href="https://example.com/2"><div class="title search-snippet-title svelte-14r20fy">Two</div></a><p class="generic-snippet svelte-1cwdgg3">s2</p></div></div>"#;
        let results = parse_brave_results(html, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://rust-lang.org/");
        assert!(results[0].snippet.contains("empowering"));
        assert_eq!(results[1].url, "https://example.com/2");
    }

    #[test]
    fn parses_jina_markdown_results_and_resolves_bing_redirects() {
        // Real r.jina.ai output shape for bing.com/search: numbered markdown
        // headings with **bold** title fragments and /ck/a redirect URLs whose
        // u= param holds the base64 real URL.
        let md = r#"Title: rust language - Bing

URL Source: https://www.bing.com/search?q=rust+language

Markdown Content:
About 16,200 results

1.   ## [**Rust** Programming **Language**](https://www.bing.com/ck/a?!&&p=abc&u=aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1)

A language empowering everyone to build reliable and efficient software.

2.   ## [Install **Rust**](https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnL3Rvb2xzL2luc3RhbGwv)

Install the toolchain.
"#;
        let results = parse_jina_markdown_results(md, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://rust-lang.org/");
        assert!(results[0].snippet.contains("empowering"));
        // a1-prefixed variant decodes too.
        assert_eq!(results[1].url, "https://rust-lang.org/tools/install/");
    }

    #[test]
    fn resolve_bing_ck_url_leaves_plain_urls_untouched() {
        assert_eq!(resolve_bing_ck_url("https://example.com/page"), "https://example.com/page");
        // Percent-encoded base64 also decodes.
        assert_eq!(
            resolve_bing_ck_url("https://www.bing.com/ck/a?u=aHR0cHM6Ly9leGFtcGxlLmNvbS8%3D&ntb=1"),
            "https://example.com/"
        );
    }

    #[test]
    fn normalize_query_strips_operators_and_punctuation() {
        assert_eq!(
            normalize_query_for_retry("\"rust\" site:rust-lang.org 2026").as_deref(),
            Some("rust 2026")
        );
        assert_eq!(
            normalize_query_for_retry("西安到重庆 机票？（价格）").as_deref(),
            Some("西安到重庆 机票 价格")
        );
        // Nothing to strip → None (no pointless retry).
        assert_eq!(normalize_query_for_retry("plain query"), None);
        assert_eq!(normalize_query_for_retry("西安天气"), None);
    }

    #[test]
    fn parses_searxng_json_results() {
        let body = serde_json::json!({
            "results": [
                {"title": "Rust", "url": "https://rust-lang.org/", "content": "s1"},
                {"title": "", "url": "https://empty.example/", "content": "skip me"},
                {"title": "T2", "url": "https://t2.example/", "content": "s2"}
            ]
        });
        let results = parse_searxng_results(&body, 10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust");
        assert_eq!(results[0].url, "https://rust-lang.org/");
        assert_eq!(results[1].snippet, "s2");
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("pure-resolve-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // resolve() canonicalizes the workspace base (macOS /var → /private/var);
        // the assertion must compare against the same canonical base.
        let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        canonical.to_str().unwrap().to_string()
    }

    #[test]
    fn path_info_and_remove_path_are_safe_for_snapshot_restore() {
        let ws = temp_workspace("snapshot");
        let file = PathBuf::from(&ws).join("new.txt");
        fs::write(&file, "agent").unwrap();
        let info = path_info(ws.clone(), "new.txt".into()).unwrap();
        assert_eq!(info["exists"], true);
        assert_eq!(info["isDirectory"], false);
        remove_path(ws.clone(), "new.txt".into(), Some(false)).unwrap();
        assert!(!file.exists());
        assert!(remove_path(ws.clone(), ".".into(), Some(true)).is_err());
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn joins_without_doubling_the_workspace_path() {
        // Regression: the old implementation re-joined the absolute path
        // components onto the base, doubling every path. The resolved path
        // must be exactly base.join(path).
        let ws = temp_workspace("nodouble");
        let r = resolve(&ws, "sub/dir/file.txt").unwrap();
        assert_eq!(r, PathBuf::from(&ws).join("sub/dir/file.txt"));
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn collapses_dot_dot_segments() {
        let ws = temp_workspace("dots");
        let r = resolve(&ws, "a/../b.txt").unwrap();
        assert_eq!(r, PathBuf::from(&ws).join("b.txt"));
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn accepts_absolute_paths_inside_workspace() {
        let ws = temp_workspace("absolute");
        let absolute = PathBuf::from(&ws).join("src/新 文件.txt");
        let r = resolve(&ws, absolute.to_str().unwrap()).unwrap();
        assert_eq!(r, absolute);
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn accepts_new_files_below_a_workspace_with_spaces() {
        let ws = temp_workspace("空 格");
        let r = resolve(&ws, "src/中文 文件.ts").unwrap();
        assert_eq!(r, PathBuf::from(&ws).join("src/中文 文件.ts"));
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn list_files_caps_results_and_reports_truncation() {
        let ws = temp_workspace("list-cap");
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(PathBuf::from(&ws).join(name), "").unwrap();
        }
        let output = list_files(ws.clone(), ".".into(), Some(false), Some(2)).unwrap();
        assert!(output.contains("[截断]"));
        assert_eq!(
            output.split("\n\n[截断]").next().unwrap().lines().count(),
            2
        );
        fs::remove_dir_all(&ws).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn allows_files_through_a_symlink_outside_workspace() {
        // Workspace confinement is removed — a symlink pointing outside the
        // workspace resolves to its real target instead of being refused.
        let ws = temp_workspace("symlink");
        let outside =
            std::env::temp_dir().join(format!("pure-resolve-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, PathBuf::from(&ws).join("linked")).unwrap();
        assert!(resolve(&ws, "linked/evil.txt").is_ok());
        fs::remove_dir_all(&outside).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_new_files_through_a_dangling_symlink() {
        let ws = temp_workspace("dangling-symlink");
        let link = PathBuf::from(&ws).join("linked");
        std::os::unix::fs::symlink("/definitely/missing/outside", &link).unwrap();
        assert!(resolve(&ws, "linked/evil.txt").is_err());
        assert!(!PathBuf::from(&ws).join("linked/evil.txt").exists());
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[test]
    fn allows_absolute_paths_outside_the_workspace() {
        // Workspace confinement is removed: absolute paths anywhere on disk
        // are accepted (not just paths under the workspace root).
        let ws = temp_workspace("absolute-outside");
        let outside =
            std::env::temp_dir().join(format!("pure-resolve-absout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("note.txt");
        fs::write(&target, "outside").unwrap();
        let r = resolve(&ws, target.to_str().unwrap()).unwrap();
        assert_eq!(r, fs::canonicalize(&target).unwrap());
        fs::remove_dir_all(&outside).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }
}

#[cfg(test)]
mod file_text_extraction_tests {
    use super::*;
    use std::io::Write as _;



    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pure-filetext-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_docx_bytes() -> Vec<u8> {
        let xml = "<?xml version=\"1.0\"?><w:document><w:body><w:p><w:r><w:t>公司名称：北极星科技有限公司</w:t></w:r></w:p><w:p><w:r><w:t>地址：北京市</w:t></w:r></w:p></w:body></w:document>";
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        writer
            .start_file("word/document.xml", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn decode_text_bytes_handles_gbk_utf16_and_utf8() {
        // GBK (Chinese Windows ANSI default): 你好 = C4E3 BAC3
        let gbk = [0xC4u8, 0xE3, 0xBA, 0xC3];
        assert_eq!(decode_text_bytes(&gbk), "你好");
        // UTF-16LE with BOM
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "Hello 你好".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&utf16), "Hello 你好");
        // plain UTF-8
        assert_eq!(decode_text_bytes("公司".as_bytes()), "公司");
    }

    #[test]
    fn xml_text_in_tag_extracts_docx_paragraphs() {
        let text = xml_text_in_tag(
            "<w:document><w:p><w:r><w:t>第一段&amp;内容</w:t></w:r></w:p><w:p><w:t>第二段</w:t></w:p></w:document>",
            "w:t",
        );
        assert!(text.contains("第一段&内容"));
        assert!(text.contains("第二段"));
    }

    #[test]
    fn zip_entry_extracts_docx_text() {
        let bytes = make_docx_bytes();
        let text = zip_entry_xml_text(&bytes, "word/document.xml", "w:t").unwrap();
        assert!(text.contains("北极星科技有限公司"));
    }

    #[test]
    fn pdf_extract_text_handles_literal_and_cid_strings() {
        // Uncompressed content stream + a ToUnicode CMap (C4E3→你, BAC3→好)
        let pdf = concat!(
            "%PDF-1.4\n",
            "1 0 obj\n<< /Type /Catalog >>\nendobj\n",
            "2 0 obj\n<< /Length 400 >>\nstream\n",
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n",
            "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n",
            "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
            "1 beginbfchar\n<C4E3> <4F60>\nendbfchar\n",
            "1 beginbfrange\n<BAC3> <BAC3> <597D>\nendbfrange\n",
            "endcmap\nend\nend\nendstream\nendobj\n",
            "3 0 obj\n<< /Length 120 >>\nstream\n",
            "BT\n/F1 12 Tf\n(Hello) Tj\nT*\n<C4E3BAC3> Tj\nET\n",
            "endstream\nendobj\n%%EOF\n",
        );
        let (text, note) = pdf_extract_text(pdf.as_bytes());
        assert!(note.is_empty(), "note should be empty: {}", note);
        assert!(text.contains("Hello"));
        assert!(text.contains("你好"), "CID text should map through ToUnicode: {}", text);
    }

    #[test]
    fn pdf_extract_text_notes_scanned_pdf() {
        let pdf = b"%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n%%EOF";
        let (text, note) = pdf_extract_text(pdf);
        assert!(text.is_empty());
        assert!(note.contains("PDF"), "scanned/empty PDF gets an actionable note");
    }

    #[test]
    fn rtf_extract_text_decodes_gbk_escapes_and_unicode() {
        // \'c4\'e3\'ba\'c3 = 你好 (GBK); \u20013 = 中
        let rtf = b"{\\rtf1\\ansi\\ansicpg936 {\\fonttbl {\\f0 \\'cb\\'ce\\'cc\\'e5;}}\\f0\\pard Hello \\'c4\\'e3\\'ba\\'c3\\u20013?\\par}";
        let text = rtf_extract_text(rtf);
        assert!(text.contains("Hello"));
        assert!(text.contains("你好"), "GBK escapes decode: {}", text);
        assert!(text.contains("中"), "unicode escapes decode: {}", text);
    }

    #[test]
    fn extract_file_text_detects_binary_and_ole() {
        let png: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let (text, note) = extract_file_text(&png, std::path::Path::new("logo.png"));
        assert!(text.is_empty());
        assert!(note.contains("PNG"));
        let ole: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        let (text, note) = extract_file_text(&ole, std::path::Path::new("old.doc"));
        assert!(text.is_empty());
        assert!(note.contains("doc"), "OLE note suggests conversion: {}", note);
    }

    #[test]
    fn search_files_finds_content_inside_docx_and_reports_skips() {
        let dir = temp_dir("search-docx");
        fs::write(dir.join("notes.docx"), make_docx_bytes()).unwrap();
        fs::write(dir.join("report.txt"), "公司名称：北极星科技有限公司\n其他内容").unwrap();
        // Old .doc (OLE magic) — must be skipped with a hint, not silently
        let ole: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        fs::write(dir.join("legacy.doc"), ole).unwrap();

        let ws = dir.to_string_lossy().into_owned();
        let result = search_files(ws.clone(), "北极星".into(), None, None, None, None).unwrap();
        assert!(result.contains("notes.docx"), "docx content searchable: {}", result);
        assert!(result.contains("report.txt"));
        assert!(result.contains("legacy.doc"), "skipped binary listed in hint: {}", result);
        assert!(result.contains("无法解析") || result.contains("已跳过"), "skip hint present: {}", result);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_files_case_sensitive_flag() {
        let dir = temp_dir("search-case");
        fs::write(dir.join("upper.txt"), "Apple Pie").unwrap();
        fs::write(dir.join("lower.txt"), "apple pie").unwrap();
        let ws = dir.to_string_lossy().into_owned();
        let loose = search_files(ws.clone(), "apple".into(), None, None, None, None).unwrap();
        assert!(loose.contains("upper.txt") && loose.contains("lower.txt"));
        let strict = search_files(ws.clone(), "apple".into(), None, None, None, Some(true)).unwrap();
        assert!(strict.contains("lower.txt"));
        assert!(!strict.contains("upper.txt"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_files_accepts_a_single_file_path() {
        let dir = temp_dir("search-file");
        let file = dir.join("target.docx");
        fs::write(&file, make_docx_bytes()).unwrap();
        let ws = dir.to_string_lossy().into_owned();
        let result = search_files(ws.clone(), "北极星".into(), Some(file.to_string_lossy().into_owned()), None, None, None).unwrap();
        assert!(result.contains("target.docx"), "single-file search: {}", result);
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod write_file_stream_tests {
    use super::*;

    // Channel::send serializes the String payload as a JSON string, exactly
    // what the JS side receives (JSON.parse(raw)) — so the test callback
    // mirrors the adapter: deserialize to String, then parse the JSON.
    fn capturing_channel(events: &Arc<StdMutex<Vec<serde_json::Value>>>) -> Channel<String> {
        let events = Arc::clone(events);
        Channel::new(move |body| {
            if let Ok(s) = body.deserialize::<String>() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    events.lock().unwrap().push(v);
                }
            }
            Ok(())
        })
    }

    fn temp_workspace(name: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("pure-write-stream-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // resolve() canonicalizes the workspace base (macOS /var → /private/var);
        // the test must read back through the SAME canonical path, or the
        // read misses the file the command wrote.
        let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        canonical.to_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn streams_chunked_progress_and_writes_the_file() {
        let workspace = temp_workspace("chunked");
        // 128 KB + 1 byte forces 3 chunks (64 KB each) → ≥3 progress events
        // with monotonic written counts ending exactly at the total.
        let content = "x".repeat(128 * 1024 + 1);
        let events: Arc<StdMutex<Vec<serde_json::Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let ch = capturing_channel(&events);

        let msg = write_file_stream_inner(&workspace, "sub/dir/app.js", &content, &ch)
            .await
            .unwrap();
        assert!(msg.contains("131073 bytes"), "msg: {}", msg);
        assert!(msg.contains("sub/dir/app.js"));

        // File landed with the exact content (parent dirs auto-created).
        let dir = PathBuf::from(&workspace);
        let written = fs::read_to_string(dir.join("sub/dir/app.js")).unwrap();
        assert_eq!(written.len(), content.len());

        let events = events.lock().unwrap();
        assert!(
            events.len() >= 3,
            "expected ≥3 chunk events, got {}",
            events.len()
        );
        let mut last = 0usize;
        for ev in events.iter() {
            assert_eq!(ev["type"], "progress");
            let written = ev["written"].as_u64().unwrap() as usize;
            let total = ev["total"].as_u64().unwrap() as usize;
            assert_eq!(total, content.len());
            assert!(written >= last && written <= total);
            last = written;
        }
        assert_eq!(last, content.len(), "final event must report full write");
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[tokio::test]
    async fn small_file_emits_a_single_full_event() {
        let workspace = temp_workspace("small");
        let events: Arc<StdMutex<Vec<serde_json::Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let ch = capturing_channel(&events);

        let msg = write_file_stream_inner(&workspace, "hi.txt", "hello", &ch)
            .await
            .unwrap();
        assert_eq!(msg, "Wrote 5 bytes to hi.txt");

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["written"], 5);
        assert_eq!(events[0]["total"], 5);
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[tokio::test]
    async fn empty_content_writes_zero_bytes() {
        let workspace = temp_workspace("empty");
        let events: Arc<StdMutex<Vec<serde_json::Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let ch = capturing_channel(&events);

        let msg = write_file_stream_inner(&workspace, "empty.txt", "", &ch)
            .await
            .unwrap();
        assert_eq!(msg, "Wrote 0 bytes to empty.txt");
        assert_eq!(
            fs::read_to_string(PathBuf::from(&workspace).join("empty.txt")).unwrap(),
            ""
        );
        // No chunks → no events (nothing to report for a zero-byte write).
        assert!(events.lock().unwrap().is_empty());
        fs::remove_dir_all(&workspace).unwrap();
    }
}

#[cfg(test)]
mod execute_command_tests {
    use super::*;

    #[tokio::test]
    async fn reports_success_with_zero_exit() {
        let out = execute_command(".".to_string(), "echo hello".to_string(), None)
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn reports_failure_with_nonzero_exit_and_stderr() {
        let out = execute_command(".".to_string(), "echo boom >&2; exit 3".to_string(), None)
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 3);
        assert!(out["stderr"].as_str().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn keeps_stdout_even_when_command_fails() {
        let out = execute_command(".".to_string(), "echo partial; exit 2".to_string(), None)
            .await
            .unwrap();
        assert_eq!(out["exitCode"], 2);
        assert!(out["stdout"].as_str().unwrap().contains("partial"));
    }
}

#[cfg(test)]
mod command_cancel_tests {
    use super::*;

    #[tokio::test]
    async fn kill_process_group_terminates_shell_tree() {
        #[cfg(unix)]
        {
            let mut child = TokioCommand::new("sh")
                .arg("-c")
                .arg("sleep 30")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap();
            let pid = child.id().unwrap() as i32;

            kill_process_group(pid).unwrap();

            let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
                .await
                .expect("killed process should exit within the timeout")
                .unwrap();
            assert!(!status.success(), "killed process must not report success");
        }
    }

    #[tokio::test]
    async fn stream_registers_then_unregisters_running_command() {
        let registry = StdMutex::new(BTreeMap::<String, u32>::new());
        let ch = Channel::new(|_: tauri::ipc::InvokeResponseBody| Ok(()));
        let code = execute_command_stream_inner(
            &registry,
            "test-call-1",
            ".",
            "echo hello",
            &ch,
            None,
        )
        .await
            .unwrap();
        assert_eq!(code, 0);
        let reg = registry.lock().unwrap();
        assert!(
            !reg.contains_key("test-call-1"),
            "registry must be cleaned up after the command finishes"
        );
    }

    #[tokio::test]
    async fn kill_command_terminates_a_registered_streaming_command() {
        let registry = Arc::new(StdMutex::new(BTreeMap::<String, u32>::new()));
        let ch = Channel::new(|_: tauri::ipc::InvokeResponseBody| Ok(()));
        let id = "test-call-kill".to_string();
        let reg_for_task = Arc::clone(&registry);
        let ch_for_task = ch.clone();
        let id_for_task = id.clone();
        let task = tokio::spawn(async move {
            execute_command_stream_inner(&reg_for_task, &id_for_task, ".", "sleep 30", &ch_for_task, None)
                .await
                .unwrap_or(-1)
        });

        // Give the command a moment to spawn and register itself.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let pid = {
            let reg = registry.lock().unwrap();
            reg.get(&id).copied()
        };
        assert!(
            pid.is_some(),
            "running command must be registered while alive"
        );
        kill_process_group(pid.unwrap() as i32).unwrap();

        let code = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("killed command should exit promptly")
            .unwrap();
        assert_ne!(code, 0, "killed command must report a non-zero exit code");

        let reg = registry.lock().unwrap();
        assert!(
            !reg.contains_key(&id),
            "registry must be cleaned up after the kill"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Web tool result cache (~/.pure/cache/web-cache.json)
//  Shared TTL cache for web_search / web_public_api / web_scrape / web_fetch
//  results — the SAME file and key scheme as the Node CLI (src/adapter/node/
//  webCache.ts, FNV-1a over the same key parts), so CLI and GUI share warm
//  results instead of each paying the free-tier quota. Bounded (200 entries,
//  oldest-first eviction, per-value size cap), corrupt-file tolerant,
//  PURE_WEB_CACHE=off disables, PURE_CACHE_DIR overrides the base dir.
// ═══════════════════════════════════════════════════════════════════════════════

const WEB_CACHE_MAX_ENTRIES: usize = 200;
const WEB_CACHE_MAX_VALUE_BYTES: usize = 30_000;
const SEARCH_TTL_MS: u64 = 15 * 60 * 1000;
const PAGE_TTL_MS: u64 = 60 * 60 * 1000;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CacheRecord {
    v: String,
    /// Epoch ms when the record was written.
    t: u64,
    /// TTL in ms — records past t+ttl are expired.
    ttl: u64,
}

/// FNV-1a 64-bit — byte-identical to the Node side's fnv1a64 (webCache.ts) so
/// CLI and GUI produce the same cache keys for the same query/URL.
fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

fn cache_hash_key(parts: &[&str]) -> String {
    format!("{:x}", fnv1a64(&parts.join("\0")))
}

fn web_cache_file() -> PathBuf {
    let base = std::env::var("PURE_CACHE_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{}/.pure", home)
    });
    PathBuf::from(base).join("cache").join("web-cache.json")
}

fn web_cache_enabled() -> bool {
    // Enabled by default; only explicit off/0/false disables. (Unset == "" is
    // NOT a disable — matches the Node webCacheEnabled.)
    let f = std::env::var("PURE_WEB_CACHE")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    f != "off" && f != "0" && f != "false"
}

// ═══════════════════════════════════════════════════════════════════════════
//  App skills directory (~/.pure/skills) — capability-gap auto-loading
//  Skills installed there (manually or by the agent per the capability-gap
//  protocol) are injected into the system prompt like Skill Hub skills.
//  Mirror of src/shared/skillFiles.ts (CLI scans the same dir with node:fs).
// ═══════════════════════════════════════════════════════════════════════════

fn app_skills_dir() -> PathBuf {
    let base = std::env::var("PURE_SKILLS_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{}/.pure", home)
    });
    PathBuf::from(base).join("skills")
}

fn parse_skill_markdown(text: &str) -> Option<(String, String, String)> {
    let trimmed = text.trim_start();
    let rest = trimmed.strip_prefix("---")?.trim_start();
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim();
    if body.is_empty() {
        return None;
    }
    let field = |key: &str| -> Option<String> {
        frontmatter.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?;
            let value = rest.strip_prefix(':')?.trim();
            if value.is_empty() { None } else { Some(value.to_string()) }
        })
    };
    let name = field("name")?;
    if name.is_empty() {
        return None;
    }
    let description = field("description").unwrap_or_default();
    Some((name, description, body.to_string()))
}

/// List skills from the app skills directory (~/.pure/skills) plus the
/// workspace's project-local .agents/skills directory (name/description/body),
/// used by the GUI to inject them into the system prompt. Mirrors the CLI's
/// loadAppSkills directory order (user skills first, project skills second).
/// Never fails: a missing or unreadable directory just yields an empty list.
#[tauri::command]
fn list_app_skills(workspace: String) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut dirs = vec![app_skills_dir()];
    let project = workspace.trim();
    if !project.is_empty() {
        dirs.push(PathBuf::from(project).join(".agents").join("skills"));
    }
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let skill_file = entry.path().join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&skill_file) else { continue };
            if let Some((name, description, body)) = parse_skill_markdown(&text) {
                out.push(serde_json::json!({
                    "name": name,
                    "description": description,
                    "body": body,
                }));
            }
        }
    }
    out
}

/// Persist a downloaded skill into the application-owned skills directory.
/// The name is deliberately limited to one safe directory component so a
/// community catalog cannot turn an install into an arbitrary file write.
#[tauri::command]
fn write_app_skill(name: String, description: String, body: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 120
        || name == "."
        || name == ".."
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("skill name must contain only letters, numbers, '-', '_' or '.'".to_string());
    }
    if body.trim().is_empty() || body.len() > 2 * 1024 * 1024 {
        return Err("skill body is empty or exceeds the 2MB limit".to_string());
    }
    let dir = app_skills_dir().join(name);
    fs::create_dir_all(&dir).map_err(|e| format!("create skill directory: {}", e))?;
    let description = description.trim().replace('\r', " ").replace('\n', " ");
    let markdown = format!("---\nname: {}\ndescription: {}\n---\n\n{}\n", name, description, body.trim());
    fs::write(dir.join("SKILL.md"), markdown).map_err(|e| format!("write SKILL.md: {}", e))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod app_skills_tests {
    use super::*;
    use std::sync::Mutex;

    // Two tests below mutate the process-global PURE_SKILLS_DIR; serialize
    // them so parallel test threads can't read each other's temp directory.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parses_frontmatter_name_description_body() {
        let text = "---\nname: vision-ocr\ndescription: Extract text from images\n---\nDo OCR on images.\n";
        let parsed = parse_skill_markdown(text).expect("parses");
        assert_eq!(parsed.0, "vision-ocr");
        assert_eq!(parsed.1, "Extract text from images");
        assert_eq!(parsed.2, "Do OCR on images.");
    }

    #[test]
    fn rejects_missing_frontmatter_or_empty_body() {
        assert!(parse_skill_markdown("just prose").is_none());
        assert!(parse_skill_markdown("---\nname: x\n---\n   \n").is_none());
        assert!(parse_skill_markdown("---\ndescription: no name\n---\nbody").is_none());
    }

    #[test]
    fn write_app_skill_rejects_path_traversal_names() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!("pure-skills-write-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let prev = std::env::var("PURE_SKILLS_DIR").ok();
        std::env::set_var("PURE_SKILLS_DIR", &base);

        // `..` and `.` would escape the skills directory via PathBuf::join.
        assert!(write_app_skill("..".to_string(), "d".to_string(), "body".to_string()).is_err());
        assert!(write_app_skill(".".to_string(), "d".to_string(), "body".to_string()).is_err());
        // Slashes are rejected (single safe directory component only).
        assert!(write_app_skill("a/b".to_string(), "d".to_string(), "body".to_string()).is_err());
        // A normal name still installs.
        assert!(write_app_skill("vision-ocr".to_string(), "d".to_string(), "body".to_string()).is_ok());
        let installed = app_skills_dir().join("vision-ocr").join("SKILL.md");
        assert!(installed.exists());

        match prev {
            Some(v) => std::env::set_var("PURE_SKILLS_DIR", v),
            None => std::env::remove_var("PURE_SKILLS_DIR"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tolerates_crlf_and_extra_metadata_lines() {
        let text = "---\r\nname: pdf-extract\r\ndescription: Parse PDFs\r\nlicense: MIT\r\n---\r\nExtract text.\r\n";
        let parsed = parse_skill_markdown(&text).expect("parses");
        assert_eq!(parsed.0, "pdf-extract");
        assert_eq!(parsed.2, "Extract text.");
    }

    #[test]
    fn lists_only_valid_skills_from_the_directory() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!("pure-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // PURE_SKILLS_DIR is the BASE dir; skills live in <base>/skills/<name>/SKILL.md.
        let skills_dir = base.join("skills");
        let good = skills_dir.join("ocr").join("SKILL.md");
        std::fs::create_dir_all(good.parent().unwrap()).unwrap();
        std::fs::write(&good, "---\nname: ocr\ndescription: OCR tool\n---\nUse tesseract.\n").unwrap();
        let bad = skills_dir.join("not-a-skill").join("SKILL.md");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(&bad, "no frontmatter here").unwrap();

        let prev = std::env::var("PURE_SKILLS_DIR").ok();
        std::env::set_var("PURE_SKILLS_DIR", &base);
        let list = list_app_skills(String::new());
        match prev {
            Some(v) => std::env::set_var("PURE_SKILLS_DIR", v),
            None => std::env::remove_var("PURE_SKILLS_DIR"),
        }
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "ocr");
        assert_eq!(list[0]["description"], "OCR tool");
        assert!(list[0]["body"].as_str().unwrap().contains("tesseract"));
    }

    #[test]
    fn lists_project_dot_agents_skills_when_workspace_is_given() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!("pure-agents-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let skill = base.join(".agents").join("skills").join("find-skills").join("SKILL.md");
        std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
        std::fs::write(&skill, "---\nname: find-skills\ndescription: Skill discovery\n---\nUse npx skills.\n").unwrap();

        // Empty user-skills dir so only the project directory contributes.
        let empty_home = base.join("empty-home");
        std::fs::create_dir_all(&empty_home).unwrap();
        let prev = std::env::var("PURE_SKILLS_DIR").ok();
        std::env::set_var("PURE_SKILLS_DIR", &empty_home);

        let list = list_app_skills(base.to_string_lossy().into_owned());

        match prev {
            Some(v) => std::env::set_var("PURE_SKILLS_DIR", v),
            None => std::env::remove_var("PURE_SKILLS_DIR"),
        }
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["name"], "find-skills");
        assert_eq!(list[0]["description"], "Skill discovery");
        assert!(list[0]["body"].as_str().unwrap().contains("npx skills"));
    }
}

/// Query normalization: lowercase + trim + collapse whitespace; CJK queries
/// also drop INTERNAL whitespace ("北京天气" == "北京 天气"). Matches the Node
/// normalizeQuery.
fn normalize_query(q: &str) -> String {
    let collapsed = q.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    if is_chinese_query(&collapsed) {
        collapsed.chars().filter(|c| !c.is_whitespace()).collect()
    } else {
        collapsed
    }
}

/// Key for web_search result sets (query + result count).
fn search_cache_key(query: &str, max: usize) -> String {
    cache_hash_key(&["search", &max.to_string(), &normalize_query(query)])
}

/// Key for URL content (web_scrape / web_fetch) — selector and the maxChars
/// bucket are part of the cache identity because they change the output.
fn page_cache_key(url: &str, selector: Option<&str>, max_chars: usize) -> String {
    let bucket = if max_chars <= 20000 {
        "20k"
    } else if max_chars <= 50000 {
        "50k"
    } else {
        "big"
    };
    cache_hash_key(&["page", url.trim(), selector.unwrap_or(""), bucket])
}

/// Key for direct public-API outcomes (query + optional forced category +
/// location — weather answers differ by city).
fn public_api_cache_key(query: &str, category: Option<&str>, location: Option<&str>) -> String {
    cache_hash_key(&[
        "publicapi",
        category.unwrap_or(""),
        &normalize_query(query),
        location.unwrap_or(""),
    ])
}

/// Per-intent freshness: weather/news/stock are minutes-fresh, geocode/wiki
/// barely ever change. Mirrors PUBLIC_API_TTL_MS in publicApis.ts.
fn public_api_ttl_ms(intent: IntentKind) -> u64 {
    match intent {
        IntentKind::Weather => 20 * 60 * 1000,
        IntentKind::AirQuality => 30 * 60 * 1000,
        IntentKind::News => 10 * 60 * 1000,
        IntentKind::Stock => 10 * 60 * 1000,
        IntentKind::Fx => 6 * 60 * 60 * 1000,
        IntentKind::Ip => 24 * 60 * 60 * 1000,
        IntentKind::Github => 24 * 60 * 60 * 1000,
        IntentKind::Geocode => 30 * 24 * 60 * 60 * 1000,
        IntentKind::Wiki => 7 * 24 * 60 * 60 * 1000,
        IntentKind::WorldBank => 7 * 24 * 60 * 60 * 1000,
    }
}

struct WebCache {
    records: std::collections::HashMap<String, CacheRecord>,
    file: PathBuf,
    loaded: bool,
}

impl WebCache {
    fn new(file: PathBuf) -> Self {
        WebCache {
            records: std::collections::HashMap::new(),
            file,
            loaded: false,
        }
    }

    fn load(file: PathBuf) -> Self {
        let mut cache = WebCache::new(file);
        cache.reload();
        cache
    }

    fn reload(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        if !web_cache_enabled() {
            return;
        }
        let raw = match std::fs::read_to_string(&self.file) {
            Ok(s) => s,
            Err(_) => return,
        };
        let parsed: Option<std::collections::HashMap<String, CacheRecord>> = serde_json::from_str(&raw).ok();
        if let Some(map) = parsed {
            self.records = map;
        }
    }

    /// Fresh value for `key`, or None (expired entries are dropped).
    fn get(&mut self, key: &str) -> Option<String> {
        if !web_cache_enabled() {
            return None;
        }
        self.reload();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        match self.records.get(key) {
            Some(rec) if rec.t + rec.ttl > now => Some(rec.v.clone()),
            Some(_) => {
                self.records.remove(key);
                None
            }
            None => None,
        }
    }

    /// Store `value` under `key` for `ttl_ms`; oldest entries are evicted when
    /// the cache is over the cap. Persisted best-effort.
    fn set(&mut self, key: &str, value: &str, ttl_ms: u64) {
        if !web_cache_enabled() {
            return;
        }
        self.reload();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut value = value.to_string();
        if value.len() > WEB_CACHE_MAX_VALUE_BYTES {
            value.truncate(WEB_CACHE_MAX_VALUE_BYTES);
        }
        self.records.insert(
            key.to_string(),
            CacheRecord {
                v: value,
                t: now,
                ttl: ttl_ms,
            },
        );
        while self.records.len() > WEB_CACHE_MAX_ENTRIES {
            let oldest = self
                .records
                .iter()
                .min_by_key(|(_, rec)| rec.t)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.records.remove(&k);
                }
                None => break,
            }
        }
        self.save();
    }

    fn save(&self) {
        if !web_cache_enabled() {
            return;
        }
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&self.records) {
            let _ = std::fs::write(&self.file, json);
        }
    }
}

/// Process-wide cache. Env vars are read at first init only.
static WEB_CACHE: std::sync::OnceLock<StdMutex<WebCache>> = std::sync::OnceLock::new();

fn web_cache() -> &'static StdMutex<WebCache> {
    WEB_CACHE.get_or_init(|| StdMutex::new(WebCache::load(web_cache_file())))
}

/// try_direct_public_api + cache: fresh answers are served from the shared
/// cache without hitting the network; misses resolve through the real resolver
/// and are stored under the intent's TTL. Returns (outcome, cached).
async fn cached_direct_public_api(
    query: &str,
    category: Option<&str>,
    location: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<(Option<PublicApiOutcome>, bool), String> {
    let key = public_api_cache_key(query, category, location);
    if let Some(hit) = web_cache().lock().unwrap().get(&key) {
        if let Ok(outcome) = serde_json::from_str::<PublicApiOutcome>(&hit) {
            return Ok((Some(outcome), true));
        }
    }
    let outcome = try_direct_public_api(query, category, location, proxy_url).await?;
    if let Some(o) = &outcome {
        if let Ok(json) = serde_json::to_string(o) {
            let ttl = public_api_ttl_ms(o.intent);
            web_cache().lock().unwrap().set(&key, &json, ttl);
        }
    }
    Ok((outcome, false))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Web Public API (Tier-2) — structured direct lookups
//  Curated no-key public APIs for STRUCTURED intents (weather / geocode / news
//  / wiki / IP / FX / stock / GitHub), mirroring
//  src/adapter/node/publicApis.ts. A deterministic intent classifier decides
//  whether a query is a structured lookup — the model is never asked to pick
//  from a huge endpoint registry. Every resolver returns Ok(None) on failure
//  so callers degrade to web search / web_fetch instead of an error wall.
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum IntentKind {
    Weather,
    AirQuality,
    Geocode,
    News,
    Wiki,
    Ip,
    Fx,
    Stock,
    Github,
    WorldBank,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PublicApiOutcome {
    #[allow(dead_code)]
    intent: IntentKind,
    /// Human-readable answer text, ready to hand to the model.
    text: String,
    /// Source label for the result, e.g. "Open-Meteo".
    source: String,
}

/// Compile-once regex helpers (the regex crate has no lookahead, so the few
/// lookahead-based JS patterns are implemented structurally instead).
macro_rules! static_regex {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static regex::Regex {
            static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            RE.get_or_init(|| regex::Regex::new($pattern).expect("static regex must compile"))
        }
    };
}

// ── Intent classifier ──
// Conservative keyword routing with length caps + a build-request guard, so
// "写一个天气网站" can never be answered with weather data instead of being
// treated as a coding request. Only HIGH-confidence intents auto-route inside
// web_search; the model-facing web_public_api tool may force a category.

static_regex!(weather_re, r"(?i)天气|气温|温度|预报|会不会下雨|降雨|降雪|风力|湿度|weather|forecast|temperature|rain|snow|humidity|wind");
static_regex!(geocode_re, r"(?i)经纬度|坐标|geocode|latitude|longitude|lat\s*/?\s*lon|地理坐标");
static_regex!(news_re, r"(?i)新闻|资讯|头条|快讯|时讯|热点|报道|新闻头条|news|headlines|breaking");
static_regex!(wiki_re, r"(?i)维基|百科|是什么|是谁|简介|wikipedia|wiki");
static_regex!(ip_re, r"(?i)(?:我的)?\s*(?:ip地址|ip 地址|本机ip|外网ip|ip)$|(?:what is|my)?\s*(?:ip address|my ip)\b|ip地址|IP地址");
static_regex!(github_re, r"(?i)\bgithub\b|开源项目|最火的.*仓库|star.*最多");
static_regex!(air_quality_re, r"(?i)空气质量|空气指数|空气污染|雾霾|霾|pm2\.?5|pm10|AQI|air quality|air pollution|air index");
static_regex!(worldbank_re, r"(?i)gdp|国内生产总值|人均gdp|人口|总人口|失业率|通胀|通货膨胀|world bank|世界银行|population|unemployment|inflation");
static_regex!(time_words_re, r"今天|明天|后天|昨天|早上|上午|中午|下午|晚上|夜里|下周|上周|这周|周末|周[一二三四五六日天]|today|tomorrow|yesterday|this|next|last|week|morning|afternoon|evening|night|in|the|for|at|what|is|like|now|的|怎么样|如何|呢|吧|啊");
static_regex!(punct_re, r"[，。？?！!、,.，\s]+");

/// True for requests that want something BUILT (never auto-route these). CJK
/// prefixes match unconditionally (every Chinese build request continues with
/// CJK characters — the JS lookahead's practical equivalent); English prefixes
/// need a word boundary so "makeup" / "codex" never match.
fn is_build_request(query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return false;
    }
    static_regex!(cjk_build_re, r"^(?:写|做|建|造|生成|开发|设计|创建一个|帮我(?:写|做|建|造|开发|设计|生成|创建一个))");
    static_regex!(en_build_re, r"^(?:make|build|create|write|generate|design|develop|code)");
    if cjk_build_re().is_match(q) {
        return true;
    }
    if let Some(m) = en_build_re().find(q) {
        return q[m.end()..]
            .chars()
            .next()
            .map_or(true, |c| !(c.is_ascii_alphanumeric() || c == '_'));
    }
    false
}

/// Classify a query's structured-data intent, or None when it does not fit.
fn classify_intent(query: &str) -> Option<IntentKind> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    if is_build_request(q) {
        return None;
    }
    let len = q.chars().count();
    if weather_re().is_match(q) && len <= 40 {
        return Some(IntentKind::Weather);
    }
    if air_quality_re().is_match(q) && len <= 60 {
        return Some(IntentKind::AirQuality);
    }
    if geocode_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Geocode);
    }
    // FX is checked via its parseable currency-pair grammar, not keywords.
    if parse_fx_query(q).is_some() {
        return Some(IntentKind::Fx);
    }
    if ip_re().is_match(q) && len <= 40 {
        return Some(IntentKind::Ip);
    }
    if news_re().is_match(q) && len <= 60 {
        return Some(IntentKind::News);
    }
    if wiki_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Wiki);
    }
    if github_re().is_match(q) && len <= 60 {
        return Some(IntentKind::Github);
    }
    if resolve_stock_symbol(q).is_some() && len <= 40 {
        return Some(IntentKind::Stock);
    }
    if worldbank_re().is_match(q) && len <= 60 && worldbank_indicator(q).is_some() && worldbank_country(q).is_some() {
        return Some(IntentKind::WorldBank);
    }
    None
}

/// Extract a location name from a weather/geocode query ("北京明天天气" → 北京).
fn extract_location(query: &str) -> String {
    let mut s = weather_re().replace(query, " ").to_string();
    s = time_words_re().replace(&s, " ").to_string();
    punct_re().replace(&s, " ").trim().to_string()
}

/// Extract a location name from an air-quality query ("北京PM2.5" → 北京).
fn extract_air_quality_location(query: &str) -> String {
    let mut s = air_quality_re().replace(query, " ").to_string();
    s = time_words_re().replace(&s, " ").to_string();
    punct_re().replace(&s, " ").trim().to_string()
}

// ── FX parsing ──

struct FxRequest {
    from: String,
    to: String,
    amount: f64,
}

fn currency_code(name: &str) -> Option<&'static str> {
    Some(match name {
        "美元" | "美金" => "USD",
        "人民币" => "CNY",
        "日元" => "JPY",
        "欧元" => "EUR",
        "英镑" => "GBP",
        "港币" => "HKD",
        "韩元" => "KRW",
        "卢布" => "RUB",
        "澳元" => "AUD",
        "加元" => "CAD",
        "新台币" => "TWD",
        "新加坡元" => "SGD",
        "泰铢" => "THB",
        "卢比" => "INR",
        "巴西雷亚尔" => "BRL",
        _ => return None,
    })
}

const CURRENCY_CODES: &str = "USD|CNY|JPY|EUR|GBP|HKD|KRW|RUB|AUD|CAD|TWD|SGD|THB|INR|BRL|CHF";

fn zh_currency_names() -> String {
    [
        "美元", "美金", "人民币", "日元", "欧元", "英镑", "港币", "韩元", "卢布", "澳元", "加元", "新台币", "新加坡元", "泰铢", "卢比", "巴西雷亚尔",
    ]
    .join("|")
}

/// Parse "100 USD to CNY", "usd cny", "1美元等于多少人民币", "美元汇率".
fn parse_fx_query(query: &str) -> Option<FxRequest> {
    let q = query.trim();
    let zh_cur = zh_currency_names();
    // English pair: [amount] CODE to/in CODE
    let en_re = regex::Regex::new(&format!(
        r"(?i)^(\d+(?:\.\d+)?)?\s*({})\s*(?:to|in|→|->|兑|换成|换)?\s*({})$",
        CURRENCY_CODES, CURRENCY_CODES
    ))
    .ok()?;
    if let Some(c) = en_re.captures(q) {
        return Some(FxRequest {
            from: c[2].to_uppercase(),
            to: c[3].to_uppercase(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    // Chinese pair: N 美元等于多少人民币 / N 美元换人民币 / 美元兑人民币
    let zh_re = regex::Regex::new(&format!(
        r"^(\d+(?:\.\d+)?)?\s*({})(?:等于多少|换成多少|是多少|等于|换成|兑换成|兑|换|折合|多少)?\s*({})$",
        zh_cur, zh_cur
    ))
    .ok()?;
    if let Some(c) = zh_re.captures(q) {
        return Some(FxRequest {
            from: currency_code(&c[2])?.to_string(),
            to: currency_code(&c[3])?.to_string(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    // Bare single currency: "美元汇率" / "usd rate" → USD → CNY baseline.
    let single_re = regex::Regex::new(&format!(
        r"(?i)^(\d+(?:\.\d+)?)?\s*({}|{})(?:汇率|兑人民币|换成人民币|和人民币|对人民币|rate)?$",
        zh_cur, CURRENCY_CODES
    ))
    .ok()?;
    if let Some(c) = single_re.captures(q) {
        let code = if c[2].len() == 3 && c[2].chars().all(|ch| ch.is_ascii_alphabetic()) {
            c[2].to_uppercase()
        } else {
            currency_code(&c[2])?.to_string()
        };
        return Some(FxRequest {
            from: code,
            to: "CNY".to_string(),
            amount: c.get(1).map(|m| m.as_str().parse().unwrap_or(1.0)).unwrap_or(1.0),
        });
    }
    None
}

// ── Stock symbol resolution ──

fn resolve_stock_symbol(query: &str) -> Option<String> {
    let q = query.trim().to_lowercase();
    static KNOWN: &[(&str, &str)] = &[
        ("苹果", "usAAPL"), ("aapl", "usAAPL"), ("apple", "usAAPL"),
        ("特斯拉", "usTSLA"), ("tsla", "usTSLA"), ("tesla", "usTSLA"),
        ("英伟达", "usNVDA"), ("nvda", "usNVDA"), ("微软", "usMSFT"), ("msft", "usMSFT"),
        ("谷歌", "usGOOGL"), ("亚马逊", "usAMZN"), ("amzn", "usAMZN"), ("meta", "usMETA"),
        ("阿里巴巴", "usBABA"), ("baba", "usBABA"), ("拼多多", "usPDD"), ("pdd", "usPDD"),
        ("京东", "usJD"), ("jd", "usJD"),
        ("腾讯", "hk00700"), ("腾讯控股", "hk00700"), ("美团", "hk03690"), ("小米", "hk01810"),
        ("茅台", "sh600519"), ("贵州茅台", "sh600519"), ("比亚迪", "sz002594"), ("宁德时代", "sz300750"),
        ("中国平安", "sh601318"), ("工商银行", "sh601398"), ("招商银行", "sh600036"), ("中国石油", "sh601857"),
    ];
    for (name, symbol) in KNOWN {
        if q.contains(name) {
            return Some(symbol.to_string());
        }
    }
    // Explicit market codes: sh600519 / sz000001 / hk00700 / 0700.hk / aapl.us
    // (HK tickers are commonly written 4-digit, e.g. 0700.hk / hk0700; the
    // resolved Tencent symbol always pads to 5 digits — 00700.)
    static_regex!(market_re, r"(?i)\b(sh|sz)\d{6}\b|\bhk\d{4,5}\b|\b\d{4,5}\.hk\b|\b[a-z]{1,5}\.(us|hk|sh|sz)\b");
    if let Some(m) = market_re().find(&q) {
        let raw = m.as_str().to_lowercase();
        if raw.starts_with("sh") || raw.starts_with("sz") {
            return Some(raw);
        }
        if raw.starts_with("hk") {
            let ticker = &raw[2..];
            return Some(format!("hk{}{}", "0".repeat(5usize.saturating_sub(ticker.len())), ticker));
        }
        if let Some(dot) = raw.find('.') {
            let (ticker, market) = (&raw[..dot], &raw[dot + 1..]);
            return if market == "hk" {
                Some(format!("hk{}{}", "0".repeat(5usize.saturating_sub(ticker.len())), ticker))
            } else {
                Some(format!("us{}", ticker.to_uppercase()))
            };
        }
    }
    // Bare ticker-ish token (2-5 letters) → US listing, only as the WHOLE query.
    static_regex!(bare_ticker_re, r"^[a-z]{2,5}$");
    if bare_ticker_re().is_match(&q) {
        return Some(format!("us{}", q.to_uppercase()));
    }
    None
}

// ── WMO weather code → description ──

fn describe_wmo_code(code: i64, zh: bool) -> String {
    let desc = if zh {
        match code {
            0 => "晴", 1 => "基本晴朗", 2 => "多云", 3 => "阴",
            45 => "雾", 48 => "雾凇", 51 => "小毛毛雨", 53 => "毛毛雨", 55 => "浓毛毛雨",
            56 => "冻毛毛雨", 57 => "浓冻毛毛雨", 61 => "小雨", 63 => "中雨", 65 => "大雨",
            66 => "冻雨", 67 => "强冻雨", 71 => "小雪", 73 => "中雪", 75 => "大雪", 77 => "米雪",
            80 => "小阵雨", 81 => "阵雨", 82 => "强阵雨", 85 => "阵雪", 86 => "强阵雪",
            95 => "雷阵雨", 96 => "雷阵雨伴冰雹", 99 => "强雷阵雨伴冰雹",
            _ => return format!("code {}", code),
        }
    } else {
        match code {
            0 => "Clear sky", 1 => "Mainly clear", 2 => "Partly cloudy", 3 => "Overcast",
            45 => "Fog", 48 => "Depositing rime fog", 51 => "Light drizzle", 53 => "Drizzle",
            55 => "Dense drizzle", 56 => "Freezing drizzle", 57 => "Dense freezing drizzle",
            61 => "Light rain", 63 => "Rain", 65 => "Heavy rain", 66 => "Freezing rain", 67 => "Heavy freezing rain",
            71 => "Light snow", 73 => "Snow", 75 => "Heavy snow", 77 => "Snow grains",
            80 => "Light rain showers", 81 => "Rain showers", 82 => "Violent rain showers",
            85 => "Snow showers", 86 => "Heavy snow showers",
            95 => "Thunderstorm", 96 => "Thunderstorm with hail", 99 => "Thunderstorm with heavy hail",
            _ => return format!("code {}", code),
        }
    };
    desc.to_string()
}

// ── RSS parsing (shared with the Tier-3 feed formatting) ──

struct RssItem {
    title: String,
    link: String,
    date: String,
    description: String,
}

fn clean_xml_text(s: &str) -> String {
    static_regex!(cdata_re, r"<!\[CDATA\[|\]\]>");
    static_regex!(tag_re, r"<[^>]+>");
    tag_re().replace_all(&cdata_re().replace_all(s, ""), "").trim().to_string()
}

/// Parse RSS/Atom <item>/<entry> blocks (no XML dependency, mirrors the
/// regex-based parsers in src/adapter/node/publicApis.ts).
fn parse_rss_items(xml: &str, max: usize) -> Vec<RssItem> {
    static_regex!(feed_block_re, r"(?is)<(item|entry)>([\s\S]*?)</(item|entry)>");
    let mut out: Vec<RssItem> = Vec::new();
    for caps in feed_block_re().captures_iter(xml) {
        if out.len() >= max {
            break;
        }
        let block = &caps[2];
        let pick = |tag: &str| -> String {
            let re = regex::Regex::new(&format!(r"(?is)<{}[^>]*>([\s\S]*?)</{}>", tag, tag)).ok();
            re.and_then(|r| r.captures(block))
                .map(|c| clean_xml_text(&c[1]))
                .unwrap_or_default()
        };
        let title = pick("title");
        if title.is_empty() {
            continue;
        }
        let mut date = pick("pubDate");
        if date.is_empty() {
            date = pick("published");
        }
        if date.is_empty() {
            date = pick("updated");
        }
        let mut description = pick("description");
        if description.is_empty() {
            description = pick("summary");
        }
        out.push(RssItem {
            title,
            link: pick("link").trim().to_string(),
            date,
            description,
        });
    }
    out
}

// ── Resolver implementations (each returns Ok(None) on any failure) ──

async fn fetch_json(
    url: &str,
    timeout_ms: u64,
    headers: &[(&str, &str)],
    proxy_url: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let client = build_http_client(std::time::Duration::from_millis(timeout_ms), proxy_url)?;
    let mut req = client.get(url).header("User-Agent", BROWSER_UA);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    match resp.json::<serde_json::Value>().await {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

struct GeoResult {
    name: String,
    latitude: f64,
    longitude: f64,
    country: Option<String>,
}

/// Open-Meteo geocoding first, Nominatim fallback (1 req/s, needs a UA).
async fn geocode(location: &str, proxy_url: Option<&str>) -> Result<Option<GeoResult>, String> {
    let zh = is_chinese_query(location);
    let url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language={}&format=json",
        urlencoding(location),
        if zh { "zh" } else { "en" }
    );
    if let Some(data) = fetch_json(&url, 8000, &[], proxy_url).await? {
        if let Some(first) = data.get("results").and_then(|v| v.as_array()).and_then(|a| a.first()) {
            if let (Some(lat), Some(lon)) = (
                first.get("latitude").and_then(|v| v.as_f64()),
                first.get("longitude").and_then(|v| v.as_f64()),
            ) {
                return Ok(Some(GeoResult {
                    name: first.get("name").and_then(|v| v.as_str()).unwrap_or(location).to_string(),
                    latitude: lat,
                    longitude: lon,
                    country: first.get("country").and_then(|v| v.as_str()).map(String::from),
                }));
            }
        }
    }
    let nomi = format!(
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q={}",
        urlencoding(location)
    );
    if let Some(arr) = fetch_json(&nomi, 6000, &[], proxy_url).await? {
        if let Some(n) = arr.as_array().and_then(|a| a.first()) {
            let lat = n.get("lat").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            let lon = n.get("lon").and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
            if let (Some(lat), Some(lon)) = (lat, lon) {
                return Ok(Some(GeoResult {
                    name: n.get("display_name").and_then(|v| v.as_str()).unwrap_or(location).to_string(),
                    latitude: lat,
                    longitude: lon,
                    country: None,
                }));
            }
        }
    }
    Ok(None)
}

fn json_num(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn fmt_opt(opt: Option<f64>) -> String {
    opt.map(|x| x.to_string()).unwrap_or_else(|| "?".to_string())
}

async fn resolve_weather(
    query: &str,
    location_opt: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let mut location = extract_location(query);
    if location.is_empty() {
        location = location_opt.unwrap_or("").to_string();
    }
    if location.is_empty() {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Weather,
            source: "Open-Meteo".to_string(),
            text: "需要知道城市才能查天气（例如“北京天气”或“weather in Tokyo”）；未检测到城市，也没有配置位置。".to_string(),
        }));
    }
    let geo = match geocode(&location, proxy_url).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3",
        geo.latitude, geo.longitude
    );
    let data = match fetch_json(&url, 8000, &[], proxy_url).await? {
        Some(d) => d,
        None => return Ok(None),
    };
    let (Some(cur), Some(daily)) = (data.get("current"), data.get("daily")) else {
        return Ok(None);
    };
    let zh = is_chinese_query(&location) || is_chinese_query(query);
    let mut lines: Vec<String> = Vec::new();
    let name = match &geo.country {
        Some(country) => format!("{} ({})", geo.name, country),
        None => geo.name.clone(),
    };
    let timezone = data.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    let cur_time = cur.get("time").and_then(|v| v.as_str()).unwrap_or("");
    lines.push(format!("{} 天气 · {} · 数据时间 {}", name, timezone, cur_time));
    let precip = json_num(cur, "precipitation").unwrap_or(0.0);
    let mut current_line = format!(
        "当前: {}°C (体感 {}°C) {} · 湿度 {}% · 风速 {} km/h",
        fmt_opt(json_num(cur, "temperature_2m")),
        fmt_opt(json_num(cur, "apparent_temperature")),
        describe_wmo_code(json_num(cur, "weather_code").unwrap_or(-1.0) as i64, zh),
        fmt_opt(json_num(cur, "relative_humidity_2m")),
        fmt_opt(json_num(cur, "wind_speed_10m")),
    );
    if precip > 0.0 {
        current_line.push_str(&format!(" · 降水 {}mm", precip));
    }
    lines.push(current_line);
    if let Some(times) = daily.get("time").and_then(|v| v.as_array()) {
        for (i, _) in times.iter().enumerate().take(3) {
            let label = match i {
                0 => (if zh { "今日" } else { "Today" }).to_string(),
                1 => (if zh { "明日" } else { "Tomorrow" }).to_string(),
                _ => times[i].as_str().unwrap_or("").to_string(),
            };
            let day_max = daily.get("temperature_2m_max").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let day_min = daily.get("temperature_2m_min").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let day_code = daily.get("weather_code").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_i64()).unwrap_or(-1);
            let prob = daily.get("precipitation_probability_max").and_then(|v| v.as_array()).and_then(|a| a.get(i)).and_then(|x| x.as_f64());
            let mut line = format!(
                "{}: {}°C / {}°C · {}",
                label,
                fmt_opt(day_max),
                fmt_opt(day_min),
                describe_wmo_code(day_code, zh)
            );
            if let Some(p) = prob {
                line.push_str(&format!(" · 降水概率 {}%", p));
            }
            lines.push(line);
        }
    }
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Weather,
        source: "Open-Meteo".to_string(),
        text: lines.join("\n"),
    }))
}

async fn resolve_geocode(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let location = extract_location(query);
    if location.is_empty() {
        return Ok(None);
    }
    let geo = match geocode(&location, proxy_url).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    let country = geo.country.as_deref().map(|c| format!(" ({})", c)).unwrap_or_default();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Geocode,
        source: "Open-Meteo/Nominatim".to_string(),
        text: format!(
            "地理位置: {}{}\n纬度: {}\n经度: {}",
            geo.name, country, geo.latitude, geo.longitude
        ),
    }))
}

async fn resolve_air_quality(
    query: &str,
    location_opt: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let mut location = extract_air_quality_location(query);
    if location.is_empty() {
        location = location_opt.unwrap_or("").to_string();
    }
    if location.is_empty() {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::AirQuality,
            source: "Open-Meteo Air Quality".to_string(),
            text: "需要知道城市才能查空气质量（例如“北京空气质量”或“北京PM2.5”）；未检测到城市，也没有配置位置。".to_string(),
        }));
    }
    let geo = match geocode(&location, proxy_url).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    let url = format!(
        "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={}&longitude={}&current=pm10,pm2_5,nitrogen_dioxide,us_aqi&timezone=auto",
        geo.latitude, geo.longitude
    );
    let data = match fetch_json(&url, 8000, &[], proxy_url).await? {
        Some(d) => d,
        None => return Ok(None),
    };
    let Some(cur) = data.get("current") else {
        return Ok(None);
    };
    let name = match &geo.country {
        Some(country) => format!("{} ({})", geo.name, country),
        None => geo.name.clone(),
    };
    let cur_time = cur.get("time").and_then(|v| v.as_str()).unwrap_or("");
    let pm25 = json_num(cur, "pm2_5");
    let pm10 = json_num(cur, "pm10");
    let us_aqi = json_num(cur, "us_aqi");
    let no2 = json_num(cur, "nitrogen_dioxide");
    let mut lines = vec![format!("{} 空气质量 · 数据时间 {}", name, cur_time)];
    let mut current_line = format!(
        "当前: PM2.5 {} µg/m³ · PM10 {} µg/m³ · 美标 AQI {}",
        fmt_opt(pm25),
        fmt_opt(pm10),
        fmt_opt(us_aqi)
    );
    if let Some(aqi) = us_aqi {
        current_line.push_str(&format!(" · {}", describe_aqi(aqi)));
    }
    lines.push(current_line);
    if no2.is_some() {
        lines.push(format!("二氧化氮 NO₂: {} µg/m³", fmt_opt(no2)));
    }
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::AirQuality,
        source: "Open-Meteo Air Quality".to_string(),
        text: lines.join("\n"),
    }))
}

/// US-AQI → six-level Chinese health label (近似国标阈值，供快速判断).
fn describe_aqi(us_aqi: f64) -> String {
    if us_aqi <= 50.0 {
        "优".to_string()
    } else if us_aqi <= 100.0 {
        "良".to_string()
    } else if us_aqi <= 150.0 {
        "轻度污染".to_string()
    } else if us_aqi <= 200.0 {
        "中度污染".to_string()
    } else if us_aqi <= 300.0 {
        "重度污染".to_string()
    } else {
        "严重污染".to_string()
    }
}

/// Look up a World Bank country ISO2 code + Chinese display name from the
/// query. CJK names match by substring; English names require word boundaries
/// (longest first so "united states" wins over "us").
fn worldbank_country(query: &str) -> Option<(&'static str, &'static str)> {
    let q = query.to_lowercase();
    for (name, code, zh) in [
        ("中国", "CN", "中国"),
        ("美国", "US", "美国"),
        ("日本", "JP", "日本"),
        ("德国", "DE", "德国"),
        ("英国", "GB", "英国"),
        ("法国", "FR", "法国"),
        ("印度", "IN", "印度"),
        ("韩国", "KR", "韩国"),
        ("俄罗斯", "RU", "俄罗斯"),
        ("巴西", "BR", "巴西"),
        ("加拿大", "CA", "加拿大"),
        ("澳大利亚", "AU", "澳大利亚"),
        ("澳洲", "AU", "澳大利亚"),
        ("意大利", "IT", "意大利"),
        ("新加坡", "SG", "新加坡"),
    ] {
        if query.contains(name) {
            return Some((code, zh));
        }
    }
    for (name, code, zh) in [
        ("united states", "US", "美国"),
        ("south korea", "KR", "韩国"),
        ("united kingdom", "GB", "英国"),
        ("china", "CN", "中国"),
        ("japan", "JP", "日本"),
        ("germany", "DE", "德国"),
        ("france", "FR", "法国"),
        ("india", "IN", "印度"),
        ("korea", "KR", "韩国"),
        ("russia", "RU", "俄罗斯"),
        ("brazil", "BR", "巴西"),
        ("canada", "CA", "加拿大"),
        ("australia", "AU", "澳大利亚"),
        ("italy", "IT", "意大利"),
        ("singapore", "SG", "新加坡"),
        ("usa", "US", "美国"),
        ("uk", "GB", "英国"),
        ("us", "US", "美国"),
    ] {
        if ascii_word_match(&q, name) {
            return Some((code, zh));
        }
    }
    None
}

/// ASCII word-boundary match so "us" never matches "must" / "house".
fn ascii_word_match(haystack: &str, needle: &str) -> bool {
    let pattern = format!(r"(?i)(?:^|[^a-z0-9]){}(?:[^a-z0-9]|$)", regex::escape(needle));
    regex::Regex::new(&pattern)
        .map(|re| re.is_match(haystack))
        .unwrap_or(false)
}

/// World Bank indicator lookup: (code, display label, is_percent). "人口" is
/// ambiguous ("人口老龄化"), so it requires a count/lookup signal alongside.
fn worldbank_indicator(query: &str) -> Option<(&'static str, &'static str, bool)> {
    let q = query.to_lowercase();
    if q.contains("人均gdp") || q.contains("人均国内生产总值") || q.contains("gdp per capita") {
        return Some(("NY.GDP.PCAP.CD", "人均GDP(现价美元)", false));
    }
    if q.contains("gdp") || q.contains("国内生产总值") {
        return Some(("NY.GDP.MKTP.CD", "GDP(现价美元)", false));
    }
    if (q.contains("人口") || q.contains("population"))
        && (q.contains("多少") || q.contains("总数") || q.contains("数量") || q.contains("几") || q.contains("how many"))
    {
        return Some(("SP.POP.TOTL", "人口总数", false));
    }
    if q.contains("失业率") || q.contains("unemployment") {
        return Some(("SL.UEM.TOTL.ZS", "失业率", true));
    }
    if q.contains("通胀") || q.contains("通货膨胀") || q.contains("inflation") {
        return Some(("FP.CPI.TOTL.ZG", "通胀率", true));
    }
    None
}

async fn resolve_worldbank(
    query: &str,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let Some((indicator, label, is_percent)) = worldbank_indicator(query) else {
        return Ok(None);
    };
    let Some((code, zh_name)) = worldbank_country(query) else {
        return Ok(None);
    };
    let url = format!(
        "https://api.worldbank.org/v2/country/{}/indicator/{}?format=json&per_page=1",
        code, indicator
    );
    let Some(data) = fetch_json(&url, 8000, &[], proxy_url).await? else {
        return Ok(None);
    };
    let entry = data
        .as_array()
        .and_then(|a| a.get(1))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());
    let Some(entry) = entry else {
        return Ok(None);
    };
    let value = entry
        .get("value")
        .and_then(|v| v.as_f64())
        .or_else(|| {
            entry
                .get("value")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
        });
    let Some(value) = value else {
        return Ok(None);
    };
    let year = entry.get("date").and_then(|v| v.as_str()).unwrap_or("最新");
    let number = if is_percent {
        format!("{:.1}%", value)
    } else if value >= 1e12 {
        format!("{:.2} 万亿", value / 1e12)
    } else if value >= 1e8 {
        format!("{:.2} 亿", value / 1e8)
    } else {
        format!("{:.1}", value)
    };
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::WorldBank,
        source: "World Bank".to_string(),
        text: format!(
            "{} {}（{}年）: {}\n数据来源: World Bank Open Data ({})",
            zh_name, label, year, number, indicator
        ),
    }))
}

async fn resolve_news(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let zh = is_chinese_query(query);
    let mut q = news_re().replace(query, "").trim().to_string();
    if q.is_empty() {
        q = if zh { "热点新闻".to_string() } else { "top news".to_string() };
    }
    // Bing News RSS is China-reachable; Google News RSS is the fallback.
    let lang = if zh { "zh-hans" } else { "en-us" };
    let mut xml = fetch_feed_text(
        &format!(
            "https://www.bing.com/news/search?q={}&format=RSS&setlang={}",
            urlencoding(&q),
            lang
        ),
        proxy_url,
    )
    .await?;
    let mut source = "Bing News RSS";
    if xml.is_none() {
        let (hl, gl, ceid) = if zh {
            ("zh-CN", "CN", "CN:zh-Hans")
        } else {
            ("en-US", "US", "US:en")
        };
        xml = fetch_feed_text(
            &format!(
                "https://news.google.com/rss/search?q={}&hl={}&gl={}&ceid={}",
                urlencoding(&q),
                hl,
                gl,
                ceid
            ),
            proxy_url,
        )
        .await?;
        source = "Google News RSS";
    }
    let xml = match xml {
        Some(x) => x,
        None => return Ok(None),
    };
    let items = parse_rss_items(&xml, 8);
    if items.is_empty() {
        return Ok(None);
    }
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut line = format!("{}. {}", i + 1, item.title);
            if !item.date.is_empty() {
                line.push_str(&format!("\n   {}", item.date));
            }
            line.push_str(&format!("\n   {}", item.link));
            line
        })
        .collect();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::News,
        source: source.to_string(),
        text: format!("新闻: {}\n\n{}", q, lines.join("\n\n")),
    }))
}

async fn resolve_wiki(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let zh = is_chinese_query(query);
    let lang = if zh { "zh" } else { "en" };
    let mut title = wiki_re().replace(query, "").trim().to_string();
    if title.is_empty() {
        return Ok(None);
    }
    // Resolve to the real page title via opensearch (handles redirects/aliases).
    let search = fetch_json(
        &format!(
            "https://{}.wikipedia.org/w/api.php?action=opensearch&search={}&limit=1&format=json",
            lang,
            urlencoding(&title)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    if let Some(arr) = search.as_ref().and_then(|v| v.get(1)).and_then(|v| v.as_array()) {
        if let Some(first) = arr.first().and_then(|v| v.as_str()) {
            if !first.is_empty() {
                title = first.to_string();
            }
        }
    }
    let summary = fetch_json(
        &format!(
            "https://{}.wikipedia.org/api/rest_v1/page/summary/{}",
            lang,
            urlencoding(&title)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    let extract = summary
        .as_ref()
        .and_then(|v| v.get("extract"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let extract = match extract {
        Some(e) => e,
        None => return Ok(None),
    };
    let page_url = summary
        .as_ref()
        .and_then(|v| v.get("content_urls"))
        .and_then(|v| v.get("desktop"))
        .and_then(|v| v.get("page"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("https://{}.wikipedia.org/wiki/{}", lang, urlencoding(&title)));
    let desc = summary
        .as_ref()
        .and_then(|v| v.get("description"))
        .and_then(|v| v.as_str())
        .map(|d| format!("{}\n", d))
        .unwrap_or_default();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Wiki,
        source: format!("Wikipedia ({})", lang),
        text: format!("{}\n{}{}\n\n来源: {}", title, desc, extract, page_url),
    }))
}

async fn resolve_ip(proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let ip = fetch_json("https://api.ipify.org?format=json", 8000, &[], proxy_url).await?;
    let addr = ip.as_ref().and_then(|v| v.get("ip")).and_then(|v| v.as_str()).map(String::from);
    let addr = match addr {
        Some(a) => a,
        None => return Ok(None),
    };
    let detail = fetch_json(
        &format!(
            "http://ip-api.com/json/{}?fields=status,country,regionName,city,isp,org,as,timezone",
            urlencoding(&addr)
        ),
        8000,
        &[],
        proxy_url,
    )
    .await?;
    if detail.as_ref().and_then(|v| v.get("status")).and_then(|v| v.as_str()) != Some("success") {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Ip,
            source: "ipify".to_string(),
            text: format!("IP 地址: {}", addr),
        }));
    }
    let d = detail.unwrap_or_default();
    let city = d.get("city").and_then(|v| v.as_str()).unwrap_or("");
    let region = d.get("regionName").and_then(|v| v.as_str()).unwrap_or("");
    let country = d.get("country").and_then(|v| v.as_str()).unwrap_or("");
    let isp = d
        .get("isp")
        .and_then(|v| v.as_str())
        .or_else(|| d.get("org").and_then(|v| v.as_str()))
        .unwrap_or("");
    let tz = d.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Ip,
        source: "ipify + ip-api.com".to_string(),
        text: format!("IP 地址: {}\n位置: {} {} {}\n运营商: {}\n时区: {}", addr, city, region, country, isp, tz),
    }))
}

async fn resolve_fx(req: &FxRequest, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let data = match fetch_json(
        &format!("https://api.frankfurter.app/latest?from={}&to={}", req.from, req.to),
        8000,
        &[],
        proxy_url,
    )
    .await?
    {
        Some(d) => d,
        None => return Ok(None),
    };
    let rate = data.get("rates").and_then(|v| v.get(&req.to)).and_then(|v| v.as_f64());
    let rate = match rate {
        Some(r) => r,
        None => return Ok(None),
    };
    let total = rate * req.amount;
    let date = data.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let precision = if req.amount >= 100.0 { 2 } else { 4 };
    let date_suffix = if date.is_empty() {
        String::new()
    } else {
        format!(", {}", date)
    };
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Fx,
        source: "Frankfurter (ECB)".to_string(),
        text: format!(
            "{} {} = {:.*} {} (1 {} = {} {}{})",
            req.amount, req.from, precision, total, req.to, req.from, rate, req.to, date_suffix
        ),
    }))
}

/// Tencent qt.gtimg.cn quote (GBK body, China-reachable, no key).
async fn fetch_stock_tencent(symbol: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(format!("http://qt.gtimg.cn/q={}", urlencoding(symbol)))
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body = response_text_with_charset(resp).await?;
    let start = match body.find('"') {
        Some(i) => i,
        None => return Ok(None),
    };
    let end = match body[start + 1..].find('"') {
        Some(i) => i + start + 1,
        None => return Ok(None),
    };
    let f: Vec<&str> = body[start + 1..end].split('~').collect();
    if f.len() < 40 || f[3].is_empty() {
        return Ok(None);
    }
    let num = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok());
    let change = num(31).unwrap_or(0.0);
    let change_pct = num(32).unwrap_or(0.0);
    let arrow = if change > 0.0 { "▲" } else if change < 0.0 { "▼" } else { "—" };
    let sign = |v: f64| if v >= 0.0 { "+" } else { "" };
    let at = |i: usize| f.get(i).copied().unwrap_or("");
    Ok(Some(format!(
        "腾讯行情 · {} {}\n现价 {} (昨收 {})  {} {}{} ({}{}%)\n今开 {}  最高 {}  最低 {}\n成交量 {}手  成交额 {}万  市盈率 {}  换手 {}%\n时间 {}",
        symbol,
        at(1),
        at(3),
        at(4),
        arrow,
        sign(change),
        change,
        sign(change_pct),
        change_pct,
        at(5),
        at(33),
        at(34),
        at(6),
        at(37),
        at(39),
        at(38),
        at(30),
    )))
}

/// Sina hq.sinajs.cn quote fallback (GBK body; needs a finance Referer).
async fn fetch_stock_sina(symbol: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(format!("https://hq.sinajs.cn/list={}", urlencoding(symbol)))
        .header("User-Agent", BROWSER_UA)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body = response_text_with_charset(resp).await?;
    let start = match body.find('"') {
        Some(i) => i,
        None => return Ok(None),
    };
    let end = match body[start + 1..].find('"') {
        Some(i) => i + start + 1,
        None => return Ok(None),
    };
    let f: Vec<&str> = body[start + 1..end].split(',').collect();
    if f.len() < 10 || f[3].is_empty() {
        return Ok(None);
    }
    let prev_close = f[2].parse::<f64>().unwrap_or(0.0);
    let current = f[3].parse::<f64>().unwrap_or(0.0);
    let change = current - prev_close;
    let change_pct = if prev_close != 0.0 { change / prev_close * 100.0 } else { 0.0 };
    let arrow = if change > 0.0 { "▲" } else if change < 0.0 { "▼" } else { "—" };
    let sign = |v: f64| if v >= 0.0 { "+" } else { "" };
    let amount = f.get(9).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let at = |i: usize| f.get(i).copied().unwrap_or("");
    Ok(Some(format!(
        "新浪行情 · {} {}\n现价 {} (昨收 {})  {} {}{:.2} ({}{:.2}%)\n今开 {}  最高 {}  最低 {}\n成交量 {}股  成交额 {}元  日期 {} {}",
        symbol,
        at(0),
        at(3),
        at(2),
        arrow,
        sign(change),
        change,
        sign(change_pct),
        change_pct,
        at(1),
        at(4),
        at(5),
        at(8),
        amount,
        at(30),
        at(31),
    )))
}

async fn resolve_stock(symbol: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    if let Some(text) = fetch_stock_tencent(symbol, proxy_url).await? {
        return Ok(Some(PublicApiOutcome {
            intent: IntentKind::Stock,
            source: "腾讯行情".to_string(),
            text,
        }));
    }
    if symbol.starts_with("sh") || symbol.starts_with("sz") {
        if let Some(text) = fetch_stock_sina(symbol, proxy_url).await? {
            return Ok(Some(PublicApiOutcome {
                intent: IntentKind::Stock,
                source: "新浪行情".to_string(),
                text,
            }));
        }
    }
    Ok(None)
}

async fn resolve_github(query: &str, proxy_url: Option<&str>) -> Result<Option<PublicApiOutcome>, String> {
    let mut q = github_re().replace(query, "").trim().to_string();
    while q.starts_with('：') || q.starts_with(':') {
        q = q[1..].trim_start().to_string();
    }
    if q.is_empty() {
        return Ok(None);
    }
    let data = match fetch_json(
        &format!(
            "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page=5",
            urlencoding(&q)
        ),
        8000,
        &[("Accept", "application/vnd.github+json")],
        proxy_url,
    )
    .await?
    {
        Some(d) => d,
        None => return Ok(None),
    };
    let items = data.get("items").and_then(|v| v.as_array()).map(|a| a.to_vec()).unwrap_or_default();
    let items: Vec<&serde_json::Value> = items.iter().take(5).collect();
    if items.is_empty() {
        return Ok(None);
    }
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, repo)| {
            let full_name = repo.get("full_name").and_then(|v| v.as_str()).unwrap_or("");
            let stars = repo.get("stargazers_count").and_then(|v| v.as_i64()).unwrap_or(0);
            let lang = repo.get("language").and_then(|v| v.as_str()).filter(|l| !l.is_empty());
            let lang_suffix = lang.map(|l| format!(" · {}", l)).unwrap_or_default();
            let url = repo.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
            let desc = repo
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|d| !d.is_empty())
                .map(|d| format!("\n   {}", d))
                .unwrap_or_default();
            format!("{}. {} (⭐ {}{}){}\n   {}", i + 1, full_name, stars, lang_suffix, desc, url)
        })
        .collect();
    Ok(Some(PublicApiOutcome {
        intent: IntentKind::Github,
        source: "GitHub Search API".to_string(),
        text: format!("GitHub 仓库 (按 star 排序):\n\n{}", lines.join("\n\n")),
    }))
}

// ── Main entry ──

/// Try to answer a query from the direct public API tier. Returns Ok(None)
/// when the query is not a structured intent or every endpoint failed —
/// callers then fall through to web search / scraping.
async fn try_direct_public_api(
    query: &str,
    category: Option<&str>,
    location: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<Option<PublicApiOutcome>, String> {
    let q = query.trim();
    if q.is_empty() && category.is_none() {
        return Ok(None);
    }
    let forced = category.and_then(|c| match c {
        "weather" => Some(IntentKind::Weather),
        "airquality" => Some(IntentKind::AirQuality),
        "geocode" => Some(IntentKind::Geocode),
        "news" => Some(IntentKind::News),
        "wiki" => Some(IntentKind::Wiki),
        "ip" => Some(IntentKind::Ip),
        "fx" => Some(IntentKind::Fx),
        "stock" => Some(IntentKind::Stock),
        "github" => Some(IntentKind::Github),
        "worldbank" => Some(IntentKind::WorldBank),
        _ => None,
    });
    let intent = forced.or_else(|| classify_intent(q));
    let Some(intent) = intent else {
        return Ok(None);
    };
    match intent {
        IntentKind::Weather => resolve_weather(q, location, proxy_url).await,
        IntentKind::AirQuality => resolve_air_quality(q, location, proxy_url).await,
        IntentKind::Geocode => resolve_geocode(q, proxy_url).await,
        IntentKind::News => resolve_news(q, proxy_url).await,
        IntentKind::Wiki => resolve_wiki(q, proxy_url).await,
        IntentKind::Ip => resolve_ip(proxy_url).await,
        IntentKind::Fx => {
            let req = parse_fx_query(q).unwrap_or(FxRequest {
                from: "USD".to_string(),
                to: "CNY".to_string(),
                amount: 1.0,
            });
            resolve_fx(&req, proxy_url).await
        }
        IntentKind::Stock => match resolve_stock_symbol(q) {
            Some(symbol) => resolve_stock(&symbol, proxy_url).await,
            None => Ok(None),
        },
        IntentKind::Github => resolve_github(q, proxy_url).await,
        IntentKind::WorldBank => resolve_worldbank(q, proxy_url).await,
    }
}

#[tauri::command]
async fn web_public_api(
    _workspace: String,
    query: String,
    category: Option<String>,
    location: Option<String>,
    api_key: Option<String>,
    serper_api_key: Option<String>,
    search_on_miss: Option<bool>,
    proxy_url: Option<String>,
    searxng_url: Option<String>,
) -> Result<String, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("web_public_api query must not be empty".to_string());
    }
    match cached_direct_public_api(&q, category.as_deref(), location.as_deref(), proxy_url.as_deref()).await? {
        (Some(outcome), cached) => {
            return Ok(format!("{}[{}] {}", if cached { "[cached] " } else { "" }, outcome.source, outcome.text));
        }
        (None, _) => {}
    }
    // Auto-escalation (L2 → L1): the direct tier had nothing for this query,
    // so fall through to web search instead of forcing a second model
    // round-trip. Opt out with searchOnMiss:false.
    if search_on_miss.unwrap_or(true) {
        return web_search_inner(
            &q,
            Some(8),
            api_key.as_deref(),
            serper_api_key.as_deref(),
            location.as_deref(),
            proxy_url.as_deref(),
            searxng_url.as_deref(),
        )
        .await;
    }
    Err(format!(
        "No structured-data source matched \"{}\" — web_public_api covers weather/air quality/geocode/news/wiki/IP/FX/stock/GitHub/World-Bank lookups; for anything else use web_search instead of retrying this tool with the same query (auto-fallback to search is off when searchOnMiss:false).",
        q
    ))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Web Scrape (Tier-3) — known-URL extraction
//  Mirrors src/adapter/node/webScrape.ts: noise-tag stripping, optional
//  #id/.class/tag selector, RSS/JSON auto-formatting, then Jina Reader
//  (free, no key) fallback for blocked, JS-heavy, or binary pages.
// ═══════════════════════════════════════════════════════════════════════════════

/// Block-level noise tags removed before text extraction (nav/header/footer/
/// aside/form/button/script/style/iframe/svg/canvas/noscript/template/dialog).
/// The JS original uses a backreference regex; the regex crate has none, so
/// this is a manual case-insensitive scan that removes each block up to its
/// OWN matching close tag (first `</tag>` occurrence).
fn strip_noise_tags(html: &str) -> String {
    const NOISE: &[&str] = &[
        "nav", "header", "footer", "aside", "form", "button", "script", "style", "iframe", "svg", "canvas", "noscript", "template", "dialog",
    ];
    let chars: Vec<char> = html.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            let mut matched: Option<&str> = None;
            for tag in NOISE {
                let t: Vec<char> = tag.chars().collect();
                if i + 1 + t.len() <= chars.len()
                    && chars[i + 1..i + 1 + t.len()].iter().zip(t.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
                    && chars.get(i + 1 + t.len()).map_or(true, |c| matches!(c, '>' | ' ' | '\t' | '\n' | '\r'))
                {
                    matched = Some(tag);
                    break;
                }
            }
            if let Some(tag) = matched {
                let close: Vec<char> = format!("</{}>", tag).chars().collect();
                let mut j = i + 1;
                let mut end: Option<usize> = None;
                while j + close.len() <= chars.len() {
                    if chars[j] == '<'
                        && chars[j..j + close.len()].iter().zip(close.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
                    {
                        end = Some(j + close.len());
                        break;
                    }
                    j += 1;
                }
                if let Some(end) = end {
                    i = end;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Extract the inner HTML of elements matching a simple selector: `#id`,
/// `.class`, or a bare tag name (`article`, `main`). Regex-based by design —
/// mirrors src/adapter/node/webScrape.ts. Returns [] when nothing matches so
/// callers fall back to whole-page extraction.
fn extract_by_selector(html: &str, selector: &str) -> Vec<String> {
    let sel = selector.trim();
    if sel.is_empty() {
        return vec![];
    }
    let is_id = sel.starts_with('#');
    let is_class = sel.starts_with('.');
    let token: String = if is_id || is_class { sel[1..].to_string() } else { String::new() };
    if (is_id || is_class) && (token.is_empty() || token.chars().any(|c| !c.is_alphanumeric() && c != '-' && c != '_')) {
        return vec![];
    }
    if !is_id && !is_class && !sel.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return vec![];
    }
    let chars: Vec<char> = html.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() && out.len() < 8 {
        if chars[i] == '<' {
            let mut j = i + 1;
            let mut name = String::new();
            while j < chars.len() && name.len() < 64 && (chars[j].is_ascii_alphanumeric() || chars[j] == '-') {
                name.push(chars[j]);
                j += 1;
            }
            if name.is_empty() {
                i += 1;
                continue;
            }
            let mut attr = String::new();
            let mut k = j;
            while k < chars.len() && chars[k] != '>' {
                attr.push(chars[k]);
                k += 1;
            }
            if k >= chars.len() {
                i += 1;
                continue;
            }
            let attr_lower = attr.to_lowercase();
            let attr_matches = if is_id {
                attr_lower.contains(&format!("id=\"{}\"", token)) || attr_lower.contains(&format!("id='{}'", token))
            } else if is_class {
                attr_lower.contains(&format!("class=\"")) && attr_lower.contains(&token)
            } else {
                sel.eq_ignore_ascii_case(&name)
            };
            if attr_matches {
                let close: Vec<char> = format!("</{}>", name).chars().collect();
                let mut m = k + 1;
                let mut end: Option<usize> = None;
                while m + close.len() <= chars.len() {
                    if chars[m] == '<'
                        && chars[m..m + close.len()].iter().zip(close.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
                    {
                        end = Some(m);
                        break;
                    }
                    m += 1;
                }
                if let Some(end) = end {
                    out.push(chars[k + 1..end].iter().collect());
                    i = end + close.len();
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Tag-strip to readable text (mirrors the Node webScrape.ts stripHtml —
/// script/style removal, <br> and block closers as breaks, whitespace
/// collapse; entities are decoded separately by decode_basic_entities).
fn strip_html_scrape(html: &str) -> String {
    let chars: Vec<char> = html.chars().collect();
    let mut kept: Vec<char> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let mut skipped = false;
        for tag in ["script", "style"] {
            let t: Vec<char> = tag.chars().collect();
            if chars[i] == '<'
                && i + 1 + t.len() <= chars.len()
                && chars[i + 1..i + 1 + t.len()].iter().zip(t.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
                && chars.get(i + 1 + t.len()).map_or(true, |c| matches!(c, '>' | ' ' | '\t' | '\n' | '\r'))
            {
                let close: Vec<char> = format!("</{}>", tag).chars().collect();
                let mut j = i + 1;
                let mut end: Option<usize> = None;
                while j + close.len() <= chars.len() {
                    if chars[j] == '<'
                        && chars[j..j + close.len()].iter().zip(close.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
                    {
                        end = Some(j + close.len());
                        break;
                    }
                    j += 1;
                }
                if let Some(end) = end {
                    i = end;
                    skipped = true;
                }
                break;
            }
        }
        if skipped {
            continue;
        }
        kept.push(chars[i]);
        i += 1;
    }
    let cleaned: String = kept.iter().collect();
    static_regex!(br_re, r"(?i)<br\s*/?\s*>");
    static_regex!(p_close_re, r"(?i)</p\s*>");
    static_regex!(block_close_re, r"(?i)</(?:div|h[1-6]|li|tr|section|article)\s*>");
    static_regex!(any_tag_re, r"(?i)<[^>]+>");
    static_regex!(triple_nl_re, r"\n{3,}");
    let mut step = br_re().replace_all(&cleaned, "\n").to_string();
    step = p_close_re().replace_all(&step, "\n\n").to_string();
    step = block_close_re().replace_all(&step, "\n").to_string();
    step = any_tag_re().replace_all(&step, "").to_string();
    step = triple_nl_re().replace_all(&step, "\n\n").to_string();
    step.split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Decode the common HTML entities (mirrors webScrape.ts decodeEntities).
fn decode_basic_entities(s: &str) -> String {
    let mut out = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ");
    static_regex!(numeric_entity_re, r"&#(\d+);");
    out = numeric_entity_re()
        .replace_all(&out, |caps: &regex::Captures| {
            caps[1]
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| caps[0].to_string())
        })
        .to_string();
    out
}

/// Full HTML extraction: noise strip → optional selector scope → readable
/// text with entities decoded (mirrors extractScrapeText).
fn extract_scrape_text(html: &str, selector: Option<&str>) -> String {
    let cleaned = strip_noise_tags(html);
    let mut body = cleaned.clone();
    if let Some(sel) = selector {
        let scoped = extract_by_selector(&cleaned, sel).join("\n\n");
        if !scoped.trim().is_empty() {
            body = scoped;
        }
    }
    decode_basic_entities(&strip_html_scrape(&body)).trim().to_string()
}

/// True when the body looks like an RSS/Atom feed (has item/entry blocks).
fn is_feed_body(body: &str) -> bool {
    static_regex!(feed_check_re, r"(?is)<(item|entry)>[\s\S]*?</(item|entry)>");
    feed_check_re().is_match(body)
}

/// Format a feed body as a numbered list (title / date / link / description).
fn format_feed_text(body: &str) -> String {
    let items = parse_rss_items(body, 8);
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut line = format!("{}. {}", i + 1, item.title);
            if !item.date.is_empty() {
                line.push_str(&format!("\n   {}", item.date));
            }
            line.push_str(&format!("\n   {}", item.link));
            if !item.description.is_empty() {
                line.push_str(&format!("\n   {}", item.description));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Pretty-print a JSON body (capped by the caller). Falls back to the raw
/// body when it is not valid JSON.
fn format_json_body(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| body.to_string()),
        Err(_) => body.to_string(),
    }
}

/// Cap a string at maxChars with a truncation marker.
fn truncate_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }
    let head: String = chars[..max_chars].iter().collect();
    format!("{}\n\n[truncated]", head)
}

/// Fetch a raw text body (RSS feeds — UTF-8 XML, plain .text() is fine).
async fn fetch_feed_text(url: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    Ok(Some(resp.text().await.map_err(|e| format!("read: {}", e))?))
}

/// Jina Reader fallback: `https://r.jina.ai/<url>` renders any page
/// (including PDFs and JS-heavy SPAs) as readable text. Free tier works
/// without a key; PURE_JINA_API_KEY raises the rate limits.
async fn scrape_via_jina(url: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    let client = build_http_client(std::time::Duration::from_secs(25), proxy_url)?;
    let mut req = client
        .get(format!("https://r.jina.ai/{}", url))
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "text/plain");
    if let Ok(key) = std::env::var("PURE_JINA_API_KEY") {
        if !key.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", key.trim()));
        }
    }
    let resp = req.send().await.map_err(|e| format!("request: {}", e))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let text = resp.text().await.map_err(|e| format!("read: {}", e))?;
    Ok((!text.trim().is_empty()).then_some(text))
}

/// Jina Reader renders pages the direct fetch cannot (blocked, JS-heavy,
/// binary) — free tier, no key required. Used by web_scrape AND web_fetch.
async fn scrape_fallback(url: &str, proxy_url: Option<&str>) -> Result<Option<String>, String> {
    scrape_via_jina(url, proxy_url).await
}

#[tauri::command]
async fn web_scrape(
    _workspace: String,
    url: String,
    selector: Option<String>,
    max_chars: Option<usize>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("web_scrape url must not be empty".to_string());
    }
    let selector = selector.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let max = max_chars.unwrap_or(20000).min(50000);

    // Page cache: same URL + selector + maxChars bucket within the hour.
    let page_key = page_cache_key(&url, selector.as_deref(), max);
    if let Some(hit) = web_cache().lock().unwrap().get(&page_key) {
        return Ok(hit);
    }

    let client = build_http_client(std::time::Duration::from_secs(30), proxy_url.as_deref())?;
    let resp = client
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !resp.status().is_success() {
        // Blocked / anti-bot page: Jina Reader fallback.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        return Err(format!(
            "Fetch failed: HTTP {} — the page may block non-browser clients. Do NOT retry web_scrape on this URL; use web_search to find a mirror or a different page.",
            resp.status()
        ));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !is_textual_content_type(&content_type) {
        // Binary payloads (PDFs, images) can still be read via Jina Reader.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        return Err(format!(
            "Unsupported content type: {} — the URL serves a non-text payload, so web_scrape cannot extract readable text from it. Do NOT retry web_scrape on this URL; use web_search to find a text/HTML page with the information, or pick a different URL.",
            content_type
        ));
    }

    let body = response_text_with_charset(resp).await?;
    let text = if is_feed_body(&body) {
        format_feed_text(&body)
    } else if content_type.to_lowercase().contains("json")
        || body.trim_start().starts_with('{')
        || body.trim_start().starts_with('[')
    {
        format_json_body(&body)
    } else {
        extract_scrape_text(&body, selector.as_deref())
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        // JS-heavy or blank page: the static HTML carried no readable text.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        return Err(format!(
            "No readable text could be extracted from {} — the page is likely JavaScript-rendered or blank. Do NOT retry web_scrape on this URL; use web_search to find the information elsewhere.",
            url
        ));
    }
    let page = truncate_text(&text, max);
    web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
    Ok(page)
}

#[cfg(test)]
mod web_tier_2_3_tests {
    use super::*;

    #[test]
    fn cache_serves_fresh_value_and_expires_after_ttl() {
        let dir = std::env::temp_dir().join(format!("pure-cache-test-ttl-{}", std::process::id()));
        let file = dir.join("web-cache.json");
        let mut c = WebCache::new(file.clone());
        c.set("k", "v", 40);
        assert_eq!(c.get("k"), Some("v".to_string()));
        std::thread::sleep(std::time::Duration::from_millis(80));
        assert_eq!(c.get("k"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_persists_and_reloads_from_disk() {
        let dir = std::env::temp_dir().join(format!("pure-cache-test-persist-{}", std::process::id()));
        let file = dir.join("web-cache.json");
        {
            let mut c = WebCache::new(file.clone());
            c.set("k1", "hello", 60_000);
        }
        let mut c2 = WebCache::load(file.clone());
        assert_eq!(c2.get("k1"), Some("hello".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_tolerates_corrupt_file_and_caps_values() {
        let dir = std::env::temp_dir().join(format!("pure-cache-test-corrupt-{}", std::process::id()));
        let file = dir.join("web-cache.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, "{not json!!").unwrap();
        let mut c = WebCache::load(file.clone());
        assert_eq!(c.get("k1"), None);
        let big = "x".repeat(WEB_CACHE_MAX_VALUE_BYTES + 10_000);
        c.set("big", &big, 60_000);
        assert!(c.get("big").map(|v| v.len() <= WEB_CACHE_MAX_VALUE_BYTES).unwrap_or(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_evicts_oldest_first_over_the_entry_cap() {
        let dir = std::env::temp_dir().join(format!("pure-cache-test-evict-{}", std::process::id()));
        let file = dir.join("web-cache.json");
        let mut c = WebCache::new(file.clone());
        for i in 0..(WEB_CACHE_MAX_ENTRIES + 10) {
            c.set(&format!("key-{}", i), &format!("value-{}", i), 60_000);
        }
        assert_eq!(c.get("key-0"), None); // oldest evicted
        assert_eq!(
            c.get(&format!("key-{}", WEB_CACHE_MAX_ENTRIES + 9)),
            Some(format!("value-{}", WEB_CACHE_MAX_ENTRIES + 9))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_keys_normalize_and_match_the_node_scheme() {
        // CJK internal whitespace is dropped; English keeps single spaces.
        assert_eq!(
            normalize_query("北京 天气"),
            normalize_query("北京天气")
        );
        assert_ne!(normalize_query("react hooks"), normalize_query("reacthooks"));
        // Keys are stable and bounded (64-bit hex, 1..=16 chars).
        let k1 = search_cache_key("react hooks 教程", 10);
        assert_eq!(k1, search_cache_key("react hooks 教程", 10));
        assert_ne!(k1, search_cache_key("react hooks 教程", 5));
        assert!((1..=16).contains(&k1.len()));
        // Cross-language constants (locked against webCache.test.ts):
        // fnv1a64("a\0b") and the CJK key hash — if these break, the CLI and
        // GUI no longer share cache keys.
        assert_eq!(cache_hash_key(&["a", "b"]), "e5d29919042666b2");
        assert_eq!(cache_hash_key(&["publicapi", "", "京", ""]), "bcf7740e6f3298ee");
        // Page keys include selector and maxChars bucket.
        assert_eq!(
            page_cache_key("https://a.com/x", None, 20000),
            page_cache_key("https://a.com/x", None, 15000)
        );
        assert_ne!(
            page_cache_key("https://a.com/x", None, 20000),
            page_cache_key("https://a.com/x", Some("#main"), 20000)
        );
        assert_ne!(
            page_cache_key("https://a.com/x", None, 20000),
            page_cache_key("https://a.com/x", None, 50000)
        );
        // Public-API keys include category and location.
        assert_eq!(
            public_api_cache_key("北京天气", None, Some("beijing")),
            public_api_cache_key("北京 天气", None, Some("beijing"))
        );
        assert_ne!(
            public_api_cache_key("天气", None, Some("beijing")),
            public_api_cache_key("天气", None, Some("shanghai"))
        );
        assert_ne!(
            public_api_cache_key("weather", Some("weather"), None),
            public_api_cache_key("weather", None, None)
        );
    }

    #[test]
    fn public_api_ttl_table_matches_freshness_classes() {
        assert_eq!(public_api_ttl_ms(IntentKind::News), 10 * 60 * 1000);
        assert_eq!(public_api_ttl_ms(IntentKind::Weather), 20 * 60 * 1000);
        assert_eq!(public_api_ttl_ms(IntentKind::Wiki), 7 * 24 * 60 * 60 * 1000);
        assert_eq!(public_api_ttl_ms(IntentKind::Geocode), 30 * 24 * 60 * 60 * 1000);
    }

    #[test]
    fn build_request_guard_blocks_chinese_and_english_builds() {
        assert!(is_build_request("写一个天气网站"));
        assert!(is_build_request("帮我写一个爬虫脚本"));
        assert!(is_build_request("帮我做一个小游戏"));
        assert!(is_build_request("build a weather app"));
        assert!(!is_build_request("北京天气"));
        assert!(!is_build_request("weather in tokyo"));
        assert!(!is_build_request("makeup"));
        assert!(!is_build_request(""));
    }

    #[test]
    fn classify_routes_structured_intents() {
        assert_eq!(classify_intent("北京明天天气"), Some(IntentKind::Weather));
        assert_eq!(classify_intent("东京的经纬度"), Some(IntentKind::Geocode));
        assert_eq!(classify_intent("今天有什么新闻"), Some(IntentKind::News));
        assert_eq!(classify_intent("JavaScript 是什么"), Some(IntentKind::Wiki));
        assert_eq!(classify_intent("我的IP地址"), Some(IntentKind::Ip));
        assert_eq!(classify_intent("100 usd to cny"), Some(IntentKind::Fx));
        assert_eq!(classify_intent("苹果股价"), Some(IntentKind::Stock));
        assert_eq!(classify_intent("github 上最火的 AI 仓库"), Some(IntentKind::Github));
        assert_eq!(classify_intent("北京到上海机票"), None);
    }

    #[test]
    fn classify_routes_air_quality_and_worldbank() {
        assert_eq!(classify_intent("北京空气质量"), Some(IntentKind::AirQuality));
        assert_eq!(classify_intent("北京PM2.5是多少"), Some(IntentKind::AirQuality));
        assert_eq!(classify_intent("中国GDP是多少"), Some(IntentKind::WorldBank));
        assert_eq!(classify_intent("美国人口总数"), Some(IntentKind::WorldBank));
        assert_eq!(classify_intent("日本失业率"), Some(IntentKind::WorldBank));
        // "人口老龄化" is an analysis question, not a population-count lookup.
        assert_eq!(classify_intent("中国人口老龄化趋势"), None);
    }

    #[test]
    fn worldbank_country_uses_word_boundaries_for_english() {
        assert_eq!(worldbank_country("美国GDP"), Some(("US", "美国")));
        assert_eq!(worldbank_country("us gdp"), Some(("US", "美国")));
        assert_eq!(worldbank_country("中国人口"), Some(("CN", "中国")));
        assert_eq!(worldbank_country("must know"), None);
    }

    #[test]
    fn classify_rejects_builds_empty_and_prose() {
        assert_eq!(classify_intent(""), None);
        assert_eq!(classify_intent("写一个天气网站"), None);
        assert_eq!(classify_intent("react 状态管理最佳实践"), None);
        assert_eq!(classify_intent("北京到上海机票"), None);
        let long = "北京明天天气怎么样，我想知道会不会下雨，因为我要考虑要不要带伞出门上班，还要看看温度适不适合穿外套";
        assert!(long.chars().count() > 40);
        assert_eq!(classify_intent(long), None);
    }

    #[test]
    fn fx_grammar_parses_english_and_chinese_pairs() {
        let en = parse_fx_query("100 usd to cny").expect("english pair");
        assert_eq!((en.from.as_str(), en.to.as_str(), en.amount), ("USD", "CNY", 100.0));
        let en2 = parse_fx_query("5 EUR in JPY").expect("english in");
        assert_eq!((en2.from.as_str(), en2.to.as_str(), en2.amount), ("EUR", "JPY", 5.0));
        let zh = parse_fx_query("1美元等于多少人民币").expect("chinese pair");
        assert_eq!((zh.from.as_str(), zh.to.as_str(), zh.amount), ("USD", "CNY", 1.0));
        let zh2 = parse_fx_query("人民币兑日元").expect("chinese 兑");
        assert_eq!((zh2.from.as_str(), zh2.to.as_str()), ("CNY", "JPY"));
        let bare = parse_fx_query("美元汇率").expect("bare");
        assert_eq!((bare.from.as_str(), bare.to.as_str(), bare.amount), ("USD", "CNY", 1.0));
        assert!(parse_fx_query("你好吗").is_none());
        assert!(parse_fx_query("今天天气").is_none());
    }

    #[test]
    fn stock_symbol_resolution() {
        assert_eq!(resolve_stock_symbol("苹果股价").as_deref(), Some("usAAPL"));
        assert_eq!(resolve_stock_symbol("贵州茅台").as_deref(), Some("sh600519"));
        assert_eq!(resolve_stock_symbol("腾讯控股").as_deref(), Some("hk00700"));
        assert_eq!(resolve_stock_symbol("0700.hk").as_deref(), Some("hk00700"));
        assert_eq!(resolve_stock_symbol("aapl.us").as_deref(), Some("usAAPL"));
        assert_eq!(resolve_stock_symbol("tsla").as_deref(), Some("usTSLA"));
        assert!(resolve_stock_symbol("not a ticker").is_none());
        assert!(resolve_stock_symbol("github").is_none());
    }

    #[test]
    fn location_extraction_strips_time_and_intent_words() {
        assert_eq!(extract_location("北京明天天气"), "北京");
        assert_eq!(extract_location("weather in tokyo"), "tokyo");
    }

    #[test]
    fn rss_items_parse_title_link_date_description() {
        let xml = r#"<?xml version="1.0"?><rss><channel>
            <item><title>First story</title><link>https://example.com/1</link><pubDate>Mon, 11 Aug 2026 10:00:00 GMT</pubDate><description>Lead paragraph one.</description></item>
            <item><title>Second story</title><link>https://example.com/2</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate><description>Lead paragraph two.</description></item>
        </channel></rss>"#;
        let items = parse_rss_items(xml, 8);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "First story");
        assert_eq!(items[0].link, "https://example.com/1");
        assert!(items[0].date.contains("2026"));
        assert_eq!(items[1].description, "Lead paragraph two.");
    }

    #[test]
    fn noise_tags_are_stripped_including_nested_blocks() {
        let html = "<nav><a>menu</a></nav><header>brand</header><article><p>Real content</p></article><footer>© 2026</footer>";
        let cleaned = strip_noise_tags(html);
        assert!(!cleaned.contains("menu"));
        assert!(!cleaned.contains("brand"));
        assert!(!cleaned.contains("© 2026"));
        assert!(cleaned.contains("Real content"));
        let nested = "<div><nav><div><span>deep</span></div></nav><p>kept</p></div>";
        assert_eq!(strip_noise_tags(nested), "<div><p>kept</p></div>");
    }

    #[test]
    fn selector_extraction_scopes_by_id_class_and_tag() {
        let html = "<div id=\"main\"><p>Main content</p></div><div id=\"sidebar\"><p>Side</p></div>";
        assert_eq!(extract_by_selector(html, "#main"), vec!["<p>Main content</p>"]);
        let classed = "<div class=\"content\">A</div><div class=\"sidebar\">B</div>";
        assert_eq!(extract_by_selector(classed, ".content"), vec!["A"]);
        let tagged = "<article>One</article><p>x</p><article>Two</article>";
        assert_eq!(extract_by_selector(tagged, "article"), vec!["One", "Two"]);
        assert!(extract_by_selector(html, "#nope").is_empty());
        assert!(extract_by_selector(html, "a[b]").is_empty());
        assert!(extract_by_selector(html, "").is_empty());
    }

    #[test]
    fn feed_detection_and_formatting() {
        let rss = r#"<rss><channel><item><title>First story</title><link>https://example.com/1</link><pubDate>Mon, 11 Aug 2026 10:00:00 GMT</pubDate><description>Lead one.</description></item></channel></rss>"#;
        assert!(is_feed_body(rss));
        assert!(!is_feed_body("<html><body>not a feed</body></html>"));
        let text = format_feed_text(rss);
        assert!(text.contains("1. First story"));
        assert!(text.contains("https://example.com/1"));
        assert!(text.contains("Lead one."));
    }

    #[test]
    fn json_body_pretty_prints_and_passes_through_invalid() {
        assert_eq!(format_json_body("{\"a\":1}"), "{\n  \"a\": 1\n}");
        assert_eq!(format_json_body("not json"), "not json");
    }

    #[test]
    fn truncate_caps_at_char_count() {
        assert_eq!(truncate_text("abc", 5), "abc");
        assert_eq!(truncate_text("abcdefghij", 5), "abcde\n\n[truncated]");
    }

    #[test]
    fn scrape_text_extracts_scoped_readable_text() {
        let html = "<nav>menu</nav><main><h1>Story</h1><p>First &amp; second.</p></main>";
        assert_eq!(
            extract_scrape_text(html, Some("#story")),
            "Story\nFirst & second."
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Web Fetch (URL → readable text)
// ═══════════════════════════════════════════════════════════════════════════════
#[tauri::command]
async fn web_fetch(
    _workspace: String,
    url: String,
    max_chars: Option<usize>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let max = max_chars.unwrap_or(20000);

    // Page cache: same URL + maxChars bucket within the hour.
    let page_key = page_cache_key(&url, None, max);
    if let Some(hit) = web_cache().lock().unwrap().get(&page_key) {
        return Ok(hit);
    }

    let client = build_http_client(std::time::Duration::from_secs(30), proxy_url.as_deref())?;

    let resp = client
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !resp.status().is_success() {
        // Blocked / anti-bot page: Jina Reader fallback.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        return Err(format!("Fetch failed: HTTP {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Accept any text-ish media type so the model doesn't hit the same
    // "unsupported content type" wall repeatedly on JSON/XML/JS/CSV pages or
    // when a server omits the header. Only clearly binary payloads (images,
    // media, archives, PDFs, octet-stream) are rejected — and the error tells
    // the model how to recover instead of just what failed.
    if !is_textual_content_type(&content_type) {
        // Empty content-type never reaches this branch (helper returns true),
        // so content_type is always a non-empty binary type here. Binary
        // payloads (PDFs, images) can still be read via Jina Reader.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        return Err(format!(
            "Unsupported content type: {} — the URL serves a non-text payload, so web_fetch cannot extract readable text from it. Do NOT retry web_fetch on this URL; instead use web_search to find a text/HTML page with the information, or pick a different URL.",
            content_type
        ));
    }

    let html = response_text_with_charset(resp).await?;
    let text = strip_html_full(&html);

    let safe_end = text
        .char_indices()
        .nth(max)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let truncated = if text.len() > safe_end {
        format!("{}\n\n[truncated]", &text[..safe_end])
    } else {
        text.to_string()
    };

    if truncated.trim().is_empty() {
        // JS-heavy or blank page: the static HTML carried no readable text.
        if let Some(fallback) = scrape_fallback(&url, proxy_url.as_deref()).await? {
            let page = truncate_text(&fallback, max);
            web_cache().lock().unwrap().set(&page_key, &page, PAGE_TTL_MS);
            return Ok(page);
        }
        web_cache().lock().unwrap().set(&page_key, "(empty page)", PAGE_TTL_MS);
        Ok("(empty page)".to_string())
    } else {
        web_cache().lock().unwrap().set(&page_key, &truncated, PAGE_TTL_MS);
        Ok(truncated)
    }
}

/// True when a Content-Type header is a text-like payload web_fetch can read.
/// Accepts text/* and common text-bearing application subtypes (JSON, XML,
/// JavaScript, SVG, RSS/Atom, form data); a missing/empty header is treated as
/// text so the fetch still works on servers that omit it. Rejects only clearly
/// binary payloads (images, audio/video, fonts, archives, PDF, octet-stream).
fn is_textual_content_type(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    let main = ct.split(';').next().unwrap_or("").trim();
    if main.is_empty() {
        return true;
    }
    if main.starts_with("text/") {
        return true;
    }
    if main.ends_with("+json") || main.ends_with("+xml") {
        return true;
    }
    matches!(
        main,
        "application/json"
            | "application/xml"
            | "application/xhtml+xml"
            | "application/javascript"
            | "application/x-javascript"
            | "application/x-www-form-urlencoded"
            | "application/svg+xml"
            | "application/rss+xml"
            | "application/atom+xml"
    )
}

fn strip_html_full(html: &str) -> String {
    // Remove scripts and styles
    let mut s = String::new();
    let mut in_skip = false;
    let mut skip_tag = String::new();
    let mut i = 0;
    let chars: Vec<char> = html.chars().collect();

    while i < chars.len() {
        // Case-insensitive open-tag detection (<SCRIPT>/<Style> count too),
        // mirroring the Node stripHtml regexes' /gi flag. Both script and
        // style are ASCII, so eq_ignore_ascii_case is safe. The tag-name
        // boundary (next char is '>', whitespace, or EOF) rejects tags like
        // <scripture> that merely START with "script" — matching the Node
        // side, which only enters skip mode for a real <script …> opening.
        if i + 6 < chars.len()
            && chars[i..i + 7]
                .iter()
                .collect::<String>()
                .eq_ignore_ascii_case("<script")
            && matches!(
                chars.get(i + 7).copied(),
                None | Some('>') | Some(' ') | Some('\t') | Some('\n') | Some('\r')
            )
        {
            in_skip = true;
            skip_tag = "script".to_string();
        } else if i + 5 < chars.len()
            && chars[i..i + 6]
                .iter()
                .collect::<String>()
                .eq_ignore_ascii_case("<style")
            && matches!(
                chars.get(i + 6).copied(),
                None | Some('>') | Some(' ') | Some('\t') | Some('\n') | Some('\r')
            )
        {
            in_skip = true;
            skip_tag = "style".to_string();
        }

        if in_skip {
            let close_tag = format!("</{}>", skip_tag);
            if i + close_tag.len() <= chars.len()
                && chars[i..i + close_tag.len()]
                    .iter()
                    .collect::<String>()
                    .eq_ignore_ascii_case(&close_tag)
            {
                in_skip = false;
                skip_tag.clear();
                i += close_tag.len();
                continue;
            }
            i += 1;
            continue;
        }

        s.push(chars[i]);
        i += 1;
    }

    // Now strip all HTML tags
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
            // Add newlines for block-level breaks
            result.push('\n');
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }
    }

    // Collapse whitespace
    let lines: Vec<&str> = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    html_decode(&lines.join("\n"))
}

// Mirrors the Node web_fetch text extractor (NodeToolAdapter.ts stripHtml) —
// both must produce IDENTICAL results on the common core: tag stripping,
// script/style removal, <br> and block tags as line breaks, whitespace
// collapsed to trimmed non-empty lines. KNOWN INTENTIONAL DIVERGENCES (each
// side pinned in the tests below, do NOT "unify" blindly):
// 1. Entities — this side html-decodes (&amp; → &); the Node side keeps raw
//    entities because its stripHtml feeds the DDG/Bing parsers which decode
//    AFTER stripping.
// 2. Tag boundaries — this side inserts a line break at EVERY tag boundary
//    ("Hello\nworld", "A\nB" for table cells); the Node side only breaks on
//    <br> and the block closers </p>, </div>, </h1-6>, </li>, </tr>, </section>,
//    </article>, removing every other tag (inline <b>/<span>, <td>/<th> cells,
//    attribute-bearing <br class="…">) without a break ("Hello world", "AB").
#[cfg(test)]
mod web_fetch_tests {
    use super::*;

    // ── Common core: identical fixtures + identical assertions on both sides ──

    #[test]
    fn passes_plain_text_through() {
        assert_eq!(strip_html_full("Hello world"), "Hello world");
    }

    #[test]
    fn strips_tags_and_collapses_block_layout_to_lines() {
        assert_eq!(
            strip_html_full("<h1>Title</h1><p>Hello world</p>"),
            "Title\nHello world"
        );
    }

    #[test]
    fn turns_paragraphs_into_separate_lines() {
        let html = "<div><p>First paragraph.</p><p>Second paragraph.</p></div>";
        assert_eq!(strip_html_full(html), "First paragraph.\nSecond paragraph.");
    }

    #[test]
    fn treats_br_as_a_line_break() {
        assert_eq!(strip_html_full("a<br>b"), "a\nb");
    }

    #[test]
    fn drops_script_and_style_blocks_entirely() {
        let html = "<script>var x = 1;</script><style>.c { color: red }</style><p>Clean</p>";
        assert_eq!(strip_html_full(html), "Clean");
    }

    #[test]
    fn strips_uppercase_and_mixed_case_script_style() {
        // Case-insensitive like the Node regexes (/gi) — <SCRIPT>/<ScRiPt>
        // and </STYLE> are stripped too, not kept as text.
        assert_eq!(strip_html_full("<SCRIPT>var x=1;</SCRIPT><p>Ok</p>"), "Ok");
        assert_eq!(
            strip_html_full(
                "<ScRiPt type=\"text/javascript\">var y=2;</ScRiPt><Style>.a{}</Style><p>Hi</p>"
            ),
            "Hi"
        );
    }

    #[test]
    fn treats_script_like_tags_as_plain_tags() {
        // <scripture> only STARTS with "script" — the tag-name boundary check
        // keeps it out of skip mode, so it is stripped like any other tag
        // (matching the Node side; without the check this would swallow to
        // EOF and drop the whole page).
        assert_eq!(strip_html_full("<scripture>foo</scripture>"), "foo");
    }

    #[test]
    fn collapses_indentation_but_keeps_inner_spacing() {
        let html = "<div>\n  <p>  Indented  text  </p>\n</div>";
        assert_eq!(strip_html_full(html), "Indented  text");
    }

    // ── Documented divergences (each side pinned; see module header) ──

    #[test]
    fn decodes_html_entities() {
        // Node stripHtml keeps &amp; raw — intentional (see header). The Node
        // web_fetch pipeline (extractReadableText) decodes AFTER trim, same
        // as here.
        assert_eq!(strip_html_full("<p>Tom &amp; Jerry</p>"), "Tom & Jerry");
    }

    #[test]
    fn decodes_nbsp_after_trim_keeping_trailing_space() {
        // Locks the trim-then-decode ordering: &nbsp; is literal text at trim
        // time, so it survives to decode and becomes a trailing space. The
        // Node extractReadableText mirrors this (same "a " result).
        assert_eq!(strip_html_full("<p>a&nbsp;</p>"), "a ");
    }

    #[test]
    fn splits_at_inline_tag_boundaries() {
        // Node stripHtml keeps inline content on one line — intentional (see header).
        assert_eq!(strip_html_full("<p>Hello <b>world</b></p>"), "Hello\nworld");
    }

    #[test]
    fn splits_table_cells_into_separate_lines() {
        // Node stripHtml merges <td> cells ("AB\nC") — <td>/<th> are outside
        // its block list; only </tr> separates rows there. Intentional (see
        // module header).
        let html = "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>";
        assert_eq!(strip_html_full(html), "A\nB\nC");
    }

    #[test]
    fn splits_at_attribute_bearing_br() {
        // Node stripHtml only matches bare/self-closed <br> ("ab" for
        // <br class="…">); this side breaks at every tag. Intentional (see
        // module header).
        assert_eq!(strip_html_full("a<br class=\"x\">b"), "a\nb");
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Replace Files (batch string replacement)
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn replace_files(
    workspace: String,
    files: Vec<String>,
    old_string: String,
    new_string: String,
    allow_multiple: Option<bool>,
) -> Result<String, String> {
    if files.is_empty() {
        return Err("No files specified".to_string());
    }

    let multi = allow_multiple.unwrap_or(false);
    let mut results: Vec<String> = Vec::new();
    let mut total_occurrences = 0usize;
    let mut errors = 0usize;

    for file_path in &files {
        let full = match resolve(&workspace, file_path) {
            Ok(f) => f,
            Err(e) => {
                results.push(format!("✗ {}: {}", file_path, e));
                errors += 1;
                continue;
            }
        };

        let text = match fs::read_to_string(&full) {
            Ok(t) => t,
            Err(e) => {
                results.push(format!("✗ {}: read failed — {}", file_path, e));
                errors += 1;
                continue;
            }
        };

        let occurrences = text.matches(&old_string).count();

        if occurrences == 0 {
            results.push(format!("− {}: string not found", file_path));
            continue;
        }

        if occurrences > 1 && !multi {
            results.push(format!(
                "✗ {}: found {} occurrences — set allowMultiple:true or narrow match",
                file_path, occurrences
            ));
            errors += 1;
            continue;
        }

        let new_text = if multi {
            text.replace(&old_string, &new_string)
        } else {
            text.replacen(&old_string, &new_string, 1)
        };

        if let Err(e) = fs::write(&full, &new_text) {
            results.push(format!("✗ {}: write failed — {}", file_path, e));
            errors += 1;
        } else {
            let n = if multi { occurrences } else { 1 };
            results.push(format!("✓ {}: replaced {} occurrence(s)", file_path, n));
            total_occurrences += n;
        }
    }

    let summary = format!(
        "{} file(s) processed, {} replacement(s), {} error(s)",
        files.len(),
        total_occurrences,
        errors
    );

    Ok(format!("{}\n{}", summary, results.join("\n")))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP Subprocess Commands
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn spawn_mcp(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<BTreeMap<String, String>>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let key = mcp_key(&session_id, &name);

    let mut cmd = silent_child_tokio(TokioCommand::new(&command));
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(extra) = &env {
        cmd.envs(extra);
    }
    // Prepend the runtime dirs to the effective PATH (a config-supplied PATH
    // in `env` wins as the base over the inherited one — never clobber it).
    let configured_path = env.as_ref().and_then(|e| e.get("PATH")).cloned();
    let base_path = configured_path.or_else(|| std::env::var("PATH").ok());
    cmd.env("PATH", augmented_mcp_path(base_path.as_deref()));
    // The proxy password lives in Rust secrets and is resolved here, so it
    // never travels through the WebView on the spawn path.
    if let Some(url) = proxy_url.as_deref().filter(|url| !url.trim().is_empty()) {
        let resolved = resolve_proxy_auth(url);
        if valid_proxy_url(&resolved) {
            cmd.env("HTTP_PROXY", &resolved)
                .env("HTTPS_PROXY", &resolved)
                .env("ALL_PROXY", &resolved)
                .env("NO_PROXY", "localhost,127.0.0.1,::1");
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {}", command, e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let handle = McpHandle {
        child: tokio::sync::Mutex::new(child),
        stdin: tokio::sync::Mutex::new(stdin),
        stdout: tokio::sync::Mutex::new(BufReader::new(stdout)),
    };

    let mut registry = state.lock().await;
    registry.insert(key.clone(), Arc::new(handle));

    Ok(key)
}

#[tauri::command]
async fn mcp_http_request(
    url: String,
    method: String,
    body: Option<String>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let client = build_http_client(std::time::Duration::from_secs(30), proxy_url.as_deref())?;
    let mut request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("unsupported MCP HTTP method: {}", other)),
    };
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|e| format!("request: {}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("read: {}", e))?;
    if !status.is_success() {
        return Err(format!("MCP HTTP {}: {}", status.as_u16(), text));
    }
    Ok(text)
}

#[tauri::command]
async fn mcp_request(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
    request: String,
) -> Result<String, String> {
    let key = mcp_key(&session_id, &name);
    let handle = {
        let registry = state.lock().await;
        registry
            .get(&key)
            .ok_or_else(|| format!("MCP not found: {}", key))?
            .clone()
    };
    mcp_call_inner(&handle, &request).await
}

/// Send an MCP JSON-RPC notification (write-only — the server sends no
/// response, so unlike `mcp_request` this must NOT block waiting for a line).
#[tauri::command]
async fn mcp_notify(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
    request: String,
) -> Result<(), String> {
    let key = mcp_key(&session_id, &name);
    let handle = {
        let registry = state.lock().await;
        registry
            .get(&key)
            .ok_or_else(|| format!("MCP not found: {}", key))?
            .clone()
    };
    let mut stdin = handle.stdin.lock().await;
    stdin
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("write stdin: {}", e))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write newline: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush stdin: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn mcp_shutdown(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let key = mcp_key(&session_id, &name);
    let handle = {
        let mut registry = state.lock().await;
        registry.remove(&key)
    };
    if let Some(handle) = handle {
        let mut child = handle.child.lock().await;
        let _ = child.kill().await;
    }
    Ok(())
}

#[tauri::command]
async fn mcp_list(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let registry = state.lock().await;
    let keys: Vec<String> = registry
        .keys()
        .filter(|k| k.starts_with(&format!("{}:", session_id)))
        .cloned()
        .collect();
    Ok(keys)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Application Temporary Workspace (~/.pure/tmp/<session-id>/)
// ═══════════════════════════════════════════════════════════════════════════════

fn application_tmp_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pure").join("tmp")
}

fn safe_session_component(session_id: &str) -> String {
    // Encode every byte instead of replacing punctuation with `_`; replacement
    // could make distinct session IDs map to the same temporary directory.
    let encoded: String = session_id.bytes().map(|b| format!("{:02x}", b)).collect();
    if encoded.is_empty() {
        "session".to_string()
    } else {
        encoded
    }
}

#[tauri::command]
fn get_tmp_workspace(session_id: String) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("session id is required".to_string());
    }
    let workspace = application_tmp_dir().join(safe_session_component(&session_id));
    fs::create_dir_all(&workspace).map_err(|e| format!("create tmp workspace: {}", e))?;
    Ok(workspace.to_string_lossy().to_string())
}

/// Reduce a paste-provided filename to its final path component so a name can
/// never escape the session tmp dir (`../../evil.txt` → `evil.txt`).
fn sanitize_paste_name(name: &str) -> String {
    std::path::Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "pasted.txt".to_string())
}

/// Write a large pasted snippet into the session's tmp workspace and return
/// the absolute path. Split out for unit testing (a Tauri command can't be
/// constructed inside a plain test).
fn write_paste_file(dir: &std::path::Path, name: &str, content: &str) -> Result<String, String> {
    write_paste_bytes(dir, name, content.as_bytes())
}

/// Write raw pasted bytes (image payloads) into the session's tmp workspace.
fn write_paste_bytes(dir: &std::path::Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let path = dir.join(sanitize_paste_name(name));
    fs::write(&path, bytes).map_err(|e| format!("write paste file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Decode a base64 image payload sent over IPC (split out for unit tests).
/// Whitespace-only payloads decode to zero bytes under the STANDARD engine
/// (it ignores whitespace) — reject them explicitly so we never persist an
/// empty image file.
fn decode_paste_image(data_base64: &str) -> Result<Vec<u8>, String> {
    let trimmed = data_base64.trim();
    if trimmed.is_empty() {
        return Err("empty image payload".to_string());
    }
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .map_err(|e| format!("decode paste image: {}", e))
}

/// The GUI turns oversized paste events (see pasteChip.ts, 64KB threshold)
/// into a file chip instead of stuffing hundreds of KB into the textarea;
/// this persists the content under ~/.pure/tmp/<session-id>/ and the chip
/// double-click viewer reads it back from memory (path kept for reference).
#[tauri::command]
fn save_paste_file(session_id: String, name: String, content: String) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("session id is required".to_string());
    }
    let dir = application_tmp_dir().join(safe_session_component(&session_id));
    fs::create_dir_all(&dir).map_err(|e| format!("create paste dir: {}", e))?;
    write_paste_file(&dir, &name, &content)
}

/// The GUI turns pasted screenshots/images (see pasteChip.ts) into a thumbnail
/// chip and persists the raw bytes here under ~/.pure/tmp/<session-id>/.
#[tauri::command]
fn save_paste_image(
    session_id: String,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("session id is required".to_string());
    }
    let bytes = decode_paste_image(&data_base64)?;
    let dir = application_tmp_dir().join(safe_session_component(&session_id));
    fs::create_dir_all(&dir).map_err(|e| format!("create paste dir: {}", e))?;
    write_paste_bytes(&dir, &name, &bytes)
}

// Upload limits: only text / images / document files may be imported (a
// binary archive or executable is useless to the agent and only bloats the
// session tmp dir). Per-file caps bound the IPC payload + tmp usage.
const DROPPED_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DROPPED_IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DROPPED_TEXT_PREVIEW_BYTES: usize = 2 * 1024 * 1024;

fn dropped_file_mime(name: &str, bytes: &[u8]) -> String {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Binary-archive/executable extensions are rejected regardless of content:
    // a ZIP header is valid UTF-8, so the UTF-8 fallback below would otherwise
    // misclassify archives as text.
    const BINARY_EXTENSIONS: &[&str] = &[
        "zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "tar", "zst", "exe", "msi", "dmg", "pkg",
        "bin", "iso", "img", "so", "dll", "dylib", "apk", "ipa", "deb", "rpm", "jar", "class",
        "wasm", "woff", "woff2", "ttf", "otf",
    ];
    if BINARY_EXTENSIONS.contains(&ext.as_str()) {
        return "application/octet-stream".to_string();
    }
    let known = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        "doc" | "docx" | "rtf" | "odt" => Some("application/msword"),
        "xls" | "xlsx" => Some("application/vnd.ms-excel"),
        "ppt" | "pptx" => Some("application/vnd.ms-powerpoint"),
        "json" => Some("application/json"),
        "xml" => Some("application/xml"),
        "txt" | "log" | "md" | "csv" | "tsv" | "js" | "ts" | "jsx" | "tsx" | "html" | "css"
        | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "sql" | "sh" => Some("text/plain"),
        _ => None,
    };
    if let Some(mime) = known {
        return mime.to_string();
    }
    if std::str::from_utf8(bytes).is_ok() {
        "text/plain".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

fn dropped_file_kind(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("text/") || mime == "application/json" || mime == "application/xml" {
        "text"
    } else if mime == "application/pdf"
        || mime.starts_with("application/vnd.")
        || mime == "application/msword"
    {
        "doc"
    } else {
        "binary"
    }
}

fn unique_tmp_file(dir: &std::path::Path, name: &str, attempt: u32) -> PathBuf {
    let safe = sanitize_paste_name(name);
    if attempt == 0 {
        return dir.join(safe);
    }
    let stem = std::path::Path::new(&safe)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("dropped-file");
    let ext = std::path::Path::new(&safe)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s))
        .unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!("{}-{}-{}{}", stem, stamp, attempt, ext))
}

fn import_dropped_file_inner(
    tmp_dir: &std::path::Path,
    source: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|e| format!("inspect dropped path: {}", e))?;
    if metadata.is_dir() {
        return Ok(
            serde_json::json!({ "isDirectory": true, "name": source.file_name().and_then(|s| s.to_str()).unwrap_or("folder") }),
        );
    }
    if !metadata.is_file() {
        return Err("dropped path is not a regular file".to_string());
    }
    if metadata.len() > DROPPED_FILE_MAX_BYTES {
        return Err(format!(
            "dropped file exceeds {} MB",
            DROPPED_FILE_MAX_BYTES / (1024 * 1024)
        ));
    }
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("dropped-file")
        .to_string();
    let bytes = fs::read(source).map_err(|e| format!("read dropped file: {}", e))?;
    if bytes.len() as u64 > DROPPED_FILE_MAX_BYTES {
        return Err(format!(
            "dropped file exceeds {} MB",
            DROPPED_FILE_MAX_BYTES / (1024 * 1024)
        ));
    }
    let mime = dropped_file_mime(&name, &bytes);
    let kind = dropped_file_kind(&mime);
    if kind == "image" && bytes.len() as u64 > DROPPED_IMAGE_MAX_BYTES {
        return Err(format!(
            "dropped image exceeds {} MB",
            DROPPED_IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }
    if kind == "binary" {
        return Err(
            "binary files are not supported — attach text, images, or documents only".to_string(),
        );
    }
    fs::create_dir_all(tmp_dir).map_err(|e| format!("create dropped-file dir: {}", e))?;

    use std::io::Write as _;
    let stored_name = format!("dropped-{}", sanitize_paste_name(&name));
    let (destination, mut file) = (0..1000)
        .map(|attempt| unique_tmp_file(tmp_dir, &stored_name, attempt))
        .find_map(|candidate| {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some((candidate, file)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(_) => None,
            }
        })
        .ok_or_else(|| "could not allocate a unique temporary filename".to_string())?;
    if let Err(e) = file.write_all(&bytes) {
        let _ = fs::remove_file(&destination);
        return Err(format!("copy dropped file: {}", e));
    }

    let mut record = serde_json::json!({
        "isDirectory": false,
        "name": name,
        "path": destination.to_string_lossy(),
        "size": bytes.len(),
        "kind": kind,
        "mime": mime,
        "content": "",
        "dataUrl": "",
    });
    if kind == "image" {
        use base64::Engine as _;
        let data_url = format!(
            "data:{};base64,{}",
            record["mime"]
                .as_str()
                .unwrap_or("application/octet-stream"),
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        record["dataUrl"] = serde_json::Value::String(data_url);
    } else if kind == "text" {
        let preview =
            String::from_utf8_lossy(&bytes[..bytes.len().min(DROPPED_TEXT_PREVIEW_BYTES)])
                .to_string();
        record["content"] = serde_json::Value::String(preview);
        record["truncated"] = serde_json::Value::Bool(bytes.len() > DROPPED_TEXT_PREVIEW_BYTES);
    }
    Ok(record)
}

/// Copy a user-dropped file into the application-owned session tmp directory.
/// The source path comes from the OS drag/drop API, while the destination is
/// always sanitized and collision-safe inside ~/.pure/tmp/<session-id>/.
#[tauri::command]
fn import_dropped_file(
    session_id: String,
    source_path: String,
) -> Result<serde_json::Value, String> {
    if session_id.trim().is_empty() {
        return Err("session id is required".to_string());
    }
    let source = PathBuf::from(&source_path);
    let tmp_dir = application_tmp_dir().join(safe_session_component(&session_id));
    import_dropped_file_inner(&tmp_dir, &source)
}

// ═══════════════════════════════════════════════════════════════════════════
//  Temp paste-file cleanup (Settings → General → 清理临时文件)
// ═══════════════════════════════════════════════════════════════════════════
// Only `pasted-*` and `dropped-*` files (our own input artifacts) are ever
// deleted — project files the agent wrote into a session tmp workspace (no user
// workspace selected) are left alone. Input files live at <tmp>/<session-id>/
// root, so the scan walks the session dirs one level deep.

const PASTE_PREFIXES: &[&str] = &["pasted-", "dropped-"];

struct PasteFileInfo {
    path: std::path::PathBuf,
    size: u64,
    modified: std::time::SystemTime,
}

/// Non-recursive scan of `dir` for `pasted-*` FILES (dirs with the prefix are
/// ignored). Split out for unit testing.
fn scan_paste_files_in(dir: &std::path::Path) -> Vec<PasteFileInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !PASTE_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .unwrap_or_else(|_| std::time::SystemTime::now());
        out.push(PasteFileInfo {
            path: entry.path(),
            size: meta.len(),
            modified,
        });
    }
    out
}

/// Scan the app tmp root AND each session dir (one level deep).
fn scan_all_paste_files(tmp: &std::path::Path) -> Vec<PasteFileInfo> {
    let mut out = scan_paste_files_in(tmp);
    if let Ok(entries) = fs::read_dir(tmp) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                out.extend(scan_paste_files_in(&entry.path()));
            }
        }
    }
    out
}

/// Age check: strictly older than `days` days (so fresh files are never
/// deleted, even with days = 0). Pure — synthetic times testable.
fn older_than(modified: std::time::SystemTime, now: std::time::SystemTime, days: u64) -> bool {
    let cutoff = days.saturating_mul(24 * 60 * 60);
    now.duration_since(modified)
        .map(|d| d.as_secs() >= cutoff)
        .unwrap_or(false)
}

/// Delete paste files older than `days` days, then remove session dirs that
/// became empty. Returns `(deleted_count, freed_bytes)`. Split out for tests.
fn cleanup_paste_files_in(dir: &std::path::Path, days: u64) -> Result<(u64, u64), String> {
    let now = std::time::SystemTime::now();
    let mut deleted = 0u64;
    let mut freed = 0u64;
    for f in scan_all_paste_files(dir) {
        if older_than(f.modified, now, days) {
            match fs::remove_file(&f.path) {
                Ok(()) => {
                    deleted += 1;
                    freed += f.size;
                }
                Err(e) => eprintln!("cleanup: remove {}: {}", f.path.display(), e),
            }
        }
    }
    // Remove session dirs left empty by the cleanup — only when something was
    // actually deleted, so an active-but-empty session dir is never disturbed.
    if deleted > 0 {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir()
                    && fs::read_dir(&p)
                        .map(|mut it| it.next().is_none())
                        .unwrap_or(false)
                {
                    let _ = fs::remove_dir(&p);
                }
            }
        }
    }
    Ok((deleted, freed))
}

/// Settings → General: current paste-file footprint (files + bytes).
#[tauri::command]
fn tmp_paste_usage() -> Result<serde_json::Value, String> {
    let files = scan_all_paste_files(&application_tmp_dir());
    let bytes: u64 = files.iter().map(|f| f.size).sum();
    Ok(serde_json::json!({ "files": files.len(), "bytes": bytes }))
}

/// Settings → General: delete paste files older than `days` days.
#[tauri::command]
fn cleanup_tmp_pastes(days: u64) -> Result<serde_json::Value, String> {
    let days = days.clamp(1, 365);
    let (deleted, freed_bytes) = cleanup_paste_files_in(&application_tmp_dir(), days)?;
    Ok(serde_json::json!({ "deleted": deleted, "freedBytes": freed_bytes }))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Secret Management (file-based, ~/.pure/secrets.json, 0600 permissions)
// ═══════════════════════════════════════════════════════════════════════════════

fn secrets_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pure").join("secrets.json")
}

fn load_secrets() -> Result<serde_json::Value, String> {
    let path = secrets_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read secrets: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse secrets: {}", e))
}

fn save_secrets(secrets: &serde_json::Value) -> Result<(), String> {
    let path = secrets_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(secrets).map_err(|e| format!("serialize: {}", e))?;
    fs::write(&path, &json).map_err(|e| format!("write secrets: {}", e))?;
    // Set restrictive permissions (Unix only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let secrets = load_secrets()?;
    Ok(secrets
        .get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let mut secrets = load_secrets()?;
    if let Some(obj) = secrets.as_object_mut() {
        obj.insert(key, serde_json::Value::String(value));
    }
    save_secrets(&secrets)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let mut secrets = load_secrets()?;
    if let Some(obj) = secrets.as_object_mut() {
        obj.remove(&key);
    }
    save_secrets(&secrets)
}

#[tauri::command]
fn secret_list() -> Result<Vec<String>, String> {
    let secrets = load_secrets()?;
    Ok(secrets
        .as_object()
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  App config file (~/.pure/config.json) — GUI + hand-editing share one source.
//  The WebView mirrors the file into localStorage at startup and writes it back
//  on every save, so a user who edits config.json directly sees the change
//  after the next app launch. Secrets (API keys / proxy password) are NOT in
//  this file — they stay in ~/.pure/secrets.json (0600).
// ═══════════════════════════════════════════════════════════════════════════════

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pure").join("config.json")
}

/// Read the user-editable app config. `Ok(None)` when the file is missing
/// (first run / not yet migrated) — the caller falls back to its defaults.
#[tauri::command]
fn load_config() -> Result<Option<serde_json::Value>, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read config: {}", e))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse config: {}", e))
}

/// Persist the user-editable app config (pretty JSON, ~/.pure/config.json).
#[tauri::command]
fn save_config(config: serde_json::Value) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("serialize: {}", e))?;
    fs::write(&path, &json).map_err(|e| format!("write config: {}", e))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LLM Transport (reqwest HTTP/2 SSE → Channel)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct ChatStreamArgs {
    messages: Vec<serde_json::Value>,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    tools: Vec<serde_json::Value>,
    model: String,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "baseUrl")]
    base_url: String,
    #[serde(default, rename = "secretKey")]
    secret_key: String,
    #[serde(default, rename = "extraBody")]
    extra_body: Option<serde_json::Value>,
    #[serde(default, rename = "maxTokens")]
    max_tokens_override: Option<u32>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default, rename = "requestId")]
    request_id: String,
    #[serde(default, rename = "proxyUrl")]
    proxy_url: String,
    #[serde(default, rename = "proxyBypassProviders")]
    proxy_bypass_providers: Vec<String>,
}

fn proxy_matches(value: &str, patterns: &[String]) -> bool {
    let value = value.trim().to_ascii_lowercase();
    !value.is_empty() && patterns.iter().any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        !pattern.is_empty() && (pattern == value || value.contains(&pattern))
    })
}

fn llm_proxy_url(args: &ChatStreamArgs) -> Option<&str> {
    if args.proxy_url.trim().is_empty()
        || proxy_matches(&args.provider, &args.proxy_bypass_providers)
    {
        None
    } else {
        Some(args.proxy_url.trim())
    }
}

// Tool-call argument delta emit throttle (ms): forwarding the FULL accumulated
// buffer on every token would be O(n²) over the channel for a giant argument
// (write_file `content`, a whole HTML file). ~10 emits/s keeps the GUI's tool
// row live while bounding the payload volume to a few hundred KB total. The
// UI-side parse throttle (TOOL_CALL_REFRESH_MS, src/ui/chat.ts) sits at 120ms
// on top of this, so the WebView only re-parses roughly every other event.
const TOOL_CALL_EMIT_MS: u128 = 100;

// ── LLM stream cancellation (mirror of the CommandRegistry/kill_command
//    pattern: register a oneshot cancel channel under `requestId`, fire it
//    from cancel_chat_stream on Stop, and select on it in the read loop). ──

/// Register a chat_stream's cancel channel. Split out for testing. Empty ids
/// (legacy callers) skip registration — the stream still runs, uncancellable.
fn register_chat_cancel(
    registry: &ChatStreamRegistry,
    request_id: &str,
) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    if !request_id.is_empty() {
        if let Ok(mut reg) = registry.lock() {
            reg.insert(request_id.to_string(), tx);
        }
    }
    rx
}

/// Fire a registered stream's cancel channel. Returns whether a live stream
/// was found and signalled (no-op for finished or unknown ids).
fn cancel_chat_stream_inner(registry: &ChatStreamRegistry, request_id: &str) -> bool {
    let tx = match registry.lock() {
        Ok(mut reg) => reg.remove(request_id),
        Err(_) => return false,
    };
    match tx {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

/// Removes a chat_stream's registry entry when dropped — on EVERY exit path
/// (normal finish, error, cancel) — so stale ids never accumulate in the map
/// or fire a reused slot.
struct ChatCancelGuard {
    registry: ChatStreamRegistry,
    key: String,
}

impl Drop for ChatCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut reg) = self.registry.lock() {
            reg.remove(&self.key);
        }
    }
}

/// Abort an in-flight chat_stream call (the GUI calls this when the turn is
/// stopped). No-op when the id is unknown — the stream already finished or
/// was never registered.
#[tauri::command]
async fn cancel_chat_stream(
    state: tauri::State<'_, ChatStreamRegistry>,
    request_id: String,
) -> Result<bool, String> {
    Ok(cancel_chat_stream_inner(state.inner(), &request_id))
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    #[test]
    fn accepts_http_https_and_socks_proxy_schemes() {
        assert!(valid_proxy_url("http://127.0.0.1:7890"));
        assert!(valid_proxy_url("https://proxy.example:8443"));
        assert!(valid_proxy_url("socks5://127.0.0.1:1080"));
        assert!(valid_proxy_url("socks5h://127.0.0.1:1080"));
        assert!(!valid_proxy_url("ftp://127.0.0.1:21"));
    }

    #[test]
    fn injects_the_stored_proxy_password_after_the_username() {
        assert_eq!(
            inject_proxy_password("http://bob@127.0.0.1:7890", Some("p@ss")),
            "http://bob:p%40ss@127.0.0.1:7890/"
        );
        assert_eq!(
            inject_proxy_password("socks5://bob@127.0.0.1:1080", Some("secret")),
            "socks5://bob:secret@127.0.0.1:1080"
        );
    }

    #[test]
    fn leaves_the_proxy_url_untouched_without_username_or_password() {
        assert_eq!(
            inject_proxy_password("http://127.0.0.1:7890", Some("secret")),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            inject_proxy_password("http://bob@127.0.0.1:7890", None),
            "http://bob@127.0.0.1:7890"
        );
        assert_eq!(
            inject_proxy_password("http://bob@127.0.0.1:7890", Some("")),
            "http://bob@127.0.0.1:7890"
        );
        assert_eq!(
            inject_proxy_password("http://bob:old@127.0.0.1:7890", Some("new")),
            "http://bob:old@127.0.0.1:7890"
        );
    }

    #[test]
    fn provider_match_bypasses_llm_proxy() {
        let mut args = ChatStreamArgs {
            messages: Vec::new(),
            provider: "ollama".to_string(),
            tools: Vec::new(),
            model: "qwen2.5-coder:7b".to_string(),
            api_key: String::new(),
            base_url: String::new(),
            secret_key: String::new(),
            extra_body: None,
            max_tokens_override: None,
            temperature: None,
            request_id: String::new(),
            proxy_url: "socks5://127.0.0.1:1080".to_string(),
            proxy_bypass_providers: vec!["ollama".to_string()],
        };
        assert!(llm_proxy_url(&args).is_none());
        args.provider = "qwen".to_string();
        args.proxy_bypass_providers.clear();
        assert_eq!(llm_proxy_url(&args), Some("socks5://127.0.0.1:1080"));
    }

    #[test]
    fn splits_proxy_urls_into_scheme_host_port() {
        assert_eq!(
            split_proxy_url("http://127.0.0.1:7890"),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        assert_eq!(
            split_proxy_url("socks5://proxy.example.com:1080"),
            Some(("socks5://".into(), "proxy.example.com".into(), "1080".into()))
        );
        // Scheme-less shorthand defaults to http.
        assert_eq!(
            split_proxy_url("127.0.0.1:7890"),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        // Scheme-default port (https:443) is recovered from the raw authority.
        assert_eq!(
            split_proxy_url("https://proxy:443"),
            Some(("https://".into(), "proxy".into(), "443".into()))
        );
        assert_eq!(split_proxy_url("ftp://127.0.0.1:21"), None);
        assert_eq!(split_proxy_url(""), None);
    }

    #[test]
    fn parses_scutil_proxy_output() {
        let http_only = "HTTPEnable : 1\nHTTPPort : 7890\nHTTPProxy : 127.0.0.1\nHTTPSEnable : 0\nSOCKSEnable : 0\n";
        assert_eq!(
            parse_scutil_proxy(http_only),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        // The HTTPS-traffic proxy is preferred over the HTTP one when both
        // are enabled — but it still maps to an http:// scheme (it is an HTTP
        // CONNECT proxy, not a TLS proxy).
        let https_first = "HTTPSEnable : 1\nHTTPSPort : 7890\nHTTPSProxy : 127.0.0.1\nHTTPEnable : 1\nHTTPPort : 8080\nHTTPProxy : 10.0.0.1\n";
        assert_eq!(
            parse_scutil_proxy(https_first),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        assert_eq!(parse_scutil_proxy("HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n"), None);
    }

    #[test]
    fn parses_windows_proxy_server() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890"),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7890"),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:7890"),
            Some(("socks5://".into(), "127.0.0.1".into(), "7890".into()))
        );
        assert_eq!(
            split_host_port("[::1]:7890"),
            ("::1".to_string(), "7890".to_string())
        );
    }

    #[test]
    fn parses_windows_reg_query() {
        let enabled = "\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
        assert_eq!(
            parse_windows_reg_query(enabled),
            Some(("http://".into(), "127.0.0.1".into(), "7890".into()))
        );
        let disabled = "\n    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n";
        assert_eq!(parse_windows_reg_query(disabled), None);
    }
}

#[cfg(test)]
mod chat_cancel_tests {
    use super::*;

    #[tokio::test]
    async fn register_then_cancel_resolves_the_receiver_and_cleans_up() {
        let reg = ChatStreamRegistry::new(StdMutex::new(BTreeMap::new()));
        let rx = register_chat_cancel(&reg, "req-1");
        assert!(reg.lock().unwrap().contains_key("req-1"));
        assert!(
            cancel_chat_stream_inner(&reg, "req-1"),
            "a live stream must be cancellable"
        );
        assert!(
            rx.await.is_ok(),
            "cancel must resolve the stream's receiver"
        );
        assert!(
            reg.lock().unwrap().is_empty(),
            "the entry must be removed on cancel"
        );
    }

    #[tokio::test]
    async fn cancel_unknown_id_is_a_noop() {
        let reg = ChatStreamRegistry::new(StdMutex::new(BTreeMap::new()));
        assert!(!cancel_chat_stream_inner(&reg, "missing"));
    }

    #[test]
    fn guard_removes_the_entry_when_dropped() {
        let reg = ChatStreamRegistry::new(StdMutex::new(BTreeMap::new()));
        {
            let _rx = register_chat_cancel(&reg, "req-2");
            assert!(reg.lock().unwrap().contains_key("req-2"));
            let _guard = ChatCancelGuard {
                registry: reg.clone(),
                key: "req-2".to_string(),
            };
        }
        assert!(
            reg.lock().unwrap().is_empty(),
            "dropping the guard must unregister the entry"
        );
    }
}

// LLM streaming timeouts. reqwest's bare `Client::new()` applies NO total or
// read timeout — if the upstream stalls (server-side reasoning queue, flaky
// network, half-open connection) or never sends headers, `send()` /
// `bytes_stream()` block forever and the GUI sits frozen on the thinking
// card. Both bounds below are generous: a long reasoning generation streams
// chunks continuously, so every chunk resets the idle clock; the timeouts
// only fire on genuinely dead connections.
const LLM_REQUEST_TIMEOUT_SECS: u64 = 180;
const LLM_STREAM_IDLE_TIMEOUT_SECS: u64 = 180;

/// One line of the SSE stream, classified. Split out so the `[DONE]`
/// termination contract is unit-testable: `[DONE]` must terminate the READ
/// loop (not just the current line batch) — a connection the server keeps
/// open after the terminal frame would otherwise block the outer
/// `stream.next()` forever.
enum SseLine {
    NotData,
    Done,
    Data(serde_json::Value),
}

fn classify_sse_line(line: &str) -> SseLine {
    if !line.starts_with("data: ") {
        return SseLine::NotData;
    }
    let data = line[6..].trim();
    if data == "[DONE]" {
        return SseLine::Done;
    }
    match serde_json::from_str(data) {
        Ok(v) => SseLine::Data(v),
        Err(_) => SseLine::NotData,
    }
}

/// Pull one complete SSE line from a byte buffer without decoding partial
/// network chunks. UTF-8 characters may straddle reqwest byte chunks; decoding
/// each chunk independently turns those boundaries into U+FFFD replacement
/// characters before the JSON parser ever sees them.
fn take_sse_line(buffer: &mut Vec<u8>) -> Option<String> {
    let line_end = buffer.iter().position(|byte| *byte == b'\n')?;
    let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
    Some(String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned())
}

#[cfg(test)]
mod chat_stream_tests {
    use super::*;

    #[test]
    fn sse_done_terminates_the_read_loop() {
        // [DONE] — with and without surrounding whitespace — is the terminal
        // frame. The caller MUST break the outer read loop on it (labeled
        // break), never fall back into stream.next().
        assert!(matches!(classify_sse_line("data: [DONE]"), SseLine::Done));
        assert!(matches!(
            classify_sse_line("data:  [DONE]  "),
            SseLine::Done
        ));
    }

    #[test]
    fn sse_data_lines_parse_to_json() {
        match classify_sse_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#) {
            SseLine::Data(v) => assert_eq!(v["choices"][0]["delta"]["content"], "hi"),
            _ => panic!("expected Data"),
        }
    }

    #[test]
    fn sse_non_data_and_garbage_lines_are_ignored() {
        // Keep-alive comments, non-`data:` events, and malformed JSON all
        // fall through (old behavior: `continue` the line loop).
        assert!(matches!(
            classify_sse_line(": keep-alive"),
            SseLine::NotData
        ));
        assert!(matches!(
            classify_sse_line("event: message"),
            SseLine::NotData
        ));
        assert!(matches!(classify_sse_line(""), SseLine::NotData));
        assert!(matches!(
            classify_sse_line("data: not json {"),
            SseLine::NotData
        ));
    }

    #[test]
    fn sse_utf8_survives_network_chunk_boundaries() {
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"西安天气\"}}]}\n";
        let mut buffer = Vec::new();
        let mut lines = Vec::new();
        for byte in payload.as_bytes() {
            buffer.push(*byte);
            if let Some(line) = take_sse_line(&mut buffer) {
                lines.push(line);
            }
        }

        assert_eq!(lines.len(), 1);
        match classify_sse_line(&lines[0]) {
            SseLine::Data(value) => {
                assert_eq!(value["choices"][0]["delta"]["content"], "西安天气");
                assert!(!lines[0].contains('\u{FFFD}'));
            }
            _ => panic!("expected UTF-8 SSE data"),
        }
    }

    #[test]
    fn sse_line_buffer_keeps_incomplete_bytes_until_newline() {
        let mut buffer = "data: 西".as_bytes().to_vec();
        assert!(take_sse_line(&mut buffer).is_none());
        buffer.extend_from_slice("安\n".as_bytes());
        assert_eq!(take_sse_line(&mut buffer).as_deref(), Some("data: 西安"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_line_buffer_handles_crlf_empty_and_malformed_lines() {
        let mut buffer = b"data: {\"ok\":true}\r\n\n".to_vec();
        assert_eq!(
            take_sse_line(&mut buffer).as_deref(),
            Some("data: {\"ok\":true}\r")
        );
        assert_eq!(take_sse_line(&mut buffer).as_deref(), Some(""));
        assert!(buffer.is_empty());

        let mut malformed = b"data: ".to_vec();
        malformed.extend_from_slice(&[0xff, b'\n']);
        assert_eq!(
            take_sse_line(&mut malformed).as_deref(),
            Some("data: �")
        );
    }

    #[test]
    fn resolve_api_key_prefers_explicit_key() {
        let secrets = serde_json::json!({"llm.apiKey": "from-secrets"});
        assert_eq!(resolve_api_key(&secrets, "explicit", ""), "explicit");
        assert_eq!(
            resolve_api_key(&secrets, "explicit", "llm.apiKey.ollama"),
            "explicit"
        );
    }

    #[test]
    fn resolve_api_key_reads_default_and_named_secrets() {
        let secrets = serde_json::json!({
            "llm.apiKey": "main-key",
            "llm.apiKey.ollama": "ollama-key",
        });
        // Default key name when the caller doesn't specify one.
        assert_eq!(resolve_api_key(&secrets, "", ""), "main-key");
        // Custom providers look up their own named secret.
        assert_eq!(
            resolve_api_key(&secrets, "", "llm.apiKey.ollama"),
            "ollama-key"
        );
        // Missing named secret → empty (keyless local provider path).
        assert_eq!(resolve_api_key(&secrets, "", "llm.apiKey.missing"), "");
    }

    #[test]
    fn resolve_api_key_allows_keyless_providers() {
        // Empty secrets + empty args = no key, but NOT an error: the caller
        // simply omits the Authorization header (Ollama / LM Studio).
        let empty = serde_json::json!({});
        assert_eq!(resolve_api_key(&empty, "", "llm.apiKey.ollama"), "");
        assert_eq!(resolve_api_key(&empty, "", ""), "");
    }
}

/// Resolve the API key for a chat_stream call: an explicitly passed key wins;
/// otherwise read the named secret (default `llm.apiKey`, custom providers use
/// `llm.apiKey.<id>`). May return EMPTY — keyless local endpoints (Ollama /
/// LM Studio) intentionally send no Authorization header at all.
fn resolve_api_key(secrets: &serde_json::Value, arg_key: &str, secret_key: &str) -> String {
    if !arg_key.is_empty() {
        return arg_key.to_string();
    }
    let key_name = if secret_key.is_empty() {
        "llm.apiKey"
    } else {
        secret_key
    };
    secrets
        .get(key_name)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, ChatStreamRegistry>,
    args: ChatStreamArgs,
    on_chunk: Channel<String>,
) -> Result<serde_json::Value, String> {
    // The API key never travels through the WebView: when the frontend omits
    // it, resolve from the secrets store (~/.pure/secrets.json, 0600). Empty is
    // allowed for keyless local providers (Ollama / LM Studio) — the
    // Authorization header is simply omitted below.
    let secrets = load_secrets()?;
    let api_key = resolve_api_key(&secrets, &args.api_key, &args.secret_key);

    let base_url = if args.base_url.trim().is_empty() {
        "https://api.deepseek.com".to_string()
    } else {
        args.base_url.trim_end_matches('/').to_string()
    };
    let url = format!("{}/chat/completions", base_url);
    let client = build_http_client(
        std::time::Duration::from_secs(LLM_REQUEST_TIMEOUT_SECS),
        llm_proxy_url(&args),
    )?;
    let mut body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "max_tokens": args.max_tokens_override.unwrap_or(4096),
        "stream": true,
    });
    if let Some(temp) = args.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    if !args.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(args.tools);
        body["tool_choice"] = serde_json::json!("auto");
    }
    // Provider-specific extras (e.g. GLM's tool_stream: true) merge last so
    // they can override the base fields if needed.
    if let Some(extra) = args.extra_body {
        if let Some(extra_map) = extra.as_object() {
            if let Some(body_map) = body.as_object_mut() {
                for (k, v) in extra_map {
                    body_map.insert(k.clone(), v.clone());
                }
            }
        }
    }

    // Timeout the whole send: with `Client::new()` a server that accepts the
    // connection but never sends headers would block here forever. 180s covers
    // even long reasoning-model time-to-first-byte. Keyless providers
    // (Ollama / LM Studio) get NO Authorization header — some local servers
    // reject `Bearer ` with an empty token.
    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(LLM_REQUEST_TIMEOUT_SECS),
        request.send(),
    )
    .await
    .map_err(|_| {
        format!(
            "request timeout: the LLM API did not respond within {}s (network or server issue) — try the turn again.",
            LLM_REQUEST_TIMEOUT_SECS
        )
    })?
    .map_err(|e| format!("request: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "{} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            text
        ));
    }

    // Register the cancel channel for this call (Stop → cancel_chat_stream →
    // this receiver fires → the select! below aborts the read loop). The
    // guard removes the entry on ANY exit path — normal finish, error, or
    // cancel — so a stale id can never fire a reused slot.
    let request_id = args.request_id.clone();
    let reg = state.inner().clone();
    let mut cancel_rx = register_chat_cancel(&reg, &request_id);
    let _guard = ChatCancelGuard {
        registry: reg,
        key: request_id,
    };

    let mut stream = resp.bytes_stream();
    // Keep the SSE buffer as bytes until a full line is available. Decoding
    // each reqwest chunk separately corrupts UTF-8 when a Chinese character
    // is split across two network chunks.
    let mut buffer: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut usage: Option<serde_json::Value> = None;
    let mut tc_map: BTreeMap<u32, serde_json::Value> = BTreeMap::new();
    // Last time a tool-call delta was forwarded to the WebView (throttle
    // below). Streaming a giant argument (e.g. write_file `content`, a whole
    // HTML file) grows the accumulated buffer to tens of KB; forwarding it on
    // every token is O(n²) over the channel.
    let mut last_tool_emit = Instant::now();

    // SSE read loop with a labeled break: the idle timeout (every chunk
    // resets the clock) fails only on genuinely dead connections, and the
    // `[DONE]` terminal frame exits the OUTER loop — not just the inner line
    // loop. Falling back into `stream.next()` after [DONE] would hang forever
    // on endpoints that keep the connection open (previous bug: frozen GUI
    // thinking card, no visible answer).
    'stream: loop {
        // Select between the upstream stream (idle-timeout bounded) and the
        // cancel channel: a Stop click aborts the read immediately instead of
        // letting the abandoned task keep generating (and billing tokens)
        // until the idle timeout fires. `biased` prefers the cancel branch.
        let item = tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                return Err("cancelled".into());
            }
            next_chunk = tokio::time::timeout(
                std::time::Duration::from_secs(LLM_STREAM_IDLE_TIMEOUT_SECS),
                stream.next(),
            ) => {
                next_chunk.map_err(|_| {
                    format!(
                        "stream stalled: no data from the LLM API for {}s — the connection likely died. Try the turn again.",
                        LLM_STREAM_IDLE_TIMEOUT_SECS
                    )
                })?
            }
        };
        let Some(chunk_result) = item else { break };
        let chunk = chunk_result.map_err(|e| format!("stream: {}", e))?;
        buffer.extend_from_slice(&chunk);

        while let Some(line) = take_sse_line(&mut buffer) {

            let json = match classify_sse_line(&line) {
                SseLine::NotData => continue,
                SseLine::Done => break 'stream,
                SseLine::Data(v) => v,
            };

            // Provider billing usage arrives on the final chunk before [DONE]
            // (OpenAI-style `{"choices":[],"usage":{...}}`; DeepSeek adds
            // prompt_cache_hit_tokens / prompt_cache_miss_tokens). Must be
            // captured BEFORE the delta extraction below, which `continue`s on
            // chunks without a delta (the usage frame has none). Forwarded to
            // the WebView so the GUI can show per-session token totals, cache
            // hit rate, and cost; also returned in the result below.
            if let Some(u) = json.get("usage") {
                if u.is_object() {
                    usage = Some(u.clone());
                    let chunk = serde_json::json!({ "type": "usage", "usage": u });
                    if on_chunk.send(chunk.to_string()).is_err() {
                        return Err("cancelled".into());
                    }
                }
            }

            let delta = match json["choices"][0]["delta"].as_object() {
                Some(d) => d.clone(),
                None => continue,
            };

            // Emit content delta
            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                text.push_str(content);
                let chunk = serde_json::json!({ "type": "delta", "content": content });
                if on_chunk.send(chunk.to_string()).is_err() {
                    return Err("cancelled".into());
                }
            }

            // Emit reasoning deltas separately from content so the GUI can
            // render a live "thinking" card. DeepSeek/Qwen/GLM stream
            // `reasoning_content`; OpenAI-style responses use `reasoning`
            // (string, or an object with a text-part `content` array). The
            // reasoning text is intentionally NOT appended to `text`, so it
            // never leaks into the final answer or persisted messages.
            let reasoning = delta
                .get("reasoning_content")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .or_else(|| match delta.get("reasoning") {
                    Some(r) => {
                        if let Some(s) = r.as_str() {
                            Some(s.to_string())
                        } else if let Some(parts) = r.get("content").and_then(|c| c.as_array()) {
                            let mut acc = String::new();
                            for p in parts {
                                if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                                    acc.push_str(t);
                                }
                            }
                            if acc.is_empty() {
                                None
                            } else {
                                Some(acc)
                            }
                        } else {
                            None
                        }
                    }
                    None => None,
                });
            if let Some(rc) = reasoning {
                let chunk = serde_json::json!({ "type": "reasoning", "content": rc });
                if on_chunk.send(chunk.to_string()).is_err() {
                    return Err("cancelled".into());
                }
            }

            // Accumulate tool_calls, forwarding throttled argument deltas so
            // the GUI shows the tool row growing live instead of sitting
            // silent while a giant argument (write_file `content`) is
            // generated — otherwise the UI only learns about the call when the
            // entire stream finishes, which reads as a frozen app. The final
            // id + full args still arrive via the returned result below.
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    let idx = tc["index"].as_u64().unwrap_or(0) as u32;
                    let cur = tc_map.entry(idx).or_insert_with(
                        || serde_json::json!({"id": "", "name": "", "arguments": ""}),
                    );
                    // Only forward when this delta actually added something
                    // (name, or appended arguments) — a delta that merely
                    // carries the id must not re-send an identical buffer.
                    let mut updated = false;
                    if let Some(id) = tc["id"].as_str() {
                        cur["id"] = serde_json::Value::String(id.to_string());
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        cur["name"] = serde_json::Value::String(name.to_string());
                        updated = true;
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        cur["arguments"] = serde_json::Value::String(format!(
                            "{}{}",
                            cur["arguments"].as_str().unwrap_or(""),
                            args
                        ));
                        updated = true;
                    }
                    if updated
                        && !cur["name"].as_str().map_or(true, |n| n.is_empty())
                        && last_tool_emit.elapsed().as_millis() >= TOOL_CALL_EMIT_MS
                    {
                        last_tool_emit = Instant::now();
                        let chunk = serde_json::json!({
                            "type": "tool_call_delta",
                            "index": idx,
                            "name": cur["name"].as_str().unwrap_or(""),
                            "arguments": cur["arguments"].as_str().unwrap_or(""),
                        });
                        if on_chunk.send(chunk.to_string()).is_err() {
                            return Err("cancelled".into());
                        }
                    }
                }
            }
        }
    }

    // Build tool_calls list
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    for (_, tc) in tc_map.iter() {
        if tc["name"].as_str().map_or(false, |n| !n.is_empty()) {
            tool_calls.push(serde_json::json!({
                "id": tc["id"],
                "function": {
                    "name": tc["name"],
                    "arguments": tc["arguments"],
                }
            }));
        }
    }

    Ok(serde_json::json!({ "text": text, "toolCalls": tool_calls, "usage": usage }))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Image Generation (OpenAI-compatible /images/generations)
// ═══════════════════════════════════════════════════════════════════════════════
// The GUI's generate_image tool (see IMAGE_GEN_TOOL_DEF in shared/toolDefs.ts)
// calls this command when the connected provider advertises text-to-image
// support. The API key is resolved from the secrets store like chat_stream — it
// never travels through the WebView. Images are returned as base64 data URLs to
// the frontend (which renders them as <img> cards); only compact metadata is
// ever fed back into the LLM context.

const IMAGE_GEN_TIMEOUT_SECS: u64 = 120;

#[derive(Deserialize)]
struct GenerateImageArgs {
    #[serde(default)]
    provider: String,
    model: String,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "baseUrl")]
    base_url: String,
    #[serde(default, rename = "secretKey")]
    secret_key: String,
    prompt: String,
    #[serde(default)]
    n: Option<u32>,
    #[serde(default)]
    size: String,
    #[serde(default, rename = "proxyUrl")]
    proxy_url: String,
    #[serde(default, rename = "proxyBypassProviders")]
    proxy_bypass_providers: Vec<String>,
}

fn image_proxy_url(args: &GenerateImageArgs) -> Option<&str> {
    if args.proxy_url.trim().is_empty()
        || proxy_matches(&args.provider, &args.proxy_bypass_providers)
    {
        None
    } else {
        Some(args.proxy_url.trim())
    }
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        "image/png"
    }
}

/// Generate images via the provider's OpenAI-compatible `/images/generations`
/// endpoint and return base64 data URLs for the UI. Mirror of chat_stream's
/// key resolution + proxy handling; the raw payload never enters the LLM
/// context (the frontend keeps it out of ToolResult.result).
#[tauri::command]
async fn generate_image(args: GenerateImageArgs) -> Result<serde_json::Value, String> {
    let prompt = args.prompt.trim();
    if prompt.is_empty() {
        return Err("generate_image: prompt is required".to_string());
    }
    let n = args.n.unwrap_or(1).clamp(1, 4);

    let secrets = load_secrets()?;
    let api_key = resolve_api_key(&secrets, &args.api_key, &args.secret_key);

    let base_url = if args.base_url.trim().is_empty() {
        "https://api.openai.com/v1".to_string()
    } else {
        args.base_url.trim_end_matches('/').to_string()
    };
    let url = format!("{}/images/generations", base_url);
    let client = build_http_client(
        std::time::Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS),
        image_proxy_url(&args),
    )?;

    // dall-e-2/3 accept response_format: b64_json; gpt-image-1 REJECTS it
    // (400) and returns base64 by default — so the field is only sent for
    // legacy models. Providers that answer with a URL are still handled below
    // (the frontend renders the https URL as the <img> src).
    let is_gpt_image = args.model.trim().to_ascii_lowercase().starts_with("gpt-image");
    let mut body = serde_json::json!({ "model": args.model, "prompt": prompt, "n": n });
    if !is_gpt_image {
        body["response_format"] = serde_json::json!("b64_json");
    }
    if !args.size.trim().is_empty() {
        body["size"] = serde_json::json!(args.size.trim());
    }

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(IMAGE_GEN_TIMEOUT_SECS),
        request.send(),
    )
    .await
    .map_err(|_| {
        format!(
            "generate_image: the image API did not respond within {}s (network or server issue) — try again or fall back to SVG.",
            IMAGE_GEN_TIMEOUT_SECS
        )
    })?
    .map_err(|e| format!("generate_image: request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "generate_image: HTTP {} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            text
        ));
    }
    let payload: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("generate_image: parse response: {}", e))?;

    let items = payload["data"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return Err("generate_image: the image API returned no images".to_string());
    }

    let mut images: Vec<serde_json::Value> = Vec::new();
    for item in items {
        let mime_hint = item
            .get("mime_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mime = mime_hint.unwrap_or_else(|| sniff_image_mime(&bytes).to_string());
            images.push(serde_json::json!({
                "dataUrl": format!("data:{};base64,{}", mime, b64),
                "mimeType": mime,
                "sizeBytes": bytes.len(),
            }));
        } else if let Some(url) = item.get("url").and_then(|v| v.as_str()) {
            let mime = mime_hint.unwrap_or_else(|| "image/png".to_string());
            images.push(serde_json::json!({ "dataUrl": url, "mimeType": mime, "sizeBytes": 0 }));
        }
    }
    if images.is_empty() {
        return Err("generate_image: the image API returned no usable images".to_string());
    }
    Ok(serde_json::json!({ "images": images }))
}

#[cfg(test)]
mod generate_image_tests {
    use super::*;

    #[test]
    fn sniff_detects_png_jpeg_gif_webp() {
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n...."), "image/png");
        assert_eq!(sniff_image_mime(b"\xff\xd8\xff\xe0...."), "image/jpeg");
        assert_eq!(sniff_image_mime(b"GIF89a...."), "image/gif");
        assert_eq!(sniff_image_mime(b"RIFF....WEBP...."), "image/webp");
        assert_eq!(sniff_image_mime(b"not an image"), "image/png");
    }

    #[test]
    fn proxy_bypass_matches_provider() {
        let args = GenerateImageArgs {
            provider: "openai".to_string(),
            model: "gpt-image-1".to_string(),
            api_key: String::new(),
            base_url: String::new(),
            secret_key: String::new(),
            prompt: "a puppy".to_string(),
            n: Some(1),
            size: String::new(),
            proxy_url: "socks5://127.0.0.1:1080".to_string(),
            proxy_bypass_providers: vec!["openai".to_string()],
        };
        assert!(image_proxy_url(&args).is_none());
        let args2 = GenerateImageArgs { proxy_bypass_providers: Vec::new(), ..args };
        assert_eq!(image_proxy_url(&args2), Some("socks5://127.0.0.1:1080"));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Session Persistence (~/.pure/sessions/)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
struct SessionData {
    #[serde(default)]
    messages: Vec<serde_json::Value>,
    #[serde(default)]
    snapshot: Option<serde_json::Value>,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    #[serde(rename = "messageCount")]
    message_count: usize,
    // Per-session user workspace override (empty = use the application tmp
    // workspace for this session). Serde default keeps older session.json files
    // readable until they are next saved.
    #[serde(default)]
    workspace: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct SessionMeta {
    id: String,
    title: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    #[serde(rename = "messageCount")]
    message_count: usize,
    #[serde(default)]
    workspace: String,
}

fn sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pure").join("sessions")
}

fn workspace_override_path(session_id: &str) -> PathBuf {
    sessions_dir().join(session_id).join("workspace.txt")
}

fn write_workspace_override(session_id: &str, workspace: &str) -> Result<(), String> {
    fs::write(workspace_override_path(session_id), workspace)
        .map_err(|e| format!("write workspace: {}", e))
}

#[tauri::command]
fn save_session(
    session_id: String,
    snapshot: serde_json::Value,
    workspace: Option<String>,
) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Frontend always sends the current session workspace; older callers omit
    // it, in which case we preserve the previously stored override (if any).
    let workspace = match workspace {
        Some(w) => w,
        None => load_session_workspace(&session_id).unwrap_or_default(),
    };

    let messages = snapshot
        .get("modelContext")
        .and_then(|context| context.get("messages"))
        .and_then(|messages| messages.as_array())
        .cloned()
        .unwrap_or_default();
    let data = SessionData {
        message_count: messages.len(),
        updated_at: now,
        workspace: workspace.clone(),
        messages,
        snapshot: Some(snapshot),
    };

    let data_path = dir.join("session.json");
    fs::write(
        &data_path,
        serde_json::to_string_pretty(&data).unwrap_or_default(),
    )
    .map_err(|e| format!("write: {}", e))?;
    // Keep the mutable workspace override in a tiny sidecar as well. Changing
    // folders should not require the picker path to rewrite this potentially
    // very large session.json, while older sessions remain readable through
    // the embedded field below. Do not overwrite an existing sidecar: a
    // workspace selection can be persisted concurrently with a turn that was
    // already in flight, and the newer user choice must win.
    let override_path = workspace_override_path(&session_id);
    if !override_path.exists() {
        write_workspace_override(&session_id, &workspace)?;
    }
    let effective_workspace = load_session_workspace(&session_id).unwrap_or(workspace);

    let title = extract_title(&data.messages);
    update_sessions_index(&session_id, &title, data.message_count, now, effective_workspace)?;

    Ok(())
}

#[tauri::command]
fn load_session(session_id: String) -> Result<Option<serde_json::Value>, String> {
    let path = sessions_dir().join(&session_id).join("session.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let data: SessionData = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let snapshot = data.snapshot.unwrap_or_else(|| serde_json::json!({
        "version": 1,
        "messages": data.messages,
    }));
    let workspace = load_session_workspace(&session_id).unwrap_or_else(|_| data.workspace.clone());
    Ok(Some(serde_json::json!({
        "sessionId": session_id,
        "snapshot": snapshot,
        "updatedAt": data.updated_at,
        "messageCount": data.message_count,
        "workspace": workspace,
    })))
}

/// Read the stored workspace override for a session ("" when absent).
fn load_session_workspace(session_id: &str) -> Result<String, String> {
    let override_path = workspace_override_path(session_id);
    if override_path.exists() {
        return fs::read_to_string(override_path).map_err(|e| format!("read workspace: {}", e));
    }
    let path = sessions_dir().join(session_id).join("session.json");
    if !path.exists() {
        return Ok(String::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let data: SessionData = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    Ok(data.workspace)
}

// ── Per-session usage stats (~/.pure/sessions/<id>/stats.json) ──
// Written by the right panel's 统计 tab. Lives INSIDE the session directory so
// delete_session / delete_all_sessions clean it up together with session.json.
// The frontend keeps an in-memory mirror for synchronous reads; these commands
// are the durable backing store (the browser-localStorage path is only used in
// plain Vite dev where there is no filesystem).

#[tauri::command]
fn save_session_stats(session_id: String, stats: serde_json::Value) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    let path = dir.join("stats.json");
    fs::write(
        &path,
        serde_json::to_string_pretty(&stats).unwrap_or_default(),
    )
    .map_err(|e| format!("write: {}", e))
}

#[tauri::command]
fn load_session_stats(session_id: String) -> Result<Option<serde_json::Value>, String> {
    let path = sessions_dir().join(&session_id).join("stats.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse: {}", e))
}

/// Bulk-load the stats of every session in one IPC round-trip (the session
/// sidebar shows a per-session token/cost summary line and would otherwise do
/// one invoke per row). Returns { sessionId: stats } for sessions that have a
/// stats.json; sessions without one are simply absent from the map.
///
/// `session_ids` optionally narrows the read to a specific set of sessions:
/// the sidebar only displays the 30 most recent ones, so passing its visible
/// ids avoids stat-ing + reading every session's stats.json on every refresh
/// (hundreds of files on a long-lived install). None = the full sweep (the
/// "export all as ZIP" path needs every session).
#[tauri::command]
fn load_all_session_stats(session_ids: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    let dir = sessions_dir();
    let mut out = serde_json::Map::new();
    if !dir.exists() {
        return Ok(serde_json::Value::Object(out));
    }
    let wanted: Option<std::collections::HashSet<String>> =
        session_ids.map(|ids| ids.into_iter().collect());
    for entry in fs::read_dir(&dir).map_err(|e| format!("read dir: {}", e))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_id = entry.file_name().to_string_lossy().to_string();
        if let Some(wanted) = &wanted {
            if !wanted.contains(&session_id) {
                continue;
            }
        }
        let stats_path = entry.path().join("stats.json");
        if !stats_path.exists() {
            continue;
        }
        let raw = match fs::read_to_string(&stats_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            out.insert(session_id, v);
        }
    }
    Ok(serde_json::Value::Object(out))
}

#[tauri::command]
fn load_last_session() -> Result<Option<serde_json::Value>, String> {
    let index_path = sessions_dir().join("index.json");
    if !index_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&index_path).map_err(|e| format!("read: {}", e))?;
    let list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
    let latest = list.iter().max_by_key(|s| s.updated_at);
    match latest {
        Some(s) => load_session(s.id.clone()),
        None => Ok(None),
    }
}

#[tauri::command]
fn load_session_list() -> Result<Vec<serde_json::Value>, String> {
    let index_path = sessions_dir().join("index.json");
    if !index_path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&index_path).map_err(|e| format!("read: {}", e))?;
    let list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "title": s.title,
                "createdAt": s.created_at,
                "updatedAt": s.updated_at,
                "messageCount": s.message_count,
                "workspace": s.workspace,
            })
        })
        .collect())
}

/// Update ONLY the workspace override of an already-saved session (used when
/// the user edits the workspace chip without sending a new message, so the
/// change survives an app restart). The mutable value lives in a small sidecar
/// instead of rewriting the complete session snapshot. No-op when the session
/// has never been persisted; its workspace is captured on first save_session.
#[tauri::command]
async fn save_session_workspace(session_id: String, workspace: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_session_workspace_sync(&session_id, &workspace))
        .await
        .map_err(|e| format!("workspace save task failed: {}", e))??;
    Ok(())
}

fn save_session_workspace_sync(session_id: &str, workspace: &str) -> Result<(), String> {
    let dir = sessions_dir().join(session_id);
    let data_path = dir.join("session.json");
    if data_path.exists() {
        // The sidecar is authoritative for this mutable field. Avoid reading,
        // parsing and rewriting the complete session snapshot on every folder
        // selection; long conversations can make that file several megabytes.
        write_workspace_override(session_id, workspace)?;
    }

    let index_path = sessions_dir().join("index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        let mut list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
        if let Some(meta) = list.iter_mut().find(|s| s.id == session_id) {
            meta.workspace = workspace.to_string();
        }
        fs::write(
            &index_path,
            serde_json::to_string_pretty(&list).unwrap_or_default(),
        )
        .map_err(|e| format!("write: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_session(session_id: String) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove: {}", e))?;
    }
    let tmp_dir = application_tmp_dir().join(safe_session_component(&session_id));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).map_err(|e| format!("remove tmp workspace: {}", e))?;
    }
    let index_path = sessions_dir().join("index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        let mut list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
        list.retain(|s| s.id != session_id);
        fs::write(
            &index_path,
            serde_json::to_string_pretty(&list).unwrap_or_default(),
        )
        .map_err(|e| format!("write: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_all_sessions() -> Result<(), String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(());
    }

    let index_path = dir.join("index.json");
    let session_ids: Vec<String> = if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        serde_json::from_str::<Vec<SessionMeta>>(&raw)
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.id)
            .collect()
    } else {
        vec![]
    };

    for entry in fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("remove: {}", e))?;
        }
    }
    fs::write(&index_path, "[]").map_err(|e| format!("write: {}", e))?;

    // Remove only temp workspaces belonging to persisted sessions. Do not
    // recursively delete the whole tmp root: an active or unsaved session may
    // still be using another temporary directory.
    for session_id in session_ids {
        let tmp_dir = application_tmp_dir().join(safe_session_component(&session_id));
        if tmp_dir.exists() {
            fs::remove_dir_all(&tmp_dir).map_err(|e| format!("remove tmp workspace: {}", e))?;
        }
    }
    Ok(())
}

fn extract_title(messages: &[serde_json::Value]) -> String {
    for m in messages {
        if m.get("role").and_then(|r| r.as_str()) == Some("user") {
            if let Some(content) = m.get("content").and_then(|c| c.as_str()) {
                let title: String = content.chars().take(60).collect();
                return if title.len() < content.len() {
                    format!("{}…", title)
                } else {
                    title
                };
            }
        }
    }
    "New chat".to_string()
}

fn update_sessions_index(
    session_id: &str,
    title: &str,
    message_count: usize,
    updated_at: u64,
    workspace: String,
) -> Result<(), String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;

    let index_path = dir.join("index.json");
    let mut list: Vec<SessionMeta> = if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        vec![]
    };

    let existing = list.iter().position(|s| s.id == session_id);
    let meta = SessionMeta {
        id: session_id.to_string(),
        title: title.to_string(),
        created_at: existing.map(|i| list[i].created_at).unwrap_or(updated_at),
        updated_at,
        message_count,
        workspace,
    };

    if let Some(i) = existing {
        list[i] = meta;
    } else {
        list.push(meta);
    }

    fs::write(
        &index_path,
        serde_json::to_string_pretty(&list).unwrap_or_default(),
    )
    .map_err(|e| format!("write: {}", e))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  System Info
// ═══════════════════════════════════════════════════════════════════════════════

/// IP-based city geolocation for the Environment section of Settings. No API
/// key, no system permission, city-level accuracy — good enough as the
/// location baseline for tasks like trip planning ("from where I am").
///
/// Backends are probed IN ORDER and the first with a usable city wins, the
/// same degrade-instead-of-fail pattern as web_search: ipapi.co (which returns
/// Chinese names via ?lang=zh) is Cloudflare-gated from many networks, so it
/// is deliberately NOT first. Order: ipwho.is (HTTPS, no key, no challenge) →
/// ipinfo.io (HTTPS fallback) → ip-api.com (Chinese names; HTTP only, so the
/// browser dev fallback skips it).
/// Flatten a reqwest error's cause chain into one readable line. The Display
/// of a request error is just "error sending request for url (…)" — the real
/// reason (connection refused, DNS failure, timeout) lives in the source
/// chain, so surface it instead of leaving the user guessing.
fn reqwest_error_detail(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(cause) = current {
        let msg = cause.to_string();
        if !msg.is_empty() && parts.last() != Some(&msg) {
            parts.push(msg);
        }
        current = cause.source();
    }
    parts.join(": ")
}

/// Probe endpoint used to verify a proxy forwards requests. Baidu is chosen
/// because it is reachable from mainland China (google.com/generate_204 is
/// not), so the connectivity test stays meaningful for users on a China
/// network and for proxies that only route domestic traffic.
const PROXY_PROBE_URL: &str = "https://www.baidu.com/";

/// Default connectivity-test endpoints for 测试连接, in probe order. The WebView
/// sends the user-edited list (Settings → 网络代理), so this is only the
/// fallback when the passed list is empty (defensive — the UI blocks this).
const DEFAULT_PROXY_PROBES: &[&str] = &[
    PROXY_PROBE_URL,
    "https://api.deepseek.com",
    "https://ipwho.is/",
];

/// Connectivity check for the proxy config (Settings → 网络代理 → 测试连接).
/// Builds the exact client the LLM / tool paths use and probes the configured
/// endpoints through it — a malformed URL (bad scheme) or a dead proxy is
/// caught HERE instead of silently failing every subsequent request. Returns
/// the first reachable endpoint + latency, or the aggregated failure reasons.
#[tauri::command]
async fn test_proxy(proxy_url: String, probe_urls: Vec<String>) -> Result<String, String> {
    let client = match build_http_client(std::time::Duration::from_secs(6), Some(&proxy_url)) {
        Ok(c) => c,
        Err(e) => return Err(format!("proxy config invalid: {}", e)),
    };
    let mut probes: Vec<String> = probe_urls
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if probes.is_empty() {
        probes = DEFAULT_PROXY_PROBES.iter().map(|s| s.to_string()).collect();
    }
    let mut failed: Vec<String> = Vec::new();
    for url in &probes {
        let start = Instant::now();
        let status = match client.get(url.as_str()).header("User-Agent", BROWSER_UA).send().await {
            Ok(r) => r.status(),
            Err(e) => {
                failed.push(format!("{url}: {}", reqwest_error_detail(&e)));
                continue;
            }
        };
        if status.is_success() || status == reqwest::StatusCode::NO_CONTENT {
            return Ok(format!("{url} ({}ms)", start.elapsed().as_millis()));
        }
        failed.push(format!("{url}: HTTP {status}"));
    }
    Err(format!("all probes failed through the proxy: {}", failed.join(" | ")))
}

// ── System proxy detection (Settings → 网络代理 → 读取系统代理) ──
// Reads the OS-level proxy (macOS scutil / Windows reg) or the standard proxy
// environment variables, then maps the result onto the settings form's
// scheme/host/port triple so the user never has to hand-type the address when
// Clash / a VPN / a corporate proxy is already active. `source` is a stable
// code (`macos` | `windows` | `env`) the UI localizes; `detail` carries the
// env-var name when the value came from the environment.

#[derive(serde::Serialize)]
struct DetectedProxy {
    scheme: String,
    host: String,
    port: String,
    source: String,
    detail: String,
}

/// Split a proxy URL into the form's (scheme, host, port) fields. Accepts the
/// full `scheme://host:port` form and the scheme-less `host:port` shorthand
/// (assumed http), and recovers a scheme-default port that URL normalization
/// drops (https:443). Returns None for unsupported schemes or an empty host.
fn split_proxy_url(url: &str) -> Option<(String, String, String)> {
    let raw = url.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    let scheme = match parsed.scheme() {
        "http" => "http://",
        "https" => "https://",
        "socks5" => "socks5://",
        "socks5h" => "socks5h://",
        "socks" | "socks4" => "socks5://",
        _ => return None,
    };
    let host = parsed.host_str()?.to_string();
    if host.is_empty() {
        return None;
    }
    let mut port = parsed.port().map(|p| p.to_string()).unwrap_or_default();
    if port.is_empty() {
        // URL normalization drops a scheme-default port; recover it from the
        // raw authority (the last colon of the userinfo-less authority).
        let authority = candidate
            .split("://")
            .nth(1)
            .unwrap_or(&candidate)
            .split(|c: char| matches!(c, '/' | '?' | '#'))
            .next()
            .unwrap_or("");
        if let Some(idx) = authority.rfind(':') {
            let tail = &authority[idx + 1..];
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                port = tail.to_string();
            }
        }
    }
    Some((scheme.to_string(), host, port))
}

/// Parse `scutil --proxy` output (macOS) into a (scheme, host, port) triple.
/// Prefers HTTPS, then HTTP, then SOCKS — the order most proxy tools populate.
/// NOTE: `HTTPSProxy` means "proxy for HTTPS traffic", not "a TLS proxy" —
/// the endpoint still speaks plain HTTP (CONNECT tunneling), so it maps to
/// `http://`, never `https://`. Only the SOCKS fields map to a real SOCKS
/// scheme.
#[cfg(any(target_os = "macos", test))]
fn parse_scutil_proxy(output: &str) -> Option<(String, String, String)> {
    fn key_value<'a>(output: &'a str, key: &str) -> Option<&'a str> {
        output.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            (k.trim() == key).then(|| v.trim())
        })
    }
    for (enable_key, proxy_key, port_key, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http://"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http://"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5://"),
    ] {
        if key_value(output, enable_key) != Some("1") {
            continue;
        }
        let host = key_value(output, proxy_key).unwrap_or("").trim();
        if host.is_empty() {
            continue;
        }
        let port = key_value(output, port_key).unwrap_or("").to_string();
        return Some((scheme.to_string(), host.to_string(), port));
    }
    None
}

/// Parse a Windows `ProxyServer` value (`reg query`) into (scheme, host, port).
/// Accepts a bare `host:port`, per-scheme `http=…;https=…;socks=…`, and IPv6
/// bracket hosts. Explicit per-scheme entries win; the bare default maps to http.
/// NOTE: `https=` means "proxy for HTTPS traffic", not a TLS proxy — it still
/// speaks HTTP, so it maps to `http://` like the `http=` entry.
#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy_server(value: &str) -> Option<(String, String, String)> {
    let entries: Vec<&str> = value.split(';').map(str::trim).filter(|s| !s.is_empty()).collect();
    for (want, scheme) in [
        ("https", "http://"),
        ("http", "http://"),
        ("socks5", "socks5://"),
        ("socks", "socks5://"),
    ] {
        let addr = entries.iter().find_map(|e| {
            let (s, a) = e.split_once('=')?;
            (s.trim() == want).then(|| a.trim())
        });
        if let Some(addr) = addr {
            let (host, port) = split_host_port(addr);
            return Some((scheme.to_string(), host, port));
        }
    }
    let bare = entries.iter().find(|e| !e.contains('='))?;
    let (host, port) = split_host_port(bare);
    Some(("http://".to_string(), host, port))
}

/// Split `host:port` (or IPv6 `[host]:port`) into its two parts.
#[cfg(any(target_os = "windows", test))]
fn split_host_port(addr: &str) -> (String, String) {
    let addr = addr.trim();
    if let Some(rest) = addr.strip_prefix('[') {
        if let Some(idx) = rest.find(']') {
            return (rest[..idx].to_string(), rest[idx + 1..].trim_start_matches(':').to_string());
        }
    }
    match addr.rfind(':') {
        Some(idx) => (addr[..idx].to_string(), addr[idx + 1..].to_string()),
        None => (addr.to_string(), String::new()),
    }
}

/// Parse `reg query "HKCU\...\Internet Settings"` output (Windows) into
/// (scheme, host, port). Returns None when the proxy is disabled or unset.
#[cfg(any(target_os = "windows", test))]
fn parse_windows_reg_query(output: &str) -> Option<(String, String, String)> {
    let enabled = output
        .lines()
        .any(|l| l.contains("ProxyEnable") && l.trim_end().ends_with("0x1"));
    if !enabled {
        return None;
    }
    let value = output
        .lines()
        .find(|l| l.contains("ProxyServer"))?
        .split("REG_SZ")
        .nth(1)?
        .trim();
    parse_windows_proxy_server(value)
}

/// Read a proxy from the standard environment variables (HTTPS_PROXY /
/// HTTP_PROXY / ALL_PROXY, plus lowercase variants). Returns the resolved
/// triple and the variable name it came from.
fn env_proxy() -> Option<(String, String, String, String)> {
    for name in [
        "HTTPS_PROXY", "https_proxy",
        "HTTP_PROXY", "http_proxy",
        "ALL_PROXY", "all_proxy",
    ] {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if let Some((scheme, host, port)) = split_proxy_url(value) {
            return Some((scheme, host, port, name.to_string()));
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn detect_macos_proxy() -> Option<(String, String, String, &'static str)> {
    let out = silent_child(std::process::Command::new("scutil"))
        .args(["--proxy"])
        .output()
        .ok()?;
    parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout))
        .map(|(s, h, p)| (s, h, p, "macos"))
}

#[cfg(target_os = "windows")]
fn detect_windows_proxy() -> Option<(String, String, String, &'static str)> {
    let out = silent_child(std::process::Command::new("reg"))
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"])
        .output()
        .ok()?;
    parse_windows_reg_query(&String::from_utf8_lossy(&out.stdout))
        .map(|(s, h, p)| (s, h, p, "windows"))
}

/// Candidate loopback ports for common local proxy tools (Clash / V2Ray /
/// Shadowsocks / Squid / Privoxy). Ordered by likelihood so the ubiquitous
/// Clash mixed port wins immediately. The list is deliberately short — this
/// fallback only runs when the OS system proxy AND env vars are both unset.
const LOCAL_PROXY_PORTS: &[u16] = &[7897, 7890, 7891, 7893, 1080, 10808, 10809, 8118, 8888, 3128];

/// Fallback detection for when the system proxy is off but a local proxy tool
/// is still running (Clash without "设为系统代理"). First checks which loopback
/// ports are listening (fast TCP connect), then verifies each open port really
/// forwards a request — trying HTTP then SOCKS5 — so a random service on the
/// port is never mistaken for a proxy. Returns (scheme, host, port).
async fn probe_local_proxy() -> Option<(String, String, String)> {
    let open: Vec<u16> = {
        let checks = LOCAL_PROXY_PORTS.iter().map(|&port| async move {
            let addr = format!("127.0.0.1:{port}");
            match tokio::time::timeout(
                std::time::Duration::from_millis(250),
                tokio::net::TcpStream::connect(&addr),
            )
            .await
            {
                Ok(Ok(_)) => Some(port),
                _ => None,
            }
        });
        futures_util::future::join_all(checks)
            .await
            .into_iter()
            .flatten()
            .collect()
    };
    for port in open {
        let host = "127.0.0.1".to_string();
        let port_str = port.to_string();
        for scheme in ["http://", "socks5://"] {
            let url = format!("{scheme}{host}:{port}");
            let Ok(client) = build_http_client(std::time::Duration::from_secs(2), Some(&url)) else {
                continue;
            };
            // A proxy that accepts and forwards the request replies with SOME
            // status (even 4xx/5xx); a non-proxy service can't complete the
            // proxy handshake, so `send()` errors. `is_ok()` is the signal.
            if client
                .get(PROXY_PROBE_URL)
                .header("User-Agent", BROWSER_UA)
                .send()
                .await
                .is_ok()
            {
                return Some((scheme.to_string(), host, port_str));
            }
        }
    }
    None
}

/// Detect the OS-level system proxy, then the standard proxy environment
/// variables, then — as a last resort — probe common local proxy ports (so a
/// Clash / V2Ray instance works even with "设为系统代理" off). Returns the
/// result split into the settings form's scheme/host/port fields; `Ok(None)`
/// means nothing was found. Desktop-only: browser JS cannot read the OS proxy.
#[tauri::command]
async fn detect_system_proxy() -> Result<Option<DetectedProxy>, String> {
    #[cfg(target_os = "macos")]
    let os_proxy = detect_macos_proxy();
    #[cfg(target_os = "windows")]
    let os_proxy = detect_windows_proxy();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let os_proxy: Option<(String, String, String, &'static str)> = None;

    if let Some((scheme, host, port, source)) = os_proxy {
        return Ok(Some(DetectedProxy {
            scheme,
            host,
            port,
            source: source.to_string(),
            detail: String::new(),
        }));
    }
    if let Some((scheme, host, port, name)) = env_proxy() {
        return Ok(Some(DetectedProxy {
            scheme,
            host,
            port,
            source: "env".to_string(),
            detail: name,
        }));
    }
    if let Some((scheme, host, port)) = probe_local_proxy().await {
        let detail = format!("{host}:{port}");
        return Ok(Some(DetectedProxy {
            scheme,
            host,
            port,
            source: "local".to_string(),
            detail,
        }));
    }
    Ok(None)
}

#[tauri::command]
async fn detect_location(proxy_url: Option<String>) -> Result<String, String> {
    let backends: &[&str] = &[
        "https://ipwho.is/",
        "https://ipinfo.io/json",
        "http://ip-api.com/json/?lang=zh-CN",
    ];
    let mut failed: Vec<String> = Vec::new();
    for url in backends {
        let client = match build_http_client(std::time::Duration::from_secs(8), proxy_url.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                failed.push(format!("{}: client: {}", url, e));
                continue;
            }
        };
        let body: serde_json::Value = match client
            .get(*url)
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    failed.push(format!("{}: read: {}", url, e));
                    continue;
                }
            },
            Ok(r) => {
                failed.push(format!("{}: HTTP {}", url, r.status()));
                continue;
            }
            Err(e) => {
                failed.push(format!("{}: request: {}", url, e));
                continue;
            }
        };
        // Normalize per-backend key differences (ipwho.is/ipinfo: city/region/
        // country; ip-api: city/regionName/country) and reject placeholder
        // "unknown" values.
        let get = |keys: &[&str]| -> Option<String> {
            for k in keys {
                if let Some(v) = body.get(k).and_then(|v| v.as_str()).map(|s| s.trim()) {
                    if !v.is_empty() && v != "unknown" {
                        return Some(v.to_string());
                    }
                }
            }
            None
        };
        let Some(city) = get(&["city"]) else { continue };
        let mut parts: Vec<String> = vec![city];
        if let Some(r) = get(&["region", "regionName"]) {
            parts.push(r);
        }
        if let Some(c) = get(&["country", "country_name"]) {
            parts.push(c);
        }
        return Ok(parts.join(", "));
    }
    Err(format!(
        "all geolocation backends failed: {}",
        failed.join("; ")
    ))
}

// ── System permissions (macOS) ──
// Location / camera / microphone access is gated by the OS. The two commands
// below let the GUI show the current status and trigger the native permission
// dialog (the dialog itself is owned by the system; the app only requests it).
// Status values returned to the frontend: authorized | denied | restricted |
// not_determined | disabled | unsupported.

#[cfg(target_os = "macos")]
#[allow(deprecated)] // class authorizationStatus accessor is deprecated in the bindings; no replacement exists
fn macos_location_status() -> String {
    unsafe {
        if !CLLocationManager::locationServicesEnabled_class() {
            return "disabled".into();
        }
        let s = CLLocationManager::authorizationStatus_class();
        if s == CLAuthorizationStatus::AuthorizedWhenInUse
            || s == CLAuthorizationStatus::AuthorizedAlways
        {
            "authorized"
        } else if s == CLAuthorizationStatus::Denied {
            "denied"
        } else if s == CLAuthorizationStatus::Restricted {
            "restricted"
        } else {
            "not_determined"
        }
        .into()
    }
}

#[cfg(target_os = "macos")]
fn macos_av_media_type(kind: &str) -> Result<&'static AVMediaType, String> {
    unsafe {
        match kind {
            "camera" => AVMediaTypeVideo.ok_or_else(|| "AVMediaTypeVideo unavailable".into()),
            "microphone" => AVMediaTypeAudio.ok_or_else(|| "AVMediaTypeAudio unavailable".into()),
            other => Err(format!("unknown permission kind: {other}")),
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_av_status(media: &AVMediaType) -> String {
    unsafe {
        let s = AVCaptureDevice::authorizationStatusForMediaType(media);
        if s == AVAuthorizationStatus::Authorized {
            "authorized"
        } else if s == AVAuthorizationStatus::Denied {
            "denied"
        } else if s == AVAuthorizationStatus::Restricted {
            "restricted"
        } else {
            "not_determined"
        }
        .into()
    }
}

#[tauri::command]
fn check_system_permission(kind: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(match kind.as_str() {
            "location" => macos_location_status(),
            "camera" => macos_av_status(macos_av_media_type("camera")?),
            "microphone" => macos_av_status(macos_av_media_type("microphone")?),
            other => return Err(format!("unknown permission kind: {other}")),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Ok("unsupported".into())
    }
}

#[tauri::command]
fn request_system_permission(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        match kind.as_str() {
            "location" => {
                // CLLocationManager must be touched on the main thread for the
                // system dialog to appear reliably. run_on_main_thread only
                // enqueues the closure, so the standard channel below is
                // woken by the main-thread run loop without deadlocking.
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                app.run_on_main_thread(move || {
                    unsafe {
                        let mgr: Retained<CLLocationManager> =
                            msg_send![CLLocationManager::class(), new];
                        mgr.requestWhenInUseAuthorization();
                        // requestWhenInUseAuthorization has no completion
                        // handler, and Apple requires a strong reference to
                        // the manager until the user answers the prompt.
                        // Leaking keeps it alive for the process lifetime;
                        // this is a one-shot settings action, so it is bounded.
                        std::mem::forget(mgr);
                    }
                    let _ = tx.send(());
                })
                .map_err(|e| e.to_string())?;
                let _ = rx.recv();
                // No completion callback exists for location, so poll the
                // class-level status until the user decides (or 60s elapses).
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
                loop {
                    let status = macos_location_status();
                    if status != "not_determined" || std::time::Instant::now() >= deadline {
                        return Ok(status);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
            "camera" | "microphone" => {
                let media = macos_av_media_type(&kind)?;
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                let block = RcBlock::new(move |_granted: Bool| {
                    let _ = tx.send(());
                });
                unsafe {
                    AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &block);
                }
                // The framework retains the block; waits until the user
                // answers the system dialog, then reports the final status.
                let _ = rx.recv();
                Ok(macos_av_status(media))
            }
            other => Err(format!("unknown permission kind: {other}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind);
        Err("system permissions are only supported on macOS".into())
    }
}


/// Directories where user-installed runtimes commonly live, MISSING from the
/// minimal PATH a macOS GUI app inherits from Finder/LaunchServices
/// (/usr/bin:/bin:/usr/sbin:/sbin). Without them, nvm / bun / volta / fnm /
/// asdf / Homebrew installs would all report "not installed" even though the
/// runtimes exist. Windows GUI apps inherit the full system PATH, so this
/// only matters on Unix. Each entry is a best-effort candidate; missing
/// directories are simply skipped by the spawn probe.
#[cfg(unix)]
fn probe_extra_path_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
    ];
    // nvm: ~/.nvm/versions/node/<version>/bin — every installed version.
    if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                dirs.push(entry.path().join("bin").to_string_lossy().to_string());
            }
        }
    }
    // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin.
    if let Ok(entries) = std::fs::read_dir(format!("{home}/.local/share/fnm/node-versions")) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                dirs.push(
                    entry
                        .path()
                        .join("installation/bin")
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    // asdf: ~/.asdf/installs/{nodejs,bun}/<version>/bin.
    for tool in ["nodejs", "bun"] {
        if let Ok(entries) = std::fs::read_dir(format!("{home}/.asdf/installs/{tool}")) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    dirs.push(entry.path().join("bin").to_string_lossy().to_string());
                }
            }
        }
    }
    dirs
}

/// PATH for runtime probes AND user commands: the inherited PATH plus the
/// user-install directories above (deduplicated, extras first so a user's
/// nvm node wins over the system node). Computed once per process — it is
/// used by every execute_command spawn, so it must not re-scan the home
/// directories per call.
#[cfg(unix)]
fn probe_path() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let inherited: Vec<String> = std::env::var("PATH")
                .map(|p| p.split(':').map(|s| s.to_string()).collect())
                .unwrap_or_default();
            let mut parts: Vec<String> = Vec::new();
            for dir in probe_extra_path_dirs() {
                if !inherited.contains(&dir) && !parts.contains(&dir) {
                    parts.push(dir);
                }
            }
            parts.extend(inherited);
            parts.join(":")
        })
        .clone()
}

/// Probe installed runtime versions (Node.js, Python, Rust) for sys_info.
/// Each is a quick `--version` subprocess; a missing binary yields "not
/// installed" instead of failing the whole sys_info call. python --version
/// prints to stderr, so both streams are checked. On Unix the probe runs with
/// an extended PATH (see probe_path) so runtimes installed via nvm/bun/volta/
/// fnm/asdf/Homebrew are found even though the GUI app's inherited PATH is
/// minimal.
fn detect_runtime_versions() -> Vec<String> {
    #[cfg(unix)]
    let probe_env_path = probe_path();
    let mut out: Vec<String> = Vec::new();
    for (label, args) in [
        ("node", vec!["--version"]),
        ("bun", vec!["--version"]),
        ("python3", vec!["--version"]),
        ("rustc", vec!["--version"]),
        ("git", vec!["--version"]),
    ] {
        let version = {
            #[cfg(unix)]
            {
                silent_child(std::process::Command::new(label))
                    .env("PATH", &probe_env_path)
                    .args(&args)
                    .output()
            }
            #[cfg(not(unix))]
            {
                silent_child(std::process::Command::new(label))
                    .args(&args)
                    .output()
            }
        }
        .ok()
        .filter(|o| o.status.success())
            .map(|o| {
                // Collapse whitespace so multi-line banners cannot break out of
                // the system-prompt sentence (mirrors the Node adapter).
                let stdout = String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .replace(char::is_whitespace, " ");
                let stderr = String::from_utf8_lossy(&o.stderr)
                    .trim()
                    .replace(char::is_whitespace, " ");
                if !stdout.is_empty() {
                    stdout
                } else {
                    stderr
                }
            })
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "not installed".to_string());
        out.push(format!("{}: {}", label, version));
    }
    out
}

/// Summarize the standard proxy environment variables (HTTP_PROXY /
/// HTTPS_PROXY / ALL_PROXY / NO_PROXY plus lowercase variants) as
/// `NAME=value` pairs, or "none" when none are set. Reported raw (unlike
/// env_proxy(), which resolves the first usable triple) so the model sees the
/// full picture — e.g. a NO_PROXY bypass list it should account for.
fn env_proxy_summary() -> String {
    let mut parts: Vec<String> = Vec::new();
    for name in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                parts.push(format!("{name}={value}"));
            }
        }
    }
    if parts.is_empty() {
        "none".to_string()
    } else {
        parts.join(" ")
    }
}

/// Detect currently-connected VPN services. macOS: `scutil --nc list` marks
/// connected VPNs with "(Connected)" followed by the service name. Other
/// platforms report "not detected" (Windows has no reliable single source
/// without extra tooling; Linux none at all).
fn detect_vpn_connections() -> String {
    #[cfg(target_os = "macos")]
    {
        let output = silent_child(std::process::Command::new("scutil"))
            .args(["--nc", "list"])
            .output()
            .ok();
        if let Some(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            let names: Vec<String> = text
                .lines()
                .filter(|line| line.contains("(Connected)"))
                .filter_map(|line| {
                    line.split("(Connected)").nth(1).map(|s| s.trim().to_string())
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !names.is_empty() {
                return format!("{} (connected)", names.join(", "));
            }
        }
        "none".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "not detected".to_string()
    }
}

/// Probe DIRECT connectivity (no proxy at all, env proxy vars ignored) to a
/// domestic and an international endpoint, so the model knows which network
/// the machine sits on (mainland China / intranet / open internet). Returns a
/// short "domestic ok, international blocked" style summary; "unknown" when
/// the client itself cannot be built. Timeouts are tight — this runs inside
/// sys_info and the per-session prompt probe.
async fn probe_reachability() -> String {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(_) => return "unknown".to_string(),
    };
    // The client's own 2s timeout bounds each probe; the requests run in
    // parallel, so the whole check takes ~2s worst case.
    async fn reachable(client: &reqwest::Client, url: &str) -> bool {
        client
            .get(url)
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }
    let (domestic, international) = tokio::join!(
        reachable(&client, "https://www.baidu.com/"),
        reachable(&client, "https://www.google.com/generate_204"),
    );
    format!(
        "domestic {}, international {}",
        if domestic { "ok" } else { "blocked" },
        if international { "ok" } else { "blocked" }
    )
}

/// Best-effort OS timezone (IANA name). macOS/Linux symlink /etc/localtime
/// into …/zoneinfo/<TZ>; the tail is the IANA name (Asia/Shanghai). Falls back
/// to the TZ env var (rarely set for macOS GUI apps) and finally "unknown".
fn detect_timezone() -> String {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if let Ok(target) = std::fs::read_link("/etc/localtime") {
            let target = target.to_string_lossy();
            if let Some(idx) = target.rfind("zoneinfo/") {
                return target[idx + "zoneinfo/".len()..].to_string();
            }
        }
    }
    std::env::var("TZ")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Best-effort OS language/locale (zh_CN, en_US, …). macOS reads the global
/// AppleLocale preference (locale env vars are unset for GUI apps); other
/// platforms fall back to the standard locale env vars set in most terminals.
fn detect_language() -> String {
    #[cfg(target_os = "macos")]
    {
        let output = silent_child(std::process::Command::new("defaults"))
            .args(["read", "-g", "AppleLocale"])
            .output()
            .ok();
        if let Some(output) = output {
            let v = String::from_utf8_lossy(&output.stdout)
                .trim()
                .trim_matches('"')
                .to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LC_CTYPE"))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Character encoding implied by the locale (en_US.UTF-8 → UTF-8). macOS and
/// modern Linux default to UTF-8; Windows ANSI code pages are not probed here.
fn detect_encoding(locale: &str) -> String {
    if let Some(enc) = locale.split('.').nth(1) {
        let enc = enc.trim();
        if !enc.is_empty() {
            return enc.to_uppercase();
        }
    }
    "UTF-8".to_string()
}

/// Public IP + city-level geolocation result for sys_info.
#[derive(Clone)]
struct IpGeo {
    ip_masked: String,
    city: String,
    region: String,
    country: String,
    timezone: String,
}

/// Public-IP geolocation is fetched ONCE per process and cached. It is the only
/// network round-trip in sys_info that never changes meaningfully mid-session
/// (a public IP is city-stable for the app's lifetime), so repeated sys_info
/// calls must not re-pay the up-to-three-backend probe. The `time:` and
/// `network reach:` lines stay live because they DO change.
static IP_GEO_CACHE: tokio::sync::OnceCell<Option<IpGeo>> = tokio::sync::OnceCell::const_new();

/// Cached wrapper around fetch_ip_geo: the first call probes the backends,
/// later calls return the cached city-level result without touching the network.
async fn detect_ip_geo() -> Option<IpGeo> {
    IP_GEO_CACHE.get_or_init(fetch_ip_geo).await.clone()
}

/// Fetch the public IP + city geolocation for sys_info. The RAW IP is
/// privacy-sensitive (sys_info text is injected into the LLM system prompt, so
/// it would be sent to the model provider), therefore only a MASKED form is
/// kept (last IPv4 octet / IPv6 hextets redacted). City/region/country/timezone
/// are the parts that matter for geographic judgment and are not sensitive at
/// city granularity.
async fn fetch_ip_geo() -> Option<IpGeo> {
    let backends: &[&str] = &[
        "https://ipwho.is/",
        "https://ipinfo.io/json",
        "http://ip-api.com/json/?lang=zh-CN",
    ];
    for url in backends {
        let client = match build_http_client(std::time::Duration::from_secs(3), None) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let body: serde_json::Value = match client
            .get(*url)
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(_) => continue,
            },
            _ => continue,
        };
        let get = |keys: &[&str]| -> String {
            for k in keys {
                if let Some(v) = body.get(k).and_then(|v| v.as_str()).map(|s| s.trim()) {
                    if !v.is_empty() && v != "unknown" {
                        return v.to_string();
                    }
                }
            }
            String::new()
        };
        let city = get(&["city"]);
        let region = get(&["region", "regionName"]);
        let country = get(&["country", "country_name"]);
        let timezone = get(&["timezone"]);
        let ip = get(&["ip", "query"]);
        if city.is_empty() && timezone.is_empty() {
            continue;
        }
        return Some(IpGeo {
            ip_masked: mask_ip(&ip),
            city,
            region,
            country,
            timezone,
        });
    }
    None
}

/// Redact the identifying tail of an IP so sys_info never leaks the exact
/// public address to the model backend. IPv4 → last octet; IPv6 → last hextet.
fn mask_ip(ip: &str) -> String {
    if ip.is_empty() {
        return "unknown".to_string();
    }
    if ip.contains(':') {
        match ip.split(':').next() {
            Some(first) if !first.is_empty() => format!("{first}:…"),
            _ => "unknown".to_string(),
        }
    } else {
        match ip.rsplit_once('.') {
            Some((head, _)) => format!("{head}.x"),
            None => "unknown".to_string(),
        }
    }
}

/// Current local time as "YYYY-MM-DD HH:MM:SS TZ" for sys_info. Kept LIVE on
/// every call (it is the one field that must be current) — the subprocess is
/// cheap (~ms) next to the runtime/network probes that ARE cached below.
fn detect_current_time() -> String {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        std::process::Command::new("date")
            .arg("+%Y-%m-%d %H:%M:%S %Z")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    // Windows has no `date` binary; PowerShell formats the local time. The
    // fixed command goes through -EncodedCommand like every other PowerShell
    // invocation, so its quoting never touches the Windows command line.
    #[cfg(windows)]
    {
        silent_child(std::process::Command::new("powershell"))
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
            .arg(utf16le_base64("Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'"))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
}

/// Human OS version string for sys_info (macOS via sw_vers, Linux via uname,
/// Windows from compile-time constants).
fn detect_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| {
                let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let arch = std::env::consts::ARCH;
                format!("macOS {} ({})", ver, arch)
            })
            .unwrap_or_else(|_| "macOS (unknown version)".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("uname")
            .args(["-srm"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "Linux (unknown version)".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
    }
}

// ── sys_info caching ──
// Probing the full sys_info on EVERY tool call costs 5+ subprocess spawns
// (runtime --version) and a 2s network round-trip (reachability) per call.
// Most fields cannot change mid-session, so they are split into two tiers:
//   * static   — OS, language, timezone, runtimes: computed ONCE per process.
//   * volatile — system/env proxy, VPN, live reachability: refreshed on a TTL
//                (they legitimately change, e.g. proxy toggled or VPN joined).
// `time:` stays live on every call. The cache is warmed at app startup (see
// run()) so the first tool call / prompt probe returns instantly.
#[derive(Clone)]
struct SysInfoStatic {
    lang: String,
    encoding: String,
    tz: String,
    os_version: String,
    runtimes: String,
}

#[derive(Clone)]
struct SysInfoVolatile {
    system_proxy: String,
    env_proxy: String,
    vpn: String,
    reach: String,
}

static SYS_INFO_STATIC: tokio::sync::OnceCell<SysInfoStatic> = tokio::sync::OnceCell::const_new();
static SYS_INFO_VOLATILE: tokio::sync::Mutex<Option<(std::time::Instant, SysInfoVolatile)>> =
    tokio::sync::Mutex::const_new(None);
const SYS_INFO_VOLATILE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

async fn probe_sys_info_static() -> SysInfoStatic {
    let lang = detect_language();
    let encoding = detect_encoding(&lang);
    let mut tz = detect_timezone();
    // Timezone fallback: the geo backend reports a city timezone when the OS
    // gives nothing (e.g. /etc/localtime unreadable).
    if tz == "unknown" {
        if let Some(g) = detect_ip_geo().await {
            if !g.timezone.is_empty() {
                tz = g.timezone.clone();
            }
        }
    }
    SysInfoStatic {
        lang,
        encoding,
        tz,
        os_version: detect_os_version(),
        runtimes: detect_runtime_versions().join("  "),
    }
}

async fn cached_sys_info_static() -> SysInfoStatic {
    SYS_INFO_STATIC.get_or_init(probe_sys_info_static).await.clone()
}

/// The live probe behind the volatile cache (system/env proxy, VPN,
/// reachability) — kept separate so tests can inject a fake probe.
async fn probe_sys_info_volatile() -> SysInfoVolatile {
    SysInfoVolatile {
        system_proxy: resolve_system_proxy_url().unwrap_or_else(|| "none".to_string()),
        env_proxy: env_proxy_summary(),
        vpn: detect_vpn_connections(),
        reach: probe_reachability().await,
    }
}

/// TTL cache core, clock- and probe-injectable for tests. A call within the
/// TTL of the last probe returns the cached block; after the TTL it probes
/// again and refreshes. The slow path probes OUTSIDE the lock (an await in
/// the lock would block other callers for the whole 2s reachability probe),
/// then re-checks the TTL under the lock so a concurrent caller that just
/// refreshed wins and the stale probe result is discarded.
async fn cached_sys_info_volatile_impl(
    cache: &tokio::sync::Mutex<Option<(std::time::Instant, SysInfoVolatile)>>,
    now: std::time::Instant,
    ttl: std::time::Duration,
    probe: impl std::future::Future<Output = SysInfoVolatile>,
) -> SysInfoVolatile {
    // Fast path: a fresh-enough cached block.
    {
        let guard = cache.lock().await;
        if let Some((at, cached)) = &*guard {
            if now.duration_since(*at) < ttl {
                return cached.clone();
            }
        }
    }
    // Slow path: probe outside the lock, then re-check the TTL so concurrent
    // callers don't each store a fresh block when another just refreshed.
    let fresh = probe.await;
    let mut guard = cache.lock().await;
    if let Some((at, cached)) = &*guard {
        if now.duration_since(*at) < ttl {
            return cached.clone();
        }
    }
    *guard = Some((now, fresh.clone()));
    fresh
}

async fn cached_sys_info_volatile() -> SysInfoVolatile {
    cached_sys_info_volatile_impl(
        &SYS_INFO_VOLATILE,
        std::time::Instant::now(),
        SYS_INFO_VOLATILE_TTL,
        probe_sys_info_volatile(),
    )
    .await
}

#[tauri::command]
async fn sys_info(_workspace: String, location: Option<String>) -> Result<String, String> {
    // Static fields come from the process-wide cache (warmed at startup),
    // volatile network fields from the TTL cache; only `time:` is live.
    // Joined so the first (cold) call pays the runtime + reachability probes
    // in parallel, like the pre-caching implementation did.
    let (static_info, volatile) = tokio::join!(cached_sys_info_static(), cached_sys_info_volatile());
    let ip_geo = detect_ip_geo().await;
    let time = detect_current_time();

    let loc = location
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| format!("{} (user-set)", s))
        .unwrap_or_else(|| "not set".to_string());

    let ip_line = match &ip_geo {
        Some(g) => {
            let mut parts: Vec<String> = vec![g.ip_masked.clone()];
            let mut loc_parts: Vec<String> = Vec::new();
            for p in [&g.city, &g.region, &g.country] {
                if !p.is_empty() {
                    loc_parts.push(p.clone());
                }
            }
            if !loc_parts.is_empty() {
                parts.push(loc_parts.join(", "));
            }
            if !g.timezone.is_empty() {
                parts.push(g.timezone.clone());
            }
            parts.join(" · ")
        }
        None => "unknown (offline or all geolocation backends blocked)".to_string(),
    };

    let info = format!(
        "timezone:  {}\nlanguage:  {}\nencoding:  {}\nip:        {}\ntime:      {}\nos:        {}\nlocation:  {}\nruntimes:  {}\nnetwork:   proxy: {}; env: {}; vpn: {}; reach: {}",
        static_info.tz,
        static_info.lang,
        static_info.encoding,
        ip_line,
        time,
        static_info.os_version,
        loc,
        static_info.runtimes,
        volatile.system_proxy,
        volatile.env_proxy,
        volatile.vpn,
        volatile.reach,
    );
    Ok(info)
}

#[cfg(test)]
mod sys_info_tests {
    use super::*;

    #[test]
    fn masks_ipv4_last_octet() {
        assert_eq!(mask_ip("58.246.12.34"), "58.246.12.x");
        assert_eq!(mask_ip("8.8.8.8"), "8.8.8.x");
    }

    #[test]
    fn masks_ipv6_beyond_first_hextet() {
        assert_eq!(mask_ip("2001:db8::1"), "2001:…");
    }

    #[test]
    fn mask_ip_handles_empty_and_malformed() {
        assert_eq!(mask_ip(""), "unknown");
        assert_eq!(mask_ip("not-an-ip"), "unknown");
    }

    #[test]
    fn detects_encoding_from_locale_suffix() {
        assert_eq!(detect_encoding("en_US.UTF-8"), "UTF-8");
        assert_eq!(detect_encoding("zh_CN.GBK"), "GBK");
        assert_eq!(detect_encoding("zh_CN"), "UTF-8");
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Open Path (clickable transcript paths → Finder / default app)
// ═══════════════════════════════════════════════════════════════════════════════/// True for the URL schemes that should be handed to the system browser or
/// mail client. Keep this allowlist narrow: `open_path` is exposed to the
/// WebView and must not become a generic URI launcher.
fn is_external_open_url(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

/// Reject unsupported URI schemes while allowing normal POSIX paths and
/// Windows drive paths (`C:\\...`).
fn has_unsupported_uri_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else {
        return false;
    };
    if colon == 1
        && raw
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic())
    {
        return false;
    }
    let scheme = &raw[..colon];
    !scheme.is_empty()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

/// Open a URL, file, or directory with the OS default application. URLs are
/// handed to the default browser; directories open in the file manager and
/// files open with their default app. Absolute OS command paths are deliberate:
/// Finder-launched Tauri apps inherit a minimal PATH that may not contain
/// `/usr/bin`, so invoking `open` by name can silently fail in the packaged GUI.
#[cfg(target_os = "linux")]
fn decode_file_uri_path(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            if i + 2 >= raw.len() {
                return None;
            }
            let hex = |digit: u8| -> Option<u8> {
                match digit {
                    b'0'..=b'9' => Some(digit - b'0'),
                    b'a'..=b'f' => Some(digit - b'a' + 10),
                    b'A'..=b'F' => Some(digit - b'A' + 10),
                    _ => None,
                }
            };
            bytes.push(hex(raw[i + 1])? * 16 + hex(raw[i + 2])?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "linux")]
fn parse_linux_icon_value(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value.strip_prefix("GThemedIcon:").unwrap_or(value).trim();
    let value = value.strip_prefix("GFileIcon:").unwrap_or(value).trim();
    let value = value
        .split(',')
        .next()?
        .trim()
        .trim_matches(['[', ']', '(', ')', '"']);
    if let Some(path) = value.strip_prefix("file://") {
        let path = path.strip_prefix("localhost").unwrap_or(path);
        return decode_file_uri_path(path);
    }
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(target_os = "linux")]
fn linux_theme_icon_path(name: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home).join(".icons"));
        roots.push(PathBuf::from(home).join(".local/share/icons"));
    }
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        roots.push(PathBuf::from(data_home).join("icons"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for root in data_dirs.split(':').filter(|root| !root.is_empty()) {
        roots.push(PathBuf::from(root).join("icons"));
    }
    roots.push(PathBuf::from("/usr/share/pixmaps"));

    let names = [name, "text-x-generic", "application-octet-stream"];
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(6)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !names.iter().any(|candidate| *candidate == stem) {
                continue;
            }
            if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("png" | "svg" | "svgz")
            ) {
                return Some(path.to_path_buf());
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_icon_data(path: &str) -> Result<String, String> {
    let output = std::process::Command::new("gio")
        .args([
            "info",
            "--attributes=standard::icon",
            "--nofollow-symlinks",
            path,
        ])
        .output()
        .map_err(|e| format!("gio unavailable: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "gio info failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let icon_name = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("standard::icon:"))
        .and_then(parse_linux_icon_value)
        .ok_or_else(|| "gio did not return a file icon".to_string())?;
    let icon_path = if icon_name.starts_with('/') {
        PathBuf::from(icon_name)
    } else {
        linux_theme_icon_path(&icon_name)
            .ok_or_else(|| format!("icon theme entry not found: {}", icon_name))?
    };
    let bytes = fs::read(&icon_path).map_err(|e| format!("read icon: {}", e))?;
    let mime = match icon_path.extension().and_then(|value| value.to_str()) {
        Some("svg") | Some("svgz") => "image/svg+xml",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(target_os = "windows")]
fn windows_icon_data(path: &str) -> Result<String, String> {
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let result = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || info.hIcon.is_null() {
        return Err("SHGetFileInfoW returned no icon".to_string());
    }
    let hicon = info.hIcon;
    let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(hicon, &mut icon_info) } == 0 {
        unsafe {
            DestroyIcon(hicon);
        }
        return Err("GetIconInfo failed".to_string());
    }
    let color_bitmap = icon_info.hbmColor;
    let mask_bitmap = icon_info.hbmMask;
    if color_bitmap.is_null() {
        unsafe {
            if !mask_bitmap.is_null() {
                DeleteObject(mask_bitmap);
            }
            DestroyIcon(hicon);
        }
        return Err("GetIconInfo returned no color bitmap".to_string());
    }
    let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
    let object_size = unsafe {
        GetObjectW(
            color_bitmap,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut BITMAP as *mut std::ffi::c_void,
        )
    };
    let width = bitmap.bmWidth;
    let height = bitmap.bmHeight.abs();
    if object_size == 0 || width <= 0 || height <= 0 {
        unsafe {
            DeleteObject(color_bitmap);
            if !mask_bitmap.is_null() {
                DeleteObject(mask_bitmap);
            }
            DestroyIcon(hicon);
        }
        return Err("invalid Windows icon bitmap".to_string());
    }
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let mut bitmap_info: BITMAPINFO = unsafe { std::mem::zeroed() };
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let hdc = unsafe { GetDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        unsafe {
            DeleteObject(color_bitmap);
            if !mask_bitmap.is_null() {
                DeleteObject(mask_bitmap);
            }
            DestroyIcon(hicon);
        }
        return Err("GetDC failed".to_string());
    }
    let copied = unsafe {
        GetDIBits(
            hdc,
            color_bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut std::ffi::c_void,
            &mut bitmap_info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        ReleaseDC(std::ptr::null_mut(), hdc);
        DeleteObject(color_bitmap);
        DestroyIcon(hicon);
    }
    if copied == 0 {
        unsafe {
            if !mask_bitmap.is_null() {
                DeleteObject(mask_bitmap);
            }
        }
        return Err("GetDIBits could not read the icon bitmap".to_string());
    }
    let mut rgba = pixels;
    let alpha_is_uniform = rgba.chunks_exact(4).all(|pixel| pixel[3] == 0)
        || rgba.chunks_exact(4).all(|pixel| pixel[3] == 0xff);
    if alpha_is_uniform && !mask_bitmap.is_null() {
        let mut mask_bitmap_info: BITMAP = unsafe { std::mem::zeroed() };
        let mask_object_size = unsafe {
            GetObjectW(
                mask_bitmap,
                std::mem::size_of::<BITMAP>() as i32,
                &mut mask_bitmap_info as *mut BITMAP as *mut std::ffi::c_void,
            )
        };
        let mask_height = mask_bitmap_info.bmHeight.abs().min(height);
        let mask_stride = ((width as usize + 31) / 32) * 4;
        if mask_object_size != 0 && mask_height > 0 {
            let mut mask_pixels = vec![0u8; mask_stride * mask_height as usize];
            let mut mask_info: BITMAPINFO = unsafe { std::mem::zeroed() };
            mask_info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -(mask_height),
                biPlanes: 1,
                biBitCount: 1,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mask_copied = unsafe {
                let mask_dc = GetDC(std::ptr::null_mut());
                if mask_dc.is_null() {
                    0
                } else {
                    let copied = GetDIBits(
                        mask_dc,
                        mask_bitmap,
                        0,
                        mask_height as u32,
                        mask_pixels.as_mut_ptr() as *mut std::ffi::c_void,
                        &mut mask_info,
                        DIB_RGB_COLORS,
                    );
                    ReleaseDC(std::ptr::null_mut(), mask_dc);
                    copied
                }
            };
            if mask_copied != 0 {
                for y in 0..height as usize {
                    for x in 0..width as usize {
                        let mask_byte = y.min(mask_height as usize - 1) * mask_stride + x / 8;
                        let transparent = (mask_pixels[mask_byte] & (0x80 >> (x % 8))) != 0;
                        rgba[(y * width as usize + x) * 4 + 3] = if transparent { 0 } else { 0xff };
                    }
                }
            }
        }
    }
    unsafe {
        if !mask_bitmap.is_null() {
            DeleteObject(mask_bitmap);
        }
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let mut png = Vec::new();
    {
        let mut encoder = Encoder::new(&mut png, width as u32, height as u32);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header: {}", e))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| format!("PNG data: {}", e))?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

#[tauri::command]
async fn get_file_icon(path: String) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("get_file_icon: path is empty".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let path_string = NSString::from_str(&path);
        let icon = NSWorkspace::sharedWorkspace().iconForFile(&path_string);
        let tiff = icon
            .TIFFRepresentation()
            .ok_or("icon has no TIFF representation")?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("unable to decode icon")?;
        let properties = NSDictionary::<NSString, AnyObject>::new();
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or("unable to encode icon")?;
        return Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(unsafe { png.as_bytes_unchecked() })
        ));
    }
    #[cfg(target_os = "linux")]
    {
        return tokio::task::spawn_blocking(move || linux_icon_data(&path))
            .await
            .map_err(|e| format!("linux icon task failed: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        return windows_icon_data(&path);
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("native icons are unavailable on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
#[cfg(test)]
mod linux_icon_tests {
    use super::parse_linux_icon_value;
    #[test]
    fn parses_gio_icon_values() {
        assert_eq!(
            parse_linux_icon_value("GThemedIcon: [text-x-generic, text-plain]"),
            Some("text-x-generic".to_string())
        );
        assert_eq!(
            parse_linux_icon_value("GFileIcon: /usr/share/pixmaps/file.png"),
            Some("/usr/share/pixmaps/file.png".to_string())
        );
        assert_eq!(
            parse_linux_icon_value("GFileIcon: file:///tmp/file%20name.png"),
            Some("/tmp/file name.png".to_string())
        );
        assert_eq!(
            parse_linux_icon_value("GFileIcon: file://localhost/tmp/file.png"),
            Some("/tmp/file.png".to_string())
        );
    }
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("open_path: path is empty".to_string());
    }
    if raw.contains('\0') {
        return Err("open_path: path contains NUL".to_string());
    }
    if !is_external_open_url(raw) && has_unsupported_uri_scheme(raw) {
        return Err(format!("open_path: unsupported URI scheme: {}", raw));
    }

    let is_url = is_external_open_url(raw);

    let mut expanded = raw.to_string();
    if expanded.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            expanded = format!("{}/{}", home.trim_end_matches('/'), &expanded[2..]);
        }
    }

    let target = if is_url {
        expanded
    } else {
        let p = PathBuf::from(&expanded);
        if p.exists() {
            expanded
        } else {
            p.parent()
                .filter(|pp| pp.exists())
                .map(|pp| pp.to_string_lossy().to_string())
                .unwrap_or(expanded)
        }
    };

    // Async so a slow launcher never blocks the main thread. Keep the command
    // path explicit for packaged apps launched from Finder.
    #[cfg(target_os = "macos")]
    let status = TokioCommand::new("/usr/bin/open")
        .arg(&target)
        .status()
        .await;
    #[cfg(target_os = "linux")]
    let status = TokioCommand::new("/usr/bin/xdg-open")
        .arg(&target)
        .status()
        .await;
    // explorer.exe is fire-and-forget and returns exit code 1 even on success,
    // so `cmd /C start "" <target>` is used instead: it hands files, folders
    // and URLs to the default app with a reliable exit code.
    #[cfg(target_os = "windows")]
    let status = silent_child_tokio(TokioCommand::new("cmd"))
        .args(["/C", "start", ""])
        .arg(&target)
        .status()
        .await;

    status
        .map_err(|e| format!("open_path: {}", e))?
        .success()
        .then_some(())
        .ok_or_else(|| format!("open failed: {}", target))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tauri App Entry
// ═══════════════════════════════════════════════════════════════════════════════

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(McpRegistry::new(BTreeMap::new()))
        .manage(CommandRegistry::new(BTreeMap::new()))
        .manage(ChatStreamRegistry::new(StdMutex::new(BTreeMap::new())))
        .setup(|_app| {
            // Warm the sys_info caches at startup so the first tool call /
            // prompt probe returns instantly instead of paying the full
            // (runtime subprocesses + network reachability) probe on first
            // use. Best-effort: a failure only means the caches fill lazily.
            tauri::async_runtime::spawn(async {
                let _ = sys_info(String::new(), None).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // File tools
            read_file,
            path_info,
            remove_path,
            write_file,
            write_file_stream,
            edit_file,
            search_files,
            find_files,
            code_searcher,
            list_files,
            create_directory,
            diff_files,
            glob_files,
            replace_files,
            save_file,
            save_file_binary,
            get_file_icon,
            // System info
            sys_info,
            detect_location,
            // System permissions
            check_system_permission,
            request_system_permission,
            list_app_skills,
            write_app_skill,
            test_llm_connection,
            test_proxy,
            detect_system_proxy,
            // Web tools
            web_search,
            web_fetch,
            web_public_api,
            web_scrape,
            // Command execution
            execute_command,
            execute_command_stream,
            kill_command,
            // Git tools
            git_diff,
            git_log,
            git_status,
            // MCP subprocess
            spawn_mcp,
            mcp_request,
            mcp_http_request,
            mcp_notify,
            mcp_shutdown,
            mcp_list,
            // Application temporary workspace + secret management
            get_tmp_workspace,
            save_paste_file,
            save_paste_image,
            import_dropped_file,
            tmp_paste_usage,
            cleanup_tmp_pastes,
            secret_get,
            secret_set,
            secret_delete,
            secret_list,
            // App config file (~/.pure/config.json)
            load_config,
            save_config,
            // Open path (clickable transcript paths)
            open_path,
            // LLM transport
            chat_stream,
            cancel_chat_stream,
            // Text-to-image (OpenAI-compatible /images/generations)
            generate_image,
            // Session persistence
            save_session,
            load_session,
            load_last_session,
            load_session_list,
            save_session_workspace,
            delete_session,
            delete_all_sessions,
            // Per-session usage stats
            save_session_stats,
            load_session_stats,
            load_all_session_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pure");
}

#[cfg(test)]
mod mcp_subprocess_tests {
    use super::*;

    #[test]
    fn external_open_url_allowlist_is_case_insensitive() {
        assert!(is_external_open_url("HTTPS://example.com"));
        assert!(is_external_open_url("MailTo:user@example.com"));
        assert!(!is_external_open_url("javascript:alert(1)"));
        assert!(!is_external_open_url("file:///tmp/report.txt"));
    }

    #[test]
    fn unsupported_uri_scheme_keeps_local_paths_allowed() {
        assert!(has_unsupported_uri_scheme("javascript:alert(1)"));
        assert!(has_unsupported_uri_scheme("file:///tmp/report.txt"));
        assert!(!has_unsupported_uri_scheme("/Users/me/report.txt"));
        assert!(!has_unsupported_uri_scheme("C:\\Users\\me\\report.txt"));
    }

    #[tokio::test]
    async fn mcp_call_roundtrips_jsonrpc_over_subprocess() {
        // Line-echo server: prints back each JSON line — the exact shape a
        // stdio MCP server produces for a request (one JSON-RPC response per
        // request line).
        let mut child = TokioCommand::new("sh")
            .arg("-c")
            .arg("while IFS= read -r line; do printf '%s\\n' \"$line\"; done")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let handle = McpHandle {
            child: tokio::sync::Mutex::new(child),
            stdin: tokio::sync::Mutex::new(stdin),
            stdout: tokio::sync::Mutex::new(BufReader::new(stdout)),
        };

        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let resp = mcp_call_inner(&handle, request).await.unwrap();
        assert_eq!(
            resp, request,
            "call must round-trip the request line verbatim"
        );

        // Notification path: write-only, must NOT block waiting for a
        // response line (the echo server sends nothing back for a notify).
        {
            let mut stdin = handle.stdin.lock().await;
            stdin
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n")
                .await
                .unwrap();
            stdin.flush().await.unwrap();
        }

        let mut child = handle.child.lock().await;
        let _ = child.kill().await;
    }

    #[tokio::test]
    async fn spawn_mcp_augments_path_and_forwards_env() {
        // Can't invoke the Tauri command (needs State), so exercise the shared
        // path helper + env forwarding against a real child process.
        let home = std::env::var("HOME").unwrap_or_default();
        let path = augmented_mcp_path(Some("/custom/bin"));
        assert!(
            path.starts_with(&format!("{}/.bun/bin", home)),
            "bun dir must be prepended: {}",
            path
        );
        assert!(
            path.contains("/custom/bin"),
            "existing PATH must be preserved: {}",
            path
        );

        let mut cmd = TokioCommand::new("sh");
        cmd.arg("-c").arg("printf '%s' \"$PURE_TEST_VAR $PATH\"");
        cmd.env("PURE_TEST_VAR", "hello");
        cmd.env("PATH", augmented_mcp_path(None));
        let out = cmd.output().await.unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(
            text.starts_with("hello "),
            "env var must reach the child: {}",
            text
        );
        assert!(
            text.contains(&format!("{}/.bun/bin", home)),
            "PATH augmentation missing: {}",
            text
        );
    }
}

#[cfg(test)]
mod save_paste_file_tests {
    use super::*;

    fn temp_paste_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pure-paste-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_content_and_returns_absolute_path() {
        let dir = temp_paste_dir("basic");
        let path = write_paste_file(&dir, "pasted.txt", "line1\nline2").unwrap();
        assert!(path.ends_with("pasted.txt"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "line1\nline2");
    }

    #[test]
    fn strips_directory_components_from_name() {
        let dir = temp_paste_dir("traversal");
        // A hostile name must never escape the session tmp dir: the file lands
        // exactly in `dir`, never in dir/../.. — and no sibling is created.
        let path = write_paste_file(&dir, "../../evil.txt", "x").unwrap();
        assert_eq!(std::path::Path::new(&path), dir.join("evil.txt"));
        assert!(!dir.join("..").join("..").join("evil.txt").exists());
    }

    #[test]
    fn falls_back_to_default_name_when_empty() {
        let dir = temp_paste_dir("empty-name");
        let path = write_paste_file(&dir, "/", "x").unwrap();
        assert!(path.ends_with("pasted.txt"));
    }

    #[test]
    fn decodes_base64_and_writes_image_bytes() {
        use base64::Engine as _;
        let dir = temp_paste_dir("img-basic");
        let bytes = vec![0x89u8, b'P', b'N', b'G', 13, 10, 26, 10, 1, 2, 3];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let decoded = decode_paste_image(&b64).unwrap();
        assert_eq!(decoded, bytes);
        let path = write_paste_bytes(&dir, "shot.png", &decoded).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn rejects_malformed_base64() {
        assert!(decode_paste_image("@@not-base64@@").is_err());
        // Whitespace-only payload → decode error, never an empty silent file.
        assert!(decode_paste_image("   ").is_err());
    }

    #[test]
    fn save_file_binary_writes_decoded_bytes_to_path() {
        use base64::Engine as _;
        let dir = temp_paste_dir("save-file-binary");
        let path = dir.join("chart.png");
        let bytes = vec![0x89u8, b'P', b'N', b'G', 13, 10, 26, 10, 42, 43, 44];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        save_file_binary(path.to_string_lossy().to_string(), b64).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn save_file_binary_rejects_bad_base64_and_never_writes() {
        let dir = temp_paste_dir("save-file-binary-bad");
        let path = dir.join("bad.png");
        assert!(
            save_file_binary(path.to_string_lossy().to_string(), "@@nope@@".to_string()).is_err()
        );
        assert!(!path.exists());
    }

    #[test]
    fn image_name_is_sanitized_like_text() {
        let dir = temp_paste_dir("img-traversal");
        let path = write_paste_bytes(&dir, "../../evil.png", &[1, 2, 3]).unwrap();
        assert_eq!(std::path::Path::new(&path), dir.join("evil.png"));
    }
}

#[cfg(test)]
mod import_dropped_file_tests {
    use super::*;

    fn temp_import_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pure-import-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classifies_and_copies_text_without_overwriting() {
        let source_dir = temp_import_dir("text-source");
        let tmp_dir = temp_import_dir("text-dest");
        let source = source_dir.join("notes.txt");
        fs::write(&source, "hello dropped file").unwrap();
        let record = import_dropped_file_inner(&tmp_dir, &source).unwrap();
        assert_eq!(record["kind"], "text");
        assert_eq!(record["content"], "hello dropped file");
        assert_eq!(
            fs::read_to_string(record["path"].as_str().unwrap()).unwrap(),
            "hello dropped file"
        );
        fs::write(tmp_dir.join("notes.txt"), "existing").unwrap();
        let second = import_dropped_file_inner(&tmp_dir, &source).unwrap();
        assert_ne!(
            second["path"],
            tmp_dir.join("notes.txt").to_string_lossy().to_string()
        );
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn classifies_images_and_builds_a_data_url() {
        let source_dir = temp_import_dir("image-source");
        let tmp_dir = temp_import_dir("image-dest");
        let source = source_dir.join("shot.png");
        fs::write(&source, [0x89, b'P', b'N', b'G']).unwrap();
        let record = import_dropped_file_inner(&tmp_dir, &source).unwrap();
        assert_eq!(record["kind"], "image");
        assert!(record["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(
            fs::read(record["path"].as_str().unwrap()).unwrap(),
            [0x89, b'P', b'N', b'G']
        );
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn rejects_binary_files_and_accepts_directories() {
        let source_dir = temp_import_dir("binary-source");
        let tmp_dir = temp_import_dir("binary-dest");
        // An archive / executable (invalid UTF-8, unknown extension) must be
        // rejected, not attached.
        let source = source_dir.join("archive.bin");
        fs::write(&source, [0, 159, 146, 150]).unwrap();
        let err = import_dropped_file_inner(&tmp_dir, &source).unwrap_err();
        assert!(err.contains("binary"), "unexpected error: {err}");
        let folder = source_dir.join("folder");
        fs::create_dir_all(&folder).unwrap();
        let dir_record = import_dropped_file_inner(&tmp_dir, &folder).unwrap();
        assert_eq!(dir_record["isDirectory"], true);
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn rejects_archive_extensions() {
        let source_dir = temp_import_dir("zip-source");
        let tmp_dir = temp_import_dir("zip-dest");
        for ext in ["zip", "rar", "7z", "gz", "tar", "exe", "dmg"] {
            let source = source_dir.join(format!("pkg.{ext}"));
            fs::write(&source, b"PK\x03\x04 some bytes").unwrap();
            let result = import_dropped_file_inner(&tmp_dir, &source);
            assert!(result.is_err(), "{ext} should be rejected: {result:?}");
        }
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn imports_documents_without_parsing_content() {
        let source_dir = temp_import_dir("doc-source");
        let tmp_dir = temp_import_dir("doc-dest");
        for (name, bytes) in [
            ("report.pdf", b"%PDF-1.4 fake".as_slice()),
            ("plan.docx", b"PK\x03\x04 docx"),
        ] {
            let source = source_dir.join(name);
            fs::write(&source, bytes).unwrap();
            let record = import_dropped_file_inner(&tmp_dir, &source).unwrap();
            assert_eq!(record["kind"], "doc", "{name} should be a doc");
            assert_eq!(record["content"], "");
        }
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn rejects_files_over_the_size_limit() {
        let source_dir = temp_import_dir("big-source");
        let tmp_dir = temp_import_dir("big-dest");
        let source = source_dir.join("huge.txt");
        // A text file just over the 10 MB cap: must be rejected even though
        // the kind would otherwise be text.
        let big = vec![b'a'; (DROPPED_FILE_MAX_BYTES + 1) as usize];
        fs::write(&source, &big).unwrap();
        let err = import_dropped_file_inner(&tmp_dir, &source).unwrap_err();
        assert!(err.contains("exceeds"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(source_dir);
        let _ = fs::remove_dir_all(tmp_dir);
    }
}

#[cfg(test)]
mod tmp_cleanup_tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_cleanup_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pure-cleanup-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Backdate a file's mtime (and atime) by `days` via utimensat (libc).
    #[cfg(unix)]
    fn backdate_file(path: &std::path::Path, days: i64) {
        use std::ffi::CString;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        let ts = libc::timespec {
            tv_sec: now - days * 86400,
            tv_nsec: 0,
        };
        let times = [ts, ts];
        let cpath = CString::new(path.to_str().unwrap()).unwrap();
        unsafe {
            libc::utimensat(libc::AT_FDCWD, cpath.as_ptr(), times.as_ptr(), 0);
        }
    }

    #[test]
    fn older_than_is_pure_and_strict() {
        let now = SystemTime::now();
        let ten_days = now - Duration::from_secs(10 * 86400);
        let just_now = now - Duration::from_secs(60);
        assert!(older_than(ten_days, now, 7));
        assert!(!older_than(just_now, now, 7));
        // Exactly at the cutoff counts as old (>=).
        let exactly = now - Duration::from_secs(7 * 86400);
        assert!(older_than(exactly, now, 7));
        // Future mtime (clock skew) → never old.
        assert!(!older_than(now + Duration::from_secs(3600), now, 7));
    }

    #[test]
    fn scan_finds_paste_files_in_session_dirs_only() {
        let dir = temp_cleanup_dir("scan");
        let session = dir.join("aabbcc");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("pasted-1.txt"), "x").unwrap();
        fs::write(session.join("pasted-2.png"), "12345").unwrap();
        fs::write(session.join("dropped-report.pdf"), "123456").unwrap();
        fs::write(session.join("notes.txt"), "keep").unwrap();
        // A dir whose name carries the prefix must NOT be treated as a file.
        fs::create_dir_all(session.join("pasted-dir")).unwrap();
        let files = scan_all_paste_files(&dir);
        assert_eq!(files.len(), 3);
        let bytes: u64 = files.iter().map(|f| f.size).sum();
        assert_eq!(bytes, 12);
    }

    #[test]
    fn cleanup_deletes_only_aged_pastes() {
        let dir = temp_cleanup_dir("age");
        let session = dir.join("sess1");
        fs::create_dir_all(&session).unwrap();
        let old = session.join("pasted-old.txt");
        let fresh = session.join("pasted-new.txt");
        let other = session.join("notes.txt");
        fs::write(&old, "12345").unwrap();
        fs::write(&fresh, "1").unwrap();
        fs::write(&other, "keep").unwrap();
        backdate_file(&old, 10);

        let (deleted, freed) = cleanup_paste_files_in(&dir, 7).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(freed, 5);
        assert!(!old.exists(), "old paste removed");
        assert!(fresh.exists(), "fresh paste kept");
        assert!(other.exists(), "non-paste file untouched");
    }

    #[test]
    fn cleanup_removes_session_dirs_left_empty() {
        let dir = temp_cleanup_dir("empty");
        let session = dir.join("hexses");
        fs::create_dir_all(&session).unwrap();
        let old = session.join("pasted-old.txt");
        fs::write(&old, "abc").unwrap();
        backdate_file(&old, 10);

        let (deleted, freed) = cleanup_paste_files_in(&dir, 7).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(freed, 3);
        assert!(!session.exists(), "empty session dir removed");
    }

    #[test]
    fn fresh_files_survive_zero_day_cleanup() {
        let dir = temp_cleanup_dir("zero");
        fs::write(dir.join("pasted-today.txt"), "today").unwrap();
        let (deleted, _) = cleanup_paste_files_in(&dir, 1).unwrap();
        assert_eq!(deleted, 0);
        assert!(dir.join("pasted-today.txt").exists());
    }
}

// ── Per-session stats persistence tests (~/.pure/sessions/<id>/stats.json) ──
#[cfg(test)]
mod session_stats_tests {
    use super::*;

    fn temp_home(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pure-stats-{}-{}", label, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// Point HOME at a temp dir for the duration of the closure so
    /// `sessions_dir()` resolves inside it.
    fn with_temp_home<T>(dir: &std::path::Path, f: impl FnOnce() -> T) -> T {
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", dir);
        let result = f();
        match old {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        result
    }

    // One test, three checks: `std::env::set_var("HOME", ...)` is process-global,
    // so separate parallel tests would clobber each other's HOME. Run sequentially.
    #[test]
    fn stats_roundtrip_missing_and_delete() {
        let home = temp_home("seq");
        let _ = fs::create_dir_all(&home);
        let stats = serde_json::json!({
            "provider": "deepseek-openai",
            "usage": { "promptTokens": 100, "completionTokens": 50, "cacheHitTokens": 30, "cacheMissTokens": 70 },
            "searches": [{ "query": "rust", "ts": 1 }],
            "fileWrites": [{ "path": "/a/b.ts", "ts": 2, "success": true }],
            "fileReads": [{ "path": "/a/c.ts", "ts": 3 }],
            "commands": [{ "command": "cargo test", "ts": 4, "success": false }],
        });

        with_temp_home(&home, || {
            // 1) Missing file → None.
            assert!(load_session_stats("sess-1".to_string()).unwrap().is_none());

            // 2) Save then load round-trips verbatim, as a real file in the session dir.
            save_session_stats("sess-1".to_string(), stats.clone()).unwrap();
            let loaded = load_session_stats("sess-1".to_string()).unwrap().unwrap();
            assert_eq!(loaded, stats);
            assert!(sessions_dir().join("sess-1").join("stats.json").exists());

            // 3) delete_session removes the stats file together with the directory.
            delete_session("sess-1".to_string()).unwrap();
            assert!(load_session_stats("sess-1".to_string()).unwrap().is_none());

            // 4) Bulk load collects every session into a map keyed by id.
            let stats_a = serde_json::json!({ "usage": { "promptTokens": 10 }, "searches": [] });
            let stats_b = serde_json::json!({ "usage": { "promptTokens": 20 }, "commands": [] });
            save_session_stats("sess-a".to_string(), stats_a.clone()).unwrap();
            save_session_stats("sess-b".to_string(), stats_b.clone()).unwrap();
            // A session dir WITHOUT stats.json must be skipped, not fatal.
            let dir = sessions_dir().join("sess-no-stats");
            fs::create_dir_all(&dir).unwrap();

            let all = load_all_session_stats(None).unwrap();
            let map = all.as_object().unwrap();
            assert_eq!(map.len(), 2);
            assert_eq!(map["sess-a"], stats_a);
            assert_eq!(map["sess-b"], stats_b);
            assert!(!map.contains_key("sess-no-stats"));

            // 5) An allow-list narrows the read to exactly those sessions (the
            // sidebar passes its visible ids; the full sweep stays the default).
            let subset = load_all_session_stats(Some(vec!["sess-b".to_string()])).unwrap();
            let sub_map = subset.as_object().unwrap();
            assert_eq!(sub_map.len(), 1);
            assert_eq!(sub_map["sess-b"], stats_b);
            assert!(!sub_map.contains_key("sess-a"));
            // A requested id without a stats file is simply absent, not fatal.
            let missing = load_all_session_stats(Some(vec!["nope".to_string()])).unwrap();
            assert_eq!(missing.as_object().unwrap().len(), 0);
        });
        let _ = fs::remove_dir_all(&home);
    }
}
