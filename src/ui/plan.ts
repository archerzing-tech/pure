// src/ui/plan.ts
// v0.1 — Plan review dialog for complex tasks (P1-6).
// Shown before a run when the Planner classifies a task as complex; the user
// can approve (plan injected into the system prompt), skip planning, or cancel.

import type { AnalysisResult, Plan } from '../coding-agent/types';
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showInlineCard } from './inlineCard';
import { PlanProgressModel, type PlanProgressSnapshot } from './planProgress';

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

const PLAN_STAGE_PROTOCOL = `Use this strict stage protocol for every top-level plan item. Before any tool call or file change for plan n, first write two short user-facing lines in the conversation: one standalone control line exactly \"## 计划 n：<阶段名称>\" and then a natural sentence explaining what this stage is about and what you are going to do. The UI consumes that line as the single stage-start event and synchronizes the in-chat plan card before execution begins. Do not call tools before the stage-start announcement. After the work and its meaningful verification are actually complete, write a standalone control line exactly \"## 计划 n 已完成\" and then briefly say what this stage completed. The UI consumes that line as the single stage-complete event for the in-chat plan card. These supported progress markers are state events, not a generic progress estimate; they do not dictate execution granularity. Do not announce the next stage, call its tools, or claim the whole plan is complete before the current stage-complete line. If a stage needs user input, explain what is missing and pause without emitting its completion line. Never use a stage marker merely as a preview or example. For a plan item that carries a visible Todo list (substeps), drive that list with the same discipline: before starting substep k, write a standalone control line exactly 「### 子步骤 k：<子步骤名称>」, and once that substep's work is actually done and verified, write a standalone control line exactly 「### 子步骤 k 已完成」 (an optional 「/总数」 after the number is accepted). The UI consumes these as the per-Todo start/complete events and advances the Todo cursor only in numeric order, so emit them in order and never mark a substep done before its work is finished. Skip substep markers entirely for an atomic plan item that has no Todo list.`;

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
  // The strict stage protocol lives in ONE place (PLAN_STAGE_PROTOCOL below) —
  // these branches only reference it, instead of restating it every time.
  const execution = approved
    ? 'Use the approved plan as a flexible guide. Keep the overall plan and any active Todo list visibly separate. The user has already approved this plan, so start executing immediately: briefly restate the request, show the complete top-level plan list once and a separate Todo list below the plan list for plan 1, then begin the most appropriate next action with real tool calls in this same response — do not wait for another approval. Verify the result. When a plan card is active, follow the strict stage protocol below. If the task needs information, ask one natural question and pause until the user answers. In later responses, continue with the next appropriate work and verify meaningful results. Emit `## 计划 n 已完成` when the plan work has actually been completed and verified' + (projectBuild ? ' (for a project build, the LAST plan stage must be the delivery verification pipeline: code review, then typecheck, then unit tests, then e2e/build checks — fix failures and re-run until ALL pass).' : '.') + ' The UI may reflect the completed plan in the separate plan list and activate the next plan. When todosRequired=false, treat the step as atomic unless the task itself reveals a reason to split it. Never claim a plan or work item is complete without relevant verification evidence. Use plain language and natural colleague-like sentences around the required markers.'
    : 'Use the approved plan as a flexible guide. Keep the overall plan and any active Todo list visibly separate. First, briefly restate the user request in your own words and say naturally that you will think it through before planning. Then show the complete top-level plan list once and a separate Todo list below the plan list for plan 1. IMPORTANT: this first planning response is a pause point — do not call tools or change files yet; end by telling the user what you recommend starting with. Only after the user sends the next message may you begin execution. If the task needs information, ask one natural question and pause until the user answers. In continuation responses, continue with the next appropriate work and verify meaningful results. When a plan card is active, follow the strict stage protocol below. Emit `## 计划 n 已完成` when the plan work has actually been completed and verified' + (projectBuild ? ' (for a project build, the LAST plan stage must be the delivery verification pipeline: code review, then typecheck, then unit tests, then e2e/build checks — fix failures and re-run until ALL pass).' : '.') + ' The UI may reflect the completed plan in the separate plan list and activate the next plan. When todosRequired=false, treat the step as atomic unless the task itself reveals a reason to split it; respect the current execution context. Never claim a plan or work item is complete without relevant verification evidence. Use plain language and natural colleague-like sentences around the required markers.';
  const firstTurn = approved
    ? 'The plan is already approved, so do NOT wait for another go-ahead: restate the request, show the relevant plan context, then start the next appropriate work with real tool calls in this same response. End by reporting what you did and what remains.'
    : 'On the first response after this plan is approved, introduce the relevant plan context without executing tools; end by saying what you recommend starting with.';
  // Only the format constraints that the protocol does not cover stay here;
  // the stage-marker mechanics are stated once in PLAN_STAGE_PROTOCOL above.
  return `\n\n## 整体安排\n${steps}\n${execution}\n\n${PLAN_STAGE_PROTOCOL}\n\nKeep the plan list and the active Todo list as two separate plain-text lists; do not use a card, tree menu, or nested plan structure. Before the next plan starts, show the updated plan context. ${firstTurn} Finish by summarizing what changed.`;
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
  return `\n\n<plan_continuation>\n这是一个已经开始的复杂任务，不要重新生成计划，也不要从头开始。\n\n当前总计划：\n${planLines}\n\n当前阶段 Todos（阶段 ${currentPlan}）：\n${todos || '当前阶段没有拆分 Todo，请直接处理这一阶段。'}\n\n继续规则：把这里的计划和 Todo 当作当前上下文，根据实际依赖选择下一步工作；可以合并紧密相关的小项，也可以在需要信息时先提问并暂停。严格执行阶段协议：每个计划开始前先单独输出一行「## 计划 n：<正在做什么>」宣布阶段，之后才能调用工具；阶段真实完成并验证后，再单独输出「## 计划 n 已完成」并简要说明完成结果；编号与上面的列表保持一致，界面靠这两个阶段事件把执行大纲一步步往下推。没有开始播报就不要执行，没有完成播报就不要进入下一计划。如果当前阶段带 Todo 列表，也要按序播报子步骤：开始第 k 项前先单独输出一行「### 子步骤 k：<名称>」，该项真实完成后再单独输出「### 子步骤 k 已完成」（数字后可选「/总数」）；界面靠这些子步骤事件推进 Todo 游标，未完成就不要播报完成。用自然语言说明真实进展，并在有帮助时使用 Todo 标记。${projectBuild ? '项目级交付仍需提供真实验证证据。' : ''}\n</plan_continuation>`;
}

// ── Live plan-progress card (transcript) ──
// After a plan is approved, a compact card in the chat lists the phases and
// highlights the current one. The assistant text is scanned for the
// `阶段 n/m` / `Step n of m` / `Phase n of m` markers the model was told to
// emit (see formatPlanForPrompt), advancing the card live.

export interface PlanCardHandle {
  el: HTMLElement;
  /** The plan this card renders — kept on the handle so the persisted snapshot
   * can keep restoring the card after the cross-turn cursor is cleared
   * (activeComplexPlan → null on completion). */
  plan: Plan;
  stepEls: HTMLElement[]; // top-level plan rows
  numEls: HTMLElement[];  // top-level number labels
  checkEls: HTMLElement[]; // independent completion marks for top-level plans
  substepEls: HTMLElement[][]; // (1)/(2)/(3) rows in each independent Todo list
  substepNumEls: HTMLElement[][];
  /** One independent Todo list per top-level plan; never nested inside plan rows. */
  todoLists: HTMLElement[];
  todoTitleEls: HTMLElement[];
  /** Refining badge element, present while the LLM is still generating the plan. */
  refiningEl: HTMLElement | null;
  /** Human-readable live activity, kept visible while the transcript grows. */
  setActivity(message: string): void;
  /** Switch the card into an explicit "waiting for your reply" state — used at
   * the first-Todo pause point so the card reads as paused-and-ready instead
   * of silently stopped or actively running. */
  setWaiting(planNumber: number, todoLabel: string): void;
  /** Live auto-continue badge element (「自动续跑中 N/M」) on the card head. */
  autoContinueEl: HTMLElement;
  /** Current badge state (round/max), or null while no auto chain runs.
   * Persisted across updatePlanCard upgrades so a mid-chain card rebind keeps
   * the badge instead of dropping it when the card is rebuilt in place. */
  autoContinueState: { round: number; max: number } | null;
  /** Show the auto-continue badge on the card head. */
  setAutoContinue(round: number, max: number): void;
  /** Hide the auto-continue badge (chain ended / user took over). */
  clearAutoContinue(): void;
}

// Refining-badge text-rotation timers, keyed by the badge element. The hint
// cycle is stopped explicitly when plan generation falls back to the scaffold
// (clearPlanCardRefining); the interval ALSO self-clears once the badge leaves
// the DOM (card upgraded / discarded), so a timer can never outlive its badge.
const refiningTimers = new WeakMap<HTMLElement, number>();

const planCardSubscriptions = new WeakMap<PlanCardHandle, () => void>();

export function createPlanCard(plan: Plan, refining: boolean, source: PlanProgressModel): PlanCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row plan-progress-row plan-text-progress-row';

  const card = document.createElement('div');
  card.className = 'plan-progress-text-plan';

  const head = document.createElement('div');
  head.className = 'plan-progress-head';
  const title = document.createElement('span');
  title.className = 'plan-progress-title';
  const firstAction = plan.steps[0]?.action?.trim();
  title.textContent = plan.steps.length === 1 && firstAction
    ? `先从「${firstAction}」开始：`
    : '根据刚才的判断，接下来按这个顺序推进：';
  const count = document.createElement('span');
  count.className = 'plan-progress-count';
  count.textContent = `大概分成 ${plan.steps.length} 件事`;
  // Live auto-continue badge: shown while an auto-continue chain is running
  // (「自动续跑中 N/M」), hidden otherwise. chat.ts drives it via
  // setAutoContinue / clearAutoContinue; the state survives updatePlanCard.
  const autoBadge = document.createElement('span');
  autoBadge.className = 'plan-progress-auto-continue';
  autoBadge.setAttribute('role', 'status');
  autoBadge.setAttribute('aria-live', 'polite');
  autoBadge.hidden = true;
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
  headParts.push(autoBadge);
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
    plan,
    stepEls,
    numEls,
    checkEls,
    substepEls,
    substepNumEls,
    todoLists,
    todoTitleEls,
    refiningEl: refining ? head.querySelector('.plan-progress-refining') : null,
    setActivity: (message: string): void => {
      activity.classList.remove('is-waiting');
      activity.textContent = message;
    },
    setWaiting: (planNumber: number, todoLabel: string): void => {
      activity.classList.add('is-waiting');
      activity.textContent = `⏸ 已暂停：正在等你回复后开始第 ${planNumber} 项「${todoLabel}」`;
    },
    autoContinueEl: autoBadge,
    autoContinueState: null,
    // These closures write through `handle` (not a captured local) so the state
    // and element stay the single source of truth on the handle object —
    // updatePlanCard can swap autoContinueEl to the fresh badge and re-apply
    // without the closures going stale.
    setAutoContinue: (round: number, max: number): void => {
      handle.autoContinueState = { round, max };
      handle.autoContinueEl.hidden = false;
      handle.autoContinueEl.textContent = `${t('plan.autoContinue.badge', '自动续跑中')} ${round}/${max}`;
    },
    clearAutoContinue: (): void => {
      handle.autoContinueState = null;
      handle.autoContinueEl.hidden = true;
    },
  };
  bindPlanCardProgress(handle, source);
  return handle;
}

/** Update the existing plan card in place. The outer transcript row stays
 * mounted, so task progress remains visible throughout the turn instead of
 * looking like a one-time list that disappears during plan refinement. */
export function updatePlanCard(h: PlanCardHandle, plan: Plan, refining: boolean, source: PlanProgressModel): void {
  unbindPlanCardProgress(h);
  const previousActivity = h.el.querySelector<HTMLElement>('.plan-progress-activity')?.textContent;
  clearPlanCardRefining(h);
  const fresh = createPlanCard(plan, refining, source);
  unbindPlanCardProgress(fresh);
  // The step list is replaced in place; instead of an abrupt cut (old steps
  // vanish, new steps pop in), cascade the FRESH steps in with the same
  // stagger the initial card uses. The children are brand-new nodes, so the
  // animation fires exactly once per update; the remove→add cycle keeps the
  // row's class state clean across repeated upgrades. No card-level fade —
  // the frame is already on screen, only the steps are new.
  h.el.classList.remove('plan-card-updating');
  h.el.classList.add('plan-card-updating');
  h.el.replaceChildren(...Array.from(fresh.el.childNodes));
  h.plan = fresh.plan;
  h.stepEls = fresh.stepEls;
  h.numEls = fresh.numEls;
  h.checkEls = fresh.checkEls;
  h.substepEls = fresh.substepEls;
  h.substepNumEls = fresh.substepNumEls;
  h.todoLists = fresh.todoLists;
  h.todoTitleEls = fresh.todoTitleEls;
  h.refiningEl = fresh.refiningEl;
  h.setActivity = fresh.setActivity;
  // Keep the auto-continue badge alive across the in-place upgrade: point the
  // (original) setAutoContinue/clearAutoContinue closures at the fresh badge
  // element, then re-apply the persisted round/max state so a mid-chain card
  // rebind doesn't drop the indicator.
  h.autoContinueEl = fresh.autoContinueEl;
  if (h.autoContinueState) h.setAutoContinue(h.autoContinueState.round, h.autoContinueState.max);
  else h.clearAutoContinue();
  bindPlanCardProgress(h, source);
  if (previousActivity) h.setActivity(previousActivity);
}

function unbindPlanCardProgress(h: PlanCardHandle): void {
  planCardSubscriptions.get(h)?.();
  planCardSubscriptions.delete(h);
}

export function bindPlanCardProgress(h: PlanCardHandle, source: PlanProgressModel): void {
  unbindPlanCardProgress(h);
  planCardSubscriptions.set(h, source.subscribe((snapshot) => renderPlanCardProgress(h, snapshot)));
}

function renderPlanCardProgress(h: PlanCardHandle, snapshot: PlanProgressSnapshot): void {
  h.plan = snapshot.plan;
  const total = snapshot.plan.steps.length;
  renderPlanPhase(h, snapshot.currentPlan);
  if (snapshot.currentPlan > total) {
    h.substepEls.forEach((rows) => renderPlanSubstepsComplete(rows));
    h.setActivity('计划中的所有步骤已完成。');
  } else if (snapshot.currentTodo > 1) {
    renderPlanSubstep(h, snapshot.currentTodo, snapshot.currentPlan);
  }
  if (snapshot.status === 'waiting' && snapshot.currentPlan <= total) {
    const label = h.plan.steps[snapshot.currentPlan - 1]?.action ?? '当前阶段';
    h.setWaiting(snapshot.currentPlan, label);
  } else if (snapshot.status === 'active') {
    const activity = h.el.querySelector<HTMLElement>('.plan-progress-activity');
    if (activity?.classList.contains('is-waiting')) h.setActivity('已恢复执行当前计划…');
  }
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


function renderPlanSubstep(h: PlanCardHandle, n: number, planNumber: number): void {
  const rows = h.substepEls[planNumber - 1] ?? [];
  const checks = rows.map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));

  if (rows.length === 0) return;
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

/** Set the active top-level plan directly (never clamps to total — total + 1
 * is the completed state). Marks every plan below `n` done, `n` active, and
 * resets the active plan's substep cursor. Exported so the marker scanner can
 * jump the card straight to a plan the model reported starting (skipping
 * several plans at once) instead of advancing one step per marker. */
function renderPlanPhase(h: PlanCardHandle, n: number): void {
  const total = h.plan.steps.length;
  const currentStep = h.plan.steps[n - 1];
  const currentTodosRequired = currentStep?.todosRequired !== false;
  const currentRows = h.substepEls[n - 1] ?? [];
  h.todoLists.forEach((todoList, planIndex) => {
    if (planIndex === n - 1 && currentTodosRequired && currentRows.length > 0) todoList.classList.remove('plan-progress-todo-hidden');
    else todoList.classList.add('plan-progress-todo-hidden');
  });
  const title = n > total
    ? '所有安排都完成了，我再确认一遍结果。'
    : !currentTodosRequired || currentRows.length === 0
      ? `现在先处理「${currentStep?.action ?? '这一件事'}」，这一步可以直接完成。`
      : `现在先处理「${currentStep?.action ?? '这一件事'}」的 Todos：`;
  const titleEl = h.todoTitleEls[n - 1] ?? h.todoTitleEls[0];
  if (titleEl) titleEl.textContent = title;
  h.substepEls.forEach((rows, i) => {
    if (i < n - 1 || n > total) renderPlanSubstepsComplete(rows);
  });
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
  if (n <= total) renderPlanSubstep(h, 1, n);
}

function renderPlanSubstepsComplete(rows: HTMLElement[]): void {
  const checks = rows.map((row) => row.querySelector<HTMLElement>('.plan-progress-substep-check'));
  rows.forEach((row, i) => {
    row.classList.remove('active', 'pending');
    row.classList.add('done');
    if (checks[i]) checks[i]!.textContent = '✓';
  });
}

/** Rebuild a plan card from the already-restored session progress model. */
export function createRestoredPlanCard(source: PlanProgressModel): PlanCardHandle {
  const snapshot = source.getSnapshot();
  return createPlanCard(snapshot.plan, false, source);
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
