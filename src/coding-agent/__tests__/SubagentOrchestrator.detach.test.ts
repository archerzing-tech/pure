// src/coding-agent/__tests__/SubagentOrchestrator.detach.test.ts
// 后台委派（2026-11-18 档二）：委派默认后台执行——立刻给受理收执，子引擎
// 在后台跑完，结算经 DetachedBranchPort 交给父引擎。这里只验编排器这一侧：
// 收执形状、结算队列/等待、同参去重、同步退回的三种情形、在飞账本不断。

import { describe, expect, it } from 'bun:test';
import { SubagentOrchestrator, type SubagentProgress } from '../SubagentOrchestrator';
import { Tags } from '../ToolRegistry';
import { MemoryStateStore } from '../../adapter/storage/MemoryStateStore';
import { branchOutcomeOf } from '../../shared/branchOutcome';
import type {
  BudgetConfig,
  LLMAdapter,
  LLMChunk,
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../../shared/types';
import type { SubagentDefinition } from '../types';

const BUDGET: BudgetConfig = {
  maxTurns: 5,
  maxTotalTokens: 10_000,
  maxExecutionTime: 60_000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

const stubAdapter: ToolAdapter = {
  getTools: () => [],
  getMetadata: () => undefined,
  execute: async (tc: ToolCall): Promise<ToolResult> => ({
    id: tc.id,
    toolName: tc.function.name,
    success: false,
    error: 'stub should not be reached',
    duration: 0,
  }),
};

function def(name: string): SubagentDefinition {
  return {
    name,
    description: `Test subagent ${name}`,
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    tags: [Tags.AGENT, Tags.READ],
    riskLevel: 'low',
    createSystemPrompt: (input: Record<string, unknown>) => `You are ${name}. Task: ${String(input.prompt ?? '')}`,
    defaultTimeoutMs: 5_000,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

/** 慢一点的 LLM：让「受理时还在跑」这件事确定成立（Mock 会瞬间跑完）。 */
function delayedLLM(text: string, ms = 40): LLMAdapter {
  return {
    stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      yield { type: 'content', content: text };
      yield { type: 'done', content: text, toolCalls: [] };
    },
    complete: async () => ({ content: text, toolCalls: [] }),
  };
}

function makeOrchestrator(opts: {
  detach: boolean;
  progress?: SubagentProgress;
  stateStore?: MemoryStateStore;
  llm?: LLMAdapter;
  name?: string;
}): SubagentOrchestrator {
  const orch = new SubagentOrchestrator({
    llm: opts.llm ?? delayedLLM('research findings'),
    parentTools: stubAdapter,
    parentToolsDefs: [],
    defaultBudget: BUDGET,
    detachDelegations: opts.detach,
    progress: opts.progress,
    stateStore: opts.stateStore,
    parentSessionId: 'parent-1',
  });
  orch.register(def(opts.name ?? 'test_researcher'));
  return orch;
}

async function waitForSettlement(orch: SubagentOrchestrator, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (orch.pendingCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return orch.takeSettled();
}

describe('委派后台执行（detach）', () => {
  // 2026-11-19 GUI 默认路径修复：config.json 无此键（undefined）时旧判
  // `!== true` 把整条后台委派关死（run7 实测同步委派）——缺省=开。
  it('config 缺省（undefined）= 默认开：受理收执而非同步等待', async () => {
    const orch = new SubagentOrchestrator({
      llm: delayedLLM('research findings'),
      parentTools: stubAdapter,
      parentToolsDefs: [],
      defaultBudget: BUDGET,
      progress: undefined,
      stateStore: undefined,
      parentSessionId: 'parent-1',
    });
    orch.register(def('test_researcher'));
    const receipt = await orch.execute(call('test_researcher', { prompt: 'research X' }));
    expect(receipt.deferred).toBe(true);
    expect(orch.pendingCount()).toBe(1);
    const settled = await waitForSettlement(orch);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.toolName).toBe('test_researcher');
  });

  it('立刻返回受理收执：deferred 标记 + 明说不是产出，支仍在跑', async () => {
    const orch = makeOrchestrator({ detach: true });
    const toolCall = call('test_researcher', { prompt: 'research X' });
    const receipt = await orch.execute(toolCall);

    expect(receipt.success).toBe(true);
    expect(receipt.duration).toBe(0);
    expect(receipt.deferred).toBe(true);
    // 收执里不能出现子代理的产出（那会让模型以为活干完了）。
    expect(JSON.stringify(receipt.result)).not.toContain('research findings');
    expect((receipt.result as { output?: string }).output).toContain('不是产出');
    expect((receipt.result as { output?: string }).output).toContain('不要用相同参数再派一次');
    // 2026-11-18 用户要求：受理当下就提醒模型向用户说一句「趁空档我做什么」。
    expect((receipt.result as { output?: string }).output).toContain('趁这段空档');
    expect((receipt.result as { output?: string }).output).toContain('别套固定句式');
    expect(orch.pendingCount()).toBe(1);
    // 在飞账本还在：stop_branch 对后台支仍可见（能停）。
    expect(orch.branchControlToolDefs().map((d) => d.name)).toContain('stop_branch');
  }, 10_000);

  it('跑完后进结算队列：真实产出取得到，在飞账清零', async () => {
    const orch = makeOrchestrator({ detach: true });
    const toolCall = call('test_researcher', { prompt: 'research X' });
    await orch.execute(toolCall);

    const settled = await waitForSettlement(orch);
    expect(settled).toHaveLength(1);
    expect(settled[0].toolCallId).toBe(toolCall.id);
    expect(settled[0].toolName).toBe('test_researcher');
    const sub = settled[0].result.result as { output?: string };
    expect(sub.output).toContain('research findings');
    expect(orch.pendingCount()).toBe(0);
    // 取即清：再取一次为空，不会重复送达。
    expect(orch.takeSettled()).toHaveLength(0);
  }, 10_000);

  it('waitForSettlement 在结算时唤醒（不必等满一片）', async () => {
    const orch = makeOrchestrator({ detach: true, llm: delayedLLM('late result', 60) });
    await orch.execute(call('test_researcher', { prompt: 'research Y' }));
    const started = Date.now();
    await orch.waitForSettlement(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    const settled = orch.takeSettled();
    expect((settled[0].result.result as { output?: string }).output).toContain('late result');
  }, 10_000);

  it('宿主关掉开关 → 退回同步委派（批次等它跑完）', async () => {
    const orch = makeOrchestrator({ detach: false });
    const result = await orch.execute(call('test_researcher', { prompt: 'research X' }));
    expect(result.deferred).toBeUndefined();
    expect((result.result as { output?: string }).output).toContain('research findings');
    expect(orch.pendingCount()).toBe(0);
  }, 10_000);

  it('调用显式 detach:false → 同步执行（下一步就要用它的产出）', async () => {
    const orch = makeOrchestrator({ detach: true });
    const result = await orch.execute(call('test_researcher', { prompt: 'research X', detach: false }));
    expect(result.deferred).toBeUndefined();
    expect((result.result as { output?: string }).output).toContain('research findings');
  }, 10_000);

  it('relay 链成员强制同步：下游要直接吃上游产出', async () => {
    const orch = makeOrchestrator({ detach: true });
    const result = await orch.execute(call('test_researcher', {
      prompt: 'research X',
      relay: { as: 'research' },
    }));
    expect(result.deferred).toBeUndefined();
    expect((result.result as { output?: string }).output).toContain('research findings');
  }, 10_000);

  it('同参重派：认出在飞的那支，不重复派工', async () => {
    const store = new MemoryStateStore();
    const orch = makeOrchestrator({ detach: true, stateStore: store, llm: delayedLLM('slow result', 80) });
    const first = call('test_researcher', { prompt: 'same brief' });
    await orch.execute(first);
    const second: ToolCall = {
      id: 'call_second',
      index: 0,
      function: { name: 'test_researcher', arguments: first.function.arguments },
    };
    const receipt = await orch.execute(second);
    expect(receipt.deferred).toBe(true);
    expect((receipt.result as { output?: string }).output).toContain(first.id);
    expect(orch.pendingCount()).toBe(1);

    const settled = await waitForSettlement(orch);
    expect(settled).toHaveLength(1);
    // 结算归在最初那支的 callId 下（收执里已经点名）；重派收执作为 alias
    // 一起上报，引擎/宿主才能把它的 deferred 与卡面收口。
    expect(settled[0].toolCallId).toBe(first.id);
    expect(settled[0].aliasToolCallIds).toEqual(['call_second']);
  }, 10_000);

  it('有一次结算就唤醒所有等待者（多支并行）', async () => {
    const orch = makeOrchestrator({ detach: true, llm: delayedLLM('r', 30) });
    await orch.execute({ id: 'call_a', index: 0, function: { name: 'test_researcher', arguments: JSON.stringify({ prompt: 'A' }) } });
    await orch.execute({ id: 'call_b', index: 0, function: { name: 'test_researcher', arguments: JSON.stringify({ prompt: 'B' }) } });
    expect(orch.pendingCount()).toBe(2);
    await orch.waitForSettlement(5_000);
    // 至少一支已结算（等待被唤醒），余下的继续跑。
    expect(orch.takeSettled().length).toBeGreaterThanOrEqual(1);
    const rest = await waitForSettlement(orch);
    expect(rest.length + 1).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

// 后台支的上限与止损（2026-11-18 档二）：detach 之后 worker 数不再受「一批」
// 约束，上限 6 是唯一硬线；stop_branch 必须有真实通路，否则「在飞账还在」
// 只是纸面保证。
describe('后台支的上限与止损', () => {
  it('后台支已达上限 6 → 第 7 支退回同步执行（不拒绝、不丢活）', async () => {
    const orch = makeOrchestrator({ detach: true, llm: delayedLLM('slow result', 150) });
    for (let i = 0; i < 6; i++) {
      const receipt = await orch.execute({
        id: `call_d${i}`,
        index: 0,
        function: { name: 'test_researcher', arguments: JSON.stringify({ prompt: `task ${i}` }) },
      });
      expect(receipt.deferred).toBe(true);
    }
    expect(orch.pendingCount()).toBe(6);

    const seventh = await orch.execute({
      id: 'call_d6',
      index: 0,
      function: { name: 'test_researcher', arguments: JSON.stringify({ prompt: 'task 6' }) },
    });
    // 同步那支等到了真产出，且不占后台结算位（在飞 6 支的结算里没有它）。
    expect(seventh.deferred).toBeUndefined();
    expect((seventh.result as { output?: string }).output).toContain('slow result');

    const settled = await waitForSettlement(orch);
    expect(settled).toHaveLength(6);
    expect(settled.some((s) => s.toolCallId === 'call_d6')).toBe(false);
    expect(orch.pendingCount()).toBe(0);
  }, 10_000);

  it('stop_branch 真的能停一支后台支：结算按暂停记账，产出不入账', async () => {
    const orch = makeOrchestrator({ detach: true, stateStore: new MemoryStateStore(), llm: delayedLLM('never arrives', 300) });
    const deleg = call('test_researcher', { prompt: 'long job' });
    await orch.execute(deleg);
    expect(orch.pendingCount()).toBe(1);

    const stopped = await orch.execute({
      id: 'call_stop',
      index: 0,
      function: { name: 'stop_branch', arguments: JSON.stringify({ call_id: deleg.id, mode: 'pause' }) },
    });
    expect(stopped.success).toBe(true);
    expect(stopped.outcome).toBe('paused');

    const settled = await waitForSettlement(orch);
    expect(settled).toHaveLength(1);
    expect(settled[0].toolCallId).toBe(deleg.id);
    // 暂停不是失败：success 保持 true、结算体内层标 paused（branchOutcomeOf
    // 读的就是这一层）、产出没混进来。
    expect(settled[0].result.success).toBe(true);
    expect(branchOutcomeOf(settled[0])).toBe('paused');
    expect(JSON.stringify(settled[0].result.result)).not.toContain('never arrives');
  }, 10_000);
});
