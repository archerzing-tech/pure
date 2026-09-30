// src-tauri/src/mcp.rs
// P3-1 第二刀（2026-09-30，lib.rs 拆分）— MCP 命令层：子进程 spawn/HTTP 转发/
// JSON-RPC request/notify/shutdown/list + 6.4 OAuth loopback 接收器与令牌库。
// 从 lib.rs 整段搬出（机械移动零语义变化）。切缝=「命令层」与「子进程传输层」
// 的分界：McpHandle / McpRegistry / mcp_key / mcp_call_inner 等底层传输仍住
// lib.rs（6.3 投毒扫描等也在那侧），本模块经 crate:: 反向引用；对 lib.rs 暴露
// 的是 12 个 tauri command 与 OAuthLoopbackRegistry（run() 的 .manage 用）。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

use crate::{
    augmented_mcp_path, build_http_client, mcp_call_inner, mcp_key, pure_home_dir, resolve_proxy_auth,
    silent_child_tokio, valid_proxy_url, McpHandle, McpRegistry,
};

//  MCP Subprocess Commands
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn spawn_mcp(
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
pub async fn mcp_http_request(
    url: String,
    method: String,
    body: Option<String>,
    proxy_url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    timeout_secs: Option<u64>,
    return_headers: Option<bool>,
    content_type: Option<String>,
) -> Result<String, String> {
    let client = build_http_client(
        std::time::Duration::from_secs(timeout_secs.unwrap_or(30).max(1)),
        proxy_url.as_deref(),
    )?;
    let mut request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("unsupported MCP HTTP method: {}", other)),
    };
    if let Some(extra) = &headers {
        for (name, value) in extra {
            request = request.header(name, value);
        }
    }
    if let Some(body) = body {
        // OAuth token requests post form-encoded bodies; JSON-RPC posts JSON.
        request = request
            .header(
                "Content-Type",
                content_type.as_deref().unwrap_or("application/json"),
            )
            .body(body);
    }
    let response = request.send().await.map_err(|e| format!("request: {}", e))?;
    let status = response.status();
    // Headers must be read before `.text()` consumes the response.
    let header_value = |name: &str| -> Option<String> {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let session_id = header_value("mcp-session-id");
    let resp_content_type = header_value("content-type");
    let www_authenticate = header_value("www-authenticate");
    // Envelope-mode callers (OAuth login) need to see 401s — the status and the
    // WWW-Authenticate challenge drive the discovery flow. Plain callers keep
    // the legacy "non-2xx is an error" contract.
    if !status.is_success() && !return_headers.unwrap_or(false) {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("MCP HTTP {}: {}", status.as_u16(), text));
    }
    let text = response.text().await.map_err(|e| format!("read: {}", e))?;
    if return_headers.unwrap_or(false) {
        let mut envelope = serde_json::Map::new();
        envelope.insert("__status".into(), serde_json::json!(status.as_u16()));
        let mut header_map = serde_json::Map::new();
        if let Some(sid) = &session_id {
            header_map.insert("mcp-session-id".into(), serde_json::json!(sid));
        }
        if let Some(ct) = &resp_content_type {
            header_map.insert("content-type".into(), serde_json::json!(ct));
        }
        if let Some(wa) = &www_authenticate {
            header_map.insert("www-authenticate".into(), serde_json::json!(wa));
        }
        envelope.insert("__headers".into(), serde_json::Value::Object(header_map));
        envelope.insert("body".into(), serde_json::json!(text));
        Ok(serde_json::Value::Object(envelope).to_string())
    } else {
        Ok(text)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP OAuth (6.4): loopback redirect receiver + token store.
//
//  The login flow itself runs in TypeScript (src/adapter/mcp/oauth.ts); Rust
//  owns the two pieces TypeScript cannot do on its own: a 127.0.0.1 loopback
//  listener that catches the provider's redirect, and
//  ~/.pure/mcp/oauth/<server>.json (0600) keeping access/refresh tokens out of
//  WebView storage.
// ═══════════════════════════════════════════════════════════════════════════════

/// One pending login: the accept-loop task plus the one-shot channel that
/// hands the full redirect URL to `mcp_oauth_loopback_wait`.
pub(crate) struct OAuthLoopbackFlow {
    task: tokio::task::JoinHandle<()>,
    redirect: tokio::sync::oneshot::Receiver<String>,
}

pub(crate) type OAuthLoopbackRegistry = tokio::sync::Mutex<BTreeMap<String, OAuthLoopbackFlow>>;

static NEXT_LOOPBACK_FLOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub async fn mcp_oauth_loopback_start(
    state: tauri::State<'_, OAuthLoopbackRegistry>,
    preferred_port: Option<u16>,
) -> Result<serde_json::Value, String> {
    // A preferred port may collide with a leftover socket — fall back to an
    // ephemeral one so a login never blocks on stale cleanup.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", preferred_port.unwrap_or(0))).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("bind loopback: {}", e))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {}", e))?
        .port();
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let task = tokio::spawn(async move {
        // Accept exactly one connection — the provider's redirect request.
        let Ok((mut socket, _)) = listener.accept().await else { return; };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match socket.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 64 * 1024 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Request line: `GET /callback?code=…&state=… HTTP/1.1`
        let head = String::from_utf8_lossy(&buf);
        let target = head.split_whitespace().nth(1).unwrap_or("");
        let redirect = if target.starts_with("http://") || target.starts_with("https://") {
            target.to_string()
        } else {
            format!("http://127.0.0.1:{}{}", port, target)
        };
        let body = "<!doctype html><meta charset=\"utf-8\"><title>pure</title><body style=\"font-family:-apple-system,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><p>登录完成 — 请回到 pure 窗口继续。</p></body>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
        let _ = tx.send(redirect);
    });
    let flow_id = format!(
        "oauth-loopback-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        NEXT_LOOPBACK_FLOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    state.lock().await.insert(
        flow_id.clone(),
        OAuthLoopbackFlow { task, redirect: rx },
    );
    Ok(serde_json::json!({ "flowId": flow_id, "port": port }))
}

/// Resolve the callback URL of a started flow. One-shot: the flow is consumed
/// either here or by cancel.
#[tauri::command]
pub async fn mcp_oauth_loopback_wait(
    state: tauri::State<'_, OAuthLoopbackRegistry>,
    flow_id: String,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let flow = {
        let mut registry = state.lock().await;
        registry
            .remove(&flow_id)
            .ok_or_else(|| format!("OAuth 回调流程不存在或已被消费: {}", flow_id))?
    };
    let OAuthLoopbackFlow { task, redirect } = flow;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(300).max(1));
    match tokio::time::timeout(timeout, redirect).await {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(_)) => Err("OAuth 回调通道已关闭（流程被取消）".into()),
        Err(_) => {
            task.abort();
            Err("等待 OAuth 回调超时".into())
        }
    }
}

#[tauri::command]
pub async fn mcp_oauth_loopback_cancel(
    state: tauri::State<'_, OAuthLoopbackRegistry>,
    flow_id: String,
) -> Result<(), String> {
    if let Some(flow) = state.lock().await.remove(&flow_id) {
        flow.task.abort();
    }
    Ok(())
}

// Token persistence: ~/.pure/mcp/oauth/<server>.json — same 0600 contract as
// secrets.json. The payload is the StoredOAuth JSON the TS side owns; Rust
// treats it as opaque bytes.

fn mcp_oauth_token_path(server: &str) -> Result<PathBuf, String> {
    // Server names double as file names: keep them to a safe charset so the
    // path stays inside the oauth dir (validity check, not a scope limit).
    let safe: String = server
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        return Err("MCP 服务器名不能为空".into());
    }
    Ok(PathBuf::from(pure_home_dir())
        .join(".pure")
        .join("mcp")
        .join("oauth")
        .join(format!("{}.json", safe)))
}

#[tauri::command]
pub fn mcp_oauth_token_read(server: String) -> Result<Option<String>, String> {
    let path = mcp_oauth_token_path(&server)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read oauth tokens: {}", e))
}

#[tauri::command]
pub fn mcp_oauth_token_write(server: String, payload: String) -> Result<(), String> {
    let path = mcp_oauth_token_path(&server)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::write(&path, payload.as_bytes()).map_err(|e| format!("write oauth tokens: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_oauth_token_delete(server: String) -> Result<(), String> {
    let path = mcp_oauth_token_path(&server)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete oauth tokens: {}", e)),
    }
}

#[tauri::command]
pub async fn mcp_request(
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
pub async fn mcp_notify(
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
pub async fn mcp_shutdown(
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
pub async fn mcp_list(
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
