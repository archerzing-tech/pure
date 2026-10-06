// src/shared/taskScript.ts
// 复杂任务呈现重设计·期 2「结构账」（2026-10-06）：一份剧本，记「每步做了什么、
// 结果如何」，让 J5（做了什么 / 结果如何）有账可查。
//
// 为什么是「账」而不是「话」：铁律要求对话流里以 agent 口吻出现的句子只能来自
// 模型。所以本模块**不生成任何句子**——它只吃真实信号（控制行 / 工具结果 /
// 验证命令 / 回合结束 / 分支中断），产出结构化事实（状态、产出文件、验证结果、
// 失败项）。句子由模型自己讲，这些事实只当它的素材与 UI 的结构。
//
// 为什么是纯函数 + 单向账本：signals 只追加，derive 从头折叠。这样「实时」与
// 「回放」走同一条推导路径（期 4 进快照时直接存 signals），不会长出第二套进度
// 真相——防缠三原则里的「不新增第五套表面」在这里靠结构保证。
//
// 兜底纪律：模型漏发控制行时不能装作没发生。工具/验证信号照样归属到当前游标步，
// 回合结束按真实活动量隐式收束该步（对应 planProgress.shouldAdvancePlanAtTurnEnd
// 的既有纪律），但**隐式完成与显式完成必须可区分**，供审计与 UI 呈现。

import type { BranchOutcome } from './branchOutcome';
import type { Plan } from '../coding-agent/types';

/** 步骤的账务状态。只描述「走到哪」，不描述「做得好不好」——好不好在 evidence。 */
export type TaskStepStatus = 'pending' | 'active' | 'done';

/** 收束方式：显式 = 模型发了完成控制行；隐式 = 回合结束时按真实活动兜底收束。 */
export type TaskStepClosure = 'control' | 'inferred' | null;

export interface TaskVerification {
  command: string;
  ok: boolean;
}

export interface TaskStepEvidence {
  /** 本步内完成过的工具调用数。 */
  tools: number;
  /** 失败的工具名（去重、按首次出现排序）。 */
  failedTools: string[];
  /** 本步真实写盘过的文件路径（去重、按首次出现排序）。 */
  artifacts: string[];
  /** 本步跑过的验证命令与结果。 */
  verifications: TaskVerification[];
  /** 本步进行期间用户中断过一支（暂停/停止），即不是「顺利做完」。 */
  branchOutcome: BranchOutcome | null;
}

export interface TaskSubstepRecord {
  index: number;
  status: TaskStepStatus;
  doneByControl: boolean;
}

export interface TaskStepRecord {
  index: number;
  action: string;
  description: string;
  expectedOutcome: string;
  status: TaskStepStatus;
  closure: TaskStepClosure;
  startedByControl: boolean;
  evidence: TaskStepEvidence;
  substeps: TaskSubstepRecord[];
}

/**
 * 剧本信号。只允许「已发生的事实」进来——控制行是模型自己的标记，工具/验证/
 * 分支是宿主观测到的事实，回合结束是生命周期。任何信号都不携带结论句。
 */
export type TaskScriptSignal =
  | { kind: 'planReplaced'; plan: Plan }
  | { kind: 'control'; marker: 'phaseStart' | 'phaseDone' | 'phaseJump' | 'substepStart' | 'substepDone'; phase: number; substep?: number }
  | { kind: 'tool'; toolName: string; ok: boolean; command?: string; artifact?: string }
  | { kind: 'verification'; command: string; ok: boolean }
  | { kind: 'turnEnd' }
  | { kind: 'branch'; outcome: BranchOutcome; toolName?: string };

export interface TaskScript {
  /** 账本格式版本。期 4 进快照时用它升版，不靠字段猜。 */
  version: 1;
  plan: Plan;
  signals: TaskScriptSignal[];
}

export function createTaskScript(plan: Plan): TaskScript {
  return { version: 1, plan, signals: [] };
}

/** 只追加，不改写：账本按发生顺序保留，状态一律现推。 */
export function applyTaskScriptSignal(script: TaskScript, signal: TaskScriptSignal): TaskScript {
  return { ...script, signals: [...script.signals, signal] };
}

export function applyTaskScriptSignals(script: TaskScript, signals: readonly TaskScriptSignal[]): TaskScript {
  return signals.length === 0 ? script : { ...script, signals: [...script.signals, ...signals] };
}

interface FoldedStep {
  index: number;
  action: string;
  description: string;
  expectedOutcome: string;
  startedByControl: boolean;
  doneByControl: boolean;
  closed: boolean;
  closure: TaskStepClosure;
  tools: number;
  failedTools: string[];
  artifacts: string[];
  verifications: TaskVerification[];
  branchOutcome: BranchOutcome | null;
  substeps: TaskSubstepRecord[];
}

/**
 * 把模型报来的步骤/子步骤编号落到有效索引；越界或非法返回 null——**不夹取**。
 * 夹取会把「模型把编号写错」变成「最后一步被判完成」，那是拿猜的当事实记账，
 * 与 J6（不确定不包装成完成）相悖。编号不可信就不动账。
 */
function resolveIndex(value: number | undefined, total: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const index = Math.floor(value);
  if (index < 1 || index > total) return null;
  return index;
}

function pushUnique(list: string[], value: string | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed || list.includes(trimmed)) return;
  list.push(trimmed);
}

/** 一次回合结束最多隐式收束一步——与既有 plan 游标纪律同口径，不跳格。 */
function inferClosures(folded: FoldedStep[]): void {
  const index = folded.findIndex((step) => !step.closed);
  if (index < 0) return;
  const step = folded[index];
  if (!step || step.tools === 0) return;
  if (step.substeps.some((row) => row.status !== 'done')) return;
  step.closed = true;
  step.closure = 'inferred';
}

function blankSteps(plan: Plan): FoldedStep[] {
  return plan.steps.map((step, i) => ({
    index: i + 1,
    action: step.action ?? '',
    description: step.description ?? '',
    expectedOutcome: step.expectedOutcome ?? '',
    startedByControl: false,
    doneByControl: false,
    closed: false,
    closure: null,
    tools: 0,
    failedTools: [],
    artifacts: [],
    verifications: [],
    branchOutcome: null,
    substeps: (step.substeps ?? []).map((_, j) => ({ index: j + 1, status: 'pending' as TaskStepStatus, doneByControl: false })),
  }));
}

function fold(script: TaskScript): { folded: FoldedStep[]; cursor: number; earlier: TaskStepEvidence } {
  let folded = blankSteps(script.plan);
  let cursor = 1;
  let openSubstep: number | null = null;
  // 计划细化之前的产出：文件真写了、验证真跑了，不能因为步骤表换了就当作没发生。
  // 但新步骤与旧步骤没有可信的一一对应，所以不硬挂到新步骤上，只作为「已发生的事实」
  // 单独交给消费方（模型收尾素材 / UI），避免把旧产出谎报成某一步的产出。
  const earlier: TaskStepEvidence = { tools: 0, failedTools: [], artifacts: [], verifications: [], branchOutcome: null };
  const bank = (evidence: TaskStepEvidence): void => {
    earlier.tools += evidence.tools;
    for (const name of evidence.failedTools) pushUnique(earlier.failedTools, name);
    for (const path of evidence.artifacts) pushUnique(earlier.artifacts, path);
    earlier.verifications.push(...evidence.verifications);
    earlier.branchOutcome = earlier.branchOutcome ?? evidence.branchOutcome;
  };
  for (const signal of script.signals) {
    if (signal.kind === 'planReplaced') {
      for (const step of folded) {
        bank({
          tools: step.tools,
          failedTools: step.failedTools,
          artifacts: step.artifacts,
          verifications: step.verifications,
          branchOutcome: step.branchOutcome,
        });
      }
      folded = blankSteps(signal.plan);
      cursor = 1;
      openSubstep = null;
      continue;
    }
    if (signal.kind === 'control') {
      const phase = resolveIndex(signal.phase, folded.length);
      if (phase === null) continue;
      const step = folded[phase - 1];
      if (!step) continue;
      if (signal.marker === 'phaseStart') {
        cursor = phase;
        openSubstep = null;
        if (!step.closed) step.startedByControl = true;
        continue;
      }
      if (signal.marker === 'phaseJump') {
        // 跳格：中间的步骤确实被走过了（计划卡也这么推进），但模型没逐步发完成
        // 行。按隐式收束记账（closure='inferred'）——不冒充它逐步显式完成，
        // 也不留成 pending 说它没做。
        for (let i = cursor; i < phase; i += 1) {
          const skipped = folded[i - 1];
          if (!skipped || skipped.closed) continue;
          for (const row of skipped.substeps) {
            if (row.status !== 'done') {
              row.status = 'done';
              row.doneByControl = false;
            }
          }
          skipped.closed = true;
          skipped.closure = 'inferred';
        }
        cursor = phase;
        openSubstep = null;
        if (!step.closed) step.startedByControl = true;
        continue;
      }
      if (signal.marker === 'phaseDone') {
        step.doneByControl = true;
        if (!step.closed) {
          step.closed = true;
          step.closure = 'control';
        }
        for (const row of step.substeps) {
          if (row.status !== 'done') {
            row.status = 'done';
            row.doneByControl = true;
          }
        }
        openSubstep = null;
        cursor = Math.min(phase + 1, folded.length + 1);
        continue;
      }
      if (cursor !== phase) continue;
      const number = resolveIndex(signal.substep ?? 1, step.substeps.length);
      if (number === null) continue;
      const row = step.substeps[number - 1];
      if (!row) continue;
      if (signal.marker === 'substepStart') {
        openSubstep = number;
        if (row.status === 'pending') row.status = 'active';
        continue;
      }
      row.status = 'done';
      row.doneByControl = true;
      openSubstep = openSubstep === number ? null : openSubstep;
      continue;
    }
    if (signal.kind === 'branch') {
      const step = folded[Math.min(cursor, folded.length) - 1];
      if (step) step.branchOutcome = signal.outcome;
      continue;
    }
    if (signal.kind === 'turnEnd') {
      inferClosures(folded);
      cursor = folded.findIndex((step) => !step.closed);
      cursor = cursor < 0 ? folded.length + 1 : cursor + 1;
      openSubstep = null;
      continue;
    }
    const step = folded[Math.min(cursor, folded.length) - 1];
    if (!step) continue;
    step.tools += 1;
    if (signal.kind === 'verification') {
      step.verifications.push({ command: signal.command, ok: signal.ok });
      continue;
    }
    if (!signal.ok) pushUnique(step.failedTools, signal.toolName);
    pushUnique(step.artifacts, signal.artifact);
    if (signal.command) step.verifications.push({ command: signal.command, ok: signal.ok });
  }
  return { folded, cursor, earlier };
}

/**
 * 状态只看**信号**：`active` = 有真实信号（控制行起手行或工具/验证活动）在跑，
 * 没有信号的步就是 `pending`——哪怕它正好处在游标位置。没干活不说在干（J6），
 * 「当前第几步」是游标的事，交给 UI 高亮，不拿它冒充活动。
 */
function deriveStatus(step: FoldedStep): TaskStepStatus {
  if (step.closed) return 'done';
  if (step.tools > 0) return 'active';
  if (step.startedByControl) return 'active';
  return 'pending';
}

/** 推导账目。每步状态、产出与证据都从 signals 现算，账本本身只存事实。 */
export function deriveTaskScript(script: TaskScript): { steps: TaskStepRecord[]; cursor: number; earlierEvidence: TaskStepEvidence } {
  const { folded, cursor, earlier } = fold(script);
  const steps = folded.map((step) => ({
    index: step.index,
    action: step.action,
    description: step.description,
    expectedOutcome: step.expectedOutcome,
    status: deriveStatus(step),
    closure: step.closure,
    startedByControl: step.startedByControl,
    evidence: {
      tools: step.tools,
      failedTools: [...step.failedTools],
      artifacts: [...step.artifacts],
      verifications: step.verifications.map((item) => ({ ...item })),
      branchOutcome: step.branchOutcome,
    },
    substeps: step.substeps.map((row) => ({ ...row })),
  }));
  return { steps, cursor, earlierEvidence: { ...earlier, failedTools: [...earlier.failedTools], artifacts: [...earlier.artifacts], verifications: earlier.verifications.map((item) => ({ ...item })) } };
}

export interface TaskScriptProgress {
  total: number;
  done: number;
  current: number;
  allDone: boolean;
}

/** 供计划卡步骤条读的数字账：几步做完、现在第几步、是不是全完了。 */
export function taskScriptProgress(script: TaskScript): TaskScriptProgress {
  const { steps, cursor } = deriveTaskScript(script);
  const done = steps.filter((step) => step.status === 'done').length;
  return {
    total: steps.length,
    done,
    current: steps.length === 0 ? 0 : Math.min(Math.max(cursor, 1), steps.length),
    allDone: steps.length > 0 && done === steps.length,
  };
}

export interface TaskStepHandOver {
  index: number;
  action: string;
  expectedOutcome: string;
  status: TaskStepStatus;
  closure: TaskStepClosure;
  evidence: TaskStepEvidence;
}

export interface TaskScriptHandOver {
  totalSteps: number;
  doneSteps: number;
  allDone: boolean;
  steps: TaskStepHandOver[];
  /** 计划细化前已发生、但无法可靠归属到某个新步骤的产出。 */
  earlierEvidence: TaskStepEvidence;
}

/**
 * 收尾素材：**只有事实**，没有句子。喂给模型自己讲「依据/改动/验证/遗留」，
 * 或者给 UI 当结构——由消费方决定怎么组织，host 不在这里替模型编排措辞。
 */
export function taskScriptHandOver(script: TaskScript): TaskScriptHandOver {
  const { steps, earlierEvidence } = deriveTaskScript(script);
  const doneSteps = steps.filter((step) => step.status === 'done').length;
  return {
    totalSteps: steps.length,
    doneSteps,
    allDone: steps.length > 0 && doneSteps === steps.length,
    steps: steps.map((step) => ({
      index: step.index,
      action: step.action,
      expectedOutcome: step.expectedOutcome,
      status: step.status,
      closure: step.closure,
      evidence: step.evidence,
    })),
    earlierEvidence,
  };
}

/** 剧本里有没有隐式收束——审计用：模型漏发控制行时这批步就是靠兜底推上去的。 */
export function inferredClosures(script: TaskScript): number[] {
  return deriveTaskScript(script)
    .steps.filter((step) => step.closure === 'inferred')
    .map((step) => step.index);
}

const STATUS_LABEL: Record<TaskStepStatus, string> = {
  done: '已完成',
  active: '进行中',
  pending: '未开始',
};

const CLOSURE_LABEL: Record<Exclude<TaskStepClosure, null>, string> = {
  control: '模型标记完成',
  inferred: '按真实活动兜底收束',
};

/** 每步列出的产出/验证条数上限：素材要够用，也不能把整轮工具历史灌进提示词。 */
const MAX_LISTED_PER_STEP = 6;

/**
 * 单步已记账事实的一句话摘要，给 UI 当悬停提示用：只说记到了什么，不下结论。
 * 没有证据时返回空串——空串意味着「没什么可显示」，不是「这步很顺利」。
 */
export function formatTaskStepEvidence(step: TaskStepRecord): string {
  // 什么也没记到的步不给提示：「未开始」不是信息，卡片本来就用灰态写着这件事。
  // 只有真记下了什么（或真收束了）才值得占用一个悬停提示。
  if (step.evidence.tools === 0 && step.closure === null) return '';
  const parts: string[] = [STATUS_LABEL[step.status]];
  if (step.closure) parts.push(CLOSURE_LABEL[step.closure]);
  if (step.evidence.artifacts.length > 0) parts.push(`产出 ${listed(step.evidence.artifacts, 3)}`);
  if (step.evidence.verifications.length > 0) {
    parts.push(`验证 ${listed(step.evidence.verifications.map((item) => `${item.command} ${item.ok ? '通过' : '未通过'}`), 3)}`);
  }
  if (step.evidence.failedTools.length > 0) parts.push(`失败 ${listed(step.evidence.failedTools, 3)}`);
  if (step.evidence.branchOutcome) parts.push(step.evidence.branchOutcome === 'paused' ? '期间被用户暂停' : '期间被用户停止');
  return parts.join(' · ');
}

function listed(values: string[], max = MAX_LISTED_PER_STEP): string {
  if (values.length === 0) return '无';
  const shown = values.slice(0, max).join('、');
  return values.length > max ? `${shown}…（共 ${values.length} 项）` : shown;
}

function stepFacts(step: TaskStepHandOver): string {
  const parts = [
    `状态：${STATUS_LABEL[step.status]}${step.closure ? `（${CLOSURE_LABEL[step.closure]}）` : ''}`,
    `产出：${listed(step.evidence.artifacts)}`,
    `验证：${listed(step.evidence.verifications.map((item) => `${item.command} ${item.ok ? '通过' : '未通过'}`))}`,
  ];
  if (step.evidence.failedTools.length > 0) parts.push(`失败工具：${listed(step.evidence.failedTools)}`);
  if (step.evidence.branchOutcome) parts.push(`期间被中断：${step.evidence.branchOutcome === 'paused' ? '用户暂停' : '用户停止'}`);
  return `第 ${step.index} 步「${step.action}」｜承诺：${step.expectedOutcome}｜${parts.join('｜')}`;
}

/**
 * 把账本排成一段**给模型看的素材**。这里排的是事实清单，不是替模型写好的收尾——
 * 它进的是提示词（user-turn context），不是对话流。措辞、顺序、语气仍由模型自己
 * 决定；模型没记到的事由它按自己知道的讲，宿主不补。
 *
 * 空账（还没开工或没有计划）返回空串：宁可不给素材，也不给一份空清单占提示词。
 */
export function formatTaskScriptFacts(handover: TaskScriptHandOver | null | undefined): string {
  if (!handover || handover.totalSteps === 0) return '';
  const lines = handover.steps.map(stepFacts);
  const earlier = handover.earlierEvidence;
  if (earlier.tools > 0 || earlier.artifacts.length > 0 || earlier.verifications.length > 0) {
    lines.push([
      '计划细化前已发生（无法归属到具体步骤）：',
      `产出：${listed(earlier.artifacts)}`,
      `验证：${listed(earlier.verifications.map((item) => `${item.command} ${item.ok ? '通过' : '未通过'}`))}`,
    ].join('｜'));
  }
  return [
    '<task_script_facts>',
    '以下是宿主按真实信号记下的账：文件是真写过的，命令是真跑过的，验证是真跑过的。它只是素材，不是要你照抄的稿子——怎么讲、按什么顺序、用什么语气，你自己决定；它没记到的事按你实际知道的讲，不要替它补，也不要因为清单里没写就当作没发生。',
    ...lines,
    '</task_script_facts>',
  ].join('\n');
}
