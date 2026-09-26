// src/ui/__tests__/planNarration.test.ts
// 「计划必须是当着用户想出来的」（2026-09-26 用户定调）的纯函数面：
// 提示词不许带提纲（一旦带提纲，思考又被掰回固定模式）、叙述与计划围栏
// 的分流、流式期绝不闪现计划 JSON、无卡时把思考当执行指引。

import { describe, expect, it } from 'bun:test';
import { buildPlanThinkingPrompt, isUsablePlan, liveNarrationPortion, planThinkingContext, splitNarrationAndPlan } from '../planNarration';

describe('buildPlanThinkingPrompt — 不给提纲，只给实质约束', () => {
  it('要求用户语言、假设明说、不许复述请求与套话', () => {
    const { system } = buildPlanThinkingPrompt('构建一个 HVC 保障项目');
    expect(system).toContain("user's language");
    expect(system).toContain('state the assumption and proceed');
    expect(system).toContain('never repeat the request back verbatim');
    expect(system).toContain('never open with ritual phrases');
  });

  it('不规定思考的形状：没有提纲、段数、顺序要求', () => {
    const { system } = buildPlanThinkingPrompt('随便什么任务');
    // 一旦出现「先讲 X 再讲 Y」的提纲，思考就又回到固定模式。
    expect(system).not.toMatch(/first (state|describe|explain)/i);
    expect(system).not.toMatch(/Part 1|Part 2|in the first paragraph|then describe|then explain/i);
    expect(system).toContain('no required outline');
  });

  it('计划 JSON 是唯一的结构要求，且步骤必须被思考挣出来', () => {
    const { system } = buildPlanThinkingPrompt('任务');
    expect(system).toContain('```json');
    expect(system).toContain('"steps"');
    expect(system).toContain('earned by your thinking');
    expect(system).toContain('never generic filler');
  });

  it('项目级构建：最后一步必须是交付验证管线', () => {
    const { system } = buildPlanThinkingPrompt('做个项目', { projectBuild: true });
    expect(system).toContain('delivery verification pipeline');
    expect(system).toContain('typecheck');
  });

  it('用户消息原样透传，带图时提示模型把图算进去', () => {
    const plain = buildPlanThinkingPrompt('帮我做 X');
    expect(plain.user).toBe('帮我做 X');
    const withImg = buildPlanThinkingPrompt('帮我做 X', { hasImages: true });
    expect(withImg.user).toContain('帮我做 X');
    expect(withImg.user).toContain('Images are attached');
  });
});

describe('splitNarrationAndPlan — 思考在前，计划围栏认最后一次', () => {
  it('标准形态：叙述 + ```json 围栏', () => {
    const full = '这个任务的关键是场馆围栏与 VIP 识别两条线。先做原型再谈部署。\n\n```json\n{"reasoning":"r","steps":[{"id":"1","action":"搭骨架","description":"d","expectedOutcome":"o"}]}\n```';
    const { narration, planText } = splitNarrationAndPlan(full);
    expect(narration).toContain('场馆围栏');
    expect(narration).not.toContain('```');
    expect(planText).toContain('"steps"');
  });

  it('叙述里出现过代码示例时不被截断：认最后一次围栏', () => {
    const full = '目录长这样：\n```shell\nls -la\n```\n所以骨架一步就够。\n```json\n{"steps":[]}\n```';
    const { narration, planText } = splitNarrationAndPlan(full);
    expect(narration).toContain('骨架一步就够');
    expect(planText).toContain('{"steps":[]}');
  });

  it('只有开栏没闭合：取开栏之后全部，交修复通道碰运气', () => {
    const full = '想清楚了。\n```json\n{"steps":[{"action":"a"';
    const { narration, planText } = splitNarrationAndPlan(full);
    expect(narration).toBe('想清楚了。\n');
    expect(planText).toContain('"steps"');
  });

  it('没有围栏：全部算叙述，计划为空', () => {
    const { narration, planText } = splitNarrationAndPlan('就是想不出靠谱的分步。');
    expect(narration).toContain('想不出');
    expect(planText).toBe('');
  });
});

describe('liveNarrationPortion — 流式期计划 JSON 绝不当着用户闪现', () => {
  it('计划围栏一开就截住', () => {
    expect(liveNarrationPortion('思考中……\n```json\n{"ste')).toBe('思考中……\n');
  });

  it('叙述里先出现代码示例：流式期先隐后半段，收尾由完整叙述接上', () => {
    expect(liveNarrationPortion('目录：\n```shell\nls\n```\n继续')).toBe('目录：\n');
    expect(liveNarrationPortion('还没有围栏的思考')).toBe('还没有围栏的思考');
  });
});

describe('planThinkingContext — 思考原文必须嵌进引擎语境', () => {
  it('原文嵌入（新会话首回合引擎读不到转录，「按上面那段思考」是指向空气的）', () => {
    const g = planThinkingContext('关键约束：场馆围栏与 VIP 识别。', {});
    expect(g).toContain('<plan_thinking>');
    expect(g).toContain('关键约束：场馆围栏与 VIP 识别。');
    expect(g).toContain('绝不要再复述一遍');
    expect(g).toContain('不要另起炉灶');
  });

  it('无卡口径：不发阶段标记；有卡口径不带这句', () => {
    expect(planThinkingContext('思考', {})).toContain('不要输出「## 计划 n：…」');
    expect(planThinkingContext('思考', { hasPlanCard: true })).not.toContain('不要输出「## 计划 n：…」');
  });

  it('项目级交付仍要真实验证证据', () => {
    expect(planThinkingContext('思考', { projectBuild: true })).toContain('真实验证证据');
  });
});

describe('isUsablePlan — 解析结果必须真能当计划用', () => {
  it('有步骤且每步可读：可用', () => {
    expect(isUsablePlan({ reasoning: 'r', steps: [{ id: '1', action: '搭骨架', description: 'd', expectedOutcome: 'o' }] })).toBe(true);
    expect(isUsablePlan({ reasoning: 'r', steps: [{ id: '1', action: '', description: '只有描述也算可读', expectedOutcome: '' }] })).toBe(true);
  });

  it('空步、空步骤数组、null：不可用', () => {
    expect(isUsablePlan({ reasoning: 'r', steps: [] })).toBe(false);
    expect(isUsablePlan({ reasoning: 'r', steps: [{ id: '1', action: '  ', description: '', expectedOutcome: '' }] })).toBe(false);
    expect(isUsablePlan(null)).toBe(false);
    expect(isUsablePlan(undefined)).toBe(false);
  });
});
