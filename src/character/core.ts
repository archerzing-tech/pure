// src/character/core.ts
// 性格内核（Character Core）的装配面：源句类型 + 注入文本装配（人格轨道 刀 2）。
//
// 内核是第 0 层，decision（怎么做）与 expression（怎么说）都是从它派生的投影
// （docs/persona-core-upgrade.md §1）。本模块只做两件事：
//   1. 定义源句表与 id 的类型（`CharacterKernelLineId` / `CharacterKernelLines`）；
//   2. 把源句装配成注入 system prompt 的精炼版（fragment `character_core`）。
//
// 铁律 1（投影必须标注推导来源）的机制面在两处：
//   · TS 侧：`CharacterProfile.decisionDerivation` 是
//     `Record<keyof CharacterDecisionProfile, readonly CharacterKernelLineId[]>`，
//     少标一个旋钮编译不过；
//   · 测试侧：每个被引用的 id 必须在源句表里存在，且源句表与本内核的 .md
//     人读镜像逐字同文（见 __tests__/characterCore.test.ts）。
//   · 反过来不要求：不被任何旋钮引用的源句是**内核通道**的长尾素材（强模型在
//     参数没盖住的情境里按性格外推，蓝图铁律 2），不强制有投影。
//
// 本模块是叶子：不 import 任何 ui / coding-agent / shared 运行时模块，避免环。

/**
 * 内核源句 id（K1…Kn）。合法取值由各内核自己的源句表声明，测试守引用有效性。
 * 刻意不做成联合类型：多内核（刀 5）各有各的源句表，类型不能押在某一个内核上。
 */
export type CharacterKernelLineId = string;

/** 源句表：id → 一句话。对象键序即注入顺序。 */
export type CharacterKernelLines = Readonly<Record<string, string>>;

/**
 * 把源句表装配成注入文本。框架句做两件事：说明这段是**你的性格**（不是可照抄
 * 的清单），以及钉住优先级——协议是物理定律、性格是人品，冲突时协议赢（蓝图
 * §4 红线 3）。逐条源句不带上 K 编号：编号是给推导表与测试用的，对模型是噪声。
 *
 * 精炼版而非全文：全文（kernels/<id>.md）是人读源（含推导表与红线对齐），
 * prompt 里只放行为面。
 */
export function buildCharacterCorePrompt(lines: CharacterKernelLines): string {
  const body = Object.values(lines)
    .map((text) => `- ${text}`)
    .join('\n');
  // 引导句刻意压在两句内（刀 6 起源句多了一条，2000 字符上限是硬断言）：
  // ① 这是你的性格、每个决策都从它派生，不是可照抄的清单；② 协议是物理定律、
  // 性格是人品，冲突时协议赢。语义与刀 2 原句逐点等价，只砍冗余措辞。
  return `<character_core>
This is who you are: how much you verify, when you stop to ask, how you speak — every decision and every sentence below is derived from it. Treat it as who you are, not a checklist to cite back.
The protocols are physics; this is personality — where they touch, the protocol wins.
${body}
</character_core>`;
}
