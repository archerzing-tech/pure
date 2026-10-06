// src/ui/__tests__/planCardHead.test.ts
// 计划卡头对「第 2 份规划」身份（序号 chip + 触发原因）的渲染。
// 原文件名 planProgressNarration.test.ts；host 进度播报下线后（呈现去话术
// 期 1），这里只剩卡头身份这一部分。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createPlanCard } from '../plan';
import { PlanProgressModel } from '../planProgress';
import type { Plan } from '../../coding-agent/types';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function samplePlan(): Plan {
  return {
    reasoning: 'r',
    steps: [
      { id: '1', action: '准备', description: '', expectedOutcome: '' },
      { id: '2', action: '实现', description: '', expectedOutcome: '' },
      { id: '3', action: '验证', description: '', expectedOutcome: '' },
    ],
  };
}

describe('plan card head — conversation-local plan identity', () => {
  it('renders a plain plan chip — no session number — for the first plan', () => {
    const card = createPlanCard(samplePlan(), false, new PlanProgressModel(samplePlan()));
    const seq = card.el.querySelector<HTMLElement>('.plan-progress-seq');
    expect(seq).not.toBeNull();
    // 首份计划不显示“1”：没有“计划 2”时序号只会让用户困惑（所谓“规划 1”而
    // 找不到“规划 2”）。只有出现新一轮计划时编号才有意义。
    expect(seq?.textContent).toBe('计划');
    expect(seq?.textContent).not.toContain('1');
    expect(seq?.classList.contains('is-new')).toBe(false);
    expect(card.el.querySelector('.plan-progress-reason')).toBeNull();
  });

  it('marks a second plan with an emphasised chip and the trigger reason', () => {
    const plan = samplePlan();
    const model = new PlanProgressModel(plan, 'active', 1, 1, false, 2, '我觉得整体风格不协调');
    const card = createPlanCard(plan, false, model);

    const seq = card.el.querySelector<HTMLElement>('.plan-progress-seq');
    expect(seq).not.toBeNull();
    expect(seq?.textContent).toContain('2');
    expect(seq?.classList.contains('is-new')).toBe(true);

    const reason = card.el.querySelector<HTMLElement>('.plan-progress-reason');
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain('我觉得整体风格不协调');
  });
});
