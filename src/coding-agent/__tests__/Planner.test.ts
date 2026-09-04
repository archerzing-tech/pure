// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { Planner, assessIntent, detectArtifactRequest, detectFictionIntent, detectProjectRequest, formatArtifactPrompt, formatIntentPrompt, formatTrapPrompt, inferSemanticRoute, isPlainConversational, classifyInsertion, parsePlanJson, parsePlanJsonWithMeta, parseSemanticRoute, shouldBypassSemanticRoute } from '../Planner';
import type { LLMAdapter, Message } from '../../shared/types';

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

  it('recommends a read-only probe for broad but recoverable changes (fallback safety net)', () => {
    // 语义路由不可用时，关键词兜底仍要把“重构 / 迁移”这类波及面大的改动标记为中等风险、
    // 需要探针——这是安全兜底策略，不是把用户意图归类为固定类型。
    const assessment = assessIntent('把认证模块重构成新的实现');
    expect(assessment.intent).toBe('refactor');
    expect(assessment.riskLevel).toBe('medium');
    expect(assessment.reversibility).toBe('partially-reversible');
    expect(assessment.requiresProbe).toBe(true);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it('does not infer ordinary creation intent from artifact words', () => {
    const assessment = assessIntent('帮我写一个打地鼠小游戏');
    expect(assessment.intent).toBe('question');
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

  it('parses a semantic route without relying on local keyword rules', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'build',
      complexity: 'complex',
      mode: 'build',
      requiresPlan: true,
      needsDeliveryGate: true,
      assessment: {
        riskLevel: 'low',
        reversibility: 'reversible',
        impact: '只生成隔离的原型文件',
        recommendation: '按独立方案逐个实现并验证',
        requiresProbe: true,
        requiresConfirmation: false,
      },
    }));
    expect(route).toMatchObject({ intent: 'build', complexity: 'complex', mode: 'build', requiresPlan: true });
    expect(route?.assessment.requiresConfirmation).toBe(false);
  });

  it('rejects incomplete semantic output and leaves the safe fallback in control', () => {
    expect(parseSemanticRoute('{"intent":"build","complexity":"complex"}')).toBeNull();
  });

  it('parses subagents into the semantic decision, filtering unknown roles', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'research',
      complexity: 'complex',
      mode: 'plan',
      requiresPlan: true,
      needsDeliveryGate: false,
      subagents: ['researcher', 'deep_thinker', 'not_a_real_role', 'code_editor'],
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '沿线路程', recommendation: '分头调研', requiresProbe: false, requiresConfirmation: false },
    }));
    expect(route?.subagents).toEqual(['researcher', 'deep_thinker', 'code_editor']);
  });

  it('preserves an explicit empty subagents array (≠ missing)', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'question',
      complexity: 'simple',
      mode: 'yolo',
      requiresPlan: false,
      needsDeliveryGate: false,
      subagents: [],
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '', requiresProbe: false, requiresConfirmation: false },
    }));
    expect(route?.subagents).toBeDefined();
    expect(route?.subagents).toEqual([]);
  });

  it('leaves subagents undefined when the field is absent', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'question',
      complexity: 'simple',
      mode: 'yolo',
      requiresPlan: false,
      needsDeliveryGate: false,
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '', requiresProbe: false, requiresConfirmation: false },
    }));
    expect(route?.subagents).toBeUndefined();
  });

  it('caps subagents at 4 and dedupes', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'build',
      complexity: 'complex',
      mode: 'build',
      requiresPlan: true,
      needsDeliveryGate: true,
      subagents: ['researcher', 'deep_thinker', 'researcher', 'ui_designer', 'project_auditor', 'bash_executor'],
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '新建', recommendation: '分步实现', requiresProbe: true, requiresConfirmation: false },
    }));
    expect(route?.subagents).toEqual(['researcher', 'deep_thinker', 'ui_designer', 'project_auditor']);
  });

  it('does not reject the whole decision when subagents is malformed', () => {
    const route = parseSemanticRoute(JSON.stringify({
      intent: 'research',
      complexity: 'complex',
      mode: 'plan',
      requiresPlan: true,
      needsDeliveryGate: false,
      subagents: 'researcher',
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '调研', recommendation: '查资料', requiresProbe: false, requiresConfirmation: false },
    }));
    expect(route).not.toBeNull();
    expect(route?.subagents).toBeUndefined();
  });

  it('bypasses the semantic router only for short acknowledgements without action words', () => {
    // Pleasantries / acknowledgements — no LLM round-trip needed.
    expect(shouldBypassSemanticRoute('好的')).toBe(true);
    expect(shouldBypassSemanticRoute('谢谢')).toBe(true);
    expect(shouldBypassSemanticRoute('ok')).toBe(true);
    expect(shouldBypassSemanticRoute('继续')).toBe(true);
    // Greetings / openers skip the semantic router too — an extra LLM round
    // trip for "hello" is the dominant part of the first-reply latency.
    expect(shouldBypassSemanticRoute('hello')).toBe(true);
    expect(shouldBypassSemanticRoute('hi')).toBe(true);
    expect(shouldBypassSemanticRoute('hey')).toBe(true);
    expect(shouldBypassSemanticRoute('你好')).toBe(true);
    expect(shouldBypassSemanticRoute('您好')).toBe(true);
    expect(shouldBypassSemanticRoute('早上好')).toBe(true);
    expect(shouldBypassSemanticRoute('在吗')).toBe(true);
    // Concrete short requests still route through the model.
    expect(shouldBypassSemanticRoute('帮我写个游戏')).toBe(false);
    expect(shouldBypassSemanticRoute('改一下')).toBe(false);
    expect(shouldBypassSemanticRoute('查查报错')).toBe(false);
    expect(shouldBypassSemanticRoute('重构')).toBe(false);
    // Questions / long messages / image attachments always route.
    expect(shouldBypassSemanticRoute('为什么？')).toBe(false);
    expect(shouldBypassSemanticRoute('这是一条足够长的消息，值得让模型完整判断一下应该怎么处理')).toBe(false);
    expect(shouldBypassSemanticRoute('好的', [{ dataUrl: 'data:image/png;base64,x', mimeType: 'image/png' }])).toBe(false);
  });

  it('asks the connected model for semantic routing instead of local keyword matching', async () => {
    let request: any[] = [];
    const consumed: string[] = [];
    const json = JSON.stringify({
      intent: 'question', complexity: 'simple', mode: 'yolo', requiresPlan: false, needsDeliveryGate: false,
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: 'design feedback', recommendation: 'explain options', requiresProbe: false, requiresConfirmation: false },
    });
    const llm = {
      // Unused now (routing consumes the stream incrementally) but required by
      // the LLMAdapter interface.
      complete: async () => ({ content: '' }),
      async *stream(messages: any[]) {
        request = messages;
        // The decision arrives across several streamed chunks, followed by
        // trailing prose the router must NOT wait for.
        consumed.push('a');
        yield { type: 'content', content: json.slice(0, 24) };
        consumed.push('b');
        yield { type: 'content', content: json.slice(24) };
        consumed.push('tail');
        yield { type: 'content', content: ' this tail is never read — the stream aborts as soon as the JSON parses' };
      },
    } as LLMAdapter;
    const route = await inferSemanticRoute(llm, '现有页面很难看，我应该从哪些设计方向改善？');
    expect(route?.intent).toBe('question');
    expect(request[1]?.content).toContain('现有页面很难看');
    expect(request[0]?.content).toContain('do not classify from isolated words');
    // Early-exit: the router stopped the stream the moment the decision object
    // was complete instead of draining the provider's trailing tokens.
    expect(consumed).toEqual(['a', 'b']);
  });

  it('skips the LLM router only for plainly conversational low-stakes questions', () => {
    expect(isPlainConversational('今天几号，星期几，天气如何')).toBe(true);
    expect(isPlainConversational('What is the weather like today?')).toBe(true);
    expect(isPlainConversational('为什么？')).toBe(true);
    expect(isPlainConversational('现有页面很难看，我应该从哪些设计方向改善？')).toBe(true);
    // Anything that could need the router still routes:
    // - no question shape → the deterministic verdict alone is not enough
    expect(isPlainConversational('帮我设计四个不同风格的自行车售卖网站的首页')).toBe(false);
    // - a build request hiding inside a question frame
    expect(isPlainConversational('能不能帮我设计一个自行车售卖网站的首页？')).toBe(false);
    // - destructive / risky framing
    expect(isPlainConversational('删除整个项目的文件，可以吗？')).toBe(false);
    // - image attachments
    expect(isPlainConversational('这张图讲了什么？', [{ dataUrl: 'data:image/png;base64,x', mimeType: 'image/png' }])).toBe(false);
  });

  it('classifies explicit planning requests as complex and generates a plan', () => {
    const r = new Planner().analyzeTask('Please plan how to refactor the auth module.');
    expect(r.complexity).toBe('complex');
    expect(r.mode).toBe('plan');
    expect(r.plan).toBeDefined();
    expect(r.plan!.steps.length).toBeGreaterThan(0);
    expect(r.plan!.steps[0].action).toContain('先理解');
    expect(r.plan!.steps[0].substeps).toBeUndefined();
  });

  it('writes heuristic plan steps in user-facing language, not internal labels', () => {
    // The fallback plan shown in the review card must read like plain
    // instructions for the user, never internal jargon (Understand/Plan/
    // Implement/Verify, How to…). It no longer buckets the request into a
    // fixed "确认范围/完成改动/验证结果" template by keyword.
    const r = new Planner().analyzeTask('重构整个项目');
    const all = r.plan!.steps.map((s) => `${s.action} ${s.description}`).join(' ');
    expect(all).not.toMatch(/\b(Understand|Plan|Implement|Verify|How to)\b/i);
    expect(r.plan!.steps[0].action).toContain('先理解');
    expect(r.plan!.steps.length).toBeGreaterThan(0);
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

  it('requires a test strategy in artifact build instructions', () => {
    const prompt = formatArtifactPrompt();
    expect(prompt).toContain('choose the project-appropriate test runner');
    expect(prompt).toContain('at least one focused smoke/unit/integration test');
    expect(prompt).toContain('happy-dom');
    expect(prompt).toContain('run the actual test command');
    expect(prompt).toContain('Do not replace automated tests with manual inspection');
  });
  it('does not turn dissatisfaction with an existing result into an artifact build request by itself', () => {
    const prompt = '当前agent 制作的基于web的页面 都很难看，缺少优秀的时髦的设计，应该怎么办';
    expect(detectArtifactRequest(prompt)).toBe(false);
    expect(new Planner().analyzeTask(prompt)).toMatchObject({ complexity: 'simple', mode: 'yolo' });
  });

  it('routes project creation through the synchronous build fallback while excluding questions', () => {
    expect(detectProjectRequest('帮我创建一个项目')).toBe(true);
    expect(new Planner().analyzeTask('帮我创建一个项目')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(detectProjectRequest('怎么创建一个项目？')).toBe(false);
    expect(new Planner().analyzeTask('怎么创建一个项目？')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
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

  it('routes English project creation through build fallback while excluding questions and docs', () => {
    expect(new Planner().analyzeTask('Create a project for a habit tracker.')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(new Planner().analyzeTask('Build a website for the team dashboard.')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(new Planner().analyzeTask('How do I create a project?').complexity).toBe('simple');
    expect(new Planner().analyzeTask('Write a project plan document.').complexity).toBe('simple');
    expect(new Planner().analyzeTask('帮我创建一个项目的技术方案。').complexity).toBe('simple');
  });

  it('treats new project builds as complex even without scale adjectives', () => {
    const r = new Planner().analyzeTask('帮我制作一个大型工程，包含完整的项目管理功能。');
    expect(r.complexity).toBe('complex');
    expect(r.mode).toBe('build');
    expect(r.plan).toBeDefined();
  });

  it('uses build fallback for project creation and keeps how-to questions conversational', () => {
    expect(new Planner().analyzeTask('帮我制作一个大型工程，包含完整的项目管理功能。').mode).toBe('build');
    expect(new Planner().analyzeTask('搭建一个完整的全栈项目。').mode).toBe('build');
    expect(new Planner().analyzeTask('请帮我搭建一个全栈项目，怎么做性能优化？').mode).toBe('yolo');
    expect(new Planner().analyzeTask('Implement a new feature across multiple files in the project.').mode).toBe('plan');
  });

  it('creates a build plan with a test strategy before implementation', () => {
    const r = new Planner().analyzeTask('创建一个5G的监控大屏项目，可以实时监控省市的实时网络现状，给出告警和分析。');
    expect(r.mode).toBe('build');
    expect(r.plan).toBeDefined();
    const actions = r.plan!.steps.map((step) => step.action).join(' ');
    const details = r.plan!.steps.map((step) => `${step.description} ${step.expectedOutcome}`).join(' ');
    expect(actions).toContain('测试策略');
    expect(actions).toContain('测试入口');
    expect(actions).toContain('运行测试');
    expect(details).toContain('smoke');
    expect(details).toContain('失败');
  });

  it('keeps broad refactors on the safety-aware plan fallback', () => {
    const r = new Planner().analyzeTask('重构整个项目');
    expect(r.mode).toBe('plan');
    expect(r.plan).toBeDefined();
    expect(r.plan!.steps[0].action).toContain('先理解');
  });

  it('classifies project creation as complex in the fallback router', () => {
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

  it('uses concrete scope or safety evidence rather than build vocabulary', () => {
    expect(new Planner().analyzeTask('重构整个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('迁移整个项目到 monorepo。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('搭建整个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('从零开始做一个项目。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('从头搭建一个网站。').complexity).toBe('complex');
    expect(new Planner().analyzeTask('搭建一个大型网站。').complexity).toBe('complex');
  });

  it('keeps build questions conversational until semantic routing decides otherwise', () => {
    expect(new Planner().analyzeTask('帮我搭建一个全栈项目，怎么做性能优化？').complexity).toBe('simple');
    expect(new Planner().analyzeTask('请帮我搭建一个全栈项目，怎么部署？').complexity).toBe('simple');
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

describe('detectFictionIntent', () => {
  it('detects explicit ignore-facts opt-outs', () => {
    expect(detectFictionIntent('不用管事实，随便写一个故事')).toBe(true);
    expect(detectFictionIntent('不考虑现实，给我一个架空的世界观')).toBe(true);
    expect(detectFictionIntent('不用考虑物理规律')).toBe(true);
    expect(detectFictionIntent("ignore physics and just make it up")).toBe(true);
    expect(detectFictionIntent("don't care about facts")).toBe(true);
  });

  it('detects explicit fiction markers', () => {
    expect(detectFictionIntent('帮我虚构一个古代王朝的历史')).toBe(true);
    expect(detectFictionIntent('写一个架空历史的故事')).toBe(true);
    expect(detectFictionIntent('编造一个平行世界的设定')).toBe(true);
    expect(detectFictionIntent('write an alternate history novel')).toBe(true);
  });

  it('detects genre creation but not factual genre questions', () => {
    expect(detectFictionIntent('写一个科幻小说')).toBe(true);
    expect(detectFictionIntent('write a fantasy story')).toBe(true);
    expect(detectFictionIntent('介绍科幻小说的历史')).toBe(false);
    expect(detectFictionIntent('解释相对论')).toBe(false);
  });

  it('does not flag ordinary factual requests', () => {
    expect(detectFictionIntent('规划一条从西安到上海的骑行路线')).toBe(false);
    expect(detectFictionIntent('解释这个文件的作用')).toBe(false);
    expect(detectFictionIntent('帮我写一个打地鼠小游戏')).toBe(false);
    expect(detectFictionIntent('What does this file do?')).toBe(false);
    // "别" as "other" (别的/别的历史) must not read as "don't".
    expect(detectFictionIntent('介绍一下别的历史人物')).toBe(false);
  });

  it('assessIntent propagates the detection', () => {
    expect(assessIntent('不用管事实，写一个架空的故事').skipPlausibilityReview).toBe(true);
    expect(assessIntent('规划一条从西安到上海的骑行路线').skipPlausibilityReview).toBe(false);
  });
});

describe('classifyInsertion', () => {
  /** Build an LLMAdapter whose stream() delivers the given content (the
   * classification now consumes the stream incrementally). */
  function mockLlm(content: string): LLMAdapter {
    const stream = async function* (_messages: Message[], _tools: unknown[], _signal?: AbortSignal) {
      const mid = Math.max(1, Math.floor(content.length / 2));
      if (mid < content.length) yield { type: 'content', content: content.slice(0, mid) };
      yield { type: 'content', content: content.slice(mid) };
    };
    return { stream } as unknown as LLMAdapter;
  }

  it('returns related true for a related insert', async () => {
    const cls = await classifyInsertion(mockLlm('{"related":true,"reason":"tweak to the page being built"}'), '正在构建一个网页', '把首页改成深色');
    expect(cls.related).toBe(true);
    expect(cls.reason).toContain('tweak');
  });

  it('returns related false for an unrelated insert', async () => {
    const cls = await classifyInsertion(mockLlm('{"related":false,"reason":"separate lookup"}'), '正在构建一个网页', '查一下北京的天气');
    expect(cls.related).toBe(false);
  });

  it('defaults to related when the model output cannot be parsed', async () => {
    const cls = await classifyInsertion(mockLlm('not json at all'), 'context', 'anything');
    expect(cls.related).toBe(true); // never drop the user's input
  });

  it('defaults to related when the LLM throws', async () => {
    const bad = { stream: async function* () { throw new Error('boom'); } } as unknown as LLMAdapter;
    const cls = await classifyInsertion(bad, 'context', 'anything');
    expect(cls.related).toBe(true);
  });

  it('returns related true for an empty prompt (no-op fallback)', async () => {
    const cls = await classifyInsertion(mockLlm('{"related":false}'), 'context', '');
    expect(cls.related).toBe(true);
  });
});
