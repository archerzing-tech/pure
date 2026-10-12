// src/character/craftsmanProfile.ts
// 第二个性格内核「工匠慢线」（人格轨道 刀 5，2026-10-12）。
//
// 与 defaultProfile.ts 的分工：那个是**默认内核**（老手快线，值 = 现行为原样，
// 整条轨道的安全底）；这个是**高危第二内核**——蓝图 §4 红线 4 划定的「先方案后
// 动手、步步验证、多确认」，只在该内核被显式激活时生效，不改全局默认。
//
// 因此这里的决策面值**刻意不等于**老手快线（否则第二个内核就是个同义词）：
//   · 简单任务也先规划 + 1 个文件证据即算复杂 → Planner 更早铺计划
//   · 收尾验证清单上限放宽到 12 条 → 验得更密
//   · 计划 6 步 / 子步骤 5 → 步子更小
//   · 默认 confirm 且读写跑全不自动批准 → 每一步都过用户的手
//   · 逐阶段交代 / 并行上限降到 2 / 插话置信门抬到 0.85 → 少并行、多问
// 每个值的内核出处见 kernels/craftsman-slow.md §三（铁律 1）。
//
// 值的语义边界（别误读成「不改用法就生效」）：
//   · Planner 的三个上限（步子/验证条数）与 mode 阈值、并行角色上限、插话置信门
//     是**结构通道**，由调用方在本文件之外逐次读 `activeCharacterProfile()` 得到，
//     所以切内核即刻生效（懒读，见 src/coding-agent/Planner.ts 等）。
//   · `confirmTendency` 是**默认值通道**：它只为「用户自己没设过」的配置项提供
//     默认（GUI `defaults()` / CLI `DEFAULT_CLI_AUTO_APPROVE`）。用户显式设过的
//     权限模式与自动批准开关永远优先——内核不覆盖人的决定。
//   · `reportRhythm` 只进 prompt（蓝图 §1 的 🔴 档），没有结构钩子。

import type { CharacterProfile } from './types';
import { CRAFTSMAN_SLOW_CORE_PROMPT, CRAFTSMAN_SLOW_KERNEL_VERSION, CRAFTSMAN_SLOW_LINES } from './kernels/craftsmanSlow';
import { CRAFTSMAN_SLOW_SCENARIOS } from './kernels/craftsmanSlowExpression';

/** 「工匠慢线」：先方案后动手、步步验证、多确认。高危，需显式激活。 */
export const CRAFTSMAN_SLOW_PROFILE: CharacterProfile = {
  id: 'craftsman-slow',
  version: CRAFTSMAN_SLOW_KERNEL_VERSION,
  name: '工匠慢线',
  description: '先方案后动手、步步验证、多确认；每一步都过你的手（慢，但可回退）。',
  core: CRAFTSMAN_SLOW_CORE_PROMPT,
  kernelLines: CRAFTSMAN_SLOW_LINES,
  decision: {
    modeThreshold: {
      planAtComplexity: 'simple',
      complexFileThreshold: 1,
    },
    verifyDensity: {
      maxVerificationItems: 12,
    },
    stepSize: {
      maxPlanSteps: 6,
      maxPlanSubsteps: 5,
    },
    confirmTendency: {
      permissionMode: 'confirm',
      autoApprove: {
        read: false,
        write: false,
        cmd: false,
        git: false,
      },
    },
    reportRhythm: 'stage-by-stage',
    parallelTendency: {
      maxSubagentRoles: 2,
    },
    insertionThreshold: {
      confidenceGate: 0.85,
    },
  },
  // 铁律 1：每个旋钮的内核源句。理由与推导链见 kernels/craftsman-slow.md §三。
  decisionDerivation: {
    modeThreshold: ['C2'],
    verifyDensity: ['C3', 'C4'],
    stepSize: ['C4'],
    confirmTendency: ['C5'],
    reportRhythm: ['C2', 'C6'],
    parallelTendency: ['C4'],
    insertionThreshold: ['C5'],
  },
  // 表达面（投影 B）：五场景的义务 / 禁止 / 源句，见 kernels/craftsman-slow-expression.md。
  expression: {
    scenarios: CRAFTSMAN_SLOW_SCENARIOS,
  },
};
