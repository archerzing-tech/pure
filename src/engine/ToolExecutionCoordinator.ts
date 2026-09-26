import type { EngineContext, ToolCall, ToolResult } from '../shared/types';
import { safeParseArgs } from '../shared/format';
import { isPauseAbort, PAUSE_TOOL_GRACE_MS, PAUSE_ABORT_REASON } from '../shared/pauseSignal';
import { FileLockManager } from './FileLockManager';
import { HOOK_BLOCK_EXIT_CODE, runUserHooksForEvent } from '../shared/userHookRunner';
import { runWithDeadline } from './streamDeadline';
import {
  applyRelaySubstitution,
  relayNode,
  relayReceipt,
  planRelayLevels,
  type RelayNode,
} from './relayPipeline';

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
   *
   * 接力流水线（北极星第 5 步）：批内调用可用保留参数 relay 声明接力——
   * relay.as 登记产出阶段名，relay.from 把上游阶段产出直接灌进本调用的参数
   * 槽（委派参数的声明式扩展，交接在本编排器完成，不经父级上下文中转）。
   * 无 relay 的批次与历史行为完全一致（单层、读完并发、写串行、随完成随
   * 上报）；有 relay 的批次按拓扑分层推进，同层保持原并发语义。上游产出被
   * 下游全部成功消费后，父级观察替换为一行收据（完整输出仍在活动卡与存
   * 档）——这是接力真正的收益：主会话不被中间产出刷屏；任一消费者失败则
   * 回灌完整产出，父级拿得到原料做重规划。
   */
  async *executeStream(
    toolCalls: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): AsyncGenerator<ExecutedToolResult, void, unknown> {
    if (!ctx.tools) return;
    // 委派起飞闸（2026-09-26 用户实测：插话落在委派发生之前，取消型插话
    // 找不到可停的支）。起飞前把整批调用交给宿主过一遍——这里是全批次唯
    // 一可见点（relay 分层前），宿主的区分词匹配能看到全部兄弟任务书，不
    // 会单支误杀。被拦的调用当场拿到合成结果（success:true + 取消说明，
    // 不走 success:false——那是失败口径，会把用户决定污染成任务失败），
    // 不再进执行池，分支根本不出生。
    const gated = ctx.gateDelegations ? await ctx.gateDelegations(toolCalls) : [];
    const blockedReason = new Map(gated.map((g) => [g.callId, g.reason]));
    if (blockedReason.size > 0) {
      for (const call of toolCalls) {
        const reason = blockedReason.get(call.id);
        if (reason === undefined) continue;
        yield {
          toolName: call.function.name,
          result: {
            id: call.id,
            toolName: call.function.name,
            // 结算体对齐真停支的既定形态（{aborted, outcome, reason,
            // summary}）：UI 从内层对象读 outcome 才走灰态、从 summary 取
            // 卡面正文——内层是纯字符串时 outcome 会被整个漏读，卡片按
            // 绿✓成功结算，被拦的支看起来像真跑完（2026-09-26 用户复测）。
            // reason 说给模型（别算进汇总、别再派工），summary 说给人。
            result: {
              aborted: true,
              outcome: 'stopped' as const,
              reason: `用户在派出前收掉了这项（用户原话：${reason}）。未执行、无产出，最终汇总不要包含它，也不要再为它派工。`,
              summary: `你在派出前收掉了这一路（“${reason}”）：没派出去、没有产出，也不会进最终汇总。`,
            },
            success: true,
            outcome: 'stopped',
            duration: 0,
          },
          duration: 0,
          toolCallId: call.id,
        };
      }
    }
    // Known narrow edge: the engine's consecutive-identical dedupe keys on
    // (name, raw arguments) — the raw string still contains the relay
    // DECLARATION but not the substituted upstream output. A model re-sending
    // a byte-identical downstream call in the next round gets the deduped
    // (stale-input) result. That is the dedupe contract applied uniformly;
    // not worth a cross-layer channel to fix.
    const nodes = toolCalls.map(relayNode);
    const plan = planRelayLevels(nodes);
    const nodeByCallId = new Map<string, RelayNode>(nodes.map((node) => [node.call.id, node]));

    // Budget parity with the pre-relay behavior: every call in the batch
    // counts exactly once — relay-skipped ones included (they still produce
    // a pairing result).
    for (const _node of nodes) budget.incrementToolCall();

    // Stage bookkeeping: which stages have consumers (→ hold their result
    // until every consumer settles), how many consumers are left, how many
    // succeeded, and the labels the receipt names.
    const consumerTotal = new Map<string, number>();
    const consumerLabels = new Map<string, string[]>();
    for (const level of plan.levels) {
      for (const node of level) {
        for (const stage of node.deps) {
          consumerTotal.set(stage, (consumerTotal.get(stage) ?? 0) + 1);
          const labels = consumerLabels.get(stage) ?? [];
          labels.push(node.decl?.as ?? node.call.function.name);
          consumerLabels.set(stage, labels);
        }
      }
    }
    const stageOutputs = new Map<string, ExecutedToolResult>();
    const consumerOk = new Map<string, number>();
    const consumerSettled = new Map<string, number>();
    const held = new Map<string, ExecutedToolResult>();

    // A consumer settled (ran, or was skipped because its upstream died):
    // count it, and release its held upstream once the last one lands. The
    // upstream ships as a receipt only when EVERY consumer succeeded — any
    // failure keeps the full output so the parent can re-plan from it.
    const noteSettled = (node: RelayNode, tr: ExecutedToolResult): ExecutedToolResult[] => {
      const releases: ExecutedToolResult[] = [];
      for (const stage of node.deps) {
        if (tr.result.success) consumerOk.set(stage, (consumerOk.get(stage) ?? 0) + 1);
        const settled = (consumerSettled.get(stage) ?? 0) + 1;
        consumerSettled.set(stage, settled);
        const total = consumerTotal.get(stage);
        if (total !== undefined && settled === total) {
          const upstream = held.get(stage);
          if (upstream) {
            held.delete(stage);
            releases.push(
              (consumerOk.get(stage) ?? 0) === total
                ? relayReceipt(upstream, consumerLabels.get(stage) ?? [])
                : upstream,
            );
          }
        }
      }
      return releases;
    };

    // Invalid declarations never run — pairing results go out first so the
    // transcript never hangs a call without an observation.
    for (const e of plan.errors) {
      yield {
        toolName: e.toolName,
        result: { id: e.callId, toolName: e.toolName, error: e.message, success: false, duration: 0 },
        duration: 0,
        toolCallId: e.callId,
      };
    }

    for (const level of plan.levels) {
      const levelCalls: ToolCall[] = [];
      for (const node of level) {
        // Fail-fast: a consumer whose upstream failed is skipped with a
        // reason naming the dead stage (its error rides along for triage).
        // 起飞闸拦下的调用不进池（合成取消结果已在上面发出）；它若是 relay
        // 阶段，下游按 deadStage 的既有路跳过——不会拿到被取消阶段的产出。
        if (blockedReason.has(node.call.id)) continue;
        const deadStage = node.decl?.from
          ? Object.keys(node.decl.from).find((stage) => stageOutputs.get(stage)?.result.success !== true)
          : undefined;
        if (deadStage !== undefined) {
          const upstreamError = stageOutputs.get(deadStage)?.result.error ?? '未知原因';
          const detail = upstreamError.length > 200 ? `${upstreamError.slice(0, 200)}…` : upstreamError;
          const skip: ExecutedToolResult = {
            toolName: node.call.function.name,
            result: {
              id: node.call.id,
              toolName: node.call.function.name,
              error: `relay 上游阶段 "${deadStage}" 执行失败（${detail}），本调用未执行——修复后可直接重新发起，上游完整产出见上方。`,
              success: false,
              duration: 0,
            },
            duration: 0,
            toolCallId: node.call.id,
          };
          for (const released of noteSettled(node, skip)) yield released;
          yield skip;
          continue;
        }
        levelCalls.push(
          node.decl?.from ? applyRelaySubstitution(node.call, node.decl.from, stageOutputs) : node.call,
        );
      }
      for await (const tr of this.runPool(levelCalls, ctx, budget)) {
        const node = nodeByCallId.get(tr.toolCallId);
        const as = node?.decl?.as;
        if (as) stageOutputs.set(as, tr);
        for (const released of node && node.deps.length > 0 ? noteSettled(node, tr) : []) yield released;
        // Hold a consumed stage's result until its consumers settle; anything
        // else streams out the moment it lands (GUI card liveness unchanged).
        if (as && consumerTotal.has(as)) held.set(as, tr);
        else yield tr;
      }
    }
    // Defensive flush: every consumer settles exactly once by construction,
    // so `held` drains itself — this only guards against an invariant break.
    for (const tr of held.values()) yield tr;
  }

  /** One concurrency pool over calls that are mutually independent (same
   * topological relay level): reads overlap and stream as they settle, writes
   * serialize after them. Extracted verbatim from the pre-relay
   * executeStream so the no-relay path keeps its exact behavior. */
  private async *runPool(
    calls: ToolCall[],
    ctx: EngineContext,
    budget: ToolExecutionBudget,
  ): AsyncGenerator<ExecutedToolResult, void, unknown> {
    // A read entry tags its own promise so the race loop can remove exactly
    // the entry it raced on (see the pending set below).
    type TaggedRead = { p: Promise<TaggedRead>; tr: ExecutedToolResult };
    const reads: ToolCall[] = [];
    const writes: ToolCall[] = [];
    for (const call of calls) {
      const metadata = ctx.tools!.getMetadata(call.function.name);
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
    // Pause semantics (pauseSignal.ts, 1c 暂停真即时): a PAUSE abort stops the
    // LLM stream now and gives the in-flight tool a grace window to finish —
    // if it does, its real result lands; if the grace expires, the abort is
    // forwarded carrying the pause reason, so a subagent delegation's
    // isPauseAbort(parentSignal) fires and its checkpoint + paused card path
    // works on the live GUI route. interruptible:false tools drain forever,
    // like the pre-1c pause. So the tool's view of the world hangs off its own
    // toolStop controller; hard (non-pause) aborts still forward instantly.
    // The deadline race listens on a SECOND controller (raceStop) because
    // onTimeout aborts toolStop to kill the tool — if the race itself listened
    // to toolStop, that abort would surface as AbortError and mask the
    // TimeoutError (the budget tests regress to "aborted" instead of "timed
    // out"). On old webviews where AbortSignal.reason is unreadable,
    // isPauseAbort is always false and this degrades to the hard stop.
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
    // A tool may declare its own budget (subagent delegations bracket a whole
    // nested agent loop); the generic cap covers everything that doesn't. The
    // engine's remaining wall clock still wins. Hoisted above forwardAbort so
    // the pause path can also read interruptible.
    const metadata = ctx.tools!.getMetadata(call.function.name);
    let pauseGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const forwardAbort = (): void => {
      if (!isPauseAbort(ctx.signal)) {
        toolStop.abort(ctx.signal?.reason);
        raceStop.abort(ctx.signal?.reason);
        return;
      }
      // 1c 暂停真即时（对话智能升格）：pause 不再无限排空。在飞工具有一段
      // 宽限（PAUSE_TOOL_GRACE_MS，ctx.pauseToolGraceMs 可配）：宽限内自然
      // 收尾最理想；到期未完 → 转发 abort，且 reason 带着暂停标记——它顺着
      // toolStop → parentSignal 送达子代理编排器，「暂停存档」从此在 GUI
      // 活链路分得清（isPauseAbort 可达）。声明 interruptible: false 的工具
      // 豁免：照旧排空到自然结束（写盘中的落盘动作不打断）。
      if (metadata?.interruptible === false) return;
      pauseGraceTimer = setTimeout(() => {
        toolStop.abort(PAUSE_ABORT_REASON);
        raceStop.abort(PAUSE_ABORT_REASON);
      }, ctx.pauseToolGraceMs ?? PAUSE_TOOL_GRACE_MS);
    };
    // 升级硬停（Esc 第二下 / 会话切换叫停）：宽限不再等，立即按暂停记账掐掉。
    const escalateHardStop = (): void => {
      clearTimeout(pauseGraceTimer);
      toolStop.abort(PAUSE_ABORT_REASON);
      raceStop.abort(PAUSE_ABORT_REASON);
    };
    ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
    ctx.hardStopSignal?.addEventListener('abort', escalateHardStop, { once: true });
    const lockManager = ctx.lockManager ?? this.fallbackLock;
    let executed: ToolResult | undefined;
    try {
      if (path) {
        if (write) await lockManager.acquireWrite(path, toolStop.signal);
        else await lockManager.acquireRead(path, toolStop.signal);
      }
      try {
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
        ctx.hardStopSignal?.removeEventListener('abort', escalateHardStop);
        clearTimeout(pauseGraceTimer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 宽限到期被掐的结果要说实话：不是工具自己错，是暂停的宽限到了。
      const pausedKill = isPauseAbort(toolStop.signal);
      executed = {
        id: call.id,
        toolName: call.function.name,
        error: pausedKill ? '已暂停——宽限期内没跑完，这一步先断了（进度不受影响）' : (message || 'unknown'),
        success: false,
        duration: 0,
      };
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
