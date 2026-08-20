// src/ui/requestReview.ts
// 诉求合理性分析卡 — the agent's structured verdict on the reasonableness of
// the user's request itself, rendered between the live analysis (thinking
// card) and the plan card. Reasonable parts proceed automatically; parts the
// model flags as questionable / unreasonable pause the plan BEFORE execution
// and let the user decide (adjust per suggestion, or proceed as requested).

import type { IntentAssessment } from '../coding-agent/types';

export type RequestReviewVerdict = 'reasonable' | 'questionable' | 'unreasonable';

export interface RequestReviewItem {
  /** The part of the user's request being judged (not a verbatim quote). */
  part: string;
  verdict: RequestReviewVerdict;
  /** Why this part is (or isn't) reasonable — concrete, fact-based. */
  reason: string;
  /** Proposed adjustment / alternative; empty for reasonable parts. */
  suggestion?: string;
}

export interface RequestReviewCardHandle {
  el: HTMLElement;
  /** Attach the decision buttons (only when the turn actually pauses).
   * Handlers return true when the action actually ran (the buttons then
   * lock against double-clicks). */
  enableDecisions(onAdjust: () => boolean, onProceed: () => boolean): void;
  /** Flip the card out of decision mode (user decided via another surface). */
  setDecided(activity?: string): void;
  remove(): void;
}

const VERDICT_LABELS: Record<RequestReviewVerdict, string> = {
  reasonable: '合理',
  questionable: '存疑',
  unreasonable: '不合理',
};

/** True when any part is not plain "reasonable". */
export function hasFlaggedReviewItems(review: RequestReviewItem[]): boolean {
  return review.some((item) => item.verdict !== 'reasonable');
}

/**
 * Whether the review card is worth SHOWING at all. The model flagged a part
 * of the request as questionable or unreasonable — that concern is exactly
 * what the user should see, so the card is informational by default. It only
 * BLOCKS execution when shouldPauseForRequestReview also says the turn must
 * stop for a decision.
 */
export function shouldShowRequestReview(review: RequestReviewItem[]): boolean {
  return hasFlaggedReviewItems(review);
}

/**
 * Whether the flagged concerns force a user DECISION before execution. A
 * model's subjective doubt about scope or taste ("需求较大", "风格差异大") stays
 * visible but non-blocking — interrupting a clear request over an opinion is
 * worse than showing the note. Only a genuine safety boundary (logical trap,
 * high risk, destructive / migration / refactor intent) or an explicitly
 * unreasonable verdict (infeasible, self-contradictory, destructive to
 * existing work) actually pauses the turn.
 */
export function shouldPauseForRequestReview(
  review: RequestReviewItem[],
  assessment: IntentAssessment,
  hasLogicalTrap: boolean,
): boolean {
  if (!hasFlaggedReviewItems(review)) return false;
  if (hasLogicalTrap || assessment.requiresConfirmation || assessment.riskLevel === 'high') return true;
  if (assessment.intent === 'delete' || assessment.intent === 'migrate' || assessment.intent === 'refactor') return true;
  return review.some((item) => item.verdict === 'unreasonable');
}

export function flaggedReviewItems(review: RequestReviewItem[]): RequestReviewItem[] {
  return review.filter((item) => item.verdict !== 'reasonable');
}

export function createRequestReviewCard(review: RequestReviewItem[]): RequestReviewCardHandle {
  const row = document.createElement('div');
  row.className = 'bubble-row request-review-row';

  const card = document.createElement('div');
  card.className = 'request-review-card';

  const head = document.createElement('div');
  head.className = 'request-review-head';
  const title = document.createElement('strong');
  title.className = 'request-review-title';
  title.textContent = '诉求合理性分析';
  head.appendChild(title);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'request-review-body';

  if (review.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'request-review-ok';
    ok.textContent = '✓ 已评估你的诉求：未发现不合理项，按计划直接执行。';
    body.appendChild(ok);
  } else {
    for (const item of review) {
      const el = document.createElement('div');
      el.className = `request-review-item request-review-${item.verdict}`;
      const marker = document.createElement('span');
      marker.className = 'request-review-marker';
      marker.textContent = item.verdict === 'reasonable' ? '✓' : item.verdict === 'questionable' ? '⚠' : '✗';
      const content = document.createElement('div');
      content.className = 'request-review-item-copy';
      const part = document.createElement('div');
      part.className = 'request-review-part';
      part.textContent = item.part;
      const meta = document.createElement('span');
      meta.className = 'request-review-verdict';
      meta.textContent = VERDICT_LABELS[item.verdict];
      part.appendChild(meta);
      const reason = document.createElement('div');
      reason.className = 'request-review-reason';
      reason.textContent = item.reason;
      content.append(part, reason);
      if (item.suggestion) {
        const suggestion = document.createElement('div');
        suggestion.className = 'request-review-suggestion';
        suggestion.textContent = `建议：${item.suggestion}`;
        content.appendChild(suggestion);
      }
      el.append(marker, content);
      body.appendChild(el);
    }
  }

  card.appendChild(body);
  row.appendChild(card);

  // Decision bar appears only when the turn pauses for a decision.
  let decisionBar: HTMLElement | null = null;
  let decided = false;
  const lock = (): void => {
    if (!decisionBar) return;
    decisionBar.querySelectorAll('button').forEach((btn) => { (btn as HTMLButtonElement).disabled = true; });
  };

  const handle: RequestReviewCardHandle = {
    el: row,
    enableDecisions(onAdjust, onProceed) {
      if (decided || decisionBar) return;
      decisionBar = document.createElement('div');
      decisionBar.className = 'request-review-actions';
      decisionBar.setAttribute('role', 'group');
      decisionBar.setAttribute('aria-label', '诉求决策');

      const adjustBtn = document.createElement('button');
      adjustBtn.type = 'button';
      adjustBtn.className = 'request-review-action request-review-action-adjust';
      adjustBtn.textContent = '采纳建议调整后继续';
      adjustBtn.setAttribute('aria-label', '按建议调整后继续执行');
      adjustBtn.addEventListener('click', () => {
        if (adjustBtn.disabled) return;
        if (onAdjust()) lock();
      });

      const proceedBtn = document.createElement('button');
      proceedBtn.type = 'button';
      proceedBtn.className = 'request-review-action request-review-action-proceed';
      proceedBtn.textContent = '仍按原诉求执行';
      proceedBtn.setAttribute('aria-label', '不调整，仍按原诉求执行');
      proceedBtn.addEventListener('click', () => {
        if (proceedBtn.disabled) return;
        if (onProceed()) lock();
      });

      decisionBar.append(adjustBtn, proceedBtn);
      row.appendChild(decisionBar);
    },
    setDecided(activity) {
      decided = true;
      if (decisionBar) {
        decisionBar.remove();
        decisionBar = null;
      }
      if (activity) {
        const note = document.createElement('div');
        note.className = 'request-review-decided';
        note.textContent = activity;
        row.appendChild(note);
      }
    },
    remove() {
      row.remove();
    },
  };
  return handle;
}

/**
 * Plain-text summary of the flagged review items, appended to the plan-pause
 * assistant message so ANY continuation turn (decision button or a typed
 * reply) has the review + suggestions in model context — the streaming card
 * itself is live-only and not restored from the transcript.
 */
export function formatRequestReviewSection(review: RequestReviewItem[]): string {
  const flagged = flaggedReviewItems(review);
  if (flagged.length === 0) return '';
  const lines = flagged.map((item, index) => {
    const tag = item.verdict === 'questionable' ? '存疑' : '不合理';
    return `${index + 1}. [${tag}] ${item.part}：${item.reason}${item.suggestion ? ` 建议：${item.suggestion}` : ''}`;
  });
  return `\n\n<request_review>\n我对你的诉求做了一轮合理性分析。以下部分需要你决策：采纳我的建议调整后继续，还是仍按原诉求执行？在你回复之前我不会执行它们。\n${lines.join('\n')}\n</request_review>`;
}
