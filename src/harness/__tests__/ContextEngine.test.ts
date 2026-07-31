// src/harness/__tests__/ContextEngine.test.ts

import { describe, it, expect } from 'bun:test';
import { ContextEngine } from '../ContextEngine';
import type { Message } from '../../shared/types';

function makeMsgs(count: number, prefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `${prefix} ${i}`,
  }));
}

describe('ContextEngine', () => {
  it('passes through when under maxMessages', async () => {
    const engine = new ContextEngine({ maxMessages: 50 });
    const msgs = makeMsgs(20);
    const result = await engine.trim(msgs);
    expect(result).toHaveLength(20);
  });

  it('trims to maxMessages', async () => {
    const engine = new ContextEngine({ maxMessages: 5 });
    const msgs = makeMsgs(20);
    const result = await engine.trim(msgs);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('keeps system messages', async () => {
    const engine = new ContextEngine({ maxMessages: 3 });
    const msgs: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...makeMsgs(10),
    ];
    const result = await engine.trim(msgs);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('system prompt');
  });

  it('preserves tool_call atomic pairs', async () => {
    const engine = new ContextEngine({ maxMessages: 3 });
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read file' },
      { role: 'assistant', content: 'ok', toolCalls: [{ id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'file content here', toolCallId: 'call_1', toolName: 'read_file' },
      { role: 'user', content: 'extra question' },
    ];

    const result = await engine.trim(msgs);

    // Should have system + the assistant/tool pair + (possibly) the extra question
    const hasAssistant = result.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'call_1'));
    const hasTool = result.some(m => m.role === 'tool' && m.toolCallId === 'call_1');
    expect(hasAssistant).toBe(true);
    expect(hasTool).toBe(true);
  });

  it('does not pull back assistant if tool result is evicted too', async () => {
    const engine = new ContextEngine({ maxMessages: 1 });
    const msgs: Message[] = [
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old', toolCalls: [{ id: 'call_evicted', index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'old result', toolCallId: 'call_evicted', toolName: 'read_file' },
      { role: 'user', content: 'new question' },
    ];

    const result = await engine.trim(msgs);

    // Only the last 1 non-system message is kept: 'new question'
    // The tool result AND assistant are both evicted → no pullback
    const hasOld = result.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'call_evicted'));
    expect(hasOld).toBe(false);
  });

  it('handles empty messages', async () => {
    const engine = new ContextEngine({ maxMessages: 10 });
    const result = await engine.trim([]);
    expect(result).toHaveLength(0);
  });

  it('keeps recent messages at tail', async () => {
    const engine = new ContextEngine({ maxMessages: 3 });
    const msgs = makeMsgs(20, 'msg');
    const result = await engine.trim(msgs);

    // Last 3 messages should be msg 17, 18, 19
    expect(result[result.length - 1].content).toBe('msg 19');
    expect(result[result.length - 2].content).toBe('msg 18');
  });
});
