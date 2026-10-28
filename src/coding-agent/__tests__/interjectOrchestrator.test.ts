// src/coding-agent/__tests__/interjectOrchestrator.test.ts
// 九类分发臂契约（v2 蓝图 §六）：supplement/emphasize/meta 转达不打断、
// question 旁答、unrelated 阶段感知排队、chatter 收下、correction 押账不掐
// 流、misunderstanding 自查降级、change 的整停/真暂停/任务状态拆解、mixed
// 原子分流、软暂停闸的开合与死线、思考窗吸收。宿主缝全部假体注入——决策核
// 不猜宿主状态，这里同时验证缝的调用形状。

import { describe, expect, it, beforeEach } from 'bun:test';
import { InterjectOrchestrator, type InterjectOrchestratorDeps } from '../interjectOrchestrator';
import { DynamicInsertionCoordinator } from '../DynamicInsertionCoordinator';
import { HoldGate } from '../holdGate';
import type { InsertionClassification } from '../Planner';
import type { DelegationControlPlane } from '../delegationControl';
import type { RoundClosePlane } from '../roundClosePlane';
import type { LLMAdapter, Message } from '../../shared/types';

function llm(): LLMAdapter {
  return { complete: async (_messages: Message[]) => ({ content: '' } as never) } as unknown as LLMAdapter;
}

interface Harness {
  deps: InterjectOrchestratorDeps;
  classifyWith: (verdict: InsertionClassification) => void;
  selfCheckWith: (verdict: { drifting: boolean; reason: string; confidence: number } | null) => void;
  hold: HoldGate;
  holds: { holdInsert: number; scheduleDispatch: number; abortReasons: string[]; steers: Array<{ target: unknown; cancel: boolean }>; queued: Array<{ text: string; priority?: number }>; folds: number; answers: string[]; registers: string[]; stripped: number; strippedPartial: number };
  setStreaming: (v: boolean) => void;
  setDelegation: (v: boolean) => void;
}

function makeHarness(): Harness {
  let verdict: InsertionClassification = { relation: 'supplement', reason: '', confidence: 1 };
  let selfCheck: { drifting: boolean; reason: string; confidence: number } | null = null;
  let streaming = true;
  let delegation = false;
  const decider = new DynamicInsertionCoordinator({
    classify: async () => verdict,
  });
  // 自查缝注桩：真实现的链路（checkOutputFaithfulness）另测；这里锁编排器
  // 对判词的消费纪律（drifting 才暂停 / null 降级）。
  (decider as unknown as { selfCheckDrift: () => unknown }).selfCheckDrift = () => selfCheck;
  const holds = {
    holdInsert: 0, scheduleDispatch: 0, abortReasons: [] as string[],
    steers: [] as Array<{ target: unknown; cancel: boolean }>, queued: [] as Array<{ text: string; priority?: number }>,
    folds: 0, answers: [] as string[], registers: [] as string[], stripped: 0, strippedPartial: 0,
  };
  const hold = new HoldGate();
  const deps: InterjectOrchestratorDeps = {
    decider,
    delegation: {
      registerCancel: (text: string) => { holds.registers.push(text); },
    } as unknown as DelegationControlPlane,
    roundClose: {
      holdInsert: () => { holds.holdInsert += 1; },
      scheduleDispatch: () => { holds.scheduleDispatch += 1; },
    } as unknown as RoundClosePlane,
    isStreaming: () => streaming,
    isAborted: () => false,
    decideSignal: () => undefined,
    decideLlm: () => llm(),
    insertionContext: () => 'ctx',
    hasDelegationInFlight: () => delegation,
    runningBranches: () => [],
    stoppedBranches: () => [],
    coveringCandidates: () => [],
    settledBranches: () => [],
    stripSettledBranchOutput: () => false,
    registerStrippedBranch: (callId) => { holds.registers.push(callId); },
    branchLabel: (name) => name,
    atAggregationWindow: () => false,
    probeResume: () => ({ hit: false, turns: 0 }),
    hold,
    taskStateSnapshot: () => null,
    freezeSideEffects: () => [],
    stripAbortedTurnPartial: () => { holds.strippedPartial += 1; },
    send: () => {},
    abort: (reason) => { holds.abortReasons.push(reason ?? ''); },
    stopBranchByCallId: () => '竞品调研',
    steerRunningTurn: (_text, _images, _ack, target, cancel) => { holds.steers.push({ target, cancel }); },
    queueInterjectTask: (text, _images, _displayText, priority) => { holds.queued.push({ text, priority }); },
    foldInScopeAddition: () => { holds.folds += 1; },
    answerMidrunQuestion: (text) => { holds.answers.push(text); return Promise.resolve(); },
    askMidrunClarification: async () => {},
    deferTimedInsert: () => false,
    createAck: () => ({}) as never,
    settleAck: () => {},
    discardAckRow: () => {},
    echoUser: () => {},
    logDecision: () => {},
  };
  return {
    deps,
    classifyWith: (v) => { verdict = v; },
    selfCheckWith: (v) => { selfCheck = v; },
    hold,
    holds,
    setStreaming: (v) => { streaming = v; },
    setDelegation: (v) => { delegation = v; },
  };
}

describe('InterjectOrchestrator — nine-relation arms (v2)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('supplement rides the steer channel to the parent, never aborts', async () => {
    h.classifyWith({ relation: 'supplement', reason: '', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('记得带上测试报告');
    expect(h.holds.steers).toEqual([{ target: 'parent', cancel: false }]);
    expect(h.holds.abortReasons).toEqual([]);
    expect(h.holds.holdInsert).toBe(0);
  });

  it('question answers on the side channel; the turn is untouched', async () => {
    h.classifyWith({ relation: 'question', reason: '', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('现在跑到哪了？');
    expect(h.holds.answers).toEqual(['现在跑到哪了？']);
    expect(h.holds.steers).toEqual([]);
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('unrelated/new_task queues as a fresh task (no delegation in flight)', async () => {
    h.classifyWith({ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('顺便查下汇率');
    expect(h.holds.queued).toHaveLength(1);
    expect(h.holds.queued[0].text).toBe('顺便查下汇率');
    expect(h.holds.steers).toEqual([]);
  });

  it('unrelated/chatter is acknowledged with zero mechanical actions', async () => {
    h.classifyWith({ relation: 'unrelated', unrelatedKind: 'chatter', reason: '', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('哈哈 辛苦了');
    expect(h.holds.queued).toEqual([]);
    expect(h.holds.steers).toEqual([]);
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('correction rides the steer channel without tearing down the turn (押账重入但不掐流)', async () => {
    h.classifyWith({ relation: 'correction', reason: 'user fixed their own wording', confidence: 1 });
    await new InterjectOrchestrator(h.deps).interject('不是周三是周四');
    expect(h.holds.steers).toEqual([{ target: 'parent', cancel: false }]);
    expect(h.holds.abortReasons).toEqual([]);
    expect(h.holds.holdInsert).toBe(0);
  });

  it('misunderstanding pauses the run for real only after the self-check confirms drift', async () => {
    // 双重触发之二：自查确认 → 押账 + 掐流 + 半截产出清理 + 重入派发重 arm。
    h.classifyWith({ relation: 'misunderstanding', reason: 'asked for price, got cost', confidence: 1, selfCheckNeeded: true });
    h.selfCheckWith({ drifting: true, reason: '报告在算成本', confidence: 0.9 });
    await new InterjectOrchestrator(h.deps).interject('不是这个意思——我要的是价格');
    expect(h.holds.holdInsert).toBe(1); // 押账：原话重入
    expect(h.holds.abortReasons).toEqual(['']); // 无委派 → 裸 abort
    expect(h.holds.strippedPartial).toBe(1); // 半截输出清理
    // 回合仍在流式 → 迟到判定兜底不重 arm（只有裁决期间已收尾才需要）。
    expect(h.holds.scheduleDispatch).toBe(0);
    // 软暂停闸以 paused 收束（真暂停链走了）。
    expect(h.hold.lastOutcome()).toBe('paused');
  });

  it('misunderstanding degrades to a steer when the self-check cannot confirm', async () => {
    h.classifyWith({ relation: 'misunderstanding', reason: '', confidence: 1, selfCheckNeeded: true });
    h.selfCheckWith(null); // 自查链路坏了
    await new InterjectOrchestrator(h.deps).interject('好像理解错了');
    expect(h.holds.steers).toEqual([{ target: 'parent', cancel: false }]);
    expect(h.holds.abortReasons).toEqual([]);
    expect(h.holds.holdInsert).toBe(0);
  });

  it('judged whole-run stop (action:"stop") ends the turn without a held re-entry (刀 1)', async () => {
    // 字面停快路径已删（2026-10-28 刀 1）：整树停也是裁决器的判定——契约
    // action:"stop" 随判词来，协调器压成整停落点，编排器走 changeArm 的
    // stop 臂收尾。
    h.classifyWith({ relation: 'change', reason: 'overturned', confidence: 1, action: 'stop' });
    await new InterjectOrchestrator(h.deps).interject('停止');
    expect(h.holds.abortReasons).toHaveLength(1);
    expect(h.holds.holdInsert).toBe(0); // 停是终局，不押账重入
    expect(h.holds.steers).toEqual([]);
  });

  it('change without targets runs the true-pause chain: hold insert, abort (PAUSE under delegation), strip partial', async () => {
    h.classifyWith({ relation: 'change', reason: 'overturned', confidence: 1 });
    h.setDelegation(true);
    await new InterjectOrchestrator(h.deps).interject('整个方向换成B方案');
    expect(h.holds.holdInsert).toBe(1);
    expect(h.holds.abortReasons).toEqual(['pure:pause']); // PAUSE 存档口径
    expect(h.holds.strippedPartial).toBe(1);
    expect(h.hold.lastOutcome()).toBe('paused');
  });

  it('change with targetsConstraint consults the task state: pending work is intercepted, not paused', async () => {
    h.classifyWith({ relation: 'change', reason: 'condition replaced', confidence: 1, targetsConstraint: '从广东出发' });
    h.deps.taskStateSnapshot = () => ({
      nodes: [
        { id: 's1', title: '查广东路线', state: 'done', dependsOn: [], origin: 'plan' },
        { id: 's2', title: '订广东酒店', state: 'pending', dependsOn: ['s1'], origin: 'plan' },
      ],
      constraints: [
        { id: 'c1', text: '从广东出发', source: 'user', status: 'active', attachedNodes: ['s1', 's2'] },
      ],
      sideEffects: [],
      safetyMarks: [],
    });
    await new InterjectOrchestrator(h.deps).interject('其实我在西安，不是广东');
    // 有 done 节点但宿主无副作用台账（freeze 返回空）→ 只有 pending 拦截 +
    // 转达；不做整树暂停（影响已机械圈定）。
    expect(h.holds.abortReasons).toEqual([]);
    expect(h.holds.holdInsert).toBe(0);
    expect(h.holds.registers).toHaveLength(1); // 起飞闸挂号
    expect(h.holds.steers).toHaveLength(1);
    expect(h.holds.steers[0].cancel).toBe(true);
  });

  it('change the state projection cannot locate falls back to the true pause (宁停不猜)', async () => {
    h.classifyWith({ relation: 'change', reason: 'condition replaced', confidence: 1, targetsConstraint: '不存在的条件' });
    h.deps.taskStateSnapshot = () => ({
      nodes: [], constraints: [], sideEffects: [], safetyMarks: [],
    });
    await new InterjectOrchestrator(h.deps).interject('前提整个变了');
    expect(h.holds.holdInsert).toBe(1);
    expect(h.holds.abortReasons).toEqual(['']);
  });

  it('mixed with a destructive atom routes the whole message through that arm', async () => {
    h.classifyWith({
      relation: 'mixed', reason: 'question + change', confidence: 1,
      atoms: [
        { relation: 'question', text: '顺便问下进度' },
        { relation: 'change', text: '方案换成B' },
      ],
    });
    await new InterjectOrchestrator(h.deps).interject('顺便问下进度；另外方案换成B');
    expect(h.holds.abortReasons).toHaveLength(1); // change 臂接管 → 真暂停
    expect(h.holds.holdInsert).toBe(1);
    expect(h.holds.answers).toEqual([]); // 不旁答——破坏优先，整条按 change 走
  });

  it('mixed without destructive atoms fans out: steer the whole text, queue and answer the atoms', async () => {
    h.classifyWith({
      relation: 'mixed', reason: 'task + question', confidence: 1,
      atoms: [
        { relation: 'unrelated', text: '查下汇率' },
        { relation: 'question', text: '现在哪步了' },
        { relation: 'supplement', text: '记得带图表' },
      ],
    });
    await new InterjectOrchestrator(h.deps).interject('查下汇率；顺便问下现在哪步了；记得带图表');
    expect(h.holds.steers).toHaveLength(1); // 转达整句
    expect(h.holds.answers).toEqual(['现在哪步了']);
    expect(h.holds.queued.map((q) => q.text)).toEqual(['查下汇率']);
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('absorbs relation-bearing inserts into the thinking window when it is open', async () => {
    h.classifyWith({ relation: 'supplement', reason: '', confidence: 1 });
    const orch = new InterjectOrchestrator(h.deps);
    orch.openPreflightWindow();
    await orch.interject('再补一条约束');
    expect(h.holds.steers).toEqual([]); // 不转达——进暂存等并账
    expect(orch.pendingPreflightCount()).toBe(1);
    orch.closePreflightWindow();
  });

  it('coveredBranch dedup answers "already running" instead of re-steering (刀 F)', async () => {
    h.classifyWith({ relation: 'supplement', reason: '', confidence: 1, coveredBranch: { callId: 'call_youku' } });
    h.deps.coveringCandidates = () => [
      { callId: 'call_youku', name: '优酷调研', snippet: '', status: 'running' as const },
    ];
    await new InterjectOrchestrator(h.deps).interject('调研必须包括优酷');
    expect(h.holds.steers).toEqual([]); // 去重：不重复转达
    expect(h.holds.abortReasons).toEqual([]);
  });

  it('cancel-bearing inserts never reach the queue (反向执行防护)', async () => {
    h.classifyWith({ relation: 'unrelated', unrelatedKind: 'new_task', reason: '', confidence: 1, cancelsPart: true });
    h.setDelegation(true);
    await new InterjectOrchestrator(h.deps).interject('B站那支别查了');
    expect(h.holds.queued).toEqual([]); // 取消绝不当活排队
    expect(h.holds.folds).toBe(1); // 折入守汇报步
  });

  it('not-streaming inserts go out as a normal send', async () => {
    h.setStreaming(false);
    let sent = '';
    h.deps.send = (text) => { sent = text; };
    await new InterjectOrchestrator(h.deps).interject('重新发一句');
    expect(sent).toBe('重新发一句');
  });
});

describe('InterjectOrchestrator — soft-pause gate lifecycle', () => {
  it('holds from arrival to disposition: released on a steer, paused on the true-pause chain', async () => {
    const h = makeHarness();
    h.classifyWith({ relation: 'supplement', reason: '', confidence: 1 });
    const orch = new InterjectOrchestrator(h.deps);
    expect(h.hold.isOpen()).toBe(false);
    await orch.interject('一句补充');
    expect(h.hold.isOpen()).toBe(false);
    expect(h.hold.lastOutcome()).toBe('released');
  });

  it('a failed classification still opens the gate (finally 放行，绝不锁死)', async () => {
    const h = makeHarness();
    h.deps.decider = {
      decide: async () => { throw new Error('judge exploded'); },
      selfCheckDrift: () => null,
    } as unknown as DynamicInsertionCoordinator;
    const orch = new InterjectOrchestrator(h.deps);
    // 异常照旧向调用方传播（与 v1 相同——宿主输入端有兜底），这里只锁闸的
    // finally 放行纪律。
    await orch.interject('这句会让裁决器炸').catch(() => {});
    expect(h.hold.isOpen()).toBe(false);
    expect(h.hold.lastOutcome()).toBe('released');
  });
});
