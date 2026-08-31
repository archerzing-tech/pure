import type { SessionAgentActivity } from './store';

export interface AgentActivityPanelHandle {
  el: HTMLElement;
  update(activities: SessionAgentActivity[], options?: { historical?: boolean }): void;
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

function stateLabel(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) return '上次未完成';
  if (activity.lifecycle === 'tool_running') return '执行工具';
  if (activity.lifecycle === 'cancelled') return '已取消';
  if (activity.lifecycle === 'done' || activity.status === 'done') return '已完成';
  if (activity.lifecycle === 'failed' || activity.status === 'failed') return '失败';
  if (activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return '超时';
  switch (activity.state) {
    case 'THINK': return '思考中';
    case 'ACT': return '执行中';
    case 'OBSERVE': return '观察中';
    case 'VERIFY': return '验证中';
    case 'TERMINATE': return '收尾中';
    default: return '工作中';
  }
}

function stateClass(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) return 'historical';
  if (activity.lifecycle === 'cancelled') return 'cancelled';
  if (activity.lifecycle === 'done' || activity.status === 'done') return 'done';
  if (activity.lifecycle === 'failed' || activity.status === 'failed') return 'failed';
  if (activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return 'timed-out';
  return 'running';
}

function activityText(activity: SessionAgentActivity, historical: boolean): string {
  if (historical && isAgentActivityActive(activity)) {
    return activity.toolName ? `上次停留在工具：${activity.toolName}` : '上次停留在该任务阶段';
  }
  if (activity.lifecycle === 'cancelled' || activity.status === 'cancelled') return '本次协作已取消';
  if (activity.lifecycle === 'done' || activity.status === 'done') return activity.output?.trim() || '已完成并返回结果';
  if (activity.lifecycle === 'failed' || activity.status === 'failed' || activity.lifecycle === 'timed_out' || activity.status === 'timed_out') return activity.error?.trim() || '本次协作未完成';
  if (activity.toolName) return `正在处理工具：${activity.toolName}`;
  return activity.inputSnippet?.trim() || '正在处理分配的任务';
}

export function createAgentActivityPanel(): AgentActivityPanelHandle {
  const el = document.createElement('section');
  el.className = 'agent-console';
  el.setAttribute('aria-label', '任务协作控制台');
  el.dataset.agentActivityPanel = 'true';

  const header = document.createElement('div');
  header.className = 'agent-console-head';
  const title = document.createElement('strong');
  title.className = 'agent-console-title';
  const count = document.createElement('span');
  count.className = 'agent-console-count';
  header.append(title, count);

  const activeList = document.createElement('div');
  activeList.className = 'agent-console-active-list';
  const history = document.createElement('details');
  history.className = 'agent-console-history';
  const historySummary = document.createElement('summary');
  historySummary.className = 'agent-console-history-summary';
  const historyCount = document.createElement('span');
  historySummary.append('已结束', historyCount);
  const historyList = document.createElement('div');
  historyList.className = 'agent-console-history-list';
  history.append(historySummary, historyList);
  el.append(header, activeList, history);

  const rows = new Map<string, { row: HTMLElement; status: HTMLElement; action: HTMLElement; note: HTMLElement }>();

  const update = (activities: SessionAgentActivity[], options: { historical?: boolean } = {}): void => {
    const historical = options.historical === true;
    const visible = activities.filter(activity => activity.callId);
    const active = visible.filter(isAgentActivityActive);
    const completed = visible.filter(activity => !isAgentActivityActive(activity));
    const sortedActive = [...active].sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
    const sortedCompleted = [...completed].sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));

    title.textContent = historical ? '上次协作摘要' : '任务协作控制台';
    count.textContent = historical
      ? `${visible.length} 个 agent`
      : active.length > 0 ? `${active.length} 个 agent 正在工作 · 共 ${visible.length} 个` : `${visible.length} 个 agent · 本轮已结束`;
    historyCount.textContent = `（${completed.length}）`;
    history.hidden = completed.length === 0;
    activeList.replaceChildren();

    const renderRow = (activity: SessionAgentActivity, parent: HTMLElement): void => {
      let entry = rows.get(activity.callId);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'agent-activity-agent';
        row.dataset.callId = activity.callId;
        const identity = document.createElement('div');
        identity.className = 'agent-activity-identity';
        const dot = document.createElement('span');
        dot.className = 'agent-activity-dot';
        dot.setAttribute('aria-hidden', 'true');
        const name = document.createElement('strong');
        name.className = 'agent-activity-name';
        const role = document.createElement('span');
        role.className = 'agent-activity-role';
        identity.append(dot, name, role);
        const status = document.createElement('span');
        status.className = 'agent-activity-status';
        const action = document.createElement('div');
        action.className = 'agent-activity-action';
        const note = document.createElement('div');
        note.className = 'agent-activity-note';
        row.append(identity, status, action, note);
        entry = { row, status, action, note };
        rows.set(activity.callId, entry);
      }
      entry.row.className = `agent-activity-agent agent-activity-agent--${stateClass(activity, historical)}`;
      const name = entry.row.querySelector<HTMLElement>('.agent-activity-name');
      const role = entry.row.querySelector<HTMLElement>('.agent-activity-role');
      if (name) name.textContent = activity.agentName;
      if (role) role.textContent = activity.agentRole || '';
      entry.status.textContent = stateLabel(activity, historical);
      entry.action.textContent = activityText(activity, historical);
      entry.note.textContent = activity.inputSnippet && !historical && isAgentActivityActive(activity)
        ? `任务：${activity.inputSnippet}`
        : activity.durationMs ? `耗时 ${Math.max(0, Math.round(activity.durationMs / 1000))} 秒` : '';
      entry.row.title = activity.output || activity.error || activity.inputSnippet || '';
      parent.appendChild(entry.row);
    };

    for (const activity of sortedActive) renderRow(activity, activeList);
    historyList.replaceChildren();
    for (const activity of sortedCompleted) renderRow(activity, historyList);
  };

  return { el, update };
}
