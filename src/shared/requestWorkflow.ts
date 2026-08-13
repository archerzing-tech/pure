import {
  detectArtifactRequest,
  detectProjectRequest,
  formatArtifactPrompt,
  formatIntentPrompt,
  formatTrapPrompt,
  Planner,
} from '../coding-agent/Planner';
import type { AnalysisResult, TaskMode } from '../coding-agent/types';
import { INCREMENTAL_BUILD_PROMPT } from './agentBehavior';
import type { UserTurnContext } from './promptLayers';

export type RequestWorkflowStage = 'direct' | 'probe' | 'plan' | 'confirm';

export interface RequestWorkflowOptions {
  forcedMode?: TaskMode;
  hasTools?: boolean;
  continuingPlan?: boolean;
  planPauseRequested?: boolean;
  planner?: Planner;
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

export function compileRequestWorkflow(
  prompt: string,
  options: RequestWorkflowOptions = {},
): CompiledRequestWorkflow {
  const planner = options.planner ?? new Planner();
  const detected = planner.analyzeTask(prompt);
  const analysis = options.forcedMode
    ? { ...detected, mode: options.forcedMode }
    : detected;
  const needsDeliveryGate = detectProjectRequest(prompt) || analysis.mode === 'build';
  const probeRequired = analysis.intent.requiresProbe
    || analysis.complexity === 'complex'
    || needsDeliveryGate;
  const probeAvailable = options.hasTools !== false;
  const needsProbe = probeRequired && probeAvailable;
  const requiresPlanReview = Boolean(
    options.continuingPlan
    || options.planPauseRequested
    || needsDeliveryGate
    || analysis.intent.requiresConfirmation
    || options.forcedMode === 'plan'
    || options.forcedMode === 'build'
    || (analysis.complexity === 'complex' && analysis.plan),
  );
  const buildRequested = detectArtifactRequest(prompt)
    || needsDeliveryGate
    || Boolean(options.continuingPlan || options.planPauseRequested);
  const userContext: UserTurnContext = {
    traps: analysis.traps.length > 0 ? formatTrapPrompt(analysis.traps) : undefined,
    assessment: analysis.intent.riskLevel !== 'low' || analysis.intent.intent !== 'question'
      ? formatIntentPrompt(analysis.intent)
      : undefined,
    buildProtocol: buildRequested ? formatArtifactPrompt() + INCREMENTAL_BUILD_PROMPT : undefined,
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
