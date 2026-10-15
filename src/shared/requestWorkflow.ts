import {
  detectFictionIntent,
  formatArtifactPrompt,
  formatIntentPrompt,
  formatTrapPrompt,
  Planner,
} from '../coding-agent/Planner';
import type { AnalysisResult, IntentAssessment, SemanticRouteDecision, TaskMode } from '../coding-agent/types';
import { detectUiDesignRequest } from './delivery';
import { INCREMENTAL_BUILD_PROMPT } from './agentBehavior';
import { SKIP_PLAUSIBILITY_REVIEW_PROMPT, type UserTurnContext } from './promptLayers';

export type RequestWorkflowStage = 'direct' | 'probe' | 'plan' | 'confirm';

export interface RequestWorkflowOptions {
  forcedMode?: TaskMode;
  hasTools?: boolean;
  continuingPlan?: boolean;
  planPauseRequested?: boolean;
  /** Whether the active (continuing) plan was approved as a project build.
   * Only build plans keep the per-phase delivery gate on continuation — an
   * ordinary complex plan must not be forced through it just because the
   * conversation is continuing. */
  continuingProjectBuild?: boolean;
  planner?: Planner;
  /** Semantic decision from the shared model router. When absent, the planner
   * supplies only a conservative fallback and does not infer ordinary intent
   * from artifact nouns. */
  semanticRoute?: SemanticRouteDecision | null;
  /** The turn reached the router because the deterministic floor could NOT
   * settle it (work-shaped input: an edit, a malfunction report, a plan ask),
   * and the router produced no verdict (timeout / unusable JSON).
   *
   * The floor's read of such a turn is a DEFAULT, not a verdict — `assessIntent`
   * answers `question` for everything it does not recognise — so falling back to
   * it here would answer a different question than the one asked: the turn gets
   * carried as an "answer" with no assessment, no probe, no plan review and no
   * delivery gate, i.e. the harness abstains precisely where the request asks
   * for work. Set this instead: the turn is carried as work, and the one move
   * that is right under EVERY work reading is the cheap read-only probe
   * ("look before you leap"). It does not invent a plan, a mode, or a risk
   * level — only refuses to claim the cheap reading it already rejected. */
  workShapedFallback?: boolean;
}

export interface CompiledRequestWorkflow {
  analysis: AnalysisResult;
  stage: RequestWorkflowStage;
  needsDeliveryGate: boolean;
  /** UI-building requests go through a design-first phase: the agent produces
   * a static design mockup and waits for user confirmation before writing any
   * implementation code. */
  needsDesignPhase: boolean;
  probeRequired: boolean;
  probeAvailable: boolean;
  needsProbe: boolean;
  requiresPlanReview: boolean;
  /** The router was asked because the floor could not settle this turn and
   *  returned nothing — the turn is carried as work on the conservative
   *  reading (see RequestWorkflowOptions.workShapedFallback). Exposed so the
   *  action classifier cannot report it to the user as an "answer" turn. */
  workShapedFallback: boolean;
  userContext: UserTurnContext;
}

/**
 * 语义路由可用时，构造分析结果直接以语义结论为准。这里不运行任何关键词启发式去“归类”
 * 用户意思——关键词逻辑只在语义路由不可用时（见下方 else 分支）作为最后的兜底。
 * 仍保留两类确定性的安全扫描（逻辑陷阱、虚构检测），它们不是意图分类，只是永不丢失
 * 的安全网。
 */
function buildSemanticAnalysis(
  planner: Planner,
  prompt: string,
  semantic: SemanticRouteDecision,
  options: RequestWorkflowOptions,
): AnalysisResult {
  const semanticMode = options.forcedMode ?? semantic.mode ?? 'yolo';
  const wantsPlan = semantic.complexity === 'complex'
    || semantic.assessment.requiresConfirmation
    || semanticMode === 'build'
    || options.forcedMode === 'build'
    || semantic.needsDeliveryGate === true;
  return {
    complexity: semantic.complexity,
    mode: semanticMode,
    plan: wantsPlan ? planner.generatePlan(prompt, semanticMode) : undefined,
    reasoning: '本轮由语义路由结合完整请求与上下文理解目标，决定是否需要计划、探针或直接回答；关键词启发式仅作为语义路由不可用时的兜底。',
    traps: planner.detectTraps(prompt),
    intent: {
      ...semantic.assessment,
      // 确定性虚构检测：必须绝不丢失，因此即便语义路由存在也由这里兜底写入。
      skipPlausibilityReview: detectFictionIntent(prompt),
    },
  };
}

export function compileRequestWorkflow(
  prompt: string,
  options: RequestWorkflowOptions = {},
): CompiledRequestWorkflow {
  const planner = options.planner ?? new Planner();
  const semantic = options.semanticRoute ?? null;
  const workShapedFallback = !semantic && options.workShapedFallback === true;

  // 语义路由可用 → 它是理解用户意图的唯一来源，不调用任何关键词分类逻辑。
  // 语义路由不可用（null）→ 才退回关键词启发式（planner.analyzeTask），这是最后的兜底。
  const analysis: AnalysisResult = semantic
    ? buildSemanticAnalysis(planner, prompt, semantic, options)
    : planner.analyzeTask(prompt);
  // forcedMode 是外部显式覆盖，无论走语义路径还是关键词兜底都要生效。
  if (options.forcedMode) analysis.mode = options.forcedMode;
  const assessment = analysis.intent;
  const isPureQuestion = semantic?.intent === 'question' && !options.forcedMode;
  const needsDeliveryGate = !isPureQuestion && (
    options.forcedMode === 'build'
    || analysis.mode === 'build'
    || semantic?.needsDeliveryGate === true
    || options.continuingProjectBuild === true
  );
  // Design-first applies to project builds that look like UI work. A
  // continuing build keeps its original routing decision (the marker only
  // matters for the FIRST implementation turn).
  const needsDesignPhase = needsDeliveryGate && !options.continuingPlan
    && detectUiDesignRequest(prompt);
  const probeRequired = workShapedFallback
    || assessment.requiresProbe
    || semantic?.requiresPlan === true
    || needsDeliveryGate;
  const probeAvailable = options.hasTools !== false;
  const needsProbe = probeRequired && probeAvailable;
  const requiresPlanReview = Boolean(
    options.continuingPlan
    || options.planPauseRequested
    || assessment.requiresConfirmation
    || options.forcedMode === 'plan'
    || options.forcedMode === 'build'
    || semantic?.requiresPlan
    // 路由器自身矛盾的优先级（2026-10-14 定死一处）：它可以一边给 mode=plan
    // 一边留 requiresPlan=false——实测「我想给这个项目加一个离线缓存层，先给我
    // 一个方案」正是如此，于是这一轮直接走成回答，一个计划都没有。规则：
    // complex + plan 模式 ⇒ 要计划；simple + plan 模式不罢（小改动上 mode=plan
    // 很常见，强制出卡就是本仓库一直在拒的过度规划）。不一致本身进 signals
    // 记录（routerPlanFlagInconsistent），不静默选边。
    || (semantic?.mode === 'plan' && semantic.complexity === 'complex')
    || (!semantic && analysis.complexity === 'complex' && analysis.plan),
  );
  const buildRequested = analysis.mode === 'build'
    || semantic?.intent === 'build'
    || semantic?.needsDeliveryGate === true
    || options.forcedMode === 'build'
    || Boolean(options.continuingPlan || options.planPauseRequested);
  const userContext: UserTurnContext = {
    traps: analysis.traps.length > 0 ? formatTrapPrompt(analysis.traps) : undefined,
    assessment: analysis.intent.riskLevel !== 'low' || analysis.intent.intent !== 'question'
      ? formatIntentPrompt(analysis.intent)
      : undefined,
    buildProtocol: buildRequested ? formatArtifactPrompt() + INCREMENTAL_BUILD_PROMPT : undefined,
    plausibilityOverride: analysis.intent.skipPlausibilityReview
      ? SKIP_PLAUSIBILITY_REVIEW_PROMPT
      : undefined,
  };
  const stage: RequestWorkflowStage = analysis.intent.requiresConfirmation
    ? 'confirm'
    : requiresPlanReview
      ? 'plan'
      : needsProbe
        ? 'probe'
        : 'direct';
  return {
    analysis,
    stage,
    needsDeliveryGate,
    needsDesignPhase,
    probeRequired,
    probeAvailable,
    needsProbe,
    requiresPlanReview,
    workShapedFallback,
    userContext,
  };
}
