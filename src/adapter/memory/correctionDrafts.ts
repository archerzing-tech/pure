// src/adapter/memory/correctionDrafts.ts
// E3.1 —— 反思器顺带产出的纠正草稿（project_convention / user_preference）：
// 落库即 confidence:'low'，没有注入资格（注入端统一过滤 low）；仪表盘卡片给
// "草稿"徽章 + 确认按钮，用户点头才转正（confidence:'high'）获得注入资格。
//
// IMemoryStore 没有 update：确认 = removeById + 重写一条（本模块构造重写条
// 目）。dedupeKey 原样保留 —— 同一句纠正（内容哈希）之后无论反思器再写多少
// 次，都会撞在已确认条目上被去重，不会回头再冒草稿卡。

import type { MemoryEntry } from '../../shared/types';

/** 可确认的草稿类型 —— 反思器 correction.kind 的白名单。别处写不出这种
 *  low 组合（error_pattern 的 low 是 E1.1 的防幻觉降级，不属于待确认草稿）。 */
export const DRAFT_CONFIRMABLE_TYPES: ReadonlySet<string> = new Set(['project_convention', 'user_preference']);

/** 这张卡是不是待确认草稿（仪表盘徽章 + 确认按钮的判定）。 */
export function isDraftEntry(entry: Pick<MemoryEntry, 'type' | 'confidence'>): boolean {
  return entry.confidence === 'low' && DRAFT_CONFIRMABLE_TYPES.has(entry.type);
}

/** 确认后的重写条目：只保留稳定字段，健康分/命中/生命周期从零起算，
 *  confidence 抬到 'high' —— 注入端从此放行。 */
export function confirmedDraftEntry(entry: MemoryEntry): Omit<MemoryEntry, 'id'> {
  return {
    type: entry.type,
    content: entry.content,
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    platform: entry.platform,
    lesson: entry.lesson,
    dedupeKey: entry.dedupeKey,
    confidence: 'high',
  };
}
