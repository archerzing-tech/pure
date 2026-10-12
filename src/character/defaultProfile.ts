// src/character/defaultProfile.ts
// 默认性格内核「老手快线」（v0）——整条轨道的安全底：
// **决策面的每个值 = 现行为原样**，只是把散在各处的旋钮收拢到一处。默认激活它时
// 行为逐字节不变（由全量 TS 套 + 本目录单测共同守）。
//
// 刀 2 起新增三样（决策面的值不变，仍是零行为变更）：
//   · `core` / `kernelLines`：内核叙事（kernels/veteranFast.ts），注入 system prompt；
//   · `decisionDerivation`：铁律 1 —— 每个旋钮标注派生它的内核源句 id；
//   · `expression.scenarios`（刀 3）：表达面五场景账，同样标注源句。
//     数值**暂时**沿用刀 1 的现行为值：内核叙事是按既定产品立场写的，二者自洽；
//     要改任何一个数值就是行为变更，须走蓝图 §4 的探针闸门（刀 4），不能顺手调。
//
// 值的出处（改这里前先对回原处，保持零行为变更）：
//   permissionMode / autoApprove  ← src/ui/config.ts 默认配置
//   planAtComplexity / complexFileThreshold ← src/coding-agent/Planner.ts detectMode
//   maxVerificationItems ← Planner.MAX_PLAN_VERIFICATION_ITEMS
//   maxPlanSteps / maxPlanSubsteps ← Planner.MAX_PLAN_STEPS / MAX_PLAN_SUBSTEPS
//   maxSubagentRoles ← src/shared/adaptiveControl.ts MAX_SUBAGENT_ROLES
//   confidenceGate ← src/coding-agent/inputDecision.ts INPUT_DEFAULT_CONFIDENCE
//
// 刀 3 起 `expression.scenarios` 不再是空壳：五个场景的表达投影落在
// kernels/veteranFastExpression.ts（义务 / 禁止进 prompt，例句只进 .md 人读账），
// 由 buildCharacterExpressionPrompt 装配成 fragment `character_expression`。

import type { CharacterProfile } from './types';
import { VETERAN_FAST_CORE_PROMPT, VETERAN_FAST_LINES, VETERAN_FAST_KERNEL_VERSION } from './kernels/veteranFast';
import { VETERAN_FAST_SCENARIOS } from './kernels/veteranFastExpression';

/**
 * 默认内核的稳定 id。单独命名（而不是在下面字面量里写第二遍）是因为
 * registry.ts / 配置迁移 / GUI 选择器都要引用它——一处改名，全链路跟着走。
 */
export const DEFAULT_CHARACTER_PROFILE_ID = 'veteran-fast';

/** 「老手快线」：效率优先，坏消息直说，少弹卡，资深结对同事。 */
export const DEFAULT_CHARACTER_PROFILE: CharacterProfile = {
  id: DEFAULT_CHARACTER_PROFILE_ID,
  version: VETERAN_FAST_KERNEL_VERSION,
  name: '老手快线',
  description: '效率优先：小步快跑、坏消息直说、少弹卡（默认内核）。',
  core: VETERAN_FAST_CORE_PROMPT,
  kernelLines: VETERAN_FAST_LINES,
  decision: {
    modeThreshold: {
      planAtComplexity: 'complex',
      complexFileThreshold: 3,
    },
    verifyDensity: {
      maxVerificationItems: 8,
    },
    stepSize: {
      maxPlanSteps: 10,
      maxPlanSubsteps: 8,
    },
    confirmTendency: {
      permissionMode: 'auto',
      autoApprove: {
        read: true,
        write: true,
        cmd: true,
        git: true,
      },
    },
    reportRhythm: 'meaningful-nodes-only',
    parallelTendency: {
      maxSubagentRoles: 4,
    },
    insertionThreshold: {
      confidenceGate: 0.7,
    },
  },
  // 铁律 1：每个旋钮的内核源句。理由与推导链见 kernels/veteran-fast.md §三。
  decisionDerivation: {
    modeThreshold: ['K2'],
    verifyDensity: ['K5', 'K2'],
    stepSize: ['K2'],
    confirmTendency: ['K3'],
    reportRhythm: ['K9', 'K4'],
    parallelTendency: ['K10', 'K2'],
    insertionThreshold: ['K2', 'K3'],
  },
  // 表达面（投影 B，刀 3）：五场景的义务 / 禁止 / 源句，见 kernels/veteran-fast-expression.md。
  expression: {
    scenarios: VETERAN_FAST_SCENARIOS,
  },
};
