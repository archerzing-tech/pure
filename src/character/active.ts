// src/character/active.ts
// 活跃性格内核的**唯一可变状态**（人格轨道 刀 5，2026-10-12）。
//
// 为什么单独一个模块，而不是把它写在 index.ts 里：漂移探针（./drift.ts）要记账
// 「这一轮是谁在台上」，它需要读活跃内核；而 index.ts 是对外入口，要 re-export
// 漂移探针。两边直接互相 import 就成环了（本仓库的模块图有明确的无环纪律）。
// 抽到本模块后方向是单向的：registry（名册）← active（台上是谁）← drift / 调用方。
//
// 状态本身刻意做成模块级可变变量而不是逐层传参：Planner / adaptiveControl /
// inputDecision / PromptAssembler / SubagentOrchestrator 分散在五个模块里读它，
// 逐层传参会把「性格」变成一条贯穿所有签名的参数——而它本来就是全局唯一的一份
// 背景事实。宿主在启动时（读完配置后）注入一次，见 src/ui/main.ts 与 src/cli.ts。
//
// 本模块是叶子：不 import 任何 ui / coding-agent / shared 运行时模块，避免环。

import type { CharacterProfile } from './types';
import { DEFAULT_CHARACTER_PROFILE } from './defaultProfile';
import { isCharacterProfileId, resolveCharacterProfile } from './registry';

/**
 * 活跃内核 id。`null` = 没人注入过（或宿主显式重置），此时回退默认内核。
 */
let activeProfileId: string | null = null;

/**
 * 注入活跃内核（宿主启动时按配置调一次；GUI 改设置后立即再调一次）。
 *
 * 返值 = 有没有被采纳：
 *   · 名册内的 id → 采纳，true；
 *   · `null` / `undefined` / `''` → 拆回默认内核，true（「没配置」是合法状态）；
 *   · 不认识的 id → **不采纳**，保持现状，false（手改配置的陈旧值不能炸启动，
 *     也不能静默生效成别的内核——宿主拿到 false 该把配置里的值纠正回默认）。
 */
export function setActiveCharacterProfile(id: string | null | undefined): boolean {
  if (id === null || id === undefined || id === '') {
    activeProfileId = null;
    return true;
  }
  if (!isCharacterProfileId(id)) return false;
  activeProfileId = id;
  return true;
}

/** 重置为默认内核（测试的隔离钩子；也用于宿主侧的「恢复默认」）。 */
export function resetActiveCharacterProfile(): void {
  activeProfileId = null;
}

/**
 * 当前激活的性格内核（**唯一读取点**）。没人注入过、或注入后被重置时，回退默认
 * 内核（老手快线）——这也是刀 1–4 的全部行为，逐字节不变。
 *
 * 调用方每次真读（不是模块加载时取一次）：决策面的上限与阈值散在五个模块里，
 * 模块加载早于宿主读配置，早读会把切内核变成静默失效。
 */
export function activeCharacterProfile(): CharacterProfile {
  return resolveCharacterProfile(activeProfileId) ?? DEFAULT_CHARACTER_PROFILE;
}

/** 当前激活内核的 id（决策日志 / 事件账 / 漂移探针都用它记「这一轮是谁在台上」）。 */
export function activeCharacterProfileId(): string {
  return activeCharacterProfile().id;
}
