import { describe, expect, it } from 'bun:test';
import { mergeTranscriptWithTurn } from '../conversation';
import type { Message } from '../types';

describe('conversation history helpers', () => {
  it('preserves the full transcript when the model used a compacted window', () => {
    const transcript: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'system', content: 'Earlier conversation summary: first' },
      { role: 'user', content: '<task_context>\nplan\n</task_context>\n\nsecond' },
      { role: 'assistant', content: 'second answer' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, 'second')).toEqual([
      ...transcript,
      { role: 'user', content: '<task_context>\nplan\n</task_context>\n\nsecond' },
      { role: 'assistant', content: 'second answer' },
    ]);
  });

  it('does not guess a turn boundary when the new user text is absent', () => {
    const transcript: Message[] = [
      { role: 'user', content: 'existing' },
      { role: 'assistant', content: 'answer' },
    ];
    const modelMessages: Message[] = [
      { role: 'user', content: 'existing' },
      { role: 'assistant', content: 'different output' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, 'missing')).toBe(transcript);
  });

  it('keeps tool messages from the new turn in order', () => {
    const modelMessages: Message[] = [
      { role: 'user', content: 'next' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', index: 0, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'file', toolCallId: 'call_1', toolName: 'read_file' },
      { role: 'assistant', content: 'done' },
    ];

    expect(mergeTranscriptWithTurn([], modelMessages, 'next')).toEqual(modelMessages);
  });
});
