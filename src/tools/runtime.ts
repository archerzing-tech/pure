// src/tools/runtime.ts
// The tool implementation layer's only permitted runtime surface (W3/D1=A:
// tools live once, in TS; the adapters inject host primitives). Adding a tool
// must no longer touch Rust + Node + Tauri separately — it lands here as pure
// logic over these primitives, and each adapter supplies its own primitive
// implementation (Node: Bun.spawn / node APIs; GUI: Rust IPC commands).

/** Options for one direct argv run. */
export interface ArgvRunOptions {
  /** Working directory. Defaults to the adapter's workspace. */
  cwd?: string;
  /** Hard cap for the whole run. The runtime kills the process and resolves
   * with exitCode 124 plus a timeout note on stderr (never rejects on
   * timeout). Defaults to the adapter's command timeout. */
  timeoutMs?: number;
  /** Parent cancellation signal (user Stop), same treatment as timeout. */
  signal?: AbortSignal;
}

/** Structured outcome of one argv run — the same shape execute_command
 * already returns, so GUI consumers read it unchanged. */
export interface ArgvRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A launched headless Chrome: its CDP port plus the OS pid (kept for
 * diagnostics; teardown goes through CDP Browser.close, not a kill). The
 * host owns the throwaway user-data-dir (it creates it and best-effort
 * cleans it after Chrome exits) — the implementation layer stays free of
 * node/fs APIs so the same module runs in the WebView. */
export interface ChromeLaunch {
  port: number;
  pid: number;
}

/** Host primitives injected into tool implementations. Kept deliberately
 * small: grow it only when a tool genuinely cannot be expressed over what is
 * here (spawn, fs, fetch, tcp — in that order of demand). Everything here
 * must be expressible in BOTH hosts: Bun (CLI) and the WebView (GUI via
 * Tauri IPC) — no node-API-only primitives. */
export interface ToolRuntime {
  /** Run an argv array directly — no shell on any platform, so quoting is
   * not a concern anywhere in the implementation layer. Rejects only when
   * the program cannot be spawned at all (ENOENT); timeout/abort resolve. */
  runArgv(argv: string[], options?: ArgvRunOptions): Promise<ArgvRunResult>;
  /** First candidate that exists — absolute paths checked as-is, bare names
   * resolved against PATH. Callers may pass the union of ALL platforms'
   * candidates: existence probing is naturally platform-blind, so the
   * implementation layer never needs process.platform itself. */
  resolveExecutable(candidates: string[]): Promise<string | null>;
  /** Spawn a headless Chrome (`args` plus a host-managed throwaway
   * `--user-data-dir`; the host prepends it) with
   * `--remote-debugging-port=0` and report the DevTools port parsed from
   * its stderr (the "DevTools listening on ws://127.0.0.1:<port>/" line).
   * No external debugging port is ever bound: port 0 lets the kernel pick
   * one. Returns null when Chrome exits before reporting a port. */
  launchHeadlessChrome(chromePath: string, args: string[]): Promise<ChromeLaunch | null>;
  /** Persist tool-produced bytes under the host's artifact directory and
   * return the absolute path written (~/.pure/cache/<kind>/ on both hosts).
   * 'screenshot' = browser captures; 'card' = the ```html escape-hatch card
   * payload (W4-3), loaded back via asset:// in an iframe. */
  writeArtifact(kind: 'screenshot' | 'card', basename: string, bytes: Uint8Array): Promise<string>;
}
