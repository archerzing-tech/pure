// src/engine/FailurePolicy.ts
// v0.1 — Failure recovery policy: escalating retry → reflect → degrade → stop.
// Used by AgentLoopEngine when consecutive failures accumulate.

import type { FailureRecord, FailureAction, FailurePolicy } from '../shared/types';

/**
 * Default escalating failure policy:
 * - 1-2 consecutive failures → retry with light hint
 * - 3-4 consecutive failures → reflect with deeper hint
 * - 5+ consecutive failures → degrade / stop, requesting user intervention
 *
 * The engine resets failure tracking after any successful phase.
 */
export class DefaultFailurePolicy implements FailurePolicy {
  decide(failures: FailureRecord[]): FailureAction {
    if (failures.length === 0) {
      return { kind: 'retry', hint: 'Continue.' };
    }

    const last = failures[failures.length - 1];
    const count = failures.length;

    if (count <= 2) {
      return {
        kind: 'retry',
        hint: `Attempt ${count}: ${last.message}. Please retry with a simpler approach.`,
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
          `Last error: ${last.message}. Reflect deeply on what went wrong and try a fundamentally different approach.`,
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
