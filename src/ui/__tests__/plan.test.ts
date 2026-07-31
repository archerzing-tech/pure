// src/ui/__tests__/plan.test.ts
// Covers the pure helper that turns an approved plan into a system-prompt
// fragment. (The dialog controller itself is DOM-bound and exercised manually.)

import { describe, it, expect } from 'bun:test';
import { formatPlanForPrompt } from '../plan';
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
  });
});
