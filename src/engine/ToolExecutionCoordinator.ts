import type { EngineContext, ToolCall, ToolResult } from '../shared/types';
import { safeParseArgs } from '../shared/format';
import { isPauseAbort } from '../shared/pauseSignal';
import { FileLockManager } from './FileLockManager';
import { HOOK_BLOCK_EXIT_CODE, runUserHooksForEvent } from '../shared/userHookRunner';
import { runWithDeadline } from './streamDeadline';

export const TOOL_EXECUTION_TIMEOUT_MS = 180_000;

export interface ExecutedToolResult {
  toolName: string;
  result: ToolResult;
  duration: number;
  toolCallId: string;
}

export interface ToolExecutionBudget {
  incrementToolCall(): void;
  remaining(): { time: number };
  /** Wall-clock ceiling that follows the cap actually ending the run —
   * remaining().time clamps at 0 after the soft cap, and Math.max(1, 0) used
   * to become a 1ms tool deadline that killed every later call instantly. */
  streamDeadlineMs(): number;
}

export class ToolExecutionCoordinator {
  private readonly fallbackLock = new FileLockManager();

  async execute(
    toolCalls: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): Promise<ExecutedToolResult[]> {
    const results: ExecutedToolResult[] = [];
    for await (const tr of this.executeStream(toolCalls, ctx, budget)) results.push(tr);
    return results;
  }

  /**
   * Streaming twin of execute(): yields each result THE MOMENT its tool
   * settles instead of holding the whole batch. Parallel reads (a batch of
   * subagents / research calls) otherwise report every ToolResult only after
   * the slowest sibling finishes — the GUI showed finished subagents as
   * spinning empty cards until the entire Promise.all resolved.
   * Concurrency policy (2026-09-20): ONLY isWrite tools serialize. The
   * sideEffects flag used to force the writes pool too, which ran four
   * parallel bash_executor delegations one-after-another — exactly the
   * fan-out users delegate subagents FOR. Now side-effecting-but-not-writing
   * calls (SHELL/AGENT/MCP-tagged) overlap in the reads pool; cross-sibling
   * same-file writes stay safe the other way: every subagent run shares the
   * orchestrator's single engine coordinator, so their inner write_file /
   * edit_file serialize per-path on its FileLockManager. Budget is
   * incremented exactly once per call.
   */
  async *executeStream(
    toolCalls: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): AsyncGenerator<ExecutedToolResult, void, unknown> {
    // A read entry tags its own promise so the race loop can remove exactly
    // the entry it raced on (see the pending set below).
    type TaggedRead = { p: Promise<TaggedRead>; tr: ExecutedToolResult };
    if (!ctx.tools) return;
    const reads: ToolCall[] = [];
    const writes: ToolCall[] = [];
    for (const call of toolCalls) {
      budget.incrementToolCall();
      const metadata = ctx.tools.getMetadata(call.function.name);
      if (metadata?.isWrite) writes.push(call);
      else reads.push(call);
    }

    // Each read settles into a tagged entry that carries its own promise, so
    // the loop can remove exactly the entry it raced on. (Deleting inside a
    // .then is racy: for an already-settled promise the delete microtask runs
    // before the awaiting generator resumes, draining the set mid-batch.)
    const pending = new Set<Promise<TaggedRead>>();
    for (const call of reads) {
      // Explicit annotation: the closure reads `entry` itself, which the
      // inference algorithm refuses to untangle on its own (TS7022).
      const entry: Promise<TaggedRead> =
        this.executeOne(call, ctx, budget, false).then((tr) => ({ p: entry, tr }));
      pending.add(entry);
    }
    while (pending.size > 0) {
      const { p, tr } = await Promise.race(pending);
      pending.delete(p);
      yield tr;
    }
    for (const call of writes) {
      yield await this.executeOne(call, ctx, budget, true);
    }
  }

  private async executeOne(
    call: ToolCall,
    ctx: EngineContext,
    budget: ToolExecutionBudget,
    write: boolean,
  ): Promise<ExecutedToolResult> {
    let path = '';
    let args: Record<string, unknown> = {};
    try {
      args = safeParseArgs(call.function.arguments);
      path = typeof args.path === 'string' ? args.path : '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        toolName: call.function.name,
        result: { id: call.id, toolName: call.function.name, error: message || 'invalid tool arguments', success: false, duration: 0 },
        duration: 0,
        toolCallId: call.id,
      };
    }
    // User hooks (hooks.json), on_pre_tool: exit code 2 vetoes the call
    // deterministically; every other exit is non-blocking. Skipped when no
    // runner is wired (renderer before the Tauri bridge lands).
    if (ctx.userHooks?.on_pre_tool?.length && ctx.userHookRunner) {
      const pre = await runUserHooksForEvent(ctx.userHooks, 'on_pre_tool', { event: 'on_pre_tool', tool: call.function.name, args }, ctx.userHookRunner);
      const veto = pre.find((r) => !r.timedOut && r.exitCode === HOOK_BLOCK_EXIT_CODE);
      if (veto) {
        const reason = (veto.stderr || veto.stdout).trim().slice(0, 500) || 'blocked by on_pre_tool hook';
        return {
          toolName: call.function.name,
          result: { id: call.id, toolName: call.function.name, error: `[on_pre_tool hook] ${reason}`, success: false, duration: 0 },
          duration: 0,
          toolCallId: call.id,
        };
      }
    }
    // 阶段 12 pause semantics (pauseSignal.ts): a PAUSE abort must NOT kill
    // in-flight work — "hand the current step a clean finish, keep the
    // archive". So the tool's view of the world hangs off its own toolStop
    // controller, which forwards only NON-pause aborts; a pause therefore
    // reaches the engine's THINK boundary (which yields Interrupted once the
    // batch drains) but never the tool itself. The deadline race listens on a
    // SECOND controller (raceStop) because onTimeout aborts toolStop to kill
    // the tool — if the race itself listened to toolStop, that abort would
    // surface as AbortError and mask the TimeoutError (the budget tests
    // regress to "aborted" instead of "timed out"). On old webviews where
    // AbortSignal.reason is unreadable, isPauseAbort is always false and this
    // degrades to today's forward-everything hard stop.
    if (ctx.signal?.aborted) {
      // Dequeued after the abort: a pause skips queued work entirely ("排队
      // 工具不再启动"), a hard stop used to start-then-kill them — either way
      // the call still needs a result or the transcript pairing would hang a
      // toolCall without an observation (next LLM call would 400).
      const skipped = isPauseAbort(ctx.signal) ? 'paused — not started' : 'cancelled — not started';
      return {
        toolName: call.function.name,
        result: { id: call.id, toolName: call.function.name, error: skipped, success: false, duration: 0 },
        duration: 0,
        toolCallId: call.id,
      };
    }
    const toolStop = new AbortController();
    const raceStop = new AbortController();
    const forwardAbort = (): void => {
      if (!isPauseAbort(ctx.signal)) {
        toolStop.abort(ctx.signal?.reason);
        raceStop.abort(ctx.signal?.reason);
      }
    };
    ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
    const lockManager = ctx.lockManager ?? this.fallbackLock;
    let executed: ToolResult | undefined;
    try {
      if (path) {
        if (write) await lockManager.acquireWrite(path, toolStop.signal);
        else await lockManager.acquireRead(path, toolStop.signal);
      }
      try {
        // A tool may declare its own budget (subagent delegations bracket a
        // whole nested agent loop); the generic cap covers everything that
        // doesn't. The engine's remaining wall clock still wins.
        const metadata = ctx.tools!.getMetadata(call.function.name);
        const cap = Math.min(
          metadata?.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS,
          budget.streamDeadlineMs(),
        );
        executed = await runWithDeadline(
          () => ctx.tools!.execute(call, toolStop.signal),
          raceStop.signal,
          cap,
          `tool ${call.function.name}`,
          () => toolStop.abort(),
        );
      } finally {
        ctx.signal?.removeEventListener('abort', forwardAbort);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executed = { id: call.id, toolName: call.function.name, error: message || 'unknown', success: false, duration: 0 };
    } finally {
      if (path) lockManager.release(path);
    }
    // on_post_tool runs after the lock is released, on both success and
    // failure. stdout the model should see on its next THINK is appended to a
    // string result, so the observation path needs no format awareness.
    if (ctx.userHooks?.on_post_tool?.length && ctx.userHookRunner) {
      const post = await runUserHooksForEvent(ctx.userHooks, 'on_post_tool', { event: 'on_post_tool', tool: call.function.name, args, success: executed.success }, ctx.userHookRunner);
      const output = post.map((r) => r.stdout.trim()).filter(Boolean).join('\n').trim();
      if (output && typeof executed.result === 'string') {
        executed = { ...executed, result: `${executed.result}\n[hook] ${output}` };
      }
    }
    return { toolName: call.function.name, result: executed, duration: executed.duration, toolCallId: call.id };
  }
}
