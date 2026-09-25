// src/ui/__tests__/planProgressNarration.test.ts
// 对话内进度播报（planProgress.ts）：formatPlanProgressNarration 纯函数的
// 播报/沉默判定（阶段推进、整体完成、只前进不回退、换计划不播），
// 以及计划卡头对「第 2 份规划」身份（序号 chip + 触发原因）的渲染。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createPlanCard } from '../plan';
import {
  PlanProgressModel,
  formatPlanProgressNarration,
  planProgressNarrationSeedFrom,
  type PlanProgressNarrationSeed,
  type PlanProgressSnapshot,
} from '../planProgress';
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

function seedOf(plan: Plan, currentPlan: number, status: PlanProgressSnapshot['status'] = 'active'): PlanProgressNarrationSeed {
  return planProgressNarrationSeedFrom(snapshotAt(plan, currentPlan, status));
}

describe('formatPlanProgressNarration', () => {
  it('narrates the first advance with the finished step and the running one', () => {
    const plan = samplePlan(); // 播报按对象同一性识别计划：种子与快照共用同一实例。
    const prev = seedOf(plan, 1);
    const line = formatPlanProgressNarration(prev, snapshotAt(plan, 2));
    expect(line).not.toBeNull();
    expect(line).toContain('第 1 步（准备）完成了');
    expect(line).toContain('正在跑');
    expect(line).toContain('实现');
  });

  it('narrates later advances with the done-count and the running step', () => {
    const plan = samplePlan();
    const prev = seedOf(plan, 2);
    const line = formatPlanProgressNarration(prev, snapshotAt(plan, 3));
    expect(line).not.toBeNull();
    expect(line).toContain('前 2 步都完成了');
    expect(line).toContain('验证');
  });

  it('narrates completion once and counts every step', () => {
    const plan = samplePlan();
    const prev = seedOf(plan, 3);
    const line = formatPlanProgressNarration(prev, snapshotAt(plan, 3, 'complete'));
    expect(line).toBe('全部 3 步完成了。');

    // 整体完成只播一次：完成位翻转后再次 complete 不重复播报。
    const again = formatPlanProgressNarration(seedOf(plan, 3, 'complete'), snapshotAt(plan, 3, 'complete'));
    expect(again).toBeNull();
  });

  it('stays silent on a single-step plan completion', () => {
    const single: Plan = { reasoning: 'r', steps: [{ id: '1', action: '收拾', description: '', expectedOutcome: '' }] };
    const prev = seedOf(single, 1);
    const line = formatPlanProgressNarration(prev, snapshotAt(single, 1, 'complete'));
    expect(line).toBe('计划完成了。');
  });

  it('never narrates backwards — a stalled or re-set cursor says nothing', () => {
    const plan = samplePlan();
    const prev = seedOf(plan, 3);
    expect(formatPlanProgressNarration(prev, snapshotAt(plan, 2))).toBeNull();
    expect(formatPlanProgressNarration(prev, snapshotAt(plan, 3))).toBeNull();
  });

  it('stays silent when the plan identity changes (planReplaced / new plan)', () => {
    const prev = seedOf(samplePlan(), 2);
    const refined: Plan = { reasoning: 'r2', steps: samplePlan().steps };
    // 同形状不同对象 = planReplaced：卡头自己亮相，播报不抢话。
    expect(formatPlanProgressNarration(prev, snapshotAt(refined, 2))).toBeNull();

    const fresh = samplePlan();
    // 新一轮计划从第 1 步重跑也不播——那是新计划的第一句，不是推进。
    expect(formatPlanProgressNarration(prev, snapshotAt(fresh, 1))).toBeNull();
  });

  it('seeds from a snapshot without narrating on restore (no prev, no emit)', () => {
    const snapshot = snapshotAt(samplePlan(), 2);
    const seed = planProgressNarrationSeedFrom(snapshot);
    expect(seed.currentPlan).toBe(2);
    expect(seed.complete).toBe(false);
    // 恢复旧会话时不回放历史：首帧 null 播种位直接沉默。
    expect(formatPlanProgressNarration(null, snapshot)).toBeNull();
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
