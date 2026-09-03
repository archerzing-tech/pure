// src/ui/planSummary.ts

import type { SemanticRouteDecision } from '../coding-agent/types';

/** Natural-language labels for the roles selected by the semantic router. */
export const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  researcher: '研究员',
  deep_thinker: '深度思考专家',
  task_planner: '任务规划师',
  code_editor: '代码编辑员',
  code_reviewer: '代码审查员',
  project_auditor: '项目审计员',
  ui_designer: 'UI 设计师',
  bash_executor: '执行专家',
};

export interface PlanSummaryOptions {
  /** True when subagent tools are actually available this turn. */
  hasSubagents: boolean;
}

export interface PlanSummaryCardHandle {
  el: HTMLElement;
}

/** Show a collaboration note only when the request is complex or needs care. */
export function shouldShowPlanSummary(
  decision: SemanticRouteDecision | null,
  _options: PlanSummaryOptions,
): boolean {
  if (!decision) return false;
  return decision.complexity === 'complex' || decision.assessment.riskLevel !== 'low';
}

function roleSentence(roles: string[]): string {
  const labels = roles.map((name) => SUBAGENT_ROLE_LABELS[name] ?? name);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}和${labels[1]}`;
  return `${labels.slice(0, -1).join('、')}和${labels.at(-1)}`;
}

export function createPlanSummaryCard(
  decision: SemanticRouteDecision,
  options: PlanSummaryOptions,
): PlanSummaryCardHandle {
  const roles = options.hasSubagents ? (decision.subagents ?? []) : [];
  const isComplex = decision.complexity === 'complex';
  const hasCaution = decision.assessment.riskLevel !== 'low';
  const message = isComplex
    ? roles.length > 0
      ? `你说的这个问题相对复杂，我将安排${roleSentence(roles)}来处理你的问题。`
      : '你说的这个问题相对复杂，我会按步骤推进并逐步验证。'
    : hasCaution
      ? roles.length > 0
        ? `你说的这个问题需要谨慎处理，我将安排${roleSentence(roles)}来一起确认影响并处理。`
        : '你说的这个问题需要谨慎处理，我会先确认影响范围，再给你结果。'
      : '';

  const el = document.createElement('div');
  el.className = 'bubble-row plan-summary-row';
  const note = document.createElement('div');
  note.className = `plan-summary-card risk-${decision.assessment.riskLevel}`;
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.textContent = message;
  el.appendChild(note);
  return { el };
}
