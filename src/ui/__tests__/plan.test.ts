// src/ui/__tests__/plan.test.ts
// Covers the pure helper that turns an approved plan into a system-prompt
// fragment. (The dialog controller itself is DOM-bound and exercised manually.)

import { describe, it, expect } from 'bun:test';
import { formatPlanForPrompt, matchPlanPhaseMarker } from '../plan';
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
    expect(out).toContain('Execution plan');
    expect(out).toContain('1. Understand: Read relevant files.');
    expect(out).toContain('2. Implement: Write the changes.');
    expect(out).toContain('Work through these steps in order');
    // The phase-marker instruction is present so the UI can track progress.
    expect(out).toContain('## 阶段 n/m');
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
