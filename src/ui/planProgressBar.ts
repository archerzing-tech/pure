// src/ui/planProgressBar.ts
// 会话内计划进度固定条：对话继续时，transcript 里的完整计划卡会滚出视口，
// 用户就看不到「走到第几步了」。这条固定在聊天区顶部的细条始终展示
// 当前规划身份（第几个规划）+ 当前第几步 + 整体进度，并一键跳回完整计划卡。
//
// 只针对当前这个对话：它随活动计划卡挂载/卸载（会话切换/新对话/计划取消即消失），
// 不跨会话残留。规划编号（planSeq）与计划卡头共用，planSeq>1 时强调显示
// 「新一轮规划」，明确与上面的规划不是同一件事。

import type { PlanProgressModel, PlanProgressSnapshot } from './planProgress';
import { t } from '../shared/i18n';

export type PlanPinState = 'active' | 'waiting' | 'complete';

export interface PlanPinInfo {
  /** 本会话内第几个独立规划（1、2、…）。 */
  seq: number;
  state: PlanPinState;
  /** 已完成（勾选）的顶层步骤数；complete 时等于 total。 */
  doneCount: number;
  total: number;
  /** 当前正在处理的步骤动作（complete 时为空）。 */
  currentStepAction: string;
}

/** 从进度快照提取固定条需要的信息（纯函数，可单测）。 */
export function formatPlanPin(snapshot: PlanProgressSnapshot): PlanPinInfo {
  const seq = snapshot.planSeq ?? 1;
  const total = snapshot.plan.steps.length;
  const complete = snapshot.status === 'complete' || snapshot.currentPlan > total;
  const state: PlanPinState = complete
    ? 'complete'
    : snapshot.status === 'waiting'
      ? 'waiting'
      : 'active';
  const doneCount = complete ? total : Math.max(0, Math.min(snapshot.currentPlan - 1, total));
  const currentStepAction = snapshot.plan.steps[snapshot.currentPlan - 1]?.action ?? '';
  return { seq, state, doneCount, total, currentStepAction };
}

function seqLabel(seq: number): string {
  return seq > 1
    ? t('plan.seqNew', '新一轮规划 {n}').replace('{n}', String(seq))
    : t('plan.seq', '规划 {n}').replace('{n}', String(seq));
}

function stateLabel(state: PlanPinState): string {
  switch (state) {
    case 'waiting':
      return t('plan.pin.state.waiting', '等待你的回复');
    case 'complete':
      return t('plan.pin.state.complete', '已完成');
    default:
      return t('plan.pin.state.active', '执行中');
  }
}

export interface PlanProgressPinHandle {
  el: HTMLElement;
  /** 绑定到进度模型并显示；重复 bind 会先解除旧订阅。 */
  bind(model: PlanProgressModel): void;
  /** 解除订阅并隐藏（元素仍可复用）。 */
  unbind(): void;
}

export interface PlanProgressPinOptions {
  /** 「回到完整计划」点击回调（通常滚动 transcript 到计划卡）。 */
  jumpTo?: () => void;
}

export function createPlanProgressPin(options: PlanProgressPinOptions = {}): PlanProgressPinHandle {
  const el = document.createElement('div');
  el.className = 'plan-progress-pin';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const seqChip = document.createElement('span');
  seqChip.className = 'plan-progress-pin-seq';

  const stateChip = document.createElement('span');
  stateChip.className = 'plan-progress-pin-state';

  const step = document.createElement('span');
  step.className = 'plan-progress-pin-step';

  const track = document.createElement('div');
  track.className = 'plan-progress-pin-track';
  track.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'plan-progress-pin-fill';
  track.appendChild(fill);

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'plan-progress-pin-jump';
  jump.textContent = '↧';
  jump.title = t('plan.pin.jump', '回到完整计划');
  jump.setAttribute('aria-label', t('plan.pin.jump', '回到完整计划'));
  jump.addEventListener('click', () => options.jumpTo?.());

  el.append(seqChip, stateChip, step, track, jump);

  let unsubscribe: (() => void) | null = null;

  const render = (snapshot: PlanProgressSnapshot): void => {
    const info = formatPlanPin(snapshot);
    seqChip.textContent = seqLabel(info.seq);
    seqChip.classList.toggle('is-new', info.seq > 1);
    stateChip.textContent = stateLabel(info.state);
    stateChip.className = `plan-progress-pin-state plan-progress-pin-state--${info.state}`;
    step.textContent = info.state === 'complete'
      ? t('plan.pin.done', '全部 {total} 步已完成').replace('{total}', String(info.total))
      : `${t('plan.pin.step', '第 {n}/{total} 步').replace('{n}', String(Math.min(info.doneCount + 1, info.total))).replace('{total}', String(info.total))}：${info.currentStepAction}`;
    const pct = info.total > 0 ? (info.doneCount / info.total) * 100 : 0;
    fill.style.width = `${Math.round(pct)}%`;
  };

  const handle: PlanProgressPinHandle = {
    el,
    bind(model: PlanProgressModel): void {
      unsubscribe?.();
      unsubscribe = model.subscribe(render);
      el.hidden = false;
    },
    unbind(): void {
      unsubscribe?.();
      unsubscribe = null;
      el.hidden = true;
    },
  };
  return handle;
}
