// src/coding-agent/taskState.ts
// 插话架构 v2 地基：任务状态结构化（docs/insertion-redesign-v2.md §三）。
//
// 为什么要有这一层：插话判定从「模型读上下文现判」升级为「查结构化状态定位影
// 响」。同一句「预算改成 50 万」在「还没用到预算」和「已基于旧预算产出」两种
// 情况下处置完全不同——没有结构化状态就无从区分（用户插入会话的处理逻辑与流程
// §一前提）。本模块把三块既有局部账缝成一份快照：
//   - Plan/PlanStep（types.ts，本版补 dependsOn 数据依赖边），
//   - TaskScript signals（shared/taskScript.ts，只追加事实账），
//   - BranchState 七态（branchLifecycle.ts，委派支生命周期）。
//
// 分层纪律：foldTaskState 是纯折算（全部输入显式，同一输入同一快照）；
// TaskStateStore 是薄壳（持约束登记 + 副作用账本两份可变账，每次查询现折）。
// 处置管线只许走这里的查询 API 定位影响，禁止自己扫上下文（蓝图 §三）。
//
// 节点状态语义（一期锁死）：
//   pending   — 计划里有、还没动；
//   running   — 已开工未收束。已暂停未落定的委派支也算在飞：活没交回来，
//               处置上它既不是「未开始可拦截」也不是「已完成可结算」；
//   done      — 已收束（显式控制行或回合兜底，与 taskScript 口径一致）；
//   stale     — 依据已失效：依附约束被撤/被换，或数据依赖上游过期。须重做
//               或重验，覆盖 done/pending/running。「曾是已完成」的信息交给
//               副作用账（pendingWrites/freezeUncompensable）兜住，节点态只
//               留管线要的最终答案——二期四类划分（§九）再拆细；
//   cancelled — 已取消：支被 abort/fail，或未开工节点连坐于已取消的上游。
//               硬取消，不再产出；stale 传播不穿越它。

import { deriveTaskScript } from '../shared/taskScript';
import type { TaskScript, TaskScriptSignal } from '../shared/taskScript';
import type { BranchOutcome } from '../shared/branchOutcome';
import type { Plan } from './types';
import type { BranchState } from './branchLifecycle';

export interface TaskNode {
  id: string;                 // 步骤/分支节点 id
  title: string;
  state: 'pending' | 'running' | 'done' | 'stale' | 'cancelled';
  dependsOn: string[];        // 数据依赖边
  branchCallId?: string;      // 关联委派支（BranchState 七态缝）
  origin: 'plan' | 'delegation' | 'queue' | 'interject';
}

export interface ConstraintEntry {      // 约束血缘：约束 → 依附节点
  id: string;
  text: string;                // 约束/前提原文片段
  source: 'user' | 'plan' | 'interject';
  status: 'active' | 'removed' | 'superseded';
  attachedNodes: string[];     // 「因这条约束才做这些节点」——因果依赖的载体
}

export interface SideEffectEntry {
  id: string; ts: number; tool: string; callId?: string;
  write: boolean; irreversible: boolean;
  target?: string;
  compensable: 'auto' | 'manual' | 'none';
  status: 'done' | 'frozen' | 'compensated';
}

export interface TaskStateSnapshot {
  nodes: TaskNode[]; constraints: ConstraintEntry[];
  sideEffects: SideEffectEntry[];
  safetyMarks: { nodeId: string; reason: string }[];   // 不可逆边界标记
}

// ── 折算器（纯函数） ──

export interface FoldTaskStateInput {
  signals: readonly TaskScriptSignal[];
  plan: Plan;
  /** callId → 分支七态。编排器现持的在飞支由此进来：账本只记落定委派，
   *  在飞支靠这张表缝进快照（BranchState 七态缝）。传引用即可，每次折算
   *  读现值。 */
  branches?: ReadonlyMap<string, BranchState>;
  constraints?: readonly ConstraintEntry[];
  sideEffects?: readonly SideEffectEntry[];
}

/** 委派节点 id 前缀：与 PlanStep.id 命名空间隔开，防 id 撞车。 */
const DELEGATION_PREFIX = 'del:';

function branchNodeState(state: BranchState): TaskNode['state'] {
  switch (state) {
    case 'completed': return 'done';
    case 'aborted':
    case 'failed': return 'cancelled';
    default: return 'running'; // delegating/running/pausing/paused：活没交回来都算在飞
  }
}

function ledgerNodeState(ok: boolean, outcome?: BranchOutcome): TaskNode['state'] {
  if (ok) return 'done';
  // 落定为暂停的支断点已存、可续跑，与 BranchState.paused 同口径算在飞；
  // 其余未交回（stopped/失败）= 这次尝试没有可用产出。
  return outcome === 'paused' ? 'running' : 'cancelled';
}

/** 计划细化（planReplaced）后折算对齐的是最后一份计划——与 taskScript fold 同源。 */
function effectivePlanOf(signals: readonly TaskScriptSignal[], base: Plan): Plan {
  let plan = base;
  for (const signal of signals) {
    if (signal.kind === 'planReplaced') plan = signal.plan;
  }
  return plan;
}

interface DelegationSeed {
  id: string;
  title: string;
  state: TaskNode['state'];
  branchCallId?: string;
  hostStepIndex: number; // 0-based，指向 plan 节点区
}

/**
 * 从 signals + Plan + 分支态 [+ 约束/副作用] 折算任务状态快照。
 * 纯函数：不改输入；同一输入永远同一快照。
 *
 * 口径说明：
 *  - plan 节点与有效计划（最后一份 planReplaced 的计划）按 taskScript 折算
 *    一一对齐，节点 id 取 PlanStep.id；节点状态沿用 deriveStatus 的信号口径
 *    （closed→done，有活动→running，否则 pending）。
 *  - 委派节点来自账本落定条目 + branches 表里的在飞支。计划细化前入账的委派
 *    随旧计划离场（与 taskScript 的 earlier 桶同口径）；delegationRetracted
 *    的支账本已抹除，不再造节点（其离场本身就是取消的落账形态）。每步只保留
 *    前 4 条委派摘要的既有上限同样适用于节点可见性。
 *  - 宿主步骤 dependsOn 它名下的委派节点（步骤消费支的产出）。
 *  - 约束血缘：被撤/被换约束的 attached 节点 → stale，再沿 dependsOn 数据边
 *    向下游闭包传播（数据依赖必须处理）；cancelled 只连坐未开工下游。
 */
export function foldTaskState(input: FoldTaskStateInput): TaskStateSnapshot {
  const { signals, plan, branches, constraints = [], sideEffects = [] } = input;
  const script: TaskScript = { version: 1, plan, signals: signals as TaskScriptSignal[] };
  const derived = deriveTaskScript(script);
  const effPlan = effectivePlanOf(signals, plan);
  const retracted = new Set<string>();
  for (const signal of signals) {
    if (signal.kind === 'delegationRetracted') retracted.add(signal.callId);
  }

  // 1) plan 节点区（[0, steps.length)），委派节点追加在后。
  const nodes: TaskNode[] = derived.steps.map((step, i) => {
    const ps = effPlan.steps[i];
    return {
      id: step.stepId || ps?.id || `step:${i + 1}`,
      title: step.action || ps?.action || `step ${i + 1}`,
      state: step.status === 'done' ? 'done' : step.status === 'active' ? 'running' : 'pending',
      dependsOn: [...(ps?.dependsOn ?? [])],
      origin: 'plan' as const,
    };
  });

  // 2) 委派节点：账本落定条目（带宿主步归属）+ 在飞支（挂游标步）。
  const delegations: DelegationSeed[] = [];
  const seenCalls = new Set<string>();
  derived.steps.forEach((step, i) => {
    let anonymous = 0;
    for (const d of step.evidence.delegations) {
      if (d.callId) {
        if (retracted.has(d.callId) || seenCalls.has(d.callId)) continue;
        seenCalls.add(d.callId);
      }
      const branchState = d.callId ? branches?.get(d.callId) : undefined;
      delegations.push({
        id: d.callId ? `${DELEGATION_PREFIX}${d.callId}` : `${DELEGATION_PREFIX}step${i + 1}:${++anonymous}`,
        title: d.tool,
        state: branchState ? branchNodeState(branchState) : ledgerNodeState(d.ok, d.outcome ?? undefined),
        ...(d.callId ? { branchCallId: d.callId } : {}),
        hostStepIndex: i,
      });
    }
  });
  if (branches && branches.size > 0 && derived.steps.length > 0) {
    // 游标步钳到有效区间：在飞支跑在「当前正在做的那一步」名下。
    const cursorIndex = Math.min(Math.max(derived.cursor, 1), derived.steps.length) - 1;
    for (const [callId, state] of branches) {
      if (retracted.has(callId) || seenCalls.has(callId)) continue;
      delegations.push({
        id: `${DELEGATION_PREFIX}${callId}`,
        title: `branch ${callId}`,
        state: branchNodeState(state),
        branchCallId: callId,
        hostStepIndex: cursorIndex,
      });
    }
  }
  for (const d of delegations) {
    nodes.push({
      id: d.id,
      title: d.title,
      state: d.state,
      dependsOn: [],
      ...(d.branchCallId ? { branchCallId: d.branchCallId } : {}),
      origin: 'delegation',
    });
  }
  // 宿主步骤消费支产出：数据依赖边 步 → 委派节点。
  for (const d of delegations) {
    nodes[d.hostStepIndex]?.dependsOn.push(d.id);
  }

  // 3) 约束血缘 → stale，沿数据边下游传播；硬取消只连坐未开工下游。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const staleFrontier: string[] = [];
  for (const c of constraints) {
    if (c.status !== 'removed' && c.status !== 'superseded') continue;
    for (const nid of c.attachedNodes) {
      const n = byId.get(nid);
      if (n && n.state !== 'stale' && n.state !== 'cancelled') {
        n.state = 'stale';
        staleFrontier.push(nid);
      }
    }
  }
  const propagate = (frontier: string[], flip: TaskNode['state']): void => {
    const queue = [...frontier];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const n of nodes) {
        if (n.state === flip || n.state === 'stale' || n.state === 'cancelled') continue;
        if (n.dependsOn.includes(cur)) {
          n.state = flip;
          queue.push(n.id);
        }
      }
    }
  };
  propagate(staleFrontier, 'stale');
  propagate(
    nodes.filter((n) => n.state === 'cancelled').map((n) => n.id),
    'cancelled',
  );

  // 4) 不可逆边界标记：不可逆副作用按 callId 归属到委派节点；归属不了的
  //    （无 callId 或账本里无对应支）不标——宁可少标不瞎标。
  const callToNode = new Map<string, string>();
  for (const d of delegations) {
    if (d.branchCallId) callToNode.set(d.branchCallId, d.id);
  }
  const safetyMarks: { nodeId: string; reason: string }[] = [];
  const seenMarks = new Set<string>();
  for (const se of sideEffects) {
    if (!se.irreversible || !se.callId) continue;
    const nid = callToNode.get(se.callId);
    if (!nid) continue;
    const reason = `irreversible write: ${se.tool}`;
    const key = `${nid}|${reason}`;
    if (seenMarks.has(key)) continue;
    seenMarks.add(key);
    safetyMarks.push({ nodeId: nid, reason });
  }

  return {
    nodes,
    constraints: constraints.map((c) => ({ ...c, attachedNodes: [...c.attachedNodes] })),
    sideEffects: sideEffects.map((se) => ({ ...se })),
    safetyMarks,
  };
}

// ── 查询（快照上的纯定位，不改节点状态） ──

function downstreamClosure(snapshot: TaskStateSnapshot, seeds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const queue: string[] = [];
  for (const id of seeds) {
    if (result.has(id)) continue;
    result.add(id);
    queue.push(id);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of snapshot.nodes) {
      if (result.has(n.id) || !n.dependsOn.includes(cur)) continue;
      result.add(n.id);
      queue.push(n.id);
    }
  }
  return result;
}

/**
 * 改变落点 → 受影响节点集（数据依赖必须处理）。种子 = 指名节点 ∪ 指名约束的
 * attached 节点，结果 = 种子 ∪ 沿 dependsOn 的下游闭包。约束不论 active 与否
 * 都收：插话点名某约束，说明它的依附节点全在影响射程内。只定位不改状态——
 * 「未开始拦截 / 进行中断 / 已完成冻结」按节点态由处置管线决定。
 */
export function affectedByChange(
  snapshot: TaskStateSnapshot,
  targets: { nodeIds?: readonly string[]; constraintIds?: readonly string[] },
): TaskNode[] {
  const byId = new Set(snapshot.nodes.map((n) => n.id));
  const seeds = new Set<string>();
  for (const id of targets.nodeIds ?? []) {
    if (byId.has(id)) seeds.add(id);
  }
  for (const cid of targets.constraintIds ?? []) {
    const c = snapshot.constraints.find((entry) => entry.id === cid);
    if (!c) continue;
    for (const nid of c.attachedNodes) {
      if (byId.has(nid)) seeds.add(nid);
    }
  }
  const hit = downstreamClosure(snapshot, seeds);
  return snapshot.nodes.filter((n) => hit.has(n.id));
}

/**
 * 因果依赖（《设想》§五.6）：与 nodeId 同挂一条约束、但不在其数据下游、且自身
 * 数据上游完好的节点——独立有效可保留。stale/cancelled 的候选不在此列（它们
 * 已在必须处理集里）；「触发原因已撤回」的标注由处置管线带着约束原文去做，
 * 本 API 只负责把「可保留」与「必须处理」两圈分开，避免误删本可保留的工作。
 */
export function causalDependents(snapshot: TaskStateSnapshot, nodeId: string): TaskNode[] {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const self = byId.get(nodeId);
  if (!self) return [];
  const dataDown = downstreamClosure(snapshot, [nodeId]);
  const candidates = new Set<string>();
  for (const c of snapshot.constraints) {
    if (!c.attachedNodes.includes(nodeId)) continue;
    for (const nid of c.attachedNodes) {
      if (nid !== nodeId && byId.has(nid) && !dataDown.has(nid)) candidates.add(nid);
    }
  }
  if (candidates.size === 0) return [];
  const compromised = downstreamClosure(
    snapshot,
    snapshot.nodes.filter((n) => n.state === 'stale' || n.state === 'cancelled').map((n) => n.id),
  );
  return snapshot.nodes.filter((n) =>
    candidates.has(n.id)
    && n.state !== 'stale'
    && n.state !== 'cancelled'
    && !compromised.has(n.id),
  );
}

// ── 薄壳：约束登记 + 副作用账本（可变，reset/注入入口供测试） ──

export type SideEffectInput = Partial<Pick<SideEffectEntry, 'id' | 'ts' | 'callId' | 'target' | 'status'>>
  & Pick<SideEffectEntry, 'tool' | 'write' | 'irreversible' | 'compensable'>;

export interface ConstraintInput {
  id?: string;
  text: string;
  source: ConstraintEntry['source'];
  /** 节点 id：plan 步骤取 PlanStep.id，委派支取 `del:<callId>`。 */
  attachedNodes: string[];
}

export interface TaskStateStoreInput {
  script: TaskScript;
  branches?: ReadonlyMap<string, BranchState>;
  constraints?: readonly ConstraintEntry[];
  sideEffects?: readonly SideEffectEntry[];
}

/**
 * 任务状态存壳：持有 taskScript 账本 + 约束登记 + 副作用账本，查询时现折。
 * 账本语义只追加（script 由宿主按 taskScript 纪律追加信号）；约束与副作用
 * 两个可变账各有登记 API；reset 整体换账（测试注入 / 会话切换）。
 * recordSideEffect 供工具完成回调落账（本期只建 API 不接线）。
 */
export class TaskStateStore {
  private branches?: ReadonlyMap<string, BranchState>;
  private constraints: ConstraintEntry[];
  private sideEffects: SideEffectEntry[];
  private constraintSeq = 0;
  private sideEffectSeq = 0;

  constructor(
    private script: TaskScript,
    input?: Omit<TaskStateStoreInput, 'script'>,
  ) {
    this.branches = input?.branches;
    this.constraints = (input?.constraints ?? []).map(cloneConstraint);
    this.sideEffects = (input?.sideEffects ?? []).map((se) => ({ ...se }));
  }

  /** 当前快照：每次查询现折（signals 只追加 + 折算纯函数，现折即最新真相）。 */
  snapshot(): TaskStateSnapshot {
    return foldTaskState({
      signals: this.script.signals,
      plan: this.script.plan,
      branches: this.branches,
      constraints: this.constraints,
      sideEffects: this.sideEffects,
    });
  }

  // ── 约束登记 ──

  registerConstraint(input: ConstraintInput): ConstraintEntry {
    const entry: ConstraintEntry = {
      id: input.id ?? `c:${++this.constraintSeq}`,
      text: input.text,
      source: input.source,
      status: 'active',
      attachedNodes: [...input.attachedNodes],
    };
    this.constraints.push(entry);
    return cloneConstraint(entry);
  }

  /** 撤约束：active → removed（血缘保留，attached 节点在下一次折算转 stale）。 */
  removeConstraint(id: string): boolean {
    const entry = this.constraints.find((c) => c.id === id);
    if (!entry || entry.status !== 'active') return false;
    entry.status = 'removed';
    return true;
  }

  /** 换约束：旧条目标 superseded（不再作数），新约束带新 id 入册。新约束
   *  attachedNodes 缺省继承旧条目——管线按约束名查影响面时新旧都能命中；
   *  显式传空数组可切断继承。 */
  supersedeConstraint(
    id: string,
    next: Omit<ConstraintInput, 'attachedNodes'> & { attachedNodes?: string[] },
  ): ConstraintEntry | undefined {
    const entry = this.constraints.find((c) => c.id === id);
    if (!entry || entry.status !== 'active') return undefined;
    entry.status = 'superseded';
    return this.registerConstraint({
      ...next,
      attachedNodes: next.attachedNodes ?? [...entry.attachedNodes],
    });
  }

  // ── 副作用账 ──

  /** 工具完成回调落账入口（本期只建 API 不接线）。缺省补 id/ts，status 默认 done。 */
  recordSideEffect(input: SideEffectInput): SideEffectEntry {
    const entry: SideEffectEntry = {
      id: input.id ?? `se:${++this.sideEffectSeq}`,
      ts: input.ts ?? Date.now(),
      tool: input.tool,
      ...(input.callId ? { callId: input.callId } : {}),
      write: input.write,
      irreversible: input.irreversible,
      ...(input.target ? { target: input.target } : {}),
      compensable: input.compensable,
      status: input.status ?? 'done',
    };
    this.sideEffects.push(entry);
    return { ...entry };
  }

  /** 已落地、尚未处置的写副作用：改变/纠偏到达时按它清点现场。 */
  pendingWrites(): SideEffectEntry[] {
    return this.sideEffects.filter((se) => se.write && se.status === 'done').map((se) => ({ ...se }));
  }

  /** 一期处置口径「冻结 + 询问」：不可自动补偿（none/manual）或不可逆的写
   *  副作用就地冻结，返回冻结条目。auto 的留给二期三级补偿。 */
  freezeUncompensable(): SideEffectEntry[] {
    const frozen: SideEffectEntry[] = [];
    for (const se of this.sideEffects) {
      if (se.status !== 'done' || !se.write) continue;
      if (se.compensable === 'auto' && !se.irreversible) continue;
      se.status = 'frozen';
      frozen.push({ ...se });
    }
    return frozen;
  }

  // ── 生命周期 ──

  /** 整体换账：全量替换或按字段替换。测试注入与快照恢复共用这一入口。 */
  reset(input?: Partial<TaskStateStoreInput>): void {
    if (input?.script) this.script = input.script;
    if (input?.branches !== undefined) this.branches = input.branches;
    if (input?.constraints !== undefined) this.constraints = input.constraints.map(cloneConstraint);
    if (input?.sideEffects !== undefined) this.sideEffects = input.sideEffects.map((se) => ({ ...se }));
  }
}

function cloneConstraint(c: ConstraintEntry): ConstraintEntry {
  return { ...c, attachedNodes: [...c.attachedNodes] };
}
