// Long-task auto-continue (设计文档: docs/auto-continue-design.md).
//
// Removes the structural breakpoint where every plan-stage boundary waits for
// a manual "继续". After a turn that ends cleanly with real progress, the
// scheduler fires one more round with a "继续" injection — until the plan
// reaches a terminal state, the round budget is exhausted, the turn stalls,
// or the user takes over (typing / Stop / session switch all cancel the chain).
//
// This module is deliberately DOM-free and framework-free so it is unit
// testable on its own; chat.ts owns the timing (schedule from send()'s
// finally) and the actual send('继续') re-entry.

/** Default cap on auto rounds per user message. Long plans routinely need
 *  more than a handful of stage-boundary continuations; 8 used to run out
 *  mid-build with no notice. */
export const DEFAULT_AUTO_CONTINUE_MAX_ROUNDS = 20;

/** Delay between an auto round ending and the next one starting (ms). Keeps a
 * perceptible stop window for the user and lets the UI flip back to Send. */
export const AUTO_CONTINUE_DELAY_MS = 1200;

/** Turn-level signals collected at the end of a completed engine round. */
export interface AutoContinueSignals {
  /** A complex plan card is present (simple turns never chain). */
  planActive: boolean;
  /** Round ended cleanly: Completed, current generation, not paused, no question. */
  cleanEnd: boolean;
  /** Assistant's final text ended with a question — never chain past a question. */
  asksForInput: boolean;
  /** At least one tool call succeeded this round (failed/denied tools don't count). */
  hasToolSuccess: boolean;
  /** Current plan index (1-based) at round end, or -1 when no plan snapshot. */
  currentPlan: number;
  /** Current todo index (1-based) at round end, or -1 when no plan snapshot. */
  currentTodo: number;
  /** Plan reached a terminal state (completed or delivery gate blocked). */
  planTerminal: boolean;
}

/**
 * Owns the pending auto-continue timer and the per-user-message round budget.
 * One instance lives on the ChatClient; cancel() is invoked from every "human
 * took over" path (typing, send, Stop, session switch, clear).
 */
export class AutoContinueScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every cancel/schedule so a stale timer can never fire. */
  private token = 0;
  private round = 0;
  private lastPlan = -1;
  private lastTodo = -1;
  /** Consecutive rounds with no tool success and no plan movement. One stall
   *  round still continues (the model may be mid-report); two in a row ends
   *  the chain with denyReason 'stall'. */
  private stallRounds = 0;
  /** Why the chain last refused to continue ('budget' = round cap, 'stall' =
   *  repeated no-progress rounds) — surfaced to the user instead of the badge
   *  silently vanishing. */
  private deny: 'budget' | 'stall' | null = null;

  /** True when a continuation is currently scheduled (pending gap). */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** Auto rounds already fired for the current user message (0 = none yet).
   *  Exposed so the UI can show a round/max hint on each 🔁 continuation. */
  get roundCount(): number {
    return this.round;
  }

  /** Why the chain last refused to schedule (null while healthy). */
  get denyReason(): 'budget' | 'stall' | null {
    return this.deny;
  }

  /** Clear any pending continuation and reset the round budget + stall cursor. */
  cancel(): void {
    this.token++;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.round = 0;
    this.lastPlan = -1;
    this.lastTodo = -1;
    this.stallRounds = 0;
    this.deny = null;
  }

  /**
   * Evaluate the just-finished round and schedule the next auto round.
   * Returns true when a continuation was scheduled. Invoking this again while
   * a continuation is already pending supersedes it (only the newest turn's
   * signals matter).
   */
  schedule(
    signals: AutoContinueSignals,
    maxRounds = DEFAULT_AUTO_CONTINUE_MAX_ROUNDS,
    delayMs = AUTO_CONTINUE_DELAY_MS,
    onFire: () => void,
  ): boolean {
    // Any previous pending schedule is stale — the turn it described is over.
    this.token++;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Gate 1: only clean plan turns with real work chain.
    if (!signals.planActive || !signals.cleanEnd || signals.asksForInput || signals.planTerminal) return false;
    // Stall handling (relaxed): a round with no successful tool and no plan
    // movement may be a premature stop (text-only report) — the "继续" nudge
    // frequently recovers it. ONE stall round still continues; TWO in a row
    // means the model is genuinely done or stuck, so the chain ends with a
    // 'stall' deny the UI reports. Any progress resets the stall counter.
    const advanced = signals.currentPlan > this.lastPlan || signals.currentTodo > this.lastTodo;
    if (!signals.hasToolSuccess && !advanced) {
      this.stallRounds++;
      if (this.stallRounds >= 2) {
        this.stallRounds = 0;
        this.deny = 'stall';
        return false;
      }
    } else {
      this.stallRounds = 0;
    }
    // Gate 2: per-user-message round budget.
    if (this.round >= maxRounds) {
      this.deny = 'budget';
      return false;
    }
    this.deny = null;
    this.lastPlan = signals.currentPlan;
    this.lastTodo = signals.currentTodo;
    const myToken = this.token;
    this.timer = setTimeout(() => {
      this.timer = null;
      // A cancel() (user input / Stop / session switch) invalidates this token.
      if (myToken !== this.token) return;
      this.round++;
      onFire();
    }, delayMs);
    return true;
  }
}
