// src/ui/__tests__/planProgressBar.test.ts
// 固定进度条（planProgressBar.ts）与计划卡头计划序号（plan.ts）：
// formatPlanPin 纯函数 + createPlanProgressPin 的 DOM 挂载/绑定行为，
// 以及 createPlanCard 对「第 2 份规划」身份（序号 chip + 触发原因）的渲染。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createPlanCard } from '../plan';
import { PlanProgressModel, type PlanProgressSnapshot } from '../planProgress';
import { createPlanProgressPin, formatPlanPin } from '../planProgressBar';
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

function snapshotAt(plan: Plan, currentPlan: number, status: PlanProgressSnapshot['status'] = 'active', planSeq = 1): PlanProgressSnapshot {
  return new PlanProgressModel(plan, status, currentPlan, 1, false, planSeq).getSnapshot();
}

describe('formatPlanPin', () => {
  it('derives the active step, sequence and done-count from a snapshot', () => {
    const info = formatPlanPin(snapshotAt(samplePlan(), 2, 'active', 2));
    expect(info.seq).toBe(2);
    expect(info.state).toBe('active');
    expect(info.total).toBe(3);
    expect(info.doneCount).toBe(1); // 步骤 1 已完成，2 正在处理
    expect(info.currentStepAction).toBe('实现');
  });

  it('treats a waiting plan as waiting with the same cursor', () => {
    const info = formatPlanPin(snapshotAt(samplePlan(), 2, 'waiting'));
    expect(info.state).toBe('waiting');
    expect(info.doneCount).toBe(1);
  });

  it('marks a completed snapshot done with every step counted', () => {
    const plan = samplePlan();
    const complete = new PlanProgressModel(plan, 'complete', 3, 1).getSnapshot();
    const info = formatPlanPin(complete);
    expect(info.state).toBe('complete');
    expect(info.doneCount).toBe(3);
    expect(info.currentStepAction).toBe('');
  });

  it('defaults an unknown sequence to plan 1', () => {
    const legacy: PlanProgressSnapshot = { plan: samplePlan(), currentPlan: 1, currentTodo: 1, status: 'active' };
    expect(formatPlanPin(legacy).seq).toBe(1);
  });
});

describe('createPlanProgressPin', () => {
  it('is hidden until bound and reflects the plan after bind', () => {
    const pin = createPlanProgressPin();
    document.body.appendChild(pin.el);
    expect(pin.el.hidden).toBe(true);

    const model = new PlanProgressModel(samplePlan(), 'active', 2, 1, false, 2);
    pin.bind(model);

    expect(pin.el.hidden).toBe(false);
    const seq = pin.el.querySelector<HTMLElement>('.plan-progress-pin-seq');
    const step = pin.el.querySelector<HTMLElement>('.plan-progress-pin-step');
    expect(seq?.textContent).toContain('2');
    expect(seq?.classList.contains('is-new')).toBe(true);
    expect(step?.textContent).toContain('2');
    expect(step?.textContent).toContain('实现');
  });

  it('unbind() hides the pin and stops receiving updates', () => {
    const pin = createPlanProgressPin();
    document.body.appendChild(pin.el);
    const model = new PlanProgressModel(samplePlan(), 'active', 1, 1);
    pin.bind(model);
    pin.unbind();
    expect(pin.el.hidden).toBe(true);

    model.dispatch({ type: 'phaseStarted', planNumber: 2 });
    const step = pin.el.querySelector<HTMLElement>('.plan-progress-pin-step');
    expect(step?.textContent).toContain('1'); // 已解绑：仍停留在第 1 步
  });

  it('shows the completed state after the plan finishes', () => {
    const pin = createPlanProgressPin();
    document.body.appendChild(pin.el);
    const model = new PlanProgressModel(samplePlan(), 'active', 1, 1);
    pin.bind(model);
    model.dispatch({ type: 'completed' });

    const state = pin.el.querySelector<HTMLElement>('.plan-progress-pin-state');
    expect(state?.classList.contains('plan-progress-pin-state--complete')).toBe(true);
    const step = pin.el.querySelector<HTMLElement>('.plan-progress-pin-step');
    expect(step?.textContent).toContain('3');
  });

  it('fires the jump callback when the button is clicked', () => {
    let jumped = false;
    const pin = createPlanProgressPin({ jumpTo: () => { jumped = true; } });
    document.body.appendChild(pin.el);
    const model = new PlanProgressModel(samplePlan(), 'active', 1, 1);
    pin.bind(model);
    pin.el.querySelector<HTMLButtonElement>('.plan-progress-pin-jump')?.click();
    expect(jumped).toBe(true);
  });
});

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
