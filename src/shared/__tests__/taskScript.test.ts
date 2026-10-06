import { describe, expect, it } from 'bun:test';
import {
  applyTaskScriptSignal,
  applyTaskScriptSignals,
  createTaskScript,
  deriveTaskScript,
  inferredClosures,
  taskScriptHandOver,
  taskScriptProgress,
} from '../taskScript';
import type { Plan } from '../../coding-agent/types';

function plan(...actions: string[]): Plan {
  return { reasoning: 'r', steps: actions.map((action, i) => ({ id: `s${i + 1}`, action, description: `${action} desc`, expectedOutcome: `${action} done` })) };
}

function planWithTodos(action: string, todos: string[]): Plan {
  return {
    reasoning: 'r',
    steps: [{
      id: 's1',
      action,
      description: 'd',
      expectedOutcome: 'e',
      todosRequired: true,
      substeps: todos.map((label, i) => ({ id: `t${i + 1}`, action: label, description: `${label} d`, expectedOutcome: `${label} e` })),
    }],
  };
}

describe('taskScript · 空账与数字账', () => {
  it('新剧本无信号时全部 pending（没干活不说在干），游标停在第一步', () => {
    const script = createTaskScript(plan('A', 'B'));
    expect(deriveTaskScript(script).steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(deriveTaskScript(script).cursor).toBe(1);
    expect(taskScriptProgress(script)).toEqual({ total: 2, done: 0, current: 1, allDone: false });
    expect(deriveTaskScript(script).steps[0]?.evidence).toEqual({ tools: 0, failedTools: [], artifacts: [], verifications: [], branchOutcome: null });
  });

  it('账本只追加不原地改：旧快照不受后续信号影响（实时=重载同路径）', () => {
    const base = createTaskScript(plan('A', 'B'));
    const advanced = applyTaskScriptSignals(base, [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
    ]);
    expect(base.signals).toHaveLength(0);
    expect(advanced.signals).toHaveLength(2);
    expect(taskScriptProgress(base).done).toBe(0);
    expect(taskScriptProgress(advanced).done).toBe(1);
  });

  it('applyTaskScriptSignals 空输入返回同一对象（无意义变更不留痕）', () => {
    const script = createTaskScript(plan('A'));
    expect(applyTaskScriptSignals(script, [])).toBe(script);
  });

  it('全步骤显式完成 → allDone，且隐式收束名单为空', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
      { kind: 'control', marker: 'phaseStart', phase: 2 },
      { kind: 'control', marker: 'phaseDone', phase: 2 },
    ]);
    const progress = taskScriptProgress(script);
    expect(progress).toEqual({ total: 2, done: 2, current: 2, allDone: true });
    expect(inferredClosures(script)).toEqual([]);
    expect(deriveTaskScript(script).steps.every((s) => s.closure === 'control')).toBe(true);
  });
});

describe('taskScript · 显式控制行记账', () => {
  it('子步骤按序推进，未标记的保持 pending', () => {
    const script = applyTaskScriptSignals(createTaskScript(planWithTodos('A', ['t1', 't2', 't3'])), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'substepStart', phase: 1, substep: 1 },
      { kind: 'control', marker: 'substepDone', phase: 1, substep: 1 },
      { kind: 'control', marker: 'substepStart', phase: 1, substep: 2 },
    ]);
    expect(deriveTaskScript(script).steps[0]?.substeps.map((s) => s.status)).toEqual(['done', 'active', 'pending']);
  });

  it('阶段完成行把剩余子步骤一并收束（模型不会再逐项标）', () => {
    const script = applyTaskScriptSignals(createTaskScript(planWithTodos('A', ['t1', 't2'])), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'substepDone', phase: 1, substep: 1 },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
    ]);
    expect(deriveTaskScript(script).steps[0]?.substeps.map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('阶段完成行后游标前进，下一步的证据记在新步上', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'a.ts' },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
      { kind: 'tool', toolName: 'edit_file', ok: true, artifact: 'b.ts' },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps[0]?.status).toBe('done');
    expect(steps[0]?.evidence.artifacts).toEqual(['a.ts']);
    expect(steps[1]?.status).toBe('active');
    expect(steps[1]?.evidence.artifacts).toEqual(['b.ts']);
  });

  it('越界/非法的控制行编号不记账：宁可不动账，也不把错编号猜成完成', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'control', marker: 'phaseStart', phase: 99 },
      { kind: 'control', marker: 'phaseDone', phase: 0 },
      { kind: 'control', marker: 'phaseDone', phase: 99 },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(steps.every((s) => s.closure === null)).toBe(true);
    expect(taskScriptProgress(script).done).toBe(0);
  });

  it('合法编号照常记账（与越界用例对照）', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
    ]);
    expect(deriveTaskScript(script).steps.map((s) => s.status)).toEqual(['done', 'pending']);
    expect(taskScriptProgress(script).current).toBe(2);
  });

  it('子步骤编号越界也不动账（不能把不存在的子步骤标完成）', () => {
    const script = applyTaskScriptSignals(createTaskScript(planWithTodos('A', ['t1', 't2'])), [
      { kind: 'control', marker: 'phaseStart', phase: 1 },
      { kind: 'control', marker: 'substepDone', phase: 1, substep: 7 },
    ]);
    expect(deriveTaskScript(script).steps[0]?.substeps.map((s) => s.status)).toEqual(['pending', 'pending']);
  });
});

describe('taskScript · 漏控制行时工具信号兜底', () => {
  it('模型一句控制行没发，工具产出照样入账并让该步 active', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/a.ts' },
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/a.ts' },
      { kind: 'tool', toolName: 'read_file', ok: true },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps[0]?.status).toBe('active');
    expect(steps[0]?.startedByControl).toBe(false);
    expect(steps[0]?.closure).toBeNull();
    expect(steps[0]?.evidence.tools).toBe(3);
    expect(steps[0]?.evidence.artifacts).toEqual(['src/a.ts']);
    expect(steps[1]?.status).toBe('pending');
  });

  it('回合结束按真实活动隐式收束一步，游标前进，且隐式可被审计', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'a.ts' },
      { kind: 'turnEnd' },
    ]);
    const progress = taskScriptProgress(script);
    expect(progress.done).toBe(1);
    expect(progress.current).toBe(2);
    expect(inferredClosures(script)).toEqual([1]);
    expect(deriveTaskScript(script).steps[0]?.closure).toBe('inferred');
  });

  it('一次回合结束最多隐式收束一步，不跳格', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B', 'C')), [
      { kind: 'tool', toolName: 'write_file', ok: true },
      { kind: 'turnEnd' },
    ]);
    expect(taskScriptProgress(script).done).toBe(1);
    expect(deriveTaskScript(script).steps.map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
  });

  it('本轮没有任何活动就不隐式收束（没干活不算做完）', () => {
    const script = applyTaskScriptSignal(createTaskScript(plan('A', 'B')), { kind: 'turnEnd' });
    expect(taskScriptProgress(script).done).toBe(0);
    expect(inferredClosures(script)).toEqual([]);
  });

  it('子步骤没做完时不隐式收束该阶段', () => {
    const script = applyTaskScriptSignals(createTaskScript(planWithTodos('A', ['t1', 't2'])), [
      { kind: 'tool', toolName: 'write_file', ok: true },
      { kind: 'control', marker: 'substepDone', phase: 1, substep: 1 },
      { kind: 'turnEnd' },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps[0]?.status).toBe('active');
    expect(steps[0]?.closure).toBeNull();
    expect(steps[0]?.substeps.map((s) => s.status)).toEqual(['done', 'pending']);
  });

  it('显式完成行已收束的步不会被回合结束重复计入', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'write_file', ok: true },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
      { kind: 'turnEnd' },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps[0]?.closure).toBe('control');
    expect(steps[1]?.status).toBe('pending');
    expect(inferredClosures(script)).toEqual([]);
  });
});

describe('taskScript · 产出与证据', () => {
  it('失败工具名去重入账；验证按运行序列记账（重跑是事实，不去重）', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A')), [
      { kind: 'tool', toolName: 'execute_command', ok: false, command: 'bun test' },
      { kind: 'verification', command: 'bun run typecheck', ok: true },
      { kind: 'tool', toolName: 'execute_command', ok: false, command: 'bun test' },
    ]);
    const evidence = deriveTaskScript(script).steps[0]?.evidence;
    expect(evidence?.failedTools).toEqual(['execute_command']);
    expect(evidence?.verifications).toEqual([
      { command: 'bun test', ok: false },
      { command: 'bun run typecheck', ok: true },
      { command: 'bun test', ok: false },
    ]);
    expect(evidence?.tools).toBe(3);
  });

  it('分支中断入账在当前步，且不把该步当成做完', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'task', ok: true },
      { kind: 'branch', outcome: 'paused', toolName: 'task' },
    ]);
    const steps = deriveTaskScript(script).steps;
    expect(steps[0]?.evidence.branchOutcome).toBe('paused');
    expect(steps[0]?.status).toBe('active');
  });

  it('计划细化后账本按新步骤重建：旧产出不谎报成新某一步的产出', () => {

    const refined = plan('A1', 'A2', 'B');
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'old.ts' },
      { kind: 'planReplaced', plan: refined },
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'new.ts' },
    ]);
    const derived = deriveTaskScript(script);
    expect(derived.steps).toHaveLength(3);
    expect(derived.steps[0]?.evidence.artifacts).toEqual(['new.ts']);
    expect(derived.steps[0]?.status).toBe('active');
    expect(derived.steps[1]?.evidence.tools).toBe(0);
  });

  it('计划细化前的产出作为历史事实保留（文件真写了就不当没发生）', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'old.ts' },
      { kind: 'verification', command: 'bun test', ok: false },
      { kind: 'planReplaced', plan: plan('A refined', 'B') },
    ]);
    const earlier = deriveTaskScript(script).earlierEvidence;
    expect(earlier.artifacts).toEqual(['old.ts']);
    expect(earlier.verifications).toEqual([{ command: 'bun test', ok: false }]);
    expect(taskScriptHandOver(script).earlierEvidence.artifacts).toEqual(['old.ts']);
  });
});

describe('taskScript · 收尾素材只出事实', () => {
  it('HandOver 是结构化事实：动作、承诺、状态、证据，不含 host 拼的句子', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('改 chat.ts', '跑验证')), [
      { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/ui/chat.ts' },
      { kind: 'control', marker: 'phaseDone', phase: 1 },
      { kind: 'verification', command: 'bun test', ok: true },
      { kind: 'turnEnd' },
    ]);
    const handover = taskScriptHandOver(script);
    expect(handover.totalSteps).toBe(2);
    expect(handover.doneSteps).toBe(2);
    expect(handover.allDone).toBe(true);
    expect(handover.steps[0]).toMatchObject({
      index: 1,
      action: '改 chat.ts',
      expectedOutcome: '改 chat.ts done',
      status: 'done',
      closure: 'control',
    });
    expect(handover.steps[0]?.evidence.artifacts).toEqual(['src/ui/chat.ts']);
    expect(handover.steps[1]?.evidence.verifications).toEqual([{ command: 'bun test', ok: true }]);
    expect(handover.earlierEvidence).toEqual({ tools: 0, failedTools: [], artifacts: [], verifications: [], branchOutcome: null });
  });

  it('未全完成的剧本 allDone 为 false，且明确暴露还差哪步', () => {
    const script = applyTaskScriptSignals(createTaskScript(plan('A', 'B')), [
      { kind: 'control', marker: 'phaseDone', phase: 1 },
    ]);
    const handover = taskScriptHandOver(script);
    expect(handover.allDone).toBe(false);
    expect(handover.doneSteps).toBe(1);
    expect(handover.steps.filter((s) => s.status !== 'done').map((s) => s.index)).toEqual([2]);
  });

  it('空计划不谎报全部完成', () => {
    const handover = taskScriptHandOver(createTaskScript({ reasoning: 'r', steps: [] }));
    expect(handover).toEqual({
      totalSteps: 0,
      doneSteps: 0,
      allDone: false,
      steps: [],
      earlierEvidence: { tools: 0, failedTools: [], artifacts: [], verifications: [], branchOutcome: null },
    });
    expect(taskScriptProgress(createTaskScript({ reasoning: 'r', steps: [] })).allDone).toBe(false);
  });

  it('derive 返回副本：外部改结果不会污染下一次推导', () => {
    const script = createTaskScript(plan('A'));
    const first = deriveTaskScript(script);
    first.steps[0]?.evidence.failedTools.push('write_file');
    first.steps[0]!.status = 'done';
    const second = deriveTaskScript(script);
    expect(second.steps[0]?.evidence.failedTools).toEqual([]);
    expect(second.steps[0]?.status).toBe('pending');
  });
});
