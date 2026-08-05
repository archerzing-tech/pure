// src/adapter/deepseek/__tests__/DeepSeekAnthropicAdapter.test.ts
// P0 fix: consecutive user messages must be merged for the Anthropic API.

import { describe, it, expect } from 'bun:test';
import { mapAnthropicMessages } from '../DeepSeekAnthropicAdapter';
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
