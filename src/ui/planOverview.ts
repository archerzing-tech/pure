// src/ui/planOverview.ts
// Floating execution-overview card pinned to the right edge of the chat area.
// The in-chat plan card stays in the transcript for interaction; this card
// mirrors its progress so the outline stays visible no matter how far the
// conversation scrolls. Driven entirely by chat.ts through the singleton API
// below — it owns no plan state of its own.

import type { Plan } from '../coding-agent/types';

export type PlanOverviewStatus = 'active' | 'waiting' | 'complete';

export interface PlanOverviewHandle {
  el: HTMLElement;
  /** Show the overview for a plan (scaffold or final). */
  show(plan: Plan, status?: PlanOverviewStatus, currentPlan?: number, currentTodo?: number, todoLabel?: string): void;
  /** In-place refresh with the same plan (LLM upgrade) — keeps progress. */
  update(plan: Plan, status?: PlanOverviewStatus, currentPlan?: number, currentTodo?: number, todoLabel?: string): void;
  setStatus(status: PlanOverviewStatus, activity?: string): void;
  setCurrent(planNumber: number, todoNumber?: number, todoLabel?: string): void;
  setCollapsed(collapsed: boolean): void;
  clear(): void;
}

export function createPlanOverview(): PlanOverviewHandle {
  const el = document.createElement('aside');
  el.className = 'plan-overview';
  el.hidden = true;
  el.setAttribute('role', 'complementary');
  el.setAttribute('aria-label', '执行大纲');

  const card = document.createElement('div');
  card.className = 'plan-overview-card';

  const compact = document.createElement('button');
  compact.type = 'button';
  compact.className = 'plan-overview-compact';
  compact.hidden = true;
  compact.title = '展开执行大纲';
  compact.setAttribute('aria-label', '展开执行大纲');
  compact.setAttribute('aria-expanded', 'false');
  const compactDot = document.createElement('span');
  compactDot.className = 'plan-overview-compact-dot';
  compactDot.setAttribute('aria-hidden', 'true');
  const compactLabel = document.createElement('span');
  compactLabel.className = 'plan-overview-compact-label';
  const compactProgress = document.createElement('span');
  compactProgress.className = 'plan-overview-compact-progress';
  const compactChevron = document.createElement('span');
  compactChevron.className = 'plan-overview-compact-chevron';
  compactChevron.textContent = '‹';
  compactChevron.setAttribute('aria-hidden', 'true');
  compact.append(compactDot, compactLabel, compactProgress, compactChevron);

  const head = document.createElement('div');
  head.className = 'plan-overview-head';
  const title = document.createElement('span');
  title.className = 'plan-overview-title';
  title.textContent = '执行大纲';
  const progress = document.createElement('span');
  progress.className = 'plan-overview-progress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'plan-overview-close';
  close.title = '收起大纲';
  close.setAttribute('aria-label', '收起执行大纲');
  close.textContent = '×';
  head.append(title, progress, close);

  const activity = document.createElement('div');
  activity.className = 'plan-overview-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');

  const steps = document.createElement('div');
  steps.className = 'plan-overview-steps';
  steps.setAttribute('role', 'list');

  card.append(head, activity, steps);
  el.append(card, compact);

  let collapsed = false;
  function setCollapsed(next: boolean): void {
    collapsed = next;
    card.hidden = collapsed;
    compact.hidden = !collapsed;
    el.classList.toggle('is-collapsed', collapsed);
    compact.setAttribute('aria-expanded', String(!collapsed));
    if (plan) render();
  }
  close.addEventListener('click', () => setCollapsed(true));
  compact.addEventListener('click', () => setCollapsed(false));

  const state = { currentPlan: 1, currentTodo: 1, todoLabel: '' };
  let plan: Plan | null = null;
  let status: PlanOverviewStatus = 'active';

  const render = (): void => {
    if (!plan) return;
    const total = plan.steps.length;
    const doneCount = Math.max(0, Math.min(state.currentPlan - 1, total));
    progress.textContent = status === 'complete' ? `${total}/${total}` : `${doneCount}/${total}`;
    steps.textContent = '';
    plan.steps.forEach((step, i) => {
      const n = i + 1;
      const row = document.createElement('div');
      row.className = 'plan-overview-step';
      row.setAttribute('role', 'listitem');
      const check = document.createElement('span');
      check.className = 'plan-overview-step-check';
      check.setAttribute('aria-hidden', 'true');
      if (status === 'complete' || n < state.currentPlan) {
        row.classList.add('done');
        check.textContent = '✓';
      } else if (n === state.currentPlan) {
        row.classList.add(status === 'waiting' ? 'awaiting' : 'active');
        check.textContent = String(n);
      } else {
        row.classList.add('pending');
        check.textContent = String(n);
      }
      const label = document.createElement('span');
      label.className = 'plan-overview-step-label';
      label.textContent = step.action;
      row.append(check, label);
      steps.appendChild(row);
    });
    card.classList.remove('complete', 'awaiting', 'active');
    compact.classList.remove('complete', 'awaiting', 'active');
    if (status === 'complete') {
      card.classList.add('complete');
      compact.classList.add('complete');
      compactLabel.textContent = '执行完成';
    } else if (status === 'waiting') {
      card.classList.add('awaiting');
      compact.classList.add('awaiting');
      compactLabel.textContent = '等待回复';
    } else {
      card.classList.add('active');
      compact.classList.add('active');
      compactLabel.textContent = state.todoLabel ? `执行中：${state.todoLabel}` : '正在执行';
    }
    compactProgress.textContent = progress.textContent;
    compact.title = collapsed ? '展开执行大纲' : '收起执行大纲';
    compact.setAttribute('aria-label', compact.title);
  };

  const apply = (
    next: Plan,
    nextStatus: PlanOverviewStatus = 'active',
    currentPlan = 1,
    currentTodo = 1,
    todoLabel = '',
  ): void => {
    plan = next;
    status = nextStatus;
    state.currentPlan = currentPlan;
    state.currentTodo = currentTodo;
    state.todoLabel = todoLabel;
    render();
    el.hidden = false;
  };

  const activityText = (s: PlanOverviewStatus): string => (
    s === 'complete' ? '全部步骤已完成'
      : s === 'waiting' ? '已暂停，等待你的回复'
        : state.todoLabel
          ? `正在执行：${state.todoLabel}`
          : '正在按计划执行…'
  );

  return {
    el,
    show: (next, nextStatus = 'active', currentPlan = 1, currentTodo = 1, todoLabel = '') => {
      apply(next, nextStatus, currentPlan, currentTodo, todoLabel);
      activity.textContent = activityText(nextStatus);
    },
    update: (next, nextStatus = 'active', currentPlan = 1, currentTodo = 1, todoLabel = '') => {
      apply(next, nextStatus, currentPlan, currentTodo, todoLabel);
      activity.textContent = activityText(nextStatus);
    },
    setStatus: (next, text) => {
      status = next;
      render();
      activity.textContent = text ?? activityText(next);
      el.hidden = false;
    },
    setCurrent: (planNumber, todoNumber, todoLabel) => {
      state.currentPlan = planNumber;
      if (todoNumber !== undefined) state.currentTodo = todoNumber;
      if (todoLabel !== undefined) state.todoLabel = todoLabel;
      render();
      activity.textContent = activityText(status);
    },
    setCollapsed,
    clear: () => {
      plan = null;
      setCollapsed(false);
      el.hidden = true;
    },
  };
}

let overview: PlanOverviewHandle | null = null;

/** Get (and lazily create) the singleton floating overview card. */
export function planOverview(): PlanOverviewHandle {
  if (overview) return overview;
  const handle = createPlanOverview();
  // Anchor it to the app shell so it outlives per-transcript DOM clears.
  const host = document.getElementById('view-container') ?? document.body;
  host.appendChild(handle.el);
  overview = handle;
  return handle;
}
