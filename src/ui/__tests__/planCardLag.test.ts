// src/ui/__tests__/planCardLag.test.ts
// 期 3a 前置 1「对照回放」的回归锁：把 scripts/verify-plan-card-lag.ts 量到的
// 结论钉死，防止机制悄悄变了而设计稿 10.4 还写着旧数字。
//
// 量的是**机制层**滞后——真解析器、真游标状态机、真回合末兜底门槛。
// 不驱动 chat.ts 事件循环（那需要真实引擎），所以量不到「某会话肉眼所见」。

import { describe, expect, it } from 'bun:test';
import { matchPlanProgressMarkers } from '../plan';
import { PlanProgressModel, shouldAdvancePlanAtTurnEnd } from '../planProgress';
import { applyTaskScriptSignals, createTaskScript, deriveTaskScript, type TaskScriptSignal } from '../../shared/taskScript';
import type { Plan } from '../../coding-agent/types';

const STAGES = 3;

function samplePlan(): Plan {
  return {
    reasoning: '对照回放',
    steps: Array.from({ length: STAGES }, (_, i) => ({
      id: `s${i + 1}`,
      action: `阶段 ${i + 1}`,
      description: 'd',
      expectedOutcome: 'e',
      substeps: [],
    })),
  };
}

/** 三个阶段在同一回合内一次做完：真工具工作 + 可选的控制行。 */
function runOneTurn(emitMarkers: boolean): { cardStep: number; ledgerDone: number } {
  const plan = samplePlan();
  const model = new PlanProgressModel(plan, 'active', 1, 1);
  const signals: TaskScriptSignal[] = [];
  for (let s = 1; s <= STAGES; s += 1) {
    signals.push({ kind: 'control', marker: 'phaseStart', phase: s });
    signals.push({ kind: 'tool', toolName: 'write_file', ok: true, artifact: `src/step-${s}.ts` });
    signals.push({ kind: 'verification', command: `bun test (step ${s})`, ok: true });
    signals.push({ kind: 'control', marker: 'phaseDone', phase: s });
  }
  signals.push({ kind: 'turnEnd' });
  const script = applyTaskScriptSignals(createTaskScript(plan), signals);

  if (emitMarkers) {
    const text = Array.from({ length: STAGES }, (_, i) => `## 计划 ${i + 1}：开工\n## 计划 ${i + 1} 已完成`).join('\n');
    for (const marker of matchPlanProgressMarkers(text)) {
      if (marker.kind === 'phase') model.dispatch({ type: 'phaseStarted', planNumber: marker.number });
      else if (marker.kind === 'phaseDone') {
        model.dispatch({ type: 'todosCompleted' });
        model.dispatch({ type: 'phaseStarted', planNumber: marker.number + 1 });
      }
    }
  }
  const snapshot = model.getSnapshot();
  if (shouldAdvancePlanAtTurnEnd(true, snapshot, null)) {
    model.dispatch({ type: 'phaseStarted', planNumber: snapshot.currentPlan + 1 });
  }
  return {
    cardStep: model.getSnapshot().currentPlan,
    ledgerDone: deriveTaskScript(script).steps.filter((s) => s.status === 'done').length,
  };
}

describe('期 3a 对照回放 · 卡片滞后实测', () => {
  it('发控制行时卡片首回合末就对齐（滞后 0 格）', () => {
    expect(runOneTurn(true)).toEqual({ cardStep: STAGES + 1, ledgerDone: STAGES });
  });

  it('不发控制行时首回合末卡片滞后 2 格（设计稿 10.4 的实测数字）', () => {
    const { cardStep, ledgerDone } = runOneTurn(false);
    expect(cardStep).toBe(2);
    expect(STAGES - (cardStep - 1)).toBe(2);
    expect(ledgerDone).toBe(STAGES);
  });

  it('关键：账本在两种情形下都认定三阶段全完成——「做了什么」不依赖标记', () => {
    expect(runOneTurn(true).ledgerDone).toBe(runOneTurn(false).ledgerDone);
    expect(runOneTurn(false).ledgerDone).toBe(STAGES);
  });

  it('关键：回合末兜底一回合只推进一格（不跳格，否则会跳过整段）', () => {
    const plan = samplePlan();
    const model = new PlanProgressModel(plan, 'active', 1, 1);
    const snapshot = model.getSnapshot();
    expect(shouldAdvancePlanAtTurnEnd(true, snapshot, null)).toBe(true);
    model.dispatch({ type: 'phaseStarted', planNumber: snapshot.currentPlan + 1 });
    expect(model.getSnapshot().currentPlan).toBe(2);
    // 第二回合末才到第 3 阶段——放开标记后游标就是这么一格一格爬的。
    const second = model.getSnapshot();
    expect(shouldAdvancePlanAtTurnEnd(true, second, null)).toBe(true);
    model.dispatch({ type: 'phaseStarted', planNumber: second.currentPlan + 1 });
    expect(model.getSnapshot().currentPlan).toBe(3);
  });

  it('游标不得越过后一阶段：一次推进不跨格', () => {
    const plan = samplePlan();
    const model = new PlanProgressModel(plan, 'active', 1, 1);
    model.dispatch({ type: 'phaseStarted', planNumber: 3 });
    expect(model.getSnapshot().currentPlan).toBe(1);
  });
});
