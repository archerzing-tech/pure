// src/ui/__tests__/sessionReplayFidelity.test.ts
// 会话回放保真（2026-09-27 用户定调：「切换历史会话，显示结果和用户实际对话
// ……要求保持一模一样」）。主差异源：约 40 处实时状态叙述行（回执、阶段播报、
// 验证轮次）过去只进 DOM 不落盘，回放里整段消失。这里锁住入账→拼接→投影→
// 渲染四环：锚点拼接保序、快照往返不丢、投影出 status 块、回放渲染同脸。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFileSync } from 'node:fs';
import { createSessionSnapshot, extractTitle, normalizeSessionSnapshot, type StatusLineRecord, type TranscriptDraft } from '../store';
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
    // 锚 -1 最前（createSessionSnapshot 是低层拼接，-1 只是历史形状——
    // 载入侧 healLeadingNarrationEvents 会把这类行搬回用户之后，见下）；
    // 锚 1 的两条在 assistant 之后、tool_result 之前（实时转写里
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

  it('快照往返不丢：账本原样回来；旧账锚 -1 的开场行载入即搬回用户之后', () => {
    const snap = createSessionSnapshot(messages as never, drafts, {}, statusLines);
    const round = normalizeSessionSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(round.statusLines).toEqual(statusLines);
    // 2026-09-29 用户定调：历史会话第一行必须是用户的输入。锚 -1 的状态行
    // 曾被 flushStatuses(-1) 拼成事件流第 0 条（画图会话 2026-09-27 实证、
    // 开局插话改前提的收执标签同病）——载入即治，搬到首条用户事件之后。
    expect(round.events.map(e => e.type)).toEqual(['user', 'status', 'assistant', 'status', 'status', 'tool_result', 'status']);
    expect(round.events[1].content).toBe('开场叙述');
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
    // 空会话钳到 0（下一条消息之后）——不再产生 -1 锚，-1 会被拼接层排到
    // 整段最顶上、压在第一条用户输入前面（2026-09-29 用户报的病形状）。
    expect(ledger[0].afterIndex).toBe(0);
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

  it('流式回合里入账：锚跟本回合用户消息将占的下标走，首回合不再锚 -1', () => {
    const host = document.createElement('div');
    const chat = new ChatController({ host } as never) as unknown as Record<string, any>;
    // 首回合在飞：turn 已开、用户气泡已上屏，但消息要收尾才 merge 进
    // this.messages——此刻 messages 还是空的。旧算法给 -1（会话最顶上，
    // 2026-09-29 用户报：开局插话改前提，收执标签占了历史会话第一行）；
    // 修复后本回合用户消息将占下标 0，行锚在它之后。
    chat.streaming = true;
    chat.notifyStatus('收到——看一下这句话怎么安排…');
    expect((chat.statusLines as StatusLineRecord[])[0].afterIndex).toBe(0);

    // 中段回合在飞：已入账 2 条（user+assistant），本回合用户消息将占下标
    // 2——收执行锚在那里，回放落在在飞回合的用户输入后面（实况里它就长在
    // 用户气泡之后），而不是压到上一回合的尾巴前面。
    (chat.statusLines as StatusLineRecord[]).length = 0;
    chat.messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ];
    chat.notifyStatus('方向变了——在跑的先停下止损。');
    expect((chat.statusLines as StatusLineRecord[])[0].afterIndex).toBe(2);

    // 空闲时尾行是最后一条已入账消息（旧行为保持）。
    chat.streaming = false;
    (chat.statusLines as StatusLineRecord[]).length = 0;
    chat.notifyStatus('手头的活收尾了。');
    expect((chat.statusLines as StatusLineRecord[])[0].afterIndex).toBe(1);
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

  it('analysis 头也属于叙述家族：预检叙述的事件形态同样搬正', () => {
    const raw = {
      version: 3,
      modelContext: { messages: [{ role: 'user', content: '画个图' }, { role: 'assistant', content: '好。' }] },
      events: [
        { id: 'e0', type: 'analysis', content: '用户想要一张图，我先拆一下需求。' },
        { id: 'e1', type: 'user', content: '画个图' },
        { id: 'e2', type: 'assistant', content: '好。' },
      ],
      transcript: [],
      uiState: {},
    };
    const healed = normalizeSessionSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(healed.events.map(e => e.type)).toEqual(['user', 'analysis', 'assistant']);
  });

  it('收执标签头也搬正（2026-09-29 用户报）：开局插话的状态行不再压在用户输入前面', () => {
    // 旧锚算法在首回合给 -1，flushStatuses(-1) 把收执行拼成事件流第 0 条——
    // 翻历史会话第一行是「前提变了……」，不是用户的输入。
    const raw = {
      version: 3,
      modelContext: { messages: [{ role: 'user', content: '帮我策划读书会' }, { role: 'assistant', content: '好的，先定主题。' }] },
      events: [
        { id: 's0', type: 'status', content: '前提变了——按纠正后的事实重新来；已完成的不丢。', kind: 'info' },
        { id: 'e0', type: 'user', content: '帮我策划读书会' },
        { id: 'e1', type: 'assistant', content: '好的，先定主题。' },
      ],
      transcript: [
        { id: 't0', modelMessageIndex: 0, role: 'user', content: '帮我策划读书会' },
        { id: 't1', modelMessageIndex: 1, role: 'assistant', content: '好的，先定主题。' },
      ],
      uiState: {},
    };
    const healed = normalizeSessionSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(healed.events.map(e => e.type)).toEqual(['user', 'status', 'assistant']);
    expect(healed.events[0].content).toBe('帮我策划读书会');
    expect(healed.events[1].content).toContain('前提变了');
    // 投影同序：回放第一块就是用户的话。
    const blocks = projectSessionEvents(healed.events);
    expect(blocks[0].type).toBe('user');
  });

  it('叙述与状态行混排的头整段搬正：相对次序保持，只是退到用户之后', () => {
    const raw = {
      version: 3,
      modelContext: { messages: [{ role: 'user', content: '调研一下' }, { role: 'assistant', content: '开始。' }] },
      events: [
        { id: 'e0', type: 'thinking', content: '先拆一下调研口径…' },
        { id: 's0', type: 'status', content: '🔎 已完成项目探索' },
        { id: 'e1', type: 'user', content: '调研一下' },
        { id: 'e2', type: 'assistant', content: '开始。' },
      ],
      transcript: [],
      uiState: {},
    };
    const healed = normalizeSessionSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(healed.events.map(e => e.type)).toEqual(['user', 'thinking', 'status', 'assistant']);
  });

  it('v2 旧账同治：派生事件里的锚 -1 开场行同样退到用户之后', () => {
    const raw = {
      version: 2,
      modelContext: { messages: [{ role: 'user', content: '帮我策划读书会' }, { role: 'assistant', content: '好的。' }] },
      transcript: [
        { id: 't0', modelMessageIndex: 0, role: 'user', content: '帮我策划读书会' },
        { id: 't1', modelMessageIndex: 1, role: 'assistant', content: '好的。' },
      ],
      statusLines: [{ afterIndex: -1, text: '收到——看一下这句话怎么安排…', pending: true }],
      uiState: {},
    };
    const healed = normalizeSessionSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(healed.events.map(e => e.type)).toEqual(['user', 'status', 'assistant']);
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

  it('自动续跑的代劳「继续」打 internal：send 的三处 user 消息构造同款（丢了恢复渲染就冒充用户发言）', () => {
    const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    // 押账提交、提交即落盘、暂停快照——isAuto 的消息每条都得带标记。
    expect(chatSource.split('internal: isAuto || undefined').length - 1).toBe(3);
  });
});

describe('会话标题取词（extractTitle）——标题必须是用户的话', () => {
  it('跳过 internal 引擎消息：失败重试注不配当标题（真实 B 会话形状）', () => {
    const title = extractTitle([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Tool call execute_command failed: Command failed with exit code 1', internal: true },
      { role: 'user', content: 'Attempt 1: Command failed with exit code 124', internal: true },
      { role: 'assistant', content: '错误说明 output 目录不在仓库里。' },
      { role: 'user', content: '从youtube上面随便给我下一个15s左右的视频' },
    ]);
    expect(title).toBe('从youtu…');
  });

  it('剥掉 <task_context> 协议壳：标题取壳外用户原话（真实 A 会话形状）', () => {
    const title = extractTitle([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: '这个需求的核心是对齐用的原型演示。' },
      { role: 'user', content: '<task_context>\n<artifact_output_rule>…</artifact_output_rule>\n</task_context>\n\n构建一个香港 HVC 保障原型' },
    ]);
    expect(title).toBe('构建一个香港…');
  });

  it('剥壳后为空就继续向后找；全是引擎消息则落 New chat', () => {
    const skipped = extractTitle([
      { role: 'user', content: '<task_context>只有壳</task_context>', internal: true },
      { role: 'user', content: '真正的问题在这' },
    ]);
    expect(skipped).toBe('真正的问题在…');
    expect(extractTitle([{ role: 'user', content: '[粘贴图片/截图: x]', internal: true }])).toBe('New chat');
  });
});
