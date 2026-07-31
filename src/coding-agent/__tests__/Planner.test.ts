// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight.

import { describe, it, expect } from 'bun:test';
import { Planner } from '../Planner';

describe('Planner', () => {
  it('classifies straightforward tasks as simple (no plan)', () => {
    const r = new Planner().analyzeTask('Summarize this file for me.');
    expect(r.complexity).toBe('simple');
    expect(r.plan).toBeUndefined();
  });

  it('classifies explicit planning requests as complex and generates a plan', () => {
    const r = new Planner().analyzeTask('Please plan how to refactor the auth module.');
    expect(r.complexity).toBe('complex');
    expect(r.plan).toBeDefined();
    expect(r.plan!.steps.length).toBeGreaterThan(0);
    expect(r.plan!.steps[0]).toMatchObject({ action: 'Understand' });
  });

  it('classifies multi-file scope as complex', () => {
    const r = new Planner().analyzeTask('Implement a new feature across multiple files in the project.');
    expect(r.complexity).toBe('complex');
    expect(r.plan).toBeDefined();
  });

  it('treats plain questions as simple even with file mentions', () => {
    const r = new Planner().analyzeTask('What does this file do?');
    expect(r.complexity).toBe('simple');
  });
});
