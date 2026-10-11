// src/character/expression.ts
// 性格内核的表达面（投影 B）——「怎么说」的装配面（人格轨道 刀 3，2026-10-11）。
//
// 内核是第 0 层，表达面与决策面都是它的投影（docs/persona-core-upgrade.md §1）。
// 本模块只做三件事：
//   1. 定场景表结构：`CharacterScenarioId`（五个高权重场景）与每个场景的
//      义务（obligation）/ 禁止（forbidden）/ 内核源句（derivedFrom）；
//   2. 把场景表装配成注入 system prompt 的精炼版（fragment `character_expression`）；
//   3. 钉死表达面红线（蓝图 §4 红线 1/2/3 在「怎么说」上的落点）。
//
// **为什么 prompt 里是义务而不是例句**（2026-10-11 用户定案；与
// src/shared/promptLayers.ts:245 的既有立场一致）：
// 写进 prompt 的「好例句」会被模型逐字复用，成为下一代机器腔——`HUMAN_TONE_PROMPT`
// 与 `COMPLEX_TASK_PROTOCOL_PROMPT` 都因此只写原则。所以：**义务与禁止进 prompt，
// 例句只进人读账**（kernels/<id>-expression.md），供刀 4 的判例集与人工抽查取用。
// 由 `__tests__/characterExpression.test.ts` 守：人读账里的例句一旦出现在注入文本里即红。
//
// 铁律 1（投影必须标注来源）的机制面：
//   · TS 侧：`CharacterScenarioLedger` 是 `Record<CharacterScenarioId, …>`，
//     少写一个场景编译不过；每个场景的 `derivedFrom` 必须非空（测试守 id 真存在）。
//   · 镜像侧：义务 / 禁止 / 源句 / 红线清单必须与 .md 人读账逐字同文。
//
// 本模块是叶子：只从 ./core 取源句 id 的类型，不 import 任何 ui / coding-agent /
// shared 运行时模块，避免环。

import type { CharacterKernelLineId } from './core';

/**
 * 高权重场景。（刀 3 的五个场景 = 蓝图 §3 刀 3 的五项；id 是稳定契约，
 * 存进 .md 的例句块标记里，改名等于改镜像契约。）
 */
export type CharacterScenarioId =
  /** 失败怎么报：坏了 / 没跑通 / 被打断时怎么开口。 */
  | 'failure-report'
  /** 等待怎么陪：长活在跑、没有可报的结果时怎么处置这段空档。 */
  | 'waiting'
  /** 打断怎么歉：用户中途插话（或我们必须打断他们）时怎么交代。 */
  | 'interruption'
  /** 交付怎么交代限制：交回成果时怎么说清「到此为止」在哪。 */
  | 'handover-limits'
  /** 拒绝怎么给台阶：不同意 / 不做某件事时怎么给下一步。 */
  | 'refusal';

/** 一个场景的表达投影——义务与禁止进 prompt，例句只在人读账里。 */
export interface CharacterScenarioProjection {
  /** prompt 里的场景标签（短，一行一条）。 */
  label: string;
  /** 该场景该怎么做。原则式义务，**不是可照抄的句子**。 */
  obligation: string;
  /** 该场景明令禁止什么（红线在本场景的落点）。 */
  forbidden: readonly string[];
  /** 铁律 1：派生本场景的内核源句 id，必须非空且真存在。 */
  derivedFrom: readonly CharacterKernelLineId[];
}

/**
 * 场景账：`Record` 而非数组——少写一个场景是编译错误，与决策面的
 * `decisionDerivation` 同等强度。这里没有另立一张 `expressionDerivation`
 * 表：场景条目本身就是对象，出处可以直接挂在它身上，不必再加一层平行映射。
 */
export type CharacterScenarioLedger = Readonly<Record<CharacterScenarioId, CharacterScenarioProjection>>;

/**
 * 表达面红线（蓝图 §4 红线 1/2/3 的「怎么说」落点）。内核无关，故放在装配面
 * 而非某个内核里：换内核不改红线。逐条：
 *   · 红线 1（服务意识 ≠ 顺从）——谄媚话术禁；
 *   · 红线 2（禁止陪伴性话术）——『我是同事，不是陪伴』；
 *   · 既有立场（HUMAN_TONE_PROMPT）——罐头开场 / 收尾 / 编号脚手架禁；
 *   · 红线 3（协议权威不可越）——控制行字面量不得被改写或转述。
 */
export const EXPRESSION_RED_LINES: readonly string[] = [
  'flattery, agreement you do not mean, or enthusiasm you do not feel',
  'companionship talk — being there for the user, keeping them company; you are the colleague on this task, not a presence in their life',
  'a canned opener, a canned closer, or a numbered scaffold',
  'anything that edits, paraphrases, or talks around the control lines the interface requires',
];

/**
 * 把场景账装配成注入文本（fragment `character_expression`）。
 * 框架句做两件事：说明这些是**义务不是台词**（防逐字复用），以及钉住四条红线。
 */
export function buildCharacterExpressionPrompt(ledger: CharacterScenarioLedger): string {
  const lines = (Object.entries(ledger) as Array<[CharacterScenarioId, CharacterScenarioProjection]>)
    .map(([, scenario]) => `- ${scenario.label}: ${scenario.obligation} Not this: ${scenario.forbidden.join('; ')}.`)
    .join('\n');
  return `<character_expression>
How this character sounds in the five moments that carry the most weight. Each line is an obligation, not a line to reuse — say it in your own words; when a phrasing feels familiar, write a different one.
${lines}
Never, in any of these moments: ${EXPRESSION_RED_LINES.join('; ')}.
</character_expression>`;
}
