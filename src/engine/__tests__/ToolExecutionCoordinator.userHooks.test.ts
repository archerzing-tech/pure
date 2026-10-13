// User-hook wiring through the real ToolExecutionCoordinator: on_pre_tool can
// veto a call (exit 2) before it touches locks or the adapter, on_post_tool
// stdout lands in the model-visible string result, and everything degrades to
// "no hooks" when no runner is wired.
//
// Timing: every test here spawns a real shell. On a cold Windows runner the
// first powershell.exe launches cost seconds each (module warm-up plus initial
// AV scanning — measured >5s on CI), and the hook budget itself is 10s, so
// bun's 5s default test timeout would report a hang that is not there. Each
// spawning test therefore carries explicit headroom.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolExecutionCoordinator, type ToolExecutionBudget } from '../ToolExecutionCoordinator';
import { createNodeUserHookRunner, type UserHookRunner } from '../../shared/userHookRunner';
import type { UserHooksConfig } from '../../shared/userHooks';
import type { EngineContext, ToolAdapter, ToolCall, ToolDefinition, ToolResult } from '../../shared/types';

class FakeTools implements ToolAdapter {
  calls: ToolCall[] = [];
  constructor(private readonly result: ToolResult) {}
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    this.calls.push(toolCall);
    return this.result;
  }
  getMetadata(): undefined {
    return undefined;
  }
  getTools(): ToolDefinition[] {
    return [];
  }
}

const BUDGET: ToolExecutionBudget = {
  incrementToolCall() {},
  remaining: () => ({ time: 1_000_000 }),
  streamDeadlineMs: () => 60_000,
};

const CALL: ToolCall = { id: 'c1', index: 0, function: { name: 'write_file', arguments: '{}' } };

describe('ToolExecutionCoordinator user hooks', () => {
  let workspace: string;
  let runner: UserHookRunner;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-coordinator-hooks-'));
    runner = createNodeUserHookRunner({ cwd: workspace });
    // Windows 冷 runner 的第一发 powershell 要付模块预热 + AV 扫描（注释上方
    // 实测 >5s；v3.3.1 两次 Release 在 10s 钩子预算到期处连红同一用例，
    // [10022ms] 即预算钟）。这笔开销必须付在断言外：满额超时的空钩子把进程
    // 首启烧掉，带默认预算的断言用例只摸暖后的系统缓存。2026-10-13。
    await runner({ command: 'echo warm-up', timeoutMs: 60_000 }, { event: 'on_pre_tool', tool: 'warm_up' });
  }, 70_000);

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function executeWith(tools: FakeTools, hooks?: UserHooksConfig, withRunner = true) {
    const ctx = {
      tools,
      ...(hooks ? { userHooks: hooks } : {}),
      ...(withRunner ? { userHookRunner: runner } : {}),
    } as unknown as EngineContext;
    const results = await new ToolExecutionCoordinator().execute([CALL], ctx, BUDGET);
    return results[0];
  }

  it('on_pre_tool exit 2 vetoes the call before the adapter sees it', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'tool-ok', success: true, duration: 1 });
    const result = await executeWith(tools, { on_pre_tool: [{ command: 'echo not-allowed; exit 2' }] });
    expect(tools.calls).toHaveLength(0);
    expect(result?.result.success).toBe(false);
    const error = (result?.result as ToolResult).error ?? '';
    expect(error.startsWith('[on_pre_tool hook]')).toBe(true);
    expect(error).toContain('not-allowed');
  }, 30_000);

  it('on_pre_tool non-zero exits other than 2 are non-blocking', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'tool-ok', success: true, duration: 1 });
    const result = await executeWith(tools, { on_pre_tool: [{ command: 'exit 1' }] });
    expect(tools.calls).toHaveLength(1);
    expect(result?.result.success).toBe(true);
  }, 30_000);

  it('on_post_tool stdout is appended to the model-visible string result', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'tool-ok', success: true, duration: 1 });
    const result = await executeWith(tools, { on_post_tool: [{ command: 'echo lint-ok' }] });
    expect((result?.result as ToolResult).result).toBe('tool-ok\n[hook] lint-ok');
  }, 30_000);

  it('on_post_tool also fires when the tool reports failure', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'boom', success: false, duration: 1 });
    const result = await executeWith(tools, { on_post_tool: [{ command: 'echo cleaned-up' }] });
    expect((result?.result as ToolResult).result).toBe('boom\n[hook] cleaned-up');
  }, 30_000);

  it('a matcher that does not match the tool skips the hook', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'tool-ok', success: true, duration: 1 });
    const result = await executeWith(tools, { on_post_tool: [{ command: 'echo other', matcher: 'web_*' }] });
    expect((result?.result as ToolResult).result).toBe('tool-ok');
  });

  it('without a runner the config is ignored entirely', async () => {
    const tools = new FakeTools({ id: 'c1', toolName: 'write_file', result: 'tool-ok', success: true, duration: 1 });
    const result = await executeWith(tools, { on_pre_tool: [{ command: 'exit 2' }], on_post_tool: [{ command: 'echo x' }] }, false);
    expect(tools.calls).toHaveLength(1);
    expect((result?.result as ToolResult).result).toBe('tool-ok');
  });
});
