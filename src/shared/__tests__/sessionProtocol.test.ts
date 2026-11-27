// src/shared/__tests__/sessionProtocol.test.ts
// P2-b 的契约锁：seq 缺口不猜、重放幂等、ops 边界、预览背压只留最后一帧。

import { describe, expect, test } from 'bun:test';
import {
  applyOps,
  applyProjectFrame,
  coalescePreview,
  resyncFrom,
  type PreviewFrame,
  type ProjectFrame,
} from '../sessionProtocol';
import type { Message } from '../types';

const message = (content: string): Message => ({ role: 'assistant', content });

describe('applyOps', () => {
  test('append / replace / truncate / reset 的基本语义', () => {
    const base = [message('a'), message('b')];
    expect(applyOps(base, [{ type: 'append', message: message('c') }]).map((m) => m.content))
      .toEqual(['a', 'b', 'c']);
    expect(applyOps(base, [{ type: 'replace', index: 1, message: message('B') }]).map((m) => m.content))
      .toEqual(['a', 'B']);
    expect(applyOps(base, [{ type: 'truncate', length: 1 }]).map((m) => m.content)).toEqual(['a']);
    expect(applyOps(base, [{ type: 'reset', messages: [message('z')] }]).map((m) => m.content)).toEqual(['z']);
  });

  test('越界 replace 与负 truncate 不炸、不越界', () => {
    const base = [message('a')];
    expect(applyOps(base, [{ type: 'replace', index: 9, message: message('x') }])).toEqual(base);
    expect(applyOps(base, [{ type: 'truncate', length: -1 }])).toEqual([]);
  });
});

describe('applyProjectFrame', () => {
  const frame = (seq: number, content: string): ProjectFrame => ({
    seq,
    kind: 'project',
    ops: [{ type: 'append', message: message(content) }],
  });

  test('连续帧推进水位并应用 ops', () => {
    const result = applyProjectFrame({ seq: 4, messages: [message('base')] }, frame(5, 'next'));
    expect(result.gap).toBe(false);
    expect(result.state.seq).toBe(5);
    expect(result.state.messages.map((m) => m.content)).toEqual(['base', 'next']);
  });

  test('seq ≤ 水位是重放：原样返回，ops 不重复应用（幂等）', () => {
    const state = { seq: 5, messages: [message('base'), message('next')] };
    const result = applyProjectFrame(state, frame(5, 'next'));
    expect(result.gap).toBe(false);
    expect(result.state).toBe(state);
    expect(result.state.messages).toHaveLength(2);
  });

  test('seq 缺口不应用，交给 resync', () => {
    const state = { seq: 4, messages: [message('base')] };
    const result = applyProjectFrame(state, frame(6, 'skipped'));
    expect(result.gap).toBe(true);
    expect(result.state).toBe(state);
    expect(resyncFrom(result.state)).toEqual({ kind: 'resync', fromSeq: 5 });
  });
});

describe('coalescePreview', () => {
  const preview = (seq: number, text: string): PreviewFrame => ({ seq, kind: 'preview', text });

  test('未超阈值时全部保留', () => {
    const queue = coalescePreview([], preview(1, 'a'), 1024);
    expect(queue).toHaveLength(1);
    expect(coalescePreview(queue, preview(2, 'b'), 1024)).toHaveLength(2);
  });

  test('超阈值只留最后一帧（中间帧可丢）', () => {
    const queue = [preview(1, 'x'.repeat(600)), preview(2, 'y'.repeat(600))];
    const next = preview(3, 'z'.repeat(600));
    const coalesced = coalescePreview(queue, next, 1024);
    expect(coalesced).toEqual([next]);
  });
});
