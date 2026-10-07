// src/coding-agent/__tests__/externalToolQuarantine.test.ts
// 阶段 13.4 停用门的**接线**测试：执行面计数 + 停用后拒绝 + 计数跨回合持久化。
//
// 判据本身在 harness/toolQuarantine.test.ts（纯函数）。这里锁的是「判据有没有真
// 被接上」——上一版正是判据写对了、接线是死的：宿主 seed 不读盘、每回合新建
// executor、`quarantinedToolResult` 全仓库只有测试引用，而这一切都不会让任何单测
// 变红，因为它们都在各自的层里自洽。

import { describe, expect, it } from 'bun:test';
import { CodingAgent, type CodingAgentConfig, type ExternalToolQuarantineHost } from '../CodingAgent';
import type { TaggedTool } from '../types';
import type { ToolAdapter, ToolCall, ToolResult } from '../../shared/types';
import { emptyQuarantineState, type ToolQuarantineCard, type ToolQuarantineState } from '../../harness/toolQuarantine';

const TOOL: TaggedTool = {
  name: 'flaky_tool',
  description: 'a generated external tool used by these tests',
  input_schema: { type: 'object', properties: {}, required: [] },
  tags: ['shell', 'external'],
  riskLevel: 'medium',
};

/** execute_command stub: outcome decides the whole test, so each case scripts
 *  the exact shell behaviour the classifier is supposed to tell apart. */
function delegateReturning(behaviour: 'ok' | 'no-match' | 'ran-failure' | 'not-found' | 'abort'): ToolAdapter {
  return {
    getTools: () => [],
    getMetadata: () => ({ isWrite: false }),
    execute: async (tc: ToolCall): Promise<ToolResult> => {
      expect(tc.function.name).toBe('execute_command');
      const base = { id: tc.id, toolName: 'execute_command' };
      switch (behaviour) {
        case 'ok':
          return { ...base, success: true, duration: 1, result: { stdout: 'hit', stderr: '', exitCode: 0 } };
        case 'no-match':
          // grep without a match: exit 1, silent. A successful run.
          return { ...base, success: false, duration: 1, error: 'exit code 1', result: { stdout: '', stderr: '', exitCode: 1 } };
        case 'ran-failure':
          // diff with differences / a failing test suite: exit 1, output on stdout.
          return { ...base, success: false, duration: 1, error: 'exit code 1', result: { stdout: '-a\n+b', stderr: '', exitCode: 1 } };
        case 'not-found':
          // The script was deleted: 127 and silent.
          return { ...base, success: false, duration: 1, error: 'exit code 127', result: { stdout: '', stderr: '', exitCode: 127 } };
        case 'abort':
          return { ...base, success: false, duration: 1, error: 'Command timed out after 120000ms', outcome: 'paused' as const, result: { stdout: '', stderr: '', exitCode: -1 } };
      }
    },
  };
}

/** Records what the executor asked the host to do. */
function recordingHost(seed?: Map<string, ToolQuarantineState>) {
  const records: Array<{ name: string; state: ToolQuarantineState }> = [];
  const cards: ToolQuarantineCard[] = [];
  const host: ExternalToolQuarantineHost = {
    seed: (name) => seed?.get(name) ?? emptyQuarantineState(),
    record: (name, state) => { records.push({ name, state: { ...state } }); },
    mark: (_name, _state, card) => { cards.push(card); },
  };
  return { host, records, cards };
}

function agentFor(behaviour: Parameters<typeof delegateReturning>[0], host?: ExternalToolQuarantineHost) {
  const agent = new CodingAgent({
    toolAdapter: delegateReturning(behaviour),
    // The counting path lives before the engine loop, so the three config
    // fields the constructor insists on are stubbed, not worked around.
    sessionId: 'quarantine-test',
    llm: {} as CodingAgentConfig['llm'],
    budget: { maxTurns: 1, maxTotalTokens: 1000, maxExecutionTime: 1000, warningThreshold: 0.8, graceTurns: 0 },
    externalTools: [TOOL],
    externalToolExecs: new Map([[TOOL.name, { exec: 'run.sh {x}', timeoutMs: 5000 }]]),
    ...(host ? { externalToolQuarantine: host } : {}),
  });
  return agent;
}

/** Go through the registry, the way the engine does — the registry is what
 *  routes Tags.EXTERNAL to the counting executor. */
async function call(agent: CodingAgent, signal?: AbortSignal): Promise<ToolResult> {
  return agent.toolRegistry.execute(
    { id: `call_${Math.random().toString(36).slice(2)}`, index: 0, function: { name: TOOL.name, arguments: '{"x":"1"}' } },
    signal,
  );
}

describe('执行面：只有「工具跑不起来」才进计数器', () => {
  it('grep 没匹配（exit 1 静默）连跑五次也不停用', async () => {
    const { host, records, cards } = recordingHost();
    const agent = agentFor('no-match', host);
    for (let i = 0; i < 5; i++) await call(agent);
    expect(records).toHaveLength(5);
    expect(records.at(-1)!.state.consecutiveFailures).toBe(0);
    expect(cards).toHaveLength(0);
  });

  it('diff/测试类的「有输出的非零退出」连跑五次也不停用', async () => {
    const { host, cards } = recordingHost();
    const agent = agentFor('ran-failure', host);
    for (let i = 0; i < 5; i++) await call(agent);
    expect(cards).toHaveLength(0);
  });

  it('用户按 Stop / 超时连跑五次也不停用', async () => {
    const { host, cards } = recordingHost();
    const agent = agentFor('abort', host);
    for (let i = 0; i < 5; i++) await call(agent);
    expect(cards).toHaveLength(0);
  });

  it('脚本被删（127 静默）连到线上才停用，且只出一次卡', async () => {
    const { host, cards } = recordingHost();
    const agent = agentFor('not-found', host);
    for (let i = 0; i < 5; i++) await call(agent);
    expect(cards).toHaveLength(1);
    expect(cards[0].toolName).toBe(TOOL.name);
  });
});

describe('执行面：停用后拒绝，且不跑命令', () => {
  it('已停用的工具下一次调用立刻被拒，回执说清怎么恢复', async () => {
    const seed = new Map<string, ToolQuarantineState>([[TOOL.name, { ...emptyQuarantineState(), quarantined: true, reason: '早先停用了' }]]);
    const { host, records } = recordingHost(seed);
    const agent = agentFor('ok', host); // the delegate WOULD succeed — it must never be reached
    const result = await call(agent);
    expect(result.success).toBe(false);
    expect(result.error).toContain('已被自动停用');
    expect(result.error).toContain('早先停用了');
    expect(result.error).toContain('重新启用');
    // Refused calls are not counted: they are the gate working, not the tool failing.
    expect(records).toHaveLength(0);
  });
});

describe('执行面：计数跨回合（判据接没接上的真判据）', () => {
  it('每回合 2 次「跑不起来」，跨回合攒到线上才停用', async () => {
    // This is the shape the gate exists for: a tool that rots over many turns.
    // With a per-turn counter it never trips; with a persisted one it trips on
    // turn 2's first call.
    const persisted = new Map<string, ToolQuarantineState>();
    const cards: ToolQuarantineCard[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const host: ExternalToolQuarantineHost = {
        // A fresh host per turn, exactly like chat.ts builds one — the seed it
        // gets is what carries the memory.
        seed: (name) => persisted.get(name) ?? emptyQuarantineState(),
        record: (name, state) => { persisted.set(name, { ...state }); },
        mark: (_n, _s, card) => { cards.push(card); },
      };
      const agent = agentFor('not-found', host);
      await call(agent);
      await call(agent);
      if (turn === 1) expect(cards).toHaveLength(0);
    }
    expect(cards.length).toBe(1);
    expect(persisted.get(TOOL.name)?.quarantined).toBe(true);
  });
});

describe('红线：不接宿主就没有这道门，且不误伤', () => {
  it('未接宿主时执行路径与从前逐字节一致', async () => {
    const agent = agentFor('not-found');
    const result = await call(agent);
    // No host ⇒ no counting ⇒ the real delegate result comes straight back.
    expect(result.success).toBe(false);
    expect(result.error).toBe('exit code 127');
  });
});

describe('同一回合内刚被停用：下一次调用立刻被拒', () => {
  it('模型这一轮已经选中了它，脚本不再跑第二次', async () => {
    // 装载面的剔除只对「下一次装载」有效；工具是在这一轮跑到一半被判停用的，
    // 模型的 tool_call 里已经有它了。执行面的兜底就是为这一刻存在的。
    const { host, cards } = recordingHost();
    const agent = agentFor('not-found', host);
    for (let i = 0; i < 3; i++) await call(agent);
    expect(cards).toHaveLength(1);
    const after = await call(agent);
    expect(after.success).toBe(false);
    expect(after.error).toContain('已被自动停用');
    // 拒绝的那次不进计数器：那是门在生效，不是工具又坏了一次。
    expect(cards).toHaveLength(1);
  });
});
