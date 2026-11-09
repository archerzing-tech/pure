// src/shared/capabilityFacts.ts
// W1b-4 能力事实送达（2026-11-04）。蓝图点名的两难——「首回合注入 ability 行
// 会动缓存前缀 vs 等具体事件推到眼前」——裁定走事件驱动：注入走 envFacts 区
// （formValidationFeedback 同款「事件→装配时读走」通道，user-turn 动态层，不碰
// system 稳定前缀），无常驻行。理由：能力事实在 90% 的回合无关紧要，常驻注入
// 是死重量；事件把事实送到决策点——传图那一刻、切换后首回合，正是模型要做
// 能力判断的瞬间。「可查」通道已有（sys_info 现状行），事件只补「该可见而
// 不可见」的时刻。
// 事件源 v1 两个：
//   1. 带图回合 × 视觉能力非确认支持——支持（known&&supported）零注入（预期
//      行为无需说）；其余一律 unknown 式措辞「读不到就直说、别假装看到」。
//      manifest 纪律是「未命中≠不支持」（VISION_TRAIT_RULES 只知已知支持），
//      所以不存在 known&&false 形态，不写强警告分支——将来 manifest 引入显式
//      否定规则时再加回，那时分支才是活的。
//   2. 模型切换后首回合——上一回合对自己的能力假设不再适用，一行新模型事实
//      （复用 modelCapabilitySummary 的一行 ASCII 摘要）。首回合（无前值）不注：
//      每会话第一条都注=变相常驻。
// 推理参数不设事件源：effort 是请求参数，不是模型盲区。CLI 无图输入、模型随
// 启动固定，两面都无事件源 → CLI 零接线。
// lastSentModelKey 由频道保存（「上次实际发出的 provider::model」），装配时算出
// currentKey 供频道回写——key 只在请求真正装配时推进，配置改了但没发话不触发。

import { modelCapabilitySummary, resolveModelCapability } from './modelCapabilities';
import { probedCapabilityKey } from './capabilityProbe';

export interface CapabilityTurnFactsInput {
  /** 本回合用户消息附带的图片数（0=无图）。 */
  imageCount: number;
  provider?: string;
  model?: string;
  /** 频道保存的「上次实际发出的 provider::model」；缺省=首回合。 */
  lastSentModelKey?: string;
}

/** 按当回合事件形状算能力事实行（空串=零注入）。currentKey 供频道在请求
 *  真正装配后回写 lastSentModelKey。 */
export function capabilityTurnFacts(input: CapabilityTurnFactsInput): { facts: string; currentKey: string } {
  const currentKey = probedCapabilityKey(input.provider ?? '', input.model ?? '');
  const parts: string[] = [];
  if (input.imageCount > 0) {
    const vision = resolveModelCapability(input.provider ?? '', input.model ?? '').vision;
    // 支持是预期行为：图能读到，无需说——只把「非确认支持」当事件。
    // 措辞跟随 manifest 纪律：未命中≠不支持，只说「读不到就直说」。
    if (!(vision.known && vision.supported)) {
      const name = input.model || 'the current model';
      parts.push(`Capability fact: vision support of ${name} is unknown — if you cannot read the ${input.imageCount} image(s) attached this turn, say so plainly and suggest switching to a vision-capable model; do not pretend to describe them.`);
    }
  }
  if (input.lastSentModelKey && input.lastSentModelKey !== currentKey) {
    const cap = resolveModelCapability(input.provider ?? '', input.model ?? '');
    parts.push(`Capability fact: the model just changed to ${currentKey} (${modelCapabilitySummary(cap)}). Assumptions about your own abilities from earlier turns no longer apply.`);
  }
  return { facts: parts.join('\n'), currentKey };
}
