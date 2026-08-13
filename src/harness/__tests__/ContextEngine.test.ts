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

  it('keeps a contiguous recent suffix after a hard budget boundary', async () => {
    const engine = new ContextEngine({ maxMessages: 2 });
    const result = await engine.compact(makeMsgs(5));

    expect(result.messages.map(message => message.content)).toEqual(['msg 3', 'msg 4']);
  });

  // ═══ LLM summary fallback (G-3 fix) ═══

  it('summarizes evicted messages when llm is provided and threshold is exceeded', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => ({ content: 'KEY DECISIONS: used TypeScript, refactored core loop' }),
    };
    const engine = new ContextEngine({ maxMessages: 3, summaryThreshold: 5, llm });
    const msgs = makeMsgs(12); // evicts 9 → > 5
    const result = await engine.trim(msgs);

    const summary = result.find(m => m.content.startsWith('Earlier conversation summary:'));
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ role: 'system' });
    expect(summary!.content).toContain('KEY DECISIONS: used TypeScript');
    // Summary is inserted before the kept recent window
    expect(result[result.length - 1].content).toBe('msg 11');
  });

  it('skips summarization when evicted count is under threshold', async () => {
    let called = false;
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => { called = true; return { content: 'summary' }; },
    };
    const engine = new ContextEngine({ maxMessages: 8, summaryThreshold: 10, llm });
    const msgs = makeMsgs(12); // evicts 4 → ≤ 10
    const result = await engine.trim(msgs);

    expect(called).toBe(false);
    expect(result.some(m => m.content.startsWith('Earlier conversation summary:'))).toBe(false);
  });

  it('falls back to plain trim when the summary LLM call fails', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => { throw new Error('llm down'); },
    };
    const engine = new ContextEngine({ maxMessages: 3, summaryThreshold: 5, llm });
    const msgs = makeMsgs(12);
    const result = await engine.trim(msgs);

    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.some(m => m.content.startsWith('Earlier conversation summary:'))).toBe(false);
  });

  it('returns structured metadata for explicit compaction without mutating input', async () => {
    const engine = new ContextEngine({ maxMessages: 2 });
    const msgs = makeMsgs(5);
    const result = await engine.compact(msgs, { force: true });

    expect(result.compacted).toBe(true);
    expect(result.evictedMessages).toBe(3);
    expect(result.summarized).toBe(false);
    expect(result.messages.map(message => message.content)).toEqual(['msg 3', 'msg 4']);
    expect(msgs).toHaveLength(5);
  });

  it('reports when older messages were trimmed without a summarizer', async () => {
    const engine = new ContextEngine({ maxMessages: 1, summaryThreshold: 1 });
    const result = await engine.compact(makeMsgs(4));

    expect(result.summaryUnavailable).toBe(true);
    expect(result.summarized).toBe(false);
  });

  it('does not retain an orphan tool result or an incomplete tool pair', async () => {
    const engine = new ContextEngine({ maxMessages: 10 });
    const msgs: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'missing', index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'orphan', toolCallId: 'orphan', toolName: 'read_file' },
      { role: 'user', content: 'latest' },
    ];

    const result = await engine.compact(msgs);

    expect(result.messages.map(message => message.content)).toEqual(['old', 'latest']);
    expect(result.evictedMessages).toBe(2);
  });

  it('keeps a newest atomic pair intact even when it exceeds the message window', async () => {
    const engine = new ContextEngine({ maxMessages: 1 });
    const pair: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'result', toolCallId: 'call_1', toolName: 'read_file' },
    ];

    const result = await engine.compact(pair);

    expect(result.messages).toEqual(pair);
    expect(result.messages).toHaveLength(2);
    expect(result.compacted).toBe(true);
  });

  it('keeps all tool results for an assistant with parallel tool calls', async () => {
    const engine = new ContextEngine({ maxMessages: 4 });
    const msgs: Message[] = [
      { role: 'user', content: 'inspect both files' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_a', index: 0, function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'call_b', index: 1, function: { name: 'read_file', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', content: 'a', toolCallId: 'call_a', toolName: 'read_file' },
      { role: 'tool', content: 'b', toolCallId: 'call_b', toolName: 'read_file' },
      { role: 'user', content: 'summarize' },
    ];

    const result = await engine.compact(msgs);

    expect(result.messages.some(message => message.toolCallId === 'call_a')).toBe(true);
    expect(result.messages.some(message => message.toolCallId === 'call_b')).toBe(true);
    expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  });

  it('counts tool schemas outside messages toward the token budget', async () => {
    const engine = new ContextEngine({
      maxMessages: 10,
      maxTokens: 100,
      tools: [{
        name: 'large_tool',
        description: 'tool',
        input_schema: { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(800) } } },
      }],
    });
    const result = await engine.compact([{ role: 'user', content: 'latest' }]);

    expect(result.estimatedTokens).toBeGreaterThan(100);
    expect(result.overBudget).toBe(true);
  });

  it('keeps the newest message when the token budget is smaller than its content', async () => {
    const engine = new ContextEngine({ maxMessages: 10, maxTokens: 1 });
    const msgs = makeMsgs(2);

    const result = await engine.compact(msgs);

    expect(result.messages.at(-1)?.content).toBe('msg 1');
    expect(result.messages).toHaveLength(1);
    expect(result.estimatedTokens).toBeGreaterThan(1);
    expect(result.overBudget).toBe(true);
    expect(result.oversizedNewestGroup).toBe(true);
  });

  it('distinguishes an over-budget system baseline from an oversized newest message', async () => {
    const engine = new ContextEngine({ maxMessages: 10, maxTokens: 2 });
    const result = await engine.compact([
      { role: 'system', content: 'a system prompt that already exceeds the budget' },
      { role: 'user', content: 'latest' },
    ]);

    expect(result.overBudget).toBe(true);
    expect(result.oversizedNewestGroup).toBe(false);
    expect(result.messages[0]?.role).toBe('system');
  });
});
