// src/coding-agent/turnRoute.ts
// ONE producer for the turn-level workflow, after the pre-turn LLM router
// retired (2026-11-06, docs: three-way comparison Claude Code / opencode /
// Codebuff). What remains is mechanical and synchronous:
//
//   1. prefetchTurnRoute — scheduled-timing facts read off the user's own
//      words (detectScheduledInput). Nothing here claims to know what the
//      turn is.
//   2. turnShape — shape facts about the input text (code block / long form /
//      short chat). Facts, not verdicts: they only choose WHICH PIPELINE a
//      turn walks, never what the turn means.
//   3. compileTurnRoute — compiles the request workflow (plan / probe /
//      delivery / confirm gates) from those facts and records the decision.
//
// 历史注：这里曾有两层关键词 floor（寒暄直通/同步复刻裁决）加两个单向
// veto——「路由一次 6-12s 死延迟」年代的产物，2026-09「改代码请求被判成
// 闲聊」事故后退役，换 LLM 语义路由（inferSemanticRoute）。语义路由本身在
// 2026-11-06 也退役：它每回合在临界路径上雇一次判定调用（1.2-3s + 慢时段
// 白等 + 与主请求挤同一端点的忙窗连坐），而三家对照证明最成功的 agent 都
// 不做回合前预判——模式显式切换或模型流内自决。退役不回词表 floor 的老路：
// floor 替模型下「这轮是什么」的结论（判闲聊→打发），shape 只决定「走哪个
// 流程」——判错代价是多付或省下一次可见思考，不再有「答非所问」形状。
//
// 「这轮是什么」的裁决权归还模型：主请求零预判秒发，思考档位由形态判据
// 决定（chat.ts isLightShapedTurn），规划流程由 planByThinking 当着用户
// 想出来（想完自己决定出不出卡）。

import type { MessageImage } from '../shared/types';
import type { TaskMode } from './types';
import { compileRequestWorkflow, type CompiledRequestWorkflow, type RequestWorkflowStage } from '../shared/requestWorkflow';
import { appendTrace } from '../evolution/trace';
import {
  detectScheduledInput,
  recordInputDecision,
  type InputDecision,
  type InputScope,
  type InputTiming,
} from './inputDecision';

/** Shape facts about the input text. Mechanical, zero-cost, and deliberately
 *  NOT a classification: the host answers "which pipeline", never "what is
 *  this". Thresholds are generous on purpose — the miss direction is cheap
 *  (a chit-chat turn that walks the thinking pipeline is a few wasted
 *  seconds; a work turn that skips it still has the resident work protocol). */
export interface TurnShape {
  /** The input carries a fenced code block (``` … ```) — pasted code is the
   *  strongest work signal there is. */
  codeShaped: boolean;
  /** The input is a long-form description (>= LONG_FORM_CHARS). */
  longForm: boolean;
  /** The input is too short to carry work (<= SHORT_TURN_CHARS, no code
   *  block, no URL, no path/domain shape) — the chit-chat shape. A short
   *  sentence CAN carry work ("把 src/ui/scrollPin.ts 里的自动滚动改成按块
   *  触发" is 47 chars) — a path or domain reference is the mechanical tell
   *  that it did, and the miss direction stays conservative: work that reads
   *  like chat keeps the main thinking tier, not the light one. */
  shortChat: boolean;
  /** The input reads as an engineering-artifact brief (创作动词 × 工程产物名词
   *  同现，排除问法与单资产创意) — the shape that keeps the delivery gate,
   *  the workspace probe and the write-to-disk protocol alive now that no
   *  router classifies builds any more. */
  buildShaped: boolean;
}

/** Below this many characters an input cannot plausibly describe work. */
const SHORT_TURN_CHARS = 128;
/** At or above this many characters an input is treated as a real brief. */
const LONG_FORM_CHARS = 200;

/** 问法（怎么/如何/how do…）在问procedure，不是在要产物——与 assessIntent
 *  的 askingHow 同思路，写死在初始判据里（不是事故后补丁）。 */
const HOW_ASKING_RE = /(?:如何|怎么|怎样|咋(?:办|样)|为什么|求(?:教|助)|请教|请问|能不能|可不可以|什么是|how\s+(?:do|can|should|to|would)|why|what\s+is)/i;
/** 单资产创意（logo/图标/起名…）：直接产资产本身，不吃工程交付管线
 *  （2026-11-06 路由退役判例：「给这个项目起个名字」不是 build）。 */
const SINGLE_ASSET_RE = /(?:logo|图标|头像|封面|插画|横幅|banner|海报|贴纸|壁纸|起(?:个)?名|命名|名字|名称|口号|slogan|配[色图]|表情包)/i;
const BUILD_VERB_RE = /(?:写|做|创[建作]|开发|生成|搭[建载]|制作|实现|给我|build|create|make|generate|develop|implement|scaffold)/i;
const BUILD_ARTIFACT_RE = /(?:项目|应用|网站|网页|游戏|工具|页面|系统|插件|脚本|组件|服务|机器人|大屏|dashboard|原型|app\b|application|website|extension|cli\b|api\b)/i;

export function turnShape(prompt: string): TurnShape {
  const trimmed = prompt.trim();
  const codeShaped = /```/.test(prompt);
  const hasUrl = /https?:\/\//.test(prompt);
  const longForm = trimmed.length >= LONG_FORM_CHARS;
  // 路径/域名形态（src/ui/x.ts、example.com）：短句也能装下真工作，这是
  // 机械可辨的工作信号——命中就不再当寒暄形状。
  const hasPathRef = /\/|\w+\.\w/.test(prompt);
  const shortChat = trimmed.length <= SHORT_TURN_CHARS && !codeShaped && !hasUrl && !hasPathRef;
  const buildShaped = !HOW_ASKING_RE.test(prompt) && !SINGLE_ASSET_RE.test(prompt)
    && BUILD_VERB_RE.test(prompt) && BUILD_ARTIFACT_RE.test(prompt);
  return { codeShaped, longForm, shortChat, buildShaped };
}

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
   *  actually wait (main.ts's durable queue vs. a CLI process). */
  defer: boolean;
  signals: InputDecision['signals'];
}

/**
 * Stage 1 — synchronous, no I/O, no LLM. Everything needed before any await
 * of a turn: whether the input named a time to run at. Nothing else.
 */
export function prefetchTurnRoute(
  text: string,
  images?: MessageImage[] | null,
  now = Date.now(),
): TurnRoutePrefetch {
  const imgs = images ?? [];
  const timing = detectScheduledInput(text, now);
  try { appendTrace({ type: 'turn_route_prefetch', reason: 'shape-only', snippet: text.slice(0, 80) }); } catch {}
  return {
    text,
    images: imgs,
    timing: timing ?? { mode: 'now' },
    defer: timing !== null,
    signals: {
      // 命中的规则名——回放一条日志时，先看它就知道是哪一层做的决定。
      rule: 'TURN_SHAPE',
      ...(timing ? { scheduledAt: timing.at, scheduledText: timing.text } : {}),
    },
  };
}

export interface TurnRouteOptions {
  forcedMode?: TaskMode;
  hasTools: boolean;
  continuingPlan?: boolean;
  planPauseRequested?: boolean;
  /** Whether the active (continuing) plan was approved as a project build.
   *  Only build plans keep the per-phase delivery gate on continuation. */
  continuingProjectBuild?: boolean;
  /** Record into the replayable log (inputDecision.ts). Off for probes: a log
   *  full of probe noise is not evidence. */
  log?: boolean;
}

export interface TurnRouteDecision extends InputDecision {
  source: 'turn-route';
  workflow: CompiledRequestWorkflow;
  stage: RequestWorkflowStage;
  defer: boolean;
}

/** How the pipeline shapes up as an action/scope pair. The action is always
 *  `proceed` — with the router gone the host holds no opinion on whether a
 *  turn is a question (the model answers questions inside the normal turn;
 *  gating the turn on a "direct question" verdict was the retired layer's
 *  last remaining opinion). Scope still records which gates are live so the
 *  replayable log stays diagnosable. */
function classifyTurnWorkflow(workflow: CompiledRequestWorkflow): { action: 'proceed'; scope: InputScope[] } {
  const scope: InputScope[] = [];
  if (workflow.requiresPlanReview) scope.push('plan');
  if (workflow.needsProbe) scope.push('resources');
  if (workflow.needsDeliveryGate) scope.push('output-format');
  if (workflow.analysis.intent.requiresConfirmation) scope.push('constraints');
  if (scope.length === 0) scope.push('none');
  return { action: 'proceed', scope };
}

/**
 * Stage 2 — the one producer. Compiles the workflow from mechanical facts and
 * shape, and assembles the shared decision: action, confidence, timing, scope,
 * and the reasons that led there. Synchronous: there is no LLM call left to
 * await — the turn is never held waiting on a pre-turn verdict.
 */
export function compileTurnRoute(
  prefetch: TurnRoutePrefetch,
  options: TurnRouteOptions,
  now = Date.now(),
): TurnRouteDecision {
  const workflow = compileRequestWorkflow(prefetch.text, {
    forcedMode: options.forcedMode,
    hasTools: options.hasTools,
    continuingPlan: options.continuingPlan,
    planPauseRequested: options.planPauseRequested,
    continuingProjectBuild: options.continuingProjectBuild,
  });

  const { action, scope } = classifyTurnWorkflow(workflow);
  // Full confidence: every gate here is a mechanical fact or a shape read off
  // the user's own text — nothing was guessed.
  const decision: TurnRouteDecision = {
    workflow,
    stage: workflow.stage,
    source: 'turn-route',
    kind: 'turn-shape',
    action,
    confidence: 1,
    timing: prefetch.timing,
    scope,
    // A fresh turn has nothing in flight to tear down: its abort semantics
    // belong to the caller (pause/supersede), never to the route decision.
    shouldAbort: false,
    reason: 'mechanical shape + word-list safety gates; no pre-turn verdict (router retired 2026-11-06)',
    signals: {
      ...prefetch.signals,
      ...turnShape(prefetch.text),
      continuing: options.continuingPlan === true || options.planPauseRequested === true,
      stage: workflow.stage,
      ...(options.continuingProjectBuild ? { continuingProjectBuild: true } : {}),
    },
    defer: prefetch.defer,
  };

  try { appendTrace({ type: 'turn_route_decided', route: decision.kind, reason: decision.reason, snippet: prefetch.text.slice(0, 80) }); } catch {}
  if (options.log !== false) recordInputDecision(decision, now);
  return decision;
}

/**
 * The host's HOLD decision — a second, separate decision about the same input
 * ("when does it run" as opposed to "which pipeline"), in the same shape and
 * the same log. Recorded by the host because that is who knows whether it has
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
