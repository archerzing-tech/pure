// src/coding-agent/turnRoute.ts
// ONE producer for "what does this fresh user turn mean?", replacing five
// separate derivations that had no arbitration between them:
//
//   1. shouldBypassSemanticRoute  — is it so trivially conversational that no
//      router call (and no workspace) is needed?
//   2. isPlainConversational      — does the synchronous Planner floor already
//      reproduce the router's verdict, so the round trip can be skipped?
//   3. inferSemanticRoute         — the hidden LLM router.
//   4. compileRequestWorkflow     — mode / plan / probe / delivery / confirm.
//   5. Planner.analyzeTask        — the keyword floor used by 2 and 4.
//
// They were individually reasonable and jointly unaccountable: nothing recorded
// which layer decided, and two of them could disagree with no one to break the
// tie. The observed failure came from exactly that seam — a modify request
// ("把 scrollPin 里的自动滚动改成按块触发…") that the synchronous rules read as
// a plain question, so (2) short-circuited (3) and the turn answered a question
// nobody asked.
//
// The convergence is not "one function decides everything" — the layers keep
// their jobs. It is: one call site, one decision OBJECT (inputDecision.ts's
// InputDecision, the same shape the mid-run insert classifier emits), one
// recorded reason. Callers switch on `route` / `workflow` exactly as before;
// what changes is that the decision is now inspectable and replayable.
//
// The split into two stages is forced by the caller's shape, not by taste:
// chat.ts must know whether the turn is workspace-free BEFORE it resolves a
// workspace (that await sits in front of the first token), and the router can
// only run after. Stage 1 (`prefetchTurnRoute`) is therefore synchronous and
// I/O-free; stage 2 (`decideTurnRoute`) is the async half and the one that
// records the final decision.

import type { LLMAdapter, MessageImage } from '../shared/types';
import { compileRequestWorkflow, type CompiledRequestWorkflow, type RequestWorkflowStage } from '../shared/requestWorkflow';
import { inferSemanticRoute, isPlainConversational, namesWorkFrame, shouldBypassSemanticRoute, type RouteContextTurn } from './Planner';
import { detectTaskKind, isFileMutating, type TaskKind } from '../shared/taskKind';
import { appendTrace } from '../evolution/trace';
import type { SemanticRouteDecision, TaskMode } from './types';
import {
  INPUT_CLARIFY_CONFIDENCE,
  inputDefaultConfidence,
  detectScheduledInput,
  recordInputDecision,
  type InputAction,
  type InputDecision,
  type InputScope,
  type InputTiming,
} from './inputDecision';

/** What the turn-level producer concluded, in the shared vocabulary:
 *  - pleasantry: deterministic small talk — no router, no workspace
 *  - conversational: the synchronous floor already reproduced the router's
 *    verdict, so the hidden round trip is skipped
 *  - router-decided: the LLM router answered
 *  - router-skipped: the router was asked but produced nothing (timeout /
 *    unusable JSON) — the Planner floor carries the turn, which is a decision
 *    too, not an error
 *  (`plan-continuation` is expressed as `route: null` + `continuing: true` in
 *  the signals rather than as a kind: a continuation is not a routing verdict.) */
export type TurnRouteKind = 'pleasantry' | 'conversational' | 'router-decided' | 'router-skipped';

export interface TurnRoutePrefetch {
  text: string;
  images: MessageImage[];
  kind: 'pleasantry' | 'conversational' | 'needs-router';
  taskKind?: TaskKind;
  fileMutating?: boolean;
  /** True when only the LLM router can settle this turn's shape. */
  needsRouter: boolean;
  /** The turn can run with NO workspace and NO tools: the rules already proved
   *  it is pure small talk. Deliberately NARROWER than `kind !== 'needs-router'`
   *  — this is a different question ("does resolving a workspace buy anything?")
   *  and the answer must not change what the router does. `isPlainConversational`
   *  admits prompts like "现有页面很难看，我应该从哪些设计方向改善？" whose answer
   *  genuinely wants to read the code, so folding the two into one flag would
   *  silently strip file access from turns that need it. */
  workspaceFree: boolean;
  /** When this input wants to run — `at` only when it named a moment. */
  timing: InputTiming;
  /** True → the input named a moment to run at, so whoever CAN hold it should.
   *  Read off the user's own words (detectScheduledInput) and never inferred.
   *
   *  Deliberately a FACT about the input, not an action: holding is the host's
   *  decision, because only the host knows whether it has somewhere that can
   *  actually wait (main.ts's durable queue vs. a CLI process). `decideTurnRoute`
   *  therefore never turns this into `action: 'queue'` — a producer that
   *  claimed to hold a turn it then ran would make the log lie about the one
   *  thing the log exists to answer. */
  defer: boolean;
  signals: InputDecision['signals'];
  /** The synchronous floor's own reading, before the edit-frame veto. True when
   *  it was ready to skip the router, i.e. it read the input as chat. */
  floorChat: boolean;
}

// The floor's one blind spot that costs real work: it reads an edit request as
// a plain question when the request names its target instead of an artifact
// class, so the chit-chat shortcut fires and the router never runs (measured
// 2026-09: "把 src/ui/scrollPin.ts 里的自动滚动改成按块触发…" —
// isPlainConversational returns true for it). The veto below is one-way by
// construction: it can only force MORE routing, never less, so a false positive
// costs one hidden round trip and a false negative costs a misrouted turn.
// Both halves must match — an edit verb AND an identifiable thing to edit —
// which keeps questions about the code out of it ("这个 ts 文件为什么这么写？").
const EDIT_VERB_RE = /(?:改成|改成|改为|改用|换成|替换|替掉|重命名|重构|删除|移除|去掉|移出|加上|添上|插入|抽取|拆出|拆分|迁移|升级|降级|修正|修复|调试|实现|接入|接上|改写|优化|调整|修改|改造|重写|切到|切到|迁到|补上|补齐)/;
const EDIT_TARGET_RE = /(?:\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|css|scss|html|json|toml|yaml|yml|md|sql|sh)\b|`[^`\n]+`|[\w.-]+\/[\w./-]+|(?:文件|目录|文件夹|页面|界面|组件|函数|方法|模块|接口|脚本|配置|样式|代码|项目|仓库|数据库|字段|路由|接口|逻辑|参数|默认值|阈值|检测器|工作流|构建|测试|类型|常量|变量))/;

function namesAnEdit(text: string): boolean {
  return EDIT_VERB_RE.test(text) && EDIT_TARGET_RE.test(text);
}

/** How long the router may take on a turn the floor could NOT settle.
 *
 *  Measured on the configured provider (glm-5.3-flash, 2026-10-14): first
 *  content byte at 8.9s / 13.1s / 19.1s / 21.9s across runs, verdict JSON at
 *  10.8s–23.0s — and a 238-character route prompt was NOT faster than the
 *  4.7k-character one (13.1s vs 21.9s), so the wait is provider-side thinking,
 *  not payload. A blocking pre-turn verdict therefore cannot be afforded here
 *  at all.
 *
 *  The cap is deliberately kept BELOW those latencies rather than raised to
 *  cover them: the router is an optimization (a verdict that arrives outranks
 *  the keyword floor), while the turn's correctness no longer depends on it —
 *  a lost race is carried as work via `workShapedFallback` below. Waiting 20s+
 *  in front of every work-shaped turn to win that lottery is a worse product
 *  than starting promptly on the safe reading. The way to get the verdict back
 *  on a slow provider is to run this phase on a fast model (the per-phase
 *  adapter seam in phaseModels.ts), not to make the user wait. */
const ROUTER_TIMEOUT_MS = 8_000;

/**
 * Stage 1 — synchronous, no I/O, no LLM. Everything needed before the first
 * await of a turn: the small-talk bypass, the conversational skip, and whether
 * the input named a time to run at.
 */
export function prefetchTurnRoute(
  text: string,
  images?: MessageImage[] | null,
  now = Date.now(),
): TurnRoutePrefetch {
  const imgs = images ?? [];
  const taskKind = detectTaskKind(text);
  const fileMutating = isFileMutating(text);
  const timing = detectScheduledInput(text, now);
  const pleasantry = shouldBypassSemanticRoute(text, imgs);
  // The floor's RAW verdict, kept even when the veto below overrides it: the
  // disagreement between this and the router is the incident shape, and it is
  // only visible if the overridden read is still in the record.
  const floorChat = pleasantry || isPlainConversational(text, imgs);
  const editVeto = !pleasantry && floorChat && namesAnEdit(text);
  // The floor's `question` is a default, not a verdict (see namesWorkFrame):
  // when the message names work, the fast path may not settle the turn.
  const workFrameVeto = !pleasantry && floorChat && !editVeto && namesWorkFrame(text);
  const conversational = floorChat && !editVeto && !workFrameVeto;
  const kind: TurnRoutePrefetch['kind'] = pleasantry
    ? 'pleasantry'
    : conversational
      ? 'conversational'
      : 'needs-router';
  try { appendTrace({ type: 'turn_route_prefetch', reason: kind, snippet: text.slice(0, 80) }); } catch {}
  return {
    text,
    images: imgs,
    kind,
    taskKind,
    fileMutating,
    needsRouter: kind === 'needs-router',
    workspaceFree: pleasantry,
    floorChat,
    timing: timing ?? { mode: 'now' },
    defer: timing !== null,
    signals: {
      // 命中的规则名——回放一条日志时，先看它就知道是哪一层做的决定。
      rule: pleasantry ? 'PLEASANTRY_BYPASS' : conversational ? 'PLAIN_CONVERSATIONAL' : 'SEMANTIC_ROUTE',
      floor: floorChat ? 'chat' : 'work',
      taskKind,
      fileMutating,
      ...(editVeto ? { editFrameVeto: true } : {}),
      ...(workFrameVeto ? { workFrameVeto: true } : {}),
      ...(timing ? { scheduledAt: timing.at, scheduledText: timing.text } : {}),
    },
  };
}

export interface TurnRouteOptions {
  forcedMode?: TaskMode;
  hasTools: boolean;
  hasSubagents?: boolean;
  continuingPlan?: boolean;
  planPauseRequested?: boolean;
  continuingProjectBuild?: boolean;
  /** Record into the replayable log (inputDecision.ts). Off for probes: a log
   *  full of probe noise is not evidence. */
  log?: boolean;
  /** The tail of the conversation, so a follow-up is routed as a continuation
   *  rather than as a standalone sentence (see routeHistoryMessages). Absent
   *  for a first turn — there is nothing to continue. */
  history?: readonly RouteContextTurn[];
  /** 第 6 期：宿主已用 startTurnRoute 抢先开始了这一跳（与工作区/探针并行），
   *  把 promise 交给这里，避免再发第二次调用。undefined = 宿主没预启动，按老
   *  路自己发；null = 宿主已认定这一跳不该跑（续计划/闲聊）。裁决仍由本函数
   *  唯一产出——这里只搬「何时开始」，不搬「意味着什么」。 */
  preRoute?: Promise<SemanticRouteDecision | null> | null;
}

export interface TurnRouteDecision extends InputDecision {
  source: 'turn-route';
  kind: TurnRouteKind;
  /** The router's verdict; null when the turn never needed one or the router
   *  produced nothing and the Planner floor carried it. */
  route: SemanticRouteDecision | null;
  workflow: CompiledRequestWorkflow;
  stage: RequestWorkflowStage;
  /** True when no router round trip was spent on this turn. */
  deterministic: boolean;
  defer: boolean;
  /** Did the synchronous floor and the router reach the same verdict (both
   *  read it as chat, or both read it as work)? A disagreement is not an error
   *  — the router outranks the keyword floor by design — but it is the exact
   *  shape the "modify request answered as chit-chat" incident took, so it
   *  stays in the signals where a replay can find it. */
  agreement: boolean;
  /** The router reported real doubt (below the clarify gate). Recorded, NOT
   *  acted on here: stopping the turn the user just sent to ask a question is a
   *  bigger cost than the misroute it would prevent, and a full turn has no
   *  "safe destination" the way a mid-run insert does (queueing it changes its
   *  meaning). The log is how we find out whether the router hedges often enough
   *  to be worth acting on. */
  advisoryClarify: boolean;
}

/** How each pipeline shapes up as an action/scope pair. `answer` is reserved
 *  for the direct-question case on purpose: everything else moves the turn
 *  forward with work, which is `proceed`. */
function classifyTurnWorkflow(workflow: CompiledRequestWorkflow): { action: InputAction; scope: InputScope[] } {
  const scope: InputScope[] = [];
  if (workflow.requiresPlanReview) scope.push('plan');
  if (workflow.needsProbe) scope.push('resources');
  if (workflow.needsDeliveryGate) scope.push('output-format');
  if (workflow.analysis.intent.requiresConfirmation) scope.push('constraints');
  if (scope.length === 0) scope.push('none');
  // An unclassified work-shaped turn is NOT an answer turn even when it has no
  // probe to run: the floor's `question` is what it could not settle, not a
  // verdict the user should be handed back.
  const directQuestion = workflow.stage === 'direct'
    && workflow.analysis.intent.intent === 'question'
    && !workflow.workShapedFallback;
  return { action: directQuestion ? 'answer' : 'proceed', scope };
}

/** Did the floor and the router read the turn the same way? Reduced to one bit
 *  ("is this chat or work?") because that is the only thing the floor ever
 *  claims to know. A null route means the router never ran, so the two layers
 *  cannot disagree. Both directions of disagreement matter: the floor smugly
 *  calling a real edit "chat" (the veto above) and the floor cautiously calling
 *  chat "work" are both visible here. */
function readsAsChat(route: SemanticRouteDecision): boolean {
  return route.intent === 'question' && route.complexity === 'simple' && route.mode === 'yolo';
}

/**
 * Stage 2 — the one producer. Runs the router (when stage 1 said it is needed),
 * compiles the workflow from the result, and assembles the shared decision:
 * action, confidence, timing, scope, and the reasons that led there.
 */
export async function decideTurnRoute(
  prefetch: TurnRoutePrefetch,
  llm: LLMAdapter | null,
  options: TurnRouteOptions,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<TurnRouteDecision> {
  const continuing = options.continuingPlan === true || options.planPauseRequested === true;
  let route: SemanticRouteDecision | null = null;
  // A continuing plan keeps its already-approved route: re-routing "继续" would
  // let the router turn a mid-plan nudge into a fresh plan.
  if (!continuing && prefetch.needsRouter && llm) {
    // The host may have already started this call (startTurnRoute) so the round
    // trip overlapped its preflight; otherwise fire it here as before.
    route = options.preRoute === undefined
      ? await inferSemanticRoute(llm, prefetch.text, signal, prefetch.images, ROUTER_TIMEOUT_MS, options.history)
      : await (options.preRoute ?? null);
  }
  const deterministic = route === null;
  // The router was ASKED because the floor could not settle this turn — so if
  // it produced nothing, the floor's read is not the fallback, it is the same
  // guess that was already rejected. Carrying it as work is the conservative
  // reading and the one that keeps the turn's structure (read first, never
  // report an unclassified work request to the user as an "answer").
  const workShapedFallback = route === null && prefetch.needsRouter && !continuing;
  const kind: TurnRouteKind = route
    ? 'router-decided'
    : prefetch.kind === 'pleasantry'
      ? 'pleasantry'
      : prefetch.kind === 'conversational'
        ? 'conversational'
        : 'router-skipped';

  const workflow = compileRequestWorkflow(prefetch.text, {
    forcedMode: options.forcedMode,
    hasTools: options.hasTools,
    continuingPlan: options.continuingPlan,
    planPauseRequested: options.planPauseRequested,
    continuingProjectBuild: options.continuingProjectBuild,
    semanticRoute: route,
    workShapedFallback,
  });

  // What the turn IS. Whether it runs now or at the named moment is a separate
  // decision, taken and recorded by whoever can hold it (see `defer` above).
  const { action, scope } = classifyTurnWorkflow(workflow);
  const confidence = route
    ? route.confidence ?? inputDefaultConfidence()
    : 1;
  const agreement = route === null || readsAsChat(route) === prefetch.floorChat;
  // Advisory only (see the field): the gate's verdict is reported, the action
  // the app takes is not overridden.
  const advisoryClarify = action !== 'clarify' && confidence < INPUT_CLARIFY_CONFIDENCE;

  // 保守强化：明显文件改动且有多 agent 时，向信号里加一个轻微倾向
  const fileMutateGate = Boolean(prefetch.fileMutating && options.hasSubagents);
  const decision: TurnRouteDecision = {
    route,
    workflow,
    stage: workflow.stage,
    deterministic,
    agreement,
    source: 'turn-route',
    kind,
    action,
    confidence,
    timing: prefetch.timing,
    scope,
    // A fresh turn has nothing in flight to tear down: its abort semantics
    // belong to the caller (pause/supersede), never to the route decision.
    shouldAbort: false,
    reason: route
      ? `semantic router: ${route.intent}/${route.complexity}/${route.mode}`
      : prefetch.kind === 'pleasantry'
        ? 'deterministic small talk; no router call and no workspace needed'          : prefetch.kind === 'conversational'
          ? 'synchronous floor already reproduced the router verdict; round trip skipped'
          : 'router produced no verdict on a work-shaped turn; carried as work (read first) rather than defaulted to chat',
    signals: {
      ...prefetch.signals,
      ...(route ? { routerIntent: route.intent, routerMode: route.mode, routerComplexity: route.complexity } : {}),
      ...(route && route.confidence === undefined ? { confidenceDefaulted: true } : {}),
      ...(workShapedFallback ? { workShapedFallback: true, routerTimeoutMs: ROUTER_TIMEOUT_MS } : {}),
      ...(route ? { routeHistoryTurns: options.history?.length ?? 0 } : {}),
      // The router contradicting itself is recorded, not hidden: it is the rate
      // that tells us whether the route prompt needs fixing (see the precedence
      // rule in requestWorkflow.compileRequestWorkflow).
      ...(route && route.mode === 'plan' && !route.requiresPlan ? { routerPlanFlagInconsistent: true } : {}),
      continuing,
      stage: workflow.stage,
      agreement,
      deterministic,
      ...(advisoryClarify ? { advisoryClarify: true } : {}),
      ...(prefetch.fileMutating ? { fileMutating: true } : {}),
      ...(options.hasSubagents ? { hasSubagents: true } : {}),
      ...(fileMutateGate ? { fileMutateWithSubagents: true } : {}),
    },
    defer: prefetch.defer,
    advisoryClarify,
  };

  try { appendTrace({ type: 'turn_route_decided', route: kind, reason: decision.reason, snippet: prefetch.text.slice(0, 80) }); } catch {}
  if (options.log !== false) recordInputDecision(decision, now);
  return decision;
}

/**
 * Stage 1.5 — start the hidden router WITHOUT deciding anything yet. The host
 * calls this right after the workspace is known, so the round trip overlaps the
 * rest of its preflight (the memory harvest and the runtime probe) instead of
 * sitting alone on the critical path immediately before the engine.
 *
 * It is deliberately NOT a second producer: the returned promise is handed back
 * to decideTurnRoute (`preRoute`), which still compiles the workflow, records
 * the decision, and owns the meaning. This only moves WHEN the model call
 * starts. Returns null when no call is warranted — a continuation keeps its
 * approved route, and a pleasantry/conversational turn never needed one.
 */
export function startTurnRoute(
  prefetch: TurnRoutePrefetch,
  llm: LLMAdapter | null,
  opts: { continuing: boolean; history?: readonly RouteContextTurn[] },
  signal?: AbortSignal,
): Promise<SemanticRouteDecision | null> | null {
  if (opts.continuing || !prefetch.needsRouter || !llm) return null;
  return inferSemanticRoute(llm, prefetch.text, signal, prefetch.images, ROUTER_TIMEOUT_MS, opts.history);
}

/**
 * The host's HOLD decision — a second, separate decision about the same input
 * ("when does it run" as opposed to "what is it"), in the same shape and the
 * same log. Recorded by the host because that is who knows whether it has
 * somewhere the input can actually wait; see `TurnRoutePrefetch.defer`.
 */
export function recordScheduledInput(prefetch: TurnRoutePrefetch, at: number, now = Date.now()): InputDecision {
  const decision: InputDecision = {
    source: 'host-schedule',
    kind: 'named-moment',
    action: 'queue',
    // Full confidence: the moment was read off the user's own words and the
    // host has a queue that survives a reload. Nothing here is a guess.
    confidence: 1,
    timing: { ...prefetch.timing, mode: 'at', at },
    scope: ['timing'],
    shouldAbort: false,
    reason: 'the input named its own run time; held in the durable queue until then',
    signals: { ...prefetch.signals, dueAt: at, heldForMs: at - now },
  };
  recordInputDecision(decision, now);
  return decision;
}
