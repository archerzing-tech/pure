import { describe, expect, it } from 'bun:test';
import { PlanProgressModel, shouldAdvancePlanAtTurnEnd, type PlanProgressSnapshot } from '../planProgress';
import type { Plan } from '../../coding-agent/types';

function plan(): Plan {
  return {
    steps: [
      { id: '1', action: '准备', description: '', expectedOutcome: '', substeps: [{ id: '1.1', action: '检查', description: '', expectedOutcome: '' }] },
      { id: '2', action: '实现', description: '', expectedOutcome: '', substeps: [{ id: '2.1', action: '修改', description: '', expectedOutcome: '' }, { id: '2.2', action: '验证', description: '', expectedOutcome: '' }] },
    ],
    reasoning: '',
  };
}

describe('PlanProgressModel', () => {
  it('publishes one ordered snapshot stream for phase and todo changes', () => {
    const model = new PlanProgressModel(plan());
    const snapshots: Array<{ currentPlan: number; currentTodo: number; status: string }> = [];
    model.subscribe((snapshot) => snapshots.push({ currentPlan: snapshot.currentPlan, currentTodo: snapshot.currentTodo, status: snapshot.status }));

    model.dispatch({ type: 'todoStarted', todoNumber: 1 });
    expect(model.isTodoStarted()).toBe(true);
    model.dispatch({ type: 'todoCompleted', todoNumber: 1 });
    expect(model.isTodoStarted()).toBe(false);
    model.dispatch({ type: 'phaseStarted', planNumber: 2 });

    expect(snapshots.at(-1)).toEqual({ currentPlan: 2, currentTodo: 1, status: 'active' });
    expect(snapshots.map((snapshot) => `${snapshot.currentPlan}/${snapshot.currentTodo}`)).toEqual(['1/1', '1/1', '1/2', '2/1']);
  });

  it('publishes persistence snapshots through the same event stream', () => {
    const model = new PlanProgressModel(plan());
    const snapshots: PlanProgressSnapshot[] = [];
    const unsubscribe = model.subscribePersistence((snapshot) => { snapshots.push(snapshot); });

    model.dispatch({ type: 'todoCompleted', todoNumber: 1 });
    unsubscribe();
    model.dispatch({ type: 'phaseStarted', planNumber: 2 });

    expect(snapshots.map((snapshot) => `${snapshot.currentPlan}/${snapshot.currentTodo}`)).toEqual(['1/1', '1/2']);
  });

  it('makes completion a single terminal state for every subscriber', () => {
    const model = new PlanProgressModel(plan(), 'waiting');
    const states: string[] = [];
    model.subscribe((snapshot) => states.push(`${snapshot.currentPlan}/${snapshot.status}`));

    model.dispatch({ type: 'completed' });

    expect(model.getSnapshot()).toMatchObject({ currentPlan: 3, currentTodo: 3, status: 'complete' });
    expect(states).toEqual(['1/waiting', '3/complete']);
  });

  it('round-trips a persisted snapshot without creating a second cursor', () => {
    const source = new PlanProgressModel(plan());
    source.dispatch({ type: 'phaseStarted', planNumber: 2 });
    source.dispatch({ type: 'todoCompleted', todoNumber: 1 });
    const restored = PlanProgressModel.fromSnapshot(source.getSnapshot());

    expect(restored.getSnapshot()).toEqual(source.getSnapshot());
    restored.dispatch({ type: 'completed' });
    expect(restored.getSnapshot().status).toBe('complete');
    expect(source.getSnapshot().status).toBe('active');
  });

  it('keeps the project-build flag when a plan is refined in place', () => {
    const model = new PlanProgressModel(plan(), 'active', 1, 1, true);
    const refined: Plan = {
      steps: [{ id: 'r1', action: '细化步骤', description: '', expectedOutcome: '' }],
      reasoning: 'refined',
    };
    model.dispatch({ type: 'planReplaced', plan: refined });
    expect(model.getSnapshot().projectBuild).toBe(true);
    expect(model.getSnapshot().plan).toEqual(refined);
  });

  it('carries the conversation-local plan sequence number and trigger reason', () => {
    const source = new PlanProgressModel(plan(), 'active', 1, 1, false, 2, '我觉得这里不好看');
    expect(source.getSnapshot()).toMatchObject({ planSeq: 2, reason: '我觉得这里不好看' });
    const restored = PlanProgressModel.fromSnapshot(source.getSnapshot());
    expect(restored.getSnapshot()).toMatchObject({ planSeq: 2, reason: '我觉得这里不好看' });
  });

  it('keeps the plan sequence when the same plan is refined in place', () => {
    const model = new PlanProgressModel(plan(), 'active', 1, 1, false, 2, '触发原因');
    const refined: Plan = {
      steps: [{ id: 'r1', action: '细化步骤', description: '', expectedOutcome: '' }],
      reasoning: 'refined',
    };
    model.dispatch({ type: 'planReplaced', plan: refined });
    expect(model.getSnapshot()).toMatchObject({ planSeq: 2, reason: '触发原因' });
    expect(model.getSnapshot().plan).toEqual(refined);
  });

  it('defaults a legacy snapshot to plan sequence 1 without a reason', () => {
    const legacy = PlanProgressModel.fromSnapshot({ plan: plan(), currentPlan: 1, currentTodo: 1, status: 'active' });
    expect(legacy.getSnapshot()).toMatchObject({ planSeq: 1, reason: undefined });
  });

  it('round-trips the project-build flag through persistence', () => {
    const source = new PlanProgressModel(plan(), 'active', 1, 1, true);
    expect(source.getSnapshot().projectBuild).toBe(true);
    const restored = PlanProgressModel.fromSnapshot(source.getSnapshot());
    expect(restored.getSnapshot().projectBuild).toBe(true);
    // A legacy snapshot without the field stays a non-build plan.
    const legacy = PlanProgressModel.fromSnapshot({ plan: plan(), currentPlan: 1, currentTodo: 1, status: 'active' });
    expect(legacy.getSnapshot().projectBuild).toBe(false);
  });

  it('normalizes a persisted complete status to the terminal cursor', () => {
    const restored = PlanProgressModel.fromSnapshot({
      plan: plan(),
      currentPlan: 2,
      currentTodo: 1,
      status: 'complete',
    });

    expect(restored.getSnapshot()).toMatchObject({ currentPlan: 3, currentTodo: 3, status: 'complete' });
  });
});

describe('shouldAdvancePlanAtTurnEnd', () => {
  function threeStepPlan(): Plan {
    return {
      reasoning: '',
      steps: [
        { id: '1', action: '一', description: '', expectedOutcome: '' },
        { id: '2', action: '二', description: '', expectedOutcome: '' },
        { id: '3', action: '三', description: '', expectedOutcome: '' },
      ],
    };
  }

  function snapshotAt(currentPlan: number, currentTodo = 1): PlanProgressSnapshot {
    return new PlanProgressModel(threeStepPlan(), 'active', currentPlan, currentTodo).getSnapshot();
  }

  it('does not advance again when the completion marker already moved the cursor (no skipped stage)', () => {
    // 模型本轮发出 `## 计划 1 已完成`：finishPlan 已把游标推到 2，并记录
    // completedPlan = 1。此时回合正常结束若再推进一次就会从 2 跳到 3，
    // 第 2 阶段被整段跳过——这是本次要防住的跳阶段回归。
    const snapshot = snapshotAt(2);
    expect(shouldAdvancePlanAtTurnEnd(true, snapshot, 1)).toBe(false);
  });

  it('advances one stage as the fallback when the model omitted the completion marker', () => {
    // 模型做了第 1 阶段的工作但漏发 `## 计划 1 已完成`：游标仍在 1，
    // completedPlan 为 null，兜底应推进一格到第 2 阶段。
    expect(shouldAdvancePlanAtTurnEnd(true, snapshotAt(1), null)).toBe(true);
  });

  it('does not advance on the last plan or when the turn did not finish a stage', () => {
    // 已在最后一个计划上：完成态交给 planProgress.dispatch({type:'completed'})。
    expect(shouldAdvancePlanAtTurnEnd(true, snapshotAt(3), null)).toBe(false);
    // 本轮没有真实完成工作（提问/中断等），不该推进。
    expect(shouldAdvancePlanAtTurnEnd(false, snapshotAt(1), null)).toBe(false);
    // 没有计划快照，更不该推进。
    expect(shouldAdvancePlanAtTurnEnd(true, undefined, null)).toBe(false);
  });
});
