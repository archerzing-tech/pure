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

function currentAction(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) {
    return activity.toolName ? `上次停留在 ${activity.toolName}` : '上次停留在该任务阶段';
  }
  if (activity.lifecycle === 'cancelled' || activity.status === 'cancelled') return '协作已取消';
  if (activity.lifecycle === 'done' || activity.status === 'done') return '已返回结果';
  if (activity.lifecycle === 'failed' || activity.status === 'failed' || activity.lifecycle === 'timed_out' || activity.status === 'timed_out') {
    return '本次协作未完成';
  }
  if (activity.toolName) return `正在执行 ${activity.toolName}`;
  if (activity.state === 'THINK') return '正在分析任务并决定下一步';
  if (activity.state === 'OBSERVE') return '正在整理刚刚获得的结果';
  if (activity.state === 'VERIFY') return '正在检查结果是否满足要求';
  return '正在处理分配的任务';
}

export function createAgentActivityPanel(initialSessionId = ''): AgentActivityPanelHandle {
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
    role: HTMLElement;
    status: HTMLElement;
    action: HTMLElement;
    duration: HTMLElement;
  }>();
  const activeCallIds = new Set<string>();
  let sessionId = initialSessionId;

  const update = (activities: SessionAgentActivity[], options: { historical?: boolean; sessionId?: string } = {}): void => {
    if (options.sessionId !== undefined && options.sessionId !== sessionId) {
      sessionId = options.sessionId;
      rows.clear();
      activeCallIds.clear();
      list.replaceChildren();
    }
    const historical = options.historical === true;
    // Live entry animation is strictly session-local: restored sessions render
    // as static historical cards, and a panel that was fed another session's
    // activities already reset above, so a card can never animate in from a
    // different conversation.
    const animateNewRows = !historical;
    const visible = activities.filter((activity) => activity.callId);
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
        const role = document.createElement('span');
        role.className = 'agent-worker-role';
        identity.append(dot, name, role);
        const status = document.createElement('span');
        status.className = 'agent-worker-status';
        top.append(identity, status);
        const action = document.createElement('div');
        action.className = 'agent-worker-action';
        const duration = document.createElement('span');
        duration.className = 'agent-worker-duration';
        row.append(top, action, duration);
        entry = { row, name, role, status, action, duration };
        rows.set(activity.callId, entry);
      }
      const state = stateClass(activity, historical);
      entry.row.className = `agent-worker agent-worker--${state}${entering ? ' agent-worker--entering' : ''}`;
      entry.name.textContent = activity.agentName;
      entry.role.textContent = activity.agentRole || '';
      entry.status.textContent = statusLabel(activity, historical);
      entry.action.textContent = currentAction(activity, historical);
      entry.duration.textContent = activity.durationMs ? `${Math.max(0, Math.round(activity.durationMs / 1000))}s` : '';
      entry.row.title = '';
      list.appendChild(entry.row);
    }
  };

  return { el, update };
}
