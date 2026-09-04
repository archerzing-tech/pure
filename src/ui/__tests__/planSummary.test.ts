// Tests for the execution-plan summary card (语义路由决策的用户可见呈现).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  createPlanSummaryCard,
  shouldShowPlanSummary,
  SUBAGENT_ROLE_LABELS,
} from '../planSummary';
import type { SemanticRouteDecision } from '../../coding-agent/types';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function decision(overrides: Partial<SemanticRouteDecision> = {}): SemanticRouteDecision {
  return {
    intent: 'build',
    complexity: 'complex',
    mode: 'build',
    requiresPlan: true,
    needsDeliveryGate: true,
    subagents: ['researcher', 'code_editor'],
    assessment: {
      intent: 'build',
      riskLevel: 'low',
      reversibility: 'reversible',
      impact: '新建一个可运行的多文件项目',
      recommendation: '按构建流程推进，先搭骨架再实现。',
      requiresProbe: false,
      requiresConfirmation: false,
    },
    ...overrides,
  };
}

describe('shouldShowPlanSummary', () => {
  it('shows for a build with planned collaborators', () => {
    expect(shouldShowPlanSummary(decision(), { hasSubagents: true })).toBe(true);
  });

  it('hides every simple low-risk question even when a role was selected', () => {
    expect(shouldShowPlanSummary(decision({
      intent: 'question',
      complexity: 'simple',
      mode: 'yolo',
      requiresPlan: false,
      needsDeliveryGate: false,
      subagents: ['researcher'],
      assessment: { intent: 'question', riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '', requiresProbe: false, requiresConfirmation: false },
    }), { hasSubagents: true })).toBe(false);
  });

  it('hides when null (no semantic route was produced)', () => {
    expect(shouldShowPlanSummary(null, { hasSubagents: true })).toBe(false);
  });

  it('drops the collaborator list when subagent tools are unavailable', () => {
    // Workspace-less plain chat: no subagent tools, so the roster must not
    // force the card out.
    expect(shouldShowPlanSummary(decision({
      subagents: ['researcher'],
      complexity: 'simple',
      mode: 'yolo',
      requiresPlan: false,
    }), { hasSubagents: false })).toBe(false);
    // …but a complex build still shows even without subagents.
    expect(shouldShowPlanSummary(decision({ subagents: [] }), { hasSubagents: false })).toBe(true);
  });
});

describe('createPlanSummaryCard', () => {
  it('renders one humanized sentence with the selected roles', () => {
    const { el } = createPlanSummaryCard(decision(), { hasSubagents: true });
    const text = el.textContent ?? '';
    expect(text).toContain(`这个问题不简单，我让${SUBAGENT_ROLE_LABELS.researcher}和${SUBAGENT_ROLE_LABELS.code_editor}分头处理，最后我来汇总结果给你。`);
    expect(text).not.toContain('本次执行方案');
    expect(text).not.toContain('计划协作');
    expect(text).not.toContain('复杂度：');
  });

  it('uses a concise fallback sentence when no roles are available', () => {
    const { el } = createPlanSummaryCard(decision(), { hasSubagents: false });
    const text = el.textContent ?? '';
    expect(text).toContain('这个问题不简单，我会分步推进，每一步验证后再往下走。');
    expect(text).not.toContain('角色协作');
    expect(text).not.toContain('本次执行方案');
  });

  it('uses cautious humanized wording for medium-risk work', () => {
    const { el } = createPlanSummaryCard(decision({
      complexity: 'simple',
      mode: 'yolo',
      subagents: ['code_reviewer'],
      assessment: { ...decision().assessment, riskLevel: 'medium' },
    }), { hasSubagents: true });
    expect(el.textContent).toContain(`这事得谨慎点，我会先让${SUBAGENT_ROLE_LABELS.code_reviewer}确认影响面，再动手处理。`);
  });
});