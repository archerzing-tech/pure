// src/cliIntent.ts
// Pure CLI-side helpers for proactive intent assessment. Kept separate from
// cli.ts so tests can cover the request policy without starting the CLI entrypoint.

import type { IntentAssessment } from './coding-agent/types';
import { formatIntentPrompt } from './coding-agent/Planner';
import { promptAssembler, type PromptBudgetConfig } from './shared/PromptAssembler';
import type { UserTurnContext } from './shared/promptLayers';
import { cyan, dim, red, yellow } from './termcolors';

/** Resolve the CLI permission stance from the opt-out flag and request risk. */
export function resolveCliAutoApprove(
  promptOnTool: boolean,
  defaultAutoApprove = true,
  assessment?: Pick<IntentAssessment, 'requiresConfirmation'>,
): boolean {
  return defaultAutoApprove && !promptOnTool && !assessment?.requiresConfirmation;
}

/** Whether the CLI has enough tooling to perform the requested read-only probe. */
export function shouldProbeCliWorkspace(hasTools: boolean, assessment: IntentAssessment): boolean {
  return hasTools && assessment.requiresProbe;
}

/** Render the risk summary printed before a CLI turn. */
export function formatCliIntentAssessment(assessment: IntentAssessment): string {
  if (assessment.riskLevel === 'low') return '';
  const label = assessment.riskLevel === 'high' ? red('high risk') : yellow('medium risk');
  return `  ${cyan('🧭')} ${label} ${dim(`· ${assessment.reversibility}`)}\n`
    + `     ${dim(assessment.impact)}\n`
    + `     ${yellow('↳')} ${dim(assessment.recommendation)}\n`;
}

/** Compose the request-scoped assessment into the L2 user message. */
export function composeCliIntentUserTurn(
  prompt: string,
  assessment: IntentAssessment,
  context: Omit<UserTurnContext, 'assessment'> = {},
  budget?: PromptBudgetConfig,
): string {
  return promptAssembler.buildUserPrompt(prompt, { ...context, assessment: formatIntentPrompt(assessment) }, budget);
}
