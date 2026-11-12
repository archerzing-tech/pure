import type { SessionAgentActivity } from './store';
import { isAgentActivityActive, stateClass, MAX_ACTIVITY_OUTPUT_CHARS } from './agentActivityPanel';
import { wireInnerFollowTail, followInnerTail } from './scrollPin';
import { t } from '../shared/i18n';

/**
 * Agent 工作台（2026-11-12 设计定稿 docs/agent-workbench-2026-11.md §3）：
 * 多 agent 协作的整页视图。右侧悬浮卡/委派卡点击进入，Back/Esc 切回。
 *
 * 页面机制照抄 #settings-view：flex 同排 width:0% → .expanded 100%，
 * chat DOM 不卸载、流式照常写进被挤压的 DOM（settings 已验证此路无损）。
 *
 * 性能契约（§3.5，硬约束）：
 * - 打开零 I/O：只读内存里的 SessionAgentActivity 快照；
 * - 外科手术式 patch：对象引用即变更信号（mergeAgentActivity 变更必产新
 *   对象、陈旧必返旧对象），引用没换就整段跳过；trace ≤20 行全量小重建；
 *   output 增量 append 文本节点；禁止 rail 的 replaceChildren 全列重建；
 * - 全开（chat 被挤到 0 宽不可见）时挂起 chat 流式 DOM 渲染（markdown.ts
 *   的 renderGate），数据照收、关闭后下一拍追平——推迟不丢弃；
 * - 1s 计时器仅打开时跑，关闭即停；产出追加靠事件驱动不轮询。
 */

export interface AgentWorkbenchHooks {
  /** 打开工作台前若设置页开着，先收起它（两个整页视图互斥，同占
   *  view-container 的 squeeze 机制）。由 main.ts 注入。 */
  requestCloseSettings?: () => void;
  /** 委派产出全文（2026-11-12 用户定案：对话委派卡=主要内容摘要，
   *  工作台=详情页显示全部——截断后踢去委派卡是死胡同反模式）。实现按
   *  callId 从活会话转写取委派 tool result 原文；未命中（历史会话转写
   *  不在内存等）返回 null，工作台回退 2000 字符存档镜像并如实提示。 */
  getFullOutput?: (callId: string) => string | null;
}

export interface AgentWorkbenchHandle {
  /** 打开并定位到某支 agent（callId 寻址）；callId 不在快照里时落到
   *  第一支，快照为空时显示空态。 */
  open(callId?: string): void;
  close(): void;
  isVisible(): boolean;
  /** funnel 第二消费者入口：与 rail panel.update 同参。打开时外科手术式
   *  patch；关闭时只更新内存快照（open 用），不碰 DOM。会话更替自动关闭。 */
  sync(activities: SessionAgentActivity[], options?: { historical?: boolean; sessionId?: string }): void;
  /** markdown.ts 流式渲染闸：工作台全开 = chat 不可见 = 挂起。半开过渡期
   *  （width 过渡中 chat 还看得见）不挂起。 */
  shouldSuspendChatStreamingRender(): boolean;
}

let singleton: AgentWorkbenchHandle | null = null;
/** 活跃 hooks：模块级持有，initAgentWorkbench 可重复调用更新（单例 DOM
 *  只建一次；测试据此注入不同钩子，主流程仍只 init 一次）。 */
let activeHooks: AgentWorkbenchHooks = {};

/** main.ts 启动时调用一次；chat.ts 经 agentWorkbench() 取用。 */
export function initAgentWorkbench(hooks: AgentWorkbenchHooks): AgentWorkbenchHandle {
  activeHooks = hooks;
  if (!singleton) singleton = createAgentWorkbench();
  return singleton;
}

/** 可能为 null（main.ts 尚未 init）——调用侧全部 ?. 。 */
export function agentWorkbench(): AgentWorkbenchHandle | null {
  return singleton;
}

// ── 呈现语汇 ──────────────────────────────────────────────
// 零新视觉语汇（设计 §3.4）：状态徽标沿用 rail 的 done/failed/active 状态色
// （stateClass 同源）、段落标签复用 .agent-activity-section-label、返回按钮
// 与设置页同款、chip 走 999px pill 语法、字号走现有阶。类名全在 styles.css
// 的 AGENT WORKBENCH 段。

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** rail 同款排序：活跃的按开始时间新→旧置顶，完成的殿后。 */
function orderedAgents(activities: SessionAgentActivity[]): SessionAgentActivity[] {
  const visible = activities.filter((a) => a.callId && a.agentName !== 'bash_executor');
  const startedDesc = (a: SessionAgentActivity, b: SessionAgentActivity): number =>
    (b.startedAt ?? b.lastUpdatedAt ?? 0) - (a.startedAt ?? a.lastUpdatedAt ?? 0);
  return [
    ...visible.filter(isAgentActivityActive).sort(startedDesc),
    ...visible.filter((a) => !isAgentActivityActive(a)).sort(startedDesc),
  ];
}

function createAgentWorkbench(): AgentWorkbenchHandle {
  const view = document.getElementById('agent-view');
  if (!view) throw new Error('#agent-view missing from index.html');

  // ── DOM 骨架（构建一次）──
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'icon-btn agent-wb-back';
  backBtn.setAttribute('data-i18n-title', 'agent.workbench.back.title');
  backBtn.title = t('agent.workbench.back.title', '返回对话 (Esc)');
  backBtn.setAttribute('aria-label', t('agent.workbench.back', '返回对话'));
  backBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

  const heading = document.createElement('div');
  heading.className = 'agent-wb-heading';
  const titleEl = document.createElement('div');
  titleEl.className = 'agent-wb-title';
  const subEl = document.createElement('div');
  subEl.className = 'agent-wb-sub';
  heading.append(titleEl, subEl);

  const statusEl = document.createElement('span');
  statusEl.className = 'agent-wb-status';
  const histEl = document.createElement('span');
  histEl.className = 'agent-wb-historical';
  histEl.textContent = t('agent.workbench.historical', '历史（已归档）');

  const idChip = document.createElement('span');
  idChip.className = 'agent-wb-idchip';
  idChip.addEventListener('click', () => {
    const id = idChip.dataset.id ?? '';
    if (!id) return;
    try { void navigator.clipboard?.writeText(id); } catch { /* 剪贴板不可用时全 id 仍在 title */ }
    idChip.classList.add('copied');
    window.setTimeout(() => idChip.classList.remove('copied'), 1200);
  });

  const header = document.createElement('div');
  header.className = 'agent-wb-header';
  header.append(backBtn, heading, histEl, statusEl, idChip);

  const chips = document.createElement('div');
  chips.className = 'agent-wb-chips';

  const body = document.createElement('div');
  body.className = 'agent-wb-body';

  const emptyEl = document.createElement('div');
  emptyEl.className = 'agent-wb-empty';
  emptyEl.textContent = t('agent.workbench.empty', '没有正在工作的 agent');

  const content = document.createElement('div');
  content.className = 'agent-wb-content';

  // 任务段
  const taskLabel = document.createElement('div');
  taskLabel.className = 'agent-activity-section-label';
  taskLabel.textContent = t('agent.workbench.section.task', '任务');
  const taskCard = document.createElement('div');
  taskCard.className = 'agent-wb-taskcard';
  const taskText = document.createElement('div');
  taskText.className = 'agent-wb-tasktext';
  const taskFlags = document.createElement('div');
  taskFlags.className = 'agent-wb-flags';
  taskCard.append(taskText, taskFlags);
  const taskSection = document.createElement('section');
  taskSection.className = 'agent-wb-section';
  taskSection.append(taskLabel, taskCard);

  // 工作流段
  const traceLabel = document.createElement('div');
  traceLabel.className = 'agent-activity-section-label';
  traceLabel.textContent = t('agent.workbench.section.workflow', '工作流');
  const traceList = document.createElement('div');
  traceList.className = 'agent-wb-trace';
  const traceSection = document.createElement('section');
  traceSection.className = 'agent-wb-section';
  traceSection.append(traceLabel, traceList);

  // 产出段
  const outputLabel = document.createElement('div');
  outputLabel.className = 'agent-activity-section-label';
  outputLabel.textContent = t('agent.workbench.section.output', '产出');
  const outputEl = document.createElement('div');
  outputEl.className = 'agent-wb-output';
  wireInnerFollowTail(outputEl);
  const outputNote = document.createElement('div');
  outputNote.className = 'agent-wb-output-note';
  outputNote.hidden = true;
  const outputSection = document.createElement('section');
  outputSection.className = 'agent-wb-section';
  outputSection.append(outputLabel, outputEl, outputNote);

  content.append(taskSection, traceSection, outputSection);
  body.append(emptyEl, content);
  view.append(header, chips, body);

  backBtn.addEventListener('click', () => api.close());

  // ── 状态 ──
  let activities: SessionAgentActivity[] = [];
  let historical = false;
  let sessionId = '';
  let currentCallId = '';
  let visible = false;
  let fullyOpen = false;
  let focusBeforeOpen: HTMLElement | null = null;
  let elapsedTimer: number | null = null;

  // patch 账（外科手术式：引用没换就跳过）
  let renderedActivity: SessionAgentActivity | null = null;
  let renderedOutputLen = 0;
  let renderedTrace: SessionAgentActivity['toolTrace'] | undefined = undefined;
  let renderedChipsKey = '';

  const chatView = document.getElementById('chat-view');

  const startTimer = (): void => {
    if (elapsedTimer !== null) return;
    elapsedTimer = window.setInterval(() => {
      const cur = activities.find((a) => a.callId === currentCallId);
      if (!cur) return;
      if (isAgentActivityActive(cur)) statusEl.textContent = statusText(cur, true);
    }, 1000);
  };
  const stopTimer = (): void => {
    if (elapsedTimer !== null) { clearInterval(elapsedTimer); elapsedTimer = null; }
  };

  function statusText(a: SessionAgentActivity, withElapsed: boolean): string {
    const cls = stateClass(a, historical);
    const retrying = isAgentActivityActive(a) && (a.attempt ?? 0) > 0;
    let label: string;
    if (cls === 'done') label = `✓ ${t('agent.workbench.status.done', '已完成')}`;
    else if (cls === 'failed') label = `✗ ${t('agent.workbench.status.failed', '失败')}`;
    else if (cls === 'timed-out') label = `✗ ${t('agent.workbench.status.timedOut', '超时')}`;
    else if (cls === 'cancelled') label = `⏹ ${t('agent.workbench.status.cancelled', '已取消')}`;
    else if (cls === 'paused') label = `⏸ ${t('agent.workbench.status.paused', '已暂停')}`;
    else if (retrying) label = `● ${t('agent.workbench.status.retrying', '自愈重试')}${a.attempt ? ` #${a.attempt}` : ''}`;
    else label = `● ${t('agent.workbench.status.running', '运行中')}`;
    if (withElapsed) {
      const elapsed = isAgentActivityActive(a)
        ? Date.now() - (a.startedAt ?? a.lastUpdatedAt ?? Date.now())
        : a.durationMs;
      const e = fmtElapsed(elapsed ?? 0);
      if (e) label += ` · ${e}`;
    }
    return label;
  }

  /** 全开判定：width 过渡走完（transitionend）才算——半开期 chat 还看得见，
   *  流式照常画（§3.5：半开过渡期不挂起）。 */
  view.addEventListener('transitionend', (e) => {
    if (e.target !== view || e.propertyName !== 'width') return;
    fullyOpen = visible;
  });

  function buildChips(): void {
    const ordered = orderedAgents(activities);
    const key = ordered.map((a) => `${a.callId}:${isAgentActivityActive(a) ? 1 : 0}`).join('|');
    if (key === renderedChipsKey) return;
    renderedChipsKey = key;
    chips.replaceChildren();
    chips.hidden = ordered.length === 0;
    for (const a of ordered) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'agent-wb-chip';
      chip.dataset.callId = a.callId;
      const dot = document.createElement('span');
      dot.className = `agent-wb-chip-dot state-${stateClass(a, historical)}`;
      chip.append(dot, document.createTextNode(a.agentName));
      if (a.callId === currentCallId) chip.classList.add('active');
      chip.addEventListener('click', () => setCurrent(a.callId));
      chips.appendChild(chip);
    }
    if (ordered.length > 0 && !ordered.some((a) => a.callId === currentCallId)) {
      setCurrent(ordered[0].callId);
    }
  }

  function setCurrent(callId: string): void {
    if (currentCallId === callId) return;
    currentCallId = callId;
    renderedActivity = null; // 强制整段重patch
    renderedOutputLen = 0;
    renderedTrace = undefined;
    outputEl.replaceChildren();
    outputEl.scrollTop = 0;
    traceList.replaceChildren(); // 空轨迹的 agent 不能残留上一位的段
    patchCurrent();
    buildChips();
  }

  function patchCurrent(): void {
    const cur = activities.find((a) => a.callId === currentCallId) ?? null;
    emptyEl.hidden = activities.length > 0;
    content.hidden = cur === null;
    chips.hidden = orderedAgents(activities).length === 0;
    if (!cur) return;
    buildChips();
    if (cur === renderedActivity) return; // 引用没换 = 无变更，零 DOM

    // 头部
    titleEl.textContent = cur.agentName + (cur.instanceNo && cur.instanceNo > 1 ? `（${cur.instanceNo}）` : '');
    subEl.textContent = cur.agentRole ?? '';
    subEl.hidden = !cur.agentRole;
    histEl.hidden = !historical;
    statusEl.textContent = statusText(cur, true);
    statusEl.className = `agent-wb-status st-${stateClass(cur, historical)}`;
    idChip.textContent = cur.agentId ?? '';
    idChip.dataset.id = cur.agentId ?? '';
    idChip.hidden = !cur.agentId;
    idChip.title = cur.agentId ? t('agent.workbench.idchip.title', 'Agent 运行 ID（点击复制）') : '';

    // 概要段
    taskText.textContent = cur.inputSnippet || t('agent.workbench.noTask', '（无任务描述）');
    taskFlags.replaceChildren();
    if (cur.resumed) {
      const f = document.createElement('span');
      f.className = 'agent-wb-flag flag-resumed';
      f.textContent = t('agent.workbench.resumed', '续跑（命中存档断点）');
      taskFlags.appendChild(f);
    }
    if (isAgentActivityActive(cur) && (cur.attempt ?? 0) > 0) {
      const f = document.createElement('span');
      f.className = 'agent-wb-flag flag-retry';
      f.textContent = `${t('agent.workbench.status.retrying', '自愈重试')} #${cur.attempt}`;
      taskFlags.appendChild(f);
    }
    if (cur.error) {
      const f = document.createElement('div');
      f.className = 'agent-wb-error';
      f.textContent = cur.error;
      taskFlags.appendChild(f);
    }
    taskFlags.hidden = !taskFlags.hasChildNodes();

    // 工作流段：trace ≤20 行全量小重建（§3.5 允许的常数级重建）
    const trace = cur.toolTrace;
    if (trace !== renderedTrace) {
      renderedTrace = trace;
      traceList.replaceChildren();
      traceList.classList.remove('agent-wb-placeholder');
      if (!trace?.length) {
        traceList.classList.add('agent-wb-placeholder');
        traceList.textContent = t('agent.workbench.noTrace', '（暂无工具轨迹）');
      } else {
        for (const entry of trace) {
          const line = document.createElement('div');
          line.className = 'agent-wb-trace-line';
          const glyph = document.createElement('span');
          glyph.className = `agent-wb-trace-glyph ts-${entry.status}`;
          glyph.textContent = entry.status === 'completed' ? '✓' : entry.status === 'failed' ? '✗' : '●';
          line.append(glyph, document.createTextNode(entry.name + (entry.args ? `(${entry.args})` : '()')));
          traceList.appendChild(line);
        }
      }
    }

    // 产出段：全文优先（2026-11-12 用户定案：工作台=详情页显示全部产出，
    // 委派卡=主要内容摘要）。全文按 callId 从活会话转写的委派 tool result
    // 取（activeHooks.getFullOutput）；未命中（历史会话等）回退 2000 字符存档
    // 镜像，note 如实说明边界——不再引导「跳去委派卡」。
    const stored = cur.output ?? '';
    const full = activeHooks.getFullOutput?.(cur.callId) ?? null;
    const out = full !== null && full.length > stored.length ? full : stored;
    if (out.length > renderedOutputLen && out.startsWith(outputEl.textContent ?? '')) {
      outputEl.appendChild(document.createTextNode(out.slice(renderedOutputLen)));
      renderedOutputLen = out.length;
    } else if (out.length !== renderedOutputLen) {
      outputEl.replaceChildren(document.createTextNode(out));
      renderedOutputLen = out.length;
    }
    // 截断提示只在「确实拿不到全文」时出现（历史回退场景）；全文可达时
    // 工作台就是终点，任何「去别处看」的引导都是死胡同。
    const clipped = full === null && out.length >= MAX_ACTIVITY_OUTPUT_CHARS;
    outputNote.replaceChildren();
    outputNote.hidden = !clipped;
    if (clipped) {
      outputNote.append(
        document.createTextNode(t('agent.workbench.truncated', '历史会话仅保留产出前 2000 字符。')),
      );
    }
    outputEl.classList.toggle('streaming', isAgentActivityActive(cur));
    followInnerTail(outputEl);

    renderedActivity = cur;
  }

  const api: AgentWorkbenchHandle = {
    open(callId) {
      activeHooks.requestCloseSettings?.();
      if (orderedAgents(activities).length === 0) currentCallId = '';
      else if (!callId || !activities.some((a) => a.callId === callId)) {
        currentCallId = orderedAgents(activities)[0].callId;
      } else currentCallId = callId;
      renderedActivity = null;
      renderedOutputLen = 0;
      renderedTrace = undefined;
      outputEl.replaceChildren();
      if (!visible) {
        visible = true;
        focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        view.classList.add('expanded');
        chatView?.classList.add('squeezed');
        // 工作台全开时程序 chrome 让位：左上/右上角钮与右侧 rail 卡都不显示
        //（2026-11-12 真机反馈：角钮叠在工作台头部上、rail 叠在状态徽标上）。
        setChromeHidden(true);
        startTimer();
      }
      patchCurrent();
    },
    close() {
      if (!visible) return;
      visible = false;
      fullyOpen = false;
      stopTimer();
      view.classList.remove('expanded');
      chatView?.classList.remove('squeezed');
      setChromeHidden(false);
      // settings 同款焦点归还（settings.ts focusBeforeOpen 模式）。
      focusBeforeOpen?.focus();
      focusBeforeOpen = null;
    },
    isVisible() { return visible; },
    shouldSuspendChatStreamingRender() { return visible && fullyOpen; },
    sync(next, options = {}) {
      // 会话更替（挂载路径带着新 sessionId 来）：整页视图跟会话走——关闭。
      if (options.sessionId !== undefined && sessionId !== '' && options.sessionId !== sessionId) {
        api.close();
        renderedChipsKey = '';
      }
      sessionId = options.sessionId ?? sessionId;
      historical = options.historical === true;
      activities = next;
      if (!visible) return; // 关闭态只养快照，零 DOM
      if (activities.filter((a) => a.callId && a.agentName !== 'bash_executor').length === 0) {
        api.close(); // 本会话活动清空（新会话/清除）：没有可看的东西
        return;
      }
      if (currentCallId && !activities.some((a) => a.callId === currentCallId)) {
        currentCallId = orderedAgents(activities)[0]?.callId ?? '';
        renderedActivity = null;
        renderedOutputLen = 0;
        renderedTrace = undefined;
        outputEl.replaceChildren();
        traceList.replaceChildren();
      }
      patchCurrent();
    },
  };

  return api;
}

// ── 委派卡 ↔ 工作台跨链（刀 3）──────────────────────────
// 转写委派卡头部挂「工作台 ↗」小 chip（tool-row-summary 内，stopPropagation
// 不触发展开）。幂等：staged→callId 迁移路径可能重复走到。callId 寻址 =
// 卡上的 data-agent-call-id（chat.ts 创建时挂）。

// 工作台打开期间的 chrome 隐藏：与 rail 的另外两口（hidden attr=挂载权、
// gate-hidden=空间门）正交，任意一口命中都藏、互不覆盖。
// context-panel-reopen 也在列（2026-11-12 用户定案）：右侧侧边栏只属于主
// 对话窗口，工作台页内把手隐去、不可弹出。
function setChromeHidden(hidden: boolean): void {
  for (const sel of ['#sidebar-toggle', '#right-settings-btn', '#context-panel-reopen', '#agent-activity-host']) {
    document.querySelector(sel)?.classList.toggle('wb-chrome-hidden', hidden);
  }
}

export function attachWorkbenchEntry(rowEl: HTMLElement, callId: string): void {
  rowEl.dataset.agentCallId = callId;
  const summary = rowEl.querySelector('.tool-row-summary');
  if (!summary || summary.querySelector('.tool-row-workbench-link')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tool-row-workbench-link';
  btn.textContent = t('agent.workbench.open', '↗');
  btn.title = t('agent.workbench.open.title', '打开 Agent 工作台');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    singleton?.open(callId);
  });
  summary.appendChild(btn);
}
