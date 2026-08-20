import { describe, expect, it } from 'bun:test';
import { PlanProgressModel, type PlanProgressSnapshot } from '../planProgress';
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
