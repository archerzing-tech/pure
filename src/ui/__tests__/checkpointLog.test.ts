// src/ui/__tests__/checkpointLog.test.ts
// P1-b 的边界锁：索引连续、长文本/工具参数有界、图片有 path 时不带 base64。

import { describe, expect, test } from 'bun:test';
import { buildTranscriptDelta } from '../checkpointLog';
import type { Message, MessageImage } from '../../shared/types';

function message(overrides: Partial<Message> = {}): Message {
  return { role: 'assistant', content: 'ok', ...overrides };
}

describe('buildTranscriptDelta', () => {
  test('modelMessageIndex 从游标连续递增', () => {
    const drafts = buildTranscriptDelta(
      [message({ content: 'a' }), message({ content: 'b' })],
      7,
    );
    expect(drafts.map((draft) => draft.modelMessageIndex)).toEqual([7, 8]);
    expect(drafts[1].message.content).toBe('b');
  });

  test('超长助手文本被截断并留下标记', () => {
    const [draft] = buildTranscriptDelta([message({ content: 'x'.repeat(40_000) })], 0);
    expect(draft.message.content?.length).toBeLessThan(32_100);
    expect(draft.message.content).toContain('checkpoint truncated');
  });

  test('工具参数超长同样截断', () => {
    const [draft] = buildTranscriptDelta([
      message({
        toolCalls: [{
          id: 'call-1',
          index: 0,
          function: { name: 'write_file', arguments: 'y'.repeat(40_000) },
        }],
      }),
    ], 0);
    expect(draft.message.toolCalls?.[0].function.arguments).toContain('[truncated]');
    expect(draft.message.toolCalls?.[0].function.arguments.length).toBeLessThan(32_100);
  });

  test('图片有 path 时不重复携带 dataUrl', () => {
    const image: MessageImage = { path: '/tmp/a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
    const [draft] = buildTranscriptDelta([message({ images: [image] })], 0);
    expect(draft.message.images?.[0].path).toBe('/tmp/a.png');
    expect(draft.message.images?.[0].dataUrl).toBe('');
  });

  test('无 path 的超大内联图被丢弃，小图保留', () => {
    const big: MessageImage = { mimeType: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(9_000)}` };
    const small: MessageImage = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
    const [draft] = buildTranscriptDelta([message({ images: [big, small] })], 0);
    expect(draft.message.images?.[0].dataUrl).toBe('');
    expect(draft.message.images?.[1].dataUrl).toBe('data:image/png;base64,AAAA');
  });
});
