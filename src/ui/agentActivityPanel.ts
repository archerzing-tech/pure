import type { SessionAgentActivity } from './store';

export interface AgentActivityPanelHandle {
  el: HTMLElement;
  update(activities: SessionAgentActivity[], options?: { historical?: boolean; sessionId?: string }): void;
}

/** 空间门阈值（工作台设计 §2，2026-11-12 定案）：窗口 minWidth 1000，
 *  1000–1080 区间 rail 要占掉转写 ~11% 的宽度——藏优于挤。 */
export const AGENT_RAIL_MIN_VIEWPORT = 1080;

/** 空间门谓词（纯函数，测试不碰 DOM）：任一条件命中即整条 rail 让位——
 *  ① 视口宽度不足；② #context-panel 展开（右侧被上下文面板占据，
 *  z 30 > rail z 18，现状是叠压，改让位）。只藏不卸：隐藏期间 rail 照常
 *  收事件、照常更新数据，只是不画。 */
export function agentRailSpaceGateHit(innerWidth: number, contextPanelExpanded: boolean): boolean {
  return innerWidth < AGENT_RAIL_MIN_VIEWPORT || contextPanelExpanded;
}

/** The rail renders the badge / name / start time only — `output` and
 *  `toolTrace` ride along for the session snapshot and are never displayed.
 *  Bound them at the single funnel that writes into the host's activity list:
 *  an unbounded `output` (a subagent's ENTIRE final answer) plus one trace entry
 *  per tool call made the persisted payload grow with how much a delegation
 *  produced instead of how many delegations ran, and the whole list is cloned
 *  and re-serialized into storage on every save. */
// 同界导出给工作台（显示边界 = 存储边界，工作台设计 §3.5）。
export const MAX_ACTIVITY_OUTPUT_CHARS = 2_000;
export const MAX_ACTIVITY_TRACE_ENTRIES = 20;

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
    // 第 2 期第四刀：自愈重试中的支仍在干活——它只是在自己纠错，不能被
    // 归进已完成队列（那会把亮灯的卡片当死卡）。
    || activity.lifecycle === 'retrying'
    || (!activity.lifecycle && (!activity.status || activity.status === 'running'));
}

/** 状态类名判定（rail 卡与工作台共用同一状态语汇——零新视觉语汇，
 *  工作台设计 §3.4）。historical 会话里仍亮着的卡归为 paused（快照不再动）。 */
export function stateClass(activity: SessionAgentActivity, historical: boolean): string {
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
  /** 刀 3（工作台设计 §3.3）：卡片可点——运行中/完成/失败卡都开放，
   *  点击进 Agent 工作台（callId 寻址）。四行卡片契约不动（2026-11-12 id 拆独立行）：不加状态文字，
   *  可点性走视觉（cursor + hover 抬升 + 尾部 ›，见 styles.css）。 */
  hooks?: { onOpenAgent?: (callId: string) => void },
): AgentActivityPanelHandle {
  const el = document.createElement('aside');
  el.className = 'agent-activity-rail';
  el.setAttribute('aria-label', '多 agent 活动');
  el.dataset.agentActivityRail = 'true';

  // No rail header (the "本轮协作 / 协作现场" block): the cards themselves are
  // the entire UI — a header only added a second surface covering the chat.
  // The session id chip (2026-09-23) is retired (2026-11-12 user request):
  // the id has no business on the main window's top-right corner.
  const list = document.createElement('div');
  list.className = 'agent-activity-list';
  el.append(list);

  const rows = new Map<string, {
    row: HTMLElement;
    badge: HTMLElement;
    name: HTMLElement;
    idline: HTMLElement;
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
    const wanted = new Set(ordered.map((activity) => activity.callId));
    // Same agent delegated N times used to render numbered instances
    // (ui_designer（1）（2）…) — the user found the suffixes noise, so cards
    // show the bare name again; instanceNo stays in the stored activity for
    // dispatch-order bookkeeping only.

    // A5（2026-11-13 性能审计）：结构只在「成员或顺序真的变了」时才动。子 agent
    // 事件 5–20Hz，旧实现每拍先 list.replaceChildren() 再逐卡 appendChild——
    // 每拍 O(N) 摘挂一遍，还会把正在跑的呼吸/重试脉冲动画从头重启（观感上的
    // 「闪一下」）。下面只 patch 内容，位置统一交给末尾的最小移动。
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
        // 刀 3：整卡可点进工作台。click 只挂一次（卡 DOM 常驻复用），
        // callId 从 dataset 读——卡的 callId 永不变化。
        if (hooks?.onOpenAgent) {
          row.classList.add('agent-worker--clickable');
          const callId = activity.callId;
          row.addEventListener('click', () => hooks.onOpenAgent?.(callId));
        }
        // Four rows, per the card contract: the "Agent" badge (cyan = an
        // active worker), the machine name (+ instance number when the same
        // agent was delegated more than once), the run id on its own line,
        // and the start time. No status text, no action lines — state is
        // conveyed by the badge color and the card's state class.
        const badge = document.createElement('span');
        badge.className = 'agent-worker-badge';
        badge.textContent = 'Agent';
        const name = document.createElement('div');
        name.className = 'agent-worker-name';
        const idline = document.createElement('div');
        idline.className = 'agent-worker-idline';
        idline.hidden = true;
        const time = document.createElement('div');
        time.className = 'agent-worker-time';
        row.append(badge, name, idline, time);
        entry = { row, badge, name, idline, time };
        rows.set(activity.callId, entry);
      }
      // 第 2 期第四刀：分支事件在轨道卡上亮灯——续跑带一个安静的强调色，
      // 自愈重试带一个脉冲（活性不靠文字，守住四行的卡片契约（名字、id 各占一行））。
      const retrying = activeNow && (activity.attempt ?? 0) > 0;
      // 整串重写必须带 --clickable（2026-11-12 真机反馈：hover 没有手型）——
      // 它只在首次创建时挂（170 行），这里的每次刷新若不补回，第一拍 update
      // 就把手型抹掉；click 监听还在，卡成了「能点但不像能点」。
      // P1-2b（2026-11-13 性能审计）：以下全部先比较再写——子 agent 事件
      // 5–20Hz，绝大多数拍的状态/名字/id/时间都没变，无差别重写文本节点
      // 与 className 让每拍都白付一次样式失效与布局。
      const wantClass = `agent-worker agent-worker--${state}`
        + (hooks?.onOpenAgent ? ' agent-worker--clickable' : '')
        + (entering ? ' agent-worker--entering' : '')
        + (retrying ? ' agent-worker--retrying' : '')
        + (activity.resumed ? ' agent-worker--resumed' : '');
      if (entry.row.className !== wantClass) entry.row.className = wantClass;
      // Row 2: the machine id in FULL (web_searcher / code_reviewer / …) —
      // ellipsized since the 2026-11-12 rail narrowing (wrap would blow the
      // narrow card's height budget; the exact agent still shows in the
      // workbench and the row title).
      if (entry.name.textContent !== activity.agentName) entry.name.textContent = activity.agentName;
      // Row 3: the run id on its OWN line (2026-11-12 用户反馈：收窄后名字行
      // 放不下 id chip，被省略号截掉半个) — every agent stays individually
      // quotable when something goes wrong ("ag-1a2b3c4d 报错了").
      const wantIdHidden = !activity.agentId;
      if (entry.idline.hidden !== wantIdHidden || (!wantIdHidden && entry.idline.textContent !== activity.agentId)) {
        entry.idline.replaceChildren();
        if (activity.agentId) {
          const idChip = document.createElement('span');
          idChip.className = 'agent-worker-id';
          idChip.textContent = activity.agentId;
          idChip.title = 'Agent 运行 ID：报错或异常时引用它定位这个 agent';
          entry.idline.append(idChip);
          entry.idline.hidden = false;
        } else {
          entry.idline.hidden = true;
        }
      }
      const wantTitle = [
        activity.agentRole || activity.agentName,
        activity.resumed ? '续跑（命中存档断点）' : '',
        retrying ? `自愈重试第 ${activity.attempt} 次` : '',
      ].filter(Boolean).join(' · ');
      if (entry.row.title !== wantTitle) entry.row.title = wantTitle;
      const wantClock = startedClock(activity.startedAt);
      if (entry.time.textContent !== wantClock) entry.time.textContent = wantClock;
    }

    // 清掉本轮名单里已经没有的卡（会话切换已在上面整表重置，这里只管成员
    // 收缩：bash_executor 过滤、任务范围收窄）。
    for (const [callId, entry] of rows) {
      if (wanted.has(callId)) continue;
      entry.row.remove();
      rows.delete(callId);
    }

    // 最小移动：已就位的节点原地不动（不摘不挂 → 动画不重启），只有错位的
    // 才 insertBefore；新卡在插入时才开始播 --entering。
    let cursor: ChildNode | null = list.firstChild;
    for (const activity of ordered) {
      const node = rows.get(activity.callId)?.row;
      if (!node) continue;
      if (node === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(node, cursor);
    }
  };

  return { el, update };
}
