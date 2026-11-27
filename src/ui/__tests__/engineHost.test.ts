// src/ui/__tests__/engineHost.test.ts
// P2-a：MainThreadEngineHost 只做转发——同一个生成器对象、同一组参数、同一个
// ContextEngine。任何包装/缓存/参数重排都会破坏「零行为切换」，这里钉住。
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MainThreadEngineHost } from '../engineHost';
import type { CodingAgent } from '../../coding-agent/CodingAgent';
import type { ContextEngine } from '../../harness/ContextEngine';
import type { EngineEvent, Message, MessageImage, ToolCall, ToolResult } from '../../shared/types';

function fakeAgent() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const events = (async function* (): AsyncGenerator<EngineEvent, void, void> {})();
  const contextEngine = { compact: async () => ({}) } as unknown as ContextEngine;
  const subagentResult = { success: true } as unknown as ToolResult;
  const agent = {
    run: (...args: unknown[]) => {
      calls.push({ method: 'run', args });
      return events;
    },
    continueTurn: (...args: unknown[]) => {
      calls.push({ method: 'continueTurn', args });
      return events;
    },
    subagentOrchestrator: {
      execute: (toolCall: ToolCall, signal?: AbortSignal) => {
        calls.push({ method: 'execute', args: [toolCall, signal] });
        return Promise.resolve(subagentResult);
      },
    },
    getHarness: () => ({ getContextEngine: () => contextEngine }),
  };
  return { agent: agent as unknown as CodingAgent, calls, events, contextEngine, subagentResult };
}

describe('MainThreadEngineHost（P2-a 零行为委托）', () => {
  it('run 原样转发参数并返回同一个生成器', () => {
    const { agent, calls, events } = fakeAgent();
    const host = new MainThreadEngineHost(agent);
    const signal = new AbortController().signal;
    const hardStop = new AbortController().signal;
    const images: MessageImage[] = [{ dataUrl: 'data:image/png;base64,x', mimeType: 'image/png' }];
    expect(host.run('sys', 'user', signal, images, hardStop)).toBe(events);
    expect(calls).toEqual([{ method: 'run', args: ['sys', 'user', signal, images, hardStop] }]);
  });

  it('continueTurn 八个位置参数一个不改', () => {
    const { agent, calls, events } = fakeAgent();
    const host = new MainThreadEngineHost(agent);
    const messages: Message[] = [{ role: 'user', content: 'history' }];
    const signal = new AbortController().signal;
    const hardStop = new AbortController().signal;
    const llmOverride = { stream: async function* () {} } as never;
    expect(host.continueTurn('sys', messages, 'next', signal, [], hardStop, true, llmOverride)).toBe(events);
    expect(calls).toEqual([{
      method: 'continueTurn',
      args: ['sys', messages, 'next', signal, [], hardStop, true, llmOverride],
    }]);
  });

  it('executeSubagent 转发到编排器并返回同一个 promise', async () => {
    const { agent, calls, subagentResult } = fakeAgent();
    const host = new MainThreadEngineHost(agent);
    const toolCall: ToolCall = { id: 'c1', index: 0, function: { name: 'code_reviewer', arguments: '{}' } };
    const signal = new AbortController().signal;
    const pending = host.executeSubagent(toolCall, signal);
    await expect(pending).resolves.toBe(subagentResult);
    expect(calls).toEqual([{ method: 'execute', args: [toolCall, signal] }]);
  });

  it('getContextEngine 返回 Harness 的同一个实例', () => {
    const { agent, contextEngine } = fakeAgent();
    const host = new MainThreadEngineHost(agent);
    expect(host.getContextEngine()).toBe(contextEngine);
  });

  it('接线锁：chat.ts 的驱动面只走 engineHost，工具/审批仍直连 codingAgent', () => {
    const source = readFileSync('src/ui/chat.ts', 'utf-8');
    expect(source).not.toMatch(/codingAgent\.(?:continueTurn|run\(|getHarness\(|subagentOrchestrator\.execute)/);
    const driveCalls = source.match(/engineHost\.(?:continueTurn|run\(|getContextEngine|executeSubagent)/g) ?? [];
    expect(driveCalls).toHaveLength(6);
    // 工具注册与交付核验不搬：它们今天就在主线程。
    expect(source).toContain('codingAgent.toolRegistry.register(');
    expect(source).toContain('runDeliveryVerification(codingAgent.toolRegistry');
  });
});
