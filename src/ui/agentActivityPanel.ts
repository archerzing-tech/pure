import type { SessionAgentActivity } from './store';

export interface AgentActivityPanelHandle {
  el: HTMLElement;
  update(activities: SessionAgentActivity[], options?: { historical?: boolean; sessionId?: string }): void;
}

/** The rail renders the badge / name / start time only — `output` and
 *  `toolTrace` ride along for the session snapshot and are never displayed.
 *  Bound them at the single funnel that writes into the host's activity list:
 *  an unbounded `output` (a subagent's ENTIRE final answer) plus one trace entry
 *  per tool call made the persisted payload grow with how much a delegation
 *  produced instead of how many delegations ran, and the whole list is cloned
 *  and re-serialized into storage on every save. */
const MAX_ACTIVITY_OUTPUT_CHARS = 2_000;
const MAX_ACTIVITY_TRACE_ENTRIES = 20;

function boundActivityPayload(activity: SessionAgentActivity): SessionAgentActivity {
  const { output, toolTrace } = activity;
  const boundedOutput = output !== undefined && output.length > MAX_ACTIVITY_OUTPUT_CHARS
    ? output.slice(0, MAX_ACTIVITY_OUTPUT_CHARS)
    : output;
  const boundedTrace = toolTrace !== undefined && toolTrace.length > MAX_ACTIVITY_TRACE_ENTRIES
    ? toolTrace.slice(-MAX_ACTIVITY_TRACE_ENTRIES)
    : toolTrace;
  if (boundedOutput === output && boundedTrace === toolTrace) return activity;
  return {
    ...activity,
    ...(boundedOutput === output ? {} : { output: boundedOutput }),
    ...(boundedTrace === toolTrace ? {} : { toolTrace: boundedTrace }),
  };
}

export function mergeAgentActivity(
  previous: SessionAgentActivity | undefined,
  update: Partial<SessionAgentActivity> & Pick<SessionAgentActivity, 'callId' | 'agentName'>,
): SessionAgentActivity {
  if (previous?.sequence !== undefined && update.sequence !== undefined && update.sequence <= previous.sequence) {
    return previous;
  }
  return boundActivityPayload({
    ...(previous ?? {}),
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
    callId: update.callId,
    agentName: update.agentName,
  });
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
  // 阶段 12: an explicit pause is its own state — visually distinct from a
  // failure, and (unlike historical) resumable.
  if (activity.lifecycle === 'paused' || activity.status === 'paused') return 'paused';
  if (activity.lifecycle === 'cancelled') return 'cancelled';
  if (activity.lifecycle === 'done' || activity.status === 'done') return 'done';
  if (activity.lifecycle === 'failed' || activity.status === 'failed') return 'failed';
  if (activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return 'timed-out';
  return 'active';
}

/** 介入时间 — the wall-clock moment the agent joined, HH:MM:SS. */
function startedClock(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createAgentActivityPanel(
  initialSessionId = '',
): AgentActivityPanelHandle {
  const el = document.createElement('aside');
  el.className = 'agent-activity-rail';
  el.setAttribute('aria-label', '多 agent 活动');
  el.dataset.agentActivityRail = 'true';

  // No rail header (the "本轮协作 / 协作现场" block): the cards themselves are
  // the entire UI — a header only added a second surface covering the chat.
  // The one exception (2026-09-23 user request): the rail must carry the
  // SESSION id, so a card can be quoted together with its conversation
  // ("session_… 的 web_searcher 报错了"). One quiet mono line above the cards —
  // click copies the full id; not a titled section, no second surface.
  const sessionChip = document.createElement('div');
  sessionChip.className = 'agent-activity-session';
  sessionChip.title = '会话 ID（点击复制）';
  sessionChip.addEventListener('click', () => {
    const id = sessionChip.textContent ?? '';
    if (!id) return;
    try {
      void navigator.clipboard?.writeText(id);
    } catch { /* clipboard unavailable — the full id is still in the tooltip */ }
    sessionChip.classList.add('copied');
    sessionChip.title = '已复制会话 ID';
    window.setTimeout(() => {
      sessionChip.classList.remove('copied');
      sessionChip.title = '会话 ID（点击复制）';
    }, 1200);
  });

  const list = document.createElement('div');
  list.className = 'agent-activity-list';
  el.append(sessionChip, list);

  const setSessionId = (id: string): void => {
    sessionChip.textContent = id;
    // No id (brand-new session before its first save) → no empty chip line.
    sessionChip.style.display = id ? '' : 'none';
  };
  setSessionId(initialSessionId);

  const rows = new Map<string, {
    row: HTMLElement;
    badge: HTMLElement;
    name: HTMLElement;
    time: HTMLElement;
  }>();
  const activeCallIds = new Set<string>();
  let sessionId = initialSessionId;

  const update = (activities: SessionAgentActivity[], options: { historical?: boolean; sessionId?: string } = {}): void => {
    if (options.sessionId !== undefined && options.sessionId !== sessionId) {
      sessionId = options.sessionId;
      rows.clear();
      activeCallIds.clear();
      list.replaceChildren();
      setSessionId(sessionId);
    }
    const historical = options.historical === true;
    // Live entry animation is strictly session-local: restored sessions render
    // as static historical cards, and a panel that was fed another session's
    // activities already reset above, so a card can never animate in from a
    // different conversation.
    const animateNewRows = !historical;
    // Tool-like roles never become agent cards: bash_executor IS a tool the
    // model delegates to — showing it as an "agent" blurred the agent/tool
    // boundary for users.
    const visible = activities.filter((activity) =>
      activity.callId
      && activity.agentName !== 'bash_executor');
    // Every dispatched agent keeps its card for the whole task — the roster is
    // the answer to "这轮到底派了几个 agent"。The rail scrolls, and the task
    // scoping (a new top-level task starts a fresh trace) bounds the growth.
    // Newest active agent on TOP — each new card lands at the top of the
    // stack like an incoming message; older ones push down.
    const active = visible.filter(isAgentActivityActive).sort((a, b) => (b.startedAt ?? b.lastUpdatedAt ?? 0) - (a.startedAt ?? a.lastUpdatedAt ?? 0));
    const completed = visible.filter((activity) => !isAgentActivityActive(activity)).sort((a, b) => (b.startedAt ?? b.lastUpdatedAt ?? 0) - (a.startedAt ?? a.lastUpdatedAt ?? 0));
    const ordered = [...active, ...completed];
    // Same agent delegated N times used to render numbered instances
    // (ui_designer（1）（2）…) — the user found the suffixes noise, so cards
    // show the bare name again; instanceNo stays in the stored activity for
    // dispatch-order bookkeeping only.

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
        // an active worker), the machine name (+ instance number when the
        // same agent was delegated more than once), and the start time.
        // No status text, no action lines — state is conveyed by the badge
        // color and the card's state class.
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
      entry.row.className = `agent-worker agent-worker--${state}${entering ? ' agent-worker--entering' : ''}`;
      // Row 2: the machine id in FULL (web_searcher / code_reviewer / …) —
      // wraps instead of ellipsizing so the exact agent is always readable.
      entry.name.replaceChildren();
      entry.name.append(document.createTextNode(activity.agentName));
      // The run id rides the name row as a quiet chip: every agent is
      // individually quotable when something goes wrong ("ag-1a2b3c4d 报错了").
      if (activity.agentId) {
        const idChip = document.createElement('span');
        idChip.className = 'agent-worker-id';
        idChip.textContent = activity.agentId;
        idChip.title = 'Agent 运行 ID：报错或异常时引用它定位这个 agent';
        entry.name.append(idChip);
      }
      entry.row.title = activity.agentRole || activity.agentName;
      entry.time.textContent = startedClock(activity.startedAt);
      list.appendChild(entry.row);
    }
  };

  return { el, update };
}
