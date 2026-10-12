// src/character/index.ts
// 性格内核（Character Core）的公开入口。
//
// 刀 1 立了决策面结构（值 = 现行为原样）；刀 2 补内核叙事与注入文本
// （kernels/veteranFast.ts）与投影推导标注（decisionDerivation），并由
// PromptAssembler 以 required fragment `character_core` 注入 system prompt；
// 刀 3 补表达面投影（kernels/veteranFastExpression.ts），同样经 PromptAssembler
// 注入（fragment `character_expression`）；刀 4 立了变更闸门（eval:character）。
//
// 刀 5 起有第二个内核（工匠慢线）与选择器：名册在 ./registry.ts，活跃状态在
// ./active.ts（宿主启动时读配置注入），漂移探针在 ./drift.ts。三条装配路径
// （GUI / CLI / 通道）与子代理继承都只读本入口导出的函数，所以「换内核」只需要
// 改一处状态（见 active.ts 的分工说明）。
//
// 本文件只是转发面：不含状态、不含逻辑，所以它 re-export 谁都不会成环。

import { activeCharacterProfile } from './active';
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

// 活跃状态（选择器）：宿主启动注入 + 三个读取点。
export {
  activeCharacterProfile,
  activeCharacterProfileId,
  resetActiveCharacterProfile,
  setActiveCharacterProfile,
} from './active';

// 名册：id → profile 的解析与列举。
export { DEFAULT_CHARACTER_PROFILE } from './defaultProfile';
export { DEFAULT_CHARACTER_PROFILE_ID } from './registry';
export { CRAFTSMAN_SLOW_PROFILE } from './craftsmanProfile';
export {
  CHARACTER_PROFILES,
  characterProfileIds,
  isCharacterProfileId,
  listCharacterProfiles,
  resolveCharacterProfile,
} from './registry';

// 内核与表达面的运行时源（人读镜像在各自的 kernels/<id>.md）。
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
export {
  CRAFTSMAN_SLOW_CORE_PROMPT,
  CRAFTSMAN_SLOW_KERNEL_VERSION,
  CRAFTSMAN_SLOW_LINES,
} from './kernels/craftsmanSlow';
export {
  CRAFTSMAN_SLOW_EXPRESSION_PROMPT,
  CRAFTSMAN_SLOW_EXPRESSION_VERSION,
  CRAFTSMAN_SLOW_SCENARIOS,
  CRAFTSMAN_SLOW_SCENARIO_IDS,
} from './kernels/craftsmanSlowExpression';

// 漂移探针（长会话人格漂移的触发时机 / 判定口径 / 成本，见 drift.ts 头注释）。
export type { DriftGoldenProbe, DriftGuardOptions, DriftReport, DriftTurnInput } from './drift';
export {
  CharacterDriftGuard,
  DRIFT_GOLDEN_PROBES,
  DRIFT_MAX_PROBES_PER_SESSION,
  DRIFT_PROBE_EVERY_TURNS,
  DRIFT_TURN_EXPECTATIONS,
  gradeDriftTurn,
  nextGoldenProbe,
  shouldRunGoldenProbe,
} from './drift';

/**
 * 当前激活内核的注入文本 —— PromptAssembler（以及任何需要内核的宿主）的唯一
 * 读取点。与 activeCharacterProfile 同源，切换内核时只改 active.ts 的状态。
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
