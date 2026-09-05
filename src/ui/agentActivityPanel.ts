import type { SessionAgentActivity } from './store';
import { SUBAGENT_ROLE_LABELS } from './planSummary';

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

function statusLabel(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) return '上次中断';
  if (activity.lifecycle === 'tool_running') return '执行工具';
  if (activity.lifecycle === 'observing') return '整理结果';
  if (activity.lifecycle === 'verifying') return '验证结果';
  if (activity.lifecycle === 'cancelled') return '已取消';
  if (activity.lifecycle === 'done' || activity.status === 'done') return '已完成';
  if (activity.lifecycle === 'failed' || activity.status === 'failed') return '失败';
  if (activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return '超时';
  switch (activity.state) {
    case 'THINK': return '分析任务';
    case 'ACT': return '执行中';
    case 'OBSERVE': return '读取结果';
    case 'VERIFY': return '验证中';
    case 'TERMINATE': return '收尾中';
    default: return '准备工作';
  }
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
    name: HTMLElement;
    status: HTMLElement;
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
    const active = visible.filter(isAgentActivityActive).sort((a, b) => (a.startedAt ?? a.lastUpdatedAt ?? 0) - (b.startedAt ?? b.lastUpdatedAt ?? 0));
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
        const top = document.createElement('div');
        top.className = 'agent-worker-top';
        const identity = document.createElement('div');
        identity.className = 'agent-worker-identity';
        const dot = document.createElement('span');
        dot.className = 'agent-worker-dot';
        dot.setAttribute('aria-hidden', 'true');
        const name = document.createElement('strong');
        name.className = 'agent-worker-name';
        identity.append(dot, name);
        const time = document.createElement('span');
        time.className = 'agent-worker-time';
        const status = document.createElement('span');
        status.className = 'agent-worker-status';
        top.append(identity, time, status);
        row.append(top);
        entry = { row, name, status, time };
        rows.set(activity.callId, entry);
      }
      const leaving = leavingCallIds.has(activity.callId);
      entry.row.className = `agent-worker agent-worker--${state}${entering ? ' agent-worker--entering' : ''}${leaving ? ' agent-worker--leaving' : ''}`;
      // Show the localized role name (研究员 / 代码审查员 / …) instead of the
      // raw snake_case tool id — 12px English ids were illegible on the small
      // cards. Unknown / custom roles fall back to the id; the machine name
      // stays available as the row tooltip.
      entry.name.textContent = SUBAGENT_ROLE_LABELS[activity.agentName] ?? activity.agentName;
      entry.row.title = activity.agentName;
      entry.time.textContent = startedClock(activity.startedAt);
      entry.status.textContent = statusLabel(activity, historical);
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
