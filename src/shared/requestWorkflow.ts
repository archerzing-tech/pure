import {
  formatArtifactPrompt,
  formatIntentPrompt,
  formatTrapPrompt,
  Planner,
} from '../coding-agent/Planner';
import type { AnalysisResult, IntentAssessment, SemanticRouteDecision, TaskMode } from '../coding-agent/types';
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
  const riskLevel = RISK_ORDER[semantic.riskLevel] >= RISK_ORDER[heuristic.riskLevel]
    ? semantic.riskLevel
    : heuristic.riskLevel;
  const reversibility = REVERSIBILITY_ORDER[semantic.reversibility] >= REVERSIBILITY_ORDER[heuristic.reversibility]
    ? semantic.reversibility
    : heuristic.reversibility;
  return {
    ...semantic,
    intent: semantic.intent,
    riskLevel,
    reversibility,
    requiresProbe: heuristic.requiresProbe || semantic.requiresProbe || riskLevel !== 'low',
    requiresConfirmation: heuristic.requiresConfirmation || semantic.requiresConfirmation || riskLevel === 'high',
    impact: semantic.impact || heuristic.impact,
    recommendation: semantic.recommendation || heuristic.recommendation,
    // Fiction detection is deterministic (Planner heuristic) and must never be
    // lost to a semantic route that does not produce the field.
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
  const analysis: AnalysisResult = {
    ...detected,
    complexity: semantic?.complexity ?? detected.complexity,
    mode: options.forcedMode ?? semantic?.mode ?? detected.mode,
    intent: assessment,
    reasoning: semantic ? '本轮先由模型结合完整请求理解目标，再决定是否需要计划、探针或直接回答。' : detected.reasoning,
    plan: detected.plan,
  };
  const needsDeliveryGate = options.forcedMode === 'build'
    || analysis.mode === 'build'
    || semantic?.needsDeliveryGate === true
    || options.continuingProjectBuild === true;
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
    probeRequired,
    probeAvailable,
    needsProbe,
    requiresPlanReview,
    userContext,
  };
}
