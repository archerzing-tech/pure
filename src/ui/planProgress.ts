import type { Plan } from '../coding-agent/types';

export type PlanProgressStatus = 'active' | 'waiting' | 'complete';

export interface PlanProgressSnapshot {
  plan: Plan;
  currentPlan: number;
  currentTodo: number;
  status: PlanProgressStatus;
  /** True when this plan was approved as a project build — the per-phase
   * delivery-gate (real verification evidence) applies to its continuations. */
  projectBuild?: boolean;
  /** 本会话内第几个独立规划（1、2、…）。同一规划的细化（planReplaced）与
   * 续跑沿用同一编号；只有对话里新生成的规划递增。用于区分「第 1 份规划」
   * 与「第 2 份规划（因反馈而来）」——它们不是同一件事。 */
  planSeq?: number;
  /** 触发本次规划的用户输入（仅新规划携带）。卡头据此展示「因为你提到：…」，
   * 让新一轮规划一眼看出与上面的规划不同。 */
  reason?: string;
}

export type PlanProgressEvent =
  | { type: 'planReplaced'; plan: Plan }
  | { type: 'statusChanged'; status: PlanProgressStatus }
  | { type: 'phaseStarted'; planNumber: number }
  | { type: 'phaseJumped'; planNumber: number }
  | { type: 'todoStarted'; todoNumber: number }
  | { type: 'todoCompleted'; todoNumber: number }
  | { type: 'todosCompleted'; force?: boolean }
  | { type: 'completed' };

export type PlanProgressListener = (snapshot: PlanProgressSnapshot) => void;
export type PlanProgressPersistenceListener = (snapshot: PlanProgressSnapshot) => void | Promise<void>;
export interface PlanProgressSubscribeOptions {
  emitCurrent?: boolean;
}

export class PlanProgressModel {
  private state: PlanProgressSnapshot;
  private readonly listeners = new Set<PlanProgressListener>();
  private readonly persistenceListeners = new Set<PlanProgressPersistenceListener>();
  private startedTodo: number | null = null;

  constructor(
    plan: Plan,
    status: PlanProgressStatus = 'active',
    currentPlan = 1,
    currentTodo = 1,
    projectBuild = false,
    planSeq = 1,
    reason?: string,
  ) {
    const complete = status === 'complete' || currentPlan > plan.steps.length;
    this.state = {
      plan,
      currentPlan: complete ? plan.steps.length + 1 : Math.max(1, Math.min(currentPlan, plan.steps.length + 1)),
      currentTodo: complete
        ? (plan.steps[plan.steps.length - 1]?.substeps?.length ?? 0) + 1
        : Math.max(1, currentTodo),
      status: complete ? 'complete' : status,
      projectBuild,
      planSeq,
      reason,
    };
  }

  static fromSnapshot(snapshot: PlanProgressSnapshot): PlanProgressModel {
    return new PlanProgressModel(
      snapshot.plan,
      snapshot.status,
      snapshot.currentPlan,
      snapshot.currentTodo,
      snapshot.projectBuild === true,
      snapshot.planSeq ?? 1,
      snapshot.reason,
    );
  }

  getSnapshot(): PlanProgressSnapshot {
    return { ...this.state };
  }

  subscribe(listener: PlanProgressListener, options: PlanProgressSubscribeOptions = {}): () => void {
    this.listeners.add(listener);
    if (options.emitCurrent !== false) listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  subscribePersistence(listener: PlanProgressPersistenceListener, options: PlanProgressSubscribeOptions = {}): () => void {
    this.persistenceListeners.add(listener);
    if (options.emitCurrent !== false) void Promise.resolve(listener(this.getSnapshot())).catch(() => {});
    return () => this.persistenceListeners.delete(listener);
  }

  dispatch(event: PlanProgressEvent): void {
    switch (event.type) {
      case 'planReplaced':
        this.applyPlanReplaced(event.plan);
        return;
      case 'statusChanged':
        this.applyStatusChanged(event.status);
        return;
      case 'phaseStarted':
        this.applyPhaseStarted(event.planNumber);
        return;
      case 'phaseJumped':
        this.applyPhaseJumped(event.planNumber);
        return;
      case 'todoStarted':
        this.applyTodoStarted(event.todoNumber);
        return;
      case 'todoCompleted':
        this.applyTodoCompleted(event.todoNumber);
        return;
      case 'todosCompleted':
        this.applyTodosCompleted(event.force === true);
        return;
      case 'completed':
        this.applyCompleted();
        return;
    }
  }

  isTodoStarted(todoNumber = this.state.currentTodo): boolean {
    return this.startedTodo === todoNumber;
  }

  canCompleteCurrentTodos(): boolean {
    const { currentPlan, currentTodo, plan } = this.state;
    const rows = plan.steps[currentPlan - 1]?.substeps ?? [];
    return currentPlan > plan.steps.length
      || plan.steps[currentPlan - 1]?.todosRequired === false
      || rows.length === 0
      || currentTodo > rows.length;
  }

  private applyPlanReplaced(plan: Plan): void {
    const currentPlan = Math.max(1, Math.min(this.state.currentPlan, plan.steps.length + 1));
    const todoTotal = plan.steps[currentPlan - 1]?.substeps?.length ?? 0;
    this.startedTodo = null;
    // Spread the previous state first so plan-level flags (projectBuild) and
    // any future metadata survive a refinement upgrade.
    this.commit({
      ...this.state,
      plan,
      currentPlan,
      currentTodo: Math.min(Math.max(1, this.state.currentTodo), todoTotal + 1),
      status: currentPlan > plan.steps.length ? 'complete' : this.state.status,
    });
  }

  private applyStatusChanged(status: PlanProgressStatus): void {
    if (status === 'complete') {
      this.applyCompleted();
      return;
    }
    this.commit({ ...this.state, status });
  }

  private applyPhaseStarted(planNumber: number): void {
    const total = this.state.plan.steps.length;
    const requestedPlan = Math.max(1, Math.min(planNumber, total + 1));
    if (requestedPlan !== this.state.currentPlan + 1 || !this.canCompleteCurrentTodos()) return;
    this.startedTodo = null;
    this.commit({
      ...this.state,
      currentPlan: requestedPlan,
      currentTodo: 1,
      status: requestedPlan > total ? 'complete' : this.state.status === 'waiting' ? 'waiting' : 'active',
    });
  }

  private applyPhaseJumped(planNumber: number): void {
    const total = this.state.plan.steps.length;
    const requestedPlan = Math.max(1, Math.min(planNumber, total + 1));
    const currentPlan = Math.max(this.state.currentPlan, requestedPlan);
    this.startedTodo = null;
    this.commit({
      ...this.state,
      currentPlan,
      currentTodo: 1,
      status: currentPlan > total ? 'complete' : this.state.status === 'waiting' ? 'waiting' : 'active',
    });
  }

  private applyTodoStarted(todoNumber: number): void {
    const total = this.state.plan.steps[this.state.currentPlan - 1]?.substeps?.length ?? 0;
    if (total === 0 || todoNumber !== this.state.currentTodo) return;
    this.startedTodo = todoNumber;
    this.commit({ ...this.state });
  }

  private applyTodoCompleted(todoNumber: number): void {
    const total = this.state.plan.steps[this.state.currentPlan - 1]?.substeps?.length ?? 0;
    if (total === 0 || todoNumber < 1 || todoNumber > total || todoNumber !== this.state.currentTodo) return;
    this.startedTodo = null;
    this.commit({
      ...this.state,
      currentTodo: todoNumber + 1,
      status: this.state.status === 'waiting' ? 'waiting' : 'active',
    });
  }

  private applyTodosCompleted(force: boolean): void {
    const total = this.state.plan.steps[this.state.currentPlan - 1]?.substeps?.length ?? 0;
    if (!force && this.state.currentTodo <= total) return;
    this.startedTodo = null;
    this.commit({ ...this.state, currentTodo: total + 1 });
  }

  private applyCompleted(): void {
    this.startedTodo = null;
    this.commit({
      ...this.state,
      currentPlan: this.state.plan.steps.length + 1,
      currentTodo: (this.state.plan.steps[this.state.plan.steps.length - 1]?.substeps?.length ?? 0) + 1,
      status: 'complete',
    });
  }

  private commit(next: PlanProgressSnapshot): void {
    this.state = next;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
    for (const listener of this.persistenceListeners) {
      void Promise.resolve(listener(snapshot)).catch(() => {});
    }
  }
}

/**
 * Decide whether a normally-finished, tool-bearing turn should advance the plan
 * cursor by one stage. `completedPlan` is the plan number whose
 * `## 计划 n 已完成` marker already advanced the cursor this turn (null when
 * none did). When the cursor already moved past a completed stage
 * (`currentPlan === completedPlan + 1`), advancing again would skip the next
 * stage — so the fallback only fires when the stage just worked on still needs
 * an implicit push.
 */
export function shouldAdvancePlanAtTurnEnd(
  planFinished: boolean,
  snapshot: PlanProgressSnapshot | undefined,
  completedPlan: number | null,
): boolean {
  if (!planFinished || !snapshot) return false;
  if (snapshot.currentPlan >= snapshot.plan.steps.length) return false;
  const markerAdvanced = completedPlan !== null
    && snapshot.currentPlan === completedPlan + 1;
  return !markerAdvanced;
}
