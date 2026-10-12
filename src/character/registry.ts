// src/character/registry.ts
// 性格内核的注册表与解析（人格轨道 刀 5，2026-10-12）。
//
// 刀 1–4 只有一个内核，所以 `activeCharacterProfile()` 恒返回默认值、不需要选择器；
// 刀 5 上了第二个内核（工匠慢线），选择器才成立。本模块是**名册**：id → profile，
// 以及「这个 id 认不认识」「列出来给谁选」——不含任何活跃状态。活跃 id 的唯一
// 持有者是 ./index.ts（`setActiveCharacterProfile` / `activeCharacterProfile`），
// 这样「谁在台上」与「有谁」不复用同一份可变状态。
//
// 为什么注册表在这里而不是在 index.ts：./index.ts 是公开入口（会 re-export 内核
// 常量与装配函数），把名册放在独立叶子模块能让测试与宿主只依赖名册、不拉起整条
// 注入链。全模块仍是叶子：不 import 任何 ui / coding-agent / shared 运行时模块。
//
// 加内核的验收：在本文件登记 + 写 `kernels/<id>.ts` 与 `.md`（源句表逐字同文）
// + `characterKernels.test.ts` 的公共断言自动覆盖它 + 跑 `bun run eval:character`。

import type { CharacterProfile } from './types';
import { DEFAULT_CHARACTER_PROFILE, DEFAULT_CHARACTER_PROFILE_ID } from './defaultProfile';
import { CRAFTSMAN_SLOW_PROFILE } from './craftsmanProfile';

/**
 * 名册：id → profile。键序即 GUI 选择器的呈现顺序——**默认内核排第一**，
 * 免得换个内核之后列表把默认项挤到最后、用户以为默认变了。
 */
export const CHARACTER_PROFILES: Readonly<Record<string, CharacterProfile>> = {
  [DEFAULT_CHARACTER_PROFILE.id]: DEFAULT_CHARACTER_PROFILE,
  [CRAFTSMAN_SLOW_PROFILE.id]: CRAFTSMAN_SLOW_PROFILE,
};

/** 名册里的全部 id（顺序 = CHARACTER_PROFILES 的键序）。 */
export function characterProfileIds(): string[] {
  return Object.keys(CHARACTER_PROFILES);
}

/** 按名册顺序列出全部内核（GUI 选择器 / 文档 / 测试都读它，不各写一份）。 */
export function listCharacterProfiles(): CharacterProfile[] {
  return characterProfileIds().map((id) => CHARACTER_PROFILES[id]);
}

/** 这个字符串是不是名册里的内核 id（类型谓词：调用方拿到 true 就可以直接用）。 */
export function isCharacterProfileId(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CHARACTER_PROFILES, id);
}

/**
 * 按 id 解析内核；未知 id 返回 undefined（**不抛**）。调用方拿到的 undefined
 * 该被当成「配置里是个不认识的值」——宿主的选择器只呈现名册内的 id，所以走到
 * 这里的只可能是手改配置或版本回退留下的陈旧值，回退默认内核并让它可见即可，
 * 不能因为配置里一个字符串就让整条启动路径炸掉。
 */
export function resolveCharacterProfile(id: unknown): CharacterProfile | undefined {
  return isCharacterProfileId(id) ? CHARACTER_PROFILES[id] : undefined;
}

export { DEFAULT_CHARACTER_PROFILE_ID };
