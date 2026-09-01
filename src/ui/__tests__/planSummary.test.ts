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

  it('hides a plain low-risk question with no collaborators', () => {
    expect(shouldShowPlanSummary(decision({
      intent: 'question',
      complexity: 'simple',
      mode: 'yolo',
      requiresPlan: false,
      needsDeliveryGate: false,
      subagents: [],
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
  it('renders intent, complexity, risk and the collaborator roster', () => {
    const { el } = createPlanSummaryCard(decision(), { hasSubagents: true });
    const text = el.textContent ?? '';
    expect(text).toContain('本次执行方案');
    expect(text).toContain('我判断这是一次项目构建请求');
    expect(text).toContain('复杂度：复杂');
    expect(text).toContain('低风险');
    expect(text).toContain('按构建流程推进');
    expect(text).toContain(SUBAGENT_ROLE_LABELS.researcher);
    expect(text).toContain(SUBAGENT_ROLE_LABELS.code_editor);
    expect(text).toContain('2 个角色');
  });

  it('omits the collaborator section when hasSubagents is false', () => {
    const { el } = createPlanSummaryCard(decision(), { hasSubagents: false });
    const text = el.textContent ?? '';
    expect(text).not.toContain('角色协作');
    expect(text).not.toContain(SUBAGENT_ROLE_LABELS.researcher);
  });

  it('renders the recommendation note when present', () => {
    const { el } = createPlanSummaryCard(decision(), { hasSubagents: false });
    expect((el.querySelector('.plan-summary-note')?.textContent ?? '')).toContain('按构建流程推进');
  });
});