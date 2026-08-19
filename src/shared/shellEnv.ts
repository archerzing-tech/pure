// src/shared/shellEnv.ts
// Shared OS/shell guidance injected into the system prompt so the model emits
// terminal commands that actually work on THIS machine. The Windows backend
// executes through PowerShell (not cmd), so the guidance teaches PowerShell
// syntax; Unix/macOS executes through `sh -c`. One helper, used by both the
// GUI (os label from the Rust sys_info probe) and the CLI (process.platform).

/** Classify an OS label into the shell family the backend uses to execute
 * commands. Labels come from Rust `std::env::consts::OS` ("windows",
 * "macos", "linux"), the richer sys_info `os:` line ("macOS 15.x (arm64)",
 * "windows x86_64", "Linux 6.8 arm64"), or Node `process.platform`
 * ("win32", "darwin", "linux"). "darwin" must NOT be matched as Windows
 * even though it ends in "win". */
export function detectShellPlatform(label: string): 'windows' | 'posix' {
  const s = String(label ?? '').trim();
  if (!s) return 'posix';
  if (/darwin/i.test(s)) return 'posix';
  return /windows|win32|win64|microsoft/i.test(s) ? 'windows' : 'posix';
}

/** Build the shell-guidance prompt fragment for a given OS label. Returns an
 * empty string when the label is empty (probe failed / browser dev mode) so a
 * missing probe never pollutes the prompt with wrong guidance. */
export function buildShellContext(osLabel: string): string {
  const os = String(osLabel ?? '').trim();
  if (!os) return '';
  if (detectShellPlatform(os) === 'windows') {
    return `\nEnvironment shell (this machine): ${os} — execute_command runs through PowerShell (powershell.exe), NOT cmd.exe or a Unix sh. Commands are passed via -EncodedCommand (base64 UTF-16LE), so quotes and special characters reach PowerShell verbatim — no Windows command-line escaping to worry about. Write only PowerShell syntax:
- Create directories with \`New-Item -ItemType Directory -Force "path"\` — never \`mkdir -p\` (it fails on Windows). Prefer the create_directory tool, which is cross-platform.
- Quote literal strings with single quotes '...'; escape a character with a backtick \` and run subexpressions with \$(...).
- Chain commands with \`;\`. \`&&\` / \`||\` do NOT work in Windows PowerShell 5.1. The runner already propagates the last command's exit code into the tool result (exitCode: 0 = success, non-zero = failure) — judge success by exitCode, no need to echo \`\$LASTEXITCODE\` yourself.
- Environment variables are \`\$env:NAME\` (not \$NAME or %NAME%).
- \`curl\` and \`wget\` are PowerShell ALIASES for Invoke-WebRequest and reject curl flags (-X/-H/-d/-o). Call the real binary as \`curl.exe ...\` (Windows 10+ ships it) or use \`Invoke-RestMethod\`/\`Invoke-WebRequest\` for HTTP.
- Paths use backslashes (C:\\proj\\src) or forward slashes (C:/proj/src); inside double quotes, escape backslashes as \\\\.
- Archives: \`unzip x.zip\` → \`Expand-Archive x.zip\` (or \`tar -xf x.zip\`); \`tar xzf x.tar.gz\` → \`tar -xzf x.tar.gz\` (Windows 10+ ships tar.exe). For files in the workspace, prefer the built-in file tools.
- Recursive search: \`find . -name "*.ts"\` is NOT the Unix find — use \`Get-ChildItem -Recurse -Filter *.ts\` or the search_files / glob_files tools; \`grep -r x .\` → \`Get-ChildItem -Recurse | Select-String x\` (prefer search_files).
- More translations: \`rm -rf dir\` → \`Remove-Item -Recurse -Force dir\`; \`cp -r a b\` → \`Copy-Item -Recurse a b\`; \`touch f\` → \`New-Item -ItemType File f\`; \`cat f\` → \`Get-Content f\`; \`which cmd\` → \`Get-Command cmd\`; \`tail -f log\` → \`Get-Content log -Wait\`; \`head -20 f\` → \`Get-Content f -TotalCount 20\`; \`ln -s tgt link\` → \`New-Item -ItemType SymbolicLink -Path link -Target tgt\`; \`open f\` → \`Invoke-Item f\`. For text edits prefer edit_file / replace_files (never sed -i).`;
  }
  return `\nEnvironment shell (this machine): ${os} — execute_command runs through \`sh -c\` (POSIX shell). Use sh/bash syntax: \`mkdir -p\`, \`rm -rf\`, \`&&\` / \`||\` chaining, \`\$VAR\`, and single-quoted literals. Prefer the create_directory / write_file tools for cross-platform file creation.`;
}
