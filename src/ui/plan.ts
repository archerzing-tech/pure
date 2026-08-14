// src/ui/plan.ts
// v0.1 — Plan review dialog for complex tasks (P1-6).
// Shown before a run when the Planner classifies a task as complex; the user
// can approve (plan injected into the system prompt), skip planning, or cancel.

import type { AnalysisResult, Plan, TaskMode } from '../coding-agent/types';
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showInlineCard } from './inlineCard';
import type { QualityGateCheck, QualityGatePhase, QualityGateStatus } from './projectQualityGate';

export type PlanReviewDecision = 'approve' | 'skip' | 'cancel';

export interface PlanReviewOptions {
  /** Project builds must be approved; ordinary complex tasks may be skipped. */
  allowSkip?: boolean;
  /** This review is a safety checkpoint for a destructive request. */
  riskReview?: boolean;
  /** When aborted (user pressed stop), the dialog resolves as 'cancel' and closes. */
  signal?: AbortSignal;
}

// Serialize concurrent plan reviews (mirrors the permission dialog queue).
let planQueue: Promise<unknown> = Promise.resolve();

export function requestPlanReview(
  analysis: AnalysisResult,
  options: PlanReviewOptions = {},
): Promise<PlanReviewDecision> {
  const run = planQueue.then(() => showPlanDialog(analysis, options));
  planQueue = run.catch(() => {});
  return run;
}

/** Render an approved plan into a system-prompt fragment the LLM must follow.
 * Also instructs the model to write a `## 阶段 n/m` heading at the start of
 * each phase — the chat UI scans for that marker to show which phase of the
 * plan is currently executing. */
export function formatPlanForPrompt(plan: Plan, projectBuild = false, approved = false): string {
  const steps = plan.steps
    .map((s, i) => {
      const substeps = s.todosRequired === false ? '' : (s.substeps ?? [])
        .map((sub, j) => `\n   (${j + 1}) ${sub.action}: ${sub.description}`)
        .join('');
      const todoRule = s.todosRequired === false ? ' [atomic step — no Todo list supplied]' : ' [show a Todo list only when it helps clarify the work]';
      return `${i + 1}. ${s.action}: ${s.description}${todoRule}${substeps}`;
    })
    .join('\n');
  // approved=true means the user has already approved the execution direction,
  // so the first response should begin useful work rather than wait for a second
  // approval. approved=false keeps the planning pause used by auto-detected plans.
  const execution = approved
    ? 'Use the approved plan as a flexible guide. Keep the overall plan and any active Todo list visibly separate. The user has already approved this plan, so start executing immediately. Briefly restate the user request, show the complete top-level plan list once and show a separate Todo list below the plan list for plan 1, then begin the most appropriate next action with real tool calls in this response when execution is approved; do not wait for another approval. Verify the result. When a plan card is active, report meaningful phase/completion progress with the supported markers so the UI can synchronize; markers describe progress only and do not dictate execution granularity. If the task needs information, ask one natural question and pause until the user answers. In later responses, continue with the next appropriate work, verify meaningful results. When a plan card is active, use the supported progress markers so the UI can synchronize; they do not dictate execution granularity. Emit `## 计划 n 已完成` when the plan work has actually been completed and verified' + (projectBuild ? ' (for a project, run the actual project verification command).' : '.') + ' The UI may reflect the completed plan in the separate plan list and activate the next plan. Before the next plan starts, show the updated plan context and continue with the next appropriate work when the execution context allows it. When todosRequired=false, treat the step as atomic unless the task itself reveals a reason to split it. Do not claim a plan or work item is complete without relevant verification evidence. Never claim a work item or plan is complete before its real verification. Use plain language and natural colleague-like sentences around the required markers.'
    : 'Use the approved plan as a flexible guide. Keep the overall plan and any active Todo list visibly separate. First, briefly restate the user request in your own words and say naturally that you will think it through before planning. Then show the complete top-level plan list once and show a separate Todo list below the plan list for plan 1. IMPORTANT: this first planning response is a pause point — do not call tools or change files yet; end by telling the user what you recommend starting with. Only after the user sends the next message may you begin execution. If the task needs information, ask one natural question and pause until the user answers. In continuation responses, continue with the next appropriate work, verify meaningful results. When a plan card is active, use the supported progress markers so the UI can synchronize; they do not dictate execution granularity. Emit `## 计划 n 已完成` when the plan work has actually been completed and verified' + (projectBuild ? ' (for a project, run the actual project verification command).' : '.') + ' The UI may reflect the completed plan in the separate plan list and activate the next plan. Before the next plan starts, show the updated plan context and continue with the next appropriate work when the execution context allows it. When todosRequired=false, treat the step as atomic unless the task itself reveals a reason to split it; respect the current execution context. Do not claim a plan or work item is complete without relevant verification evidence. Never claim a work item or plan is complete before its real verification. Use plain language and natural colleague-like sentences around the required markers.';
  const firstTurn = approved
    ? 'The plan is already approved, so do NOT wait for another go-ahead: restate the request, show the relevant plan context, then start the next appropriate work with real tool calls in this same response. End by reporting what you did and what remains.'
    : 'On the first response after this plan is approved, introduce the relevant plan context without executing tools; end by saying what you recommend starting with.';
  return `\n\n## 整体安排\n${steps}\n${execution} Begin each active plan with an explicit line \"## 计划 n：<正在做什么>\" and close it with \"## 计划 n 已完成\" (for example, \"## 计划 1 已完成\"); keep the numbering consistent with the list above. Keep the plan list and the active Todo list as two separate plain-text lists. The UI uses present markers to reflect progress while keeping the plan context visible; markers are presentation/state signals, not execution rules. Do not use a card, tree menu, or nested plan structure. ${firstTurn} In later responses, continue with the work that remains and verify it where appropriate. Use completion markers only when they accurately describe the progress. If the current work requires an answer, ask one conversational question and pause without claiming completion. Finish by summarizing what changed.`;
}

/** Build the assistant-side history entry for the first planning pause. */
export function formatPlanPauseMessage(plan: Plan): string {
  const planLines = plan.steps.map((step, index) => `□ ${index + 1}. ${step.action}：${step.description}`).join('\n');
  const first = plan.steps[0];
  const todoLines = (first?.substeps ?? []).map((todo, index) => `□ ${index + 1}. ${todo.action}：${todo.description}`).join('\n');
  return `我仔细分析了一下你的需求。这不是一件适合一口气做完的事，我会先把范围和顺序理清，再逐步推进。\n\n📋 我先列出整体安排：\n${planLines}\n\n当前先处理第 1 项「${first?.action ?? '当前阶段'}」。${todoLines ? `\n\n这一阶段的 Todos：\n${todoLines}` : ''}\n\n计划先列到这里。你回复后，我会根据实际依赖继续推进；如果 Todo 列表有帮助，再用“✓ + 删除线”同步真实进度。`;
}

/** Context for a later user turn that continues an already-approved complex plan. */
export function formatPlanContinuation(plan: Plan, currentPlan: number, currentTodo: number, projectBuild = false): string {
  const planLines = plan.steps.map((step, index) => {
    const done = index + 1 < currentPlan;
    return `${done ? '✓ ~~' : '□ '}${index + 1}. ${step.action}${done ? '~~ [已完成]' : index + 1 === currentPlan ? ' 👈 当前阶段' : ''}`;
  }).join('\n');
  const active = plan.steps[currentPlan - 1];
  const todos = (active?.substeps ?? []).map((todo, index) => {
    const done = index + 1 < currentTodo;
    return `${done ? '✓ ~~' : '□ '}${index + 1}. ${todo.action}${done ? '~~ [已完成]' : index + 1 === currentTodo ? ' 👈 建议从这里继续' : ''}`;
  }).join('\n');
  return `\n\n<plan_continuation>\n这是一个已经开始的复杂任务，不要重新生成计划，也不要从头开始。\n\n当前总计划：\n${planLines}\n\n当前阶段 Todos（阶段 ${currentPlan}）：\n${todos || '当前阶段没有拆分 Todo，请直接处理这一阶段。'}\n\n继续规则：把这里的计划和 Todo 当作当前上下文，根据实际依赖选择下一步工作；可以合并紧密相关的小项，也可以在需要信息时先提问并暂停。完成后用自然语言说明真实进展，并在有帮助时使用完成标记。${projectBuild ? '项目级交付仍需提供真实验证证据。' : ''}\n</plan_continuation>`;
}

// ── Live plan-progress card (transcript) ──
// After a plan is approved, a compact card in the chat lists the phases and
// highlights the current one. The assistant text is scanned for the
// `阶段 n/m` / `Step n of m` / `Phase n of m` markers the model was told to
// emit (see formatPlanForPrompt), advancing the card live.

export interface PlanCardHandle {
  el: HTMLElement;
  stepEls: HTMLElement[]; // top-level plan rows
  numEls: HTMLElement[];  // top-level number labels
  checkEls: HTMLElement[]; // independent completion marks for top-level plans
  substepEls: HTMLElement[][]; // (1)/(2)/(3) rows in each independent Todo list
  substepNumEls: HTMLElement[][];
  /** One independent Todo list per top-level plan; never nested inside plan rows. */
  todoLists: HTMLElement[];
  planLabels: string[];
  todoTitleEl: HTMLElement;
  todosRequired: boolean[];
  total: number;
  current: number;
  currentSubstep: number;
  /** Whether the active plan intentionally renders a Todo list. */
  currentTodosRequired: boolean;
  /** True once the model has explicitly reported the active substep. */
  substepStarted: boolean;
  /** Refining badge element, present while the LLM is still generating the plan. */
  refiningEl: HTMLElement | null;
  /** Human-readable live activity, kept visible while the transcript grows. */
  setActivity(message: string): void;
  /** Switch the card into an explicit "waiting for your reply" state — used at
   * the first-Todo pause point so the card reads as paused-and-ready instead
   * of silently stopped or actively running. */
  setWaiting(planNumber: number, todoLabel: string): void;
}

// Refining-badge text-rotation timers, keyed by the badge element. The hint
// cycle is stopped explicitly when plan generation falls back to the scaffold
// (clearPlanCardRefining); the interval ALSO self-clears once the badge leaves
// the DOM (card upgraded / discarded), so a timer can never outlive its badge.
const refiningTimers = new WeakMap<HTMLElement, number>();

export function createPlanCard(plan: Plan, mode?: TaskMode, refining = false, fallback = false): PlanCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row plan-progress-row plan-text-progress-row';

  const card = document.createElement('div');
  card.className = 'plan-progress-text-plan';

  const head = document.createElement('div');
  head.className = 'plan-progress-head';
  const title = document.createElement('span');
  title.className = 'plan-progress-title';
  const firstAction = plan.steps[0]?.action?.trim();
  // A fallback card (real-time analysis failed/timed out) must not claim the
  // steps came from a judgment that never happened — say plainly that these
  // are generic steps and execution will adapt.
  title.textContent = fallback
    ? '当前为通用步骤（实时分析未完成），执行中会结合实际情况调整：'
    : plan.steps.length === 1 && firstAction
      ? `先从「${firstAction}」开始：`
      : '根据刚才的判断，接下来按这个顺序推进：';
  const count = document.createElement('span');
  count.className = 'plan-progress-count';
  count.textContent = `大概分成 ${plan.steps.length} 件事`;
  const headParts: HTMLElement[] = [title];
  if (refining) {
    // Scaffold period: the LLM is still working out the real steps. Animated
    // dots + label tell the user the card is live and being refined, instead
    // of looking like a static generic list. After 3s the label starts
    // rotating through informative hints (scanning the workspace / analyzing
    // the request / drafting the plan) so a long wait stays informative.
    const badge = document.createElement('span');
    badge.className = 'plan-progress-refining';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('i');
      dot.className = 'plan-refining-dot';
      badge.appendChild(dot);
    }
    const label = document.createElement('span');
    label.className = 'plan-refining-label';      label.textContent = '我先想清楚每一步…';
    badge.appendChild(label);
    headParts.push(badge);
    // 3s hint rotation; self-cleaning via the isConnected guard (see above).
    const hints = [
      t('plan.refining.files', '正在参考工作区文件…'),
      t('plan.refining.analyzing', '正在分析你的需求…'),
      '正在把事情理顺…',
    ];
    let hintIndex = 0;
    const timer = window.setInterval(() => {
      if (!badge.isConnected) {
        window.clearInterval(timer);
        return;
      }
      label.textContent = hints[hintIndex % hints.length];
      hintIndex++;
      // Re-trigger the swap fade (removing + re-adding the class restarts the
      // CSS animation, so each new hint gently fades in).
      label.classList.remove('plan-refining-label-swap');
      void label.offsetWidth;
      label.classList.add('plan-refining-label-swap');
    }, 3000);
    refiningTimers.set(badge, timer);
  }
  headParts.push(count);
  head.append(...headParts);

  const activity = document.createElement('div');
  activity.className = 'plan-progress-activity';
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');
  activity.textContent = refining ? '正在整理执行步骤…' : '等待开始执行…';

  const steps = document.createElement('div');
  steps.className = 'plan-progress-steps';
  const todoLists: HTMLElement[] = [];
  const todoTitleEls: HTMLElement[] = [];
  const stepEls: HTMLElement[] = [];
  const numEls: HTMLElement[] = [];
  const checkEls: HTMLElement[] = [];
  const substepEls: HTMLElement[][] = [];
  const substepNumEls: HTMLElement[][] = [];
  plan.steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'plan-progress-step pending';
    const check = document.createElement('span');
    check.className = 'plan-progress-step-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '';
    const num = document.createElement('span');
    num.className = 'plan-progress-step-num';
    num.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'plan-progress-step-body';
    const action = document.createElement('span');
    action.className = 'plan-progress-step-action';
    action.textContent = s.action;
    body.appendChild(action);
    if (s.description) {
      const desc = document.createElement('span');
      desc.className = 'plan-progress-step-desc';
      desc.textContent = s.description;
      body.appendChild(desc);
    }
    const nestedRows: HTMLElement[] = [];
    const nestedNums: HTMLElement[] = [];
    for (const [j, sub] of (s.substeps ?? []).entries()) {
      const subRow = document.createElement('div');
      subRow.className = 'plan-progress-substep plan-progress-todo-row pending';
      const subCheck = document.createElement('span');
      subCheck.className = 'plan-progress-substep-check';
      subCheck.setAttribute('aria-hidden', 'true');
      subCheck.textContent = '';
      const subNum = document.createElement('span');
      subNum.className = 'plan-progress-substep-num';
      subNum.textContent = `(${j + 1})`;
      const subBody = document.createElement('div');
      subBody.className = 'plan-progress-substep-body';
      const subAction = document.createElement('span');
      subAction.className = 'plan-progress-substep-action';
      subAction.textContent = sub.action;
      subBody.appendChild(subAction);
      if (sub.description) {
        const subDesc = document.createElement('span');
        subDesc.className = 'plan-progress-substep-desc';
        subDesc.textContent = sub.description;
        subBody.appendChild(subDesc);
      }
      subRow.append(subCheck, subNum, subBody);
      nestedRows.push(subRow);
      nestedNums.push(subNum);
    }
    row.append(check, num, body);
    steps.appendChild(row);
    const todoList = document.createElement('div');
    todoList.className = 'plan-progress-text-todos plan-progress-todo-hidden';
    const todoTitle = document.createElement('div');
    todoTitle.className = 'plan-progress-todo-title';
    todoTitle.setAttribute('role', 'status');
    todoTitle.setAttribute('aria-live', 'polite');
    todoTitle.textContent = `这一步的 Todos：${s.action}`;
    todoList.append(todoTitle, ...nestedRows);
    todoLists.push(todoList);
    todoTitleEls.push(todoTitle);
    stepEls.push(row);
    numEls.push(num);
    checkEls.push(check);
    substepEls.push(nestedRows);
    substepNumEls.push(nestedNums);
  });

  card.append(head, activity, steps);
  el.appendChild(card);
  for (const todoList of todoLists) el.appendChild(todoList);

  const handle: PlanCardHandle = {
    el,
    stepEls,
    numEls,
    checkEls,
    substepEls,
    substepNumEls,
    todoLists,
    planLabels: plan.steps.map((step) => step.action),
    todoTitleEl: todoTitleEls[0] ?? document.createElement('div'),
    todosRequired: plan.steps.map((step) => step.todosRequired !== false),
    total: plan.steps.length,
    current: 1,
    currentSubstep: 1,
    currentTodosRequired: plan.steps[0]?.todosRequired !== false,
    substepStarted: false,
    refiningEl: refining ? head.querySelector('.plan-progress-refining') : null,
    setActivity: (message: string): void => {
      activity.classList.remove('is-waiting');
      activity.textContent = message;
    },
    setWaiting: (planNumber: number, todoLabel: string): void => {
      activity.classList.add('is-waiting');
      activity.textContent = `⏸ 已暂停：正在等你回复后开始第 ${planNumber} 项「${todoLabel}」`;
    },
  };
  setPlanPhase(handle, 1);
  return handle;
}

/** Update the existing plan card in place. The outer transcript row stays
 * mounted, so task progress remains visible throughout the turn instead of
 * looking like a one-time list that disappears during plan refinement. */
export function updatePlanCard(h: PlanCardHandle, plan: Plan, mode?: TaskMode, refining = false, fallback = false): void {
  const previousPhase = h.current;
  const previousSubstep = h.currentSubstep;
  const previousSubstepStarted = h.substepStarted;
  const previousTodosRequired = h.currentTodosRequired;
  const previousActivity = h.el.querySelector<HTMLElement>('.plan-progress-activity')?.textContent;
  clearPlanCardRefining(h);
  const fresh = createPlanCard(plan, mode, refining, fallback);
  h.el.replaceChildren(...Array.from(fresh.el.childNodes));
  h.stepEls = fresh.stepEls;
  h.numEls = fresh.numEls;
  h.checkEls = fresh.checkEls;
  h.substepEls = fresh.substepEls;
  h.substepNumEls = fresh.substepNumEls;
  h.todoLists = fresh.todoLists;
  h.planLabels = fresh.planLabels;
  h.todoTitleEl = fresh.todoTitleEl;
  h.todosRequired = fresh.todosRequired;
  h.total = fresh.total;
  h.current = 1;
  h.currentSubstep = 1;
  h.currentTodosRequired = fresh.currentTodosRequired;
  h.substepStarted = false;
  h.refiningEl = fresh.refiningEl;
  h.setActivity = fresh.setActivity;
  setPlanPhase(h, Math.max(1, Math.min(previousPhase, h.total)));
  if (previousPhase === h.current && previousTodosRequired === h.currentTodosRequired && previousSubstepStarted) {
    h.substepStarted = true;
    setPlanSubstep(h, previousSubstep);
  }
  if (previousActivity) h.setActivity(previousActivity);
}

/** Remove the "完善中…" refining badge in place — used when plan generation
 * falls back to the heuristic scaffold (LLM call failed/timed out) so the card
 * never keeps claiming the steps are still being refined during execution. */
export function clearPlanCardRefining(h: PlanCardHandle): void {
  if (!h.refiningEl) return;
  const timer = refiningTimers.get(h.refiningEl);
  if (timer !== undefined) window.clearInterval(timer);
  refiningTimers.delete(h.refiningEl);
  h.refiningEl.remove();
  h.refiningEl = null;
}

// ── Delivery quality-gate checklist card ──
// Project builds finish with a test/audit phase. Mirroring the plan card, a
// live checklist in the transcript lists the verification steps UP FRONT (so
// the user sees what will be tested/audited before it runs) and checks each
// one off as the gate reports it: review → audit → verify.

export interface QualityGateCardHandle {
  el: HTMLElement;
  /** Update one step's row: 'active' while running, final status when done. */
  set(phase: QualityGatePhase, status: QualityGateStatus | 'active', summary?: string): void;
  /** Attach the actual tool/command output to the completed step. */
  setEvidence(check: QualityGateCheck): void;
  /** Put every step back to pending (repair → full re-run cycle). */
  reset(): void;
  /** Update the live explanation while the gate is waiting on a tool. */
  setActivity(message: string): void;
  /** Stop the live elapsed-time heartbeat when the gate run is over. */
  dispose(outcome: 'passed' | 'failed' | 'cancelled'): void;
}

// User-facing verification steps, in the order the gate runs them. Kept as
// exported data so tests can guard against internal phrasing creeping back in.
export const QUALITY_GATE_STEPS: Array<{ phase: QualityGatePhase; action: string; description: string }> = [
  { phase: 'review', action: '代码审查', description: '用审查工具检查本次生成的全部代码，确认没有阻断交付的问题' },
  { phase: 'audit', action: '依赖/安全审计', description: '审计项目依赖与安全配置，确认没有高危漏洞' },
  { phase: 'verify', action: '自动化验证', description: '运行类型检查与测试，确认项目能正常构建并全部通过' },
];

export function createQualityGateCard(): QualityGateCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row plan-progress-row';

  const card = document.createElement('div');
  card.className = 'plan-progress-card quality-gate-card';

  const head = document.createElement('div');
  head.className = 'plan-progress-head';
  const title = document.createElement('span');
  title.className = 'plan-progress-title';
  title.textContent = '🧪 交付前测试与审计';
  const live = document.createElement('span');
  live.className = 'quality-gate-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.innerHTML = '<i class="quality-gate-live-dot" aria-hidden="true"></i><span class="quality-gate-live-text">后台运行中 · 已用时 0s</span>';
  const count = document.createElement('span');
  count.className = 'plan-progress-count';
  count.textContent = `共 ${QUALITY_GATE_STEPS.length} 步`;
  head.append(title, live, count);

  const activity = document.createElement('div');
  activity.className = 'quality-gate-activity';
  activity.setAttribute('aria-live', 'polite');
  activity.textContent = '正在准备交付检查…';

  const steps = document.createElement('div');
  steps.className = 'plan-progress-steps';
  const numEls: HTMLElement[] = [];
  const statusEls: HTMLElement[] = [];
  const byPhase = new Map<QualityGatePhase, { row: HTMLElement; check: HTMLElement; num: HTMLElement; status: HTMLElement; evidence: HTMLDetailsElement; evidenceBody: HTMLElement; index: number }>();

  QUALITY_GATE_STEPS.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'plan-progress-step pending';
    const check = document.createElement('span');
    check.className = 'plan-progress-step-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '';
    const num = document.createElement('span');
    num.className = 'plan-progress-step-num';
    num.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'plan-progress-step-body';
    const action = document.createElement('span');
    action.className = 'plan-progress-step-action';
    action.textContent = s.action;
    const desc = document.createElement('span');
    desc.className = 'plan-progress-step-desc';
    desc.textContent = s.description;
    const status = document.createElement('span');
    status.className = 'plan-progress-step-status';
    const evidence = document.createElement('details');
    evidence.className = 'quality-gate-evidence';
    const evidenceSummary = document.createElement('summary');
    evidenceSummary.textContent = '查看检查反馈';
    const evidenceBody = document.createElement('pre');
    evidenceBody.className = 'quality-gate-evidence-body';
    evidenceBody.textContent = '等待检查结果…';
    evidence.append(evidenceSummary, evidenceBody);
    body.append(action, desc, status, evidence);
    row.append(check, num, body);
    steps.appendChild(row);
    numEls.push(num);
    statusEls.push(status);
    byPhase.set(s.phase, { row, check, num, status, evidence, evidenceBody, index: i });
  });

  card.append(head, activity, steps);
  el.appendChild(card);

  const startedAt = Date.now();
  let timer: number | undefined;
  let disposed = false;
  const phaseLabels: Record<QualityGatePhase, string> = {
    review: '代码审查',
    audit: '依赖/安全审计',
    verify: '自动化验证',
  };
  const phaseActivities: Record<QualityGatePhase, string> = {
    review: '正在调用代码审查工具，检查当前工作区的代码与配置…',
    audit: '正在扫描依赖清单与安全审计结果…',
    verify: '正在运行类型检查与自动化测试…',
  };
  const elapsed = (): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `${seconds}s`;
  };
  const refreshLive = (): void => {
    if (disposed) return;
    if (!el.isConnected) {
      disposed = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
      return;
    }
    const liveText = live.querySelector('.quality-gate-live-text');
    if (liveText) liveText.textContent = `后台运行中 · 已用时 ${elapsed()}`;
  };
  const startHeartbeat = (): void => {
    if (timer === undefined) timer = window.setInterval(refreshLive, 1000);
    refreshLive();
  };
  const set = (phase: QualityGatePhase, status: QualityGateStatus | 'active', summary?: string): void => {
    const entry = byPhase.get(phase);
    if (!entry) return;
    const { row, check, num, status: statusEl, evidence, evidenceBody, index } = entry;
    row.classList.remove('pending', 'active', 'done', 'failed', 'unavailable');
    if (status === 'active') {
      row.classList.add('active');
      check.textContent = '';
      num.textContent = String(index + 1);
      statusEl.textContent = '进行中…';
      evidence.open = false;
      evidenceBody.textContent = '检查正在运行，结果会显示在这里…';
      activity.textContent = `${phaseActivities[phase]} · 已用时 ${elapsed()}`;
      live.classList.add('active');
      startHeartbeat();
    } else if (status === 'passed') {
      row.classList.add('done');
      check.textContent = '✓';
      num.textContent = String(index + 1);
      statusEl.textContent = summary ?? '通过';
      activity.textContent = `${phaseLabels[phase]}已完成：${summary ?? '通过'} · 总耗时 ${elapsed()}`;
    } else if (status === 'degraded') {
      row.classList.add('degraded');
      check.textContent = '△';
      num.textContent = String(index + 1);
      statusEl.textContent = summary ?? '降级完成';
      activity.textContent = `${phaseLabels[phase]}已降级完成：${summary ?? '完整工具未完成'}`;
    } else if (status === 'unavailable') {
      row.classList.add('unavailable');
      check.textContent = '!';
      num.textContent = String(index + 1);
      statusEl.textContent = summary ?? '无法验证';
      activity.textContent = `${phaseLabels[phase]}无法形成证据：${summary ?? '无法验证'}`;
    } else {
      row.classList.add('failed');
      check.textContent = '✗';
      num.textContent = String(index + 1);
      statusEl.textContent = summary ?? '未通过';
      activity.textContent = `${phaseLabels[phase]}未通过：${summary ?? '未通过'}`;
    }
  };

  const setActivity = (message: string): void => {
    if (disposed) return;
    activity.textContent = `${message} · 已用时 ${elapsed()}`;
    live.classList.add('active');
    startHeartbeat();
  };

  const setEvidence = (check: QualityGateCheck): void => {
    const entry = byPhase.get(check.phase);
    if (!entry) return;
    set(check.phase, check.status, check.summary);
    const output = check.output?.trim();
    entry.evidenceBody.textContent = output || '该检查没有返回可展示的详细输出。';
    entry.evidence.hidden = false;
    entry.evidence.open = Boolean(output);
  };

  const reset = (): void => {
    // A failed gate may enter a repair → full re-run cycle. The first run's
    // dispose() stops its heartbeat, so reset must explicitly revive the card
    // before the second run starts; otherwise the UI would say the task ended
    // while the retry was still working.
    disposed = false;
    for (const entry of byPhase.values()) {
      entry.row.classList.remove('active', 'done', 'degraded', 'failed', 'unavailable');
      entry.row.classList.add('pending');
      entry.check.textContent = '';
      entry.num.textContent = String(entry.index + 1);
      entry.status.textContent = '';
      entry.evidence.hidden = false;
      entry.evidence.open = false;
      entry.evidenceBody.textContent = '等待重新检查结果…';
    }
    activity.textContent = '正在重新执行全部交付检查…';
    live.classList.remove('complete', 'failed', 'cancelled');
    live.classList.add('active');
    startHeartbeat();
  };

  const dispose = (outcome: 'passed' | 'failed' | 'cancelled'): void => {
    disposed = true;
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    live.classList.remove('active', 'complete', 'failed', 'cancelled');
    live.classList.add(outcome === 'passed' ? 'complete' : outcome);
    const outcomeText = outcome === 'passed' ? '检查通过' : outcome === 'cancelled' ? '检查已取消' : '检查未通过';
    const liveText = live.querySelector('.quality-gate-live-text');
    if (liveText) liveText.textContent = `${outcomeText} · 总耗时 ${elapsed()}`;
  };

  // Do not start the timer here: the card is not attached to the transcript
  // until createQualityGateCard() returns. The first onPhase/onActivity call
  // starts it after the card is mounted; starting earlier would trigger the
  // detached-card guard and permanently mark the handle disposed.
  return { el, set, setEvidence, reset, setActivity, dispose };
}

function setPlanSubstep(h: PlanCardHandle, n: number): void {
  const rows = h.substepEls[h.current - 1] ?? [];
  const checks = h.substepEls[h.current - 1].map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));

  if (rows.length === 0) {
    h.currentSubstep = 0;
    h.substepStarted = false;
    return;
  }
  h.currentSubstep = n;
  rows.forEach((row, i) => {
    row.classList.remove('done', 'active', 'pending');
    if (i + 1 < n) {
      row.classList.add('done');
      if (checks[i]) checks[i]!.textContent = '✓';
    } else if (i + 1 === n && n <= rows.length) {
      row.classList.add('active');
      if (checks[i]) checks[i]!.textContent = '';
    } else {
      row.classList.add('pending');
      if (checks[i]) checks[i]!.textContent = '';
    }
  });
  if (n > rows.length) {
    rows.forEach((row, i) => {
      row.classList.remove('active', 'pending');
      row.classList.add('done');
      if (checks[i]) checks[i]!.textContent = '✓';
    });
  }
}

function setPlanPhase(h: PlanCardHandle, n: number): void {
  h.current = n;
  h.currentTodosRequired = h.todosRequired[n - 1] !== false;
  h.substepStarted = false;
  const currentRows = h.substepEls[n - 1] ?? [];
  h.todoLists.forEach((todoList, planIndex) => {
    if (planIndex === n - 1 && h.currentTodosRequired && currentRows.length > 0) todoList.classList.remove('plan-progress-todo-hidden');
    else todoList.classList.add('plan-progress-todo-hidden');
  });
  if (n > h.total) {
    h.todoTitleEl.textContent = '所有安排都完成了，我再确认一遍结果。';
  } else if (!h.currentTodosRequired || currentRows.length === 0) {
    h.todoTitleEl.textContent = `现在先处理「${h.planLabels[n - 1] ?? '这一件事'}」，这一步可以直接完成。`;
  } else {
    h.todoTitleEl.textContent = `现在先处理「${h.planLabels[n - 1] ?? '这一件事'}」的 Todos：`;
  }
  h.stepEls.forEach((el, i) => {
    el.classList.remove('done', 'active', 'pending');
    if (i + 1 < n) {
      el.classList.add('done');
      h.checkEls[i].textContent = '✓';
    } else if (i + 1 === n) {
      el.classList.add('active');
      h.numEls[i].textContent = String(i + 1);
      h.checkEls[i].textContent = '';
    } else {
      el.classList.add('pending');
      h.numEls[i].textContent = String(i + 1);
      h.checkEls[i].textContent = '';
    }
  });
  if (n <= h.total) setPlanSubstep(h, 1);
}

/** Advance the card to a later top-level plan (never moves backwards).
 * A plan cannot be skipped while its visible substeps are still pending. */
/** Restore a plan card from a cross-turn progress cursor. */
export function restorePlanCardProgress(h: PlanCardHandle, currentPlan: number, currentTodo: number): void {
  if (h.total === 0) return;
  const phase = Math.max(1, Math.min(currentPlan, h.total));
  setPlanPhase(h, phase);
  const rows = h.substepEls[phase - 1] ?? [];
  if (rows.length > 0 && currentTodo > 1) {
    h.substepStarted = true;
    h.currentSubstep = Math.min(currentTodo, rows.length + 1);
    setPlanSubstep(h, h.currentSubstep);
  }
}

export function updatePlanCardPhase(h: PlanCardHandle, n: number): void {
  const clamped = Math.max(1, Math.min(n, h.total));
  if (clamped !== h.current + 1) return;
  const currentSubsteps = h.substepEls[h.current - 1] ?? [];
  if (h.currentTodosRequired && currentSubsteps.length > 0 && h.currentSubstep <= currentSubsteps.length) return;
  setPlanPhase(h, clamped);
}

/** Advance the numbered substeps inside the active top-level plan.
 * Markers must be sequential: a later marker cannot skip an unseen substep. */
export function updatePlanCardSubstep(h: PlanCardHandle, n: number): void {
  const rows = h.substepEls[h.current - 1] ?? [];
  if (!h.currentTodosRequired || rows.length === 0) return;
  const clamped = Math.max(1, Math.min(n, rows.length));
  // A start marker only activates the next Todo. Completion is a separate
  // explicit marker so the previous Todo is crossed out at the real moment it
  // finishes, rather than merely when the model mentions the next one.
  if (clamped === h.currentSubstep && !h.substepStarted) {
    h.substepStarted = true;
    setPlanSubstep(h, clamped);
  }
}

/** Mark one explicitly reported Todo complete, then activate the next Todo. */
export function completePlanCardSubstep(h: PlanCardHandle, n: number): void {
  const rows = h.substepEls[h.current - 1] ?? [];
  const checks = h.substepEls[h.current - 1].map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));

  if (!h.currentTodosRequired || rows.length === 0) return;
  const index = n - 1;
  if (index < 0 || index >= rows.length || n !== h.currentSubstep) return;
  // A natural-language completion line may be the first marker the UI sees;
  // treat it as an implicit start of the current Todo instead of requiring the
  // model to emit a redundant "开始子步骤" line first.
  if (!h.substepStarted) {
    h.substepStarted = true;
    setPlanSubstep(h, n);
  }
  rows[index].classList.remove('active', 'pending');
  rows[index].classList.add('done');
  const check = rows[index].querySelector<HTMLElement>('.plan-progress-substep-check');
  if (check) check.textContent = '✓';
  h.substepStarted = true;
  if (n < rows.length) {
    h.currentSubstep = n + 1;
    setPlanSubstep(h, h.currentSubstep);
  } else {
    h.currentSubstep = rows.length + 1;
  }
}

/** Return true only after every visible substep has been explicitly entered. */
export function canCompletePlanCardSubsteps(h: PlanCardHandle): boolean {
  const rows = h.substepEls[h.current - 1] ?? [];
  return !h.currentTodosRequired || rows.length === 0 || (h.substepStarted && h.currentSubstep > rows.length);
}

/** Check off every substep in the active top-level plan before moving on. */
export function completePlanCardSubsteps(h: PlanCardHandle): void {
  if (!canCompletePlanCardSubsteps(h)) return;
  const rows = h.substepEls[h.current - 1] ?? [];
  const checks = h.substepEls[h.current - 1].map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));

  rows.forEach((row, i) => {
    row.classList.remove('active', 'pending');
    row.classList.add('done');
    if (checks[i]) checks[i]!.textContent = '✓';
  });
  if (rows.length > 0) h.currentSubstep = rows.length + 1;
  h.substepStarted = true;
}

// A top-level marker is `## 第 2 步…`; a substep marker is `### 子步骤 2/3…`
// The explicit form avoids treating ordinary numbered prose or examples as
// execution progress.
const PLAN_PHASE_START_MARKER_RE = /(?:^|[\n#>])\s*(?:计划|Plan)\s*(\d+)\s*(?=[:：])/gi;
const PLAN_PHASE_DONE_MARKER_RE = /(?:^|[\n#>])\s*(?:计划|Plan)\s*(\d+)\s*(?:完成|已完成|done)(?=\s|$|[.!?,，。！？])/gi;
const PLAN_SUBSTEP_DONE_MARKER_RE = /(?:^|[\n#>])\s*(?:(?:子步骤|小步骤|子任务)\s*(\d+)(?:\s*(?:\/|of)\s*\d+)?\s*(?:[:：]\s*)?(?:完成|已完成)|(?:完成子步骤|子步骤完成|Todo\s+done)\s*(\d+)(?:\s*(?:\/|of)\s*\d+)?)/gi;
const PLAN_SUBSTEP_MARKER_RE = /(?:^|[\n#>])\s*(?:子步骤|小步骤|子任务|[Ss]ubstep)\s*(\d+)(?:\s*(?:\/|of)\s*\d+)?(?!\s*(?:[:：]\s*)?(?:完成|已完成)|\s*\/)/g;

export type PlanProgressMarker =
  | { kind: 'phase'; number: number; index: number; end: number }
  | { kind: 'phaseDone'; number: number; index: number; end: number }
  | { kind: 'substep'; number: number; index: number; end: number }
  | { kind: 'substepDone'; number: number; index: number; end: number };

export function matchPlanProgressMarkers(text: string): PlanProgressMarker[] {
  const markers: PlanProgressMarker[] = [];
  PLAN_PHASE_MARKER_RE.lastIndex = 0;
  let phase: RegExpExecArray | null;
  while ((phase = PLAN_PHASE_MARKER_RE.exec(text)) !== null) {
    const n = Number(phase[1] ?? phase[3] ?? phase[4] ?? phase[6]);
    if (Number.isFinite(n)) markers.push({ kind: 'phase', number: n, index: phase.index, end: phase.index + phase[0].length });
  }
  PLAN_PHASE_START_MARKER_RE.lastIndex = 0;
  let phaseStart: RegExpExecArray | null;
  while ((phaseStart = PLAN_PHASE_START_MARKER_RE.exec(text)) !== null) {
    const n = Number(phaseStart[1] ?? phaseStart[2]);
    if (Number.isFinite(n)) markers.push({ kind: 'phase', number: n, index: phaseStart.index, end: phaseStart.index + phaseStart[0].length });
  }
  PLAN_PHASE_DONE_MARKER_RE.lastIndex = 0;
  let phaseDone: RegExpExecArray | null;
  while ((phaseDone = PLAN_PHASE_DONE_MARKER_RE.exec(text)) !== null) {
    const n = Number(phaseDone[1] ?? phaseDone[2]);
    if (Number.isFinite(n)) markers.push({ kind: 'phaseDone', number: n, index: phaseDone.index, end: phaseDone.index + phaseDone[0].length });
  }
  PLAN_SUBSTEP_DONE_MARKER_RE.lastIndex = 0;
  let done: RegExpExecArray | null;
  while ((done = PLAN_SUBSTEP_DONE_MARKER_RE.exec(text)) !== null) {
    const n = Number(done[1] ?? done[2] ?? done[3]);
    if (Number.isFinite(n)) markers.push({ kind: 'substepDone', number: n, index: done.index, end: done.index + done[0].length });
  }
  PLAN_SUBSTEP_MARKER_RE.lastIndex = 0;
  let substep: RegExpExecArray | null;
  while ((substep = PLAN_SUBSTEP_MARKER_RE.exec(text)) !== null) {
    const n = Number(substep[1] ?? substep[2]);
    if (Number.isFinite(n)) markers.push({ kind: 'substep', number: n, index: substep.index, end: substep.index + substep[0].length });
  }
  return markers
    .sort((a, b) => a.index - b.index)
    .filter((marker, index, all) => marker.kind !== 'substep' || !all.slice(0, index).some((previous) => previous.kind === 'substepDone' && previous.index <= marker.index && previous.end >= marker.end));
}

export function matchPlanSubstepMarkers(text: string): number[] {
  return matchPlanProgressMarkers(text)
    .filter((marker): marker is Extract<PlanProgressMarker, { kind: 'substep' }> => marker.kind === 'substep')
    .map((marker) => marker.number);
}

export function matchPlanSubstepMarker(text: string): number | null {
  const markers = matchPlanSubstepMarkers(text);
  return markers.length > 0 ? Math.max(...markers) : null;
}

/** Mark every top-level plan and its substeps complete (called on run completion). */
export function finalizePlanCard(h: PlanCardHandle): void {
  setPlanPhase(h, h.total + 1);
  h.substepEls.forEach((rows, planIndex) => {
      const checks = rows.map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));
    rows.forEach((row, i) => {
      row.classList.remove('active', 'pending');
      row.classList.add('done');
      if (checks[i]) checks[i]!.textContent = '✓';
    });
  });
}

// Phase-marker regex: `## 阶段 1/4`, `步骤 2/4`, `## 第 1 步：搭建骨架`, `Step
// 2 of 4` / `Step 2/4`, `Phase 2 of 4` / `Phase 2/4`. Anchored to a line start
// (^, newline, `#`, or `>`) because the model is told to write the marker as a
// heading line — a mid-line "阶段 1/4" is usually quoted/sample content, not a
// real phase transition. Groups 1/2 = 阶段/步骤 n/m, 3 = 第 n 步, 4/5 = Step,
// 6/7 = Phase.
const PLAN_PHASE_MARKER_RE = /(?:^|[\n#>])\s*(?:阶段|步骤)\s*(\d+)\s*\/\s*(\d+)|(?:^|[\n#>])\s*第\s*(\d+)\s*步|(?:^|[\n#>])\s*[Ss]tep\s+(\d+)\s*(?:of|\/)\s*(\d+)|(?:^|[\n#>])\s*[Pp]hase\s+(\d+)\s*(?:of|\/)\s*(\d+)/g;

/** Find the highest phase number mentioned in a chunk of assistant text. */
export function matchPlanPhaseMarker(text: string): number | null {
  let best: number | null = null;
  PLAN_PHASE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAN_PHASE_MARKER_RE.exec(text)) !== null) {
    const n = Number(m[1] ?? m[3] ?? m[4] ?? m[6]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

function showPlanDialog(analysis: AnalysisResult, options: PlanReviewOptions): Promise<PlanReviewDecision> {
  const steps = (analysis.plan?.steps ?? []).map((s, i) => `
    <div class="plan-step">
      <span class="plan-step-num">${i + 1}</span>
      <div class="plan-step-body">
        <span class="plan-step-action">${escapeHtml(s.action)}</span>
        <span class="plan-step-desc">${escapeHtml(s.description)}</span>
      </div>
    </div>`).join('');

  const allowSkip = options.allowSkip ?? true;
  const actions = [
    { label: t('plan.cancel'), value: 'cancel' as const },
    ...(allowSkip ? [{ label: t('plan.skip'), value: 'skip' as const }] : []),
    { label: t('plan.approve'), value: 'approve' as const, kind: 'primary' as const },
  ];

  const intent = analysis.intent;
  const riskSummary = intent
    ? `<div class="plan-risk-summary"><strong>${intent.requiresConfirmation ? '⚠️ 高风险操作' : '🧭 主动评估'}</strong><br><span>影响：${escapeHtml(intent.impact)}</span><br><span>可逆性：${escapeHtml(intent.reversibility)}</span><br><span>建议：${escapeHtml(intent.recommendation)}</span></div>`
    : '';
  return showInlineCard({
    cardClass: options.riskReview ? 'plan risk-review' : 'plan',
    title: options.riskReview ? '执行前确认：先看影响再决定' : t('plan.title'),
    bodyHTML:
      `<span class="plan-complexity-badge">${options.riskReview ? '高风险变更' : t('plan.complex')}</span>` +
      riskSummary +
      `<div class="plan-reasoning">${escapeHtml(analysis.reasoning)}</div>` +
      `<div class="plan-steps">${steps}</div>`,
    actions,
    focusIndex: actions.length - 1,
    escValue: 'cancel',
    signal: options.signal,
  }) as Promise<PlanReviewDecision>;
}
