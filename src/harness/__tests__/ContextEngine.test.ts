// src/harness/__tests__/ContextEngine.test.ts

import { describe, it, expect } from 'bun:test';
import { ContextEngine, collectModifiedFilePaths } from '../ContextEngine';
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

  // ═══ 8.1 — token budget primary ═══
  // When a token budget is configured (production always resolves one), the
  // message-count window no longer truncates: short turns are kept as long
  // as the provider window fits them. The count window governs only the
  // no-token-budget fallback path.

  it('keeps short turns far past the count window when the token budget allows', async () => {
    const engine = new ContextEngine({ maxMessages: 2, maxTokens: 10_000 });
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) msgs.push(...pair(`p${i}`)); // 60 messages >> 2

    const result = await engine.compact(msgs);

    expect(result.messages).toHaveLength(60);
    expect(result.compacted).toBe(false);
    expect(result.evictedMessages).toBe(0);
    expect(result.overBudget).toBe(false);
  });

  it('still evicts by size when the token budget is the small bound', async () => {
    // maxMessages would keep everything here; tokens refuse. The weighting
    // must evict the oldest pairs, newest intact — the inverse of the count
    // fallback above.
    const engine = new ContextEngine({ maxMessages: 1000, maxTokens: 220 });
    const bigPair = (id: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id, index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'x'.repeat(400), toolCallId: id, toolName: 'read_file' }, // ~100 tokens
    ];
    const msgs: Message[] = [
      ...bigPair('p0'), ...bigPair('p1'), ...bigPair('p2'), ...bigPair('p3'), ...bigPair('p4'),
    ];

    const result = await engine.compact(msgs);

    expect(result.evictedMessages).toBeGreaterThanOrEqual(2);
    expect(result.messages.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'p0'))).toBe(false);
    expect(result.messages.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'p4'))).toBe(true);
    expect(result.messages.at(-1)?.content).toBe('x'.repeat(400));
  });

  it('prices assistant tool-call arguments into the window (wire payload, not just content)', async () => {
    // The exact 400-wedge shape from the field: write_file carries a whole
    // file in its arguments. Content-only estimating saw ~zero tokens here,
    // "compacted" to a window that still overflowed, and every subsequent
    // turn 400'd (context length) — the session wedged even on fresh input.
    const heavyPair = (id: string): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id, index: 0, function: { name: 'write_file', arguments: JSON.stringify({ path: `/tmp/${id}.html`, content: 'x'.repeat(600) }) } }] },
      { role: 'tool', content: 'ok', toolCallId: id, toolName: 'write_file' },
    ];
    const engine = new ContextEngine({ maxMessages: 1000, maxTokens: 500 });
    const msgs: Message[] = [...heavyPair('a0'), ...heavyPair('a1'), ...heavyPair('a2')];

    const result = await engine.compact(msgs);

    // ~207 est. tokens per pair (args are dense JSON, padded 4/3): a 500-token
    // window keeps only the newest two — the oldest pair must go, pairs intact.
    expect(result.compacted).toBe(true);
    expect(result.messages.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'a0'))).toBe(false);
    expect(result.messages.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === 'a2'))).toBe(true);
    expect(result.messages.some(m => m.role === 'tool' && m.toolCallId === 'a2')).toBe(true);
  });

  // ═══ LLM summary fallback (G-3 fix) ═══

  it('summarizes evicted messages when llm is provided', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => ({ content: 'KEY DECISIONS: used TypeScript, refactored core loop' }),
    };
    const engine = new ContextEngine({ maxMessages: 3, llm });
    const msgs: Message[] = [...pair('p1'), ...pair('p2'), ...pair('p3'), ...pair('p4')];
    const result = await engine.trim(msgs);

    const summary = result.find(m => m.content.startsWith('Earlier conversation summary:'));
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ role: 'system' });
    expect(summary!.content).toContain('KEY DECISIONS: used TypeScript');
    // Summary is inserted before the kept recent window
    expect(result.at(-1)?.content).toBe('p4 result');
  });

  // 9.1 — the old gate ("only past 40 evicted messages") let a token-driven
  // overflow of a handful of messages drop content with NO summary at all.
  // That is exactly how an attachment path disappeared between turns. Every
  // eviction of real conversation is now summarized.
  it('summarizes a small eviction instead of silently dropping it', async () => {
    let calls = 0;
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => { calls++; return { content: 'summary of the evicted pair' }; },
    };
    const engine = new ContextEngine({ maxMessages: 8, llm });
    const msgs: Message[] = [...pair('p1'), ...pair('p2'), ...pair('p3'), ...pair('p4'), ...pair('p5')]; // 10 > 8: evicts one pair
    const result = await engine.compact(msgs);

    expect(calls).toBe(1);
    expect(result.evictedMessages).toBe(2);
    expect(result.summarized).toBe(true);
    expect(result.summaryUnavailable).toBe(false);
    expect(result.messages.some(m => m.content.startsWith('Earlier conversation summary:'))).toBe(true);
  });

  it('falls back to plain trim when the summary LLM call fails', async () => {
    const llm = {
      stream: async function* () {
        yield { type: 'done' as const, content: '', toolCalls: [] };
      },
      complete: async () => { throw new Error('llm down'); },
    };
    const engine = new ContextEngine({ maxMessages: 3, llm });
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
    const engine = new ContextEngine({ maxMessages: 1 });
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
    const engine = new ContextEngine({ maxMessages: 4, maxTokens: 80, llm });
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

  // ═══ 9.1 L1 — tool-result microcompaction ═══
  // Old tool RESULTS are the bulk of a long agent session's window. Clearing
  // them costs no LLM call and keeps the conversational skeleton (who asked
  // what, what was decided) that whole-group eviction would delete. It runs
  // BEFORE eviction, so it is the first thing that gives.

  /** An assistant+tool pair whose tool result is `chars` characters of 'x'. */
  const bigPair = (id: string, chars = 4000): Message[] => [
    { role: 'assistant', content: '', toolCalls: [{ id, index: 0, function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: 'x'.repeat(chars), toolCallId: id, toolName: 'read_file' },
  ];

  it('clears old large tool results instead of evicting their messages', async () => {
    // ~1006 est. tokens per pair, ~3018 total, against a 1200-token budget.
    // Eviction alone would drop the oldest pairs whole; clearing just the two
    // old RESULTS brings the window to ~1068 and every message survives.
    const engine = new ContextEngine({ maxMessages: 1000, maxTokens: 1200, microcompaction: { keepRecent: 1 } });
    const msgs: Message[] = [...bigPair('a'), ...bigPair('b'), ...bigPair('c')];

    const result = await engine.compact(msgs);

    expect(result.microcompactedToolResults).toBe(2);
    expect(result.reclaimedTokens).toBeGreaterThan(1000);
    expect(result.evictedMessages).toBe(0);
    expect(result.messages).toHaveLength(6);
    expect(result.compacted).toBe(true);
    // The newest result stays verbatim — the model is usually still working
    // from it — and a cleared one keeps its identity so the wire stays valid.
    expect(result.messages.at(-1)?.content).toBe('x'.repeat(4000));
    const cleared = result.messages.find(m => m.role === 'tool' && m.content.startsWith('[old read_file result cleared'));
    expect(cleared).toMatchObject({ toolName: 'read_file', toolCallId: 'a' });
    // Input untouched.
    expect(msgs[1].content).toBe('x'.repeat(4000));
  });

  it('leaves tool results alone while the window fits', async () => {
    const engine = new ContextEngine({ maxMessages: 100, maxTokens: 100_000, microcompaction: { keepRecent: 1 } });
    const result = await engine.compact([...bigPair('a'), ...bigPair('b')]);

    expect(result.microcompactedToolResults).toBe(0);
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.messages.at(-1)?.content).toBe('x'.repeat(4000));
  });

  it('ignores small tool results: the placeholder would cost as much as it saves', async () => {
    const engine = new ContextEngine({ maxMessages: 1000, maxTokens: 100, microcompaction: { keepRecent: 0, minChars: 1000 } });
    const msgs: Message[] = [...bigPair('a', 20), ...bigPair('b', 20), ...bigPair('c', 20)];

    const result = await engine.compact(msgs);

    expect(result.microcompactedToolResults).toBe(0);
  });

  it('aggressive compaction clears recent results too and lands below the configured budget', async () => {
    const engine = new ContextEngine({ maxMessages: 1000, maxTokens: 2000 });
    const msgs: Message[] = [...bigPair('a'), ...bigPair('b'), ...bigPair('c')];

    const result = await engine.compact(msgs, { force: true, aggressive: true });

    expect(result.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.overBudget).toBe(false);
  });

  // ═══ 9.1 L3 — post-compaction rehydration ═══

  it('collects modified file paths newest-first without duplicates', () => {
    const call = (name: string, path: string, id: string): Message => ({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, index: 0, function: { name, arguments: JSON.stringify({ path }) } }],
    });
    const paths = collectModifiedFilePaths([
      call('write_file', 'a.ts', '1'),
      call('read_file', 'ignored.ts', '2'),
      call('edit_file', 'b.ts', '3'),
      call('write_file', 'a.ts', '4'),
    ], 10);

    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('re-reads recently modified files and restates the plan after an eviction', async () => {
    const reads: string[] = [];
    const engine = new ContextEngine({
      maxMessages: 3,
      rehydration: {
        readFile: async (path) => { reads.push(path); return path === 'src/app.ts' ? 'export const a = 1;' : undefined; },
        todos: () => '[>] wire the parser',
      },
    });
    const writeCall: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'w1', index: 0, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content: 'x' }) } }] },
      { role: 'tool', content: 'ok', toolCallId: 'w1', toolName: 'write_file' },
    ];
    const msgs: Message[] = [...writeCall, ...pair('p1'), ...pair('p2'), ...pair('p3')];

    const result = await engine.compact(msgs);

    expect(reads).toContain('src/app.ts');
    expect(result.rehydratedFiles).toBe(1);
    expect(result.restoredPlan).toBe(true);
    const block = result.messages.find(m => m.content.startsWith('State restored after context compaction'));
    expect(block).toBeDefined();
    expect(block!.content).toContain('export const a = 1;');
    expect(block!.content).toContain('wire the parser');
  });

  it('replaces a stale rehydration block instead of stacking a new one', async () => {
    const engine = new ContextEngine({
      maxMessages: 3,
      rehydration: { readFile: async () => 'NEW CONTENT' },
    });
    const stale: Message = {
      role: 'system',
      content: 'State restored after context compaction — earlier pass\n\n--- src/app.ts ---\nOLD CONTENT',
    };
    const writeCall: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'w1', index: 0, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content: 'x' }) } }] },
      { role: 'tool', content: 'ok', toolCallId: 'w1', toolName: 'write_file' },
    ];
    const msgs: Message[] = [stale, ...writeCall, ...pair('p1'), ...pair('p2'), ...pair('p3')];

    const result = await engine.compact(msgs);

    const blocks = result.messages.filter(m => m.content.startsWith('State restored after context compaction'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain('NEW CONTENT');
    expect(blocks[0].content).not.toContain('OLD CONTENT');
  });

  it('does not rehydrate when nothing was evicted', async () => {
    let called = false;
    const engine = new ContextEngine({
      maxMessages: 50,
      rehydration: { readFile: async () => { called = true; return 'x'; } },
    });

    const result = await engine.compact([...pair('p1')]);

    expect(called).toBe(false);
    expect(result.rehydratedFiles).toBe(0);
    expect(result.restoredPlan).toBe(false);
  });
});
