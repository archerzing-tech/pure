// src/shared/backgroundCommand.ts
// Shared building blocks for execute_command's background:true mode — starting
// long-lived processes (dev servers, static file servers, watchers) DETACHED so
// the tool returns immediately instead of blocking until the command timeout
// kills the server. Used by BOTH adapters: NodeToolAdapter spawns natively and
// only needs the log path + result shape; TauriToolAdapter has no direct spawn
// (it routes through the Rust command channel), so it wraps the user command in
// a self-detaching launcher script that exits immediately after printing the
// child PID.
//
// BROWSER-SAFE BY CONTRACT: TauriToolAdapter runs inside the WebView, and Vite
// externalizes node:* imports into stubs that THROW on access — a top-level
// `import { tmpdir } from 'node:os'` here once killed the whole settings panel
// at boot (caught by e2e-settings-apikey, invisible to Bun unit tests). No
// node/module imports may appear at module scope.

export interface BackgroundLaunchPlan {
  /** Path of the log file the detached process appends to. Unix → absolute
   *  (/tmp/...); Windows → %TEMP%-relative literal (the launcher resolves it
   *  via $env:TEMP at start time). */
  logFile: string;
  /** Path of the generated launcher/wrapper script (same flavor rules). */
  scriptFile: string;
  /** Shell snippet for the Tauri channel: writes the wrapper, launches it
   *  detached, echoes PURE_BG_PID=<pid>, then returns — the outer tool call
   *  therefore finishes in well under a second. Empty on the Node path (it
   *  spawns directly and never needs an incantation). */
  detachCommand: string;
}

let seq = 0;

function nextId(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${seq}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Random per-call heredoc delimiter: a user command that happens to contain a
 *  literal "PURE_BG_EOF" line cannot break the writer. */
function delimiter(): string {
  return `PURE_BG_EOF_${nextId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function isWindowsPlatform(isWindows?: boolean): boolean {
  return isWindows ?? (typeof navigator !== 'undefined' ? /Win/i.test(navigator.platform || navigator.userAgent) : false);
}

/** Temp directory WITHOUT node APIs. Node/Bun resolve the real tmpdir through
 *  require (guarded — undefined in ESM browser bundles); browsers fall back to
 *  /tmp for unix targets. Windows never uses this value (it emits $env:TEMP /
 *  %TEMP% forms resolved on the target machine instead). */
function tempBase(): string {
  try {
    const { tmpdir } = require('node:os');
    if (typeof tmpdir === 'function') return String(tmpdir());
  } catch {}
  return '/tmp';
}

/** Single-quote a literal for PowerShell ('' escapes a quote). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Plan a background launch. The wrapper script redirects ALL output of the
 * user command into logFile, so the caller never needs to quote the command —
 * arbitrary multi-line content lands verbatim inside the generated file.
 *
 * scriptFile flavors: Unix → .sh (both adapters); Windows → .ps1 (Tauri
 * incantation). The Node adapter on Windows ignores scriptFile and generates
 * its own cmd.exe wrapper via buildWrapperScript().
 */
export function buildBackgroundLaunchPlan(command: string, opts: { isWindows?: boolean } = {}): BackgroundLaunchPlan {
  const windows = isWindowsPlatform(opts.isWindows);
  const id = nextId();
  // Windows paths are resolved ON the target machine ($env:TEMP at launch
  // time; %TEMP% form reported to the model), because the browser-side caller
  // cannot know the real temp dir.
  const base = windows ? '%TEMP%' : tempBase();
  const sep = windows ? '\\' : '/';
  const logFile = `${base}${sep}pure-bg-${id}.log`;
  const scriptFile = `${base}${sep}pure-bg-${id}.${windows ? 'ps1' : 'sh'}`;
  const winLogPs = `$env:TEMP\\pure-bg-${id}.log`;
  const winScriptPs = `$env:TEMP\\pure-bg-${id}.ps1`;

  let detachCommand = '';
  if (!windows) {
    // POSIX detach incantation (Tauri path only). Quoted heredoc → no shell
    // expansion inside the written file; $! is the PID of the background job.
    const eof = delimiter();
    const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    detachCommand = [
      `__pure_bg=${shQuote(scriptFile)}`,
      `__pure_log=${shQuote(logFile)}`,
      `cat > "\$__pure_bg" <<'${eof}'`,
      command,
      eof,
      `nohup sh "\$__pure_bg" >/dev/null 2>&1 &`,
      'echo PURE_BG_PID=$!',
    ].join('\n');
  } else {
    // PowerShell detach incantation (Tauri path only). The wrapper travels as
    // base64 — PowerShell has no custom here-string delimiters, and base64
    // makes quoting/multi-line content a non-issue (PS 5.1-compatible APIs).
    // The generated wrapper redirects every stream into the log so the hidden
    // child holds no handles back to the tool call's pipes.
    const wrapper =
      `& {\r\n${command}\r\n} *>> ${psQuote(winLogPs)}\r\nexit 0\r\n`;
    const b64 = typeof Buffer !== 'undefined'
      ? Buffer.from(wrapper, 'utf8').toString('base64')
      : btoa(String.fromCharCode(...new TextEncoder().encode(wrapper)));
    detachCommand = [
      `$__f=${winScriptPs}`,
      `[IO.File]::WriteAllText($__f, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
      `$__p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$__f -WindowStyle Hidden -PassThru`,
      `'PURE_BG_PID=' + $__p.Id`,
    ].join('; ');
  }

  return { logFile, scriptFile, detachCommand };
}

/** Wrapper script BODY (written by the Node adapter directly; embedded in the
 *  Tauri detach incantation via the heredoc above). Self-redirecting on BOTH
 *  platforms: the spawned process needs no inherited pipes, so the parent tool
 *  call can return while the server keeps writing into the log. */
export function buildWrapperScript(command: string, logFile: string, opts: { isWindows?: boolean } = {}): string {
  if (isWindowsPlatform(opts.isWindows)) {
    // cmd.exe: group the whole command so redirection binds to everything,
    // then always exit 0 — the wrapper's own exit code must not depend on a
    // long-lived server being Ctrl-C'd.
    return `@echo off\r\n(\r\n${command}\r\n) >> "${logFile}" 2>&1\r\nexit /b 0\r\n`;
  }
  const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `{\n${command}\n} >> ${shQuote(logFile)} 2>&1\n`;
}

/** Extract the detached PID echoed by the detach incantation. */
export function parseBackgroundPid(stdout: string): number | null {
  const m = stdout.match(/PURE_BG_PID=(\d+)/);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Uniform tool-result payload both adapters hand back to the model. */
export function buildBackgroundResult(pid: number | null, logFile: string): string {
  return JSON.stringify({
    kind: 'background',
    pid,
    logFile,
    started: pid !== null,
    ...(pid === null ? { note: 'detached launch did not report a PID; check the log file' } : {}),
    hint: 'Process started detached — it keeps running after this call returns. Verify with a bounded probe (e.g. curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>) or read the log with read_file. Stop it later with kill <pid> (PowerShell: Stop-Process -Id <pid>).',
  });
}
