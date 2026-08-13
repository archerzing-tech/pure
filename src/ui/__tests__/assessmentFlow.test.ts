import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAssessmentFlowCard, getAssessmentFlowStages } from '../assessmentFlow';
import type { IntentAssessment } from '../../coding-agent/types';

function assessment(overrides: Partial<IntentAssessment> = {}): IntentAssessment {
  return {
    intent: 'modify',
    riskLevel: 'medium',
    reversibility: 'partially-reversible',
    impact: '可能波及多个模块。',
    recommendation: '先读取真实结构，再决定改动。',
    requiresProbe: true,
    requiresConfirmation: false,
    ...overrides,
  };
}

function installFakeDocument(): () => void {
  const previous = (globalThis as any).document;
  const createElement = (tag: string): any => {
    const classes = new Set<string>();
    const element: any = {
      tagName: tag.toUpperCase(),
      children: [],
      childNodes: [],
      dataset: {},
      className: '',
      textContent: '',
      open: false,
      isConnected: true,
      classList: {
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
        contains: (name: string) => classes.has(name),
      },
      append: (...items: any[]) => items.forEach((item) => { element.children.push(item); element.childNodes.push(item); }),
      appendChild: (item: any) => { element.children.push(item); element.childNodes.push(item); return item; },
      setAttribute: (name: string, value: string) => {
        element[name] = value;
        if (name.startsWith('data-')) element.dataset[name.slice(5)] = value;
      },
    };
    return element;
  };
  (globalThis as any).document = { createElement };
  return () => { (globalThis as any).document = previous; };
}

function findNode(root: any, label: string): any | null {
  if (root?.dataset?.label === label) return root;
  for (const child of root?.children ?? []) {
    const found = findNode(child, label);
    if (found) return found;
  }
  return null;
}

describe('dynamic intent assessment flow', () => {
  it('only renders the decision points relevant to a medium-risk task', () => {
    const stages = getAssessmentFlowStages(assessment());
    expect(stages.map((stage) => stage.phase)).toEqual(['intent', 'risk']);
    expect(stages[0]?.label).toContain('修改功能');
    expect(stages[1]?.label).toBe('需要注意的影响');
    expect(stages[1]?.description).toContain('先读取真实结构');
  });

  it('adds an explicit confirmation point only for high-risk work', () => {
    const stages = getAssessmentFlowStages(assessment({
      intent: 'delete',
      riskLevel: 'high',
      reversibility: 'irreversible',
      requiresConfirmation: true,
    }));
    expect(stages.map((stage) => stage.phase)).toEqual(['intent', 'risk', 'gate']);
    expect(stages[2]?.label).toBe('执行前需要你的确认');
    expect(stages[2]?.description).toContain('先读取真实结构');
  });

  it('does not invent a safety gate for a low-risk task', () => {
    const stages = getAssessmentFlowStages(assessment({
      riskLevel: 'low',
      reversibility: 'reversible',
      requiresProbe: false,
      requiresConfirmation: false,
    }));
    expect(stages.map((stage) => stage.phase)).toEqual(['intent']);
  });

  it('keeps the GUI card accessible and uses task-specific content', () => {
    const source = readFileSync(new URL('../assessmentFlow.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../plain-text-plan.css', import.meta.url), 'utf8');
    expect(source).toContain("document.createElement('details')");
    expect(source).toContain("body.setAttribute('role', 'group')");
    expect(source).toContain("diagram.setAttribute('role', 'list')");
    expect(source).toContain('relevantStages');
    expect(source).not.toContain("const PHASES: AssessmentFlowPhase[] = ['intent', 'risk', 'gate', 'execute', 'verify']");
    expect(css).toContain('.assessment-flow-diagram');
    expect(css).toContain('.assessment-flow-node.active');
    expect(css).toContain('.assessment-flow-node.done');
  });

  it('does not turn a cancelled high-risk confirmation into an execution state', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({
        riskLevel: 'high',
        intent: 'delete',
        requiresConfirmation: true,
      }));
      handle.setPhase('gate', '等待确认');
      handle.setPhase('execute', '错误地尝试执行');
      expect(findNode(handle.el, '执行前需要你的确认')?.dataset.status).toBe('active');
      handle.cancel('未批准');
      expect(handle.el.children[0]?.classList.contains('cancelled')).toBe(true);
      expect(findNode(handle.el, '执行前需要你的确认')?.dataset.status).toBe('blocked');
      expect(findNode(handle.el, '错误地尝试执行')).toBeNull();
    } finally {
      restore();
    }
  });

  it('keeps chat approval ahead of the execution transition', () => {
    const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    const approval = chat.indexOf('const decision = await requestPlanReview(');
    const approveBranch = chat.indexOf("if (decision === 'cancel')", approval);
    const gatePass = chat.indexOf("assessmentFlow.completePhase('gate'");
    const approveCall = chat.indexOf('approvePlan(true);', approveBranch);
    expect(approval).toBeGreaterThan(-1);
    expect(approveBranch).toBeGreaterThan(approval);
    expect(gatePass).toBeGreaterThan(-1);
    expect(approveCall).toBeGreaterThan(approveBranch);
  });

  it('allows execution updates without fabricating execute and verify nodes', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({ requiresConfirmation: false }));
      handle.completePhase('risk', '影响范围已明确');
      handle.setPhase('execute', '正在按计划执行');
      handle.completePhase('verify', '已完成实际验证');
      handle.complete('完成');
      expect(findNode(handle.el, '小步执行')).toBeNull();
      expect(findNode(handle.el, '验证结果')).toBeNull();
      expect(handle.el.children[0]?.classList.contains('complete')).toBe(true);
    } finally {
      restore();
    }
  });

  it('rebuilds a paused high-risk card with the relevant confirmation point', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({
        intent: 'delete',
        riskLevel: 'high',
        reversibility: 'irreversible',
        requiresProbe: true,
        requiresConfirmation: true,
      }));
      handle.completePhase('gate');
      handle.awaitPhase('execute', '计划已就绪，等待你回复后开始…');
      expect(findNode(handle.el, '我判断这是一次删除请求')?.dataset.status).toBe('done');
      expect(findNode(handle.el, '需要注意的影响')?.dataset.status).toBe('done');
      expect(findNode(handle.el, '执行前需要你的确认')?.dataset.status).toBe('done');
    } finally {
      restore();
    }
  });
});
