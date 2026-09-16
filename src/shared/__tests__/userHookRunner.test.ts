import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_STDOUT_CAP_CHARS,
  createNodeUserHookRunner,
  hookMatchesTool,
  runUserHooksForEvent,
  type UserHookPayload,
  type UserHookRunner,
} from '../userHookRunner';

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

  it('captures stdout and runs in the bound cwd', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: 'pwd' }, { event: 'on_turn_complete' });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // bash pwd reports the physical path; macOS symlinks /var into /private/var.
    expect(result.stdout.trim()).toBe(realpathSync(workspace));
  });

  it('passes the payload as JSON on stdin', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const payload: UserHookPayload = { event: 'on_post_tool', tool: 'write_file', args: { path: 'a.txt' }, success: true };
    const result = await run({ command: 'cat' }, payload);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  it('kills hooks that exceed the clamped timeout', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const started = Date.now();
    const result = await run({ command: 'sleep 30', timeoutMs: 1000 }, { event: 'on_turn_complete' });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('clamps sub-minimum overrides up to 1s', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const started = Date.now();
    // 1ms would otherwise race the kill timer; the clamp must hold it at 1s.
    await run({ command: 'sleep 30', timeoutMs: 1 }, { event: 'on_turn_complete' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it('caps captured stdout', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: 'yes x | head -c 10000' }, { event: 'on_turn_complete' });
    expect(result.stdout.length).toBe(HOOK_STDOUT_CAP_CHARS);
  });

  it('reports non-zero exits without throwing', async () => {
    const run = createNodeUserHookRunner({ cwd: workspace });
    const result = await run({ command: 'echo bad >&2; exit 2' }, { event: 'on_pre_tool' });
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
