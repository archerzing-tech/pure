// src/coding-agent/turnRoute.ts
// ONE producer for "what does this fresh user turn mean?", after framework
// reform phase 1 (docs/framework-reform-2026-11.md):
//
//   1. prefetchTurnRoute   — the synchronous, I/O-free half: scheduled-timing
//      facts only. NO keyword floor — nothing here claims to know what the
//      turn is.
//   2. inferSemanticRoute  — the LLM router. The ONLY semantic judge.
//   3. compileRequestWorkflow — mode / plan / probe / delivery / confirm.
//
// 历史注：这里曾有两层关键词 floor（shouldBypassSemanticRoute 寒暄直通、
// isPlainConversational 同步复刻路由裁决）加两个单向 veto（namesAnEdit /
// namesWorkFrame），外加 taskKind 词表。它们是「路由一次 6-12s 死延迟」年代
// 的产物——用同步规则替模型下结论，代价是 2026-09 的「改代码请求被判成闲聊」
// 事故和补不完的 veto。省这一次往返的正确方式是让路由本身跑在快模型上
// （phaseModels 的 per-phase seam + startTurnRoute 预热并行），不是让词表替
// 它表态。floor 与 veto 就此退役：宿主不再对「这轮是什么」有任何同步意见，
// 路由缺席时按 workShapedFallback 保守推进（先读后动），也绝不当闲聊打发。
//
// The split into two stages is still forced by the caller's shape: chat.ts
// must kick off the router BEFORE it resolves a workspace (that await sits in
// front of the first token), and prefetch is where timing facts are read.
// Stage 1 (`prefetchTurnRoute`) is synchronous and I/O-free; stage 2
// (`decideTurnRoute`) is the async half and the one that records the decision.

import type { LLMAdapter, MessageImage } from '../shared/types';
import { compileRequestWorkflow, type CompiledRequestWorkflow, type RequestWorkflowStage } from '../shared/requestWorkflow';
import { inferSemanticRoute, type RouteContextTurn } from './Planner';
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

/** What the turn-level producer concluded:
 *  - router-decided: the LLM router answered — the only path that claims to
 *    know what the turn is.
 *  - router-skipped: the router never ran or produced nothing (no adapter /
 *    timeout / unusable JSON) — the turn is carried as work (see
 *    workShapedFallback below), which is a decision too, not an error.
 *  (`plan-continuation` is expressed as `route: null` + `continuing: true` in
 *  the signals rather than as a kind: a continuation is not a routing verdict.) */
export type TurnRouteKind = 'router-decided' | 'router-skipped';

export interface TurnRoutePrefetch {
  text: string;
  images: MessageImage[];
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
}

/** How long the router may take on a turn.
 *
 *  Measured on the configured provider (glm-5.3-flash, 2026-10-14): first
 *  content byte at 8.9s / 13.1s / 19.1s / 21.9s across runs, verdict JSON at
 *  10.8s–23.0s — and a 238-character route prompt was NOT faster than the
 *  4.7k-character one (13.1s vs 21.9s), so the wait is provider-side thinking,
 *  not payload. A blocking pre-turn verdict therefore cannot be afforded here
 *  at all: the router is started as early as possible (startTurnRoute) and a
 *  lost race is carried as work via `workShapedFallback`, never as chat.
 *  The way to shrink the wait further is a faster routing model (the
 *  per-phase adapter seam in phaseModels.ts), not a keyword floor.
 *
 *  2026-11-05 真机判例把这条线从 8s 压到 3s：deepseek 端点时段性慢时路由
 *  裁决 8s 不回，hello 每轮撞满线白等 8s 才发主请求（ttft 9.9s＝白等 8s＋
 *  主请求 1.9s）；快时段路由 1.3-2.3s 全程在线内。超时的兜底是当工作轮
 *  保守推进——对闲聊轮无损（主请求照常快出字），对工作轮无新增损失
 *  （plan/probe 判定在 8s 超时年代本来就丢，且工作轮本就主档）。裁决的
 *  价值边界与插话判定缝的 2.5s（U1）同构：轻裁决值得付的等待就是秒级，
 *  「这轮是什么」仍归路由模型裁决，这里只校准「等多久」这个物理预算。 */
const ROUTER_TIMEOUT_MS = 3_000;

/**
 * Stage 1 — synchronous, no I/O, no LLM. Everything needed before the first
 * await of a turn: whether the input named a time to run at. Nothing else —
 * what the turn IS is the router's to say.
 */
export function prefetchTurnRoute(
  text: string,
  images?: MessageImage[] | null,
  now = Date.now(),
): TurnRoutePrefetch {
  const imgs = images ?? [];
  const timing = detectScheduledInput(text, now);
  try { appendTrace({ type: 'turn_route_prefetch', reason: 'needs-router', snippet: text.slice(0, 80) }); } catch {}
  return {
    text,
    images: imgs,
    timing: timing ?? { mode: 'now' },
    defer: timing !== null,
    signals: {
      // 命中的规则名——回放一条日志时，先看它就知道是哪一层做的决定。
      // 一期后 floor 不存在了：这一跳永远交给语义路由。
      rule: 'SEMANTIC_ROUTE',
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
   *  路自己发；null = 宿主已认定这一跳不该跑（续计划）。裁决仍由本函数
   *  唯一产出——这里只搬「何时开始」，不搬「意味着什么」。 */
  preRoute?: Promise<SemanticRouteDecision | null> | null;
}

export interface TurnRouteDecision extends InputDecision {
  source: 'turn-route';
  kind: TurnRouteKind;
  /** The router's verdict; null when the router never ran or produced nothing
   *  and the turn was carried as work. */
  route: SemanticRouteDecision | null;
  workflow: CompiledRequestWorkflow;
  stage: RequestWorkflowStage;
  /** True when no router verdict was spent on this turn (no adapter, timeout,
   *  or a continuing plan keeping its approved route). */
  deterministic: boolean;
  defer: boolean;
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
  // probe to run: the router being silent is not a verdict the user should be
  // handed back as an "answer".
  const directQuestion = workflow.stage === 'direct'
    && workflow.analysis.intent.intent === 'question'
    && !workflow.workShapedFallback;
  return { action: directQuestion ? 'answer' : 'proceed', scope };
}

/**
 * Stage 2 — the one producer. Runs the router, compiles the workflow from the
 * result, and assembles the shared decision: action, confidence, timing,
 * scope, and the reasons that led there.
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
  if (!continuing && llm) {
    // The host may have already started this call (startTurnRoute) so the round
    // trip overlapped its preflight; otherwise fire it here as before.
    route = options.preRoute === undefined
      ? await inferSemanticRoute(llm, prefetch.text, signal, prefetch.images, ROUTER_TIMEOUT_MS, options.history)
      : await (options.preRoute ?? null);
  }
  const deterministic = route === null;
  // Every turn reaches the router (no floor left to excuse one), so if it
  // produced nothing the turn is carried as WORK: the one move that is right
  // under every work reading is the cheap read-only probe ("look before you
  // leap"). Calling it an "answer" would hand the user back a shrug where they
  // asked for something to be done.
  const workShapedFallback = route === null && !continuing;
  const kind: TurnRouteKind = route ? 'router-decided' : 'router-skipped';

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
  // Advisory only (see the field): the gate's verdict is reported, the action
  // the app takes is not overridden.
  const advisoryClarify = action !== 'clarify' && confidence < INPUT_CLARIFY_CONFIDENCE;

  const decision: TurnRouteDecision = {
    route,
    workflow,
    stage: workflow.stage,
    deterministic,
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
      : continuing
        ? 'continuing an approved plan; no re-route'
        : 'router produced no verdict; carried as work (read first) rather than defaulted to chat',
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
      deterministic,
      ...(advisoryClarify ? { advisoryClarify: true } : {}),
      ...(options.hasSubagents ? { hasSubagents: true } : {}),
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
 * approved route.
 */
export function startTurnRoute(
  prefetch: TurnRoutePrefetch,
  llm: LLMAdapter | null,
  opts: { continuing: boolean; history?: readonly RouteContextTurn[] },
  signal?: AbortSignal,
): Promise<SemanticRouteDecision | null> | null {
  if (opts.continuing || !llm) return null;
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
