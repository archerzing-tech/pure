// src/ui/__tests__/plan.test.ts
// Covers the pure helper that turns an approved plan into a system-prompt
// fragment. (The dialog controller itself is DOM-bound and exercised manually.)

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatPlanForPrompt, matchPlanPhaseMarker, QUALITY_GATE_STEPS } from '../plan';
import { t } from '../../shared/i18n';
import type { Plan } from '../../coding-agent/types';

describe('formatPlanForPrompt', () => {
  it('renders ordered steps into a prompt fragment', () => {
    const plan: Plan = {
      reasoning: 'complex task',
      steps: [
        { id: '1', action: 'Understand', description: 'Read relevant files.', expectedOutcome: 'Context' },
        { id: '2', action: 'Implement', description: 'Write the changes.', expectedOutcome: 'Working code' },
      ],
    };
    const out = formatPlanForPrompt(plan);
    const projectOut = formatPlanForPrompt(plan, true);
    expect(out).toContain('Execution plan');
    expect(out).toContain('1. Understand: Read relevant files.');
    expect(out).toContain('2. Implement: Write the changes.');
    expect(out).toContain('Work through these steps in order');
    expect(projectOut).toContain('execute phases strictly in order');
    // Ordinary plans keep the concise step instruction; project builds add
    // the stricter phase-marker protocol.
    expect(out).not.toContain('## 阶段 n/m');
    expect(projectOut).toContain('## 阶段 n/m');
  });
});

describe('matchPlanPhaseMarker', () => {
  it('matches Chinese phase markers at line start', () => {
    expect(matchPlanPhaseMarker('## 阶段 2/4')).toBe(2);
    expect(matchPlanPhaseMarker('步骤 1/3\n开始工作')).toBe(1);
    expect(matchPlanPhaseMarker('\n阶段 3/4 完成')).toBe(3);
  });

  it('matches English step/phase markers', () => {
    expect(matchPlanPhaseMarker('## Step 3 of 5')).toBe(3);
    expect(matchPlanPhaseMarker('## Step 2/4')).toBe(2);
    expect(matchPlanPhaseMarker('> Phase 4/6')).toBe(4);
  });

  it('returns the highest phase mentioned in a chunk', () => {
    expect(matchPlanPhaseMarker('## 阶段 1/4 调研\n## 阶段 2/4 实现')).toBe(2);
  });

  it('ignores mid-line mentions and plain text', () => {
    expect(matchPlanPhaseMarker('请按阶段 1/4 执行')).toBe(null);
    expect(matchPlanPhaseMarker('README 里写了一个"阶段 1/4"的示例')).toBe(null);
    expect(matchPlanPhaseMarker('普通文本')).toBe(null);
  });
});

describe('QUALITY_GATE_STEPS (delivery checklist card)', () => {
  it('lists the verification steps in gate execution order', () => {
    expect(QUALITY_GATE_STEPS.map((s) => s.phase)).toEqual(['review', 'audit', 'verify']);
  });

  it('describes each step in user-facing language, not internal phrasing', () => {
    for (const step of QUALITY_GATE_STEPS) {
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(10);
      expect(step.description).not.toMatch(/Understand|Plan|Implement|Verify|How to/i);
    }
  });
});

describe('plan refining badge (3s hint rotation)', () => {
  it('rotates the hint every 3 seconds and self-cleans when the badge leaves the DOM', () => {
    const src = readFileSync(new URL('../plan.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/setInterval\(\(\) =>/);
    expect(src).toMatch(/3000\)/);
    expect(src).toMatch(/!badge\.isConnected/);
    expect(src).toMatch(/clearInterval\(timer\)/);
  });

  it('provides localized rotating hints', () => {
    for (const key of ['plan.refining.files', 'plan.refining.analyzing', 'plan.refining.planning'] as const) {
      const text = t(key);
      expect(text).not.toBe(key);
      expect(text.length).toBeGreaterThan(4);
    }
  });
});
