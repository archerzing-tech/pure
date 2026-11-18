// src/engine/__tests__/AgentLoopEngine.detachedBranches.test.ts
// 后台委派（2026-11-18 档二）：委派 detach 后批次立刻清空，产出晚到。
// 引擎只做三件物理事——配平点取结果、收尾前等收齐、不把受理收执当产出复用。
// 这里用假端口（DetachedBranchPort）验证这三条接线，不掺真子引擎。

import { describe, it, expect } from 'bun:test';
import { AgentLoopEngine } from '../AgentLoopEngine';
import { EventFanout } from '../../shared/asyncQueue';
import type {
  BudgetConfig,
  DetachedBranchPort,
  DetachedBranchSettlement,
  EngineContext,
  EngineEvent,
  LLMAdapter,
  LLMChunk,
  Message,
  SubagentActivityEvent,
  ToolAdapter,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../../shared/types';

const BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
  hardMaxTurns: 60,
  hardMaxTokens: 400_000,
  hardMaxTime: 1_200_000,
};

const EDITOR_TOOL: ToolDefinition = {
  name: 'code_editor',
  description: 'Delegated editor',
  input_schema: { type: 'object', properties: { instructions: { type: 'string' } } },
};
const READ_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } } },
};

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** 假端口：手动登记在飞支、手动结算，行为与编排器实现同形（永不 reject）。 */
class FakeBranches implements DetachedBranchPort {
  private pending = new Set<string>();
  private settled: DetachedBranchSettlement[] = [];
  private waiters: Array<() => void> = [];

  add(callId: string, toolName = 'code_editor'): void {
    this.pending.add(callId);
    void toolName;
  }

  settle(callId: string, output: string, opts: { success?: boolean; aliasToolCallIds?: string[] } = {}): void {
    this.pending.delete(callId);
    const success = opts.success ?? true;
    this.settled.push({
      toolCallId: callId,
      ...(opts.aliasToolCallIds?.length ? { aliasToolCallIds: opts.aliasToolCallIds } : {}),
      toolName: 'code_editor',
      duration: 7,
      result: success
        ? { id: callId, toolName: 'code_editor', success: true, duration: 7, result: { output } }
        : { id: callId, toolName: 'code_editor', success: false, duration: 7, error: output },
    });
    for (const wake of [...this.waiters]) wake();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  takeSettled(): DetachedBranchSettlement[] {
    return this.settled.splice(0);
  }

  waitForSettlement(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.settled.length > 0 || this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.waiters = this.waiters.filter((wake) => wake !== finish);
        resolve();
      };
      timer = setTimeout(finish, Math.max(10, timeoutMs));
      signal?.addEventListener('abort', finish, { once: true });
      this.waiters.push(finish);
    });
  }
}

/** 受理收执（与编排器 acceptedReceipt 同形）。 */
function receipt(tc: ToolCall): ToolResult {
  return {
    id: tc.id,
    toolName: tc.function.name,
    success: true,
    duration: 0,
    deferred: true,
    result: { output: `已受理，正在后台跑（call_id=${tc.id}）` },
  };
}

function delegationAdapter(port: FakeBranches, settleDelayMs = 20): ToolAdapter {
  return {
    getTools: () => [EDITOR_TOOL, READ_TOOL],
    getMetadata: (name: string) => ({ isWrite: name === 'read_file' ? false : false }),
    execute: async (tc: ToolCall): Promise<ToolResult> => {
      if (tc.function.name === 'code_editor') {
        port.add(tc.id);
        setTimeout(() => port.settle(tc.id, 'REAL MODULE OUTPUT'), settleDelayMs);
        return receipt(tc);
      }
      return { id: tc.id, toolName: tc.function.name, success: true, duration: 1, result: 'file body' };
    },
  };
}

/** 每轮由回调决定：返回 toolCalls 或最终文本。 */
function scriptedLLM(
  rounds: Array<Array<{ name: string; args: Record<string, unknown> }> | string>,
): { llm: LLMAdapter; seen: Message[][]; roundCount: () => number } {
  const seen: Message[][] = [];
  let idx = 0;
  const llm: LLMAdapter = {
    stream: async function* (messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
      seen.push([...messages]);
      const round = rounds[idx++];
      if (round === undefined || typeof round === 'string') {
        const content = typeof round === 'string' ? round : 'done';
        yield { type: 'content', content };
        yield { type: 'done', content, toolCalls: [] };
        return;
      }
      const tcs: ToolCall[] = round.map((r, i) => ({
        id: `call_${idx}_${i}`,
        index: i,
        function: { name: r.name, arguments: JSON.stringify(r.args) },
      }));
      for (const tc of tcs) {
        yield { type: 'tool_call_delta', index: tc.index, name: tc.function.name, arguments: tc.function.arguments };
        yield { type: 'tool_call', index: tc.index, id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
      }
      yield { type: 'done', content: '', toolCalls: tcs };
    },
    complete: async () => ({ content: 'done', toolCalls: [] }),
  };
  return { llm, seen, roundCount: () => idx };
}

function baseCtx(overrides: Partial<EngineContext> = {}): EngineContext {
  return { llm: scriptedLLM(['hello']).llm, toolsDefs: [], budget: BUDGET, ...overrides };
}

function internalNotes(messages: Message[]): string[] {
  return messages
    .filter((m) => m.role === 'user' && m.internal && typeof m.content === 'string')
    .map((m) => m.content);
}

function transcriptIsPaired(messages: Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const needed = new Set(m.toolCalls.map((tc) => tc.id));
    for (let j = i + 1; j < messages.length && needed.size > 0; j++) {
      if (messages[j].role === 'assistant') break;
      const toolCallId = messages[j].toolCallId;
      if (messages[j].role === 'tool' && toolCallId) needed.delete(toolCallId);
    }
    if (needed.size > 0) return false;
  }
  return true;
}

describe('后台委派：配平点送达（2026-11-18 档二）', () => {
  it('工具批结束后把已结算的后台结果作为内部消息送达，并补一条 backgroundSettle 事件', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const { llm } = scriptedLLM([
      [{ name: 'code_editor', args: { instructions: 'write module A' } }],
      // 第二轮是普通工具：给结算留出落地的窗口，测的是「批结束时的配平点」。
      [{ name: 'read_file', args: { path: 'src/a.ts' } }],
      'final answer',
    ]);
    const adapter = delegationAdapter(port, 10);
    // 让第二轮的工具慢一点，结算必然落在它执行期间。
    const slowRead: ToolAdapter = {
      ...adapter,
      execute: async (tc) => {
        if (tc.function.name === 'read_file') await new Promise((r) => setTimeout(r, 60));
        return adapter.execute(tc);
      },
    };
    const ctx = baseCtx({
      llm,
      tools: slowRead,
      toolsDefs: [EDITOR_TOOL, READ_TOOL],
      detachedBranches: port,
    });

    const events = await collect(engine.run(
      { sessionId: 's-detach-deliver', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));

    const completed = events.find((e) => e.type === 'Completed' && e.payload.isComplete);
    expect(completed).toBeDefined();
    const messages = (completed as Extract<EngineEvent, { type: 'Completed' }>).payload.messages ?? [];
    const notes = internalNotes(messages);
    expect(notes.some((n) => n.includes('[background branch settled]') && n.includes('REAL MODULE OUTPUT'))).toBe(true);
    // 结算事件走同 toolCallId 的 ToolResult，宿主据此把挂起卡换成真结果。
    const settle = events.find((e) => e.type === 'ToolResult' && e.payload.backgroundSettle === true);
    expect(settle).toBeDefined();
    expect((settle as Extract<EngineEvent, { type: 'ToolResult' }>).payload.toolCallId).toBe('call_1_0');
    // 受理收执也要在转录里（配对契约），且整体配对完整。
    expect(transcriptIsPaired(messages)).toBe(true);
    // 崩溃恢复判据：收执消息先带 deferred 标记，送达后降回 false——否则重启
    // 会把已送达的支报成「丢了」再喊一遍。
    const receiptEvent = events.find((e) => e.type === 'ToolResult' && e.payload.toolCallId === 'call_1_0' && e.payload.backgroundSettle !== true);
    expect((receiptEvent as Extract<EngineEvent, { type: 'ToolResult' }>).payload.result.deferred).toBe(true);
    const receiptMessage = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1_0');
    expect(receiptMessage?.deferred).toBe(false);
    expect(port.pendingCount()).toBe(0);
  }, 10_000);

  // 同参重派（2026-11-18 beta 审查）：新调用拿到的是指向原支的收执，它不是
  // 独立支——结算归原 callId，但它的 deferred 也必须一起清掉，否则卡面永久
  // 「⏳ 后台运行中」，下次重启还会被崩溃恢复误报成丢了的那批。
  it('同参重派的收执随原支结算：alias 的 deferred 清掉，产出只送达一次', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const { llm } = scriptedLLM([
      [
        { name: 'code_editor', args: { instructions: 'same module' } },
        { name: 'code_editor', args: { instructions: 'same module' } },
      ],
      'final answer',
    ]);
    const executed: string[] = [];
    const adapter: ToolAdapter = {
      getTools: () => [EDITOR_TOOL],
      getMetadata: () => ({ isWrite: false }),
      execute: async (tc: ToolCall): Promise<ToolResult> => {
        executed.push(tc.id);
        if (executed.length === 1) {
          port.add(tc.id);
          setTimeout(() => port.settle(tc.id, 'REAL MODULE OUTPUT', { aliasToolCallIds: ['call_1_1'] }), 10);
        }
        return receipt(tc);
      },
    };
    const events = await collect(engine.run(
      { sessionId: 's-detach-alias', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      baseCtx({ llm, tools: adapter, toolsDefs: [EDITOR_TOOL], detachedBranches: port }),
    ));

    const completed = events.find((e) => e.type === 'Completed' && e.payload.isComplete);
    const messages = (completed as Extract<EngineEvent, { type: 'Completed' }>).payload.messages ?? [];
    for (const callId of ['call_1_0', 'call_1_1']) {
      expect(messages.find((m) => m.role === 'tool' && m.toolCallId === callId)?.deferred).toBe(false);
    }
    const settle = events.find((e) => e.type === 'ToolResult' && e.payload.backgroundSettle === true);
    expect((settle as Extract<EngineEvent, { type: 'ToolResult' }>).payload.aliasToolCallIds).toEqual(['call_1_1']);
    // 产出只作为一条通告送达：alias 不是第二份结果。
    expect(internalNotes(messages).filter((n) => n.includes('REAL MODULE OUTPUT'))).toHaveLength(1);
    // 同批同参的第二支必须真派、必须有结果——配对契约不能断。
    expect(transcriptIsPaired(messages)).toBe(true);
  }, 10_000);
});

describe('后台委派：终局闸（回合不能带着自己派出去的支收尾）', () => {
  it('模型在支在飞时给最终答复 → 先等收齐、送达，再重入 THINK 改写答复', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const { llm, seen } = scriptedLLM([
      [{ name: 'code_editor', args: { instructions: 'write module A' } }],
      'early draft answer',
      'final answer with results',
    ]);
    const ctx = baseCtx({
      llm,
      tools: delegationAdapter(port, 30),
      toolsDefs: [EDITOR_TOOL, READ_TOOL],
      detachedBranches: port,
    });

    const events = await collect(engine.run(
      { sessionId: 's-detach-gate', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));

    const completed = events.find((e) => e.type === 'Completed' && e.payload.isComplete);
    expect(completed).toBeDefined();
    const payload = (completed as Extract<EngineEvent, { type: 'Completed' }>).payload;
    // 收尾用的是收到真产出之后的那一版答复，不是草稿。
    expect(payload.finalOutput).toBe('final answer with results');
    expect(internalNotes(payload.messages ?? []).some((n) => n.includes('REAL MODULE OUTPUT'))).toBe(true);
    // 第三次 THINK 时结果已经在上下文里了（送达在重入之前）。
    const thirdRound = seen[2] ?? [];
    expect(thirdRound.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('REAL MODULE OUTPUT'))).toBe(true);
    expect(port.pendingCount()).toBe(0);
  }, 10_000);

  it('多支在飞：等全部结算后一次性送达，再收尾', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const { llm } = scriptedLLM([
      [
        { name: 'code_editor', args: { instructions: 'module A' } },
        { name: 'code_editor', args: { instructions: 'module B' } },
      ],
      'early draft',
      'final answer',
    ]);
    const ctx = baseCtx({
      llm,
      tools: delegationAdapter(port, 25),
      toolsDefs: [EDITOR_TOOL, READ_TOOL],
      detachedBranches: port,
    });

    await collect(engine.run(
      { sessionId: 's-detach-gate2', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));
    expect(port.pendingCount()).toBe(0);
    expect(port.takeSettled()).toHaveLength(0); // 都被取走了
  }, 10_000);
});

describe('后台委派：受理收执不参与去重', () => {
  it('同参重派真执行（不被去重吞成回放）', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    let executions = 0;
    const adapter = delegationAdapter(port, 15);
    const counting: ToolAdapter = {
      ...adapter,
      execute: async (tc) => {
        if (tc.function.name === 'code_editor') executions++;
        return adapter.execute(tc);
      },
    };
    const { llm } = scriptedLLM([
      [{ name: 'code_editor', args: { instructions: 'same brief' } }],
      [{ name: 'code_editor', args: { instructions: 'same brief' } }],
      'final answer',
    ]);
    const ctx = baseCtx({
      llm,
      tools: counting,
      toolsDefs: [EDITOR_TOOL, READ_TOOL],
      detachedBranches: port,
    });

    const events = await collect(engine.run(
      { sessionId: 's-detach-dedupe', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));

    expect(executions).toBe(2);
    // 第二轮不能被合成复用标记顶替。
    const synthetic = events.filter((e) => e.type === 'ToolResult' && e.payload.backgroundSettle !== true && (e.payload.result.result as { output?: string } | undefined)?.output?.includes('已经执行过'));
    expect(synthetic).toHaveLength(0);
  }, 10_000);
});

describe('后台委派：失败与用户中断的送达措辞', () => {
  it('失败的后台支：送达消息说清失败，并要求模型别装作跑完', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const adapter: ToolAdapter = {
      getTools: () => [EDITOR_TOOL],
      getMetadata: () => ({ isWrite: false }),
      execute: async (tc: ToolCall): Promise<ToolResult> => {
        port.add(tc.id);
        setTimeout(() => port.settle(tc.id, 'stream died', { success: false }), 20);
        return receipt(tc);
      },
    };
    const { llm } = scriptedLLM([
      [{ name: 'code_editor', args: { instructions: 'doomed' } }],
      'early draft',
      'final answer',
    ]);
    const ctx = baseCtx({ llm, tools: adapter, toolsDefs: [EDITOR_TOOL], detachedBranches: port });

    const events = await collect(engine.run(
      { sessionId: 's-detach-fail', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));
    const completed = events.find((e) => e.type === 'Completed' && e.payload.isComplete) as Extract<EngineEvent, { type: 'Completed' }>;
    const notes = internalNotes(completed.payload.messages ?? []);
    expect(notes.some((n) => n.includes('失败了') && n.includes('stream died') && n.includes('不要装作它跑完了'))).toBe(true);
  }, 10_000);
});

// 批次外的分支活动（2026-11-18 档二续）：委派 detach 后支活过整批，批级
// reader 在批结束就关了——detach 之前的引擎在这里会把活动静默丢掉，卡片在
// 整个窗口里只有一个转圈。
describe('后台委派：批次外的分支活动不再失明', () => {
  it('主线 THINK 期间到达的分支活动照样转发', async () => {
    const engine = new AgentLoopEngine();
    const port = new FakeBranches();
    const fanout = new EventFanout<SubagentActivityEvent>();
    let round = 0;
    const llm: LLMAdapter = {
      stream: async function* (): AsyncGenerator<LLMChunk, void, void> {
        round++;
        if (round === 1) {
          const tc: ToolCall = {
            id: 'call_1_0',
            index: 0,
            function: { name: 'code_editor', arguments: '{"instructions":"write A"}' },
          };
          yield { type: 'tool_call', index: 0, id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
          yield { type: 'done', content: '', toolCalls: [tc] };
          return;
        }
        if (round === 2) {
          // 批级 reader 已在第一批结束时关闭；这一条只在 THINK 期间被拾取。
          fanout.publish({ callId: 'call_1_0', agentName: 'code_editor', kind: 'tool', toolName: 'write_file' });
          yield { type: 'content', content: 'draft answer' };
          yield { type: 'done', content: 'draft answer', toolCalls: [] };
          return;
        }
        yield { type: 'content', content: 'final answer' };
        yield { type: 'done', content: 'final answer', toolCalls: [] };
      },
      complete: async () => ({ content: 'final answer', toolCalls: [] }),
    };
    const ctx = baseCtx({
      llm,
      tools: delegationAdapter(port, 50),
      toolsDefs: [EDITOR_TOOL, READ_TOOL],
      detachedBranches: port,
      subagentEvents: fanout,
    });

    const events = await collect(engine.run(
      { sessionId: 's-detach-think-activity', systemPrompt: 'X', userPrompt: 'Y', budget: BUDGET },
      ctx,
    ));

    const forwarded = events.filter((e) => e.type === 'SubagentActivity') as Array<Extract<EngineEvent, { type: 'SubagentActivity' }>>;
    expect(forwarded.map((e) => e.payload.callId)).toEqual(['call_1_0']);
    expect(forwarded[0].payload.toolName).toBe('write_file');
    // 转发发生在回合收尾之前（不是攒到 Completed 一起吐）。
    const activityAt = events.findIndex((e) => e.type === 'SubagentActivity');
    const completedAt = events.findIndex((e) => e.type === 'Completed');
    expect(activityAt).toBeGreaterThan(-1);
    expect(activityAt).toBeLessThan(completedAt);
  }, 10_000);
});
