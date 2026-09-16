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
    proc.stdin.write(JSON.stringify(payload) + '\n');
    proc.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, clampTimeout(hook));
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return {
        command: hook.command,
        exitCode: timedOut ? null : proc.exitCode,
        timedOut,
        stdout: cap(stdout),
        stderr: cap(stderr),
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
