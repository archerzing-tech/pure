// src/coding-agent/delegationControl.ts
// S2 第二刀（P3-2 控制面抽出）— 委派控制面的宿主无关状态机：起飞闸挂号簿
// （取消/停支）、委派原始参数捕获（分支级续跑的凭据）、点名停支的匹配与派发。
//
// 此前这四本账散在 chat.ts 的字段里（pendingCancels / pendingBranchStops /
// delegationArgs / 三个操作闭包），CLI/通道宿主没有等价物——远程「停掉那支」
// 无从落地。本模块把状态与匹配原样抽出：匹配口径的单一真相已在
// steerTargeting（matchInFlightBranch / planTakeoffGate），这里只是有状态
// 容器 + 派发缝，不发明第二种语义。收执渲染、折入、steer 路由留在宿主。

import { matchInFlightBranch, planTakeoffGate, type InFlightBranch, type TakeoffBlock } from '../shared/steerTargeting';
import type { ToolCall } from '../shared/types';

/** 停支挂号（text + 展示名，收据用）。 */
export interface BranchStopEntry {
  text: string;
  label: string;
}

/** 委派原始参数（分支级续跑的凭据：同参重派命中 checkpoint）。 */
export interface DelegationArgsRecord {
  name: string;
  args: string;
}

/** 在飞支的匹配面（名字是代号，主题在任务书里）。 */
export interface LiveBranchView {
  callId: string;
  name: string;
  snippet: string;
}

export type BranchStopMode = 'abort' | 'pause';

export interface NamedStopResult {
  callId: string;
  label: string;
}

/** 从委派参数里提取任务书片段（匹配面用）。 */
function snippetFromArgs(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    const raw = parsed.prompt ?? parsed.task ?? parsed.question ?? parsed.topic ?? parsed.instructions;
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

export class DelegationControlPlane {
  private cancels: string[] = [];
  private branchStops: BranchStopEntry[] = [];
  /** callId → 原始参数。跨回合保留（续跑点名的是上一回合停下的支）。 */
  readonly delegationArgs = new Map<string, DelegationArgsRecord>();

  /** 取消挂号：话先挂上，委派批次出生时按区分词拦下。 */
  registerCancel(text: string): void {
    this.cancels.push(text);
  }

  /** 停支挂号：同一句只挂一次（重复挂没有意义，还会多拦）。 */
  registerBranchStop(text: string, label: string): void {
    if (!this.branchStops.some((s) => s.text === text)) this.branchStops.push({ text, label });
  }

  /** 回合收尾清空：残留的取消/停支挂号若跨回合，会拦下用户后来明确要
   * 「继续/再跑」的那支——那是新指令，挂号没资格否决它。delegationArgs
   * 不清（续跑点名的是历史支）。 */
  settleRound(): void {
    this.cancels = [];
    this.branchStops = [];
  }

  /**
   * 委派起飞闸。宿主在每个委派批次起飞前调用：先捕获原始参数（与有无
   * 挂号无关——续跑凭据的地基），再按区分词匹配兑现挂号（命中即拦、
   * 一次性消费）。返回被拦下的 callId 列表（空 = 放行）。
   *
   * 合成重派豁免（resume_/foldin_ 前缀）承载的是用户最新的话，挂号无权
   * 否决——与 settleRound 同源纪律：最新的指令永远赢。
   */
  gate(calls: readonly ToolCall[], subagentNames: ReadonlySet<string>): TakeoffBlock[] {
    for (const c of calls) {
      if (!subagentNames.has(c.function.name) || this.delegationArgs.has(c.id)) continue;
      this.delegationArgs.set(c.id, { name: c.function.name, args: c.function.arguments });
    }
    if (this.cancels.length === 0 && this.branchStops.length === 0) return [];
    const candidates = calls
      .filter((c) => subagentNames.has(c.function.name) && !c.id.startsWith('resume_') && !c.id.startsWith('foldin_'))
      .map((c) => ({ callId: c.id, name: c.function.name, snippet: snippetFromArgs(c.function.arguments) }));
    if (candidates.length === 0) return [];
    const { blocked, consumed } = planTakeoffGate(candidates, [...this.cancels], this.branchStops.map((s) => s.text));
    if (consumed.length > 0) {
      this.cancels = this.cancels.filter((t) => !consumed.includes(t));
      this.branchStops = this.branchStops.filter((s) => !consumed.includes(s.text));
    }
    return blocked;
  }

  /**
   * 点名停支：用区分词匹配器在在飞支里找出被点名的那支（只认只被一支
   * 含有的词，打平宁可不停），经 `act` 派发真停。点不到 = 返回 null，
   * 调用方退回取消折入——宁可折叠不误杀。停成功即挂上起飞闸（同回合
   * 重派的同目标支在出生点拦下）。
   */
  stopNamed(
    text: string,
    live: readonly LiveBranchView[],
    act: (callId: string, mode: BranchStopMode) => boolean,
    label: (name: string, callId: string) => string,
    mode: BranchStopMode = 'abort',
  ): NamedStopResult | null {
    const matched = matchInFlightBranch(text, live as InFlightBranch[]);
    if (!matched) return null;
    if (!act(matched.callId, mode)) return null;
    const branchLabel = label(matched.name, matched.callId);
    this.registerBranchStop(text, branchLabel);
    return { callId: matched.callId, label: branchLabel };
  }

  /** 诊断/收据叙述用。 */
  pendingCancelCount(): number {
    return this.cancels.length;
  }
}
