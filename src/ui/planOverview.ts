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
  setStatus(status: PlanOverviewStatus): void;
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
  const compactStep = document.createElement('span');
  compactStep.className = 'plan-overview-compact-step';
  compactStep.setAttribute('aria-live', 'polite');
  compactStep.setAttribute('aria-label', '当前步骤');
  compact.append(compactStep);

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

  const steps = document.createElement('div');
  steps.className = 'plan-overview-steps';
  steps.setAttribute('role', 'list');

  card.append(head, steps);
  el.append(card, compact);

  let collapsed = false;
  function setCollapsed(next: boolean): void {
    collapsed = next;
    card.hidden = collapsed;
    compact.hidden = !collapsed;
    el.classList.toggle('is-collapsed', collapsed);
    compact.setAttribute('aria-expanded', String(!collapsed));
    if (plan) render();
    fitOverviewToHost(el);
  }

  // ── Drag to reposition ──
  // The floating widget can be grabbed (the card body or the compact circle)
  // and moved anywhere inside the chat window. Pointer events cover mouse +
  // touch; a real drag (>4px) suppresses the click that would otherwise
  // collapse/expand the card, so dragging the circle never misfires a toggle.
  let dragState: { pointerId: number; handle: HTMLElement; startX: number; startY: number; origLeft: number; origTop: number; moved: boolean } | null = null;
  let justDragged = false;
  let lastDragPos: { left: number; top: number } | null = null;

  const clampDrag = (left: number, top: number): { left: number; top: number } => {
    // Clamp inside the anchor host (#view-container) so the card can't be
    // flung off-screen; without a host (unit tests) pass raw values through.
    const hostRect = el.parentElement?.getBoundingClientRect?.();
    if (!hostRect) return { left, top };
    const maxLeft = Math.max(0, hostRect.width - el.offsetWidth);
    const maxTop = Math.max(0, hostRect.height - el.offsetHeight);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  };

  const startDrag = (ev: PointerEvent, handle: HTMLElement): void => {
    if (ev.button !== 0 || dragState) return;
    justDragged = false;
    dragState = {
      pointerId: ev.pointerId,
      handle,
      startX: ev.clientX,
      startY: ev.clientY,
      origLeft: el.offsetLeft,
      origTop: el.offsetTop,
      moved: false,
    };
  };

  const moveDrag = (ev: PointerEvent): void => {
    const s = dragState;
    if (!s || ev.pointerId !== s.pointerId) return;
    const dx = ev.clientX - s.startX;
    const dy = ev.clientY - s.startY;
    if (!s.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      s.moved = true;
      // Engage pointer capture only once the drag is real. A plain click on
      // the close button or the compact circle never captures, so its click
      // keeps its natural target — capturing on every pointerdown would
      // retarget the × click onto the card and kill the collapse button.
      el.classList.add('dragging');
      el.style.right = 'auto';
      s.handle.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    }
    if (s.moved) {
      const clamped = clampDrag(s.origLeft + dx, s.origTop + dy);
      lastDragPos = clamped;
      el.style.left = `${clamped.left}px`;
      el.style.top = `${clamped.top}px`;
    }
  };

  const endDrag = (ev: PointerEvent): void => {
    const s = dragState;
    if (!s || ev.pointerId !== s.pointerId) return;
    dragState = null;
    justDragged = s.moved;
    el.classList.remove('dragging');
    if (s.moved && lastDragPos) {
      try {
        const key = positionSession ? `${OVERVIEW_POS_KEY}:${positionSession}` : OVERVIEW_POS_KEY;
        localStorage.setItem(key, JSON.stringify(lastDragPos));
      } catch {
        // Storage unavailable (private mode): the position just isn't remembered.
      }
    }
  };

  const bindDrag = (handle: HTMLElement): void => {
    handle.addEventListener('pointerdown', (ev) => startDrag(ev, handle));
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  };
  bindDrag(card);
  bindDrag(compact);

  close.addEventListener('click', () => { if (!justDragged) setCollapsed(true); });
  compact.addEventListener('click', () => { if (!justDragged) setCollapsed(false); });

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
    const currentStep = status === 'complete'
      ? total
      : Math.max(1, Math.min(state.currentPlan, total));
    compactStep.textContent = String(currentStep);
    compactStep.setAttribute('aria-label', `当前第 ${currentStep} 步，共 ${total} 步`);
    if (status === 'complete') {
      card.classList.add('complete');
      compact.classList.add('complete');
    } else if (status === 'waiting') {
      card.classList.add('awaiting');
      compact.classList.add('awaiting');
    } else {
      card.classList.add('active');
      compact.classList.add('active');
    }
    compact.title = collapsed
      ? `展开执行大纲（当前第 ${currentStep} 步，共 ${total} 步）`
      : '收起执行大纲';
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
    fitOverviewToHost(el);
  };

  return {
    el,
    show: (next, nextStatus = 'active', currentPlan = 1, currentTodo = 1, todoLabel = '') => {
      apply(next, nextStatus, currentPlan, currentTodo, todoLabel);
    },
    update: (next, nextStatus = 'active', currentPlan = 1, currentTodo = 1, todoLabel = '') => {
      apply(next, nextStatus, currentPlan, currentTodo, todoLabel);
    },
    setStatus: (next) => {
      status = next;
      render();
      el.hidden = false;
      fitOverviewToHost(el);
    },
    setCurrent: (planNumber, todoNumber, todoLabel) => {
      state.currentPlan = planNumber;
      if (todoNumber !== undefined) state.currentTodo = todoNumber;
      if (todoLabel !== undefined) state.todoLabel = todoLabel;
      render();
      fitOverviewToHost(el);
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

// ── Dragged-position persistence ──
// The floating widget is a global singleton; once the user parks it somewhere,
// that spot is remembered per conversation (keyed by sessionId) and restored
// on the next open / session switch, clamped to the current host size so a
// shrunken window can't leave it off-screen. Sessions without a saved position
// fall back to the default corner.
const OVERVIEW_POS_KEY = 'pure_plan_overview_pos';

let positionSession: string | null = null;

export function fitOverviewToHost(el: HTMLElement): void {
  const host = el.parentElement;
  const hostRect = host?.getBoundingClientRect?.();
  if (!hostRect || !Number.isFinite(hostRect.width) || !Number.isFinite(hostRect.height)) return;
  if (!el.offsetWidth || !el.offsetHeight) return;

  const maxLeft = Math.max(0, hostRect.width - el.offsetWidth);
  const maxTop = Math.max(0, hostRect.height - el.offsetHeight);
  const left = Math.min(Math.max(0, el.offsetLeft), maxLeft);
  const top = Math.min(Math.max(0, el.offsetTop), maxTop);
  const needsInlinePosition = el.style.left !== '' || el.style.right === 'auto'
    || left !== el.offsetLeft || top !== el.offsetTop;
  if (needsInlinePosition) {
    el.style.right = 'auto';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  const card = el.querySelector<HTMLElement>('.plan-overview-card');
  const steps = el.querySelector<HTMLElement>('.plan-overview-steps');
  if (!card || card.hidden || !steps) return;
  const availableHeight = Math.max(0, hostRect.height - top - 12);
  card.style.maxHeight = `${availableHeight}px`;
  const head = el.querySelector<HTMLElement>('.plan-overview-head');
  const headHeight = head?.offsetHeight ?? 0;
  steps.style.maxHeight = `${Math.max(0, availableHeight - headHeight - 14)}px`;
}

/** Point the outline's position memory at a session. Call on session switch so
 * the widget re-applies that session's remembered spot (or resets to the
 * default corner when the session never had one). */
export function setOverviewPositionSession(sessionId: string | null): void {
  positionSession = sessionId;
  if (overview) restoreStoredPosition(overview.el, sessionId);
}

export function restoreStoredPosition(el: HTMLElement, sessionId?: string | null): void {
  // Reset any inline placement first: switching to a session without a saved
  // position must return the widget to its default corner, never inherit the
  // previous session's spot.
  el.style.left = '';
  el.style.top = '';
  el.style.right = '';
  let raw: string | null = null;
  try {
    const key = sessionId ? `${OVERVIEW_POS_KEY}:${sessionId}` : OVERVIEW_POS_KEY;
    raw = localStorage.getItem(key);
  } catch {
    return; // storage unavailable — keep the default corner
  }
  if (!raw) return;
  let pos: { left?: unknown; top?: unknown };
  try {
    pos = JSON.parse(raw) as { left?: unknown; top?: unknown };
  } catch {
    return; // corrupt entry must never break the outline
  }
  if (typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
  const hostRect = el.parentElement?.getBoundingClientRect?.();
  let left = pos.left;
  let top = pos.top;
  if (hostRect) {
    const maxLeft = Math.max(0, hostRect.width - el.offsetWidth);
    const maxTop = Math.max(0, hostRect.height - el.offsetHeight);
    left = Math.min(Math.max(0, left), maxLeft);
    top = Math.min(Math.max(0, top), maxTop);
  }
  el.style.right = 'auto';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** Get (and lazily create) the singleton floating overview card. */
export function planOverview(): PlanOverviewHandle {
  if (overview) return overview;
  const handle = createPlanOverview();
  // Anchor it to the app shell so it outlives per-transcript DOM clears.
  const host = document.getElementById('view-container') ?? document.body;
  host.appendChild(handle.el);
  // Remember where the user parked the widget across launches / sessions.
  restoreStoredPosition(handle.el, positionSession);
  const fit = () => fitOverviewToHost(handle.el);
  if (typeof window !== 'undefined') window.addEventListener('resize', fit);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const chatView = document.getElementById('chat-view');
    if (chatView) observer.observe(chatView);
  }
  overview = handle;
  return handle;
}
