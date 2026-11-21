// src/shared/turnNoteBudget.ts
// 回合内机制提醒的节流（2026-11-21）。
//
// 背景：引擎里 21 处 internal 注入（`grep -n "internal: true"` 除注释外）里，
// 一半是**事实**（工具结果、下层约定、后台支结算、流超时现状），另一半是**给
// 模型的行为指令**（失败阶梯的 hint、退化说明、并行建议、验证失败反馈、
// continueGuard 提醒）。指令型里有相当一部分会在接连几轮里重复同一段文字：
// 一次没修完的验证每轮都报同一句 feedback，退化说明同一失败每次重试都重发，
// 并行建议每个配平点都拉一条。这些重复不增信息，只增 token 和「再想一轮」的
// 推力——正是用户说的「过度思考」的机械来源。
//
// 口径：按**原文**去重，K 轮内同一段指令只发一次；内容不同的照发。不去重
// 事件型提醒（流恢复提示、握手指令、失败阶梯每一级的新 hint）——那些是「此刻
// 必须知道」的机制指令，吞掉会让模型在断流/终止边缘失去唯一的说明。事实型
// 一律放行：事实的重复本身就是信号（同一结果出现两次 = 世界没变）。
//
// K 默认 2（相邻两轮同文只发一次）；`PURE_TURN_NOTE_GAP=0` 关掉节流以回退到
// 每次注入。这个数没有实测基线支撑（不像 turnProgress 的 3/6），取 2 是最保守
// 的「去掉紧邻重复」，要更激进得先量每个注入口每回合实际命中次数。

/** 同文指令在 K 轮内只发一次的默认间隔。 */
export const TURN_NOTE_GAP = 2;

export type TurnNoteKind = 'fact' | 'instruction';

export interface TurnNoteBudget {
  /**
   * 决定这段文本是否该注入这一轮。返回空串 = 本轮已有同文，跳过。
   * `round` 用引擎的回合号（StateChange → THINK 的计数）。
   */
  note(kind: TurnNoteKind, text: string, round: number): string;
}

export function turnNoteGap(): number {
  if (typeof process === 'undefined') return TURN_NOTE_GAP;
  const raw = process.env?.PURE_TURN_NOTE_GAP;
  if (raw === undefined) return TURN_NOTE_GAP;
  const parsed = Number.parseInt(raw, 10);
  // 0 / 1 = 不节流（同轮内仍按同文去重一次，避免同一轮推两条一模一样的）。
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : TURN_NOTE_GAP;
}

/** 归一：空白差异不算新指令（引擎里同一提示字面量稳定，归一只是防守）。 */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function createTurnNoteBudget(): TurnNoteBudget {
  const gap = turnNoteGap();
  const lastRoundByText = new Map<string, number>();
  return {
    note(kind: TurnNoteKind, text: string, round: number): string {
      if (!text.trim()) return '';
      if (kind === 'fact') return text;
      const key = normalize(text);
      const lastRound = lastRoundByText.get(key);
      if (lastRound !== undefined && round - lastRound < Math.max(gap, 1)) return '';
      lastRoundByText.set(key, round);
      // 账不能随回合无限长：超过 64 条就把最老的挤出去（一回合的指令种类有限）。
      if (lastRoundByText.size > 64) {
        const oldest = [...lastRoundByText.entries()].sort((left, right) => left[1] - right[1])[0];
        if (oldest) lastRoundByText.delete(oldest[0]);
      }
      return text;
    },
  };
}
