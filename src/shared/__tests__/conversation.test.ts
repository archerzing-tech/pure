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

  it('a completed turn merges to exactly one user turn with the reply intact (2026-09-27 HVC 复测回归)', () => {
    // GUI 正常完成的形态：合并前转录只有 system + 规划叙述（用户气泡只在
    // DOM 里），引擎载荷 [system, 组合请求, …工作消息…, 回复] 并进来后，
    // 用户回合必须恰好一份、回复跟在它后面。HVC 复测的中断双并曾把这份
    // 形状打成 [.., userTC, userTC] 且回复丢失。
    const narration = '我先把需求拆解清楚，再定原型方案。';
    const userTurn = '<task_context>…artifact rule…</task_context>\n\n构建一个 hvc 原型演示项目';
    const transcript: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: narration },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: userTurn },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', index: 0, function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'write_file' },
      { role: 'assistant', content: '项目已交付，入口是 index.html。' },
    ];

    const merged = mergeTranscriptWithTurn(transcript, modelMessages, '构建一个 hvc 原型演示项目');
    expect(merged).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: narration },
      { role: 'user', content: userTurn },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', index: 0, function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'write_file' },
      { role: 'assistant', content: '项目已交付，入口是 index.html。' },
    ]);
  });
});
