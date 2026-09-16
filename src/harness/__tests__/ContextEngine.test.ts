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

/** An atomic assistant+tool pair (one group in the compactor). */
function pair(id: string, content = `${id} result`): Message[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, index: 0, function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content, toolCallId: id, toolName: 'read_file' },
  ];
}

describe('ContextEngine', () => {
  it('passes through when under maxMessages', async () => {
    const engine = new ContextEngine({ maxMessages: 50 });
    const msgs = makeMsgs(20);
    const result = await engine.trim(msgs);
    expect(result).toHaveLength(20);
  });

  it('trims assistant/tool chatter to maxMessages while pinning user messages', async () => {
    const engine = new ContextEngine({ maxMessages: 5 });
    const msgs: Message[] = [
      { role: 'user', content: 'first ask' },
      ...pair('a'), ...pair('b'), ...pair('c'), ...pair('d'), // 8 chatter messages
      { role: 'user', content: 'follow-up ask' },
    ];
    const result = await engine.trim(msgs);
    expect(result.filter(m => m.role === 'user').map(m => m.content)).toEqual(['first ask', 'follow-up ask']);
    // The 5-message window bounds only the non-pinned chatter.
    expect(result.length).toBeLessThanOrEqual(2 + 5);
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

  it('does not pull back an older assistant pair once it is evicted', async () => {
    const engine = new ContextEngine({ maxMessages: 2 });
    const msgs: Message[] = [...pair('call_evicted', 'old result'), ...pair('call_kept', 'new result')];

    const result = await engine.trim(msgs);

    // Only the newest pair fits the 2-message window; the older pair is
    // evicted whole — assistant and tool result go together, no pullback.
    const hasOld = result.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'call_evicted'));
    expect(hasOld).toBe(false);
    expect(result.some(m => m.toolCallId === 'call_kept')).toBe(true);
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

  it('keeps a contiguous recent suffix of work after a hard budget boundary', async () => {
    const engine = new ContextEngine({ maxMessages: 2 });
    const result = await engine.compact([
      { role: 'user', content: 'ask' },
      ...pair('p1'), ...pair('p2'), ...pair('p3'),
    ]);

    // The 2-message window keeps the newest pair whole; older work is evicted
    // from the top. The pinned user ask rides along outside the window.
    expect(result.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(result.messages.at(-1)?.content).toBe('p3 result');
    expect(result.messages.some(m => m.role === 'user' && m.content === 'ask')).toBe(true);
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
    const msgs: Message[] = [...pair('p1'), ...pair('p2'), ...pair('p3'), ...pair('p4')]; // evicts 6 → > 5
    const result = await engine.trim(msgs);

    const summary = result.find(m => m.content.startsWith('Earlier conversation summary:'));
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ role: 'system' });
    expect(summary!.content).toContain('KEY DECISIONS: used TypeScript');
    // Summary is inserted before the kept recent window
    expect(result.at(-1)?.content).toBe('p4 result');
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
    const msgs: Message[] = [...pair('p1'), ...pair('p2'), ...pair('p3'), ...pair('p4'), ...pair('p5')]; // evicts 2 → ≤ 10
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
    const msgs: Message[] = [...pair('p1'), ...pair('p2'), ...pair('p3'), ...pair('p4')];
    const result = await engine.trim(msgs);

    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.some(m => m.content.startsWith('Earlier conversation summary:'))).toBe(false);
  });

  it('returns structured metadata for explicit compaction without mutating input', async () => {
    const engine = new ContextEngine({ maxMessages: 2 });
    const msgs: Message[] = [{ role: 'user', content: 'ask' }, ...pair('p1'), ...pair('p2')];
    const result = await engine.compact(msgs, { force: true });

    expect(result.compacted).toBe(true);
    expect(result.evictedMessages).toBe(2);
    expect(result.summarized).toBe(false);
    expect(result.messages.map(message => message.content)).toEqual(['ask', '', 'p2 result']);
    expect(msgs).toHaveLength(5);
  });

  it('reports when older messages were trimmed without a summarizer', async () => {
    const engine = new ContextEngine({ maxMessages: 1, summaryThreshold: 1 });
    const result = await engine.compact([...pair('p1'), ...pair('p2')]);

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

  // ═══ Regression: the follow-up turn must still see the attachment path ═══
  // Windows report: upload a doc → build a PPT (one long turn, > 20 model
  // messages) → "基于 pptx skill 再做一遍" → the agent's read_file failed with
  // a truncated path ("文件路径被截断了") and it searched the workspace in
  // vain. Cause: background compaction evicted the turn-1 user message — the
  // only place the attachment's absolute path lived — and the ≤40-message
  // eviction got NO summary at all, so the redo turn reconstructed the path
  // from memory.

  it('keeps the attachment-path user message when a PPT-length turn overflows the window', async () => {
    const engine = new ContextEngine({ maxMessages: 20 });
    const attachmentAsk: Message = {
      role: 'user',
      content: [
        '<task_context>',
        'x'.repeat(600),
        '</task_context>',
        '',
        '帮我把这个文档做成一个PPT',
        '',
        '[粘贴文件: 产品需求说明.md (1.0 KB)]',
        'C:\\Users\\win\\.pure\\workspace\\336639393532343935323931355f33\\产品需求说明.md',
        '请先用 read_file 按原样读取上面的绝对路径（这是应用保存的附件文件，路径可直接使用）。',
      ].join('\n'),
    },
    chatter: Message[] = [];
    for (let i = 0; i < 13; i++) chatter.push(...pair(`call_${i}`, `chunk ${i}`));
    const result = await engine.compact([attachmentAsk, ...chatter, { role: 'user', content: '基于 pptx 这个 skill 再做一版本' }]);

    const flattened = result.messages.map(m => m.content).join('\n');
    expect(flattened).toContain('[粘贴文件: 产品需求说明.md (1.0 KB)]');
    expect(flattened).toContain('C:\\Users\\win\\.pure\\workspace\\336639393532343935323931355f33\\产品需求说明.md');
  });

  it('summarizer excerpt strips task_context and reaches the attachment path tail', async () => {
    let seenPrompt = '';
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async (messages: { content: string }[]) => {
        seenPrompt = messages[0].content;
        return { content: 'summary' };
      },
    };
    // Token pressure (80) forces the pinned attachment message into `evicted`;
    // with an LLM present the summarizer must still see the path that sits
    // AFTER the 600-char <task_context> wrapper.
    const engine = new ContextEngine({ maxMessages: 4, maxTokens: 80, summaryThreshold: 0, llm });
    const attachmentAsk: Message = {
      role: 'user',
      content: [
        '<task_context>',
        'x'.repeat(600),
        '</task_context>',
        '',
        '帮我把这个文档做成一个PPT',
        '',
        '[粘贴文件: 产品需求说明.md (1.0 KB)]',
        'C:\\Users\\win\\.pure\\workspace\\336639393532343935323931355f33\\产品需求说明.md',
        '请先用 read_file 按原样读取上面的绝对路径。',
      ].join('\n'),
    };
    const chatter: Message[] = [];
    for (let i = 0; i < 4; i++) chatter.push(...pair(`call_${i}`, `chunk ${i}`));
    await engine.compact([attachmentAsk, ...chatter]);

    expect(seenPrompt).toContain('user:');
    expect(seenPrompt).not.toContain('xxxxx'); // task_context boilerplate stays out of the excerpt
    expect(seenPrompt).toContain('[粘贴文件: 产品需求说明.md (1.0 KB)]');
    expect(seenPrompt).toContain('C:\\Users\\win\\.pure\\workspace\\336639393532343935323931355f33\\产品需求说明.md');
  });
});
