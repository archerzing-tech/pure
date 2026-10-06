// scripts/verify-plan-card-lag.ts
// 期 3a 前置 1「对照回放」：把「控制行从必须发降为发了更准」的代价量出来，
// 而不是靠评审拍脑袋。同一份多步工作跑两遍——一遍模型发控制行、一遍不发——
// 用**生产代码本身**跑：matchPlanProgressMarkers（真解析器）、PlanProgressModel
// （真游标状态机）、shouldAdvancePlanAtTurnEnd（真回合末兜底门槛）、
// TaskScript（期 2 的事实账）。跑完打印两份游标轨迹与滞后格数。
//
// 诚实边界：这个夹具量的是**机制层**的滞后——解析、游标推进、回合末兜底、
// 账本推导都走真代码。它**不驱动 chat.ts 的事件循环**（那需要真实引擎与
// LLM），所以量到的是「机制会滞后多少格」，不是「某个会话肉眼看到什么」。
//
// 用法：bun run scripts/verify-plan-card-lag.ts

import { matchPlanProgressMarkers, type PlanProgressMarker } from '../src/ui/plan';
import { PlanProgressModel, shouldAdvancePlanAtTurnEnd, type PlanProgressSnapshot } from '../src/ui/planProgress';
import { applyTaskScriptSignals, createTaskScript, deriveTaskScript, type TaskScriptSignal } from '../src/shared/taskScript';
import type { Plan } from '../src/coding-agent/types';

const STAGES = 3;

function samplePlan(): Plan {
  return {
    reasoning: '对照回放用的三阶段计划',
    steps: Array.from({ length: STAGES }, (_, i) => ({
      id: `s${i + 1}`,
      action: `阶段 ${i + 1}`,
      description: `把第 ${i + 1} 阶段的活干完`,
      expectedOutcome: `第 ${i + 1} 阶段的结果可交付`,
      // 无子步骤 ⇒ canCompleteCurrentTodos() 为真，回合末兜底不被 Todo 挡。
      substeps: [],
    })),
  };
}

interface TurnReport {
  /** 该回合结束时卡片高亮的阶段（total+1 = 全部完成）。 */
  cardStep: number;
  /** 该回合结束时账本认定已完成的阶段数。 */
  ledgerDone: number;
  /** 该回合结束时账本认定在跑的阶段（0 = 无）。 */
  ledgerActive: number;
}

interface ScenarioResult {
  label: string;
  turns: TurnReport[];
  /** 收尾时「真实完成阶段数 - 卡片显示阶段数」的格数。 */
  lagAtFirstTurn: number;
  /** 游标走到最后一个阶段所需的回合末数量（仅回合计，不含计划级收尾——见下方说明）。 */
  turnEndsToLastStage: number;
}

/** 把一段模型输出里的控制行喂给真游标状态机（复刻 chat.ts trackPlanPhase 的动作）。 */
function applyMarkerText(model: PlanProgressModel, text: string): void {
  for (const marker of matchPlanProgressMarkers(text) as PlanProgressMarker[]) {
    if (marker.kind === 'phase') model.dispatch({ type: 'phaseStarted', planNumber: marker.number });
    else if (marker.kind === 'phaseDone') {
      model.dispatch({ type: 'todosCompleted' });
      model.dispatch({ type: 'phaseStarted', planNumber: marker.number + 1 });
    }
  }
}

/**
 * 跑一个场景：一个回合内把 STAGES 个阶段全做完（真工具工作 = 每阶段若干次
 * 工具调用），看回合末兜底把游标推到哪里。turnsToFinish 是把同一份工作按
 * 「一回合一阶段」铺开时，收尾需要几个回合。
 */
function runScenario(label: string, emitMarkers: boolean): ScenarioResult {
  const plan = samplePlan();
  const model = new PlanProgressModel(plan, 'active', 1, 1);
  const turns: TurnReport[] = [];

  // 每阶段真实干活的工具信号（账本据此自证进度；游标不据此推进）。
  const workSignals = (from: number, to: number): TaskScriptSignal[] => {
    const out: TaskScriptSignal[] = [];
    for (let s = from; s < to; s += 1) {
      out.push({ kind: 'control', marker: 'phaseStart', phase: s + 1 });
      out.push({ kind: 'tool', toolName: 'write_file', ok: true, artifact: `src/step-${s + 1}.ts` });
      out.push({ kind: 'verification', command: `bun test (step ${s + 1})`, ok: true });
      out.push({ kind: 'control', marker: 'phaseDone', phase: s + 1 });
    }
    return out;
  };

  // 回合 1：模型一口气把三个阶段全做掉。
  let script = createTaskScript(plan);
  script = applyTaskScriptSignals(script, workSignals(0, STAGES));
  if (emitMarkers) {
    applyMarkerText(model, Array.from({ length: STAGES }, (_, i) => `## 计划 ${i + 1}：开工\n## 计划 ${i + 1} 已完成`).join('\n'));
  }
  script = applyTaskScriptSignals(script, [{ kind: 'turnEnd' }]);
  // 回合末兜底（chat.ts 的 canAdvancePlan 分支）：一回合一阶段，至多推进一格。
  const snapshot = model.getSnapshot();
  if (shouldAdvancePlanAtTurnEnd(true, snapshot, null)) {
    model.dispatch({ type: 'phaseStarted', planNumber: snapshot.currentPlan + 1 });
  }
  const derived = deriveTaskScript(script);
  turns.push({
    cardStep: model.getSnapshot().currentPlan,
    ledgerDone: derived.steps.filter((s) => s.status === 'done').length,
    ledgerActive: derived.steps.filter((s) => s.status === 'active').length,
  });

  // 后续回合：每回合末兜底推一格，直到游标走到最后一个阶段为止。
  // 刻意**不**在这里报「收尾需几个回合」：计划级收尾走的是 chat.ts 的完成候选
  // 判定（legacyPlanFinished / protocolPlanFinished / toolFinishedLastPlan /
  // deliveryCompletedPlan …最后 dispatch completed），那套判定带门禁证据门槛，
  // 本夹具没有建模它。拿没建模的路径报一个「21 回合」是拿夹具的缺陷冒充结论。
  let turnEndsToLastStage = 1;
  let guard = 0;
  while (model.getSnapshot().currentPlan < STAGES && guard < 10) {
    guard += 1;
    const current = model.getSnapshot();
    script = applyTaskScriptSignals(script, [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: `src/step-${current.currentPlan}.ts` },
      { kind: 'turnEnd' },
    ]);
    if (shouldAdvancePlanAtTurnEnd(true, model.getSnapshot(), null)) {
      model.dispatch({ type: 'phaseStarted', planNumber: model.getSnapshot().currentPlan + 1 });
    }
    const derivedNow = deriveTaskScript(script);
    turns.push({
      cardStep: model.getSnapshot().currentPlan,
      ledgerDone: derivedNow.steps.filter((s) => s.status === 'done').length,
      ledgerActive: derivedNow.steps.filter((s) => s.status === 'active').length,
    });
    turnEndsToLastStage += 1;
  }

  const first = turns[0]!;
  return {
    label,
    turns,
    lagAtFirstTurn: STAGES - (first.cardStep > STAGES ? STAGES : first.cardStep - 1),
    turnEndsToLastStage,
  };
}

function render(result: ScenarioResult): void {
  console.log(`\n【${result.label}】`);
  console.log('  回合 | 卡片高亮阶段 | 账本已完成 | 账本在跑');
  for (const [i, turn] of result.turns.entries()) {
    const card = turn.cardStep > STAGES ? `完成(${STAGES})` : `${turn.cardStep}/${STAGES}`;
    console.log(`   ${String(i + 1).padStart(3)} | ${card.padStart(13)} | ${String(turn.ledgerDone).padStart(10)} | ${String(turn.ledgerActive).padStart(8)}`);
  }
  console.log(`  首个回合末的卡片滞后：${result.lagAtFirstTurn} 格（真实已完成 ${STAGES} 阶段）`);
  console.log(`  游标走到最后一个阶段：${result.turnEndsToLastStage} 个回合末`);
}

const withMarkers = runScenario('模型发控制行（现状）', true);
const withoutMarkers = runScenario('模型不发控制行（放开后）', false);

console.log(`对照回放：${STAGES} 个阶段在同一回合内一次做完`);
render(withMarkers);
render(withoutMarkers);

console.log('\n结论（写回设计稿 10.4 的实测数据）：');
console.log(`- 有标记：首回合末卡片即对齐（滞后 ${withMarkers.lagAtFirstTurn} 格）。`);
console.log(`- 无标记：首回合末卡片滞后 ${withoutMarkers.lagAtFirstTurn} 格，游标需 ${withoutMarkers.turnEndsToLastStage} 个回合末才走到最后阶段。`);
console.log(`- 但账本两种情形都认定已完成 ${withMarkers.turns[0]?.ledgerDone} / ${withoutMarkers.turns[0]?.ledgerDone} 阶段——`);
console.log('  「做了什么、结果如何」不依赖标记，只有「卡片高亮走到哪」依赖。');

if (withoutMarkers.lagAtFirstTurn <= 0) {
  console.log('\n注意：无标记场景首回合无滞后，回合末兜底已足够，3a 的代价判断可以放宽。');
}
