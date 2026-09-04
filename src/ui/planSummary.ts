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
      ? `这个问题不简单，我让${roleSentence(roles)}分头处理，最后我来汇总结果给你。`
      : '这个问题不简单，我会分步推进，每一步验证后再往下走。'
    : hasCaution
      ? roles.length > 0
        ? `这事得谨慎点，我会先让${roleSentence(roles)}确认影响面，再动手处理。`
        : '这事得谨慎点，我先确认影响范围，再决定怎么动。'
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
