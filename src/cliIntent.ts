// src/cliIntent.ts
// Pure CLI-side helpers for proactive intent assessment. Kept separate from
// cli.ts so tests can cover the request policy without starting the CLI entrypoint.

import type { IntentAssessment } from './coding-agent/types';
import { formatIntentPrompt } from './coding-agent/Planner';
import { promptAssembler, type PromptBudgetConfig } from './shared/PromptAssembler';
import type { UserTurnContext } from './shared/promptLayers';
import { cyan, dim, red, yellow } from './termcolors';

/** Resolve the CLI permission stance from the opt-out flag alone.
 *
 *  请求风险**不再**翻转立场（2026-10-10 修复「做着做着突然没权限」）：此前
 *  某一轮被 Planner 判 `requiresConfirmation` 就把整轮 autoApprove 关掉，
 *  该轮全部 write/edit/execute 落进确认门——非 TTY 直接硬拒，用户看到的是
 *  「没有任何改动却突然没权限」，下一轮评估回落又自己恢复。现在高风险轮
 *  照常自动放行：风险提示行照打（formatCliIntentAssessment），只有
 *  dangerLevel==='danger' 的**操作本身**才落到交互门（见
 *  createCliPermissionHandler）。护栏从「模型一句话」换成了「操作分级」。 */
export function resolveCliAutoApprove(
  promptOnTool: boolean,
  defaultAutoApprove = true,
): boolean {
  return defaultAutoApprove && !promptOnTool;
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
