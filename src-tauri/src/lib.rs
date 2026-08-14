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
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if let Some(url) = proxy_url.map(str::trim).filter(|url| !url.is_empty()) {
        if !valid_proxy_url(url) {
            return Err("proxy: URL must start with http://, https://, socks5://, or socks5h://".to_string());
        }
        let proxy = reqwest::Proxy::all(url).map_err(|e| format!("proxy: {}", e))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("client: {}", e))
}

fn valid_proxy_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://", "socks5://", "socks5h://"].iter().any(|prefix| lower.starts_with(prefix))
}

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};

use base64::Engine as _;

#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDictionary, NSString};

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
/// Homebrew) plus the system defaults. A Finder-launched app inherits a
/// minimal PATH (/usr/bin:/bin:…) that omits per-user runtimes, so MCP
/// servers launched with bunx/npx would fail to spawn without this. `existing`
/// is the caller-supplied or inherited PATH to preserve as the base.
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
    if let Some(base) = existing.filter(|s| !s.is_empty()) {
        dirs.push(base.to_string());
    }
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
    let normalized =
        normalize_lexical(&candidate).map_err(|_| format!("path escapes workspace: {}", path))?;

    // Canonicalize the deepest existing ancestor, then append the missing
    // components in reverse order. This resolves existing symlinks while still
    // allowing write_file to target a file that does not exist yet.
    let mut existing = normalized.clone();
    let mut missing: Vec<PathBuf> = Vec::new();
    while !existing.exists() {
        // `Path::exists()` follows symlinks and returns false for a dangling
        // link. Inspect metadata before climbing so a broken link cannot be
        // treated as an ordinary missing directory and later followed by a
        // write into an arbitrary target outside the workspace.
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
    if !canonical_existing.starts_with(&base_canonical) {
        return Err(format!("path escapes workspace: {}", path));
    }

    let mut resolved = canonical_existing;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    if !resolved.starts_with(&base_canonical) {
        return Err(format!("path escapes workspace: {}", path));
    }
    Ok(resolved)
}

fn has_symlink_component(workspace: &str, path: &str) -> bool {
    let Ok(base) = fs::canonicalize(workspace) else { return true };
    let requested = PathBuf::from(path.trim());
    let candidate = if requested.is_absolute() { requested } else { base.join(requested) };
    let Ok(normalized) = normalize_lexical(&candidate) else { return true };
    if !normalized.starts_with(&base) { return true; }
    let Ok(relative) = normalized.strip_prefix(&base) else { return true; };
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
    fs::read_to_string(&full).map_err(|e| format!("read_file: {}", e))
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
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
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
async fn execute_command(workspace: String, command: String, proxy_url: Option<String>) -> Result<serde_json::Value, String> {
    // Unix shells run `sh -c`, Windows runs `cmd /C` (no `sh` binary there).
    let output = {
        #[cfg(unix)]
        let mut cmd = silent_child_tokio(TokioCommand::new("sh"));
        #[cfg(windows)]
        let mut cmd = silent_child_tokio(TokioCommand::new("cmd"));
        #[cfg(unix)]
        cmd.arg("-c");
        #[cfg(windows)]
        cmd.arg("/C");
        cmd.arg(&command)
            .current_dir(&workspace);
        if let Some(url) = proxy_url.as_deref().filter(|url| !url.trim().is_empty()) {
            if !valid_proxy_url(url) {
                return Err("proxy: URL must start with http://, https://, socks5://, or socks5h://".to_string());
            }
            cmd.env("HTTP_PROXY", url)
                .env("HTTPS_PROXY", url)
                .env("ALL_PROXY", url)
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
    // Unix shells run `sh -c`, Windows runs `cmd /C` (no `sh` binary there).
    #[cfg(unix)]
    let mut cmd = {
        let mut c = silent_child_tokio(TokioCommand::new("sh"));
        c.arg("-c");
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = silent_child_tokio(TokioCommand::new("cmd"));
        c.arg("/C");
        c
    };
    cmd.arg(command)
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    if let Some(url) = proxy_url.filter(|url| !url.trim().is_empty()) {
        if !valid_proxy_url(url) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "proxy URL must start with http://, https://, socks5://, or socks5h://"));
        }
        cmd.env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
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

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
    let client = build_http_client(std::time::Duration::from_secs(8), proxy_url)?;
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
    let url = format!(
        "https://www.bing.com/search?q={}&count={}",
        urlencoding(query),
        max
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

/// Human-readable list of the configured search backends (API keys that were
/// passed in plus the always-available free HTML backends) for the error /
/// no-results guidance the model feeds back on.
fn configured_backend_names(serper_api_key: &Option<String>, api_key: &Option<String>) -> String {
    let mut names: Vec<&str> = Vec::new();
    if serper_api_key.as_deref().map_or(false, |k| !k.is_empty()) {
        names.push("Serper");
    }
    if api_key.as_deref().map_or(false, |k| !k.is_empty()) {
        names.push("Tavily");
    }
    names.extend(["cn.bing.com", "DuckDuckGo", "Bing"]);
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

#[tauri::command]
async fn web_search(
    _workspace: String,
    query: String,
    max_results: Option<usize>,
    api_key: Option<String>,
    serper_api_key: Option<String>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let max = max_results.unwrap_or(10).min(20);

    let mut results: Vec<SearchResult> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
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
    if let Some(k) = serper_api_key.as_deref().filter(|k| !k.is_empty()) {
        match search_backend_serper(&query, max, k, proxy_url.as_deref()).await {
            Ok(r) if !r.is_empty() => results = r,
            Ok(_) => any_empty = true,
            Err(e) => failed.push(format!("Serper: {}", e)),
        }
    }
    if results.is_empty() {
        if let Some(k) = api_key.as_deref().filter(|k| !k.is_empty()) {
            match search_backend_tavily(&query, max, k, proxy_url.as_deref()).await {
                Ok(r) if !r.is_empty() => results = r,
                Ok(_) => any_empty = true,
                Err(e) => failed.push(format!("Tavily: {}", e)),
            }
        }
    }

    // Free HTML backends — probed ONLY when the API backends produced nothing
    // (a successful Serper hit no longer triggers three wasted scrapes), and
    // then IN PARALLEL with first-success-returns. Each backend keeps its own
    // bounded request timeout (8s via fetch_search_page), so the effective
    // latency is the FIRST backend to deliver a non-empty result, not the
    // slowest — the join!-style sweep this replaces still waited for every
    // probe to finish (up to the worst-case timeout). cn.bing.com is biased
    // to win ties for CJK (biased select checks branches in declaration
    // order) and gets a short grace window (CN_BING_GRACE_MS) when another
    // backend wins the race, because international backends return
    // irrelevant results for Chinese; otherwise the first non-empty winner
    // is used and the still-in-flight probes are dropped. Errors and empty
    // sets are still accumulated for the degraded-error message below.
    if results.is_empty() {
        let chinese = is_chinese_query(&query);
        let mut cn = Box::pin(async {
            if chinese {
                search_backend_bing_cn(&query, max, proxy_url.as_deref()).await
            } else {
                Err("cn.bing.com not probed for non-CJK queries".to_string())
            }
        });
        let mut ddg = Box::pin(search_backend_duckduckgo(&query, max, proxy_url.as_deref()));
        let mut bing = Box::pin(search_backend_bing(&query, max, proxy_url.as_deref()));
        let (mut cn_done, mut ddg_done, mut bing_done) = (false, false, false);
        while results.is_empty() {
            // A completed branch is guarded off (never re-polled) so the loop
            // keeps racing only the still-pending backends; when every branch
            // is done or disabled the else arm breaks out. Non-CJK never
            // consults cn.bing.com (guard false), so its synthetic error can't
            // surface in the degraded-error message.
            let winner = tokio::select! {
                biased;
                r = &mut cn, if chinese && !cn_done => { cn_done = true; ("cn.bing.com", r) }
                r = &mut ddg, if !ddg_done => { ddg_done = true; ("DuckDuckGo", r) }
                r = &mut bing, if !bing_done => { bing_done = true; ("Bing", r) }
                else => break,
            };
            match winner {
                (_, Ok(r)) if !r.is_empty() => {
                    // CJK relevance guard: a fast-but-English-biased DDG/Bing
                    // win must not preempt cn.bing.com, the Chinese-relevant
                    // backend. When cn.bing.com is still in flight, grant it a
                    // short grace window and only accept the race winner if
                    // cn.bing.com times out or returns nothing usable.
                    if chinese && !cn_done {
                        let grace = tokio::time::timeout(CN_BING_GRACE_MS, &mut cn).await;
                        cn_done = true;
                        match grace {
                            Ok(Ok(cn_r)) if !cn_r.is_empty() => results = cn_r,
                            _ => results = r,
                        }
                    } else {
                        results = r;
                    }
                }
                (_, Ok(_)) => any_empty = true,
                (name, Err(e)) => failed.push(format!("{}: {}", name, e)),
            }
        }
    }

    if results.is_empty() {
        // At least one backend answered with an empty result set: the search
        // infrastructure works, the query just has no hits — rephrase, don't
        // repeat. (Other backends may have been unreachable; either way the
        // actionable guidance is the same.)
        if any_empty {
            return Ok(format!(
                "No results found for \"{}\" on the available search backends ({}). Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to contain the information.",
                query, configured_backend_names(&serper_api_key, &api_key)
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
            configured_backend_names(&None, &None),
            "cn.bing.com, DuckDuckGo, Bing"
        );
        assert_eq!(
            configured_backend_names(&Some("k".into()), &None),
            "Serper, cn.bing.com, DuckDuckGo, Bing"
        );
        assert_eq!(
            configured_backend_names(&Some("k".into()), &Some("".into())),
            "Serper, cn.bing.com, DuckDuckGo, Bing"
        );
        assert_eq!(
            configured_backend_names(&Some("k".into()), &Some("t".into())),
            "Serper, Tavily, cn.bing.com, DuckDuckGo, Bing"
        );
    }
}

#[cfg(test)]
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
    fn rejects_new_files_through_a_symlink_outside_workspace() {
        let ws = temp_workspace("symlink");
        let outside =
            std::env::temp_dir().join(format!("pure-resolve-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, PathBuf::from(&ws).join("linked")).unwrap();
        assert!(resolve(&ws, "linked/evil.txt").is_err());
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
    fn rejects_paths_escaping_the_workspace() {
        let ws = temp_workspace("escape");
        assert!(resolve(&ws, "../../etc/passwd").is_err());
        assert!(resolve(&ws, "sub/../../../etc/passwd").is_err());
        // More `..` segments than the absolute root can absorb must never be
        // silently normalized into a different relative path.
        assert!(resolve(&ws, "../../../../../../etc/passwd").is_err());
        fs::remove_dir_all(&ws).unwrap();
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

    let client = build_http_client(std::time::Duration::from_secs(30), proxy_url.as_deref())?;

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
    #[serde(default, rename = "proxyBypassModels")]
    proxy_bypass_models: Vec<String>,
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
        || proxy_matches(&args.model, &args.proxy_bypass_models)
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
    fn provider_or_model_match_bypasses_llm_proxy() {
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
            proxy_bypass_models: Vec::new(),
        };
        assert!(llm_proxy_url(&args).is_none());
        args.provider = "qwen".to_string();
        args.proxy_bypass_providers.clear();
        args.proxy_bypass_models = vec!["qwen2.5-coder".to_string()];
        assert!(llm_proxy_url(&args).is_none());
        args.proxy_bypass_models.clear();
        assert_eq!(llm_proxy_url(&args), Some("socks5://127.0.0.1:1080"));
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
    #[serde(default, rename = "proxyBypassModels")]
    proxy_bypass_models: Vec<String>,
}

fn image_proxy_url(args: &GenerateImageArgs) -> Option<&str> {
    if args.proxy_url.trim().is_empty()
        || proxy_matches(&args.provider, &args.proxy_bypass_providers)
        || proxy_matches(&args.model, &args.proxy_bypass_models)
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
    fn proxy_bypass_matches_provider_or_model() {
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
            proxy_bypass_models: Vec::new(),
        };
        assert!(image_proxy_url(&args).is_none());
        let mut args2 = GenerateImageArgs { proxy_bypass_providers: Vec::new(), ..args };
        assert_eq!(image_proxy_url(&args2), Some("socks5://127.0.0.1:1080"));
        args2.proxy_bypass_providers = Vec::new();
        args2.proxy_bypass_models = vec!["gpt-image".to_string()];
        assert!(image_proxy_url(&args2).is_none());
    }
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
    fs::write(
        &data_path,
        serde_json::to_string_pretty(&data).unwrap_or_default(),
    )
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
/// change survives an app restart). No-op when the session dir does not exist
/// yet — a brand-new chat that has never been persisted has nothing to update,
/// and its workspace is captured on the first save_session call.
#[tauri::command]
fn save_session_workspace(session_id: String, workspace: String) -> Result<(), String> {
    let dir = sessions_dir().join(&session_id);
    let data_path = dir.join("session.json");
    if data_path.exists() {
        let raw = fs::read_to_string(&data_path).map_err(|e| format!("read: {}", e))?;
        let mut data: SessionData =
            serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
        data.workspace = workspace.clone();
        fs::write(
            &data_path,
            serde_json::to_string_pretty(&data).unwrap_or_default(),
        )
        .map_err(|e| format!("write: {}", e))?;
    }

    let index_path = sessions_dir().join("index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path).unwrap_or_default();
        let mut list: Vec<SessionMeta> = serde_json::from_str(&raw).unwrap_or_default();
        if let Some(meta) = list.iter_mut().find(|s| s.id == session_id) {
            meta.workspace = workspace.clone();
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

/// Probe installed runtime versions (Node.js, Python, Rust) for sys_info.
/// Each is a quick `--version` subprocess; a missing binary yields "not
/// installed" instead of failing the whole sys_info call. python --version
/// prints to stderr, so both streams are checked.
fn detect_runtime_versions() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (label, args) in [
        ("node", vec!["--version"]),
        ("bun", vec!["--version"]),
        ("python3", vec!["--version"]),
        ("rustc", vec!["--version"]),
        ("git", vec!["--version"]),
    ] {
        let version = silent_child(std::process::Command::new(label))
            .args(&args)
            .output()
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

#[tauri::command]
fn sys_info(_workspace: String, location: Option<String>) -> Result<String, String> {
    let tz = std::env::var("TZ").unwrap_or_else(|_| "UTC".to_string());

    let lang = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LC_CTYPE"))
        .unwrap_or_else(|_| "unknown".to_string());

    let loc = location
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| format!("{} (user-set)", s))
        .unwrap_or_else(|| "not set".to_string());

    let time = {
        #[cfg(target_os = "macos")]
        let output = std::process::Command::new("date")
            .arg("+%Y-%m-%d %H:%M:%S %Z")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        #[cfg(target_os = "linux")]
        let output = std::process::Command::new("date")
            .arg("+%Y-%m-%d %H:%M:%S %Z")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        // Windows has no `date` binary; PowerShell formats the local time.
        #[cfg(windows)]
        let output = silent_child(std::process::Command::new("powershell"))
            .args([
                "-NoProfile",
                "-Command",
                "Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'",
            ])
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

    let runtimes = detect_runtime_versions().join("  ");

    let info = format!(
        "timezone:  {}\nlanguage:  {}\ntime:      {}\nos:        {}\nlocation:  {}\nruntimes:  {}",
        tz, lang, time, os_version, loc, runtimes
    );
    Ok(info)
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
        .invoke_handler(tauri::generate_handler![
            // File tools
            read_file,
            path_info,
            remove_path,
            write_file,
            write_file_stream,
            edit_file,
            search_files,
            code_searcher,
            list_files,
            create_directory,
            diff_files,
            glob_files,
            replace_files,
            save_file,
            save_file_binary,
            // System info
            sys_info,
            detect_location,
            // Web tools
            web_search,
            web_fetch,
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
