// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { Planner, formatTrapPrompt, parsePlanJson } from '../Planner';

describe('Planner', () => {
  it('classifies straightforward tasks as simple (no plan, yolo mode)', () => {
    const r = new Planner().analyzeTask('Summarize this file for me.');
    expect(r.complexity).toBe('simple');
    expect(r.mode).toBe('yolo');
    expect(r.plan).toBeUndefined();
  });

  it('classifies explicit planning requests as complex and generates a plan', () => {
    const r = new Planner().analyzeTask('Please plan how to refactor the auth module.');
    expect(r.complexity).toBe('complex');
    expect(r.mode).toBe('plan');
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

  it('classifies Chinese large-project requests as complex', () => {
    const r = new Planner().analyzeTask('帮我制作一个大型工程，包含完整的项目管理功能。');
    expect(r.complexity).toBe('complex');
    expect(r.plan).toBeDefined();
  });

  it('switches build mode for complex requests with build/artifact intent', () => {
    expect(new Planner().analyzeTask('帮我制作一个大型工程，包含完整的项目管理功能。').mode).toBe('build');
    expect(new Planner().analyzeTask('搭建一个完整的全栈项目。').mode).toBe('build');
    expect(new Planner().analyzeTask('请帮我搭建一个全栈项目，怎么做性能优化？').mode).toBe('build');
    expect(new Planner().analyzeTask('Implement a new feature across multiple files in the project.').mode).toBe('plan');
  });

  it('classifies Chinese full-stack / multi-file builds as complex', () => {
    expect(new Planner().analyzeTask('搭建一个完整的全栈项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('从零开始构建一个多文件系统。').complexity).toBe('complex');
  });

  it('keeps single-file Chinese artifacts simple', () => {
    const r = new Planner().analyzeTask('帮我写一个打地鼠小游戏。');
    expect(r.complexity).toBe('simple');
    expect(new Planner().analyzeTask('做一个简单的网页。').complexity).toBe('simple');
  });

  it('keeps Chinese documentation requests simple (bare verb + noun, no scale word)', () => {
    expect(new Planner().analyzeTask('帮我写一个项目总结。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('写个项目方案。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('做个系统介绍。').complexity).toBe('simple');
  });

  it('keeps Chinese doc requests simple even with a scale word present', () => {
    expect(new Planner().analyzeTask('帮我写一个完整的项目方案。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('写一个完整的项目总结。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('搭建完整项目的开发文档。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('帮我写一个完整项目的技术方案。').complexity).toBe('simple');
  });

  it('keeps destructive / query actions on whole projects simple', () => {
    expect(new Planner().analyzeTask('删除整个项目。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('查看整个项目的结构。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('整理整个项目的依赖。').complexity).toBe('simple');
  });

  it('keeps Chinese how-to questions simple even with scale words', () => {
    expect(new Planner().analyzeTask('请帮我看看怎么搭建一个完整的全栈项目。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('如何搭建一个完整的全栈项目？').complexity).toBe('simple');
    expect(new Planner().analyzeTask('全栈项目的数据库怎么设计？').complexity).toBe('simple');
    expect(new Planner().analyzeTask('这个大型工程要怎么规划？').complexity).toBe('simple');
  });

  it('classifies scale word + noun + build verb as complex', () => {
    expect(new Planner().analyzeTask('重构整个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('迁移整个项目到 monorepo。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('搭建整个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('从零开始做一个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('从头搭建一个网站。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('搭建一个大型网站。').complexity).toBe('complex');
  });

  it('treats a build command with a trailing question as complex', () => {
    expect(new Planner().analyzeTask('帮我搭建一个全栈项目，怎么做性能优化？').complexity).toBe('complex');
    expect(new Planner().analyzeTask('请帮我搭建一个全栈项目，怎么部署？').complexity).toBe('complex');
  });

  it('keeps from-scratch learning and doc requests simple', () => {
    expect(new Planner().analyzeTask('从零开始学习。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('从零搭建一个网站的教程。').complexity).toBe('simple');
    expect(new Planner().analyzeTask('从头写一个项目的总结。').complexity).toBe('simple');
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

describe('parsePlanJson (LLM plan parsing)', () => {
  it('parses a plain JSON array of steps', () => {
    const plan = parsePlanJson('[{"action":"Inspect","description":"Read the auth module","expectedOutcome":"Understand the current flow"},{"action":"Rewrite","description":"Replace the token logic"}]');
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(2);
    expect(plan!.steps[0]).toMatchObject({ action: 'Inspect', description: 'Read the auth module' });
    // expectedOutcome defaults to the description when absent
    expect(plan!.steps[1].expectedOutcome).toBe('Replace the token logic');
  });

  it('accepts an object with a steps array', () => {
    const plan = parsePlanJson('{"steps":[{"action":"A","description":"d"}]}');
    expect(plan?.steps).toHaveLength(1);
  });

  it('accepts ```json fences', () => {
    const plan = parsePlanJson('```json\n[{"action":"A","description":"d"}]\n```');
    expect(plan?.steps).toHaveLength(1);
  });

  it('returns null for malformed / empty / non-array input', () => {
    expect(parsePlanJson('')).toBeNull();
    expect(parsePlanJson('not json')).toBeNull();
    expect(parsePlanJson('{}')).toBeNull();
    expect(parsePlanJson('[]')).toBeNull();
    expect(parsePlanJson('{"steps":[]}')).toBeNull();
    expect(parsePlanJson('[{"foo":1}]')).toBeNull();
  });

  it('drops empty steps and fills action/description fallbacks', () => {
    const plan = parsePlanJson('[{"action":"","description":""},{"action":"Only action"}]');
    expect(plan?.steps).toHaveLength(1);
    expect(plan!.steps[0].description).toBe('Only action');
  });

  it('caps runaway step lists at 10 and re-indexes ids', () => {
    const many = Array.from({ length: 25 }, (_, i) => JSON.stringify({ action: `S${i}`, description: `d${i}` })).join(',');
    const plan = parsePlanJson(`[${many}]`);
    expect(plan?.steps).toHaveLength(10);
    expect(plan!.steps[9]).toMatchObject({ id: '10', action: 'S9' });
  });
});
