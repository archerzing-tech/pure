// src/harness/__tests__/HarnessDetachedResume.test.ts
// 恢复会话的接线（2026-11-18 档二续）：转录里挂着 deferred 收执时，模型必须
// 在续轮第一次 THINK 前就看到「那些支随上个进程没了」——沉默的收执会让模型
// 把没回来的活当成已完成或还在跑。

import { describe, it, expect } from 'bun:test';
import { Harness } from '../Harness';
import { DETACHED_RESUME_TAG } from '../../shared/detachedResume';
import type { BudgetConfig, EngineEvent, LLMAdapter, LLMChunk, Message } from '../../shared/types';

const BUDGET: BudgetConfig = {
  maxTurns: 10,
  maxTotalTokens: 100_000,
  maxExecutionTime: 120_000,
  warningThreshold: 0.8,
  graceTurns: 2,
};

function recordingLLM(text: string): { llm: LLMAdapter; received: Message[][] } {
  const received: Message[][] = [];
  const llm: LLMAdapter = {
    stream: async function* (messages: Message[]): AsyncGenerator<LLMChunk, void, void> {
      received.push(messages.map((m) => ({ ...m })));
      yield { type: 'content', content: text };
      yield { type: 'done', content: text, toolCalls: [] };
    },
    complete: async () => ({ content: text, toolCalls: [] }),
  };
  return { llm, received };
}

async function collect(stream: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const receipt = (toolCallId: string): Message => ({
  role: 'tool',
  content: '已受理，后台运行中（call_id=' + toolCallId + '）',
  toolCallId,
  toolName: 'code_editor',
  deferred: true,
});

const assistantCall = (toolCallId: string): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: toolCallId, index: 0, function: { name: 'code_editor', arguments: '{"task":"写 a.ts"}' } }],
});

describe('后台委派崩溃恢复通告（续轮接线）', () => {
  it('模型在恢复后的第一轮就看到丢失通告，而不是一张沉默的收执', async () => {
    const { llm, received } = recordingLLM('接着做');
    const harness = new Harness({ sessionId: 'sess-detached-resume', llm, toolsDefs: [], budget: BUDGET });
    const history: Message[] = [
      { role: 'user', content: '照着 brief 写两个模块' },
      assistantCall('call_live'),
      receipt('call_live'),
    ];

    await collect(harness.continueTurn('SYS', history, '继续'));

    const firstTurn = received[0];
    const receiptAt = firstTurn.find((m) => m.role === 'tool' && m.toolCallId === 'call_live');
    expect(receiptAt).toBeDefined();
    expect(receiptAt!.content.startsWith(DETACHED_RESUME_TAG)).toBe(true);
    expect(receiptAt!.content).toContain('call_id=call_live');
    expect(receiptAt!.deferred).toBe(false);
    // 配对契约不变：还是同一条 tool 消息，位置就在它的 assistant 调用之后；
    // 新请求仍是最后一条（装配器会给它加 adaptive_context 前缀，不作逐字断言）。
    expect(firstTurn.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(firstTurn[firstTurn.length - 1].content.endsWith('继续')).toBe(true);
  });

  it('没有未结算收执时不多说一句（普通续轮不动历史）', async () => {
    const { llm, received } = recordingLLM('好的');
    const harness = new Harness({ sessionId: 'sess-detached-clean', llm, toolsDefs: [], budget: BUDGET });
    const history: Message[] = [
      { role: 'user', content: '普通回合' },
      { role: 'assistant', content: '做完了' },
    ];

    await collect(harness.continueTurn('SYS', history, '再改一处'));

    expect(received[0].some((m) => m.content.startsWith(DETACHED_RESUME_TAG))).toBe(false);
    // 历史一条不多：不改写、不插通告。
    expect(received[0].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(received[0][1].content).toBe('普通回合');
    expect(received[0][2].content).toBe('做完了');
    expect(received[0][3].content.endsWith('再改一处')).toBe(true);
  });
});
