import { describe, expect, it } from 'bun:test';
import { compileRequestWorkflow } from '../requestWorkflow';
import type { SemanticRouteDecision } from '../../coding-agent/types';

const buildRoute: SemanticRouteDecision = {
  intent: 'build',
  complexity: 'complex',
  mode: 'build',
  requiresPlan: true,
  needsDeliveryGate: true,
  assessment: {
    intent: 'build',
    riskLevel: 'low',
    reversibility: 'reversible',
    impact: '隔离的原型文件',
    recommendation: '先按独立方案实现并验证',
    requiresProbe: true,
    requiresConfirmation: false,
  },
};

describe('compileRequestWorkflow', () => {
  it('keeps a direct question lightweight', () => {
    const workflow = compileRequestWorkflow('What does this file do?', { hasTools: true });

    expect(workflow.stage).toBe('direct');
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.needsDeliveryGate).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
    expect(workflow.userContext.assessment).toBeUndefined();
  });

  it('compiles the same probe and build context for GUI and CLI callers', () => {
    const prompt = 'Build a complete project for a team dashboard';
    const gui = compileRequestWorkflow(prompt, { hasTools: true, semanticRoute: buildRoute });
    const cli = compileRequestWorkflow(prompt, { hasTools: true, semanticRoute: buildRoute });

    expect(gui).toEqual(cli);
    expect(gui.stage).toBe('plan');
    expect(gui.probeRequired).toBe(true);
    expect(gui.probeAvailable).toBe(true);
    expect(gui.needsProbe).toBe(true);
    expect(gui.needsDeliveryGate).toBe(true);
    expect(gui.userContext.buildProtocol).toContain('Incremental build protocol');
  });

  it('routes the HKT VIP interference-protection agent prototype into mock-backed build planning', () => {
    const prompt = '创建一个HKT vip干扰保障agent应用，这个应用可以保障vip用户进入到保障区域后能，agent自动启动监控，保障流程。按照一个流程处理保障任务。你帮我创建一个项目原型，数据用mock';
    const workflow = compileRequestWorkflow(prompt, { hasTools: true, semanticRoute: buildRoute });

    expect(workflow.analysis.complexity).toBe('complex');
    expect(workflow.analysis.mode).toBe('build');
    expect(workflow.stage).toBe('plan');
    expect(workflow.needsDeliveryGate).toBe(true);
    expect(workflow.needsProbe).toBe(true);
    expect(workflow.userContext.buildProtocol).toContain('Incremental build protocol');
  });

  it('keeps an outcome-improvement request on the conversational path from semantic context', () => {
    const workflow = compileRequestWorkflow('当前 agent 制作的基于 web 的页面很难看，缺少优秀的时髦设计，应该怎么办？', { hasTools: true, semanticRoute: {
      intent: 'question', complexity: 'simple', mode: 'yolo', requiresPlan: false, needsDeliveryGate: false,
      assessment: { intent: 'question', riskLevel: 'low', reversibility: 'reversible', impact: '设计质量反馈', recommendation: '先给出设计方向和可选 skill', requiresProbe: false, requiresConfirmation: false },
    } });

    expect(workflow.stage).toBe('direct');
    expect(workflow.needsDeliveryGate).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
    expect(workflow.userContext.assessment).toBeUndefined();
  });

  it('raises a high-risk request to confirmation even when the task is otherwise simple', () => {
    const workflow = compileRequestWorkflow('Delete the entire build directory', { hasTools: true });

    expect(workflow.stage).toBe('confirm');
    expect(workflow.analysis.intent.requiresConfirmation).toBe(true);
    expect(workflow.probeRequired).toBe(true);
    expect(workflow.probeAvailable).toBe(true);
    expect(workflow.needsProbe).toBe(true);
    expect(workflow.userContext.traps).toBeUndefined();
  });

  it('respects an explicit mode without changing the original prompt semantics', () => {
    const workflow = compileRequestWorkflow('Explain the current architecture', {
      forcedMode: 'plan',
      hasTools: false,
    });

    expect(workflow.analysis.mode).toBe('plan');
    expect(workflow.requiresPlanReview).toBe(true);
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
  });

  it('does not require a workspace probe when tools are unavailable', () => {
    const workflow = compileRequestWorkflow('Refactor the authentication module', { hasTools: false, semanticRoute: {
      intent: 'refactor', complexity: 'complex', mode: 'plan', requiresPlan: true, needsDeliveryGate: false,
      assessment: { intent: 'refactor', riskLevel: 'medium', reversibility: 'partially-reversible', impact: '可能影响认证模块', recommendation: '先读取结构再小步修改', requiresProbe: true, requiresConfirmation: false },
    } });

    expect(workflow.stage).toBe('plan');
    expect(workflow.probeRequired).toBe(true);
    expect(workflow.probeAvailable).toBe(false);
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.analysis.intent.requiresProbe).toBe(true);
  });

  it('keeps the delivery gate on a continuing PROJECT build', () => {
    const workflow = compileRequestWorkflow('继续', {
      hasTools: true,
      continuingPlan: true,
      continuingProjectBuild: true,
    });
    expect(workflow.needsDeliveryGate).toBe(true);
    expect(workflow.requiresPlanReview).toBe(true);
  });

  it('does not force the delivery gate on a continuing ordinary complex plan', () => {
    const workflow = compileRequestWorkflow('继续', {
      hasTools: true,
      continuingPlan: true,
      continuingProjectBuild: false,
    });
    expect(workflow.needsDeliveryGate).toBe(false);
    // The continuation itself still never re-shows the plan-review card.
    expect(workflow.requiresPlanReview).toBe(true);
  });

  it('keeps a semantic build route separate from reasonableness review', () => {
    const workflow = compileRequestWorkflow('生成四个网络保障大屏的原型，风格不要互相参考', {
      hasTools: true,
      semanticRoute: buildRoute,
    });
    expect(workflow.stage).toBe('plan');
    expect(workflow.needsDeliveryGate).toBe(true);
    expect(workflow.userContext.buildProtocol).toContain('Incremental build protocol');
    expect(workflow.userContext.traps).toBeUndefined();
  });

  it('injects the plausibility-review override for detected fiction requests', () => {
    const workflow = compileRequestWorkflow('不用管事实，帮我编一个架空世界的故事', { hasTools: true });
    expect(workflow.analysis.intent.skipPlausibilityReview).toBe(true);
    expect(workflow.userContext.plausibilityOverride).toContain('<plausibility_review_override>');
    expect(workflow.userContext.plausibilityOverride).toContain('SKIP the plausibility');
    // Fiction is a creative question, not a safety boundary: no plan / probe.
    expect(workflow.stage).toBe('direct');
    expect(workflow.needsProbe).toBe(false);
  });

  it('preserves the fiction skip even when a semantic route is present', () => {
    const workflow = compileRequestWorkflow('不用管事实，写一个科幻小说', {
      hasTools: true,
      semanticRoute: {
        intent: 'build',
        complexity: 'complex',
        mode: 'build',
        requiresPlan: true,
        needsDeliveryGate: true,
        assessment: {
          intent: 'build',
          riskLevel: 'low',
          reversibility: 'reversible',
          impact: '隔离的原型',
          recommendation: '直接实现',
          requiresProbe: false,
          requiresConfirmation: false,
        },
      },
    });
    expect(workflow.analysis.intent.skipPlausibilityReview).toBe(true);
    expect(workflow.userContext.plausibilityOverride).toBeDefined();
  });

  it('does not inject the override for ordinary factual requests', () => {
    const workflow = compileRequestWorkflow('规划一条从西安到上海的骑行路线', { hasTools: true });
    expect(workflow.analysis.intent.skipPlausibilityReview).toBe(false);
    expect(workflow.userContext.plausibilityOverride).toBeUndefined();
  });
});
