// src-tauri/src/lib.rs
// v0.7 — Full IPC backend with file tools, git, session, LLM streaming, MCP, secrets, file watching.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};

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

async fn mcp_call_inner(handle: &McpHandle, request: &str) -> Result<String, String> {
    // Write request to stdin
    {
        let mut stdin = handle.stdin.lock().await;
        stdin.write_all(request.as_bytes()).await.map_err(|e| format!("write stdin: {}", e))?;
        stdin.write_all(b"\n").await.map_err(|e| format!("write newline: {}", e))?;
        stdin.flush().await.map_err(|e| format!("flush stdin: {}", e))?;
    }

    // Read response from stdout (one line = one JSON-RPC response)
    let mut line = String::new();
    {
        let mut stdout = handle.stdout.lock().await;
        stdout.read_line(&mut line).await.map_err(|e| format!("read stdout: {}", e))?;
    }

    Ok(line.trim().to_string())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File Tools
// ═══════════════════════════════════════════════════════════════════════════════

fn resolve(workspace: &str, path: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(workspace);
    let base_canonical = std::fs::canonicalize(&base).unwrap_or_else(|_| base.clone());
    let joined = base_canonical.join(path);
    let mut stack: Vec<PathBuf> = Vec::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                stack.pop();
            }
            std::path::Component::Normal(_) => {
                stack.push(PathBuf::from(c.as_os_str()));
            }
            _ => {}
        }
    }
    let normalized: PathBuf = stack.iter().collect();
    let full = base_canonical.join(&normalized);
    let canonical = std::fs::canonicalize(&full).unwrap_or_else(|_| full.clone());
    if !canonical.starts_with(&base_canonical) {
        return Err(format!("path escapes workspace: {}", path));
    }
    Ok(canonical)
}

#[tauri::command]
fn read_file(workspace: String, path: String) -> Result<String, String> {
    let full = resolve(&workspace, &path)?;
    fs::read_to_string(&full).map_err(|e| format!("read_file: {}", e))
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

    let _idx = text.find(&old_string).ok_or_else(|| {
        format!(
            "String not found in file: {}",
            &old_string[..old_string.len().min(100)]
        )
    })?;

    let occurrences = text.matches(&old_string).count();
    let multi = allow_multiple.unwrap_or(false);

    if occurrences > 1 && !multi {
        return Err(format!(
            "Found {} occurrences. Set allow_multiple:true to replace all, or provide more context.",
            occurrences
        ));
    }

    let new_text = if multi {
        text.replace(&old_string, &new_string)
    } else {
        text.replacen(&old_string, &new_string, 1)
    };

    fs::write(&full, &new_text).map_err(|e| format!("write: {}", e))?;
    Ok(format!(
        "Replaced {} occurrence(s) in {}",
        if multi { occurrences } else { 1 },
        path
    ))
}

#[tauri::command]
fn search_files(
    workspace: String,
    pattern: String,
    path: Option<String>,
    file_pattern: Option<String>,
    max_results: Option<usize>,
) -> Result<String, String> {
    let search_dir = match &path {
        Some(p) => resolve(&workspace, p)?,
        None => resolve(&workspace, ".")?,
    };

    let max = max_results.unwrap_or(50);
    let glob_pattern = file_pattern.unwrap_or_else(|| "**/*".to_string());
    let glob_pattern = format!("{}/{}", search_dir.to_string_lossy(), glob_pattern);

    let mut results: Vec<String> = Vec::new();

    for entry in glob::glob(&glob_pattern).map_err(|e| format!("glob: {}", e))? {
        if results.len() >= max {
            break;
        }
        let entry_path = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !entry_path.is_file() {
            continue;
        }

        let content = match fs::read_to_string(&entry_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let rel_path = entry_path
            .strip_prefix(&search_dir)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .to_string();

        for (line_no, line) in content.lines().enumerate() {
            if results.len() >= max {
                break;
            }
            if line.contains(&pattern) {
                results.push(format!("{}:{}: {}", rel_path, line_no + 1, line.trim()));
            }
        }
    }

    if results.is_empty() {
        Ok(format!("No matches found for \"{}\"", pattern))
    } else {
        Ok(results.join("\n"))
    }
}

#[tauri::command]
fn list_files(workspace: String, path: String, recursive: Option<bool>) -> Result<String, String> {
    let dir = resolve(&workspace, &path)?;
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut items: Vec<String> = Vec::new();

    if recursive.unwrap_or(false) {
        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let rel = entry.path().strip_prefix(&dir).unwrap_or(entry.path());
            items.push(rel.to_string_lossy().to_string());
        }
    } else {
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))?;
        for entry in read_dir {
            let entry = entry.map_err(|e| format!("entry: {}", e))?;
            items.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    items.sort();
    if items.is_empty() {
        Ok("(empty directory)".to_string())
    } else {
        Ok(items.join("\n"))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Async Command Execution (non-blocking tokio version)
// ═══════════════════════════════════════════════════════════════════════════════

/// Execute a shell command and return all output at once.
/// Uses tokio::process::Command so it does NOT block the async runtime.
#[tauri::command]
async fn execute_command(workspace: String, command: String) -> Result<String, String> {
    let output = TokioCommand::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&workspace)
        .output()
        .await
        .map_err(|e| format!("execute_command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("[stderr]\n");
        result.push_str(&stderr);
    }
    if output.status.code() != Some(0) && result.is_empty() {
        result = format!("exit code: {}", output.status.code().unwrap_or(-1));
    }
    Ok(result)
}

/// Execute a shell command with streaming output via Channel (safe concurrent reader pattern).
/// Uses `tokio::spawn` + `tokio::join!` so both stdout and stderr are read independently
/// — no data loss when one pipe closes before the other.
#[tauri::command]
async fn execute_command_stream(
    workspace: String,
    command: String,
    on_output: Channel<String>,
) -> Result<i32, String> {
    let mut child = TokioCommand::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

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
                    if ch_stdout.send(chunk.to_string()).is_err() { break; }
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
                    if ch_stderr.send(chunk.to_string()).is_err() { break; }
                }
                Err(_) => break,
            }
        }
    });

    // Wait for both readers to finish independently
    let _ = tokio::join!(stdout_task, stderr_task);

    // Now get the exit code (on_output is still available since only clones were moved)
    let exit_code = child.wait().await.map_err(|e| format!("wait: {}", e))?.code().unwrap_or(-1);
    let done = serde_json::json!({ "type": "exit", "code": exit_code });
    let _ = on_output.send(done.to_string());

    Ok(exit_code)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Git Tools
// ═══════════════════════════════════════════════════════════════════════════════

fn run_git(workspace: &str, args: &[String]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|e| format!("git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let msg = if stderr.is_empty() {
            stdout
        } else {
            stderr
        };
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
//  MCP Subprocess Commands
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn spawn_mcp(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<String, String> {
    let key = mcp_key(&session_id, &name);

    let mut child = TokioCommand::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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
async fn mcp_request(
    state: tauri::State<'_, McpRegistry>,
    session_id: String,
    name: String,
    request: String,
) -> Result<String, String> {
    let key = mcp_key(&session_id, &name);
    let handle = {
        let registry = state.lock().await;
        registry.get(&key).ok_or_else(|| format!("MCP not found: {}", key))?.clone()
    };
    mcp_call_inner(&handle, &request).await
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
async fn mcp_list(state: tauri::State<'_, McpRegistry>, session_id: String) -> Result<Vec<String>, String> {
    let registry = state.lock().await;
    let keys: Vec<String> = registry
        .keys()
        .filter(|k| k.starts_with(&format!("{}:", session_id)))
        .cloned()
        .collect();
    Ok(keys)
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
    Ok(secrets.get(&key).and_then(|v| v.as_str()).map(|s| s.to_string()))
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
//  File Watching (notify crate + Channel)
// ═══════════════════════════════════════════════════════════════════════════════

// Track active watchers globally so we can stop them
type WatcherRegistry = StdMutex<BTreeMap<String, notify::RecommendedWatcher>>;

#[tauri::command]
async fn watch_files(
    state: tauri::State<'_, WatcherRegistry>,
    session_id: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                EventKind::Modify(_) => "change",
                EventKind::Create(_) => "create",
                EventKind::Remove(_) => "delete",
                _ => return, // ignore other events
            };

            for path in &event.paths {
                let payload = serde_json::json!({
                    "type": kind,
                    "path": path.to_string_lossy(),
                    "timestamp": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                });
                let _ = on_event.send(payload.to_string());
            }
        }
    })
    .map_err(|e| format!("create watcher: {}", e))?;

    watcher
        .watch(
            std::path::Path::new("."),
            RecursiveMode::Recursive,
        )
        .map_err(|e| format!("watch: {}", e))?;

    let mut registry = state.lock().map_err(|e| format!("lock: {}", e))?;
    registry.insert(session_id, watcher);

    Ok(())
}

#[tauri::command]
async fn unwatch_files(
    state: tauri::State<'_, WatcherRegistry>,
    session_id: String,
) -> Result<(), String> {
    let mut registry = state.lock().map_err(|e| format!("lock: {}", e))?;
    registry.remove(&session_id);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LLM Transport (reqwest HTTP/2 SSE → Channel)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Deserialize)]
struct ChatStreamArgs {
    messages: Vec<serde_json::Value>,
    #[serde(default)]
    tools: Vec<serde_json::Value>,
    model: String,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "baseUrl")]
    base_url: String,
    #[serde(default, rename = "extraBody")]
    extra_body: Option<serde_json::Value>,
    #[serde(default, rename = "maxTokens")]
    max_tokens_override: Option<u32>,
    #[serde(default)]
    temperature: Option<f64>,
}

#[tauri::command]
async fn chat_stream(
    args: ChatStreamArgs,
    on_chunk: Channel<String>,
) -> Result<serde_json::Value, String> {
    // The API key never travels through the WebView: when the frontend omits
    // it, resolve from the secrets store (~/.pure/secrets.json, 0600).
    let api_key = if args.api_key.is_empty() {
        load_secrets()?
            .get("llm.apiKey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default()
    } else {
        args.api_key
    };
    if api_key.is_empty() {
        return Err("No API key configured. Set one in Settings.".into());
    }

    let base_url = if args.base_url.trim().is_empty() {
        "https://api.deepseek.com".to_string()
    } else {
        args.base_url.trim_end_matches('/').to_string()
    };
    let url = format!("{}/chat/completions", base_url);

    let client = reqwest::Client::new();
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

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
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

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut text = String::new();
    let mut tc_map: BTreeMap<u32, serde_json::Value> = BTreeMap::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].to_string();
            buffer = buffer[line_end + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = line[6..].trim().to_string();
            if data == "[DONE]" {
                break;
            }

            let json: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

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

            // Accumulate tool_calls
            if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    let idx = tc["index"].as_u64().unwrap_or(0) as u32;
                    let cur = tc_map.entry(idx).or_insert_with(|| {
                        serde_json::json!({"id": "", "name": "", "arguments": ""})
                    });
                    if let Some(id) = tc["id"].as_str() {
                        cur["id"] = serde_json::Value::String(id.to_string());
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        cur["name"] = serde_json::Value::String(name.to_string());
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        cur["arguments"] = serde_json::Value::String(format!(
                            "{}{}",
                            cur["arguments"].as_str().unwrap_or(""),
                            args
                        ));
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

    Ok(serde_json::json!({ "text": text, "toolCalls": tool_calls }))
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Session Persistence (~/.pure/sessions/)
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone)]
struct SessionData {
    messages: Vec<serde_json::Value>,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    #[serde(rename = "messageCount")]
    message_count: usize,
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
}

fn sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pure").join("sessions")
}

#[tauri::command]
fn save_session(session_id: String, messages: Vec<serde_json::Value>) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let data = SessionData {
        message_count: messages.len(),
        updated_at: now,
        messages,
    };

    let data_path = dir.join("session.json");
    fs::write(&data_path, serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|e| format!("write: {}", e))?;

    let title = extract_title(&data.messages);
    update_sessions_index(&session_id, &title, data.message_count, now)?;

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
    Ok(Some(serde_json::json!({
        "sessionId": session_id,
        "messages": data.messages,
        "updatedAt": data.updated_at,
        "messageCount": data.message_count,
    })))
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
            })
        })
        .collect())
}

#[tauri::command]
fn delete_session(session_id: String) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove: {}", e))?;
    }
    let index_path = sessions_dir().join("index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        let mut list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
        list.retain(|s| s.id != session_id);
        fs::write(&index_path, serde_json::to_string_pretty(&list).unwrap_or_default())
            .map_err(|e| format!("write: {}", e))?;
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
        created_at: existing
            .map(|i| list[i].created_at)
            .unwrap_or(updated_at),
        updated_at,
        message_count,
    };

    if let Some(i) = existing {
        list[i] = meta;
    } else {
        list.push(meta);
    }

    fs::write(&index_path, serde_json::to_string_pretty(&list).unwrap_or_default())
        .map_err(|e| format!("write: {}", e))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tauri App Entry
// ═══════════════════════════════════════════════════════════════════════════════

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(McpRegistry::new(BTreeMap::new()))
        .manage(WatcherRegistry::new(BTreeMap::new()))
        .invoke_handler(tauri::generate_handler![
            // File tools
            read_file, write_file, edit_file, search_files, list_files,
            // Command execution
            execute_command, execute_command_stream,
            // Git tools
            git_diff, git_log, git_status,
            // MCP subprocess
            spawn_mcp, mcp_request, mcp_shutdown, mcp_list,
            // Secret management
            secret_get, secret_set, secret_delete, secret_list,
            // File watching
            watch_files, unwatch_files,
            // LLM transport
            chat_stream,
            // Session persistence
            save_session, load_session, load_last_session, load_session_list, delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pure");
}
