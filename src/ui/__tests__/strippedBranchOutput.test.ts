// src/ui/__tests__/strippedBranchOutput.test.ts
// 缺口②机械排除（第 6 期）行为判例：已收工委派支被点名取消后，产出从**后续
// 每一次请求**的装配源里整体离场（四通道），渲染通道保持原样。
// 第 0 步先立两条判例证实/证伪开工前的两处推断（同回合空转、渲染通道被墓碑
// 顶替），再在其上锁四通道离场与持久化往返。
//
// 四通道 = ① this.messages（历史 → 下一轮装配）、② preCompactedMessages、
// ③ sessionLedger.done（delegate:<agent> 摘要）、④ activeTaskScript 委派摘要。
// 渲染通道 = toolExec.resultText / 委派卡 agentActivities.output / 事件日志。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { loadSession } from '../store';
import { settledBranchCancelNote } from '../../shared/insertionMessaging';
import { createSessionLedger, recordDone } from '../../shared/sessionLedger';
import {
  applyTaskScriptSignal,
  createTaskScript,
  taskScriptHandOver,
  type TaskScript,
} from '../../shared/taskScript';
import type { Plan } from '../../coding-agent/types';
import { InterjectOrchestrator, type InterjectOrchestratorDeps, type InterjectAck } from '../../coding-agent/interjectOrchestrator';
import type { DynamicInsertionCoordinator, DynamicInsertionDecision } from '../../coding-agent/DynamicInsertionCoordinator';
import type { DelegationControlPlane } from '../../coding-agent/delegationControl';
import type { RoundClosePlane } from '../../coding-agent/roundClosePlane';
import type { InFlightBranch, SteerTarget } from '../../shared/steerTargeting';
import type { MessageImage } from '../../shared/types';

const ORIGINAL_OUTPUT = '原始产出：A 平台的定价区间是 9.9–19.9 元，份额领先。';
const AGENT = '市场调研员';
const SNIPPET = '调研A平台定价';
const CALL = 'call_done';
const TOPIC = 'A平台定价不用查了';

const PLAN: Plan = {
  reasoning: '',
  steps: [{ id: 's1', action: '调研', description: '', expectedOutcome: '' }],
};

function makeChat(): Record<string, any> {
  const host = document.createElement('div');
  return new ChatController({ host } as never) as unknown as Record<string, any>;
}

function delegationToolMessage(callId: string, content: string): Record<string, unknown> {
  return { role: 'tool', content, toolCallId: callId, toolName: 'researcher_market' };
}

/** 一回合都在飞（含本回合工具结果）——引擎侧看到的上一轮形状。 */
function settledMessages(callId: string, content: string): Array<Record<string, any>> {
  return [
    { role: 'user', content: '帮我调研' },
    { role: 'assistant', content: '', toolCalls: [{ id: callId, index: 0, function: { name: 'researcher_market', arguments: '{}' } }] },
    delegationToolMessage(callId, content),
  ];
}

/** 把四通道的「产出在场」初态摆好（调用方随后触发剔除）。 */
function withFourChannelsPresent(chat: Record<string, any>): void {
  chat.agentActivities = [
    { callId: CALL, agentName: AGENT, agentRole: '市场调研', status: 'done', inputSnippet: SNIPPET, output: ORIGINAL_OUTPUT },
  ];
  chat.messages = settledMessages(CALL, ORIGINAL_OUTPUT);
  chat.preCompactedMessages = [{ role: 'system', content: 'Earlier conversation summary: …' }, ...chat.messages];
  chat.preCompactSourceMessages = [...chat.messages];
  chat.sessionLedger = recordDone(createSessionLedger(), {
    ts: 1,
    intent: `delegate:${AGENT}`,
    args: SNIPPET,
    ok: true,
    summary: ORIGINAL_OUTPUT,
  });
  let script: TaskScript = createTaskScript(PLAN);
  script = applyTaskScriptSignal(script, { kind: 'delegation', toolName: 'researcher_market', ok: true, summary: ORIGINAL_OUTPUT, callId: CALL });
  chat.activeTaskScript = script;
}

// ── 编排器判定面：真 InterjectOrchestrator + 受控假宿主缝 ────────────────────

interface OrchestratorSpies {
  registered: Array<{ callId: string; topic: string }>;
  stripped: string[];
  settleAcks: Array<string | null>;
  folds: Array<{ cancels: boolean; stopMissed?: boolean }>;
  steers: Array<{ target: SteerTarget; cancel: boolean }>;
  cancels: string[];
}

function steerCancelDecision(extra: Record<string, unknown> = {}): DynamicInsertionDecision {
  return {
    source: 'mid-run-insert',
    verdict: 'inline',
    kind: 'steer',
    action: 'apply',
    confidence: 1,
    timing: { mode: 'now' },
    scope: ['constraints'],
    shouldAbort: false,
    reason: 'test',
    // 三值契约（A 刀）：取消话的宿主信号 = verdict inline + 裁决器点名的
    // stopBranchCallId——宿主只核实执行，cancelsPart 不再过河。
    signals: { stopBranchCallId: CALL, ...extra },
  };
}

function makeOrchestratorFace(opts: {
  decision: DynamicInsertionDecision;
  settled: InFlightBranch[];
  stripResult?: boolean;
  hasDelegationInFlight?: boolean;
  atAggregationWindow?: boolean;
}): { orchestrator: InterjectOrchestrator; spies: OrchestratorSpies } {
  const spies: OrchestratorSpies = { registered: [], stripped: [], settleAcks: [], folds: [], steers: [], cancels: [] };
  const deps = {
    decider: { decide: async () => opts.decision } as unknown as DynamicInsertionCoordinator,
    delegation: { registerCancel: (text: string) => { spies.cancels.push(text); } } as unknown as DelegationControlPlane,
    roundClose: { holdInsert: () => {}, scheduleDispatch: () => {} } as unknown as RoundClosePlane,
    isStreaming: () => true,
    isAborted: () => false,
    decideSignal: () => undefined,
    decideLlm: () => null,
    insertionContext: () => '',
    hasDelegationInFlight: () => opts.hasDelegationInFlight === true,
    runningBranches: () => [],
    stoppedBranches: () => [],
    coveringCandidates: () => [],
    settledBranches: () => opts.settled,
    stripSettledBranchOutput: (callId: string) => { spies.stripped.push(callId); return opts.stripResult !== false; },
    registerStrippedBranch: (callId: string, topic: string) => { spies.registered.push({ callId, topic }); },
    branchLabel: (name: string) => name,
    atAggregationWindow: () => opts.atAggregationWindow === true,
    probeResume: () => ({ hit: false, turns: 0 }),
    send: () => {},
    abort: () => {},
    stopBranchByCallId: () => null,
    steerRunningTurn: (_text: string, _images: MessageImage[], _ack: InterjectAck, target: SteerTarget, cancel: boolean) => {
      spies.steers.push({ target, cancel });
    },
    queueInterjectTask: () => {},
    foldInScopeAddition: (_text: string, _images: MessageImage[], _displayText: string, _mechanical: boolean, _ack: InterjectAck, cancels: boolean, stopMissed?: boolean) => {
      spies.folds.push({ cancels, stopMissed });
    },
    answerMidrunQuestion: async () => {},
    askMidrunClarification: async () => {},
    deferTimedInsert: () => false,
    createAck: () => ({}),
    settleAck: (_ack: InterjectAck, text: string | null) => { spies.settleAcks.push(text); },
    discardAckRow: () => {},
    echoUser: () => {},
    logDecision: () => {},
  } as unknown as InterjectOrchestratorDeps;
  return { orchestrator: new InterjectOrchestrator(deps), spies };
}

const DONE_BRANCH: InFlightBranch = { callId: CALL, name: AGENT, role: '市场调研', snippet: SNIPPET };

// ── 全域注册 happy-dom（localStorage 是 store 落盘的前提） ────────────────────

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
beforeEach(() => {
  localStorage.clear();
});

describe('缺口②机械排除 · 第 0 步推断判例', () => {
  it('推断1 证实：同回合 settle 的支，其 tool 消息尚未进 this.messages —— strip 找不到（空转）', () => {
    const chat = makeChat();
    // 同回合：支已 settle（agentActivities 有 status=done），引擎在流。
    chat.agentActivities = [
      { callId: CALL, agentName: AGENT, status: 'done', inputSnippet: SNIPPET, output: ORIGINAL_OUTPUT },
    ];
    // 本回合还没收尾：this.messages 不含本回合的 tool 结果。
    chat.messages = [{ role: 'user', content: '帮我调研' }];
    expect(chat.stripSettledBranchOutput(CALL)).toBe(false);
  });

  it('推断1 对称面：上一回合 settle 的支，tool 消息已在 this.messages —— strip 命中', () => {
    const chat = makeChat();
    chat.agentActivities = [
      { callId: CALL, agentName: AGENT, status: 'done', inputSnippet: SNIPPET, output: ORIGINAL_OUTPUT },
    ];
    chat.messages = settledMessages(CALL, ORIGINAL_OUTPUT);
    expect(chat.stripSettledBranchOutput(CALL)).toBe(true);
    expect(chat.messages.find((m: any) => m.toolCallId === CALL).content).toBe(settledBranchCancelNote());
  });

  it('推断2 修正：剔除→落盘→reload，委派工具行 resultText 仍是原始产出（不被墓碑顶替）', async () => {
    const chat = makeChat();
    chat.sessionId = 'step0-inference2';
    withFourChannelsPresent(chat);
    expect(chat.stripSettledBranchOutput(CALL)).toBe(true);
    // 落盘：toolResults 里没有该 callId（新回合/重放），兜底曾取 m.content = 墓碑。
    await chat.persistSession(chat.messages, new Map(), [], 'step0-inference2', '');
    const loaded = await loadSession('step0-inference2');
    const toolEntry = loaded?.snapshot.transcript.find((e: any) => e.toolCallId === CALL);
    expect(toolEntry?.toolExec?.resultText).toBe(ORIGINAL_OUTPUT);
  });
});

describe('A · 编排器判定：收工支被点名取消才登记/剔除', () => {
  it('非整理窗（委派不在飞）：命中已收工支即登记 + 即时剔除；收执沉默（刀 2）', async () => {
    const { orchestrator, spies } = makeOrchestratorFace({
      decision: steerCancelDecision(),
      settled: [DONE_BRANCH],
      hasDelegationInFlight: false,
      atAggregationWindow: false,
    });
    await orchestrator.interject(TOPIC);
    expect(spies.registered).toEqual([{ callId: CALL, topic: TOPIC }]);
    expect(spies.stripped).toEqual([CALL]);
    // 非整理窗的取消臂：转达父引擎（parent, cancel=true），不折入。
    expect(spies.steers).toEqual([{ target: 'parent', cancel: true }]);
    expect(spies.folds).toHaveLength(0);
    // 2026-10-28 刀 2：收执 = 裁决器现场 receipt 唯一来源——decision 无
    // receipt 时引擎沉默（settleAck null 退场），固定句「这项不做了」已废。
    expect(spies.settleAcks[0]).toBeNull();
  });

  it('整理窗（委派已收齐、汇总未完）：同样登记 + 即时剔除，且折入汇聚轮（cancels=true）', async () => {
    const { orchestrator, spies } = makeOrchestratorFace({
      decision: steerCancelDecision(),
      settled: [DONE_BRANCH],
      hasDelegationInFlight: false,
      atAggregationWindow: true,
    });
    await orchestrator.interject(TOPIC);
    expect(spies.registered).toEqual([{ callId: CALL, topic: TOPIC }]);
    expect(spies.stripped).toEqual([CALL]);
    expect(spies.folds).toEqual([{ cancels: true, stopMissed: false }]);
  });

  it('候选面只认已收工（done）：暂停/停止/在飞的支不入 settledBranches', () => {
    const chat = makeChat();
    chat.agentActivities = [
      { callId: 'done-1', agentName: 'A', status: 'done', inputSnippet: 'x' },
      { callId: 'running-1', agentName: 'B', status: 'running', inputSnippet: 'y' },
      { callId: 'paused-1', agentName: 'C', status: 'paused', inputSnippet: 'z' },
      { callId: 'cancelled-1', agentName: 'D', status: 'cancelled', inputSnippet: 'w' },
      { callId: 'failed-1', agentName: 'E', status: 'failed', inputSnippet: 'v' },
    ];
    const deps = (chat.interjectOrchestrator as any).deps as { settledBranches: () => InFlightBranch[] };
    expect(deps.settledBranches().map((b) => b.callId)).toEqual(['done-1']);
  });

  it('打平/认不出：点名与两支各中一词（打平）时不登记也不剔除——宁可漏剔不误剔', async () => {
    const { orchestrator, spies } = makeOrchestratorFace({
      decision: steerCancelDecision(),
      settled: [
        { callId: 'c1', name: 'alpha', role: '定价', snippet: '定价' },
        { callId: 'c2', name: 'beta', role: '份额', snippet: '份额' },
      ],
      hasDelegationInFlight: false,
      atAggregationWindow: false,
    });
    await orchestrator.interject('定价 份额 不用查了');
    expect(spies.registered).toHaveLength(0);
    expect(spies.stripped).toHaveLength(0);
  });

  it('剔除落空（返回 false）不预支「已剔除」：收执同样沉默，且不含机制词', async () => {
    const base = {
      decision: steerCancelDecision(),
      settled: [DONE_BRANCH],
      hasDelegationInFlight: false,
      atAggregationWindow: false,
    };
    const hit = makeOrchestratorFace({ ...base, stripResult: true });
    const miss = makeOrchestratorFace({ ...base, stripResult: false });
    await hit.orchestrator.interject(TOPIC);
    await miss.orchestrator.interject(TOPIC);
    // 收执不随剔除成败改变——裁决器无 receipt 时两头都沉默（刀 2：宁可无话
    // 不出机械腔，机制状态由登记/剔除的账呈现）。
    expect(hit.spies.settleAcks[0]).toBeNull();
    expect(miss.spies.settleAcks[0]).toBeNull();
    // 登记照在（登记与即时剔除解耦，回合收尾/下一轮装配兜底兑现）。
    expect(miss.spies.registered).toEqual([{ callId: CALL, topic: TOPIC }]);
    expect(miss.spies.stripped).toEqual([CALL]);
  });
});

describe('B · 四通道整体离场，渲染通道不动', () => {
  it('① this.messages：那路工具结果换墓碑；渲染留底记下原始产出', () => {
    const chat = makeChat();
    withFourChannelsPresent(chat);
    expect(chat.stripSettledBranchOutput(CALL)).toBe(true);
    const tool = chat.messages.find((m: any) => m.toolCallId === CALL);
    expect(tool.content).toBe(settledBranchCancelNote());
    expect(chat.strippedBranchOriginals.get(CALL)).toBe(ORIGINAL_OUTPUT);
  });

  it('② 预压实窗作废：preCompactedMessages 与 preCompactSourceMessages 一并清空', () => {
    const chat = makeChat();
    withFourChannelsPresent(chat);
    expect(chat.preCompactedMessages).not.toBeNull();
    chat.stripSettledBranchOutput(CALL);
    expect(chat.preCompactedMessages).toBeNull();
    expect(chat.preCompactSourceMessages).toBeNull();
  });

  it('③ 会话账本 done：delegate:<agent> 那笔「已做」条目随产出摘掉', () => {
    const chat = makeChat();
    withFourChannelsPresent(chat);
    expect(chat.sessionLedger.done).toHaveLength(1);
    chat.stripSettledBranchOutput(CALL);
    expect(chat.sessionLedger.done).toHaveLength(0);
  });

  it('④ 剧本委派摘要：按 callId 撤掉那条委派，收尾素材不再带支产出', () => {
    const chat = makeChat();
    withFourChannelsPresent(chat);
    expect(taskScriptHandOver(chat.getTaskScript()!).steps[0].evidence.delegations).toHaveLength(1);
    chat.stripSettledBranchOutput(CALL);
    const evidence = taskScriptHandOver(chat.getTaskScript()!).steps[0].evidence;
    expect(evidence.delegations).toHaveLength(0);
    expect(evidence.delegationCount).toBe(0);
  });

  it('渲染通道未动：agentActivities.output 原样；toolRowRenderText 取回原始产出而非墓碑', () => {
    const chat = makeChat();
    withFourChannelsPresent(chat);
    chat.stripSettledBranchOutput(CALL);
    expect(chat.agentActivities[0].output).toBe(ORIGINAL_OUTPUT);
    expect(chat.toolRowRenderText(CALL, settledBranchCancelNote())).toBe(ORIGINAL_OUTPUT);
  });
});

describe('C · 时序：同回合/迟到/缺账都在装配点兑现', () => {
  it('同回合 settle：即时剔除落空（false），回合收尾 applyStrippedBranches 补剔', () => {
    const chat = makeChat();
    chat.agentActivities = [
      { callId: CALL, agentName: AGENT, status: 'done', inputSnippet: SNIPPET, output: ORIGINAL_OUTPUT },
    ];
    // 取消那一刻本回合工具结果还没进账。
    chat.messages = [{ role: 'user', content: '帮我调研' }];
    chat.registerStrippedBranch(CALL, TOPIC);
    expect(chat.stripSettledBranchOutput(CALL)).toBe(false);
    // 回合收尾：本回合消息 merge 进来，补剔把这路换成墓碑。
    const finalMessages = settledMessages(CALL, ORIGINAL_OUTPUT);
    chat.applyStrippedBranches(finalMessages);
    expect(finalMessages.find((m: any) => m.toolCallId === CALL)?.content).toBe(settledBranchCancelNote());
    expect(chat.strippedBranchOriginals.get(CALL)).toBe(ORIGINAL_OUTPUT);
  });

  it('迟到结果：登记时无消息，装配期按 callId 补剔', () => {
    const chat = makeChat();
    chat.registerStrippedBranch(CALL, TOPIC);
    const late = settledMessages(CALL, ORIGINAL_OUTPUT);
    chat.applyStrippedBranches(late);
    expect(late.find((m: any) => m.toolCallId === CALL)?.content).toBe(settledBranchCancelNote());
  });

  it('缺账/认不出：applyStrippedBranches 对空消息与无候选不抛、不误剔', () => {
    const chat = makeChat();
    chat.agentActivities = [];
    chat.registerStrippedBranch('call_gone', '一个对不上的话题');
    const other = [{ role: 'tool', content: '别的东西', toolCallId: 'call_other', toolName: 'x' }];
    expect(() => chat.applyStrippedBranches(other)).not.toThrow();
    expect(other[0].content).toBe('别的东西');
    // 空集短路不误伤。
    chat.applyStrippedBranches([]);
    expect(chat.strippedBranchIds.has('call_gone')).toBe(true);
  });

  it('装配期二次匹配：点名原文命中其后才收工的支（迟到），登记并补剔', () => {
    const chat = makeChat();
    chat.agentActivities = [
      { callId: 'call_late', agentName: AGENT, agentRole: '市场调研', status: 'done', inputSnippet: SNIPPET, output: ORIGINAL_OUTPUT },
    ];
    // 登记的是另一个（已不在册的）id，点名原文仍可命中已收工面。
    chat.registerStrippedBranch('call_stale', TOPIC);
    const messages = settledMessages('call_late', ORIGINAL_OUTPUT);
    chat.applyStrippedBranches(messages);
    expect(chat.strippedBranchIds.has('call_late')).toBe(true);
    expect(messages.find((m: any) => m.toolCallId === 'call_late')?.content).toBe(settledBranchCancelNote());
  });
});

describe('D · 渲染通道隔离与持久化往返', () => {
  it('剔除→落盘→reload：离场账随快照回来，装配侧继续剔除残留', async () => {
    const chat = makeChat();
    chat.sessionId = 'd-roundtrip';
    withFourChannelsPresent(chat);
    chat.registerStrippedBranch(CALL, TOPIC);
    chat.stripSettledBranchOutput(CALL);
    await chat.persistSession(chat.messages, new Map(), [], 'd-roundtrip', '');
    const loaded = await loadSession('d-roundtrip');
    expect(loaded?.snapshot.uiState.strippedBranchIds).toEqual([CALL]);
    expect(loaded?.snapshot.uiState.strippedBranchTopics).toEqual([TOPIC]);

    const restored = makeChat();
    restored.loadFromStorage(loaded!.snapshot);
    expect(restored.strippedBranchIds.has(CALL)).toBe(true);
    // 通道③/④ 残留不复活：reload 后重放摘账。
    expect(restored.sessionLedger.done).toHaveLength(0);
    const evidence = taskScriptHandOver(restored.getTaskScript() ?? createTaskScript(PLAN)).steps[0].evidence;
    expect(evidence.delegations).toHaveLength(0);
  });

  it('reload 后留底从已持久化 toolExec 回灌：再次落盘不回退成墓碑', async () => {
    const first = makeChat();
    first.sessionId = 'd-rehydrate';
    withFourChannelsPresent(first);
    first.stripSettledBranchOutput(CALL);
    await first.persistSession(first.messages, new Map(), [], 'd-rehydrate', '');
    const loaded = await loadSession('d-rehydrate');
    // 第一次落盘已经是原始产出（修推断2）。
    expect(loaded?.snapshot.transcript.find((e: any) => e.toolCallId === CALL)?.toolExec?.resultText).toBe(ORIGINAL_OUTPUT);

    const restored = makeChat();
    restored.loadFromStorage(loaded!.snapshot);
    expect(restored.toolRowRenderText(CALL, settledBranchCancelNote())).toBe(ORIGINAL_OUTPUT);
    // 二次落盘仍走空 toolResults 兜底（最易泄漏的路径），不得回落墓碑。
    await restored.persistSession(restored.messages, new Map(), [], 'd-rehydrate', '');
    const reloaded = await loadSession('d-rehydrate');
    expect(reloaded?.snapshot.transcript.find((e: any) => e.toolCallId === CALL)?.toolExec?.resultText).toBe(ORIGINAL_OUTPUT);
  });
});
