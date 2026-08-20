// src/ui/__tests__/planOverviewRestore.test.ts
// Real-DOM integration test for the PlanState.complete restore path. A
// finished complex plan nulls the cross-turn cursor (activeComplexPlan) but
// persists planState with complete: true, so a session reload must bring the
// floating outline back in its all-done state — without re-arming the
// continuation cursor. Uses happy-dom (registered only in this file) so the
// outline renders against a real DOM instead of the fake documents used by
// the unit tests.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { planOverview, setOverviewPositionSession } from '../planOverview';
import { loadSession, SESSION_SNAPSHOT_VERSION, type PlanState, type SessionSnapshotV2 } from '../store';
import type { Message } from '../../shared/types';
import type { Plan } from '../../coding-agent/types';

// Register the DOM globals only for the duration of this file's tests, then
// unregister. bun shares worker processes across some test files, and happy-dom
// installs localStorage/document as readonly accessors — leaving them installed
// at module-eval time would break other suites (e.g. planOverview.test.ts's
// fake-storage installs throw "attempted to assign to readonly property").
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(() => {
  // bun shares module state across test files in the same worker: the
  // ChatController constructor points the outline's position memory at a
  // session id, which would leak into planOverview.test.ts's drag tests (they
  // read the global key while endDrag would write a session-scoped one). Reset
  // the shared module state before the worker moves on.
  setOverviewPositionSession(null);
  planOverview().clear();
  GlobalRegistrator.unregister();
});

function samplePlan(): Plan {
  return {
    steps: [
      { id: '1', action: '了解需求', description: 'd', expectedOutcome: 'o' },
      { id: '2', action: '设计方案', description: 'd', expectedOutcome: 'o' },
      { id: '3', action: '实现功能', description: 'd', expectedOutcome: 'o' },
    ],
    reasoning: 'r',
  };
}

function snapshotWith(planState: PlanState | null): SessionSnapshotV2 {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    modelContext: { messages: [] },
    transcript: [],
    uiState: { planState },
  };
}

function planStateOf(partial: Partial<PlanState> & Pick<PlanState, 'plan'>): PlanState {
  return { planNumber: 1, todoNumber: 1, started: false, ...partial };
}

afterEach(() => {
  // The floating outline is a module-level singleton; hide it between tests
  // so one test's restored plan cannot leak into the next.
  planOverview().clear();
});

describe('PlanState.complete restore path (real DOM)', () => {
  it('persists a completed plan and reloads the outline in its all-done state', async () => {
    const chat = new ChatController();
    const plan = samplePlan();
    // End of a turn where the plan finished: the cross-turn cursor is nulled
    // but the final card snapshot carries complete: true (see syncActivePlanCursor).
    (chat as any).activeComplexPlan = null;
    (chat as any).activePlanCardSnapshot = { plan, currentPlan: 3, currentTodo: 2, complete: true };
    const assistant: Message = { role: 'assistant', content: '全部完成。' };
    await (chat as any).persistSession([assistant], new Map(), [], chat.getSessionId(), '');

    const loaded = await loadSession(chat.getSessionId());
    expect(loaded?.snapshot.uiState.planState?.complete).toBe(true);
    expect(loaded?.snapshot.uiState.planState?.plan).toEqual(plan);

    // A fresh session reload keeps the completed state for the chat plan card
    // without mounting the removed floating outline.
    const restored = new ChatController();
    restored.loadFromStorage(loaded!.snapshot);
    expect(restored.getPlanProgressModel()?.getSnapshot().status).toBe('complete');
    expect((restored as any).activeComplexPlan).toBeNull();
    expect((restored as any).activePlanCardSnapshot).toBeNull();
  });

  it('restores an in-progress plan with its chat-card continuation cursor', () => {
    const chat = new ChatController();
    const plan = samplePlan();
    chat.loadFromStorage(snapshotWith(planStateOf({ plan, planNumber: 2, todoNumber: 1, started: true })));
    expect((chat as any).activeComplexPlan).toBe(plan);
    expect((chat as any).activePlanNumber).toBe(2);
    expect(chat.getPlanProgressModel()?.getSnapshot().currentPlan).toBe(2);
    expect(chat.getPlanProgressModel()?.getSnapshot().status).toBe('active');
  });

  it('restores a paused plan in the waiting state with its cursor', () => {
    const chat = new ChatController();
    const plan = samplePlan();
    chat.loadFromStorage(snapshotWith(planStateOf({ plan, planNumber: 1, todoNumber: 1, started: false })));
    expect((chat as any).activeComplexPlan).toBe(plan);
    expect((chat as any).activePlanNumber).toBe(1);
    expect((chat as any).activePlanStarted).toBe(false);
  });

  it('restores one canonical progress model for the chat-card continuation state', () => {
    const plan = samplePlan();
    const progress = { plan, currentPlan: 2, currentTodo: 1, status: 'active' as const };
    const chat = new ChatController();
    chat.loadFromStorage({
      ...snapshotWith(null),
      transcript: [{
        id: 'plan',
        modelMessageIndex: 0,
        role: 'assistant',
        content: '执行中',
        planCard: { plan, currentPlan: 2, currentTodo: 1, complete: false },
      }],
      uiState: { planProgress: progress, planState: null },
    });

    const restored = chat.getPlanProgressModel();
    expect(restored).toBeTruthy();
    // The canonical model normalizes the missing project-build flag to false.
    expect(restored?.getSnapshot()).toEqual({ ...progress, projectBuild: false });
    expect((chat as any).activeComplexPlan).toBe(plan);
    expect((chat as any).activePlanNumber).toBe(2);

    restored!.dispatch({ type: 'completed' });
    expect((chat as any).activeComplexPlan).toBeNull();
    expect(restored!.getSnapshot().status).toBe('complete');
  });

  it('keeps the chat plan state empty when no plan state is restored', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith(null));
    expect((chat as any).activeComplexPlan).toBeNull();
    expect(chat.getPlanProgressModel()).toBeNull();
  });
});
