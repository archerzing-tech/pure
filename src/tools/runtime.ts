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

/** Host primitives injected into tool implementations. Kept deliberately
 * small: grow it only when a tool genuinely cannot be expressed over what is
 * here (spawn, fs, fetch, tcp — in that order of demand). */
export interface ToolRuntime {
  /** Run an argv array directly — no shell on any platform, so quoting is
   * not a concern anywhere in the implementation layer. Rejects only when
   * the program cannot be spawned at all (ENOENT); timeout/abort resolve. */
  runArgv(argv: string[], options?: ArgvRunOptions): Promise<ArgvRunResult>;
}
