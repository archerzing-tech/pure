import { describe, expect, it } from 'bun:test';
import {
  TaskStateStore,
  affectedByChange,
  causalDependents,
  foldTaskState,
} from '../taskState';
import type { BranchState } from '../branchLifecycle';
import type { Plan } from '../types';
import { applyTaskScriptSignals, createTaskScript } from '../../shared/taskScript';
import type { TaskScript, TaskScriptSignal } from '../../shared/taskScript';

function planWithDeps(steps: { id: string; action: string; dependsOn?: string[] }[]): Plan {
  return {
    reasoning: 'r',
    steps: steps.map((s) => ({
      id: s.id,
      action: s.action,
      description: `${s.action} desc`,
      expectedOutcome: `${s.action} done`,
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
    })),
  };
}

function script(plan: Plan, ...signals: TaskScriptSignal[]): TaskScript {
  return applyTaskScriptSignals(createTaskScript(plan), signals);
}

describe('taskState · 折算器节点状态', () => {
  const plan = planWithDeps([{ id: 'a1', action: 'A' }, { id: 'b1', action: 'B' }]);

  it('无信号全部 pending，节点 id 取 PlanStep.id（没干活不说在干）', () => {
    const snap = foldTaskState({ signals: [], plan });
    expect(snap.nodes.map((n) => [n.id, n.state, n.origin])).toEqual([
      ['a1', 'pending', 'plan'],
      ['b1', 'pending', 'plan'],
    ]);
    expect(snap.nodes.every((n) => n.dependsOn.length === 0)).toBe(true);
  });

  it('有工具活动未收束 → running；显式完成 → done；回合兜底收束也是 done', () => {
    const running = foldTaskState({
      signals: [{ kind: 'tool', toolName: 'write_file', ok: true }],
      plan,
    });
    expect(running.nodes.map((n) => n.state)).toEqual(['running', 'pending']);

    const done = foldTaskState({
      signals: [
        { kind: 'control', marker: 'phaseStart', phase: 1 },
        { kind: 'control', marker: 'phaseDone', phase: 1 },
      ],
      plan,
    });
    expect(done.nodes.map((n) => n.state)).toEqual(['done', 'pending']);

    const inferred = foldTaskState({
      signals: [{ kind: 'tool', toolName: 'write_file', ok: true }, { kind: 'turnEnd' }],
      plan,
    });
    expect(inferred.nodes.map((n) => n.state)).toEqual(['done', 'pending']);
  });

  it('planReplaced 后节点按最后一份计划重建（旧步骤节点离场）', () => {
    const refined = planWithDeps([{ id: 'x1', action: 'X' }, { id: 'y1', action: 'Y' }]);
    const snap = foldTaskState({
      signals: [{ kind: 'tool', toolName: 'write_file', ok: true }, { kind: 'planReplaced', plan: refined }],
      plan,
    });
    expect(snap.nodes.map((n) => n.id)).toEqual(['x1', 'y1']);
    expect(snap.nodes.map((n) => n.state)).toEqual(['pending', 'pending']);
  });

  it('数据依赖边从 PlanStep.dependsOn 进节点（折算不改边，只沿边传播）', () => {
    const snap = foldTaskState({
      signals: [],
      plan: planWithDeps([{ id: 'a1', action: 'A' }, { id: 'b1', action: 'B', dependsOn: ['a1'] }]),
    });
    expect(snap.nodes[1]?.dependsOn).toEqual(['a1']);
  });

  it('被撤约束的 attached 节点 → stale，且覆盖 running/done（依据失效不分新旧）', () => {
    const snap = foldTaskState({
      signals: [{ kind: 'tool', toolName: 'write_file', ok: true }],
      plan,
      constraints: [{ id: 'c:1', text: '预算 500 万', source: 'user', status: 'removed', attachedNodes: ['a1'] }],
    });
    expect(snap.nodes.map((n) => [n.id, n.state])).toEqual([['a1', 'stale'], ['b1', 'pending']]);
  });

  it('stale 沿 dependsOn 数据边向下游闭包传播；cancelled 是硬边界不被复活', () => {
    const chain = planWithDeps([
      { id: 'a1', action: 'A' },
      { id: 'b1', action: 'B', dependsOn: ['a1'] },
      { id: 'c1', action: 'C', dependsOn: ['b1'] },
    ]);
    const snap = foldTaskState({
      signals: [{ kind: 'control', marker: 'phaseDone', phase: 1 }],
      plan: chain,
      constraints: [{ id: 'c:1', text: '旧前提', source: 'user', status: 'removed', attachedNodes: ['a1'] }],
    });
    expect(snap.nodes.map((n) => [n.id, n.state])).toEqual([
      ['a1', 'stale'],
      ['b1', 'stale'],
      ['c1', 'stale'],
    ]);
  });

  it('支被 abort：委派节点 cancelled，未开工宿主步连坐取消，无关步骤不动', () => {
    const plan2 = planWithDeps([{ id: 'a1', action: 'A' }, { id: 'b1', action: 'B' }]);
    const branches: ReadonlyMap<string, BranchState> = new Map([['call-1', 'aborted']]);
    const snap = foldTaskState({
      signals: [{ kind: 'delegation', toolName: 'researcher_web', ok: true, summary: '结论', callId: 'call-1' }],
      plan: plan2,
      branches,
    });
    expect(snap.nodes.map((n) => [n.id, n.state])).toEqual([
      ['a1', 'cancelled'],
      ['b1', 'pending'],
      ['del:call-1', 'cancelled'],
    ]);
  });
});

describe('taskState · 委派支缝合（BranchState 七态缝）', () => {
  const plan = planWithDeps([{ id: 'a1', action: '调研' }]);

  it('账本落定委派成节点：branchCallId 缝合，宿主步 dependsOn 它', () => {
    const snap = foldTaskState({
      signals: [{ kind: 'delegation', toolName: 'researcher_web', ok: true, summary: '结论', callId: 'call-1' }],
      plan,
    });
    const del = snap.nodes.find((n) => n.id === 'del:call-1');
    expect(del).toMatchObject({ state: 'done', branchCallId: 'call-1', origin: 'delegation', title: 'researcher_web' });
    expect(snap.nodes[0]?.dependsOn).toContain('del:call-1');
  });

  it('branches 表覆盖账本：同支以生命周期七态为准（完成账 vs 已中止支）', () => {
    const signals: TaskScriptSignal[] = [
      { kind: 'delegation', toolName: 'researcher_web', ok: true, summary: '结论', callId: 'call-1' },
    ];
    const aborted: ReadonlyMap<string, BranchState> = new Map([['call-1', 'aborted']]);
    const paused: ReadonlyMap<string, BranchState> = new Map([['call-1', 'paused']]);
    expect(foldTaskState({ signals, plan, branches: aborted }).nodes[1]?.state).toBe('cancelled');
    // 已暂停未落定 = 活没交回来，算在飞
    expect(foldTaskState({ signals, plan, branches: paused }).nodes[1]?.state).toBe('running');
  });

  it('账本口径：ok=false 且落定为暂停 → running；其余未交回 → cancelled', () => {
    const paused = foldTaskState({
      signals: [{ kind: 'delegation', toolName: 'r', ok: false, outcome: 'paused', summary: '抓了一半' }],
      plan,
    });
    expect(paused.nodes[1]?.state).toBe('running');
    const failed = foldTaskState({
      signals: [{ kind: 'delegation', toolName: 'r', ok: false, summary: '挂了' }],
      plan,
    });
    expect(failed.nodes[1]?.state).toBe('cancelled');
  });

  it('在飞支（账本没记、branches 表有）→ running 节点，挂在游标步名下', () => {
    const branches: ReadonlyMap<string, BranchState> = new Map([['call-live', 'running']]);
    const snap = foldTaskState({
      signals: [{ kind: 'control', marker: 'phaseStart', phase: 1 }],
      plan,
      branches,
    });
    const del = snap.nodes.find((n) => n.id === 'del:call-live');
    expect(del?.state).toBe('running');
    expect(snap.nodes[0]?.dependsOn).toContain('del:call-live');
  });

  it('delegationRetracted 的支不再造节点（账已抹除即取消的落账形态）', () => {
    const snap = foldTaskState({
      signals: [
        { kind: 'delegation', toolName: 'r', ok: true, summary: '结论', callId: 'call-1' },
        { kind: 'delegationRetracted', callId: 'call-1' },
      ],
      plan,
    });
    expect(snap.nodes.find((n) => n.id === 'del:call-1')).toBeUndefined();
    expect(snap.nodes[0]?.dependsOn).toEqual([]);
  });

  it('安全标记：不可逆副作用按 callId 归属到委派节点，归属不了不瞎标，同点去重', () => {
    const signals: TaskScriptSignal[] = [
      { kind: 'delegation', toolName: 'r', ok: true, summary: '结论', callId: 'call-1' },
    ];
    const sideEffects = [
      { id: 'se:1', ts: 1, tool: 'bash', callId: 'call-1', write: true, irreversible: true, compensable: 'none' as const, status: 'done' as const },
      { id: 'se:2', ts: 2, tool: 'bash', callId: 'call-1', write: true, irreversible: true, compensable: 'none' as const, status: 'done' as const },
      { id: 'se:3', ts: 3, tool: 'http', callId: 'call-404', write: true, irreversible: true, compensable: 'none' as const, status: 'done' as const },
    ];
    const snap = foldTaskState({ signals, plan, sideEffects });
    expect(snap.safetyMarks).toEqual([{ nodeId: 'del:call-1', reason: 'irreversible write: bash' }]);
  });
});

describe('taskState · affectedByChange（数据依赖必须处理）', () => {
  const plan = planWithDeps([
    { id: 'a1', action: 'A' },
    { id: 'b1', action: 'B', dependsOn: ['a1'] },
    { id: 'c1', action: 'C', dependsOn: ['b1'] },
    { id: 'd1', action: 'D' },
  ]);

  it('指名节点的下游闭包：A 变则 B、C 全在射程内，独立步骤 D 不连坐', () => {
    const snap = foldTaskState({ signals: [], plan });
    expect(affectedByChange(snap, { nodeIds: ['a1'] }).map((n) => n.id)).toEqual(['a1', 'b1', 'c1']);
    expect(affectedByChange(snap, { nodeIds: ['d1'] }).map((n) => n.id)).toEqual(['d1']);
  });

  it('指名约束 → attached 节点及其下游全收（约束不论 active 与否，点名即入射程）', () => {
    const snap = foldTaskState({
      signals: [],
      plan,
      constraints: [{ id: 'c:1', text: '预算 500 万', source: 'user', status: 'active', attachedNodes: ['a1'] }],
    });
    expect(affectedByChange(snap, { constraintIds: ['c:1'] }).map((n) => n.id)).toEqual(['a1', 'b1', 'c1']);
  });

  it('委派节点也在传播路径上：支产出变了，宿主步的下游跟着过期', () => {
    const plan2 = planWithDeps([{ id: 'a1', action: '调研' }, { id: 'b1', action: '写报告', dependsOn: ['a1'] }]);
    const snap = foldTaskState({
      signals: [{ kind: 'delegation', toolName: 'r', ok: true, summary: '结论', callId: 'call-1' }],
      plan: plan2,
    });
    expect(affectedByChange(snap, { nodeIds: ['del:call-1'] }).map((n) => n.id)).toEqual(['a1', 'b1', 'del:call-1']);
  });

  it('只定位不改状态：查询前后快照逐位一致，未知 id 静默忽略', () => {
    const snap = foldTaskState({ signals: [], plan });
    const before = JSON.stringify(snap);
    expect(affectedByChange(snap, { nodeIds: ['nope'], constraintIds: ['c:404'] })).toEqual([]);
    expect(JSON.stringify(snap)).toBe(before);
  });
});

describe('taskState · causalDependents（因果依赖：独立有效可保留）', () => {
  const plan = planWithDeps([
    { id: 'a1', action: '按预算编制方案' },
    { id: 'b1', action: '基于方案写报告', dependsOn: ['a1'] },
    { id: 'd1', action: '搭成本模型框架' },
  ]);

  it('同挂一条约束但无数据路径的兄弟节点可保留；数据下游不在此列（归必须处理圈）', () => {
    const snap = foldTaskState({
      signals: [],
      plan,
      constraints: [{ id: 'c:1', text: '预算 500 万', source: 'user', status: 'active', attachedNodes: ['a1', 'd1'] }],
    });
    expect(causalDependents(snap, 'a1').map((n) => n.id)).toEqual(['d1']);
  });

  it('自身数据上游已 stale/cancelled 的候选不算独立有效，不返回', () => {
    const plan2 = planWithDeps([
      { id: 'a1', action: 'A' },
      { id: 'x1', action: 'X' },
      { id: 'e1', action: 'E', dependsOn: ['x1'] },
    ]);
    const snap = foldTaskState({
      signals: [],
      plan: plan2,
      constraints: [
        { id: 'c:0', text: 'x 的依据', source: 'user', status: 'removed', attachedNodes: ['x1'] },
        { id: 'c:1', text: '共同约束', source: 'user', status: 'active', attachedNodes: ['a1', 'e1'] },
      ],
    });
    // e1 依附 x1（已 stale），不因共同约束而算可保留
    expect(causalDependents(snap, 'a1')).toEqual([]);
  });

  it('约束被撤后 attached 节点已 stale：不再当「可保留」返回', () => {
    const snap = foldTaskState({
      signals: [],
      plan,
      constraints: [{ id: 'c:1', text: '预算 500 万', source: 'user', status: 'removed', attachedNodes: ['a1', 'd1'] }],
    });
    expect(causalDependents(snap, 'a1')).toEqual([]);
  });

  it('未知节点返回空（管线点名错 id 不炸）', () => {
    const snap = foldTaskState({ signals: [], plan });
    expect(causalDependents(snap, 'nope')).toEqual([]);
  });
});

describe('taskState · TaskStateStore 约束血缘', () => {
  const plan = planWithDeps([
    { id: 'a1', action: 'A' },
    { id: 'b1', action: 'B', dependsOn: ['a1'] },
  ]);

  it('登记 → active；removeConstraint → attached 节点 stale 且下游连坐', () => {
    const store = new TaskStateStore(script(plan));
    const c = store.registerConstraint({ text: '预算 500 万', source: 'user', attachedNodes: ['a1'] });
    expect(store.snapshot().constraints[0]).toMatchObject({ id: c.id, status: 'active' });

    expect(store.removeConstraint(c.id)).toBe(true);
    const snap = store.snapshot();
    expect(snap.constraints[0]?.status).toBe('removed');
    expect(snap.nodes.map((n) => [n.id, n.state])).toEqual([['a1', 'stale'], ['b1', 'stale']]);
  });

  it('supersedeConstraint：旧条目 superseded、新条目 active 继承 attached，两边查影响都命中', () => {
    const store = new TaskStateStore(script(plan));
    const c1 = store.registerConstraint({ text: '预算 500 万', source: 'user', attachedNodes: ['a1'] });
    const c2 = store.supersedeConstraint(c1.id, { text: '预算 50 万', source: 'user' });
    expect(c2).toBeDefined();
    const snap = store.snapshot();
    expect(snap.constraints.map((c) => [c.status, c.text])).toEqual([
      ['superseded', '预算 500 万'],
      ['active', '预算 50 万'],
    ]);
    expect(snap.nodes.map((n) => n.state)).toEqual(['stale', 'stale']);
    expect(affectedByChange(snap, { constraintIds: [c2!.id] }).map((n) => n.id)).toEqual(['a1', 'b1']);
  });

  it('remove 不存在的约束 / 已终态的约束返回 false（幂等不炸）', () => {
    const store = new TaskStateStore(script(plan));
    expect(store.removeConstraint('c:404')).toBe(false);
    const c = store.registerConstraint({ text: 't', source: 'user', attachedNodes: [] });
    store.removeConstraint(c.id);
    expect(store.removeConstraint(c.id)).toBe(false);
  });
});

describe('taskState · TaskStateStore 副作用账', () => {
  it('recordSideEffect 缺省补 id/ts/status，落账后 pendingWrites 可清点', () => {
    const store = new TaskStateStore(script(planWithDeps([{ id: 'a1', action: 'A' }])));
    const se = store.recordSideEffect({ tool: 'write_file', write: true, irreversible: false, compensable: 'auto', target: 'a.ts' });
    expect(se.id).toBe('se:1');
    expect(se.status).toBe('done');
    expect(se.ts).toBeGreaterThan(0);
    expect(store.pendingWrites()).toHaveLength(1);
  });

  it('freezeUncompensable：none/manual/不可逆就地冻结，auto 留给二期补偿', () => {
    const store = new TaskStateStore(script(planWithDeps([{ id: 'a1', action: 'A' }])));
    store.recordSideEffect({ tool: 'edit_file', write: true, irreversible: false, compensable: 'auto' });
    store.recordSideEffect({ tool: 'bash', write: true, irreversible: false, compensable: 'none' });
    store.recordSideEffect({ tool: 'deploy', write: true, irreversible: true, compensable: 'manual' });
    const frozen = store.freezeUncompensable();
    expect(frozen.map((se) => se.tool).sort()).toEqual(['bash', 'deploy']);
    expect(frozen.every((se) => se.status === 'frozen')).toBe(true);
    expect(store.pendingWrites().map((se) => se.tool)).toEqual(['edit_file']);
    // 冻结幂等：再冻没有新账
    expect(store.freezeUncompensable()).toEqual([]);
  });

  it('非写副作用不进 pendingWrites 也不被冻结（只读调用不处置）', () => {
    const store = new TaskStateStore(script(planWithDeps([{ id: 'a1', action: 'A' }])));
    store.recordSideEffect({ tool: 'read_file', write: false, irreversible: false, compensable: 'none' });
    expect(store.pendingWrites()).toEqual([]);
    expect(store.freezeUncompensable()).toEqual([]);
  });

  it('reset 整体换账：约束清空后节点不再 stale，分支表可换新', () => {
    const plan = planWithDeps([{ id: 'a1', action: 'A' }]);
    const store = new TaskStateStore(script(plan));
    const c = store.registerConstraint({ text: '旧前提', source: 'user', attachedNodes: ['a1'] });
    store.removeConstraint(c.id);
    expect(store.snapshot().nodes[0]?.state).toBe('stale');

    store.reset({ constraints: [] });
    expect(store.snapshot().nodes[0]?.state).toBe('pending');
    expect(store.snapshot().constraints).toEqual([]);
  });

  it('折算纯函数与存壳一致：直接喂 constraints 与经 store 登记后 remove 同快照', () => {
    const plan = planWithDeps([{ id: 'a1', action: 'A' }]);
    const direct = foldTaskState({
      signals: [],
      plan,
      constraints: [{ id: 'c:1', text: 't', source: 'user', status: 'removed', attachedNodes: ['a1'] }],
    });
    const store = new TaskStateStore(script(plan));
    const c = store.registerConstraint({ text: 't', source: 'user', attachedNodes: ['a1'] });
    store.removeConstraint(c.id);
    expect(store.snapshot().nodes).toEqual(direct.nodes);
  });
});
