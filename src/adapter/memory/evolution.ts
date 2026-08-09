// src/adapter/memory/evolution.ts
// v1.5 智能进化记忆系统（Adapter Layer 设计文档 §12.8）——把旧的"单一时间轴减半
// 衰减"升级为多维健康分 + 生命周期 + 策略进化：
//
//   健康分 = 时间维度(recency) × 可信度维度(credibility) × 使用频率维度(usage)
//            × 进化状态维度(superseded)
//
// 生命周期按健康分推进：active（活跃）→ degraded（降级）→ dormant（休眠，
// 不再进检索）→ 删除（跌破删除线，或休眠超过宽限期仍未再被使用）。
//
// 进化：当一条"新"记忆（procedure / successful_pattern / user_preference /
// project_convention）与同类型旧记忆针对同一情境（内容定向覆盖率高）时，新条目
// 取代旧条目 —— 旧条目打 supersededBy 标记并立即降级，之后以 0.4 的惩罚因子
// 更快地走完 降级 → 休眠 → 删除，实现"不合时宜的策略慢慢进化成最新最好用的"。
//
// 全部为纯规则、确定性计算：不依赖 LLM / 网络，评分在任何环境行为一致、可单测。

import type { MemoryEntry, MemoryType } from './IMemoryStore';

export type MemoryLifecycle = 'active' | 'degraded' | 'dormant';

export const EVOLUTION = {
  // ── 时间维度：recency 半衰期。闲置满一个半衰期的记忆保留 50% 的时间分量。──
  RECENCY_HALF_LIFE_MS: 30 * 24 * 3600 * 1000,

  // ── 可信度维度：按记忆类型的基础可信度（1.0 = 最高）。──
  CREDIBILITY: {
    successful_pattern: 1.0, // 已验证的结果
    procedure: 1.0,          // 已验证可复用的流程
    user_preference: 0.9,    // 用户的直接表述
    project_convention: 0.85,
    error_pattern: 0.8,      // 从失败中学到 —— 可能是暂时的
  } as Record<MemoryType, number>,

  // ── 使用频率维度：检索命中多少次视为"高频使用"（达到即饱和）。──
  HITS_FOR_FULL_USAGE: 4,

  // ── 进化状态维度：被取代的策略健康分 × 此惩罚，加速走完生命周期。──
  SUPERSEDED_PENALTY: 0.4,

  // ── 生命周期阈值（健康分 0..1）。──
  ACTIVE_MIN: 0.45,   // ≥ 活跃；以下 → 降级
  DORMANT_MAX: 0.15,  // ≤ 休眠 —— 不进检索（"睡着"，不是"没了"）
  DELETE_FLOOR: 0.05, // < 直接删除

  // 硬性兜底：已休眠的记忆即使健康分还没跌破删除线，闲置超过此宽限期也删除
  // （高频使用过的记忆降级很慢，可能永远悬在删除线之上）。
  DORMANT_GRACE_MS: 60 * 24 * 3600 * 1000,

  // ── 进化：定向内容覆盖率阈值。新条目的有效 token 至少有此比例被旧条目
  //  覆盖，才判定为"同一情境的新版本"并取代旧条目。──
  SUPERSEDE_SIMILARITY: 0.55,
  MIN_TOKENS_FOR_SUPERSEDE: 4,
} as const;

// 可互相取代的类型。error_pattern 被排除：其内容充满共享模板样板
// （"Stopped by failure policy: …"、"(tool: …)"、"Do not make this exact call
// again"），内容相似度在那里是噪音，靠 dedupe + 衰减即可。
const SUPERSEDABLE_TYPES = new Set<MemoryType>([
  'procedure',
  'successful_pattern',
  'user_preference',
  'project_convention',
]);

// 无策略含义的英文功能词。剥离它们是为了让模板措辞（"When facing … apply the
// verified procedure"）不会把两条无关的教训判成同一情境。
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'via', 'this', 'that', 'your', 'from',
  'into', 'were', 'been', 'have', 'will', 'would', 'should', 'using', 'make',
  'again', 'switch', 'different', 'approach', 'exact', 'call', 'tool', 'then',
  'than', 'more', 'most', 'about', 'after', 'before', 'between', 'during',
  'their', 'there', 'these', 'those', 'which', 'while', 'does', 'done', 'use',
  'used', 'not', 'are', 'was', 'its', 'has', 'had', 'out', 'all', 'can',
  'could', 'over', 'under', 'only', 'also', 'may', 'like', 'prefer', 'both',
]);

const ln2 = Math.log(2);

/**
 * 多维健康分（0..1）：recency × (0.55×credibility + 0.45×usage 饱和曲线) ×
 * superseded 惩罚。确定性 —— 同一 (entry, now) 永远给出同一分数，decay 反复
 * 执行只会收敛而非叠加。
 */
export function healthScore(entry: MemoryEntry, now = Date.now()): number {
  const lastUsed = entry.lastUsedAt ?? entry.timestamp;
  const recency = Math.exp(-(Math.max(0, now - lastUsed) / EVOLUTION.RECENCY_HALF_LIFE_MS) * ln2);
  const credibility = EVOLUTION.CREDIBILITY[entry.type] ?? 0.8;
  const usage = Math.min(1, (entry.hitCount ?? 0) / EVOLUTION.HITS_FOR_FULL_USAGE);
  const superseded = entry.supersededBy ? EVOLUTION.SUPERSEDED_PENALTY : 1;
  return recency * (0.55 * credibility + 0.45 * (0.5 + 0.5 * usage)) * superseded;
}

/** 健康分 → 生命周期阶段。 */
export function lifecycleOf(score: number): MemoryLifecycle {
  if (score >= EVOLUTION.ACTIVE_MIN) return 'active';
  if (score > EVOLUTION.DORMANT_MAX) return 'degraded';
  return 'dormant';
}

export type DecayOutcome = 'untouched' | 'updated' | 'deleted';

/**
 * 对单条记忆执行一次衰减。最近 olderThan 毫秒内被使用过的记忆不处理（还在
 * 服务用户）；更旧的按绝对时间重算健康分 —— 确定性收敛，不叠加。
 */
export function decayEntry(e: MemoryEntry, now: number, olderThan: number): DecayOutcome {
  const lastUsed = e.lastUsedAt ?? e.timestamp;
  if (now - lastUsed < olderThan) return 'untouched';
  const score = healthScore(e, now);
  if (
    score < EVOLUTION.DELETE_FLOOR ||
    (e.lifecycle === 'dormant' && now - lastUsed >= EVOLUTION.DORMANT_GRACE_MS)
  ) {
    return 'deleted';
  }
  const lifecycle = lifecycleOf(score);
  // 用 epsilon 比较：两次 decay 之间 now 只前进毫秒，纯浮点漂移（~1e-13）不应
  // 触发无谓的重写 + 缓存清理（否则每个含旧条目的项目每小时都落盘一次）。
  if (Math.abs((e.decayScore ?? 0) - score) > 1e-9 || e.lifecycle !== lifecycle) {
    e.decayScore = score;
    e.lifecycle = lifecycle;
    return 'updated';
  }
  return 'untouched';
}

/** 检索命中副作用：hitCount +1、lastUsedAt 刷新（使用频率/新鲜度信号）。 */
export function applyHits(entries: MemoryEntry[], now = Date.now()): void {
  for (const e of entries) {
    e.hitCount = (e.hitCount ?? 0) + 1;
    e.lastUsedAt = now;
  }
}

/**
 * 用于"新记忆是否取代旧记忆"的对比文本。successful_pattern 取结构化
 * lesson.symptom —— 两段会话修同一个问题，即使修复路径不同也应取代；其余类型
 * 取 content 并剥离 Harness 写入时的模板样板（"Reusable lesson —"、各字段标签、
 * procedure 的 "When facing … apply the verified procedure" 外壳）。
 */
export function comparisonText(e: MemoryEntry): string {
  if (e.type === 'successful_pattern' && e.lesson?.symptom) return e.lesson.symptom;
  return e.content
    .replace(/^Reusable lesson —\s*/i, ' ')
    .replace(/\b(symptom|root cause|recovery path|verification|avoid next time|tools used|outcome)\s*:/gi, ' ')
    .replace(/when facing "|":\s*apply the verified procedure —|verify via:\s*/gi, ' ')
    .replace(/No retry was required/gi, ' ')
    .replace(/Engine VERIFY phase passed;?[^.]*\.?/gi, ' ');
}

/**
 * 有效对比 token：ASCII 词（≥3 字符，剥停用词）+ 中文二元组（单字太噪）。
 */
export function similarityTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) {
    if (!STOPWORDS.has(m)) out.add(m);
  }
  const han: string[] = [];
  for (const ch of text) if (/[\u4e00-\u9fff]/.test(ch)) han.push(ch);
  for (let i = 0; i + 1 < han.length; i++) out.add(`${han[i]}${han[i + 1]}`);
  return out;
}

/**
 * 在现有条目里找"同情境的旧版本"：同类型、同项目、尚未被取代、内容对新条目
 * 的定向覆盖率达到阈值。返回应被取代的旧条目，无则 undefined。
 */
export function findSupersedeTarget(
  entries: MemoryEntry[],
  candidate: Omit<MemoryEntry, 'id'>,
): MemoryEntry | undefined {
  if (!SUPERSEDABLE_TYPES.has(candidate.type)) return undefined;
  const a = similarityTokens(comparisonText(candidate as MemoryEntry));
  if (a.size < EVOLUTION.MIN_TOKENS_FOR_SUPERSEDE) return undefined;
  let best: MemoryEntry | undefined;
  let bestCoverage = 0;
  for (const e of entries) {
    if (e.type !== candidate.type) continue;
    if (e.supersededBy) continue;
    if (e.projectPath !== candidate.projectPath) continue;
    // 同会话内不取代：一条用户消息收割出的多个偏好/流程（"用 TypeScript 和
    // Python"）是并列清单，不是变更 —— 否则第二个条目会误杀第一个。
    // 跨会话的"改主意"（tabs → spaces、TS → JS）仍正常取代。
    if (e.sessionId === candidate.sessionId) continue;
    const b = similarityTokens(comparisonText(e));
    if (b.size === 0) continue;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    const coverage = shared / a.size;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      best = e;
    }
  }
  return bestCoverage >= EVOLUTION.SUPERSEDE_SIMILARITY ? best : undefined;
}
