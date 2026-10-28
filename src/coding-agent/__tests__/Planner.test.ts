// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Planner, assessIntent, detectArtifactRequest, detectFictionIntent, detectProjectRequest, formatArtifactPrompt, formatIntentPrompt, formatTrapPrompt, inferSemanticRoute, isPlainConversational, markParallelPlanSteps, classifyInsertion, resolveStopBranchTarget, recheckCoveredInsertion, parsePlanJson, parsePlanJsonWithMeta, parseSemanticRoute, shouldBypassSemanticRoute } from '../Planner';
import type { LLMAdapter, Message } from '../../shared/types';
import type { Plan } from '../types';

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

  it('flags the spoken and overwrite forms of destruction', () => {
    // 2026-09-20: these used to pass as low risk even when spelled correctly —
    // the floor only knew 删除/移除/清理/销毁/不可逆.
    for (const draft of ['帮我把 build 目录清空', '删掉这些临时文件', '把缓存删了', '把 config.json 覆盖掉', '把数据库重置一下']) {
      expect([draft, assessIntent(draft).riskLevel]).toEqual([draft, 'high']);
    }
    expect(assessIntent('删掉这些临时文件').requiresConfirmation).toBe(true);
  });

  it('reads a question about how to reset as advice, not an order to delete', () => {
    // 2026-10-14 真机案例：「本机装了一个应用叫 UNIvpn，输入用户名密码总是报错，你帮我看
    // 下如何重置」被兜底规则判成删除请求 + 高危确认卡，卡片上还写着「我判断这是一次删
    // 除请求」——问「怎么做」被读成了让人动手。
    for (const draft of [
      '本机装了一个应用叫 UNIvpn，输入用户名密码总是报错，你帮我看下如何重置',
      '如何重置 UNIvpn 的账号',
      '怎么才能清空这个目录',
      '为什么删掉这个文件这么慢',
      '如何清空这台机器的缓存',
    ]) {
      const verdict = assessIntent(draft);
      expect([draft, verdict.intent, verdict.riskLevel, verdict.requiresConfirmation])
        .toEqual([draft, 'question', 'low', false]);
    }
  });

  it('keeps an imperative or permission-seeking destruction request in the high-risk lane', () => {
    // 豁免只覆盖「问怎么做 / 问为什么」：命令式施动（把/帮我/给我 + 动作）与
    // 句末征求许可（…可以吗）仍然留在高危通道上。
    for (const draft of ['帮我把这个应用重置一下', '把缓存清掉吧', '帮我删掉这些临时文件', '给我把日志清理掉', '删除整个项目的文件，可以吗？']) {
      expect([draft, assessIntent(draft).riskLevel]).toEqual([draft, 'high']);
    }
  });

  it('keeps the benign engineering senses of those words out of the gate', () => {
    // A UI behaviour, a password-reset feature, and test coverage — each one
    // would otherwise cost a confirmation and, in the CLI, a whole turn of
    // auto-approval.
    for (const draft of ['清空输入框后再发送', '加一个重置密码的入口', '把测试覆盖率提到 90%', '补一下覆盖测试的用例']) {
      expect([draft, assessIntent(draft).riskLevel]).toEqual([draft, 'low']);
    }
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

  it('skips the LLM router only for plainly conversational low-stakes turns', () => {
    expect(isPlainConversational('今天几号，星期几，天气如何')).toBe(true);
    expect(isPlainConversational('What is the weather like today?')).toBe(true);
    expect(isPlainConversational('为什么？')).toBe(true);
    expect(isPlainConversational('现有页面很难看，我应该从哪些设计方向改善？')).toBe(true);
    // Creative imperatives classify identically under the remaining guards —
    // they must not pay the hidden router round trip either.
    expect(isPlainConversational('给我做一首诗')).toBe(true);
    expect(isPlainConversational('写个关于秋天的故事')).toBe(true);
    // Anything that could need the router still routes:
    // - an explicit multi-part build request
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

  it('routes single visual/naming assets of an app as direct creative output, not builds', () => {
    // The regression: "…应用的图标" read 应用 as the deliverable and planned a
    // full engineering project for a request that just wants one drawn icon.
    const icon = '给我生成一个桌面端应用的图标，应用是一个工作台智能体';
    expect(detectProjectRequest(icon)).toBe(false);
    // The bare icon clause is fully clean; the full sentence's trailing "应用
    // 是…" clause still trips detectArtifactRequest's noun scan, which is
    // inert there (build routing keys on analysis.mode/semantic, not this
    // detector) — the routing assertions below are the real contract.
    expect(detectArtifactRequest('给我生成一个桌面端应用的图标')).toBe(false);
    expect(new Planner().analyzeTask(icon)).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    expect(new Planner().analyzeTask('做一个应用的启动图标')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    expect(new Planner().analyzeTask('设计一个网站的logo')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    expect(new Planner().analyzeTask('设计一个应用的图标')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    expect(detectArtifactRequest('设计一个网站的logo')).toBe(false);
    expect(detectArtifactRequest('做一个应用的启动图标')).toBe(false);
    expect(detectProjectRequest('给我生成一个app icon')).toBe(false);
    expect(new Planner().analyzeTask('generate an icon for my desktop app')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    expect(new Planner().analyzeTask('生成一个应用的名字')).toMatchObject({ complexity: 'simple', mode: 'yolo' });
    // Real builds survive — including asset words heading a real construction
    // and second clauses that carry a genuine project.
    expect(new Planner().analyzeTask('做一个应用商店')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(new Planner().analyzeTask('搭建一个个人博客网站')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(new Planner().analyzeTask('开发一个应用图标管理系统')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(new Planner().analyzeTask('设计一个应用图标管理系统').complexity).toBe('complex');
    expect(detectProjectRequest('build an app icon manager')).toBe(true);
    expect(detectProjectRequest('做一个应用的图标，另外帮我开发一个管理系统')).toBe(true);
    expect(new Planner().analyzeTask('做一个应用，图标要扁平风格')).toMatchObject({ complexity: 'complex', mode: 'build' });
    expect(detectProjectRequest('写一个应用图标库网站')).toBe(true);
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

  it('carries the declared verification list (刀 1.1) with final marks intact', () => {
    const plan = parsePlanJson('{"steps":[{"action":"A","description":"d"}],"verification":[{"command":"bun run typecheck","reason":"类型是本轮风险面","final":true},{"command":"bun run test src/auth","reason":"定向测试就够"}]}');
    expect(plan?.verification).toHaveLength(2);
    expect(plan?.verification?.[0]).toEqual({ command: 'bun run typecheck', reason: '类型是本轮风险面', final: true });
    expect(plan?.verification?.[1]).toEqual({ command: 'bun run test src/auth', reason: '定向测试就够' });
  });

  it('drops broken verification items but keeps the good ones; no list means no field', () => {
    const mixed = parsePlanJson('{"steps":[{"action":"A","description":"d"}],"verification":[{"reason":"没有命令"},{"command":"  ","reason":"空白命令"},{"command":"bun run test","reason":"ok"}]}');
    expect(mixed?.verification).toEqual([{ command: 'bun run test', reason: 'ok' }]);
    // 纯数组形态无处挂清单；对象形态没声明也不占字段。
    expect(parsePlanJson('[{"action":"A","description":"d"}]')?.verification).toBeUndefined();
    expect(parsePlanJson('{"steps":[{"action":"A","description":"d"}]}')?.verification).toBeUndefined();
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

describe('classifyInsertion — 三值 verdict 契约（并线/另线）', () => {
  /** Build an LLMAdapter whose stream() delivers the given content (the
   * classification consumes the stream incrementally). */
  function mockLlm(content: string): LLMAdapter {
    const stream = async function* (_messages: Message[], _tools: unknown[], _signal?: AbortSignal) {
      const mid = Math.max(1, Math.floor(content.length / 2));
      if (mid < content.length) yield { type: 'content', content: content.slice(0, mid) };
      yield { type: 'content', content: content.slice(mid) };
    };
    return { stream } as unknown as LLMAdapter;
  }

  it('routes a status question to sideline', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"sideline","reason":"status check"}'), '正在构建一个网页', '现在跑到哪了？');
    expect(cls.verdict).toBe('sideline');
    expect(cls.reason).toContain('status');
  });

  it('routes a small tweak to inline', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"inline","reason":"constraint on current task"}'), '正在构建一个网页', '记得跑测试');
    expect(cls.verdict).toBe('inline');
  });

  it('routes an independent request to new_task', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"new_task","reason":"separate lookup"}'), '正在构建一个网页', '查一下北京的天气');
    expect(cls.verdict).toBe('new_task');
  });

  it('routes small talk to sideline', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"sideline","reason":"filler"}'), 'context', '哈哈 辛苦了');
    expect(cls.verdict).toBe('sideline');
  });

  it('routes an overturn to inline — the main line digests it', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"inline","reason":"user replaced the approach"}'), 'context', '别用方案A了，换一个思路');
    expect(cls.verdict).toBe('inline');
  });

  it('parses action:"stop" strictly — only the exact value counts', async () => {
    // 整树停命令：宿主唯一保留的机械动作。严格 === "stop" 才收，其他值一律
    // 当缺席（宿主按缺省 inline 处置，不掐流）。
    const hit = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"the user is done","confidence":0.95,"action":"stop"}'),
      'context', '停止当前任务',
    );
    expect(hit.verdict).toBe('inline');
    expect(hit.action).toBe('stop');
    const loose = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"not a command","confidence":0.9,"action":"apply"}'),
      'context', '继续加油',
    );
    expect(loose.action).toBeUndefined(); // "apply" 是缺省态，模型不必输出
  });

  it('parses the receipt: blank means absent, present means verbatim', async () => {
    // 现场收执（§〇 呈现层契约）：空串/空白视为缺席=引擎沉默；有值原样过河。
    const hit = await classifyInsertion(
      mockLlm('{"verdict":"new_task","reason":"queued errand","confidence":0.9,"receipt":"这个跑完就弄。"}'),
      'context', '顺便查一下天气',
    );
    expect(hit.receipt).toBe('这个跑完就弄。');
    const blank = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"x","confidence":0.9,"receipt":"   "}'),
      'context', '记得跑测试',
    );
    expect(blank.receipt).toBeUndefined();
    const missing = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"x","confidence":0.9}'),
      'context', '记得跑测试',
    );
    expect(missing.receipt).toBeUndefined();
  });

  it('parses the named-branch call_id through (§一 细化 2 插话点名某支)', async () => {
    // 点名某支（范围确认/转向/问及）：id 一字不差过河，宿主只核实。
    const hit = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"scope confirmation","confidence":0.9,"call_id":"call_youku"}'),
      'context', '调研必须包括优酷',
    );
    expect(hit.branchCallId).toBe('call_youku');
    // 驼峰兜底：模型自行改写键名时照样收。
    const camel = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"same","confidence":0.9,"callId":"call_a"}'),
      'context', '同样的话',
    );
    expect(camel.branchCallId).toBe('call_a');
    // 空串/缺字段宁可当没点名——宿主照旧路由，绝不拿半截 id 答话。
    for (const junk of ['{"verdict":"inline","reason":"x","call_id":"  "}', '{"verdict":"inline","reason":"x"}']) {
      const miss = await classifyInsertion(mockLlm(junk), 'context', 'x');
      expect(miss.branchCallId).toBeUndefined();
    }
  });

  it('parses the stop_branch call_id through to the classification (2026-10-10 模型点名)', async () => {
    // 模型判断、宿主执行：裁决器从 <live_branches> 花名册指认被停支的确切
    // id，宿主只按这个 id 执行——id 解析必须一字不差过河。
    const hit = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"stop the review branch","confidence":0.95,"stop_branch":{"call_id":"call_review"}}'),
      'context', '不要评审了',
    );
    expect(hit.stopBranch).toEqual({ callId: 'call_review' });
    // 驼峰兜底：模型自行改写键名时照样收。
    const camel = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"stop it","confidence":0.9,"stopBranch":{"callId":"call_a"}}'),
      'context', '停掉那一支',
    );
    expect(camel.stopBranch).toEqual({ callId: 'call_a' });
    // 残缺对象/空串/缺字段宁可当没点名——绝不拿半截 id 去停。
    for (const junk of [
      '{"verdict":"inline","reason":"x","confidence":0.9,"stop_branch":{}}',
      '{"verdict":"inline","reason":"x","confidence":0.9,"stop_branch":{"call_id":"  "}}',
      '{"verdict":"inline","reason":"x","confidence":0.9}',
    ]) {
      const miss = await classifyInsertion(mockLlm(junk), 'context', 'x');
      expect(miss.stopBranch).toBeUndefined();
    }
  });

  it('parses the resumes_branch call_id through (点名续支保留成果)', async () => {
    const hit = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"resume the named paused branch","confidence":0.95,"resumes_branch":{"call_id":"call_b"}}'),
      'context', '把竞品那支接着跑完',
    );
    expect(hit.resumesBranch).toEqual({ callId: 'call_b' });
    const camel = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"same","confidence":0.9,"resumesBranch":{"callId":"call_c"}}'),
      'context', '让报价那路继续',
    );
    expect(camel.resumesBranch).toEqual({ callId: 'call_c' });
    const miss = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"no branch named","confidence":0.9}'),
      'context', '继续',
    );
    expect(miss.resumesBranch).toBeUndefined();
  });

  it('rejects an unknown verdict and falls back to the inline passthrough', async () => {
    // 兜底=原话直投（inline），绝不猜——低置信一律并线，宁可打扰不丢话
    // （§一 细化 5）。协调器对 fallbackUsed 判定不信不猜，统一走 passthrough。
    const cls = await classifyInsertion(mockLlm('{"verdict":"banana","reason":"junk"}'), 'context', 'anything');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('rejects the nine-relation JSON — the previous contract is not silently accepted', async () => {
    // 不做兼容妥协：九类 relation 词表的回复不再是合法判定，走 fallback
    // 原话直投——绝不拿旧词表冒充三值判定。
    const cls = await classifyInsertion(mockLlm('{"relation":"supplement","reason":"old contract"}'), 'context', 'anything');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('rejects legacy seven-kind JSON — the old contract is not silently accepted', async () => {
    const cls = await classifyInsertion(mockLlm('{"kind":"task","reason":"old contract"}'), 'context', 'anything');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('falls back to the inline passthrough when the model output cannot be parsed', async () => {
    const cls = await classifyInsertion(mockLlm('not json at all'), 'context', 'anything');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('falls back to the inline passthrough when the LLM throws', async () => {
    const bad = { stream: async function* () { throw new Error('boom'); } } as unknown as LLMAdapter;
    const cls = await classifyInsertion(bad, 'context', 'anything');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('falls back for an empty prompt (no-op fallback)', async () => {
    const cls = await classifyInsertion(mockLlm('{"verdict":"sideline","reason":"x"}'), 'context', '');
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBe(true);
  });

  it('retires the atoms contract field — mixed messages are judged as one whole', async () => {
    // 混合插话不再原子拆分：原话全文会到主线模型面前，多意图由它自行消化。
    // 原语料里的 atoms 字段解析层直接无视；类型槽已随三值化退役（D 刀），
    // 解析成功的证据 = verdict 正常返回且未走 fallback。
    const cls = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"question + change, judged whole","confidence":0.9,"atoms":[{"relation":"supplement","text":"加 D"}]}'),
      'context', '顺便查下股价，另外预算改成两万',
    );
    expect(cls.verdict).toBe('inline');
    expect(cls.fallbackUsed).toBeUndefined();
  });

  it('classifies a multi-part message as ONE whole and flips by final intent (2026-09-24 案例集)', () => {
    // 学习案例集案例 5/6/7/10 固化进分类提示词：一句话多条指令按整体判、
    // 取影响最大的部分；自相矛盾按最后明确意图，不判中间态。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    expect(promptStart).toBeGreaterThan(-1);
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion', promptStart));
    expect(prompt).toContain('Judge a multi-part message as ONE whole');
    expect(prompt).toContain('LAST explicit statement');
    expect(prompt).toContain('never split it');
  });

  it('opens with the judge-first frame: timing × content-impact, never keywords (2026-09-28 用户定调)', () => {
    // 用户定调：决策不看关键词，看时机×内容×结果收益——聪明的人类同事
    // 会怎么做。提示词开篇必须立住这个框架；宿主侧没有任何字面快路径。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    expect(promptStart).toBeGreaterThan(-1);
    const opening = src.slice(promptStart, promptStart + 900);
    expect(opening).toContain('NOT by matching keywords');
    expect(opening).toContain('WHEN it arrived');
    expect(opening).toContain('the result you still owe them');
  });

  it('grounds the judgment in the three-element live context (蓝图 §5.0, 2026-10-27 用户强调)', () => {
    // 判定输入必须三要素齐备——用户上一句原话（目标原点）、当前输出脉络
    // （做到哪）、任务状态投影（依据什么条件在做）。同一句"预算改成 50 万"
    // 在用到前后着陆不同，提示词必须把三要素讲清。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const contextDoc = src.slice(src.indexOf('<current_task>', promptStart), src.indexOf('<live_branches>', promptStart));
    expect(contextDoc).toContain('用户上一句原话');
    expect(contextDoc).toContain('当前输出脉络');
    expect(contextDoc).toContain('任务状态投影');
    expect(contextDoc).toContain('<last_user_message>');
    expect(contextDoc).toContain('<output_gist>');
    expect(contextDoc).toContain('<task_state>');
    expect(contextDoc).toContain('the same words land differently before vs after the work has already used them');
  });

  it('teaches the three-verdict contract with the JSON template', () => {
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion'));
    // 三值模板与点名三形。
    expect(prompt).toContain('"verdict":"inline|sideline|new_task"');
    expect(prompt).toContain('"stop_branch":{"call_id":"<exact id from the roster, or omit>"}');
    expect(prompt).toContain('"resumes_branch":{"call_id":"<exact id from the roster, or omit>"}');
    expect(prompt).toContain('"call_id":"<exact id of the branch the remark names, or omit>"');
    // 三值各占一个定义条目。
    for (const v of ['inline', 'sideline', 'new_task']) {
      expect(prompt).toContain(`- "${v}" —`);
    }
  });

  it('teaches the confidence bias: a low number never leaves the main line (§一 细化 5)', () => {
    // 置信偏置：低置信一律 inline——宁可打扰不丢话；sideline 只在高置信走
    // （HIGH BAR）。误判不对称的账写进提示词。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion'));
    expect(prompt).toContain('宁可打扰，不丢话');
    expect(prompt).toContain('A low number never reroutes the remark');
    expect(prompt).toContain('HIGH BAR');
  });

  it('teaches the whole-run stop as action:"stop" — the host\'s one mechanical action', () => {
    // 整树停是用户的明确命令：裁决器输出 action:"stop"，宿主掐流不重排不重想。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion'));
    expect(prompt).toContain('the WHOLE tree to stop');
    expect(prompt).toContain('"action":"stop"');
    expect(prompt).toContain('the one mechanical action left to it');
    // 旧口径不得回流：宿主不再有任何字面停快路径。
    expect(src.slice(promptStart)).not.toContain("the host's literal-stop fast path");
  });

  it('teaches the receipt discipline: only where a confirmation is due, and it must sound human (§〇)', () => {
    // 呈现层契约：并线默认不出 receipt（主线的自然承接才是回应）；必须出时
    // 像人说的一句话——短、点名具体的事、零客套、不虚报已发生。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion'));
    expect(prompt).toContain('no internal jargon');
    expect(prompt).toContain('never claim it already has');
    expect(prompt).toContain('your next natural sentence on the main line is the real answer');
  });

  it('teaches the id-copy discipline for every naming field (零字面匹配的模型侧半边)', () => {
    // 停支/续支/点名三形共用一条纪律：抄 id 逐字，绝不发明或截短——点错支
    // 比不点更糟。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const promptStart = src.indexOf('const INSERTION_CLASSIFY_PROMPT');
    const prompt = src.slice(promptStart, src.indexOf('export async function classifyInsertion'));
    expect(prompt).toContain('EXACTLY from <live_branches>');
    expect(prompt).toContain('Never invent or shorten an id');
    expect(prompt).toContain('a wrong id answers about the WRONG branch');
  });

  it('parses real three-value traffic through the pipeline (sideline / new_task / inline)', async () => {
    const s = await classifyInsertion(
      mockLlm('{"verdict":"sideline","reason":"the time","confidence":0.9}'),
      'context', '现在几点了',
    );
    expect(s.verdict).toBe('sideline');
    const n = await classifyInsertion(
      mockLlm('{"verdict":"new_task","reason":"a lookup of its own","confidence":0.9}'),
      'context', '顺便查一下汇率',
    );
    expect(n.verdict).toBe('new_task');
    const i = await classifyInsertion(
      mockLlm('{"verdict":"inline","reason":"an addition inside the deliverable","confidence":0.9}'),
      'context', '背景上加几朵会动的云',
    );
    expect(i.verdict).toBe('inline');
    expect(i.fallbackUsed).toBeUndefined(); // 真裁决绝不带兜底标记
  });
});

describe('recheckCoveredInsertion — 去重撞车复核（2026-10-21 真机二连）', () => {
  function mockLlm(content: string): LLMAdapter {
    const stream = async function* (_messages: Message[], _tools: unknown[], _signal?: AbortSignal) {
      const mid = Math.max(1, Math.floor(content.length / 2));
      if (mid < content.length) yield { type: 'content', content: content.slice(0, mid) };
      yield { type: 'content', content: content.slice(mid) };
    };
    return { stream } as unknown as LLMAdapter;
  }

  // 「停掉优酷这一调研」在同一个 system 下重问仍判 task——<dedupe_conflict>
  // 块在 system 里零契约被当噪声，二次锚定原判。复核换独立窄问题提示词：
  // 举证责任倒置（谁会要求加一个正在跑的东西），输出契约收窄为
  // cancels_part / stop_branch / receipt。
  it('parses the recheck contract: snake cancels_part, stop_branch id, receipt', async () => {
    const verdict = await recheckCoveredInsertion(
      mockLlm('{"cancels_part":true,"stop_branch":{"call_id":"call_r2"},"receipt":"好——优酷那路这就停掉。","reason":"removal of the named branch","confidence":0.9}'),
      '并行调研四路平台', '它点到的活已有一支在跑：researcher·3号', '停掉优酷这一调研',
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.cancelsPart).toBe(true);
    expect(verdict?.stopBranchCallId).toBe('call_r2');
    expect(verdict?.receipt).toContain('优酷');
  });

  it('accepts the camelCase fallbacks and a bare no-verdict object', async () => {
    const remove = await recheckCoveredInsertion(
      mockLlm('{"cancelsPart":true,"reason":"no longer wanted","confidence":0.8}'),
      'context', 'conflict', '不需要优酷的了',
    );
    expect(remove?.cancelsPart).toBe(true);
    expect(remove?.stopBranchCallId).toBeUndefined();
    const keep = await recheckCoveredInsertion(
      mockLlm('{"cancels_part":false,"reason":"genuinely new work","confidence":0.7}'),
      'context', 'conflict', '再加一个爱奇艺',
    );
    expect(keep?.cancelsPart).toBe(false);
  });

  it('returns null on parse failure, empty message, or abort — caller falls back to the canned receipt', async () => {
    expect(await recheckCoveredInsertion(mockLlm('not json at all'), 'context', 'conflict', 'anything')).toBeNull();
    expect(await recheckCoveredInsertion(mockLlm('{"cancels_part":true}'), 'context', 'conflict', '  ')).toBeNull();
    expect(await recheckCoveredInsertion(mockLlm('{"cancels_part":true}'), 'context', '  ', 'anything')).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await recheckCoveredInsertion(mockLlm('{"cancels_part":true}'), 'context', 'conflict', 'anything', controller.signal)).toBeNull();
  });
});

describe('刀 4.1 缓存固化 — 判例调用 system 逐字稳定，现场全在 user', () => {
  /** mockLlm 的捕获版：记下每次收到的 messages 再回既定 JSON。 */
  function captureLlm(content: string) {
    const calls: Message[][] = [];
    const stream = async function* (messages: Message[]) {
      calls.push(messages);
      const mid = Math.max(1, Math.floor(content.length / 2));
      yield { type: 'content', content: content.slice(0, mid) };
      yield { type: 'content', content: content.slice(mid) };
    };
    return { llm: { stream } as unknown as LLMAdapter, calls };
  }

  it('classifyInsertion: system carries the whole stable template, variables only in the user turn', async () => {
    // 适配器在 system 上打 cache_control：system 里只要混进一次易变现场
    // （投影/消息），每次判例都是一次缓存写（1.25×）且永不命中。所以指令
    // 头与 JSON 契约尾必须同住一个逐字稳定的 system，投影/消息只许出现在
    // user 消息里。
    const { llm, calls } = captureLlm('{"verdict":"new_task","reason":"x","confidence":0.9}');
    await classifyInsertion(llm, '现场投影<LIVE-STATE>独一份', '用户插话<MSG-MARKER>独一份');
    expect(calls).toHaveLength(1);
    const [system, user] = calls[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('You are the agent, mid-task');
    expect(system.content).toContain('Return ONLY one JSON object');
    expect(system.content).not.toContain('<LIVE-STATE>');
    expect(system.content).not.toContain('<MSG-MARKER>');
    expect(system.content).not.toContain('{{');
    expect(user.role).toBe('user');
    expect(user.content).toContain('<current_task>\n现场投影<LIVE-STATE>独一份\n</current_task>');
    expect(user.content).toContain('<new_message>\n用户插话<MSG-MARKER>独一份\n</new_message>');
  });

  it('resolveStopBranchTarget: same discipline — stable system, roster in the user turn', async () => {
    const { llm, calls } = captureLlm('{"call_id":"call_abc"}');
    const hit = await resolveStopBranchTarget(llm, '任务投影', '停掉竞品那支', [
      { callId: 'call_abc', name: '竞品调研', role: 'researcher', snippet: '调研竞品' },
    ]);
    expect(hit).toEqual({ callId: 'call_abc' });
    const [system, user] = calls[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Return ONLY one JSON object');
    expect(system.content).not.toContain('call_abc');
    expect(system.content).not.toContain('竞品调研');
    expect(system.content).not.toContain('{{');
    expect(user.role).toBe('user');
    expect(user.content).toContain('<live_branches>');
    expect(user.content).toContain('id=call_abc name=竞品调研');
    expect(user.content).toContain('<new_message>\n停掉竞品那支\n</new_message>');
  });

  it('source lock: neither judge template keeps any {{placeholder}} in the stable block', () => {
    // 缓存锁的真身：模板里只要还留一个插值占位符，稳定块就是假的。
    const src = readFileSync(new URL('../Planner.ts', import.meta.url), 'utf8');
    const classifyPrompt = src.slice(src.indexOf('const INSERTION_CLASSIFY_PROMPT'), src.indexOf('export async function classifyInsertion'));
    expect(classifyPrompt).not.toContain('{{');
    const stopStart = src.indexOf('const STOP_TARGET_PROMPT');
    expect(stopStart).toBeGreaterThan(-1);
    const stopPrompt = src.slice(stopStart, src.indexOf('export async function resolveStopBranchTarget'));
    expect(stopPrompt).not.toContain('{{');
  });
});

describe('markParallelPlanSteps (E2.3)', () => {
  const basePlan: Plan = {
    reasoning: 'fixture',
    steps: [
      { id: '1', action: '理解与分析需求', description: '拆解目标与约束', expectedOutcome: '理解一致' },
      { id: '2', action: '调研竞品背景', description: '搜集同类产品的资料', expectedOutcome: '调研笔记' },
      { id: '3', action: '调研技术方案现状', expectedOutcome: '选型依据', description: '搜索主流做法与依赖现状' },
      { id: '4', action: '搭建项目骨架', description: '建立目录与脚本', expectedOutcome: '可运行骨架' },
    ],
  };

  it('marks the independent research steps when researcher is recommended', () => {
    const marked = markParallelPlanSteps(basePlan, ['researcher']);
    expect(marked.steps.map(s => s.parallel)).toEqual([undefined, true, true, undefined]);
    // 入参不被改写——分析结果还要以原样喂给其他流程。
    expect(basePlan.steps[1].parallel).toBeUndefined();
  });

  it('merges domains across recommended roles', () => {
    const marked = markParallelPlanSteps(basePlan, ['researcher', 'project_auditor']);
    // fixture 没有审计步骤，审计域不命中；researcher 域照常标 2、3。
    expect(marked.steps.map(s => s.parallel)).toEqual([undefined, true, true, undefined]);
  });

  it('marks nothing when no recommended role domain matches', () => {
    const marked = markParallelPlanSteps(basePlan, ['code_editor']);
    expect(marked.steps.some(s => s.parallel)).toBe(false);
  });

  it('marks nothing when fewer than two steps qualify', () => {
    const lone = {
      reasoning: 'fixture',
      steps: [
        { id: '1', action: '调研现状', description: '搜集资料', expectedOutcome: '笔记' },
        { id: '2', action: '实现功能', description: '写代码', expectedOutcome: '可用' },
      ],
    };
    expect(markParallelPlanSteps(lone, ['researcher']).steps.some(s => s.parallel)).toBe(false);
  });

  it('returns the plan untouched for an empty role list', () => {
    expect(markParallelPlanSteps(basePlan, [])).toBe(basePlan);
  });
});
