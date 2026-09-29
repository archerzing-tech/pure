// src/evolution/__tests__/sleepTimeHosts.test.ts
// P0-1 Phase 4 — 宿主共用的纯函数单测（GUI 定时器与 CLI 宿主都只做 IO 装配，
// 决策逻辑全部下沉在纯核：延迟策略、会话快照映射、游标形状闸）。

import { describe, expect, test } from 'bun:test';
import {
  computeIdleCycleDelayMs,
  sanitizeCursor,
  sessionTurnFromMessages,
} from '../sleepTimeOrchestrator';
import type { Message } from '../../shared/types';

const POLL = 10 * 60 * 1000;
const GAP = 30 * 60 * 1000;

describe('computeIdleCycleDelayMs', () => {
  test('从没跑过 → 等一个完整轮询窗（启动不抢跑）', () => {
    expect(computeIdleCycleDelayMs(undefined, 1_000_000, POLL, GAP)).toBe(POLL);
  });

  test('刚跑过 → 间隔到期还剩多久', () => {
    const now = 1_000_000;
    const lastCycleAt = now - 5 * 60 * 1000; // 5 分钟前跑过
    expect(computeIdleCycleDelayMs(lastCycleAt, now, POLL, GAP)).toBe(GAP - 5 * 60 * 1000);
  });

  test('间隔早已过期 → 0（立即补跑，绝不取负）', () => {
    const now = 1_000_000;
    const lastCycleAt = now - GAP - 1;
    expect(computeIdleCycleDelayMs(lastCycleAt, now, POLL, GAP)).toBe(0);
  });
});

describe('sessionTurnFromMessages', () => {
  test('最后一条真实 user 消息 + 其后最后一条 assistant 消息', () => {
    const messages: Message[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', index: 0, function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      { role: 'assistant', content: 'fixed, tests pass' },
    ];
    const turn = sessionTurnFromMessages(messages);
    expect(turn?.userPrompt).toBe('fix the bug');
    expect(turn?.finalOutput).toBe('fixed, tests pass');
    expect(turn?.messages).toBe(messages);
  });

  test('internal 恢复指令不算真实用户请求', () => {
    const messages: Message[] = [
      { role: 'user', content: 'real request' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'retry after cancel', internal: true },
    ];
    const turn = sessionTurnFromMessages(messages);
    expect(turn?.userPrompt).toBe('real request');
  });

  test('没有真实 user 消息 → undefined（宿主跳过反思段）', () => {
    expect(sessionTurnFromMessages([])).toBeUndefined();
    expect(sessionTurnFromMessages([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '   ', internal: true },
    ])).toBeUndefined();
  });

  test('user 之后没有 assistant 文本 → 只有 userPrompt', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello?' },
      { role: 'tool', toolCallId: 'x', content: 'orphan tool result' },
    ];
    const turn = sessionTurnFromMessages(messages);
    expect(turn?.userPrompt).toBe('hello?');
    expect(turn?.finalOutput).toBeUndefined();
  });
});

describe('sanitizeCursor', () => {
  test('垃圾输入 / null → 全默认游标（不抛）', () => {
    for (const garbage of [null, undefined, 'json', 42, {}, { lastProcessedAt: 'x' }]) {
      const cursor = sanitizeCursor(garbage);
      expect(cursor.lastProcessedAt).toBe(0);
      expect(cursor.processedSessionIds).toEqual([]);
      expect(cursor.overlayLedger).toEqual({});
    }
  });

  test('合法字段原样保留，坏条目逐个剔除', () => {
    const cursor = sanitizeCursor({
      lastProcessedAt: 1234,
      processedSessionIds: ['a', 7, null, 'b'],
      overlayLedger: {
        'overlay:code_reviewer': { deniedAt: 99, attempts: 2 },
        'overlay:bad': { deniedAt: 'nope', attempts: 1 },
        'overlay:worse': { attempts: 3 },
        'overlay:null': null,
      },
    });
    expect(cursor.lastProcessedAt).toBe(1234);
    expect(cursor.processedSessionIds).toEqual(['a', 'b']);
    expect(cursor.overlayLedger).toEqual({
      'overlay:code_reviewer': { deniedAt: 99, attempts: 2 },
    });
  });
});
