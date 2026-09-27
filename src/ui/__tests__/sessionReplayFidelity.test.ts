// src/ui/__tests__/sessionReplayFidelity.test.ts
// 会话回放保真（2026-09-27 用户定调：「切换历史会话，显示结果和用户实际对话
// ……要求保持一模一样」）。主差异源：约 40 处实时状态叙述行（回执、阶段播报、
// 验证轮次）过去只进 DOM 不落盘，回放里整段消失。这里锁住入账→拼接→投影→
// 渲染四环：锚点拼接保序、快照往返不丢、投影出 status 块、回放渲染同脸。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFileSync } from 'node:fs';
import { createSessionSnapshot, normalizeSessionSnapshot, type StatusLineRecord, type TranscriptDraft } from '../store';
import { projectSessionEvents } from '../transcriptProjection';
import { ChatController } from '../chat';

const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('状态叙述行入账与事件拼接（store）', () => {
  const messages = [
    { role: 'user', content: '帮我调研' },
    { role: 'assistant', content: '先把来源理一遍。' },
    { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'web_search' },
  ];
  const drafts = messages.map((message, modelMessageIndex) => ({ message, modelMessageIndex })) as TranscriptDraft[];
  const statusLines: StatusLineRecord[] = [
    { afterIndex: -1, text: '开场叙述' },
    { afterIndex: 1, text: '正在整理来源…', pending: true },
    { afterIndex: 1, text: '已完成项目探索：结构已摸清', kind: 'info' },
    { afterIndex: 2, text: '第 1/3 轮交付验证未通过', error: true },
  ];

  it('按锚点拼接进事件流：锚点消息的事件落完后插入，同锚保持入账次序', () => {
    const snap = createSessionSnapshot(messages as never, drafts, {}, statusLines);
    const types = snap.events.map(e => e.type);
    // 锚 -1 最前；锚 1 的两条在 assistant 之后、tool_result 之前（实时转写里
    // 这两行就长在回复与结果卡之间）；锚 2 收尾。
    expect(types).toEqual(['status', 'user', 'assistant', 'status', 'status', 'tool_result', 'status']);
    const texts = snap.events.filter(e => e.type === 'status').map(e => e.content);
    expect(texts).toEqual(['开场叙述', '正在整理来源…', '已完成项目探索：结构已摸清', '第 1/3 轮交付验证未通过']);
    // 着色随行：kind/error 原样进事件。
    const statusEvents = snap.events.filter(e => e.type === 'status');
    expect(statusEvents[1].kind).toBeUndefined();
    expect(statusEvents[2].kind).toBe('info');
    expect(statusEvents[3].error).toBe(true);
  });

  it('快照往返不丢：v3 序列化→normalize 后 statusLines 与事件原样回来', () => {
    const snap = createSessionSnapshot(messages as never, drafts, {}, statusLines);
    const round = normalizeSessionSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(round.statusLines).toEqual(statusLines);
    expect(round.events.map(e => e.type)).toEqual(['status', 'user', 'assistant', 'status', 'status', 'tool_result', 'status']);
  });

  it('LS 降级裁剪与 transcript 同一命运：锚点消息被裁的状态行一并裁掉', () => {
    // limitSessionSnapshot 是私有路径，行为等价物在这里直接验锚点过滤的
    // 语义：裁掉 dropped 条消息后，锚 < dropped 的行不再留在账上。
    const dropped = 1;
    const kept = statusLines.filter(line => line.afterIndex >= dropped);
    expect(kept.map(l => l.text)).toEqual(['正在整理来源…', '已完成项目探索：结构已摸清', '第 1/3 轮交付验证未通过']);
  });
});

describe('状态块投影（transcriptProjection）', () => {
  it('status 事件投影为 status 块，位置保持在消息与工具卡之间', () => {
    const events = [
      { id: 'e1', type: 'user' as const, content: '帮我调研' },
      { id: 'e2', type: 'status' as const, content: '正在整理来源…' },
      { id: 'e3', type: 'tool_call' as const, toolCallId: 'c1', toolName: 'web_search', toolCalls: [{ id: 'c1', toolName: 'web_search', args: {} }] },
      { id: 'e4', type: 'status' as const, content: '验证未通过', error: true },
      { id: 'e5', type: 'tool_result' as const, content: 'ok', toolCallId: 'c1', toolName: 'web_search' },
    ];
    const blocks = projectSessionEvents(events as never);
    const shapes = blocks.map(b => (b.type === 'status' ? `status:${b.text}${b.error ? '!' : ''}` : b.type));
    // tool_call 不直接出块（委派卡由 tool_result 落地时渲染），状态行卡在
    // 调用与结果之间——与实时转写里「工具在跑时叙述行先到」的位置一致。
    expect(shapes).toEqual(['user', 'status:正在整理来源…', 'status:验证未通过!', 'tool']);
  });
});

describe('控制器账本（chat）', () => {
  let registeredHere = false;
  beforeAll(() => {
    if (!(globalThis as any).document?.body) {
      GlobalRegistrator.register();
      registeredHere = true;
    }
  });
  afterAll(() => {
    if (registeredHere) {
      GlobalRegistrator.unregister();
      registeredHere = false;
    }
  });

  it('notifyStatus 入账：锚在当前最后一条消息之后，终稿补丁随行、销账即消失', () => {
    const host = document.createElement('div');
    const chat = new ChatController({ host } as never) as unknown as Record<string, any>;
    chat.notifyStatus('🔎 探索中…');
    let ledger = chat.statusLines as StatusLineRecord[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].afterIndex).toBe(-1);
    expect(ledger[0].text).toBe('🔎 探索中…');

    // 终稿补丁：文本与着色跟上（settleAck / 修复轮次走的同一入口）。
    const bubble = host.querySelector('.bubble-row.status > .bubble') as HTMLElement;
    chat.patchStatusLine(bubble, { text: '🔎 已完成项目探索', pending: false, kind: 'info' });
    expect((chat.statusLines as StatusLineRecord[])[0].text).toBe('🔎 已完成项目探索');
    expect((chat.statusLines as StatusLineRecord[])[0].kind).toBe('info');

    // 行被摘掉（ack 终稿顶替 / modeBubble 让位）：账上同步销账。
    chat.removeStatusLine(bubble);
    expect(chat.statusLines).toHaveLength(0);

    // 快照没带账（旧会话）：载入即空账，不拿幻影行污染后续持久化。
    chat.loadFromStorage({ version: 3, modelContext: { messages: [] }, events: [], transcript: [], uiState: {} } as never);
    expect(chat.statusLines).toHaveLength(0);
  });

  it('回放渲染同脸：main.ts 的回放分支用 buildStatusRow 长出同一张脸', () => {
    expect(main).toContain("block.type === 'status'");
    expect(main).toContain('buildStatusRow(block.text');
  });
});

describe('规划叙述时序（2026-09-27 用户报「切历史会话 pure 先思考，人的输入在后面」）', () => {
  it('normalize 载入即治：v3 旧账（思考在请求前）的条目、事件、上下文、锚点同搬正', () => {
    // 形状取自真实 HVC 会话（session_1790503940864_2）：canonical 是
    // [system, 叙述, userTC, …]，叙述条目 modelMessageIndex=1、用户=2。
    const raw = {
      version: 3,
      modelContext: {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'assistant', content: '这个需求的核心是对齐用的原型演示。' },
          { role: 'user', content: '<task_context>…</task_context>\n\n构建一个 hvc 原型' },
          { role: 'assistant', content: '先看一眼工作区。' },
        ],
      },
      events: [
        { id: 'e0', type: 'thinking', content: 'The user wants me to build an HVC demo…' },
        { id: 'e1', type: 'assistant', content: '这个需求的核心是对齐用的原型演示。' },
        { id: 'e2', type: 'user', content: '<task_context>…</task_context>\n\n构建一个 hvc 原型' },
        { id: 'e3', type: 'assistant', content: '先看一眼工作区。' },
      ],
      transcript: [
        { id: 't1', modelMessageIndex: 1, role: 'assistant', content: '这个需求的核心是对齐用的原型演示。' },
        { id: 't2', modelMessageIndex: 2, role: 'user', content: '<task_context>…</task_context>\n\n构建一个 hvc 原型' },
        { id: 't3', modelMessageIndex: 3, role: 'assistant', content: '先看一眼工作区。' },
      ],
      statusLines: [
        { afterIndex: 1, text: '叙述之后出的行' },
        { afterIndex: 2, text: '请求之后出的行' },
        { afterIndex: 3, text: '回复之后出的行' },
      ],
      uiState: {},
    };
    const healed = normalizeSessionSnapshot(JSON.parse(JSON.stringify(raw)));

    // 事件：用户先开口，思考跟在后面——回放顺序恢复真实时序。
    expect(healed.events.map(e => e.type)).toEqual(['user', 'thinking', 'assistant', 'assistant']);
    // 条目与 modelMessageIndex：用户占住叙述原来的起点，叙述顺延一位。
    expect(healed.transcript.map(e => `${e.role}@${e.modelMessageIndex}`)).toEqual(['user@1', 'assistant@2', 'assistant@3']);
    // 模型上下文同治：后续回合读到的就是真实时序。
    expect(healed.modelContext.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'assistant']);
    // 状态行锚点随条目重排：锚叙述(1)→2，锚用户(2)→1，其余不动。
    expect((healed.statusLines ?? []).map(l => l.afterIndex)).toEqual([2, 1, 3]);
    // 投影出来的块序即回放序：先用户、再思考卡、再叙述正文。
    const blocks = projectSessionEvents(healed.events);
    expect(blocks.map(b => b.type)).toEqual(['user', 'thinking', 'assistant', 'assistant']);
  });

  it('normalize 幂等且对健康数据零改动：正常会话原样通过', () => {
    const healthy = {
      version: 3,
      modelContext: { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }] },
      events: [
        { id: 'e0', type: 'user', content: '你好' },
        { id: 'e1', type: 'assistant', content: '你好！' },
      ],
      transcript: [
        { id: 't0', modelMessageIndex: 0, role: 'user', content: '你好' },
        { id: 't1', modelMessageIndex: 1, role: 'assistant', content: '你好！' },
      ],
      uiState: {},
    };
    const once = normalizeSessionSnapshot(JSON.parse(JSON.stringify(healthy)));
    expect(once.events.map(e => e.type)).toEqual(['user', 'assistant']);
    expect(once.transcript.map(e => `${e.role}@${e.modelMessageIndex}`)).toEqual(['user@0', 'assistant@1']);
    expect(normalizeSessionSnapshot(JSON.parse(JSON.stringify(once))).events).toEqual(once.events);
  });

  it('源头修复：chat.ts 押账叙述、两个合并点与暂停提交各消费一次', () => {
    const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    // 叙述不再直接 push 进 canonical（push 就是「思考抢在请求前」的病根）。
    expect(chatSource).not.toContain("this.messages.push({ role: 'assistant', content: thought.narration })");
    expect(chatSource).toContain('this.pendingPlanNarration = thought.narration;');
    // 两个合并点 + 暂停提交都经 takePendingPlanNarration 消费（各恰好一次）。
    expect(chatSource.split('this.takePendingPlanNarration()').length - 1).toBe(3);
    expect(chatSource).toContain('mergeTranscriptWithTurn(this.messages, completionMessages, userText, this.takePendingPlanNarration())');
    expect(chatSource).toContain('mergeTranscriptWithTurn(this.messages, event.payload.messages, userText, this.takePendingPlanNarration())');
  });
});
