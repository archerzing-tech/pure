import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { createRestoredPlanCard, type PlanCardHandle } from '../plan';
import { planOverview, setOverviewPositionSession } from '../planOverview';
import { PlanProgressModel, type PlanProgressSnapshot } from '../planProgress';
import { deleteSession, loadSession, saveSession, SESSION_SNAPSHOT_VERSION, type SessionSnapshotV2 } from '../store';
import type { Plan } from '../../coding-agent/types';

const sessionIds = new Set<string>();

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(async () => {
  planOverview().clear();
  document.querySelectorAll('.plan-progress-row').forEach((element) => element.remove());
  for (const sessionId of sessionIds) await deleteSession(sessionId);
  sessionIds.clear();
});

afterAll(() => {
  setOverviewPositionSession(null);
  planOverview().clear();
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

function ensureOverviewMounted(): void {
  const el = planOverview().el;
  if (!el.isConnected) document.body.appendChild(el);
}

function mountRestoredCard(chat: ChatController): { model: PlanProgressModel; card: PlanCardHandle } {
  ensureOverviewMounted();
  const model = chat.getPlanProgressModel();
  if (!model) throw new Error('expected a restored plan model');
  const card = createRestoredPlanCard(model);
  document.body.appendChild(card.el);
  return { model, card };
}

function expectSharedProgress(card: PlanCardHandle, currentPlan: number, progressText: string): void {
  ensureOverviewMounted();
  const overviewEl = planOverview().el;
  expect(overviewEl.hidden).toBe(false);
  expect(overviewEl.querySelector('.plan-overview-progress')?.textContent).toBe(progressText);
  expect(card.plan.steps.length).toBe(3);
  expect(card.stepEls[currentPlan - 1]?.classList.contains('active')).toBe(true);
  expect(card.stepEls.slice(0, currentPlan - 1).every((row) => row.classList.contains('done'))).toBe(true);
}

async function flushProgress(chat: ChatController): Promise<void> {
  await (chat as any).activePlanProgressPersistence?.flush();
}

describe('plan progress session integration', () => {
  it('keeps the restored chat card and floating outline on one model after refresh', async () => {
    const sessionId = `plan-e2e-refresh-${Date.now()}-${Math.random()}`;
    sessionIds.add(sessionId);
    const plan = samplePlan();
    const initial = snapshotFor(progressAt(plan, 2));
    await saveSession(sessionId, initial);

    const first = new ChatController();
    first.setSessionId(sessionId);
    first.loadFromStorage((await loadSession(sessionId))!.snapshot);
    const firstView = mountRestoredCard(first);
    expectSharedProgress(firstView.card, 2, '1/3');

    firstView.model.dispatch({ type: 'phaseStarted', planNumber: 3 });
    expectSharedProgress(firstView.card, 3, '2/3');
    await flushProgress(first);

    const refreshedSnapshot = (await loadSession(sessionId))!.snapshot;
    const refreshed = new ChatController();
    refreshed.setSessionId(sessionId);
    refreshed.loadFromStorage(refreshedSnapshot);
    const refreshedView = mountRestoredCard(refreshed);
    expect(refreshed.getPlanProgressModel()).not.toBe(firstView.model);
    expectSharedProgress(refreshedView.card, 3, '2/3');
    expect(planOverview().el.querySelectorAll('.plan-overview-step.done').length).toBe(2);
  });

  it('detaches the previous session so an old model cannot move the new outline', () => {
    const plan = samplePlan();
    const first = new ChatController();
    const firstSession = `plan-e2e-a-${Date.now()}-${Math.random()}`;
    const secondSession = `plan-e2e-b-${Date.now()}-${Math.random()}`;
    sessionIds.add(firstSession);
    sessionIds.add(secondSession);

    first.setSessionId(firstSession);
    first.loadFromStorage(snapshotFor(progressAt(plan, 1)));
    const firstView = mountRestoredCard(first);
    const firstModel = firstView.model;
    expectSharedProgress(firstView.card, 1, '0/3');

    first.setSessionId(secondSession);
    first.loadFromStorage(snapshotFor(progressAt(plan, 2)));
    const secondView = mountRestoredCard(first);
    expectSharedProgress(secondView.card, 2, '1/3');

    firstModel.dispatch({ type: 'completed' });
    expect(planOverview().el.querySelector('.plan-overview-progress')?.textContent).toBe('1/3');
    expect(planOverview().el.querySelector('.plan-overview-card')?.classList.contains('complete')).toBe(false);

    secondView.model.dispatch({ type: 'completed' });
    expect(planOverview().el.querySelector('.plan-overview-progress')?.textContent).toBe('3/3');
    expect(planOverview().el.querySelector('.plan-overview-card')?.classList.contains('complete')).toBe(true);
    expect(secondView.card.stepEls.every((row) => row.classList.contains('done'))).toBe(true);
  });

  it('recovers a paused plan through the continuation path and clears waiting in both views', async () => {
    const sessionId = `plan-e2e-pause-${Date.now()}-${Math.random()}`;
    sessionIds.add(sessionId);
    const plan = samplePlan();
    const pausedSnapshot = snapshotFor(progressAt(plan, 2, 'waiting'));
    await saveSession(sessionId, pausedSnapshot);
    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    const view = mountRestoredCard(chat);
    const overviewEl = planOverview().el;
    expect(overviewEl.querySelector('.plan-overview-card')?.classList.contains('awaiting')).toBe(true);
    expect(view.card.el.querySelector('.plan-progress-activity')?.classList.contains('is-waiting')).toBe(true);

    let continuedText = '';
    (chat as any).send = async (text: string) => {
      continuedText = text;
      view.model.dispatch({ type: 'statusChanged', status: 'active' });
    };
    expect(chat.continuePausedPlan()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(continuedText).toBe('继续');
    expect(overviewEl.querySelector('.plan-overview-card')?.classList.contains('active')).toBe(true);
    expect(overviewEl.querySelector('.plan-overview-card')?.classList.contains('awaiting')).toBe(false);
    expect(view.card.el.querySelector('.plan-progress-activity')?.classList.contains('is-waiting')).toBe(false);
    await flushProgress(chat);
    const persisted = (await loadSession(sessionId))!.snapshot.uiState.planProgress;
    expect(persisted?.status).toBe('active');
  });
});
