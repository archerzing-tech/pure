// src/ui/planSummary.ts
// 执行方案卡（Execution plan summary）。
// 语义路由（inferSemanticRoute）在每轮发送前会产出一份决策：意图、复杂度、
// 执行策略（yolo/plan/build）、风险等级、以及计划协作的子 agent 名单。此前
// 这些决策只用于引擎内部（prompt 注入、记忆检索），用户完全看不到"我为什么
// 决定这样拆、打算动用哪些角色"。这张卡把决策依据在 LLM 分析完成后、执行
// 开始前呈现出来 —— 与评估卡（assessmentFlow）同一套玻璃卡片视觉语言，
// 默认展开，可折叠。

import type { SemanticRouteDecision } from '../coding-agent/types';
import { INTENT_LABELS, RISK_LABELS } from './assessmentFlow';

/** 子 agent 角色短名 → 一句话说明（与 SubagentOrchestrator 的角色定义对应）。 */
export const SUBAGENT_ROLE_LABELS: Record<string, string> = {
  researcher: '研究调研',
  deep_thinker: '深度推理',
  task_planner: '任务规划',
  code_editor: '代码编辑',
  code_reviewer: '代码审查',
  project_auditor: '项目审计',
  ui_designer: '界面设计',
  bash_executor: '命令执行',
};

export interface PlanSummaryOptions {
  /** True when subagent tools are actually available this turn (workspace mode). */
  hasSubagents: boolean;
}

export interface PlanSummaryCardHandle {
  el: HTMLElement;
}

const COMPLEXITY_LABELS: Record<'simple' | 'complex', string> = {
  simple: '简单',
  complex: '复杂',
};

const MODE_LABELS: Record<'yolo' | 'plan' | 'build', string> = {
  yolo: '直接执行',
  plan: '计划推进',
  build: '构建交付',
};

/**
 * Whether a semantic-route decision carries enough substance to warrant a card:
 * a plain low-risk question with no planned collaborators would be card noise.
 */
export function shouldShowPlanSummary(
  decision: SemanticRouteDecision | null,
  options: PlanSummaryOptions,
): boolean {
  if (!decision) return false;
  const subagents = options.hasSubagents ? (decision.subagents ?? []) : [];
  return subagents.length > 0
    || decision.complexity === 'complex'
    || decision.mode !== 'yolo'
    || decision.requiresPlan === true
    || decision.assessment.riskLevel !== 'low';
}

export function createPlanSummaryCard(
  decision: SemanticRouteDecision,
  options: PlanSummaryOptions,
): PlanSummaryCardHandle {
  const subagents = options.hasSubagents ? (decision.subagents ?? []) : [];
  const risk = decision.assessment.riskLevel;
  const recommendation = decision.assessment.recommendation;

  const el = document.createElement('div');
  el.className = 'bubble-row plan-summary-row';

  const card = document.createElement('details');
  card.className = `plan-summary-card risk-${risk}`;
  card.setAttribute('aria-label', '本次执行方案');
  card.open = true;

  const summary = document.createElement('summary');
  summary.className = 'plan-summary-head';
  const marker = document.createElement('span');
  marker.className = 'plan-summary-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.textContent = '▶';
  const title = document.createElement('span');
  title.className = 'plan-summary-title';
  title.textContent = '本次执行方案';
  const mode = document.createElement('span');
  mode.className = 'plan-summary-mode';
  mode.textContent = MODE_LABELS[decision.mode];
  const summaryStatus = document.createElement('span');
  summaryStatus.className = 'plan-summary-status';
  summaryStatus.setAttribute('aria-live', 'polite');
  summaryStatus.textContent = subagents.length > 0
    ? `计划协作 ${subagents.length} 个角色`
    : decision.complexity === 'complex'
      ? '按步骤推进，逐步验证'
      : '判断完成，开始执行';
  const chevron = document.createElement('span');
  chevron.className = 'plan-summary-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '⌄';
  summary.append(marker, title, mode, summaryStatus, chevron);

  const body = document.createElement('div');
  body.className = 'plan-summary-body';

  const row1 = document.createElement('div');
  row1.className = 'plan-summary-line';
  const intent = document.createElement('span');
  intent.className = 'plan-summary-intent';
  intent.textContent = `我判断这是一次${INTENT_LABELS[decision.intent] ?? decision.intent}请求`;
  const complexity = document.createElement('span');
  complexity.className = 'plan-summary-complexity';
  complexity.textContent = `复杂度：${COMPLEXITY_LABELS[decision.complexity] ?? decision.complexity}`;
  const riskEl = document.createElement('span');
  riskEl.className = `plan-summary-risk risk-${risk}`;
  riskEl.textContent = RISK_LABELS[risk];
  row1.append(intent, complexity, riskEl);
  body.appendChild(row1);

  if (recommendation) {
    const note = document.createElement('p');
    note.className = 'plan-summary-note';
    note.textContent = recommendation;
    body.appendChild(note);
  }

  if (subagents.length > 0) {
    const collab = document.createElement('div');
    collab.className = 'plan-summary-collab';
    const collabTitle = document.createElement('span');
    collabTitle.className = 'plan-summary-collab-title';
    collabTitle.textContent = `为了把这件事做好，我会找 ${subagents.length} 个角色协作：`;
    collab.appendChild(collabTitle);
    const roles = document.createElement('span');
    roles.className = 'plan-summary-roles';
    for (const name of subagents) {
      const chip = document.createElement('span');
      chip.className = 'plan-summary-role';
      chip.textContent = SUBAGENT_ROLE_LABELS[name] ?? name;
      roles.appendChild(chip);
    }
    collab.appendChild(roles);
    body.appendChild(collab);
  }

  card.append(summary, body);
  el.appendChild(card);
  return { el };
}