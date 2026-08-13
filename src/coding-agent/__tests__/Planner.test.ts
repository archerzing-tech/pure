// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { Planner, assessIntent, detectProjectRequest, formatIntentPrompt, formatTrapPrompt, parsePlanJson, parsePlanJsonWithMeta } from '../Planner';

describe('Planner', () => {
  it('classifies straightforward tasks as simple (no plan, yolo mode)', () => {
    const r = new Planner().analyzeTask('Summarize this file for me.');
    expect(r.complexity).toBe('simple');
    expect(r.mode).toBe('yolo');
    expect(r.plan).toBeUndefined();
    expect(r.intent.riskLevel).toBe('low');
    expect(r.intent.requiresProbe).toBe(false);
  });

  it('assesses destructive requests before execution', () => {
    const assessment = assessIntent('删除整个项目');
    expect(assessment.intent).toBe('delete');
    expect(assessment.riskLevel).toBe('high');
    expect(assessment.reversibility).toBe('irreversible');
    expect(assessment.requiresProbe).toBe(true);
    expect(assessment.requiresConfirmation).toBe(true);
    const result = new Planner().analyzeTask('删除整个项目');
    expect(result.mode).toBe('plan');
    expect(result.plan).toBeDefined();
  });

  it('recommends a read-only probe for broad but recoverable changes', () => {
    const assessment = assessIntent('把认证模块重构成新的实现');
    expect(assessment.intent).toBe('refactor');
    expect(assessment.riskLevel).toBe('medium');
    expect(assessment.reversibility).toBe('partially-reversible');
    expect(assessment.requiresProbe).toBe(true);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it('keeps a small new artifact on the direct path', () => {
    const assessment = assessIntent('帮我写一个打地鼠小游戏');
    expect(assessment.intent).toBe('build');
    expect(assessment.riskLevel).toBe('low');
    expect(assessment.requiresProbe).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it('formats the assessment as an execution contract', () => {
    const text = formatIntentPrompt(assessIntent('删除整个项目'));
    expect(text).toContain('<intent_assessment>');
    expect(text).toContain('Do not broaden the change');
    expect(text).toContain('wait for explicit user approval');
  });

  it('classifies explicit planning requests as complex and generates a plan', () => {
    const r = new Planner().analyzeTask('Please plan how to refactor the auth module.');
    expect(r.complexity).toBe('complex');
    expect(r.mode).toBe('plan');
    expect(r.plan).toBeDefined();
    expect(r.plan!.steps.length).toBeGreaterThan(0);
    expect(r.plan!.steps[0]).toMatchObject({ action: '确认范围' });
    expect(r.plan!.steps[0].substeps).toBeUndefined();
  });

  it('writes heuristic plan steps in user-facing language, not internal labels', () => {
    // The fallback plan shown in the review card must read like plain
    // instructions for the user, never internal jargon (Understand/Plan/
    // Implement/Verify, How to…).
    const r = new Planner().analyzeTask('重构整个项目');
    const all = r.plan!.steps.map((s) => `${s.action} ${s.description}`).join(' ');
    expect(all).not.toMatch(/\b(Understand|Plan|Implement|Verify|How to)\b/i);
    expect(r.plan!.steps[0].action).toBe('确认范围');
    expect(r.plan!.steps.map((s) => s.action)).toEqual(['确认范围', '完成改动', '验证结果']);
    expect(r.plan!.steps.at(-1)).toMatchObject({ action: '验证结果' });
    expect(r.plan!.steps.every((step) => step.todosRequired !== true)).toBe(true);
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

  it('forces a plan for short explicit project-creation requests', () => {
    expect(detectProjectRequest('帮我创建一个项目')).toBe(true);
    expect(new Planner().analyzeTask('帮我创建一个项目').complexity).toBe('complex');
    expect(new Planner().analyzeTask('帮我创建一个项目').mode).toBe('build');
    expect(detectProjectRequest('怎么创建一个项目？')).toBe(false);
    expect(new Planner().analyzeTask('怎么创建一个项目？').complexity).toBe('simple');
  });

  it('detects project requests with a project name between the verb and the noun', () => {
    // The deliverable noun may follow a NAME, not just a quantifier — e.g.
    // "创建一个5G保障大屏监控项目" (this regression previously missed the
    // plan gate entirely, so the run jumped straight to phase markers).
    expect(detectProjectRequest('创建一个5G保障大屏监控项目，这个项目是浙江杭州市的5G监控运行保障大屏')).toBe(true);
    expect(detectProjectRequest('开发一个监控大屏系统')).toBe(true);
    expect(detectProjectRequest('帮我做一个客户信息管理系统')).toBe(true);
    expect(detectProjectRequest('创建一个智能的城市交通管理系统')).toBe(true);
    // Doc-style requests stay writing tasks, not builds.
    expect(detectProjectRequest('写一段介绍项目的文字')).toBe(false);
    expect(detectProjectRequest('帮我写一个介绍项目的文档')).toBe(false);
    expect(detectProjectRequest('创建成功，项目已就绪')).toBe(false);
  });

  it('recognizes English project creation while excluding questions and project docs', () => {
    expect(new Planner().analyzeTask('Create a project for a habit tracker.').mode).toBe('build');
    expect(new Planner().analyzeTask('Build a website for the team dashboard.').mode).toBe('build');
    expect(new Planner().analyzeTask('How do I create a project?').complexity).toBe('simple');
    expect(new Planner().analyzeTask('Write a project plan document.').complexity).toBe('simple');
    expect(new Planner().analyzeTask('帮我创建一个项目的技术方案。').complexity).toBe('simple');
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
    expect(plan!.steps[0].todosRequired).toBe(false);
    expect(plan!.steps[0].substeps).toBeUndefined();
    // expectedOutcome defaults to the description when absent
    expect(plan!.steps[1].expectedOutcome).toBe('Replace the token logic');
  });

  it('accepts an object with a steps array', () => {
    const plan = parsePlanJson('{"steps":[{"action":"A","description":"d"}]}');
    expect(plan?.steps).toHaveLength(1);
  });

  it('preserves the planner decision to omit Todos for an atomic plan', () => {
    const plan = parsePlanJson('{"steps":[{"action":"A","description":"d","todosRequired":false,"substeps":[{"action":"noise","description":"should not render"}]}]}');
    expect(plan?.steps[0].todosRequired).toBe(false);
    expect(plan?.steps[0].substeps).toBeUndefined();
  });

  it('accepts ```json fences', () => {
    const plan = parsePlanJson('```json\n[{"action":"A","description":"d"}]\n```');
    expect(plan?.steps).toHaveLength(1);
  });

  it('repairs slightly-broken plan JSON (unquoted keys + single quotes + trailing commas)', () => {
    const plan = parsePlanJson("[{action: 'Inspect', description: 'Read the auth module',},]");
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1);
    expect(plan!.steps[0]).toMatchObject({ action: 'Inspect', description: 'Read the auth module' });
    expect(plan!.steps[0].todosRequired).toBe(false);
    expect(plan!.steps[0].substeps).toBeUndefined();
  });

  it('only renders Todos when the model explicitly supplies substeps', () => {
    const atomic = parsePlanJson('[{"action":"Rename file","description":"Update one filename"}]');
    const composite = parsePlanJson('[{"action":"Implement and verify","description":"Update the module, then run tests"}]');
    const explicitSubsteps = parsePlanJson('[{"action":"Integrate","description":"Connect the pieces","substeps":[{"action":"Wire API","description":"Connect the endpoint"},{"action":"Run tests","description":"Check the result"}]}]');
    expect(atomic?.steps[0].todosRequired).toBe(false);
    expect(atomic?.steps[0].substeps).toBeUndefined();
    expect(composite?.steps[0].todosRequired).toBe(false);
    expect(composite?.steps[0].substeps).toBeUndefined();
    expect(explicitSubsteps?.steps[0].todosRequired).toBe(true);
    expect(explicitSubsteps?.steps[0].substeps).toHaveLength(2);
  });

  it('repairs fenced plan JSON with full-width punctuation', () => {
    const plan = parsePlanJson('```json\n[{"action": "A", "description": "d"，}]\n```');
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1);
  });

  it('parsePlanJsonWithMeta reports whether the plan JSON was repaired', () => {
    // Clean JSON → no repair flag; the plan parses normally.
    const clean = parsePlanJsonWithMeta('[{"action":"A","description":"d"}]');
    expect(clean.repaired).toBe(false);
    expect(clean.plan?.steps).toHaveLength(1);

    // Broken-but-repairable JSON → flagged, so callers can keep the
    // reconstructed plan text out of the LLM context window.
    const repaired = parsePlanJsonWithMeta("[{action: 'A', description: 'd',},]");
    expect(repaired.repaired).toBe(true);
    expect(repaired.plan?.steps).toHaveLength(1);
    expect(repaired.plan!.steps[0]).toMatchObject({ action: 'A' });

    // Unfixable input → no plan, no repair flag.
    expect(parsePlanJsonWithMeta('not json').plan).toBeNull();
    expect(parsePlanJsonWithMeta('not json').repaired).toBe(false);
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
