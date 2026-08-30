// src/ui/preflight.ts
// Submit-time error prediction & prevention for the GUI composer. Unlike the
// planner's full in-turn analysis, this runs synchronously BEFORE send so a
// destructive intent never leaves the composer without explicit confirmation.
// Pure + sync — no DOM — so it unit-tests without a harness.
//
// Scope note: this is deliberately NOT the LLM pre-analysis that was removed
// from the send path (see chat.ts: "该环节从未稳定成功"). It is deterministic
// keyword-based intent classification reusing the same assessIntent the CLI
// ships in its high-risk approval flow — cheap, synchronous, zero model calls.

import { assessIntent } from '../coding-agent/Planner';
import type { IntentAssessment } from '../coding-agent/types';

export interface PreflightGate {
  risk: 'high';
  assessment: IntentAssessment;
}

/** Returns a gate when the draft must be confirmed before sending; null = safe.
 * Only the top risk tier ('high', e.g. delete/clear/reset/drop) triggers the
 * gate — medium refactors get the planner's in-turn probe instead, and ordinary
 * questions pass straight through. */
export function checkPreflight(text: string): PreflightGate | null {
  const assessment = assessIntent(text);
  if (assessment.riskLevel === 'high') return { risk: 'high', assessment };
  return null;
}
