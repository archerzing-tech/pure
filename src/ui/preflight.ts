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
//
// Roadmap 阶段 11.1: a homophone slip used to walk straight through this gate —
// assessIntent matches literal words, so "闪除整个项目" was classified low-risk
// and the destructive send left without a confirmation. The gate now also
// assesses the typo-expanded reading and keeps the HIGHER of the two tiers
// (fail-safe: one extra confirmation beats one missed destructive action).

import { assessIntent } from '../coding-agent/Planner';
import type { IntentAssessment } from '../coding-agent/types';
import { expandRiskSynonyms, type RiskRepair } from './inputRepair';

export interface PreflightGate {
  risk: 'high';
  assessment: IntentAssessment;
  /** Set only when the typo-expanded reading is what raised the tier — i.e. the
   *  user's literal words were NOT high-risk on their own. The dialog uses this
   *  to explain why it appeared; a plainly destructive draft gets no lecture. */
  repairs?: RiskRepair[];
}

const RISK_TIER: Record<IntentAssessment['riskLevel'], number> = { low: 0, medium: 1, high: 2 };

/** Returns a gate when the draft must be confirmed before sending; null = safe.
 * Only the top risk tier ('high', e.g. delete/clear/reset/drop) triggers the
 * gate — medium refactors get the planner's in-turn probe instead, and ordinary
 * questions pass straight through. */
export function checkPreflight(text: string): PreflightGate | null {
  const direct = assessIntent(text);
  const expansion = expandRiskSynonyms(text);
  const expanded = expansion.applied.length > 0 ? assessIntent(expansion.text) : direct;
  const raisedByRepair = RISK_TIER[expanded.riskLevel] > RISK_TIER[direct.riskLevel];
  const assessment = raisedByRepair ? expanded : direct;
  if (assessment.riskLevel !== 'high') return null;
  // The assessment's impact / recommendation strings describe the destructive
  // reading; `repairs` only says which slip produced it. The original draft
  // still goes to the model untouched — the expansion never leaves this file.
  return raisedByRepair && expansion.applied.length > 0
    ? { risk: 'high', assessment, repairs: expansion.applied }
    : { risk: 'high', assessment };
}
