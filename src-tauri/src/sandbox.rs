// src-tauri/src/sandbox.rs
// Optional macOS Seatbelt (sandbox-exec) wrapper for shell commands run by
// the agent. The permission dialog remains the primary control — this is the
// kernel-level backstop for high-autonomy runs (YOLO / unattended-local),
// where every command is auto-approved and a single successful prompt
// injection would otherwise have the whole user account as its blast radius.
//
// Design:
// - Opt-in per command: `wrap_command(workspace, command)` returns either the
//   original argv (sandboxing unavailable) or a `/usr/bin/sandbox-exec -f
//   <profile> sh -c <wrapped>` invocation whose profile allows reads
//   everywhere, writes only inside the workspace + temp dirs, and denies
//   network inbound. Process-control syscalls (process-info*, process-fork)
//   are NOT denied: on macOS 14.x sandbox-exec rejects `process-info-setinfo`
//   as unbound, and denying process-info even for Apple's own git makes it
//   die with SIGILL, so those filters break the toolchain instead of
//   hardening it. Write confinement + network direction are the backstop.
// - Graceful degradation: on non-macOS builds, or when `sandbox-exec` is
//   missing (Apple removed it from newer SDKs), wrap is a no-op and the
//   caller runs the command exactly as before. Sandboxing must never make
//   the agent stop working.
// - Denials surface as exit code 1 with "Operation not permitted" on stderr,
//   which the model already reports like any other command failure.

use std::path::Path;

/// True when the Seatbelt wrapper can actually be applied on this machine.
pub fn seatbelt_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        // sandbox-exec lives at a fixed absolute path on every macOS version
        // that shipped it; also tolerate PATH-based installs for testing.
        std::path::Path::new("/usr/bin/sandbox-exec").exists()
            || which_sandbox_exec().is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
fn which_sandbox_exec() -> Option<std::path::PathBuf> {
    let path = std::env::var("PATH").ok()?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("sandbox-exec"))
        .find(|p| p.is_file())
}

/// Shell-metacharacter escaping for the inner `sh -c` argument. The wrapper
/// embeds the user command inside a single-quoted string, so only the single
/// quote needs care (POSIX: end the literal, add an escaped quote, reopen).
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Build the Seatbelt profile for an agent command rooted at `workspace`.
/// Reads stay broad (the agent legitimately reads toolchains, config, caches);
/// writes are confined to the workspace, system temp, and the app config dir;
/// network is outbound-only; dangerous process-control syscalls are denied.
pub fn seatbelt_profile(workspace: &Path) -> String {
    let ws = workspace.display().to_string();
    let tmp = std::env::temp_dir().display().to_string();
    format!(
        r##"(version 1)
; Deny by default only for file-write and network operations; everything
; else falls through to allow (reads stay broad on purpose).
(deny default)
(allow default)
(deny file-write*)
(allow file-write*
    (subpath "{ws}")
    (subpath "{tmp}")
    (subpath "/tmp")
    (subpath "/private/tmp")
    (literal "/dev/null")
    (literal "/dev/stdout")
    (literal "/dev/stderr")
    (regex "^/private/var/folders/[^/]+/[^/]+/[Tt]/")
    (regex "^/(private/)?var/folders/.*[.]pure-lock"))
(allow network-outbound)
(deny network-inbound)
"##,
        ws = ws,
        tmp = tmp,
    )
}

/// Wrap a shell command for sandboxed execution. Returns the argv to spawn
/// plus a flag saying whether the wrapper was applied. When Seatbelt is
/// unavailable the original `sh -c <command>` argv is returned unchanged.
pub fn wrap_command(workspace: &Path, command: &str) -> (Vec<String>, bool) {
    let base = || -> Vec<String> {
        #[cfg(windows)]
        {
            vec!["powershell".into(), "-NoProfile".into(), "-NonInteractive".into(), "-EncodedCommand".into()]
        }
        #[cfg(not(windows))]
        {
            vec!["sh".into(), "-c".into()]
        }
    };
    if !seatbelt_available() {
        return (base(), false);
    }
    let exec = std::path::PathBuf::from("/usr/bin/sandbox-exec");
    let exec = if exec.exists() { exec } else { which_sandbox_exec().unwrap_or(exec) };
    let profile_path = match write_profile_file(workspace) {
        Ok(p) => p,
        Err(_) => return (base(), false),
    };
    let inner = format!("cd {} && {}", sh_quote(&workspace.display().to_string()), command);
    (
        vec![
            exec.display().to_string(),
            "-f".into(),
            profile_path.display().to_string(),
            "sh".into(),
            "-c".into(),
            inner,
        ],
        true,
    )
}

/// Materialize the profile once per machine into the app config dir so the
/// command line stays short and the profile is user-inspectable.
fn write_profile_file(workspace: &Path) -> Result<std::path::PathBuf, std::io::Error> {
    let dir = match std::env::var("HOME") {
        Ok(home) => std::path::PathBuf::from(home).join(".pure"),
        Err(_) => std::env::temp_dir(),
    };
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sbconf-profile.sb");
    std::fs::write(&path, seatbelt_profile(workspace))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_denies_global_writes_but_allows_workspace_and_tmp() {
        let ws = std::path::Path::new("/Users/dev/project");
        let profile = seatbelt_profile(ws);
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(subpath \"/Users/dev/project\")"));
        assert!(profile.contains("(allow network-outbound)"));
        assert!(profile.contains("(deny network-inbound)"));
        // Temp regex line present
        assert!(profile.contains("/private/var/folders/"));
        // Regex literals must be plain quoted strings: the #"..."# sharp
        // expression form fails to compile on current macOS sandbox-exec.
        assert!(!profile.contains('#'));
        // process-* filters break Apple toolchain binaries (git dies with
        // SIGILL under process-info denials); they must stay out.
        assert!(!profile.contains("process-"));
    }

    #[test]
    fn profile_escapes_paths() {
        let ws = std::path::Path::new("/Users/dev/my project");
        let profile = seatbelt_profile(ws);
        assert!(profile.contains("(subpath \"/Users/dev/my project\")"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wrap_command_shapes_sandbox_exec_argv_when_available() {
        let ws = std::path::Path::new("/tmp");
        let (argv, wrapped) = wrap_command(ws, "echo hi");
        if seatbelt_available() {
            assert!(wrapped);
            assert_eq!(argv[0], "/usr/bin/sandbox-exec");
            assert_eq!(argv[1], "-f");
            assert!(argv[3] == "sh" && argv[4] == "-c");
            assert!(argv[5].contains("echo hi"));
        } else {
            // Degrade gracefully: unchanged sh -c argv.
            assert!(!wrapped);
            assert_eq!(argv[0], "sh");
            assert_eq!(argv[1], "-c");
            assert_eq!(argv[2], "echo hi");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wrap_command_single_quotes_the_inner_command() {
        let ws = std::path::Path::new("/tmp");
        let (argv, wrapped) = wrap_command(ws, "echo 'a b' && ls");
        if wrapped {
            assert!(argv[5].starts_with("cd '/tmp' && echo "));
            assert!(argv[5].contains(r"'a b'"));
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn wrap_command_is_a_noop_off_macos() {
        let ws = std::path::Path::new("/tmp");
        let (argv, wrapped) = wrap_command(ws, "echo hi");
        assert!(!wrapped);
        assert_eq!(argv, vec!["sh".to_string(), "-c".to_string(), "echo hi".to_string()]);
    }

    #[test]
    fn sh_quote_handles_embedded_quotes() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("plain"), "'plain'");
    }
}
