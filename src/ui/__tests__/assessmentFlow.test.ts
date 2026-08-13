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
    recommendation: '先做只读探针。',
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
      // Mirror real-DOM behavior: data-* attributes sync into the dataset map.
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

describe('active intent assessment flow', () => {
  it('uses a read-only probe as the medium-risk safety gate', () => {
    const stages = getAssessmentFlowStages(assessment());
    expect(stages.map((stage) => stage.phase)).toEqual(['intent', 'risk', 'gate', 'execute', 'verify']);
    // The intent node starts pending and is only resolved by a REAL event
    // (chat.ts completes it after the LLM analysis lands) — the card must
    // never read as a pre-computed result.
    expect(stages[0]?.status).toBe('pending');
    expect(stages[2]?.label).toBe('只读探针');
    expect(stages[2]?.description).toContain('收集证据');
  });

  it('uses explicit confirmation as the high-risk safety gate', () => {
    const stages = getAssessmentFlowStages(assessment({
      intent: 'delete',
      riskLevel: 'high',
      reversibility: 'irreversible',
      requiresProbe: true,
      requiresConfirmation: true,
    }));
    expect(stages[2]?.label).toBe('执行确认');
    expect(stages[2]?.description).toContain('等待你确认');
    expect(stages[3]?.description).toContain('确认范围');
  });

  it('keeps low-risk requests on the same five-node flow without inventing a probe', () => {
    const stages = getAssessmentFlowStages(assessment({
      riskLevel: 'low',
      reversibility: 'reversible',
      requiresProbe: false,
      requiresConfirmation: false,
    }));
    expect(stages[2]?.label).toBe('安全闸门');
    expect(stages[2]?.description).toContain('不需要额外确认');
  });

  it('keeps the GUI card accessible, collapsible, and connected to the real flow phases', () => {
    const source = readFileSync(new URL('../assessmentFlow.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../plain-text-plan.css', import.meta.url), 'utf8');
    expect(source).toContain("document.createElement('details')");
    expect(source).toContain("body.setAttribute('role', 'group')");
    expect(source).toContain("diagram.setAttribute('role', 'list')");
    // Staged reveal: the card must expose phase transitions AND a dedicated
    // awaiting (waiting-for-reply) state for the plan pause point.
    expect(source).toContain('const setPhase = (phase');
    expect(source).toContain('const completePhase = (phase');
    expect(source).toContain("transition(phase, 'awaiting', text)");
    expect(source).toContain("card.open = false");
    expect(css).toContain('.assessment-flow-diagram');
    expect(css).toContain('.assessment-flow-node.active');
    expect(css).toContain('.assessment-flow-node.done');
    expect(css).toContain('@media (max-width: 760px)');
  });

  it('does not turn a cancelled high-risk confirmation into an execution state', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({ riskLevel: 'high', intent: 'delete', requiresConfirmation: true }));
      handle.setPhase('gate', '等待确认');
      handle.setPhase('execute', '错误地尝试执行');
      expect(findNode(handle.el, '执行确认')?.dataset.status).toBe('active');
      expect(findNode(handle.el, '小步执行')?.dataset.status).toBe('pending');
      handle.cancel('未批准');

      const skipped = createAssessmentFlowCard(assessment({ riskLevel: 'high', intent: 'delete', requiresConfirmation: true }));
      skipped.skipPhase('gate', '错误地跳过确认');
      skipped.setPhase('execute', '错误地尝试执行');
      expect(findNode(skipped.el, '小步执行')?.dataset.status).toBe('pending');
      expect(handle.el.children[0]?.classList.contains('cancelled')).toBe(true);
      expect(findNode(handle.el, '执行确认')?.dataset.status).toBe('blocked');
      expect(findNode(handle.el, '小步执行')?.dataset.status).toBe('pending');
    } finally {
      restore();
    }
  });

  it('keeps chat approval ahead of the execution transition', () => {
    const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    const approval = chat.indexOf('const decision = await requestPlanReview(');
    const approveBranch = chat.indexOf("if (decision === 'cancel')", approval);
    const gatePass = chat.indexOf("assessmentFlow.completePhase('gate'");
    // Approval happens on the dialog-approved path only: approvePlan(true) marks
    // the explicit user approval (project builds / high-risk / forced plan mode).
    const approveCall = chat.indexOf('approvePlan(true);', approveBranch);
    expect(approval).toBeGreaterThan(-1);
    expect(approveBranch).toBeGreaterThan(approval);
    expect(gatePass).toBeGreaterThan(-1);
    expect(approveCall).toBeGreaterThan(approveBranch);
  });

  it('preserves a skipped gate when the rest of the assessment finishes', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({ riskLevel: 'low', requiresProbe: false }));
      handle.skipPhase('gate', '无需额外闸门');
      handle.complete('完成');
      expect(findNode(handle.el, '安全闸门')?.dataset.status).toBe('skipped');
      expect(findNode(handle.el, '验证结果')?.dataset.status).toBe('done');
    } finally {
      restore();
    }
  });

  it('shows a distinct awaiting state when execution waits for the user reply', () => {
    const restore = installFakeDocument();
    try {
      const handle = createAssessmentFlowCard(assessment({ requiresProbe: false, requiresConfirmation: false }));
      // Simulate the plan-ready pause: gate approved, execute node switches to
      // awaiting instead of active.
      handle.completePhase('gate', '评估完成');
      handle.awaitPhase('execute', '计划已就绪，等待你回复后开始…');
      // dataset.status is set through the same setStatus path used by every
      // other status (the fake document stores it on the element object via
      // setAttribute), so the awaiting class was applied without throwing.
      expect(findNode(handle.el, '小步执行')).not.toBeNull();
      expect(findNode(handle.el, '小步执行')?.dataset.status).toBe('awaiting');
    } finally {
      restore();
    }
  });

  it('rebuilds the paused high-risk card on session restore with execute awaiting', () => {
    const restore = installFakeDocument();
    try {
      // This is exactly the sequence main.ts runs when a paused plan message
      // is restored: gate completed, then execute set to awaiting. The
      // requiresConfirmation gate guard must NOT block the awaiting transition
      // once the gate is marked done.
      const handle = createAssessmentFlowCard(assessment({
        intent: 'delete',
        riskLevel: 'high',
        reversibility: 'irreversible',
        requiresProbe: true,
        requiresConfirmation: true,
      }));
      handle.completePhase('gate');
      handle.awaitPhase('execute', '计划已就绪，等待你回复后开始第一个可验证步骤…');
      expect(findNode(handle.el, '识别意图')?.dataset.status).toBe('done');
      expect(findNode(handle.el, '评估风险')?.dataset.status).toBe('done');
      expect(findNode(handle.el, '执行确认')?.dataset.status).toBe('done');
      expect(findNode(handle.el, '小步执行')?.dataset.status).toBe('awaiting');
      expect(findNode(handle.el, '验证结果')?.dataset.status).toBe('pending');
    } finally {
      restore();
    }
  });
});
