// streamWithDeadline first-token deadline — the "两个子 agent 无法执行" fix.
// A connection that accepts but never streams used to be held for the shared
// 5-minute FIRST_TOKEN_TIMEOUT_MS; subagent budgets now pass a tighter ceiling
// (deriveSubagentBudget → 90s) so a stalled fan-out sibling fails fast into
// the retry policy instead of holding the whole tool batch as silent cards.

import { describe, expect, it } from 'bun:test';
import type { LLMAdapter, LLMChunk, Message, ToolDefinition } from '../../shared/types';
import { streamWithDeadline } from '../streamDeadline';

const NO_TOOLS: ToolDefinition[] = [];
const NO_MESSAGES: Message[] = [];

function stalledAdapter(): LLMAdapter {
  return {
    // Accepts the call, then never produces a chunk until the abort arrives —
    // the free-tier queue/stall shape the first-token deadline exists for.
    async *stream(_messages: Message[], _tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LLMChunk, void, void> {
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted before first chunk'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted before first chunk')), { once: true });
      });
      yield { type: 'done', content: '', toolCalls: [] };
    },
  } as unknown as LLMAdapter;
}

function healthyAdapter(firstChunkDelayMs: number): LLMAdapter {
  return {
    async *stream(): AsyncGenerator<LLMChunk, void, void> {
      await new Promise((r) => setTimeout(r, firstChunkDelayMs));
      yield { type: 'content', content: 'hello' };
      yield { type: 'done', content: 'hello', toolCalls: [] };
    },
  } as unknown as LLMAdapter;
}

async function consume(gen: AsyncGenerator<LLMChunk, void, void>): Promise<{ chunks: LLMChunk[]; error?: Error }> {
  const chunks: LLMChunk[] = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
  } catch (error) {
    return { chunks, error: error as Error };
  }
  return { chunks };
}

describe('streamWithDeadline first-token deadline', () => {
  it('aborts a never-streaming connection with a first-token TimeoutError (custom ceiling)', async () => {
    const started = Date.now();
    const { error } = await consume(
      streamWithDeadline(stalledAdapter(), NO_MESSAGES, NO_TOOLS, undefined, 60_000, 50),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.name).toBe('TimeoutError');
    expect(error?.message).toMatch(/first token/);
    // 50ms ceiling, not the historical 5 minutes.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets a healthy stream through when the first chunk beats the ceiling', async () => {
    const { chunks, error } = await consume(
      streamWithDeadline(healthyAdapter(10), NO_MESSAGES, NO_TOOLS, undefined, 60_000, 50),
    );
    expect(error).toBeUndefined();
    expect(chunks.some((c) => c.type === 'content' && c.content === 'hello')).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe('done');
  });
});
