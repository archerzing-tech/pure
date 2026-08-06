// src/engine/FailurePolicy.ts
// v0.1 — Failure recovery policy: escalating retry → reflect → degrade → stop.
// Used by AgentLoopEngine when consecutive failures accumulate.
// v0.2 — logical-trap escape: after a failed round the hints tell the model to
//        re-read the ORIGINAL request and consider that the premise itself may
//        be a trap (self-contradictory / impossible / trick) — switch to a
//        different interpretation instead of grinding the same dead-end.
// v0.12 — web_search recovery guidance: when the failing tool is web_search,
//        retry/reflect hints append explicit "rephrase, don't repeat" guidance
//        (a dead-end query or a down backend must not be retried verbatim).
//        Mirrors the adapters' error text and the CLI/GUI BASE_SYSTEM_PROMPT
//        so the policy reinforces it even when the raw error message does not.

import type { FailureRecord, FailureAction, FailurePolicy } from '../shared/types';

// Trap-escape guidance appended to retry/reflect hints once the first attempt
// has already failed: the failure may not be in the model's execution but in
// the request's premise. Re-reading the original prompt and switching approach
// beats repeating the same failing path.
const TRAP_ESCAPE_HINT =
  ' Also re-read the ORIGINAL user request: the failure may be a logical trap (self-contradictory, impossible, or mutually exclusive constraints, or a trick premise). If the premise itself is flawed, state the trap and solve the most reasonable interpretation instead of repeating the same approach.';

// Web-search recovery guidance appended to retry/reflect hints (and the
// identical-repeat stop reason) when the failing tool is web_search. Repeating
// the same or a near-identical query is the classic web_search failure loop —
// the fix is to rephrase, not retry verbatim. Wording mirrors the adapters'
// empty/failed-search messages and the CLI's BASE_SYSTEM_PROMPT. Starts with
// "Do NOT" (no "if" hedge): the webHint guard already guarantees the failing
// tool is web_search, so the appended sentence can state the rule directly.
const WEB_SEARCH_RECOVERY_HINT =
  ' Do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.';

/**
 * Default escalating failure policy:
 * - 1-2 consecutive failures → retry with light hint
 * - 3-4 consecutive failures → reflect with deeper hint
 * - 5+ consecutive failures → degrade / stop, requesting user intervention
 *
 * The engine resets failure tracking after any successful phase.
 *
 * v0.11 — repeated-error detection: when the SAME call (same tool + same error
 * message) fails over and over, count-based escalation alone is not enough —
 * the model keeps walking the same dead-end path. The policy now recognizes
 * identical repeats and escalates faster with an explicit "do not repeat this
 * call" instruction:
 * - same error repeated 2× → reflect + tell the model to stop making that call
 * - same error repeated 3× → stop (do not wait for 6 total failures)
 */
function repeatKey(f: FailureRecord): string {
  // toolName separates "web_fetch failed on URL A" from "read_file failed";
  // the message identifies the same dead-end (e.g. repeated "unsupported
  // content type" from the same tool).
  return `${f.toolName ?? ''}::${f.message}`;
}

export class DefaultFailurePolicy implements FailurePolicy {
  decide(failures: FailureRecord[]): FailureAction {
    if (failures.length === 0) {
      return { kind: 'retry', hint: 'Continue.' };
    }

    const last = failures[failures.length - 1];
    const count = failures.length;

    // ── Repeated-identical-error detection (v0.11) ──
    const repeats = failures.filter(f => repeatKey(f) === repeatKey(last)).length;
    const toolLabel = last.toolName ? ` (tool: ${last.toolName})` : '';
    // Web-search recovery guidance only applies when the failing call is a
    // web_search — for other tools it would be noise.
    const webHint = last.toolName === 'web_search' ? WEB_SEARCH_RECOVERY_HINT : '';

    // Same call failed 3+ times with the same error: the model is looping.
    // Stop now instead of grinding through the generic 6-failure ceiling.
    // webHint rides along here (unlike the count-based handoff branches below):
    // an identical web_search repeat is exactly the same-query loop the
    // guidance targets, and this reason is surfaced to the user as well.
    if (repeats >= 3) {
      return {
        kind: 'stop',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call keeps failing with the same error — stop making it. Switch to a fundamentally different approach or ask the user.${webHint}`,
      };
    }

    // Same call failed twice with the same error: escalate to reflect with an
    // explicit instruction not to repeat the exact call.
    if (repeats === 2) {
      return {
        kind: 'reflect',
        hint: `The same call${toolLabel} has now failed twice with the identical error: "${last.message}". Do NOT make this exact call again — it will fail the same way. Change approach now (different tool, different URL, or ask the user).${webHint}${TRAP_ESCAPE_HINT}`,
      };
    }

    if (count <= 2) {
      // 2nd failure = the first round of testing already failed → prime the
      // model to consider that the REQUEST may be the trap, not its execution.
      const trapNote = count === 2 ? TRAP_ESCAPE_HINT : '';
      return {
        kind: 'retry',
        hint: `Attempt ${count}: ${last.message}. Please retry with a simpler approach.${webHint}${trapNote}`,
      };
    }

    if (count <= 4) {
      const toolHints = failures
        .filter(f => f.toolName)
        .map(f => f.toolName)
        .join(', ');
      return {
        kind: 'reflect',
        hint: `${count} consecutive failures${toolHints ? ' involving ' + toolHints : ''}. ` +
          `Last error: ${last.message}. Reflect deeply on what went wrong and try a fundamentally different approach.${webHint}${TRAP_ESCAPE_HINT}`,
      };
    }

    // count >= 5 → degrade or stop
    if (count >= 6) {
      return {
        kind: 'stop',
        reason: `${count} consecutive failures. Last: ${last.message}. Please review and provide guidance.`,
      };
    }

    return {
      kind: 'degrade',
      reason: `${count} consecutive failures. Switched to degraded / simplified mode.`,
    };
  }
}
