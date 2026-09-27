import { describe, expect, it } from 'bun:test';
import { mergeTranscriptWithTurn, relocatePreflightNarration } from '../conversation';
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
    // GUI 正常完成的形态：合并前转录只有 system（用户气泡只在 DOM 里），引擎
    // 载荷 [system, 组合请求, …工作消息…, 回复] 并进来后，用户回合必须恰好
    // 一份、回复跟在它后面。HVC 复测的中断双并曾把这份形状打成
    // [.., userTC, userTC] 且回复丢失。
    const userTurn = '<task_context>…artifact rule…</task_context>\n\n构建一个 hvc 原型演示项目';
    const transcript: Message[] = [
      { role: 'system', content: 'system' },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: userTurn },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', index: 0, function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'write_file' },
      { role: 'assistant', content: '项目已交付，入口是 index.html。' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, '构建一个 hvc 原型演示项目')).toEqual(modelMessages);
  });

  it('押账的规划叙述插在本回合用户消息之后，不抢在请求前面（2026-09-27 时序修正）', () => {
    // 病根回归：2a7c950 曾把叙述直接 push 进转录，canonical 变成
    // [system, 思考, 用户请求]，切回历史会话就是“pure 先思考，人的话在后头”。
    // 现在叙述走第 4 参，合并时插到请求后面——先请求，后思考，再执行。
    const narration = '我先把需求拆解清楚，再定原型方案。';
    const userTurn = '<task_context>…artifact rule…</task_context>\n\n构建一个 hvc 原型演示项目';
    const transcript: Message[] = [
      { role: 'system', content: 'system' },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: userTurn },
      { role: 'assistant', content: '先看一眼工作区，然后开工。' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, '构建一个 hvc 原型演示项目', { role: 'assistant', content: narration })).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: userTurn },
      { role: 'assistant', content: narration },
      { role: 'assistant', content: '先看一眼工作区，然后开工。' },
    ]);
  });

  it('多回合会话：叙述只插进本回合，上一回合的账原样保留', () => {
    const narration2 = '这个追加需求我想清楚再动。';
    const transcript: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '第一件事' },
      { role: 'assistant', content: '第一件事做完了。' },
    ];
    const modelMessages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '<task_context>…</task_context>\n\n第二件事' },
      { role: 'assistant', content: '第二件事做完了。' },
    ];

    expect(mergeTranscriptWithTurn(transcript, modelMessages, '第二件事', { role: 'assistant', content: narration2 })).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: '第一件事' },
      { role: 'assistant', content: '第一件事做完了。' },
      { role: 'user', content: '<task_context>…</task_context>\n\n第二件事' },
      { role: 'assistant', content: narration2 },
      { role: 'assistant', content: '第二件事做完了。' },
    ]);
  });

  it('relocatePreflightNarration：载入时把「思考在请求前」的旧账搬正', () => {
    // 2a7c950 落下的存量会话（含用户报的 HVC 案例）：canonical 是
    // [system, 思考, 用户请求, …]，真实时序是先请求后思考。
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: '思考叙述 A' },
      { role: 'assistant', content: '思考叙述 B' },
      { role: 'user', content: '构建一个 hvc 原型' },
      { role: 'assistant', content: '先看一眼工作区。' },
    ];
    expect(relocatePreflightNarration(messages)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: '构建一个 hvc 原型' },
      { role: 'assistant', content: '思考叙述 A' },
      { role: 'assistant', content: '思考叙述 B' },
      { role: 'assistant', content: '先看一眼工作区。' },
    ]);
  });

  it('relocatePreflightNarration：正常数据与无从判定的形状原样返回', () => {
    const normal: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '先来一版' },
      { role: 'assistant', content: '好' },
    ];
    expect(relocatePreflightNarration(normal)).toBe(normal);
    // 首个用户消息之前出现 tool 不是叙述形状，不动。
    const withTool: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: '叙述' },
      { role: 'tool', content: 'r', toolCallId: 'c', toolName: 'x' },
      { role: 'user', content: '请求' },
    ];
    expect(relocatePreflightNarration(withTool)).toBe(withTool);
    // 纯 system 开头、没有用户消息：不动。
    const noUser: Message[] = [{ role: 'system', content: 'system' }];
    expect(relocatePreflightNarration(noUser)).toBe(noUser);
  });
});
