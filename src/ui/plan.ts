// src/ui/plan.ts
// v0.1 — Plan review dialog for complex tasks (P1-6).
// Shown before a run when the Planner classifies a task as complex; the user
// can approve (plan injected into the system prompt), skip planning, or cancel.

import type { AnalysisResult, Plan } from '../coding-agent/types';
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';

export type PlanReviewDecision = 'approve' | 'skip' | 'cancel';

// Serialize concurrent plan reviews (mirrors the permission dialog queue).
let planQueue: Promise<unknown> = Promise.resolve();

export function requestPlanReview(analysis: AnalysisResult): Promise<PlanReviewDecision> {
  const run = planQueue.then(() => showPlanDialog(analysis));
  planQueue = run.catch(() => {});
  return run;
}

/** Render an approved plan into a system-prompt fragment the LLM must follow.
 * Also instructs the model to write a `## 阶段 n/m` heading at the start of
 * each phase — the chat UI scans for that marker to show which phase of the
 * plan is currently executing. */
export function formatPlanForPrompt(plan: Plan): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.action}: ${s.description}`)
    .join('\n');
  return `\n\n## Execution plan (approved by user)\n${steps}\nWork through these steps in order. When you START each phase, write a heading line exactly in this form: \`## 阶段 n/m\` where n is the current phase number and m is the total number of phases (e.g. \`## 阶段 1/${plan.steps.length}\` for the first of ${plan.steps.length}). The UI uses these markers to display which phase you are on — always include the total count. Finish by summarizing what changed.`;
}

// ── Live plan-progress card (transcript) ──
// After a plan is approved, a compact card in the chat lists the phases and
// highlights the current one. The assistant text is scanned for the
// `阶段 n/m` / `Step n of m` / `Phase n of m` markers the model was told to
// emit (see formatPlanForPrompt), advancing the card live.

export interface PlanCardHandle {
  el: HTMLElement;
  stepEls: HTMLElement[]; // phase rows
  numEls: HTMLElement[];  // phase number chips (swapped for ✓ when done)
  total: number;
  current: number;
}

export function createPlanCard(plan: Plan): PlanCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row plan-progress-row';

  const card = document.createElement('div');
  card.className = 'plan-progress-card';

  const head = document.createElement('div');
  head.className = 'plan-progress-head';
  const title = document.createElement('span');
  title.className = 'plan-progress-title';
  title.textContent = t('plan.progress.title', '📋 执行计划');
  const count = document.createElement('span');
  count.className = 'plan-progress-count';
  count.textContent = t('plan.progress.phases', '共 {n} 个阶段').replace('{n}', String(plan.steps.length));
  head.append(title, count);

  const steps = document.createElement('div');
  steps.className = 'plan-progress-steps';
  const stepEls: HTMLElement[] = [];
  const numEls: HTMLElement[] = [];
  plan.steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'plan-progress-step pending';
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
    row.append(num, body);
    steps.appendChild(row);
    stepEls.push(row);
    numEls.push(num);
  });

  card.append(head, steps);
  el.appendChild(card);

  const handle: PlanCardHandle = { el, stepEls, numEls, total: plan.steps.length, current: 1 };
  setPlanPhase(handle, 1);
  return handle;
}

function setPlanPhase(h: PlanCardHandle, n: number): void {
  h.current = n;
  h.stepEls.forEach((el, i) => {
    el.classList.remove('done', 'active', 'pending');
    if (i + 1 < n) {
      el.classList.add('done');
      h.numEls[i].textContent = '✓';
    } else if (i + 1 === n) {
      el.classList.add('active');
      h.numEls[i].textContent = String(i + 1);
    } else {
      el.classList.add('pending');
      h.numEls[i].textContent = String(i + 1);
    }
  });
}

/** Advance the card to a later phase (never moves backwards). */
export function updatePlanCardPhase(h: PlanCardHandle, n: number): void {
  const clamped = Math.max(1, Math.min(n, h.total));
  if (clamped > h.current) setPlanPhase(h, clamped);
}

/** Mark every phase complete (called on run completion). */
export function finalizePlanCard(h: PlanCardHandle): void {
  setPlanPhase(h, h.total);
}

// Phase-marker regex: `## 阶段 1/4`, `步骤 2/4`, `Step 2 of 4` / `Step 2/4`,
// `Phase 2 of 4` / `Phase 2/4`. Anchored to a line start (^, newline, `#`, or
// `>`) because the model is told to write the marker as a heading line — a
// mid-line "阶段 1/4" is usually quoted/sample content, not a real phase
// transition. Groups 1/2 = Chinese, 3/4 = Step, 5/6 = Phase.
const PLAN_PHASE_MARKER_RE = /(?:^|[\n#>])\s*(?:阶段|步骤)\s*(\d+)\s*\/\s*(\d+)|(?:^|[\n#>])\s*[Ss]tep\s+(\d+)\s*(?:of|\/)\s*(\d+)|(?:^|[\n#>])\s*[Pp]hase\s+(\d+)\s*(?:of|\/)\s*(\d+)/g;

/** Find the highest phase number mentioned in a chunk of assistant text. */
export function matchPlanPhaseMarker(text: string): number | null {
  let best: number | null = null;
  PLAN_PHASE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLAN_PHASE_MARKER_RE.exec(text)) !== null) {
    const n = Number(m[1] ?? m[3] ?? m[5]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

function showPlanDialog(analysis: AnalysisResult): Promise<PlanReviewDecision> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('plan-overlay') as HTMLDivElement;
    const titleEl = document.getElementById('plan-title') as HTMLSpanElement;
    const badgeEl = document.getElementById('plan-complexity-badge') as HTMLSpanElement;
    const reasoningEl = document.getElementById('plan-reasoning') as HTMLDivElement;
    const stepsEl = document.getElementById('plan-steps') as HTMLDivElement;
    const approveBtn = document.getElementById('plan-approve') as HTMLButtonElement;
    const skipBtn = document.getElementById('plan-skip') as HTMLButtonElement;
    const cancelBtn = document.getElementById('plan-cancel') as HTMLButtonElement;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    titleEl.textContent = t('plan.title');
    badgeEl.textContent = t('plan.complex');
    reasoningEl.textContent = analysis.reasoning;
    stepsEl.innerHTML = (analysis.plan?.steps ?? []).map((s, i) => `
      <div class="plan-step">
        <span class="plan-step-num">${i + 1}</span>
        <div class="plan-step-body">
          <span class="plan-step-action">${escapeHtml(s.action)}</span>
          <span class="plan-step-desc">${escapeHtml(s.description)}</span>
        </div>
      </div>`).join('');

    const cleanup = () => {
      overlay.classList.add('hidden');
      approveBtn.removeEventListener('click', onApprove);
      skipBtn.removeEventListener('click', onSkip);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    const onApprove = () => { cleanup(); resolve('approve'); };
    const onSkip = () => { cleanup(); resolve('skip'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [approveBtn, skipBtn, cancelBtn].filter((button) => !button.disabled && !button.hidden);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      e.preventDefault();
      focusable[next].focus();
    };

    approveBtn.addEventListener('click', onApprove);
    skipBtn.addEventListener('click', onSkip);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.remove('hidden');
    approveBtn.focus();
  });
}
