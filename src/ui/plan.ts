// src/ui/plan.ts
// v0.1 — Plan review dialog for complex tasks (P1-6).
// Shown before a run when the Planner classifies a task as complex; the user
// can approve (plan injected into the system prompt), skip planning, or cancel.

import type { AnalysisResult, Plan, TaskMode } from '../coding-agent/types';
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showInlineCard } from './inlineCard';
import { scrollChatToBottomIfPinned } from './scrollPin';
import type { QualityGatePhase, QualityGateStatus } from './projectQualityGate';

export type PlanReviewDecision = 'approve' | 'skip' | 'cancel';

export interface PlanReviewOptions {
  /** Project builds must be approved; ordinary complex tasks may be skipped. */
  allowSkip?: boolean;
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
export function formatPlanForPrompt(plan: Plan, projectBuild = false): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.action}: ${s.description}`)
    .join('\n');
  const execution = projectBuild
    ? 'This is a project build: execute phases strictly in order. Never create or modify files for a later phase early. At the start of each phase, write a heading exactly like `## 阶段 n/m`. Within a phase, make only the files needed for that phase, then RUN THE PROJECT\'S ACTUAL verification command (e.g. `npm run typecheck && npm test`, `cargo test`) and report its real output before starting the next phase — never claim a check you did not run. Do not batch the whole project into one tool burst. If verification fails, stop advancing, fix the current phase, and report the failure and retry.'
    : 'Work through these steps in order and report the result of each step before moving on.';
  return `\n\n## Execution plan (approved by user)\n${steps}\n${execution} The UI uses these markers to display the active phase — always include the total count. Finish by summarizing what changed.`;
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
  /** Refining badge element, present while the LLM is still generating the plan. */
  refiningEl: HTMLElement | null;
}

// Refining-badge text-rotation timers, keyed by the badge element. The hint
// cycle is stopped explicitly when plan generation falls back to the scaffold
// (clearPlanCardRefining); the interval ALSO self-clears once the badge leaves
// the DOM (card upgraded / discarded), so a timer can never outlive its badge.
const refiningTimers = new WeakMap<HTMLElement, number>();

// Short chip label for the auto-selected task mode (shown in the progress-card
// head so the user sees the yolo → plan/build switch). Defined here (not in
// chat.ts) to avoid a circular import.
function modeChipLabel(mode: TaskMode | undefined): string | null {
  switch (mode) {
    case 'build': return t('plan.mode.build');
    case 'plan': return t('plan.mode.plan');
    default: return null;
  }
}

export function createPlanCard(plan: Plan, mode?: TaskMode, refining = false): PlanCardHandle {
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
  const chipLabel = modeChipLabel(mode);
  const headParts: HTMLElement[] = [title];
  if (chipLabel) {
    const chip = document.createElement('span');
    chip.className = 'plan-mode-chip';
    chip.textContent = chipLabel;
    headParts.push(chip);
  }
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
    label.className = 'plan-refining-label';
    label.textContent = t('plan.refining', '完善中…');
    badge.appendChild(label);
    headParts.push(badge);
    // 3s hint rotation; self-cleaning via the isConnected guard (see above).
    const hints = [
      t('plan.refining.files', '正在参考工作区文件…'),
      t('plan.refining.analyzing', '正在分析你的需求…'),
      t('plan.refining.planning', '正在生成专属执行计划…'),
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

  const handle: PlanCardHandle = {
    el,
    stepEls,
    numEls,
    total: plan.steps.length,
    current: 1,
    refiningEl: refining ? head.querySelector('.plan-progress-refining') : null,
  };
  setPlanPhase(handle, 1);
  return handle;
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
  /** Put every step back to pending (repair → full re-run cycle). */
  reset(): void;
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
  card.className = 'plan-progress-card';

  const head = document.createElement('div');
  head.className = 'plan-progress-head';
  const title = document.createElement('span');
  title.className = 'plan-progress-title';
  title.textContent = '🧪 交付前测试与审计';
  const count = document.createElement('span');
  count.className = 'plan-progress-count';
  count.textContent = `共 ${QUALITY_GATE_STEPS.length} 步`;
  head.append(title, count);

  const steps = document.createElement('div');
  steps.className = 'plan-progress-steps';
  const numEls: HTMLElement[] = [];
  const statusEls: HTMLElement[] = [];
  const byPhase = new Map<QualityGatePhase, { row: HTMLElement; num: HTMLElement; status: HTMLElement; index: number }>();

  QUALITY_GATE_STEPS.forEach((s, i) => {
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
    const desc = document.createElement('span');
    desc.className = 'plan-progress-step-desc';
    desc.textContent = s.description;
    const status = document.createElement('span');
    status.className = 'plan-progress-step-status';
    body.append(action, desc, status);
    row.append(num, body);
    steps.appendChild(row);
    numEls.push(num);
    statusEls.push(status);
    byPhase.set(s.phase, { row, num, status, index: i });
  });

  card.append(head, steps);
  el.appendChild(card);

  const set = (phase: QualityGatePhase, status: QualityGateStatus | 'active', summary?: string): void => {
    const entry = byPhase.get(phase);
    if (!entry) return;
    const { row, num, status: statusEl, index } = entry;
    row.classList.remove('pending', 'active', 'done', 'failed', 'unavailable');
    if (status === 'active') {
      row.classList.add('active');
      num.textContent = String(index + 1);
      statusEl.textContent = '进行中…';
    } else if (status === 'passed') {
      row.classList.add('done');
      num.textContent = '✓';
      statusEl.textContent = summary ?? '通过';
    } else if (status === 'unavailable') {
      row.classList.add('unavailable');
      num.textContent = '!';
      statusEl.textContent = summary ?? '无法验证';
    } else {
      row.classList.add('failed');
      num.textContent = '✗';
      statusEl.textContent = summary ?? '未通过';
    }
  };

  const reset = (): void => {
    for (const entry of byPhase.values()) {
      entry.row.classList.remove('active', 'done', 'failed', 'unavailable');
      entry.row.classList.add('pending');
      entry.num.textContent = String(entry.index + 1);
      entry.status.textContent = '';
    }
  };

  return { el, set, reset };
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
  setPlanPhase(h, h.total + 1);
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

// ── Pre-plan clarifying questions (Freebuff-style interview) ──
// Before the plan is generated, ambiguous project requests get a short
// question card: the user answers 1-3 key questions (platform/stack, scope,
// constraints), and the answers feed BOTH the plan generation and the run's
// user context (see chat.ts formatClarificationBlock).

/**
 * Ask the user to answer the given clarifying questions inline in the chat
 * transcript. Resolves with the filled-in answers (aligned to the question
 * order, empty answers dropped) or null when the user skips / Esc / the card
 * is removed externally.
 */
export function requestClarifications(questions: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const chatEl = document.getElementById('chat')!;
    const row = document.createElement('div');
    row.className = 'bubble-row inline-card clarify-card';

    const card = document.createElement('div');
    card.className = 'inline-card-box';

    const head = document.createElement('div');
    head.className = 'inline-card-head';
    const title = document.createElement('span');
    title.className = 'inline-card-title';
    title.textContent = '📋 开工前先确认几个问题';
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'inline-card-body';
    const inputs: HTMLTextAreaElement[] = [];
    questions.forEach((q, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'clarify-question';
      const label = document.createElement('span');
      label.className = 'clarify-question-label';
      label.textContent = `${i + 1}. ${q}`;
      const ta = document.createElement('textarea');
      ta.className = 'clarify-input';
      ta.placeholder = '你的回答…（可留空跳过）';
      ta.setAttribute('rows', '2');
      inputs.push(ta);
      wrap.append(label, ta);
      body.appendChild(wrap);
    });
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'inline-card-actions';
    let decided = false;
    const cleanup = (): void => {
      row.remove();
      watchdog.disconnect();
      document.removeEventListener('keydown', onKeydown);
    };
    const finish = (answers: string[] | null): void => {
      if (decided) return;
      decided = true;
      cleanup();
      resolve(answers);
    };
    const skipBtn = document.createElement('button');
    skipBtn.className = 'setting-btn secondary';
    skipBtn.textContent = '跳过提问';
    skipBtn.addEventListener('click', () => finish(null));
    const submitBtn = document.createElement('button');
    submitBtn.className = 'setting-btn primary';
    submitBtn.textContent = '提交回答';
    submitBtn.addEventListener('click', () => {
      const answers = inputs.map((ta) => ta.value.trim()).filter(Boolean);
      finish(answers.length ? answers : null);
    });
    actions.append(skipBtn, submitBtn);
    card.appendChild(actions);

    row.appendChild(card);
    chatEl.appendChild(row);

    // Fail-safe: external removal (chat clear / session switch) resolves null
    // so the awaiting send() can never hang.
    const watchdog = new MutationObserver(() => {
      if (!row.isConnected) finish(null);
    });
    watchdog.observe(chatEl, { childList: true });

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitBtn.click();
      }
    };
    document.addEventListener('keydown', onKeydown);

    submitBtn.focus();
    scrollChatToBottomIfPinned(chatEl);
  });
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

  return showInlineCard({
    cardClass: 'plan',
    title: t('plan.title'),
    bodyHTML:
      `<span class="plan-complexity-badge">${t('plan.complex')}</span>` +
      `<div class="plan-reasoning">${escapeHtml(analysis.reasoning)}</div>` +
      `<div class="plan-steps">${steps}</div>`,
    actions,
    focusIndex: actions.length - 1,
    escValue: 'cancel',
  }) as Promise<PlanReviewDecision>;
}
