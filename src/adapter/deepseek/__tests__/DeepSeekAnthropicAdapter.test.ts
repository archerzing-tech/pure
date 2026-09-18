// src/adapter/deepseek/__tests__/DeepSeekAnthropicAdapter.test.ts
// P0 fix: consecutive user messages must be merged for the Anthropic API.
// 8.2: cache breakpoints mark only the stable prefix; usage translation maps
// Anthropic's split billing fields into the normalized shape.

import { describe, it, expect } from 'bun:test';
import {
  anthropicUsageToOpenAI,
  applyAnthropicCacheBreakpoints,
  cacheableAnthropicRequest,
  mapAnthropicMessages,
} from '../DeepSeekAnthropicAdapter';
import type { Message } from '../../../shared/types';

describe('mapAnthropicMessages — consecutive user merging', () => {
  it('merges two consecutive user messages into one', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Please fix the bug' },
      { role: 'user', content: 'Retry hint injected by failure policy' },
    ];
    const { conversationMessages } = mapAnthropicMessages(messages);
    expect(conversationMessages).toHaveLength(1);
    expect(conversationMessages[0]).toEqual({
      role: 'user',
      content: 'Please fix the bug\n\nRetry hint injected by failure policy',
    });
  });

  it('merges a user hint appended after tool results into the tool-result user turn', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', toolCallId: 'call_1', toolName: 'read_file', content: '{"ok":true}' },
      { role: 'user', content: 'Tool failed, retry with a different approach' },
    ];
    const { conversationMessages } = mapAnthropicMessages(messages);
    // assistant + one merged user turn (tool_result + hint text)
    expect(conversationMessages).toHaveLength(2);
    const userTurn = conversationMessages[1];
    expect(userTurn.role).toBe('user');
    const blocks = userTurn.content as unknown as Array<{ type: string; text?: string; tool_use_id?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Tool failed, retry with a different approach' });
  });

  it('maps a native data URL image into an Anthropic base64 image block', () => {
    const { conversationMessages } = mapAnthropicMessages([{
      role: 'user',
      content: 'What is in this image?',
      images: [{ dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'shot.png' }],
    }]);
    expect(conversationMessages[0]).toMatchObject({ role: 'user' });
    expect(conversationMessages[0].content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('keeps alternating roles unchanged for a normal tool round', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', index: 0, function: { name: 'write_file', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'write_file', content: 'wrote' },
    ];
    const { system, conversationMessages } = mapAnthropicMessages(messages);
    expect(system).toBe('sys');
    expect(conversationMessages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('merges three consecutive user messages (verify retry loop)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u3' },
    ];
    const { conversationMessages } = mapAnthropicMessages(messages);
    expect(conversationMessages).toHaveLength(1);
    expect(conversationMessages[0].content).toBe('u1\n\nu2\n\nu3');
  });

  it('promotes a string-content user turn when a tool result follows it (no consecutive users)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a hint from an earlier flow' },
      { role: 'tool', toolCallId: 'call_9', toolName: 'read_file', content: '{}' },
    ];
    const { conversationMessages } = mapAnthropicMessages(messages);
    expect(conversationMessages).toHaveLength(1);
    const blocks = conversationMessages[0].content as unknown as Array<{ type: string; text?: string; tool_use_id?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'a hint from an earlier flow' });
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_9' });
  });
});

describe('8.2 — anthropic prompt-cache breakpoints', () => {
  it('marks the second-to-last message and leaves the newest turn unmarked', () => {
    const { conversationMessages } = mapAnthropicMessages([
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', index: 0, function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 't1', toolName: 'a', content: 'ok' },
      { role: 'user', content: 'newest ask' },
    ]);
    const marked = applyAnthropicCacheBreakpoints(conversationMessages);
    expect(marked).toHaveLength(3);

    // The prefix message (assistant with the tool_use block) is promoted so
    // its LAST block carries the marker.
    const prefix = marked[1].content as unknown as Array<Record<string, unknown>>;
    expect(prefix[prefix.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // The newest message — the merged tool-result + ask turn — stays unmarked:
    // it is the delta every request re-bills.
    const newest = marked[2].content as unknown as Array<Record<string, unknown>>;
    expect(newest.some((block) => block.cache_control)).toBe(false);
  });

  it('leaves a single-message transcript untouched (nothing stable yet)', () => {
    const { conversationMessages } = mapAnthropicMessages([{ role: 'user', content: 'only ask' }]);
    const marked = applyAnthropicCacheBreakpoints(conversationMessages);
    expect(marked[0].content).toBe('only ask');
  });

  it('wraps the system prompt as a breakpoint-carrying text block', () => {
    const request = cacheableAnthropicRequest('the system prompt', [{ role: 'user', content: 'hi' }]);
    expect(request.system).toEqual([
      { type: 'text', text: 'the system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(cacheableAnthropicRequest('', []).system).toBeUndefined();
  });

  it('translates Anthropic usage into the normalized cache split', () => {
    const mapped = anthropicUsageToOpenAI({
      input_tokens: 100,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 50,
      output_tokens: 42,
    });
    // Total billed prompt includes cached + cache-write portions.
    expect(mapped.prompt_tokens).toBe(850);
    expect(mapped.prompt_cache_hit_tokens).toBe(700);
    expect(mapped.prompt_cache_miss_tokens).toBe(150);
    expect(mapped.completion_tokens).toBe(42);

    // Absent fields degrade to zero, never NaN.
    const bare = anthropicUsageToOpenAI({ input_tokens: 10 });
    expect(bare.prompt_cache_hit_tokens).toBe(0);
    expect(bare.completion_tokens).toBe(0);
  });
});
