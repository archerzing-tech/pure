// src/character/types.ts
// 人格轨道 刀 1（2026-10-11）— 性格内核（Character Core）的结构定义。
//
// 命名裁定（见 docs/persona-core-upgrade.md §1）：「persona」专指子代理角色层
// （src/harness/personaOverlays.ts），本模块是**智能体自身**的性格内核，叫
// Character Core，目录 src/character/。
//
// 设计：性格内核是第 0 层，decision（怎么做）与 expression（怎么说）都是从它
// 派生的投影。刀 1 只立结构、值全部等于现行为原样（零行为变更）；刀 2 起才从
// 内核叙事推导这些值。铁律 1：每个值都要能标注「从内核哪一句推导」。
//
// 本模块是叶子：不 import 任何 ui / coding-agent / shared 运行时模块，避免环；
// 只从 ./core 取源句的类型（core 也是叶子）。

import type { CharacterKernelLineId, CharacterKernelLines } from './core';
import type { CharacterScenarioLedger } from './expression';

/** 权限模式字面量（与 PureConfig.permissionMode 同形；此处是内核侧的唯一来源）。 */
export type CharacterPermissionMode = 'auto' | 'confirm' | 'restricted';

/**
 * 决策面（投影 A）——「怎么做」。每个字段都对应一个真实存在的结构钩子，
 * 值等于现行为原样。刀 1 只把这些散落的旋钮收拢到一处。
 */
export interface CharacterDecisionProfile {
  /** mode 判定阈值：复杂度达到哪一档才标 plan；显式文件证据达到几条即视为复杂。 */
  modeThreshold: {
    planAtComplexity: 'simple' | 'complex';
    complexFileThreshold: number;
  };
  /** 验证密度：收尾门禁验证清单的条数上限。 */
  verifyDensity: {
    maxVerificationItems: number;
  };
  /** 步子大小：计划步骤 / 子步骤上限。 */
  stepSize: {
    maxPlanSteps: number;
    maxPlanSubsteps: number;
  };
  /** 确认倾向：默认权限模式与分类自动批准开关。 */
  confirmTendency: {
    permissionMode: CharacterPermissionMode;
    autoApprove: {
      read: boolean;
      write: boolean;
      cmd: boolean;
      git: boolean;
    };
  };
  /**
   * 汇报节奏：在哪些节点开口。「老手快线」= 只在有意义的节点（现行为原样）；
   * 「工匠慢线」= 逐阶段交代（动手前说打算、每步验完报一次）。
   * 唯一消费者是 prompt（蓝图 §1 的 🔴 仅 prompt 档），所以这里换值不改结构行为。
   */
  reportRhythm: 'meaningful-nodes-only' | 'stage-by-stage';
  /** 并行倾向：一次可委派 / 并行的子代理角色上限。 */
  parallelTendency: {
    maxSubagentRoles: number;
  };
  /** 插话阈值：路由与插话分类共用的置信门。 */
  insertionThreshold: {
    confidenceGate: number;
  };
}

/**
 * 表达面（投影 B）——「怎么说」。刀 3 填五个场景的账（失败怎么报 / 等待怎么陪 /
 * 打断怎么歉 / 交付怎么交代限制 / 拒绝怎么给台阶）。
 *
 * 这里没有另立一张 `expressionDerivation`：场景条目本身就是对象，内核出处
 * （`derivedFrom`）直接挂在它身上；`CharacterScenarioLedger` 是
 * `Record<CharacterScenarioId, …>`，**少写一个场景照样编译不过**，与决策面的
 * `Record<旋钮, id[]>` 同等强度。例句不进这里（只进 .md 人读账），理由见
 * ./expression.ts 头注释。
 */
export interface CharacterExpressionProfile {
  /** 场景账：`CharacterScenarioId` → 义务 / 禁止 / 内核源句。 */
  scenarios: CharacterScenarioLedger;
}

/**
 * 铁律 1 的机制面：决策面每个旋钮 → 派生它的内核源句 id。
 * `Record<keyof CharacterDecisionProfile, …>` 让**少标一个旋钮就编译不过**；
 * id 的有效性与镜像同文由 `__tests__/characterCore.test.ts` 守。
 * 反过来不要求每条源句都被引用：没被引用的源句是内核通道的长尾素材。
 */
export type CharacterDecisionDerivation = Record<keyof CharacterDecisionProfile, readonly CharacterKernelLineId[]>;

/** 一个可激活的性格内核。一次只激活一个，版本化管理。 */
export interface CharacterProfile {
  /** 稳定 id（存 PureConfig，做活跃内核选择）。 */
  id: string;
  /** 内核叙事版本号（刀 2 起与 src/character/kernels/<id>.md 对齐）。 */
  version: string;
  /** 人读名（GUI 选择器 / 文档用）。 */
  name: string;
  /**
   * 人读一句话摘要：在哪些地方与别的内核不同（GUI 选择器的副标题）。
   * 不进 prompt——进 prompt 的是 core / expression 两张投影。
   */
  description: string;
  /**
   * 注入 system prompt 的精炼版内核（fragment `character_core`，priority 119）。
   * 由该内核的源句表装配（buildCharacterCorePrompt），不是正文抄写。
   */
  core: string;
  /** 源句表：推导标注的引用面，也是 .md 人读镜像的快照对照面。 */
  kernelLines: CharacterKernelLines;
  decision: CharacterDecisionProfile;
  decisionDerivation: CharacterDecisionDerivation;
  expression: CharacterExpressionProfile;
}
