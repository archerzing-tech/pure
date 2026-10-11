// src/character/index.ts
// 性格内核（Character Core）的公开入口。
//
// 刀 1 立了决策面结构（值 = 现行为原样）；刀 2 补内核叙事与注入文本
// （kernels/veteranFast.ts）与投影推导标注（decisionDerivation），并由
// PromptAssembler 以 required fragment `character_core` 注入 system prompt；
// 刀 3 补表达面投影（kernels/veteranFastExpression.ts），同样经 PromptAssembler
// 注入（fragment `character_expression`）。
//
// 活跃内核的选择器（PureConfig 里的 characterProfileId）留到刀 5「第二内核」
// 接线：多内核之前只有一个候选，选择器没有可选的第二项，此刻不引入空壳配置。

import type { CharacterProfile } from './types';
import { DEFAULT_CHARACTER_PROFILE } from './defaultProfile';
import { buildCharacterExpressionPrompt } from './expression';

export type {
  CharacterProfile,
  CharacterDecisionProfile,
  CharacterDecisionDerivation,
  CharacterExpressionProfile,
  CharacterPermissionMode,
} from './types';
export type { CharacterKernelLineId, CharacterKernelLines } from './core';
export { buildCharacterCorePrompt } from './core';
export type { CharacterScenarioId, CharacterScenarioLedger, CharacterScenarioProjection } from './expression';
export { buildCharacterExpressionPrompt, EXPRESSION_RED_LINES } from './expression';
export { DEFAULT_CHARACTER_PROFILE } from './defaultProfile';
export {
  VETERAN_FAST_CORE_PROMPT,
  VETERAN_FAST_KERNEL_VERSION,
  VETERAN_FAST_LINES,
} from './kernels/veteranFast';
export {
  VETERAN_FAST_EXPRESSION_PROMPT,
  VETERAN_FAST_EXPRESSION_VERSION,
  VETERAN_FAST_SCENARIOS,
  VETERAN_FAST_SCENARIO_IDS,
} from './kernels/veteranFastExpression';

/**
 * 当前激活的性格内核。刀 1/2 阶段无选择器，恒为默认「老手快线」；
 * 刀 5 接 PureConfig 的活跃 id 时，这里变成唯一的读取点，调用方无需改动。
 */
export function activeCharacterProfile(): CharacterProfile {
  return DEFAULT_CHARACTER_PROFILE;
}

/**
 * 当前激活内核的注入文本 —— PromptAssembler（以及任何需要内核的宿主）的唯一
 * 读取点。与 activeCharacterProfile 同源，切换内核时只需改这一个函数。
 */
export function activeCharacterCore(): string {
  return activeCharacterProfile().core;
}

/**
 * 当前激活内核的**表达面**注入文本（fragment `character_expression`）——同样
 * 从 activeCharacterProfile() 派生：一次内核选择同时决定「怎么做」与「怎么说」
 * 的精炼版（蓝图 §0：两张投影必须同一出典，各自为政就会一眼假）。
 */
export function activeCharacterExpression(): string {
  return buildCharacterExpressionPrompt(activeCharacterProfile().expression.scenarios);
}
