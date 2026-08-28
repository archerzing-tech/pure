import {
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

const RISK_ORDER: Record<IntentAssessment['riskLevel'], number> = { low: 0, medium: 1, high: 2 };
const REVERSIBILITY_ORDER: Record<IntentAssessment['reversibility'], number> = {
  reversible: 0,
  'partially-reversible': 1,
  'hard-to-reverse': 2,
  irreversible: 3,
};

function mergeSemanticAssessment(
  heuristic: IntentAssessment,
  semantic: IntentAssessment,
): IntentAssessment {
  // 语义路由可用时，意图 / 风险 / 可逆性 / 影响 / 建议一律以语义结论为准，关键词启发式
  // 不再“覆盖”它（即不再把语义判定为低风险的请求又用关键词拔高）。关键词只保留两件事：
  // 1) 确定性的虚构检测标记（必须绝不丢失）；
  // 2) 安全开关的“更谨慎”兜底——探针 / 确认在任一方要求时即开启。
  return {
    ...semantic,
    intent: semantic.intent,
    riskLevel: semantic.riskLevel,
    reversibility: semantic.reversibility,
    impact: semantic.impact || heuristic.impact,
    recommendation: semantic.recommendation || heuristic.recommendation,
    requiresProbe: heuristic.requiresProbe || semantic.requiresProbe,
    requiresConfirmation: heuristic.requiresConfirmation || semantic.requiresConfirmation,
    skipPlausibilityReview: heuristic.skipPlausibilityReview === true,
  };
}

export function compileRequestWorkflow(
  prompt: string,
  options: RequestWorkflowOptions = {},
): CompiledRequestWorkflow {
  const planner = options.planner ?? new Planner();
  const detected = planner.analyzeTask(prompt);
  const semantic = options.semanticRoute ?? null;
  const assessment = semantic ? mergeSemanticAssessment(detected.intent, semantic.assessment) : detected.intent;
  // 计划结构跟随语义路由给出的 mode（build / plan / yolo），而不是再用关键词把
  // 用户意图重新归类为某种固定模板。只有当语义层面判定需要计划/构建时才生成计划。
  const semanticMode = options.forcedMode ?? semantic?.mode ?? detected.mode;
  const analysisComplexity = semantic?.complexity ?? detected.complexity;
  const wantsPlan = analysisComplexity === 'complex'
    || assessment.requiresConfirmation
    || semanticMode === 'build'
    || options.forcedMode === 'build'
    || semantic?.needsDeliveryGate === true;
  const analysisPlan = semantic
    ? (wantsPlan ? planner.generatePlan(prompt, semanticMode) : undefined)
    : detected.plan;
  const analysis: AnalysisResult = {
    ...detected,
    complexity: analysisComplexity,
    mode: semanticMode,
    intent: assessment,
    reasoning: semantic ? '本轮先由模型结合完整请求理解目标，再决定是否需要计划、探针或直接回答。' : detected.reasoning,
    plan: analysisPlan,
  };
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
