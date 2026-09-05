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
//        Mirrors the adapters' error text and the shared PromptAssembler contract
//        so the policy reinforces it even when the raw error message does not.

import type { FailureRecord, FailureAction, FailurePolicy } from '../shared/types';
import { classifyFailure, FAILURE_CLASS_HINTS } from '../shared/netGuard';

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
// empty/failed-search messages and the shared PromptAssembler contract. Starts with
// "Do NOT" (no "if" hedge): the webHint guard already guarantees the failing
// tool is web_search, so the appended sentence can state the rule directly.
const WEB_SEARCH_RECOVERY_HINT =
  ' Do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.';

const EDIT_MISMATCH_RECOVERY_HINT =
  ' The edit_file target no longer matches the current file. Do NOT repeat the same edit_file call. First call read_file on the target path, compare the current contents with the intended change, then use a shorter exact context or write a complete corrected file only when justified. If the requested change is already present, verify it and move on.';

function isEditMismatch(failure: FailureRecord): boolean {
  return failure.toolName === 'edit_file' && /String not found in file|file may have changed|target no longer matches/i.test(failure.message);
}

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
 * the model keeps walking the same dead-end path. The policy recognizes
 * identical repeats and escalates faster with an explicit "do not repeat this
 * call" instruction:
 * - same error repeated 2× → reflect + tell the model to stop making that call
 * - same error repeated 3-4× → degrade: SKIP the failing call, take a workable
 *   alternative, CONTINUE the task (a hard stop here aborted multi-step work
 *   over one non-critical failing call — e.g. a website build dying on a
 *   blocked resource download)
 * - same error repeated 5× → stop (it kept failing even after the directive)
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
    const webHint = ['web_search', 'researcher_web', 'researcher_docs'].includes(last.toolName ?? '')
      ? WEB_SEARCH_RECOVERY_HINT
      : '';
    const editHint = isEditMismatch(last) ? EDIT_MISMATCH_RECOVERY_HINT : '';

    // Same call failed 5+ times with the same error: it kept failing even
    // after the skip-it directive below — a genuine stuck loop. Stop instead
    // of grinding toward the generic 6-failure ceiling.
    if (repeats >= 5) {
      return {
        kind: 'stop',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call kept failing even after a skip-it directive was issued — stopping here rather than retrying again. Please review and provide guidance.`,
      };
    }

    // Same call failed 3-4 times with the same error: the model is looping on
    // one dead-end call, but the TASK may be perfectly salvageable. This used
    // to be a hard stop — which aborted multi-step work (e.g. a website build
    // where one resource download kept failing) and threw away its own
    // advice, because the model never got the chance to act on it. Degrade
    // instead: the engine injects the directive and the loop continues, so
    // the model can skip the call and finish the remaining steps.
    if (repeats >= 3) {
      return {
        kind: 'degrade',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call keeps failing with the same error — SKIP it now. Do not retry it with the same or trivially-different arguments. Take a workable alternative that still serves the user's goal (a different source or tool, inline or substitute the content, or omit this step) and CONTINUE the task. A further identical failure will hand the turn back to the user.${webHint}`,
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

    // ── Class-level loop detection (v0.13) ──
    // Diverse arguments, same failure CLASS. Three different URLs failing with
    // three different network errors against the same dead host used to evade
    // the identical-repeat detector and grind to the generic 6-failure
    // ceiling. Same tool + same class is a loop even when the messages differ.
    const lastClass = classifyFailure(last.message);
    const classHint = FAILURE_CLASS_HINTS[lastClass];
    const classRepeats = lastClass === 'generic'
      ? 0
      : failures.filter(f => f.toolName === last.toolName && classifyFailure(f.message) === lastClass).length;
    if (classRepeats >= 4) {
      return {
        kind: 'degrade',
        reason: `${classRepeats} failures of the same class (${lastClass}) from ${last.toolName ?? 'this tool'}, most recently: "${last.message}". Stop attacking this path from different angles. ${classHint} Then CONTINUE the task with what is achievable.`,
      };
    }
    if (classRepeats === 3) {
      return {
        kind: 'reflect',
        hint: `3 failures of the same class (${lastClass}) from ${last.toolName ?? 'this tool'}, most recently: "${last.message}". ${classHint}`,
      };
    }

    if (count <= 2) {
      // 2nd failure = the first round of testing already failed → prime the
      // model to consider that the REQUEST may be the trap, not its execution.
      const trapNote = count === 2 ? TRAP_ESCAPE_HINT : '';
      return {
        kind: 'retry',
        hint: `Attempt ${count}: ${last.message}. ${isEditMismatch(last) ? 'Re-read the current file before making any further edit.' : 'Please retry with a simpler approach.'}${webHint}${editHint}${trapNote}`,
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
          `Last error: ${last.message}. Reflect deeply on what went wrong and try a fundamentally different approach.${webHint}${editHint}${TRAP_ESCAPE_HINT}`,
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
      reason: `${count} consecutive failures (last: ${last.message}). Switched to degraded / simplified mode: stop retrying the failing approach, minimize further tool use, and deliver the simplest complete answer — or hand control back to the user with a clear summary of what was attempted and what failed.`,
    };
  }
}
