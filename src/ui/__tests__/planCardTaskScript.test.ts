// src/ui/__tests__/planCardTaskScript.test.ts
// 期 2·结构账的消费侧：计划卡步骤行从剧本账本读「这步做了什么、结果如何」。
//
// 刻意锁住一条边界：账本**只加悬停提示，不改步骤状态**。游标回答「走到哪」，
// 账本回答「做了什么」；两者混用就会出现两个同时高亮的行——那是一个真相
// 盖住另一个真相，比少显示信息严重得多。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createPlanCard, refreshPlanCardTaskScript, type PlanCardHandle } from '../plan';
import { PlanProgressModel } from '../planProgress';
import { applyTaskScriptSignals, createTaskScript, type TaskScript, type TaskScriptSignal } from '../../shared/taskScript';
import type { Plan } from '../../coding-agent/types';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function plan(): Plan {
  return {
    reasoning: '',
    steps: [
      { id: '1', action: '改 chat.ts', description: '', expectedOutcome: '功能完成', todosRequired: false },
      { id: '2', action: '跑验证', description: '', expectedOutcome: '结果可交付', todosRequired: false },
    ],
  };
}

function mount(signals: TaskScriptSignal[] = []): { card: PlanCardHandle; script: () => TaskScript | null } {
  const ledger: { current: TaskScript } = { current: createTaskScript(plan()) };
  const script = (): TaskScript | null => ledger.current;
  const model = new PlanProgressModel(plan(), 'active', 1, 1);
  const card = createPlanCard(plan(), false, model, script);
  ledger.current = applyTaskScriptSignals(ledger.current, signals);
  refreshPlanCardTaskScript(card);
  return { card, script };
}

describe('plan card reads the task script', () => {
  it('步骤行显示已记账的产出与验证结果', () => {
    const { card } = mount([
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/ui/chat.ts' },
      { kind: 'verification', command: 'bun test', ok: true },
      { kind: 'tool', toolName: 'edit_file', ok: false },
    ]);
    const title = String(card.stepEls[0]?.title ?? '');
    expect(title).toContain('进行中');
    expect(title).toContain('产出 src/ui/chat.ts');
    expect(title).toContain('验证 bun test 通过');
    expect(title).toContain('失败 edit_file');
  });

  it('未记账的步骤没有提示（空清单不冒充「一切顺利」）', () => {
    const { card } = mount([{ kind: 'tool', toolName: 'write_file', ok: true, artifact: 'a.ts' }]);
    expect(card.stepEls[0]?.title).toBeTruthy();
    expect(String(card.stepEls[1]?.title ?? '')).toBe('');
  });

  it('只标了完成、没任何活动的步也有提示（能分出显式与兜底）', () => {
    const { card } = mount([{ kind: 'control', marker: 'phaseDone', phase: 1 }]);
    expect(String(card.stepEls[0]?.title ?? '')).toBe('已完成 · 模型标记完成');
  });

  it('账本不改步骤状态：done/active 仍由游标决定', () => {
    const { card } = mount([
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'a.ts' },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
    ]);
    // 游标还在第 1 步（未推进），账本说第 1 步已完成——但高亮必须仍是游标说了算。
    expect(card.stepEls[0]?.classList.contains('active')).toBe(true);
    expect(card.stepEls[0]?.classList.contains('done')).toBe(false);
    expect(String(card.stepEls[0]?.title ?? '')).toContain('已完成');
  });

  it('账变后刷新即生效（工具结果不改游标，提示不能因此过期）', () => {
    const ledger = { current: createTaskScript(plan()) };
    const model = new PlanProgressModel(plan(), 'active', 1, 1);
    const card = createPlanCard(plan(), false, model, () => ledger.current);
    expect(String(card.stepEls[0]?.title ?? '')).toBe('');
    ledger.current = applyTaskScriptSignals(ledger.current, [{ kind: 'tool', toolName: 'write_file', ok: true, artifact: 'x.ts' }]);
    refreshPlanCardTaskScript(card);
    expect(String(card.stepEls[0]?.title ?? '')).toContain('x.ts');
  });

  it('无剧本来源（重载恢复的旧卡片）不报错、也不加提示', () => {
    const model = new PlanProgressModel(plan(), 'active', 1, 1);
    const card = createPlanCard(plan(), false, model);
    expect(String(card.stepEls[0]?.title ?? '')).toBe('');
    refreshPlanCardTaskScript(card);
    expect(card.stepEls[0]?.classList.contains('active')).toBe(true);
  });
});
