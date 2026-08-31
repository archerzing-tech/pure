import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { createRestoredPlanCard, type PlanCardHandle } from '../plan';
import { PlanProgressModel, type PlanProgressSnapshot } from '../planProgress';
import { deleteSession, loadSession, saveSession, SESSION_SNAPSHOT_VERSION, type SessionSnapshotV2 } from '../store';
import type { Plan } from '../../coding-agent/types';

const sessionIds = new Set<string>();

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(async () => {
  document.querySelectorAll('.plan-progress-row').forEach((element) => element.remove());
  for (const sessionId of sessionIds) await deleteSession(sessionId);
  sessionIds.clear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function samplePlan(): Plan {
  return {
    steps: [
      { id: '1', action: '准备', description: '准备执行上下文', expectedOutcome: '上下文就绪', todosRequired: false },
      { id: '2', action: '实现', description: '完成核心实现', expectedOutcome: '功能完成', todosRequired: false },
      { id: '3', action: '验证', description: '验证最终结果', expectedOutcome: '结果可交付', todosRequired: false },
    ],
    reasoning: 'session integration',
  };
}

function snapshotFor(progress: PlanProgressSnapshot): SessionSnapshotV2 {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    modelContext: {
      messages: [
        { role: 'user', content: '执行复杂任务' },
        { role: 'assistant', content: '执行中' },
      ],
    },
    events: [],
    transcript: [{
      id: 'plan-assistant',
      modelMessageIndex: 1,
      role: 'assistant',
      content: '执行中',
      planCard: {
        plan: progress.plan,
        currentPlan: progress.currentPlan,
        currentTodo: progress.currentTodo,
        complete: progress.status === 'complete',
      },
    }],
    uiState: {
      planProgress: progress,
      planState: null,
    },
  };
}

function progressAt(plan: Plan, currentPlan: number, status: PlanProgressSnapshot['status'] = 'active'): PlanProgressSnapshot {
  return new PlanProgressModel(plan, status, currentPlan, 1).getSnapshot();
}

function mountRestoredCard(chat: ChatController): { model: PlanProgressModel; card: PlanCardHandle } {
  const model = chat.getPlanProgressModel();
  if (!model) throw new Error('expected a restored plan model');
  const card = createRestoredPlanCard(model);
  document.body.appendChild(card.el);
  return { model, card };
}

function expectCardProgress(card: PlanCardHandle, currentPlan: number): void {
  expect(card.plan.steps.length).toBe(3);
  expect(card.stepEls[currentPlan - 1]?.classList.contains('active')).toBe(true);
  expect(card.stepEls.slice(0, currentPlan - 1).every((row) => row.classList.contains('done'))).toBe(true);
}

async function flushProgress(chat: ChatController): Promise<void> {
  await (chat as any).activePlanProgressPersistence?.flush();
}

describe('chat plan-card progress session integration', () => {
  it('keeps the restored chat card on one model after refresh', async () => {
    const sessionId = `plan-e2e-refresh-${Date.now()}-${Math.random()}`;
    sessionIds.add(sessionId);
    const plan = samplePlan();
    await saveSession(sessionId, snapshotFor(progressAt(plan, 2)));

    const first = new ChatController();
    first.setSessionId(sessionId);
    first.loadFromStorage((await loadSession(sessionId))!.snapshot);
    const firstView = mountRestoredCard(first);
    expectCardProgress(firstView.card, 2);

    firstView.model.dispatch({ type: 'phaseStarted', planNumber: 3 });
    expectCardProgress(firstView.card, 3);
    await flushProgress(first);

    const refreshedSnapshot = (await loadSession(sessionId))!.snapshot;
    const refreshed = new ChatController();
    refreshed.setSessionId(sessionId);
    refreshed.loadFromStorage(refreshedSnapshot);
    const refreshedView = mountRestoredCard(refreshed);
    expect(refreshed.getPlanProgressModel()).not.toBe(firstView.model);
    expectCardProgress(refreshedView.card, 3);
  });

  it('detaches the previous session model from the new chat plan card', () => {
    const plan = samplePlan();
    const chat = new ChatController();
    const firstSession = `plan-e2e-a-${Date.now()}-${Math.random()}`;
    const secondSession = `plan-e2e-b-${Date.now()}-${Math.random()}`;
    sessionIds.add(firstSession);
    sessionIds.add(secondSession);

    chat.setSessionId(firstSession);
    chat.loadFromStorage(snapshotFor(progressAt(plan, 1)));
    const firstView = mountRestoredCard(chat);
    const firstModel = firstView.model;

    chat.setSessionId(secondSession);
    chat.loadFromStorage(snapshotFor(progressAt(plan, 2)));
    const secondView = mountRestoredCard(chat);
    expectCardProgress(secondView.card, 2);

    firstModel.dispatch({ type: 'completed' });
    expectCardProgress(secondView.card, 2);
    secondView.model.dispatch({ type: 'completed' });
    expect(secondView.card.stepEls.every((row) => row.classList.contains('done'))).toBe(true);
  });

  it('recovers a paused chat plan card through the continuation path', async () => {
    const sessionId = `plan-e2e-pause-${Date.now()}-${Math.random()}`;
    sessionIds.add(sessionId);
    const plan = samplePlan();
    await saveSession(sessionId, snapshotFor(progressAt(plan, 2, 'waiting')));
    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    const view = mountRestoredCard(chat);
    expect(view.card.el.querySelector('.plan-progress-activity')?.classList.contains('is-waiting')).toBe(true);

    let continuedText = '';
    (chat as any).send = async (text: string) => {
      continuedText = text;
      view.model.dispatch({ type: 'statusChanged', status: 'active' });
    };
    expect(chat.continuePausedPlan()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(continuedText).toBe('继续');
    expect(view.card.el.querySelector('.plan-progress-activity')?.classList.contains('is-waiting')).toBe(false);
    await flushProgress(chat);
    const persisted = (await loadSession(sessionId))!.snapshot.uiState.planProgress;
    expect(persisted?.status).toBe('active');
  });
});
