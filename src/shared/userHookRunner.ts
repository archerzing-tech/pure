// src/shared/userHookRunner.ts
// Shell runner for user hooks (hooks.json). The engine never spawns processes
// itself: ToolExecutionCoordinator and Harness receive a `UserHookRunner`
// through EngineContext/HarnessConfig. The CLI passes
// createNodeUserHookRunner(); a future GUI passes a Tauri-IPC runner — OS
// capability stays on the host side of the adapter boundary.
//
// Contract (v1):
//  - the payload reaches the hook as one JSON line on stdin;
//  - on_pre_tool exit code 2 blocks the tool call (deterministic gate); any
//    other exit code is non-blocking;
//  - on_post_tool stdout is appended to the string tool result the model sees
//    on the next THINK (capped);
//  - default timeout 10s, per-hook overrides clamped to [1s, 60s]; a timed-out
//    hook is killed and reports exitCode null.

import type { UserHook, UserHookEvent, UserHooksConfig } from './userHooks';
import { stripPowerShellStartupProgress } from './powershellOutput';

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MIN_HOOK_TIMEOUT_MS = 1_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
export const HOOK_STDOUT_CAP_CHARS = 4_000;
export const HOOK_BLOCK_EXIT_CODE = 2;

export interface UserHookPayload {
  event: UserHookEvent;
  tool?: string;
  args?: unknown;
  success?: boolean;
}

export interface UserHookRunResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Set when the permission gate refused to run the hook (it never executed). */
  skippedByGate?: boolean;
}

/** Permission gate consulted before every hook run. Implementations consult
 * the approval store and may ask the user (first enable); any throw denies. */
export interface UserHookGate {
  check(hook: UserHook, event: UserHookEvent): Promise<boolean>;
}

export type UserHookRunner = (hook: UserHook, payload: UserHookPayload) => Promise<UserHookRunResult>;

/** Matcher semantics: no matcher = every tool; trailing `*` = prefix wildcard;
 * otherwise exact tool-name match. Ignored for on_turn_complete. */
export function hookMatchesTool(hook: UserHook, toolName: string | undefined): boolean {
  if (!hook.matcher) return true;
  if (!toolName) return false;
  if (hook.matcher.endsWith('*')) return toolName.startsWith(hook.matcher.slice(0, -1));
  return hook.matcher === toolName;
}

function clampTimeout(hook: UserHook): number {
  const raw = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(Math.max(raw, MIN_HOOK_TIMEOUT_MS), MAX_HOOK_TIMEOUT_MS);
}

function cap(text: string): string {
  return text.length > HOOK_STDOUT_CAP_CHARS ? text.slice(0, HOOK_STDOUT_CAP_CHARS) : text;
}

/** The hook exited without reading the payload we piped it (see the stdin write
 *  in the runner below): an unread payload is not a failure. */
function ignoreBrokenPipe(): void {}

/** kill 后给「超时点上还在途的最后一块」留的冲刷余量。直子进程被 kill 前写
 *  的数据本就在管道缓冲里立即可读，余量不为孙进程的存活时间买单。 */
const KILL_GRACE_MS = 1_000;

/** 逐 read 竞速截止钟读干一条流（审计批 6②）。杀直子进程不等于 EOF——hook
 *  的后台孙进程（`sleep 30 &` 之类）继承写端时，「等流尾」要等孙子死掉才算
 *  数，「超时必返回」的契约会被一个无关进程扣住。Bun 的 stream.cancel() 实测
 *  并不解开挂着的 read（本仓 Bun 1.3.14：Response.text() 在 cancel 后依旧悬
 *  死），所以 read 本身必须被截止钟约束，输了就把已收到的部分带回去。悬着的
 *  read 由 Promise.race 挂着 handler，后续进程死亡导致的 rejection 不会变成
 *  unhandled。 */
async function drainWithDeadline(stream: ReadableStream<Uint8Array>, deadline: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const remainingMs = deadline - Date.now();
    const tick = new Promise<'deadline'>((resolve) => {
      setTimeout(() => resolve('deadline'), Math.max(remainingMs, 0)).unref?.();
    });
    const raced = await Promise.race([reader.read(), tick]);
    if (raced === 'deadline') {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      return out;
    }
    if (raced.done) return out;
    out += decoder.decode(raced.value, { stream: true });
  }
}

/** Node-side runner: `bash -c` on POSIX; PowerShell -EncodedCommand on Windows
 * (the same transport the execute_command tool documents, so quoting behaves
 * identically for hooks and for tool commands). */
export function createNodeUserHookRunner(opts: { cwd?: string } = {}): UserHookRunner {
  return async (hook, payload) => {
    const started = Date.now();
    const isWindows = process.platform === 'win32';
    const argv = isWindows
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(hook.command, 'utf16le').toString('base64')]
      : ['bash', '-c', hook.command];
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // The payload is a courtesy, not a contract: plenty of hooks never read
    // stdin (`command -v prettier`, a lint probe, …) and exit before the write
    // lands, closing the pipe under it. Without this guard bun raises `EPIPE:
    // broken pipe, write` out of the runner — the hook's own result would turn
    // into an exception, breaking the "never a throw" contract its callers rely
    // on (this failed the Linux CI run even though macOS rarely loses the race).
    // Both delivery shapes are covered: the sync throw, and the promise bun
    // returns when the write has to be flushed.
    try {
      void Promise.resolve(proc.stdin.write(JSON.stringify(payload) + '\n')).catch(ignoreBrokenPipe);
      void Promise.resolve(proc.stdin.end()).catch(ignoreBrokenPipe);
    } catch {
      // Unread payload: the hook's exit code and output stay the source of truth.
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 杀直子进程不等于 EOF（审计批 6②）：hook 的后台孙进程（`sleep 30 &`
      // 之类）继承了 stdout/stderr 写端时，流尾要等孙子死掉才来。这里只管
      // 结束直子进程本身；读侧由 drainWithDeadline 的截止钟兜底——Bun 的
      // stream.cancel() 实测并不解开挂着的 read，不能指望它。
      proc.kill();
    }, clampTimeout(hook));
    try {
      // 截止钟 = 超时点 + 一秒冲刷余量：kill 后直子进程的最后写入已在管道
      // 缓冲里立即可读；余量只为「超时点上恰好还有一块在途中」的边角让路，
      // 不给孙进程的存活时间买单。
      const readDeadline = Date.now() + clampTimeout(hook) + KILL_GRACE_MS;
      const [stdout, stderr] = await Promise.all([
        drainWithDeadline(proc.stdout, readDeadline),
        drainWithDeadline(proc.stderr, readDeadline),
      ]);
      await proc.exited;
      // PowerShell writes its module warm-up to stderr as a CLIXML blob. On
      // Windows that blob would BE the hook's stderr (an on_pre_tool veto
      // reports stderr first), so the model and the user would read
      // `#< CLIXML …Preparing modules for first use…` instead of the hook's
      // actual message. Same strip the execute_command tool adapter applies.
      return {
        command: hook.command,
        exitCode: timedOut ? null : proc.exitCode,
        timedOut,
        stdout: cap(stripPowerShellStartupProgress(stdout)),
        stderr: cap(stripPowerShellStartupProgress(stderr)),
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Run every hook registered for `event` whose matcher matches, in config
 * order. A spawn failure becomes a failed result, never a throw — hooks must
 * not take the turn down. */
export async function runUserHooksForEvent(
  config: UserHooksConfig | undefined,
  event: UserHookEvent,
  payload: UserHookPayload,
  runner: UserHookRunner,
): Promise<UserHookRunResult[]> {
  const hooks = config?.[event] ?? [];
  const results: UserHookRunResult[] = [];
  for (const hook of hooks) {
    if (!hookMatchesTool(hook, payload.tool)) continue;
    try {
      results.push(await runner(hook, { ...payload, event }));
    } catch {
      results.push({ command: hook.command, exitCode: null, timedOut: false, stdout: '', stderr: 'hook failed to start', durationMs: 0 });
    }
  }
  return results;
}

/** Wrap a runner with the permission gate: an unapproved hook never executes
 * and reports `skippedByGate` with its stderr set to the skip reason, so the
 * skip surfaces wherever the runner's results are consumed. */
export function createGatedUserHookRunner(
  inner: UserHookRunner,
  gate: UserHookGate,
  onSkip?: (hook: UserHook, event: UserHookEvent) => void,
): UserHookRunner {
  return async (hook, payload) => {
    let approved = false;
    try {
      approved = await gate.check(hook, payload.event);
    } catch {
      approved = false; // a broken gate denies, never bypasses
    }
    if (!approved) {
      onSkip?.(hook, payload.event);
      return { command: hook.command, exitCode: null, timedOut: false, stdout: '', stderr: 'hook not approved — skipped', durationMs: 0, skippedByGate: true };
    }
    return inner(hook, payload);
  };
}
