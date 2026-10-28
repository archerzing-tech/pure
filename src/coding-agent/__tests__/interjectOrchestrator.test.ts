// src/coding-agent/__tests__/interjectOrchestrator.test.ts
// 三臂契约（2026-10-28 刀 B，docs/interjection-inline-sideline.md）：判定三值化
// （A 刀）后宿主不再替模型做语义细分——inline 原话直投（点名停支/续支/整树停
// 三个机械信号仍先消费，思考流在飞掐流重入）、sideline 旁答、new_task 排队
// （撞车先复核）。宿主缝全部假体注入——决策核不猜宿主状态，这里同时验证缝
// 的调用形状。退役面（holdGate 软暂停闸/真暂停押账、selfCheckDrift 自查、
// mixed 原子拆分）在「退役负向锁」describe 里锁死不回流。

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  InterjectOrchestrator,
  type InterjectOrchestratorDeps,
  type CoveringBranch,
} from '../interjectOrchestrator';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import type { CoveredRecheckVerdict, InsertionClassification } from '../Planner';
import type { DelegationControlPlane } from '../delegationControl';
import type { RoundClosePlane } from '../roundClosePlane';
import type { InFlightBranch, SteerTarget } from '../../shared/steerTargeting';
import { branchResumeReceipt, branchUncertainPauseReceipt } from '../../shared/insertionMessaging';
import type { LLMAdapter, Message, MessageImage } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

interface SteerRecord { text: string; target: SteerTarget; cancel: boolean; receipt: string | undefined }
interface FoldRecord { cancels: boolean; stopMissed?: boolean; receipt?: string }

interface Harness {
  deps: InterjectOrchestratorDeps;
  classifyWith: (verdict: InsertionClassification) => void;
  recheckWith: (verdict: CoveredRecheckVerdict | null) => void;
  holds: {
    holdInsert: number; scheduleDispatch: number; abortReasons: string[]; reenters: number;
    stops: Array<{ callId: string; mode: string }>;
    steers: SteerRecord[]; queued: Array<{ text: string; priority?: number }>;
    folds: FoldRecord[]; answers: string[]; clarifies: number;
    registers: string[]; stripped: number; settleAcks: Array<string | null>;
    discards: number; echoes: number; deferred: number; sends: string[]; resumes: number;
  };
  setStreaming: (v: boolean) => void;
  setDelegation: (v: boolean) => void;
  setThinking: (v: boolean) => void;
  setAborted: (v: boolean) => void;
  setDefer: (v: boolean) => void;
  setRunning: (b: InFlightBranch[]) => void;
  setStopped: (b: InFlightBranch[]) => void;
  setCovering: (b: CoveringBranch[]) => void;
  selfCheckCount: () => number;
}

function makeHarness(): Harness {
  // 判词注桩：三值契约的最小合法形态（A 刀解析只认 verdict/reason/confidence
  // + 可选 action/stop_branch/resumes_branch/branch_call_id/receipt）。
  let verdict: InsertionClassification = { verdict: 'inline', reason: '', confidence: 1 };
  let recheck: CoveredRecheckVerdict | null = null;
  let streaming = true;
  let delegation = false;
  let thinkingActive = false;
  let aborted = false;
  let defer = false;
  let running: InFlightBranch[] = [];
  let stopped: InFlightBranch[] = [];
  let covering: CoveringBranch[] = [];
  const decider = new DynamicInsertionCoordinator({
    classify: async () => verdict,
    recheckCoveredInsertion: async () => recheck,
  });
  // 自查退役监视器（方法本体已随 D 刀删除）：实例桩影子仍挂着——若将来
  // 有人把自查链加回来并被任何臂调用，计数翻红。
  let selfCheckCalls = 0;
  (decider as unknown as { selfCheckDrift: () => unknown }).selfCheckDrift = () => {
    selfCheckCalls += 1;
    return null;
  };
  const delegationArgs = new Map<string, { name: string; args: string }>([
    ['call_p1', { name: '暂停支', args: '{}' }],
  ]);
  const holds = {
    holdInsert: 0, scheduleDispatch: 0, abortReasons: [] as string[], reenters: 0,
    stops: [] as Array<{ callId: string; mode: string }>,
    steers: [] as SteerRecord[], queued: [] as Array<{ text: string; priority?: number }>,
    folds: [] as FoldRecord[], answers: [] as string[], clarifies: 0,
    registers: [] as string[], stripped: 0, settleAcks: [] as Array<string | null>,
    discards: 0, echoes: 0, deferred: 0, sends: [] as string[], resumes: 0,
  };
  const deps: InterjectOrchestratorDeps = {
    decider,
    delegation: {
      registerCancel: (text: string) => { holds.registers.push(text); },
      delegationArgs,
      queueResume: () => { holds.resumes += 1; return true; },
    } as unknown as DelegationControlPlane,
    isStreaming: () => streaming,
    isAborted: () => aborted,
    decideSignal: () => undefined,
    decideLlm: () => llm(),
    insertionContext: () => 'ctx',
    hasDelegationInFlight: () => delegation,
    runningBranches: () => running,
    stoppedBranches: () => stopped,
    coveringCandidates: () => covering,
    settledBranches: () => [],
    stripSettledBranchOutput: () => false,
    registerStrippedBranch: (callId) => { holds.registers.push(callId); },
    branchLabel: (name) => name,
    atAggregationWindow: () => false,
    probeResume: () => ({ hit: true, turns: 3 }),
    // 嘴/手分开（细化 1）：思考流读数与掐流重入把手都是注入缝——测试按场景
    // 拨开关，断言重入只发生在思考流在飞的那一臂。
    isThinkingStreamActive: () => thinkingActive,
    abortReenter: () => { holds.reenters += 1; },
    send: (text) => { holds.sends.push(text); },
    abort: (reason) => { holds.abortReasons.push(reason ?? ''); },
    stopBranchByCallId: (callId, mode) => {
      holds.stops.push({ callId, mode });
      return `分支-${callId}`;
    },
    steerRunningTurn: (text, _images, _ack, target, cancel, receipt) => {
      holds.steers.push({ text, target, cancel, receipt });
    },
    queueInterjectTask: (text, _images, _displayText, priority) => { holds.queued.push({ text, priority }); },
    foldInScopeAddition: (_text, _images, _displayText, _mechanical, _ack, cancels, stopMissed, receipt) => {
      holds.folds.push({ cancels, stopMissed, receipt });
    },
    answerMidrunQuestion: (text) => { holds.answers.push(text); return Promise.resolve(); },
    askMidrunClarification: async () => { holds.clarifies += 1; },
    deferTimedInsert: () => { holds.deferred += 1; return defer; },
    createAck: () => ({}) as never,
    settleAck: (_ack, text) => { holds.settleAcks.push(text); },
    discardAckRow: () => { holds.discards += 1; },
    echoUser: () => { holds.echoes += 1; },
    logDecision: () => {},
  };
  return {
    deps,
    classifyWith: (v) => { verdict = v; },
    recheckWith: (v) => { recheck = v; },
    holds,
    setStreaming: (v) => { streaming = v; },
    setDelegation: (v) => { delegation = v; },
    setThinking: (v) => { thinkingActive = v; },
    setAborted: (v) => { aborted = v; },
    setDefer: (v) => { defer = v; },
    setRunning: (b) => { running = b; },
    setStopped: (b) => { stopped = b; },
    setCovering: (b) => { covering = b; },
    selfCheckCount: () => selfCheckCalls,
  };
}

describe('InterjectOrchestrator — inline 臂（原话直投与机械信号）', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('inline 直投：思考流在飞 → steer + abortReenter 掐流重入，不落 pause 账', async () => {
    h.setThinking(true);
    await new InterjectOrchestrator(h.deps).interject('记得带上测试报告');
    expect(h.holds.steers).toEqual([
      { text: '记得带上测试报告', target: 'parent', cancel: false, receipt: undefined },
    ]);
    expect(h.holds.reenters).toBe(1); // INTERJECT_REENTER_REASON 掐流，宿主带原话重开思考
    expect(h.holds.abortReasons).toEqual([]); // 不走 pause/硬停通道
    expect(h.holds.holdInsert).toBe(0); // 真暂停押账重入已退役
  });

  it('inline 直投：工具期（思考流不在飞）不打断，等下一 THINK 边界', async () => {
    h.setThinking(false);
    await new InterjectOrchestrator(h.deps).interject('不是周三是周四');
    expect(h.holds.steers).toHaveLength(1);
    expect(h.holds.reenters).toBe(0);
  });

  it('inline 直投：委派在飞且点名 → 定向投递到那一支', async () => {
    h.setDelegation(true);
    h.setRunning([
      { callId: 'call_b1', name: 'B站调研', snippet: 'B站视频调研' },
      { callId: 'call_b2', name: '竞品份额', snippet: '竞品份额汇总' },
    ]);
    await new InterjectOrchestrator(h.deps).interject('B站调研再深挖');
    expect(h.holds.steers[0].target).toEqual({ branchCallId: 'call_b1', branchName: 'B站调研' });
    expect(h.holds.reenters).toBe(0); // 支在飞不打断
  });

  it('整树停（action:stop 高置信）：abort 一次 + settle(ack, receipt)，无 steer', async () => {
    h.classifyWith({ verdict: 'inline', reason: 'overturned', confidence: 1, action: 'stop', receipt: '收到，整棵树停了' });
    await new InterjectOrchestrator(h.deps).interject('停止');
    expect(h.holds.abortReasons).toEqual(['']); // 停是宿主唯一保留的机械动作
    expect(h.holds.settleAcks).toEqual(['收到，整棵树停了']); // 收执随裁决走
    expect(h.holds.steers).toEqual([]);
    expect(h.holds.reenters).toBe(0);
    expect(h.holds.holdInsert).toBe(0); // 停是终局，不押账重入
  });

  it('整树停低置信被门拦下：先问不做（action:stop + 置信<0.6 → clarify）', async () => {
    h.classifyWith({ verdict: 'inline', reason: 'maybe stop?', confidence: 0.4, action: 'stop' });
    await new InterjectOrchestrator(h.deps).interject('好像可以停了？');
    expect(h.holds.clarifies).toBe(1); // 问询接管 ack（呈现层：无占位系统话）
    expect(h.holds.abortReasons).toEqual([]); // 问必须先于拆
    expect(h.holds.steers).toEqual([]);
  });

  it('passthrough（裁决器倒下）直投：低置信 inline 非 destructive，原话照投不问', async () => {
    // classify 兜底形态（fallbackUsed）→ 协调器折 passthrough（inline/0.3/
    // via=passthrough）→ 置信门降级 clarify 但 gatedFrom='apply' 非 destructive
    // → 宿主直投：话绝不因没有裁决器而失踪，也不拿问题烦人。
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, fallbackUsed: true });
    await new InterjectOrchestrator(h.deps).interject('随便补充一句');
    expect(h.holds.steers).toHaveLength(1);
    expect(h.holds.clarifies).toBe(0);
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('点名停支（在飞）：宿主按 call_id 真停（mode=pause），收执随 receipt', async () => {
    h.classifyWith({
      verdict: 'inline', reason: 'user cancelled one branch', confidence: 1,
      stopBranch: { callId: 'call_b1' }, receipt: '好，B站那支先停了',
    });
    h.setDelegation(true);
    h.setRunning([{ callId: 'call_b1', name: 'B站调研', snippet: 'B站视频调研' }]);
    await new InterjectOrchestrator(h.deps).interject('B站那支别查了');
    expect(h.holds.stops).toEqual([{ callId: 'call_b1', mode: 'pause' }]);
    expect(h.holds.settleAcks).toEqual(['好，B站那支先停了']);
    expect(h.holds.steers).toEqual([]);
    expect(h.holds.folds).toHaveLength(0);
  });

  it('点名停支指认不在花名册：退回取消折入（stopMissed=true），绝不停别的支', async () => {
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, stopBranch: { callId: 'call_x' } });
    h.setDelegation(true);
    await new InterjectOrchestrator(h.deps).interject('B站那支别查了');
    expect(h.holds.stops).toHaveLength(0); // 核实不过不执行
    expect(h.holds.registers).toHaveLength(1); // 起飞闸挂号
    expect(h.holds.folds).toEqual([{ cancels: true, stopMissed: true, receipt: undefined }]);
  });

  it('点名续支：同参重派排队，收执 checkpoint 诚实二分', async () => {
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, resumesBranch: { callId: 'call_p1' } });
    h.setStopped([{ callId: 'call_p1', name: '暂停支', snippet: '' }]);
    await new InterjectOrchestrator(h.deps).interject('刚才那支接着跑');
    expect(h.holds.resumes).toBe(1);
    expect(h.holds.settleAcks).toEqual([
      branchResumeReceipt('暂停支', { hit: true, turns: 3 }, false),
    ]);
    expect(h.holds.steers).toHaveLength(0);
  });

  it('点名续支核实不过（id 不在停止面）：按普通插话照常路由', async () => {
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, resumesBranch: { callId: 'call_none' } });
    await new InterjectOrchestrator(h.deps).interject('刚才那支接着跑');
    expect(h.holds.resumes).toBe(0);
    expect(h.holds.steers).toHaveLength(1); // 落回原话直投
  });

  it('覆盖去重核实不过（branchCallId 不在覆盖面）：照常直投，绝不拿错的支回「不重复」', async () => {
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, branchCallId: 'call_wrong' });
    await new InterjectOrchestrator(h.deps).interject('调研必须包括优酷');
    expect(h.holds.settleAcks).toHaveLength(0);
    expect(h.holds.steers).toHaveLength(1);
  });

  it('思考窗吸收：窗开 + inline 无信号 → 入暂存等并账，不转达不掐主流', async () => {
    const orch = new InterjectOrchestrator(h.deps);
    orch.openPreflightWindow();
    await orch.interject('再补一条约束');
    expect(h.holds.steers).toEqual([]);
    expect(orch.pendingPreflightCount()).toBe(1);
    expect(h.holds.settleAcks).toEqual(['已并入补充，重新规划…']);
    expect(h.holds.reenters).toBe(0);
    expect(h.holds.abortReasons).toEqual([]);
    orch.closePreflightWindow();
  });

  it('吸收集合封闭：窗开 + sideline/new_task 照走原臂，绝不被吞进思考窗', async () => {
    const orch = new InterjectOrchestrator(h.deps);
    orch.openPreflightWindow();
    h.classifyWith({ verdict: 'sideline', reason: '', confidence: 1 });
    await orch.interject('现在跑到哪了？');
    expect(h.holds.answers).toEqual(['现在跑到哪了？']);
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    await orch.interject('顺便查下汇率');
    expect(h.holds.queued).toHaveLength(1);
    expect(orch.pendingPreflightCount()).toBe(0);
    orch.closePreflightWindow();
  });
});

describe('InterjectOrchestrator — sideline / new_task 臂', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('sideline：旁答管线接管 ack，零机械动作零转达', async () => {
    h.classifyWith({ verdict: 'sideline', reason: '', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('现在跑到哪了？');
    expect(h.holds.answers).toEqual(['现在跑到哪了？']);
    expect(h.holds.discards).toBe(1); // 临时行退场，答案气泡接管
    expect(h.holds.echoes).toBe(1); // 用户原话回显在先（§〇）
    expect(h.holds.steers).toEqual([]);
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('new_task：排队 + settle(ack, receipt)，干净无撞车不触复核', async () => {
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1, receipt: '好，收尾后开新轮' });
    await new InterjectOrchestrator(h.deps).interject('顺便查下汇率');
    expect(h.holds.queued).toEqual([{ text: '顺便查下汇率', priority: expect.any(Number) }]);
    expect(h.holds.settleAcks).toEqual(['好，收尾后开新轮']);
    expect(h.holds.steers).toEqual([]);
  });

  it('new_task 撞车已收工支 + 复核判取消：精确停支（verdict inline 面恢复）', async () => {
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    h.recheckWith({ cancelsPart: true, stopBranchCallId: 'call_youku', receipt: '优酷那路停了', reason: '', confidence: 0.9 });
    h.setCovering([{ callId: 'call_youku', name: '优酷调研', snippet: '优酷调研', status: 'running' }]);
    h.setDelegation(true);
    h.setRunning([{ callId: 'call_youku', name: '优酷调研', snippet: '优酷调研' }]);
    await new InterjectOrchestrator(h.deps).interject('优酷调研不用再做了');
    expect(h.holds.stops).toEqual([{ callId: 'call_youku', mode: 'pause' }]);
    expect(h.holds.settleAcks).toEqual(['优酷那路停了']); // 收执取复核现场那份
    expect(h.holds.queued).toHaveLength(0); // 取消绝不当活排队
  });

  it('new_task 撞车在飞支 + 复核没结论：选可逆的一边，暂停那支如实交代', async () => {
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    h.recheckWith(null);
    h.setCovering([{ callId: 'call_youku', name: '优酷调研', snippet: '优酷调研', status: 'running' }]);
    await new InterjectOrchestrator(h.deps).interject('优酷调研不用再做了');
    expect(h.holds.stops).toEqual([{ callId: 'call_youku', mode: 'pause' }]);
    expect(h.holds.settleAcks).toEqual([branchUncertainPauseReceipt('优酷调研')]);
  });

  it('new_task 撞车 + 复核明确判加活：「不重复派」终稿', async () => {
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    h.recheckWith({ cancelsPart: false, reason: 'adds a new deliverable', confidence: 0.9 });
    h.setCovering([{ callId: 'call_youku', name: '优酷调研', snippet: '优酷调研', status: 'running' }]);
    await new InterjectOrchestrator(h.deps).interject('调研必须包括优酷');
    expect(h.holds.stops).toHaveLength(0);
    expect(h.holds.queued).toHaveLength(0);
    expect(h.holds.settleAcks).toEqual([
      '您说的这个正在「优酷调研」那路跑着，不重复派——收齐后一并汇总给您。',
    ]);
  });

  it('输入自带执行时刻（timing at）：交排期 sink，不进任何臂', async () => {
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    h.setDefer(true);
    await new InterjectOrchestrator(h.deps).interject('下午三点再查下汇率');
    expect(h.holds.deferred).toBe(1);
    expect(h.holds.discards).toBe(1);
    expect(h.holds.queued).toHaveLength(0);
    expect(h.holds.steers).toHaveLength(0);
  });

  it('判定期间硬停：不丢话，排队等下回', async () => {
    h.setAborted(true);
    await new InterjectOrchestrator(h.deps).interject('顺便查下汇率');
    expect(h.holds.queued).toHaveLength(1);
    expect(h.holds.discards).toBe(1);
  });

  it('not-streaming：正常 send 渲染用户气泡', async () => {
    h.setStreaming(false);
    await new InterjectOrchestrator(h.deps).interject('重新发一句');
    expect(h.holds.sends).toEqual(['重新发一句']);
  });

  it('判定链异常：收执兜底句退场，链不毒化（后续插话照常）', async () => {
    const real = h.deps.decider;
    let exploded = false;
    h.deps.decider = {
      decide: async (...args: Parameters<DynamicInsertionCoordinator['decide']>) => {
        if (!exploded) {
          exploded = true;
          throw new Error('judge exploded');
        }
        return real.decide(...args);
      },
    } as unknown as DynamicInsertionCoordinator;
    const orch = new InterjectOrchestrator(h.deps);
    await orch.interject('这句会让裁决器炸').catch(() => {});
    expect(h.holds.settleAcks).toEqual(['未能处理这句插话；请重新发送。']);
    await orch.interject('下一句正常'); // 链已恢复：判定照走，原话直投
    expect(h.holds.steers).toHaveLength(1);
  });
});

describe('InterjectOrchestrator — 退役负向锁（刀 B 清场面不回流）', () => {
  it('selfCheckDrift 零引用：任何臂的判定都不再触发自查', async () => {
    const h = makeHarness();
    const orch = new InterjectOrchestrator(h.deps);
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1 });
    await orch.interject('一句普通补充');
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, action: 'stop' });
    await orch.interject('停止');
    expect(h.selfCheckCount()).toBe(0); // 自查降级链退役（D 刀清方法本体）
    expect(h.holds.holdInsert).toBe(0);
  });

  it('truePause 押账退役：任何臂都不再 roundClose.holdInsert', async () => {
    const h = makeHarness();
    const orch = new InterjectOrchestrator(h.deps);
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1 });
    await orch.interject('一句并线补充');
    h.classifyWith({ verdict: 'inline', reason: '', confidence: 1, action: 'stop' });
    await orch.interject('停止');
    h.classifyWith({ verdict: 'new_task', reason: '', confidence: 1 });
    await orch.interject('顺便查下汇率');
    expect(h.holds.holdInsert).toBe(0); // 押账重入整体退役（abortReenter 接棒）
    expect(h.holds.scheduleDispatch).toBe(0); // 编排器不再碰回合收尾排程
  });

  it('mixed 原子拆分退役：带 atoms 的判词按 verdict 整句处置', async () => {
    const h = makeHarness();
    h.classifyWith({
      verdict: 'inline', reason: 'question + change', confidence: 1,
      atoms: [
        { relation: 'question', text: '顺便问下进度' },
        { relation: 'change', text: '方案换成B' },
      ],
    } as InsertionClassification);
    await new InterjectOrchestrator(h.deps).interject('顺便问下进度；另外方案换成B');
    expect(h.holds.steers).toHaveLength(1); // 原话全文直投，主线自己消化
    expect(h.holds.answers).toEqual([]);
    expect(h.holds.queued).toEqual([]);
    expect(h.holds.abortReasons).toEqual([]); // 不再有「破坏原子接管整条」
  });

  it('holdGate / 任务状态投影 / 副作用冻结退役：deps 缝面已无这些把手', () => {
    const h = makeHarness();
    const seam = h.deps as unknown as Record<string, unknown>;
    expect('hold' in seam).toBe(false);
    expect('taskStateSnapshot' in seam).toBe(false);
    expect('freezeSideEffects' in seam).toBe(false);
    expect('stripAbortedTurnPartial' in seam).toBe(false);
  });
});
