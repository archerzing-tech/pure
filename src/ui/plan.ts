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

/** Render an approved plan into a system-prompt fragment the LLM must follow. */
export function formatPlanForPrompt(plan: Plan): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.action}: ${s.description}`)
    .join('\n');
  return `\n\n## Execution plan (approved by user)\n${steps}\nWork through these steps in order, then summarize what changed.`;
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
    };
    const onApprove = () => { cleanup(); resolve('approve'); };
    const onSkip = () => { cleanup(); resolve('skip'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onApprove();
    };

    approveBtn.addEventListener('click', onApprove);
    skipBtn.addEventListener('click', onSkip);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.remove('hidden');
    approveBtn.focus();
  });
}
