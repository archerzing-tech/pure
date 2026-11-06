import { describe, expect, it } from 'bun:test';
import { compileRequestWorkflow } from '../requestWorkflow';

// 预判层退役后（2026-11-06）：workflow 编译的全部判定源是机械事实
// （forcedMode/continuing）、形态判据（turnShape）与词表安全闸
// （assessIntent 只在毁灭性操作上抬闸）。这组测试钉住三条主线——
// 普通请求保持轻量；工程创作形态保住交付闸与落盘协议；安全闸只升不降。

describe('compileRequestWorkflow', () => {
  it('keeps an ordinary request lightweight (no probe, no build gate)', () => {
    const workflow = compileRequestWorkflow('What does this file do?', { hasTools: true });

    expect(workflow.stage).toBe('direct');
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.needsDeliveryGate).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
    expect(workflow.analysis.intent.riskLevel).toBe('low');
  });

  it('derives the reply-language directive from the raw prompt (P3 2026-11-06)', () => {
    // 判定源=用户原话（本函数是 GUI/CLI 共用的零污染单源），指令随
    // user-turn 注入件走，不再住 system 尾。
    const zh = compileRequestWorkflow('帮我看看这个崩溃怎么回事');
    expect(zh.userContext.languageDirective).toBe('用户要求用中文来思考与输出。');

    const en = compileRequestWorkflow('Please take a look at this crash stack and explain the root cause.');
    expect(en.userContext.languageDirective).toBe('The user expects reasoning and output in English.');
  });

  it('reads a declarative artifact request as build, a how-asking one as not', () => {
    // 框架改革一期纪律的退役后形态：旧病是「问怎么做」被读成「帮我建」。
    // 陈述式创作（创建×项目同现）走 build 形态是判据的预期行为；问法被
    // HOW_ASKING 排除，procedure 问题不吃交付管线。
    const build = compileRequestWorkflow('帮我创建一个项目', { hasTools: true });
    expect(build.needsDeliveryGate).toBe(true);
    expect(build.stage).toBe('plan');

    const asking = compileRequestWorkflow('怎么创建一个项目？', { hasTools: true });
    expect(asking.needsDeliveryGate).toBe(false);
    expect(asking.stage).toBe('direct');
  });

  it('keeps the delivery gate + write-to-disk protocol on an engineering-artifact brief', () => {
    const prompt = '创建一个HKT vip干扰保障agent应用，这个应用可以保障vip用户进入到保障区域后能，agent自动启动监控，保障流程。按照一个流程处理保障任务。你帮我创建一个项目原型，数据用mock';
    const workflow = compileRequestWorkflow(prompt, { hasTools: true });

    expect(workflow.stage).toBe('plan');
    expect(workflow.needsDeliveryGate).toBe(true);
    expect(workflow.needsProbe).toBe(true);
    expect(workflow.userContext.buildProtocol).toContain('Incremental build protocol');
  });

  it('excludes how-asking and single-asset requests from the build shape', () => {
    const asking = compileRequestWorkflow('怎么做一个登录页面？', { hasTools: true });
    expect(asking.needsDeliveryGate).toBe(false);

    const naming = compileRequestWorkflow('给这个项目起个名字', { hasTools: true });
    expect(naming.needsDeliveryGate).toBe(false);

    const logo = compileRequestWorkflow('给这个项目设计一个logo', { hasTools: true });
    expect(logo.needsDeliveryGate).toBe(false);
  });

  it('compiles identical output for GUI and CLI callers', () => {
    const prompt = 'Build a complete project for a team dashboard';
    const gui = compileRequestWorkflow(prompt, { hasTools: true });
    const cli = compileRequestWorkflow(prompt, { hasTools: true });

    expect(gui).toEqual(cli);
    expect(gui.stage).toBe('plan');
    expect(gui.probeRequired).toBe(true);
    expect(gui.probeAvailable).toBe(true);
    expect(gui.needsProbe).toBe(true);
    expect(gui.needsDeliveryGate).toBe(true);
    expect(gui.userContext.buildProtocol).toContain('Incremental build protocol');
  });

  it('raises a destructive request to confirmation even when the task is otherwise simple', () => {
    const workflow = compileRequestWorkflow('drop table users', { hasTools: true });

    expect(workflow.stage).toBe('confirm');
    expect(workflow.analysis.intent.requiresConfirmation).toBe(true);
    expect(workflow.probeRequired).toBe(true);
    expect(workflow.probeAvailable).toBe(true);
    expect(workflow.needsProbe).toBe(true);
  });

  it('keeps ordinary deletes off the confirmation pause (probe-and-proceed)', () => {
    // 2026-09-17 定调：确认卡只挂命令级毁灭；普通删除探查后直接做。
    const workflow = compileRequestWorkflow('删掉 src/tmp.ts 这个文件', { hasTools: true });
    expect(workflow.stage).not.toBe('confirm');
    expect(workflow.analysis.intent.requiresConfirmation).toBe(false);
    expect(workflow.needsProbe).toBe(true);
  });

  it('respects an explicit mode without changing the original prompt semantics', () => {
    const workflow = compileRequestWorkflow('Explain the current architecture', {
      forcedMode: 'plan',
      hasTools: false,
    });

    expect(workflow.analysis.mode).toBe('plan');
    expect(workflow.requiresPlanReview).toBe(true);
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
  });

  it('walks the plan pipeline for code-shaped turns even in plain-chat tooling', () => {
    const workflow = compileRequestWorkflow('这个类型不对：\n```ts\nconst a: number = "x";\n```', { hasTools: false });
    expect(workflow.requiresPlanReview).toBe(true);
    expect(workflow.stage).toBe('plan');
  });

  it('does not require a workspace probe when tools are unavailable', () => {
    const workflow = compileRequestWorkflow('Refactor the authentication module', { hasTools: false, forcedMode: 'plan' });

    expect(workflow.stage).toBe('plan');
    expect(workflow.probeAvailable).toBe(false);
    expect(workflow.needsProbe).toBe(false);
  });

  it('keeps the delivery gate on a continuing PROJECT build', () => {
    const workflow = compileRequestWorkflow('继续', {
      hasTools: true,
      continuingPlan: true,
      continuingProjectBuild: true,
    });
    expect(workflow.needsDeliveryGate).toBe(true);
    expect(workflow.requiresPlanReview).toBe(true);
  });

  it('does not force the delivery gate on a continuing ordinary complex plan', () => {
    const workflow = compileRequestWorkflow('继续', {
      hasTools: true,
      continuingPlan: true,
      continuingProjectBuild: false,
    });
    expect(workflow.needsDeliveryGate).toBe(false);
    // The continuation itself still never re-shows the plan-review card.
    expect(workflow.requiresPlanReview).toBe(true);
  });
});
