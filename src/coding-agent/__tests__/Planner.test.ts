// src/coding-agent/__tests__/Planner.test.ts
// Covers the complexity classification that drives the PlanReview pre-flight
// and the logical-trap detection that primes premise verification.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Planner, assessIntent, formatArtifactPrompt, formatIntentPrompt, inferSemanticRoute, markParallelPlanSteps, classifyInsertion, resolveStopBranchTarget, recheckCoveredInsertion, parsePlanJson, parsePlanJsonWithMeta, parseSemanticRoute, parseSemanticRouteEarly } from '../Planner';
import { resetRouterWaitBudgetForTests, routerTimeoutMs } from '../routerWaitBudget';
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

  it('routes task-level destructive words to probe-and-proceed, not a confirmation pause', () => {
    // 2026-11-01 用户判例 + 2026-09-17 定调落死：任务级破坏词（删除/清理/清空/
    // 重置…）不再弹确认卡——指令本身就是授权，探针保留、动手照常。真机动因：
    // 「能清理夏普电视吗」被「清理」二字拉进高危通道暂停整轮。
    const assessment = assessIntent('删除整个项目');
    expect(assessment.intent).toBe('delete');
    expect(assessment.riskLevel).toBe('medium');
    expect(assessment.reversibility).toBe('hard-to-reverse');
    expect(assessment.requiresProbe).toBe(true);
    expect(assessment.requiresConfirmation).toBe(false);
    // 兜底（路由缺席）不再造计划/抬形态：探查纪律由 workShapedFallback 的
    // probeRequired 承载，analyzeTask 只过破坏词安全网。
    const result = new Planner().analyzeTask('删除整个项目');
    expect(result.mode).toBe('yolo');
    expect(result.plan).toBeUndefined();
    expect(result.intent.requiresProbe).toBe(true);
    // 真机原案：一句带 URL 的清理请求，不再暂停等待。
    const sharp = assessIntent('https://github.com/Gathin23/cleanyourtv 能清理夏普电视吗');
    expect([sharp.riskLevel, sharp.requiresConfirmation]).toEqual(['medium', false]);
    expect(sharp.requiresProbe).toBe(true);
  });

  it('reserves the confirmation card for system-scale destruction only', () => {
    // 「非常危险除外」的边界：命令级/库级毁灭形态（rm -rf / drop database /
    // 删库 / force push / reset --hard）保留高危确认；口语破坏词一律探查通道。
    for (const draft of ['用 rm -rf 清掉整个目录', '直接 drop database', '帮我删库', 'force push 到 main', 'git reset --hard 回退所有提交']) {
      const verdict = assessIntent(draft);
      expect([draft, verdict.riskLevel, verdict.requiresConfirmation]).toEqual([draft, 'high', true]);
    }
  });

  it('flags the spoken and overwrite forms of destruction on the probe lane', () => {
    // 2026-09-20: these used to pass as low risk even when spelled correctly —
    // the floor only knew 删除/移除/清理/销毁/不可逆. 2026-11-01 起识别后不再
    // 拦停：medium + probe + 自动动手（确认卡只留给操作级毁灭）。
    for (const draft of ['帮我把 build 目录清空', '删掉这些临时文件', '把缓存删了', '把 config.json 覆盖掉', '把数据库重置一下']) {
      const verdict = assessIntent(draft);
      expect([draft, verdict.riskLevel]).toEqual([draft, 'medium']);
      expect(verdict.requiresProbe).toBe(true);
      expect(verdict.requiresConfirmation).toBe(false);
    }
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
        .toEqual([draft, 'modify', 'low', false]);
    }
  });

  it('keeps imperative destruction on the probe lane; only command-scale stays high', () => {
    // 问「怎么做」豁免不动；命令式施动（把/帮我/给我 + 动作）2026-11-01 起
    // 走探查通道自动执行（medium、不确认），句末征求许可（…可以吗）同通道——
    // 确认卡只留给上一条用例里的操作级毁灭形态。
    for (const draft of ['帮我把这个应用重置一下', '把缓存清掉吧', '帮我删掉这些临时文件', '给我把日志清理掉', '删除整个项目的文件，可以吗？']) {
      const verdict = assessIntent(draft);
      expect([draft, verdict.riskLevel, verdict.requiresConfirmation]).toEqual([draft, 'medium', false]);
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

  it('no longer lifts risk from change verbs — shape belongs to the router', () => {
    // 框架改革一期：宿主不再凭「重构/迁移」这类动词表抬风险——波及面判断是
    // 语义路由的事。兜底只认破坏词；普通改动一律 low + 直推。
    const assessment = assessIntent('把认证模块重构成新的实现');
    expect(assessment.intent).toBe('modify');
    expect(assessment.riskLevel).toBe('low');
    expect(assessment.requiresProbe).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it('does not infer ordinary creation intent from artifact words', () => {
    const assessment = assessIntent('帮我写一个打地鼠小游戏');
    expect(assessment.intent).toBe('modify');
    expect(assessment.riskLevel).toBe('low');
    expect(assessment.requiresProbe).toBe(false);
    expect(assessment.requiresConfirmation).toBe(false);
  });

  it('formats the assessment as an execution contract per lane', () => {
    const confirmed = formatIntentPrompt(assessIntent('用 rm -rf 清掉整个目录'));
    expect(confirmed).toContain('<intent_assessment>');
    expect(confirmed).toContain('Do not broaden the change');
    expect(confirmed).toContain('wait for explicit user approval');
    // 探查级（任务级删除）不带 approval 字样，契约改为探查后直接动手。
    const probe = formatIntentPrompt(assessIntent('删除整个项目'));
    expect(probe).toContain('Proceed without pausing for approval');
    expect(probe).not.toContain('wait for explicit user approval');
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

  it('parses the early verdict once the nine gate fields are on the wire', () => {
    // 2026-11-05 判定前移：prompt 把枚举门禁钉在散文前——到 requiresConfirmation
    // 为止，workflow 编译的全部输入都在场，散文没到也必须能判。缺一个门禁
    // 字段（requiresConfirmation 还在路上）就绝不判：安全语义不靠猜。
    const partial = '{"intent":"modify","complexity":"simple","mode":"yolo","requiresPlan":false,"needsDeliveryGate":false,"assessment":{"riskLevel":"low","reversibility":"reversible","requiresProbe":false,"requiresConfirmation":false';
    const route = parseSemanticRouteEarly(partial);
    expect(route).toMatchObject({ intent: 'modify', complexity: 'simple', mode: 'yolo', requiresPlan: false, needsDeliveryGate: false });
    expect(route?.assessment.requiresConfirmation).toBe(false);
    expect(route?.assessment.requiresProbe).toBe(false);
    // 散文占位空串：下游 assessmentFlow 直接 .trim()，undefined 会炸。
    expect(route?.assessment.impact).toBe('');
    expect(route?.assessment.recommendation).toBe('');
    expect(parseSemanticRouteEarly('{"intent":"modify","complexity":"simple","mode":"yolo","requiresPlan":false,"needsDeliveryGate":false,"assessment":{"riskLevel":"low","reversibility":"reversible","requiresProbe":false')).toBeNull();
    expect(parseSemanticRouteEarly('{"intent":"question","complexity":"simple"')).toBeNull();
    expect(parseSemanticRouteEarly('plain prose, no JSON yet')).toBeNull();
  });

  it('returns the early verdict immediately and merges the trailing prose into the same object', async () => {
    const head = '{"intent":"question","complexity":"simple","mode":"yolo","requiresPlan":false,"needsDeliveryGate":false,"assessment":{"riskLevel":"low","reversibility":"reversible","requiresProbe":false,"requiresConfirmation":false';
    const tail = ',"impact":"design feedback","recommendation":"explain options"},"subagents":[],"confidence":0.8}';
    let releaseTail: () => void = () => {};
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    const llm = {
      complete: async () => ({ content: '' }),
      async *stream() {
        yield { type: 'content', content: head };
        // 判定（head）此刻已可交付；散文（tail）是流尾——主消费方不等它。
        await tailGate;
        yield { type: 'content', content: tail };
      },
    } as unknown as LLMAdapter;
    const route = await inferSemanticRoute(llm, '这句话什么意思？');
    expect(route?.intent).toBe('question');
    expect(route?.assessment.impact).toBe('');  // 返回时散文还在路上
    releaseTail();
    await new Promise((resolve) => setTimeout(resolve, 0));  // 让后台 drain 跑完
    // 同一对象原位补全：先拿到引用的消费方（评估卡/风险条）读得到散文。
    expect(route?.assessment.impact).toBe('design feedback');
    expect(route?.assessment.recommendation).toBe('explain options');
    expect(route?.subagents).toEqual([]);
    expect(route?.confidence).toBe(0.8);
  });

  it('returns null immediately when the caller aborts mid-route', async () => {
    const llm = {
      complete: async () => ({ content: '' }),
      async *stream() {
        yield { type: 'content', content: '{"intent":"question"' };
        await new Promise<void>(() => {});  // 流停在这里，永不推进
      },
    } as unknown as LLMAdapter;
    const controller = new AbortController();
    const pending = inferSemanticRoute(llm, '你好', controller.signal, undefined, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const startedAt = Date.now();
    expect(await pending).toBeNull();
    // 停轮即刻放手：不吞 10s 超时线的白等。
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('router outcomes feed the adaptive wait budget (timeout streak shrinks, verdicts recover)', async () => {
    // 2026-11-06 接线锁：inferSemanticRoute 出口把每笔往返记账进
    // routerWaitBudget——两笔连续落空降线、两笔判定回基线，都在返回值之外的
    // 模块状态里，没有这条锁接线断了也是静默的。
    resetRouterWaitBudgetForTests();
    const json = JSON.stringify({
      intent: 'question', complexity: 'simple', mode: 'yolo', requiresPlan: false, needsDeliveryGate: false,
      assessment: { riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '', requiresProbe: false, requiresConfirmation: false },
    });
    const hanging = {
      complete: async () => ({ content: '' }),
      async *stream() { await new Promise<void>(() => {}); },  // 判定永不落地
    } as unknown as LLMAdapter;
    const verdict = {
      complete: async () => ({ content: '' }),
      async *stream() { yield { type: 'content', content: json }; },
    } as unknown as LLMAdapter;
    expect(await inferSemanticRoute(hanging, '你好', undefined, undefined, 30)).toBeNull();
    expect(routerTimeoutMs()).toBe(3_000);  // 一笔落空是偶发，不动线
    expect(await inferSemanticRoute(hanging, '你好', undefined, undefined, 30)).toBeNull();
    expect(routerTimeoutMs()).toBe(2_200);  // 连续两笔落空 → 降线
    expect(await inferSemanticRoute(verdict, '你好')).not.toBeNull();
    expect(routerTimeoutMs()).toBe(2_200);  // 一笔快成功不够回升
    expect(await inferSemanticRoute(verdict, '你好')).not.toBeNull();
    expect(routerTimeoutMs()).toBe(3_000);  // 连续两笔判定 → 回基线
    resetRouterWaitBudgetForTests();
  });

  it('a caller abort is not a router failure — the wait budget ignores it', async () => {
    // 用户停轮是人手掐的，不是端点慢：这一笔不进 streak，否则停一次轮就
    // 白降一次线。挂在基线状态上验证（降到 2.2s 后 abort 恰好无观测差异）。
    resetRouterWaitBudgetForTests();
    const hanging = {
      complete: async () => ({ content: '' }),
      async *stream() { await new Promise<void>(() => {}); },
    } as unknown as LLMAdapter;
    const controller = new AbortController();
    const pending = inferSemanticRoute(hanging, '你好', controller.signal, undefined, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await pending).toBeNull();
    expect(routerTimeoutMs()).toBe(3_000);  // streak 没被动过
    resetRouterWaitBudgetForTests();
  });

  it('the fallback never invents a plan or mode from keywords', () => {
    // 框架改革一期：兜底（路由缺席）一律普通任务直推——复杂度/构建形态是
    // 语义路由的裁决，宿主不再从词表猜。
    for (const prompt of ['Please plan how to refactor the auth module.', '重构整个项目', '帮我创建一个博客网站', 'Implement a new feature across multiple files in the project.']) {
      const r = new Planner().analyzeTask(prompt);
      expect([prompt, r.complexity, r.mode, r.plan]).toEqual([prompt, 'simple', 'yolo', undefined]);
    }
  });

  it('generatePlan yields the two-step skeleton, not a methodology template', () => {
    // 计划卡占位骨架：真实拆解由主模型出，宿主不再教「理解→搭骨架→测试→收尾」。
    const plan = new Planner().generatePlan('whatever', 'build');
    expect(plan.steps).toHaveLength(2);
    const all = plan.steps.map((st) => `${st.action} ${st.description}`).join(' ');
    expect(all).not.toContain('理解与分析需求');
    expect(all).not.toContain('确定技术栈与测试策略');
    expect(plan.steps.every((step) => step.todosRequired !== true)).toBe(true);
    expect(new Planner().generatePlan('whatever', 'yolo').steps).toHaveLength(2);
  });

  it('keeps the build-protocol prompt instructive for real build requests', () => {
    const prompt = formatArtifactPrompt();
    expect(prompt).toContain('choose the project-appropriate test runner');
    expect(prompt).toContain('at least one focused smoke/unit/integration test');
    expect(prompt).toContain('happy-dom');
    expect(prompt).toContain('run the actual test command');
    expect(prompt).toContain('Do not replace automated tests with manual inspection');
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
