import type { SessionAgentActivity } from './store';

export interface AgentActivityPanelHandle {
  el: HTMLElement;
  update(activities: SessionAgentActivity[], options?: { historical?: boolean; sessionId?: string }): void;
}

export function mergeAgentActivity(
  previous: SessionAgentActivity | undefined,
  update: Partial<SessionAgentActivity> & Pick<SessionAgentActivity, 'callId' | 'agentName'>,
): SessionAgentActivity {
  if (previous?.sequence !== undefined && update.sequence !== undefined && update.sequence <= previous.sequence) {
    return previous;
  }
  return {
    ...(previous ?? {}),
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
    callId: update.callId,
    agentName: update.agentName,
  };
}

export function isAgentActivityActive(activity: SessionAgentActivity): boolean {
  return activity.lifecycle === 'started'
    || activity.lifecycle === 'tool_running'
    || activity.lifecycle === 'observing'
    || activity.lifecycle === 'verifying'
    || (!activity.lifecycle && (!activity.status || activity.status === 'running'));
}

function stateClass(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) return 'paused';
  if (activity.lifecycle === 'cancelled') return 'cancelled';
  if (activity.lifecycle === 'done' || activity.status === 'done') return 'done';
  if (activity.lifecycle === 'failed' || activity.status === 'failed') return 'failed';
  if (activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return 'timed-out';
  return 'active';
}

/** Live-mode dismissal: a terminal card dwells so its end state is readable,
 * then fades away — the card's job is "who is working, since when", not a
 * permanent log. The historical trace always keeps every card. */
const DISMISS_DWELL_MS = 2000;
const DISMISS_FADE_MS = 400;
const TERMINAL_WORKER_STATES = new Set(['done', 'failed', 'timed-out', 'cancelled']);

/** 介入时间 — the wall-clock moment the agent joined, HH:MM:SS. */
function startedClock(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createAgentActivityPanel(
  initialSessionId = '',
  options: { dismissDwellMs?: number; dismissFadeMs?: number } = {},
): AgentActivityPanelHandle {
  const dwellMs = options.dismissDwellMs ?? DISMISS_DWELL_MS;
  const fadeMs = options.dismissFadeMs ?? DISMISS_FADE_MS;
  const el = document.createElement('aside');
  el.className = 'agent-activity-rail';
  el.setAttribute('aria-label', '多 agent 活动');
  el.dataset.agentActivityRail = 'true';

  const header = document.createElement('header');
  header.className = 'agent-activity-rail-header';
  const headingGroup = document.createElement('div');
  headingGroup.className = 'agent-activity-rail-heading';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-activity-rail-eyebrow';
  eyebrow.textContent = 'LIVE / MULTI-AGENT';
  const title = document.createElement('strong');
  title.className = 'agent-activity-rail-title';
  headingGroup.append(eyebrow, title);
  const count = document.createElement('span');
  count.className = 'agent-activity-rail-count';
  header.append(headingGroup, count);

  const list = document.createElement('div');
  list.className = 'agent-activity-list';
  el.append(header, list);

  const rows = new Map<string, {
    row: HTMLElement;
    badge: HTMLElement;
    name: HTMLElement;
    time: HTMLElement;
  }>();
  const activeCallIds = new Set<string>();
  // Live-mode dismiss bookkeeping: a card whose work has ended dwells 2s,
  // fades, then leaves the DOM AND the render set — its activity may keep
  // arriving in the source stream, and it must not re-materialize.
  const dismissedCallIds = new Set<string>();
  const leavingCallIds = new Set<string>();
  const dismissTimers = new Map<string, number>();
  let sessionId = initialSessionId;

  const clearDismissals = (): void => {
    for (const timer of dismissTimers.values()) clearTimeout(timer);
    dismissTimers.clear();
    dismissedCallIds.clear();
    leavingCallIds.clear();
  };

  const update = (activities: SessionAgentActivity[], options: { historical?: boolean; sessionId?: string } = {}): void => {
    if (options.sessionId !== undefined && options.sessionId !== sessionId) {
      sessionId = options.sessionId;
      rows.clear();
      activeCallIds.clear();
      clearDismissals();
      list.replaceChildren();
    }
    const historical = options.historical === true;
    // Live entry animation is strictly session-local: restored sessions render
    // as static historical cards, and a panel that was fed another session's
    // activities already reset above, so a card can never animate in from a
    // different conversation.
    const animateNewRows = !historical;
    const visible = activities.filter((activity) => activity.callId && !(!historical && dismissedCallIds.has(activity.callId)));
    // Newest active agent on TOP — each new card lands at the top of the
    // stack like an incoming message; older ones push down.
    const active = visible.filter(isAgentActivityActive).sort((a, b) => (b.startedAt ?? b.lastUpdatedAt ?? 0) - (a.startedAt ?? a.lastUpdatedAt ?? 0));
    const completed = visible.filter((activity) => !isAgentActivityActive(activity)).sort((a, b) => (b.startedAt ?? b.lastUpdatedAt ?? 0) - (a.startedAt ?? a.lastUpdatedAt ?? 0));
    const ordered = [...active, ...completed];

    title.textContent = historical ? '协作记录' : active.length > 0 ? '协作现场' : '本轮协作';
    count.textContent = historical
      ? `${visible.length} 个 agent`
      : active.length > 0
        ? `${active.length} 个活动中`
        : `${visible.length} 个已结束`;
    list.replaceChildren();

    for (const activity of ordered) {
      const activeNow = isAgentActivityActive(activity);
      const state = stateClass(activity, historical);
      const entering = activeNow && !activeCallIds.has(activity.callId) && animateNewRows;
      if (activeNow) activeCallIds.add(activity.callId);
      let entry = rows.get(activity.callId);
      if (!entry) {
        const row = document.createElement('article');
        row.className = 'agent-worker';
        row.dataset.callId = activity.callId;
        // Three rows only, per the card contract: the "Agent" badge (cyan =
        // an active worker), the machine name in FULL, and the start time.
        // No status text, no action lines — state is conveyed by the badge
        // color and the card's terminal fade.
        const badge = document.createElement('span');
        badge.className = 'agent-worker-badge';
        badge.textContent = 'Agent';
        const name = document.createElement('div');
        name.className = 'agent-worker-name';
        const time = document.createElement('div');
        time.className = 'agent-worker-time';
        row.append(badge, name, time);
        entry = { row, badge, name, time };
        rows.set(activity.callId, entry);
      }
      const leaving = leavingCallIds.has(activity.callId);
      entry.row.className = `agent-worker agent-worker--${state}${entering ? ' agent-worker--entering' : ''}${leaving ? ' agent-worker--leaving' : ''}`;
      // Row 2: the machine id in FULL (web_searcher / code_reviewer / …) —
      // wraps instead of ellipsizing so the exact agent is always readable.
      entry.name.textContent = activity.agentName;
      entry.row.title = activity.agentRole || activity.agentName;
      entry.time.textContent = startedClock(activity.startedAt);
      list.appendChild(entry.row);

      // Schedule the fade-out the moment a live card reaches a terminal
      // state; the composed className above keeps the leaving class applied
      // across intermediate render ticks.
      if (!historical && !leaving && !dismissTimers.has(activity.callId) && TERMINAL_WORKER_STATES.has(state)) {
        const timer = window.setTimeout(() => {
          dismissTimers.delete(activity.callId);
          const target = rows.get(activity.callId);
          if (!target) return;
          leavingCallIds.add(activity.callId);
          target.row.classList.add('agent-worker--leaving');
          window.setTimeout(() => {
            leavingCallIds.delete(activity.callId);
            dismissedCallIds.add(activity.callId);
            rows.delete(activity.callId);
            target.row.remove();
          }, fadeMs);
        }, dwellMs);
        dismissTimers.set(activity.callId, timer);
      }
    }
  };

  return { el, update };
}
