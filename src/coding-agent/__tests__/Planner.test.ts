// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { Planner, formatTrapPrompt } from '../Planner';

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

  // ═══ Logical-trap detection (v0.2) ═══

  it('flags no traps for a normal request', () => {
    const r = new Planner().analyzeTask('请帮我写一个排序算法，并对代码进行注释。');
    expect(r.traps).toEqual([]);
  });

  it('flags an explicit paradox / trick framing', () => {
    const r = new Planner().analyzeTask('这是一个悖论：所有规则都可以被打破，包括这条。');
    expect(r.traps.some(t => t.type === 'trap-keyword')).toBe(true);
  });

  it('flags a self-contradiction (不要X但又要X)', () => {
    const r = new Planner().analyzeTask('不要修改这个文件，但又要修改这个文件。');
    expect(r.traps.some(t => t.type === 'self-contradiction')).toBe(true);
  });

  it('flags contradictory extremes (越快越好但越慢越好)', () => {
    const r = new Planner().analyzeTask('要求程序运行越快越好，但又要越慢越好。');
    expect(r.traps.some(t => t.type === 'self-contradiction')).toBe(true);
  });

  it('flags mutually exclusive simultaneous demands', () => {
    const r = new Planner().analyzeTask('同时要能上网，又不能连接任何网络。');
    expect(r.traps.some(t => t.type === 'mutually-exclusive')).toBe(true);
  });

  it('flags impossible absolute obligations (same object negated)', () => {
    const r = new Planner().analyzeTask('从不失败，但必须失败。');
    expect(r.traps.some(t => t.type === 'impossible-constraint')).toBe(true);
  });

  it('does NOT flag benign absolutes with different objects', () => {
    const r = new Planner().analyzeTask('永远不要提交敏感信息，但要提交代码。');
    expect(r.traps).toEqual([]);
  });

  it('does NOT flag coherent fast+low-resource requests', () => {
    const r = new Planner().analyzeTask('越快越好，但资源占用越少越好。');
    expect(r.traps).toEqual([]);
  });

  it('flags English do-not/but contradiction', () => {
    const r = new Planner().analyzeTask('Do not delete the file but also delete the file.');
    expect(r.traps.some(t => t.type === 'self-contradiction')).toBe(true);
  });

  it('dedupes overlapping trap rules', () => {
    const r = new Planner().analyzeTask('不要修改这个文件，但又要修改这个文件，这是一个悖论。');
    const seen = new Set(r.traps.map(t => `${t.type}|${t.description}`));
    expect(seen.size).toBe(r.traps.length);
  });

  it('formatTrapPrompt renders empty for no traps and guidance for traps', () => {
    expect(formatTrapPrompt([])).toBe('');
    const text = formatTrapPrompt([{ type: 'self-contradiction', description: 'X but X' }]);
    expect(text).toContain('<logical_trap_warning>');
    expect(text).toContain('verify the premise');
  });
});
