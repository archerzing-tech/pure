import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_STDOUT_CAP_CHARS,
  createGatedUserHookRunner,
  createNodeUserHookRunner,
  hookMatchesTool,
  runUserHooksForEvent,
  type UserHookGate,
  type UserHookPayload,
  type UserHookRunner,
} from '../userHookRunner';
import type { UserHook, UserHookEvent } from '../userHooks';

/** Marker the cwd test writes into the bound workspace. */
const MARKER_FILE = 'hook-cwd-marker.txt';

describe('hookMatchesTool', () => {
  it('no matcher matches everything, including a missing tool name', () => {
    expect(hookMatchesTool({ command: 'x' }, 'write_file')).toBe(true);
    expect(hookMatchesTool({ command: 'x' }, undefined)).toBe(true);
  });

  it('exact match and prefix wildcard', () => {
    expect(hookMatchesTool({ command: 'x', matcher: 'write_file' }, 'write_file')).toBe(true);
    expect(hookMatchesTool({ command: 'x', matcher: 'write_file' }, 'write_files')).toBe(false);
    expect(hookMatchesTool({ command: 'x', matcher: 'mcp_*' }, 'mcp_github')).toBe(true);
    expect(hookMatchesTool({ command: 'x', matcher: 'mcp_*' }, 'web_search')).toBe(false);
  });

  it('a matcher never matches a missing tool name', () => {
    expect(hookMatchesTool({ command: 'x', matcher: 'write_file' }, undefined)).toBe(false);
  });
});

describe('createNodeUserHookRunner', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-hook-runner-'));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // Hooks are shell commands, and the shell is platform-native by design
  // (bash -c on POSIX, PowerShell -EncodedCommand on Windows — the same
  // transport execute_command documents). Each behaviour therefore needs its
  // command spelled per platform; the assertions stay identical.
  const isWindows = process.platform === 'win32';
  const hookCommands = {
    // Relative-path resolution proves the bound cwd without comparing path
    // strings: Windows reports the same temp dir as either the 8.3 short or
    // the long form depending on who asks, so a path equality check would be
    // testing path formatting, not the cwd binding.
    echoStdin: isWindows ? '[Console]::Out.Write([Console]::In.ReadToEnd())' : 'cat',
    markerOrNothing: isWindows ? `if (Test-Path ${MARKER_FILE}) { Write-Output bound }` : `test -f ${MARKER_FILE} && echo bound`,
    flood: isWindows ? "[Console]::Out.Write('x' * 10000)" : 'yes x | head -c 10000',
    failWithMessage: isWindows ? "[Console]::Error.Write('bad'); exit 2" : 'echo bad >&2; exit 2',
    sleepLong: isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30',
  };

  it('captures stdout and runs in the bound cwd', async () => {
    writeFileSync(join(workspace, MARKER_FILE), 'x');
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: hookCommands.markerOrNothing }, { event: 'on_turn_complete' });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('bound');
  });

  it('passes the payload as JSON on stdin', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const payload: UserHookPayload = { event: 'on_post_tool', tool: 'write_file', args: { path: 'a.txt' }, success: true };
    const result = await run({ command: hookCommands.echoStdin }, payload);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('kills hooks that exceed the clamped timeout', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const started = Date.now();
    const result = await run({ command: hookCommands.sleepLong, timeoutMs: 1000 }, { event: 'on_turn_complete' });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('clamps sub-minimum overrides up to 1s', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const started = Date.now();
    // 1ms would otherwise race the kill timer; the clamp must hold it at 1s.
    await run({ command: hookCommands.sleepLong, timeoutMs: 1 }, { event: 'on_turn_complete' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it('caps captured stdout', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: hookCommands.flood }, { event: 'on_turn_complete' });
    expect(result.stdout.length).toBe(HOOK_STDOUT_CAP_CHARS);
  });

  // Windows parity, testable anywhere: the runner must not hand PowerShell's
  // CLIXML warm-up blob back as the hook's stderr. An on_pre_tool veto reports
  // stderr first, so on Windows this blob — not the hook's own message — used
  // to become the model-visible reason the tool was blocked.
  it('drops the PowerShell CLIXML warm-up blob from captured output', async () => {
    const clixml = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
      + '<Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>';
    writeFileSync(join(workspace, 'warmup.txt'), clixml, 'utf8');
    const dump = isWindows
      ? "Get-Content warmup.txt -Raw | ForEach-Object { [Console]::Error.Write($_) }; exit 2"
      : 'cat warmup.txt >&2; exit 2';
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: dump }, { event: 'on_pre_tool' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
  });

  it('reports non-zero exits without throwing', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: hookCommands.failWithMessage }, { event: 'on_pre_tool' });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim()).toBe('bad');
  });
});

describe('runUserHooksForEvent', () => {
  function recordingRunner(stdout = 'ok'): { runner: UserHookRunner; seen: string[] } {
    const seen: string[] = [];
    const runner: UserHookRunner = async (hook, payload) => {
      seen.push(`${payload.event}:${hook.command}`);
      return { command: hook.command, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 1 };
    };
    return { runner, seen };
  }

  it('filters by event and matcher, preserving config order', async () => {
    const { runner, seen } = recordingRunner();
    const config = {
      on_pre_tool: [{ command: 'a.sh', matcher: 'write_*' }, { command: 'b.sh' }],
      on_post_tool: [{ command: 'c.sh' }],
    };
    const results = await runUserHooksForEvent(config, 'on_pre_tool', { event: 'on_pre_tool', tool: 'write_file' }, runner);
    expect(seen).toEqual(['on_pre_tool:a.sh', 'on_pre_tool:b.sh']);
    expect(results.map((r) => r.command)).toEqual(['a.sh', 'b.sh']);
  });

  it('a spawn failure becomes a failed result, never a throw', async () => {
    const runner: UserHookRunner = async () => {
      throw new Error('boom');
    };
    const results = await runUserHooksForEvent({ on_turn_complete: [{ command: 'x.sh' }] }, 'on_turn_complete', { event: 'on_turn_complete' }, runner);
    expect(results).toHaveLength(1);
    expect(results[0]?.stderr).toBe('hook failed to start');
  });

  it('tolerates a missing config', async () => {
    const { runner, seen } = recordingRunner();
    const results = await runUserHooksForEvent(undefined, 'on_pre_tool', { event: 'on_pre_tool', tool: 'x' }, runner);
    expect(results).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('createGatedUserHookRunner', () => {
  const HOOK: UserHook = { command: 'lint.sh' };
  const PAYLOAD: UserHookPayload = { event: 'on_pre_tool', tool: 'write_file' };

  function makeGate(outcome: boolean | Error): { gate: UserHookGate; asked: Array<{ hook: UserHook; event: UserHookEvent }> } {
    const asked: Array<{ hook: UserHook; event: UserHookEvent }> = [];
    const gate: UserHookGate = {
      async check(hook, event) {
        asked.push({ hook, event });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
    return { gate, asked };
  }

  it('an unapproved hook never reaches the inner runner and is reported to onSkip', async () => {
    const inner: UserHookRunner = async () => {
      throw new Error('inner must not run');
    };
    const skips: string[] = [];
    const { gate } = makeGate(false);
    const run = createGatedUserHookRunner(inner, gate, (hook, event) => skips.push(`${event}:${hook.command}`));
    const result = await run(HOOK, PAYLOAD);
    expect(result.skippedByGate).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('not approved');
    expect(result.durationMs).toBe(0);
    expect(skips).toEqual(['on_pre_tool:lint.sh']);
  });

  it('an approved hook passes through to the inner runner untouched', async () => {
    const inner: UserHookRunner = async (hook) => ({ command: hook.command, exitCode: 0, timedOut: false, stdout: 'ran', stderr: '', durationMs: 3 });
    const skips: string[] = [];
    const { gate, asked } = makeGate(true);
    const run = createGatedUserHookRunner(inner, gate, () => skips.push('x'));
    const result = await run(HOOK, PAYLOAD);
    expect(result.stdout).toBe('ran');
    expect(result.skippedByGate).toBeUndefined();
    expect(skips).toEqual([]);
    expect(asked).toEqual([{ hook: HOOK, event: 'on_pre_tool' }]);
  });

  it('a throwing gate denies (fail closed), it never bypasses', async () => {
    const inner: UserHookRunner = async () => {
      throw new Error('inner must not run');
    };
    const { gate } = makeGate(new Error('store exploded'));
    const run = createGatedUserHookRunner(inner, gate);
    const result = await run(HOOK, PAYLOAD);
    expect(result.skippedByGate).toBe(true);
    expect(result.stderr).toContain('not approved');
  });
});
