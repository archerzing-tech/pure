// src-tauri/src/lib.rs
// v0.7 — Full IPC backend with file tools, git, session, LLM streaming, MCP, secrets, file watching.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

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
//  Async Command Execution (non-blocking tokio version)
// ═══════════════════════════════════════════════════════════════════════════════

/// Execute a shell command and return all output at once.
/// Uses tokio::process::Command so it does NOT block the async runtime.
/// Returns structured `{ exitCode, stdout, stderr }` so the frontend can tell
/// a failed command (non-zero exit) apart from a successful one instead of
/// squashing everything into a `success: true` string.
#[tauri::command]
async fn execute_command(workspace: String, command: String) -> Result<serde_json::Value, String> {
    let output = TokioCommand::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&workspace)
        .output()
        .await
        .map_err(|e| format!("execute_command: {}", e))?;

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
fn spawn_shell_command(workspace: &str, command: &str) -> std::io::Result<Child> {
    let mut cmd = TokioCommand::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
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
        if err.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(err) }
    }
}

#[cfg(not(unix))]
fn kill_process_group(pid: i32) -> std::io::Result<()> {
    let ret = unsafe { libc::kill(pid, libc::SIGKILL) };
    if ret == 0 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(err) }
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
) -> Result<i32, String> {
    let mut child = spawn_shell_command(workspace, command).map_err(|e| format!("spawn: {}", e))?;

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

    let wait_result = child.wait().await;

    // Always unregister, even when wait failed (the process may already be
    // gone) — a stale entry would make a later kill_command target a reused
    // pid and kill an unrelated process.
    if !id.is_empty() {
        let mut reg = registry.lock().map_err(|e| format!("lock: {}", e))?;
        reg.remove(id);
    }

    // Now get the exit code (on_output is still available since only clones were moved)
    let exit_code = wait_result.map_err(|e| format!("wait: {}", e))?.code().unwrap_or(-1);
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
) -> Result<i32, String> {
    execute_command_stream_inner(&state, &id, &workspace, &command, &on_output).await
}

/// Kill a running command started via execute_command_stream. The GUI calls
/// this when the turn is cancelled (Stop button): the shell tree is SIGKILLed
/// as a process group so grandchildren don't survive as background orphans.
/// No-op when the id is unknown (already exited or never registered).
#[tauri::command]
async fn kill_command(
    state: tauri::State<'_, CommandRegistry>,
    id: String,
) -> Result<(), String> {
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

    let output = std::process::Command::new("diff")
        .arg("-u")
        .arg(&full_a)
        .arg(&full_b)
        .output()
        .map_err(|e| format!("diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    match output.status.code() {
        Some(0) => Ok("(files are identical)".to_string()),
        Some(1) => Ok(if stdout.is_empty() { stderr } else { stdout }),
        _ => Err(if stderr.is_empty() { "diff failed".to_string() } else { stderr }),
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

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async fn fetch_search_page(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client: {}", e))?;
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
    resp.text().await.map_err(|e| format!("read: {}", e))
}

async fn search_backend_duckduckgo(query: &str, max: usize) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));
    let html = fetch_search_page(&url).await?;
    Ok(parse_duckduckgo_results(&html, max))
}

async fn search_backend_bing(query: &str, max: usize) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://www.bing.com/search?q={}&count={}", urlencoding(query), max);
    let html = fetch_search_page(&url).await?;
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
async fn search_backend_bing_cn(query: &str, max: usize) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://cn.bing.com/search?q={}&count={}", urlencoding(query), max);
    let html = fetch_search_page(&url).await?;
    Ok(parse_bing_results(&html, max))
}

#[tauri::command]
async fn web_search(
    _workspace: String,
    query: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    let max = max_results.unwrap_or(10).min(20);

    let mut results: Vec<SearchResult> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut any_empty = false;

    // Backend order: CJK queries hit cn.bing.com FIRST (international Bing /
    // DuckDuckGo return irrelevant results for Chinese), then DuckDuckGo, then
    // www.bing.com. Non-CJK keeps the established DuckDuckGo → Bing order. A
    // backend that errors OR returns nothing rolls over to the next one, so
    // challenge pages and empty result sets degrade gracefully instead of
    // failing the search.
    let backends: &[&str] = if is_chinese_query(&query) {
        &["cn.bing.com", "DuckDuckGo", "Bing"]
    } else {
        &["DuckDuckGo", "Bing"]
    };
    for backend in backends {
        if !results.is_empty() { break; }
        // Explicit arms only — a future backend added to the order list must
        // name its fetch here instead of silently falling through to Bing.
        let attempt: Result<Vec<SearchResult>, String> = match *backend {
            "cn.bing.com" => search_backend_bing_cn(&query, max).await,
            "DuckDuckGo" => search_backend_duckduckgo(&query, max).await,
            "Bing" => search_backend_bing(&query, max).await,
            _ => unreachable!("unknown web_search backend label: {}", backend),
        };
        match attempt {
            Ok(r) if !r.is_empty() => results = r,
            Ok(_) => any_empty = true,
            Err(e) => failed.push(format!("{}: {}", backend, e)),
        }
    }

    if results.is_empty() {
        // At least one backend answered with an empty result set: the search
        // infrastructure works, the query just has no hits — rephrase, don't
        // repeat. (Other backends may have been unreachable; either way the
        // actionable guidance is the same.)
        if any_empty {
            return Ok(format!(
                "No results found for \"{}\" on the available search backends (cn.bing.com, DuckDuckGo, Bing). Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to contain the information.",
                query
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

    Ok(output.join("\n\n"))
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
        let Some(idx) = rest.find("<li class=\"b_algo") else { break };
        let tail = &rest[idx..];
        let Some(li_end) = tail.find("</li>") else { break };
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
    let snippet = block.find("<p").and_then(|p| {
        let after_p = &block[p..];
        let gt = after_p.find('>')?;
        let content = &after_p[gt + 1..];
        let end = content.find("</p>")?;
        Some(strip_html_tags(&content[..end]))
    }).unwrap_or_default();

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
        assert_eq!(results[1].url, "https://www.runoob.com/rust/rust-tutorial.html?a=1&b=2");
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
}


#[cfg(test)]
mod execute_command_tests {
    use super::*;

    #[tokio::test]
    async fn reports_success_with_zero_exit() {
        let out = execute_command(".".to_string(), "echo hello".to_string()).await.unwrap();
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn reports_failure_with_nonzero_exit_and_stderr() {
        let out = execute_command(".".to_string(), "echo boom >&2; exit 3".to_string()).await.unwrap();
        assert_eq!(out["exitCode"], 3);
        assert!(out["stderr"].as_str().unwrap().contains("boom"));
    }

    #[tokio::test]
    async fn keeps_stdout_even_when_command_fails() {
        let out = execute_command(".".to_string(), "echo partial; exit 2".to_string()).await.unwrap();
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

            let status = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                child.wait(),
            )
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
        let code = execute_command_stream_inner(&registry, "test-call-1", ".", "echo hello", &ch)
            .await
            .unwrap();
        assert_eq!(code, 0);
        let reg = registry.lock().unwrap();
        assert!(!reg.contains_key("test-call-1"), "registry must be cleaned up after the command finishes");
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
            execute_command_stream_inner(&reg_for_task, &id_for_task, ".", "sleep 30", &ch_for_task)
                .await
                .unwrap_or(-1)
        });

        // Give the command a moment to spawn and register itself.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let pid = {
            let reg = registry.lock().unwrap();
            reg.get(&id).copied()
        };
        assert!(pid.is_some(), "running command must be registered while alive");
        kill_process_group(pid.unwrap() as i32).unwrap();

        let code = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("killed command should exit promptly")
            .unwrap();
        assert_ne!(code, 0, "killed command must report a non-zero exit code");

        let reg = registry.lock().unwrap();
        assert!(!reg.contains_key(&id), "registry must be cleaned up after the kill");
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
) -> Result<String, String> {
    let max = max_chars.unwrap_or(20000);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    let resp = client
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Fetch failed: HTTP {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Accept any text-ish media type so the model doesn't hit the same
    // "unsupported content type" wall repeatedly on JSON/XML/JS/CSV pages or
    // when a server omits the header. Only clearly binary payloads (images,
    // media, archives, PDFs, octet-stream) are rejected — and the error tells
    // the model how to recover instead of just what failed.
    if !is_textual_content_type(&content_type) {
        // Empty content-type never reaches this branch (helper returns true),
        // so content_type is always a non-empty binary type here.
        return Err(format!(
            "Unsupported content type: {} — the URL serves a non-text payload, so web_fetch cannot extract readable text from it. Do NOT retry web_fetch on this URL; instead use web_search to find a text/HTML page with the information, or pick a different URL.",
            content_type
        ));
    }

    let html = resp.text().await.map_err(|e| format!("read: {}", e))?;
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
        Ok("(empty page)".to_string())
    } else {
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
            && chars[i..i + 7].iter().collect::<String>().eq_ignore_ascii_case("<script")
            && matches!(
                chars.get(i + 7).copied(),
                None | Some('>') | Some(' ') | Some('\t') | Some('\n') | Some('\r')
            )
        {
            in_skip = true;
            skip_tag = "script".to_string();
        } else if i + 5 < chars.len()
            && chars[i..i + 6].iter().collect::<String>().eq_ignore_ascii_case("<style")
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
    let lines: Vec<&str> = result.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
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
        assert_eq!(strip_html_full("<h1>Title</h1><p>Hello world</p>"), "Title\nHello world");
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
        assert_eq!(strip_html_full("<ScRiPt type=\"text/javascript\">var y=2;</ScRiPt><Style>.a{}</Style><p>Hi</p>"), "Hi");
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
    if encoded.is_empty() { "session".to_string() } else { encoded }
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
    #[serde(default, rename = "requestId")]
    request_id: String,
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
mod chat_cancel_tests {
    use super::*;

    #[tokio::test]
    async fn register_then_cancel_resolves_the_receiver_and_cleans_up() {
        let reg = ChatStreamRegistry::new(StdMutex::new(BTreeMap::new()));
        let mut rx = register_chat_cancel(&reg, "req-1");
        assert!(reg.lock().unwrap().contains_key("req-1"));
        assert!(
            cancel_chat_stream_inner(&reg, "req-1"),
            "a live stream must be cancellable"
        );
        assert!(rx.await.is_ok(), "cancel must resolve the stream's receiver");
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

#[cfg(test)]
mod chat_stream_tests {
    use super::*;

    #[test]
    fn sse_done_terminates_the_read_loop() {
        // [DONE] — with and without surrounding whitespace — is the terminal
        // frame. The caller MUST break the outer read loop on it (labeled
        // break), never fall back into stream.next().
        assert!(matches!(classify_sse_line("data: [DONE]"), SseLine::Done));
        assert!(matches!(classify_sse_line("data:  [DONE]  "), SseLine::Done));
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
        assert!(matches!(classify_sse_line(": keep-alive"), SseLine::NotData));
        assert!(matches!(classify_sse_line("event: message"), SseLine::NotData));
        assert!(matches!(classify_sse_line(""), SseLine::NotData));
        assert!(matches!(classify_sse_line("data: not json {"), SseLine::NotData));
    }
}

#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, ChatStreamRegistry>,
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

    // Timeout the whole send: with `Client::new()` a server that accepts the
    // connection but never sends headers would block here forever. 180s covers
    // even long reasoning-model time-to-first-byte.
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(LLM_REQUEST_TIMEOUT_SECS),
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send(),
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
    let mut buffer = String::new();
    let mut text = String::new();
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
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].to_string();
            buffer = buffer[line_end + 1..].to_string();

            let json = match classify_sse_line(&line) {
                SseLine::NotData => continue,
                SseLine::Done => break 'stream,
                SseLine::Data(v) => v,
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

            // Emit reasoning deltas separately from content so the GUI can
            // render a live "thinking" card. DeepSeek/Qwen/GLM stream
            // `reasoning_content`; OpenAI-style responses use `reasoning`
            // (string, or an object with a text-part `content` array). The
            // reasoning text is intentionally NOT appended to `text`, so it
            // never leaks into the final answer or persisted messages.
            let reasoning = delta.get("reasoning_content").and_then(|c| c.as_str()).map(|s| s.to_string()).or_else(|| {
                match delta.get("reasoning") {
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
                            if acc.is_empty() { None } else { Some(acc) }
                        } else {
                            None
                        }
                    }
                    None => None,
                }
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
                    let cur = tc_map.entry(idx).or_insert_with(|| {
                        serde_json::json!({"id": "", "name": "", "arguments": ""})
                    });
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

#[tauri::command]
fn save_session(
    session_id: String,
    messages: Vec<serde_json::Value>,
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

    let data = SessionData {
        message_count: messages.len(),
        updated_at: now,
        workspace: workspace.clone(),
        messages,
    };

    let data_path = dir.join("session.json");
    fs::write(&data_path, serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|e| format!("write: {}", e))?;

    let title = extract_title(&data.messages);
    update_sessions_index(&session_id, &title, data.message_count, now, workspace)?;

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
        "workspace": data.workspace,
    })))
}

/// Read the stored workspace override for a session ("" when absent).
fn load_session_workspace(session_id: &str) -> Result<String, String> {
    let path = sessions_dir().join(session_id).join("session.json");
    if !path.exists() {
        return Ok(String::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let data: SessionData = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    Ok(data.workspace)
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
/// change survives an app restart). No-op when the session dir does not exist
/// yet — a brand-new chat that has never been persisted has nothing to update,
/// and its workspace is captured on the first save_session call.
#[tauri::command]
fn save_session_workspace(session_id: String, workspace: String) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    let data_path = dir.join("session.json");
    if data_path.exists() {
        let raw = fs::read_to_string(&data_path).map_err(|e| format!("read: {}", e))?;
        let mut data: SessionData = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
        data.workspace = workspace.clone();
        fs::write(&data_path, serde_json::to_string_pretty(&data).unwrap_or_default())
            .map_err(|e| format!("write: {}", e))?;
    }

    let index_path = sessions_dir().join("index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        let mut list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
        if let Some(meta) = list.iter_mut().find(|s| s.id == session_id) {
            meta.workspace = workspace.clone();
        }
        fs::write(&index_path, serde_json::to_string_pretty(&list).unwrap_or_default())
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
        fs::write(&index_path, serde_json::to_string_pretty(&list).unwrap_or_default())
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
        created_at: existing
            .map(|i| list[i].created_at)
            .unwrap_or(updated_at),
        updated_at,
        message_count,
        workspace,
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
//  System Info
// ═══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn sys_info(_workspace: String) -> Result<String, String> {
    let tz = std::env::var("TZ").unwrap_or_else(|_| "UTC".to_string());

    let lang = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LC_CTYPE"))
        .unwrap_or_else(|_| "unknown".to_string());

    let time = {
        let output = std::process::Command::new("date")
            .arg("+%Y-%m-%d %H:%M:%S %Z")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        output
    };

    let os_version = {
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
    };

    let info = format!(
        "timezone:  {}\nlanguage:  {}\ntime:      {}\nos:        {}",
        tz, lang, time, os_version
    );
    Ok(info)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Open Path (clickable transcript paths → Finder / default app)
// ═══════════════════════════════════════════════════════════════════════════════

/// Open a file/directory with the OS default application (macOS `open`, Linux
/// `xdg-open`, Windows `explorer`). A directory opens in the file manager; a
/// file opens with its default app. When the exact path doesn't exist yet
/// (e.g. clicking a file the agent plans to create), fall back to the nearest
/// existing parent directory so the click still lands somewhere useful.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let mut expanded = path;
    // Expand a leading ~/ to the user's home directory (PathBuf alone does
    // not resolve ~).
    if expanded.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            expanded = format!("{}/{}", home.trim_end_matches('/'), &expanded[2..]);
        }
    }

    let p = PathBuf::from(&expanded);
    let target = if p.exists() {
        p
    } else {
        p.parent()
            .filter(|pp| pp.exists())
            .map(|pp| pp.to_path_buf())
            .unwrap_or(p)
    };

    // Async so a slow launcher never blocks the main thread.
    #[cfg(target_os = "macos")]
    let status = TokioCommand::new("open").arg(&target).status().await;
    #[cfg(target_os = "linux")]
    let status = TokioCommand::new("xdg-open").arg(&target).status().await;
    #[cfg(target_os = "windows")]
    let status = TokioCommand::new("explorer").arg(&target).status().await;

    status
        .map_err(|e| format!("open_path: {}", e))?
        .success()
        .then_some(())
        .ok_or_else(|| format!("open failed: {}", target.display()))
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
        .manage(WatcherRegistry::new(BTreeMap::new()))
        .manage(CommandRegistry::new(BTreeMap::new()))
        .manage(ChatStreamRegistry::new(StdMutex::new(BTreeMap::new())))
        .invoke_handler(tauri::generate_handler![
            // File tools
            read_file, write_file, edit_file, search_files, list_files, create_directory, diff_files, glob_files, replace_files,
            save_file,
            // System info
            sys_info,
            // Web tools
            web_search, web_fetch,
            // Command execution
            execute_command, execute_command_stream, kill_command,
            // Git tools
            git_diff, git_log, git_status,
            // MCP subprocess
            spawn_mcp, mcp_request, mcp_shutdown, mcp_list,
            // Application temporary workspace + secret management
            get_tmp_workspace,
            secret_get, secret_set, secret_delete, secret_list,
            // File watching
            watch_files, unwatch_files,
            // Open path (clickable transcript paths)
            open_path,
            // LLM transport
            chat_stream, cancel_chat_stream,
            // Session persistence
            save_session, load_session, load_last_session, load_session_list, save_session_workspace, delete_session, delete_all_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pure");
}
