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

  // 语义路由可用 → 它是理解用户意图的唯一来源，不调用任何关键词分类逻辑。
  // 语义路由不可用（null）→ 才退回关键词启发式（planner.analyzeTask），这是最后的兜底。
  const analysis: AnalysisResult = semantic
    ? buildSemanticAnalysis(planner, prompt, semantic, options)
    : planner.analyzeTask(prompt);
  // forcedMode 是外部显式覆盖，无论走语义路径还是关键词兜底都要生效。
  if (options.forcedMode) analysis.mode = options.forcedMode;
  const assessment = analysis.intent;
  const needsDeliveryGate = options.forcedMode === 'build'
    || analysis.mode === 'build'
    || semantic?.needsDeliveryGate === true
    || options.continuingProjectBuild === true;
  // Design-first applies to project builds that look like UI work. A
  // continuing build keeps its original routing decision (the marker only
  // matters for the FIRST implementation turn).
  const needsDesignPhase = needsDeliveryGate && !options.continuingPlan
    && detectUiDesignRequest(prompt);
  const probeRequired = assessment.requiresProbe
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
    userContext,
  };
}
