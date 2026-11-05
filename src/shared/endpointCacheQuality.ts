// src/shared/endpointCacheQuality.ts
// 端点缓存质量观测（感知手脚，2026-11-05）。cacheHit/Miss 的逐回合账此前
// 只落盘展示（stats.json / 统计面板），零决策消费——GLM flash 端点连续全
// miss + TTFT 12.1s vs DeepSeek 74% 命中 + 4.3s 的实测判例没有任何机制承接。
// 2026-11-03 定调：自愈裁决权归模型，pure 只做感知手脚——所以这里只聚合
// 现状事实并让模型/用户看得见（sys_info 活设置行），换不换端点是模型和
// 用户的裁决，宿主不自动降权不自动挪流量。
//
// 口径（全部机械、可测）：
// - 滑动窗口 MAX_SAMPLES 笔「报了缓存分账」的回合，按 provider/model 键隔离
//   ——换模型即换键，旧键读数自然过期。
// - 「全 miss」= hit=0 且 miss>0；provider 没有缓存概念（两字段都缺席）不
//   计样本也不清连续计数（observeCache 同口径）——没报 ≠ 全 miss。
// - 时间断档 GAP_RESET_MS 清零连续计数：隔了缓存 TTL 数量级再回来的第一轮
//   全 miss 是前缀过期的物理事实，不是端点质量证据。

import type { TokenUsage } from './types';

/** 滑动窗口长度：12 笔分账约等于一两个长回合的用量，再多就稀释近期信号。 */
const MAX_SAMPLES = 12;
/** 连续计数的时间断档重置线（30min）：prompt cache TTL 的数量级中值。 */
const GAP_RESET_MS = 30 * 60 * 1000;
/** 连续全 miss 达到这个笔数才出告警——单轮全 miss 可能只是首轮回填。 */
const ALL_MISS_STREAK = 3;
/** 少于这个样本数只报「信号不足」，不下缓存质量结论。 */
const MIN_SAMPLES = 3;
/** 窗口内全 miss 笔数占比达到这个比例判「间歇缓存」（2026-11-05 第四态，
 *  GLM flash 实测判例：同一端点轮间命中率 3%~97% 抽签——多实例无共享缓存
 *  的负载均衡形态，hitRate 均值看着「active」其实轮间大幅抖动）。 */
const INTERMITTENT_RATIO = 0.4;

export interface CacheQualityWindow {
  /** 窗口内报了缓存分账的回合数。 */
  sampleCount: number;
  /** 窗口内 hit/(hit+miss)，百分比一位小数；分账全为零时 null。 */
  hitRate: number | null;
  /** 连续全 miss 的笔数（时间断档清零后重数）。 */
  consecutiveAllMiss: number;
  /** 窗口内全 miss（hit=0 且 miss>0）的笔数——intermittent 判据的原料。 */
  allMissCount: number;
}

interface Sample {
  t: number;
  hit: number;
  miss: number;
}

interface WindowState {
  samples: Sample[];
  consecutiveAllMiss: number;
  lastAt: number;
}

const windows = new Map<string, WindowState>();

function keyFor(provider: string | undefined, model: string | undefined): string {
  return `${provider ?? 'unknown'}/${model ?? 'unknown'}`;
}

/** 归一笔回合的缓存账。usage 无缓存字段时是 no-op（见文件头口径）。 */
export function recordEndpointCacheOutcome(
  provider: string | undefined,
  model: string | undefined,
  usage: TokenUsage | undefined,
  now: number = Date.now(),
): void {
  const hit = usage?.cacheHitTokens;
  const miss = usage?.cacheMissTokens;
  if (hit === undefined && miss === undefined) return;
  const key = keyFor(provider, model);
  const state = windows.get(key) ?? { samples: [], consecutiveAllMiss: 0, lastAt: 0 };
  if (state.lastAt > 0 && now - state.lastAt > GAP_RESET_MS) state.consecutiveAllMiss = 0;
  const hitTokens = hit ?? 0;
  const missTokens = miss ?? 0;
  state.samples.push({ t: now, hit: hitTokens, miss: missTokens });
  if (state.samples.length > MAX_SAMPLES) state.samples.shift();
  state.lastAt = now;
  const allMiss = hitTokens === 0 && missTokens > 0;
  state.consecutiveAllMiss = allMiss ? state.consecutiveAllMiss + 1 : 0;
  windows.set(key, state);
}

/** 读端点的当前窗口；该键从未记过账（或记账全被淘汰——不可能，窗口只滑不
 *  清）返回 undefined。 */
export function cacheQualityFor(
  provider: string | undefined,
  model: string | undefined,
  now: number = Date.now(),
): CacheQualityWindow | undefined {
  const state = windows.get(keyFor(provider, model));
  if (!state || state.samples.length === 0) return undefined;
  let hit = 0;
  let miss = 0;
  let allMissCount = 0;
  for (const sample of state.samples) {
    hit += sample.hit;
    miss += sample.miss;
    if (sample.hit === 0 && sample.miss > 0) allMissCount++;
  }
  const total = hit + miss;
  // 读侧同样做断档清零：归账后隔了很久才读，连续计数已经不代表现状。
  const stale = state.lastAt > 0 && now - state.lastAt > GAP_RESET_MS;
  return {
    sampleCount: state.samples.length,
    hitRate: total > 0 ? Math.round((hit / total) * 1000) / 10 : null,
    consecutiveAllMiss: stale ? 0 : state.consecutiveAllMiss,
    allMissCount,
  };
}

/** sys_info 活设置行的缓存质量行（promptBudgetLiveLine 的姊妹行，同一处
 *  2026-11-03 定调的感知手脚）。四态：样本不足 / 持续全 miss / 间歇缓存 /
 *  健康读数。全 miss 态优先于 intermittent（连续 3 笔全 miss 是正在发生的
 *  坏状态，比占比更紧急）。该键无任何样本（provider 从不报缓存分账）返回
 *  undefined——行不出现，不冤枉没有缓存概念的端点。 */
export function cacheQualityLiveLine(
  provider: string | undefined,
  model: string | undefined,
  now: number = Date.now(),
): string | undefined {
  const window = cacheQualityFor(provider, model, now);
  if (!window) return undefined;
  const endpoint = `${provider ?? 'unknown'}/${model ?? 'unknown'}`;
  if (window.sampleCount < MIN_SAMPLES) {
    return `llm cache quality: only ${window.sampleCount} billed turn${window.sampleCount === 1 ? '' : 's'} observed for ${endpoint} - not enough signal yet; a stable read needs a few more turns in one session`;
  }
  if (window.consecutiveAllMiss >= ALL_MISS_STREAK || window.hitRate === 0) {
    return `llm cache quality: hit rate ${window.hitRate ?? 0}% over last ${window.sampleCount} billed turns (${window.consecutiveAllMiss} consecutive all-miss) - this endpoint likely lacks prompt caching or drops the cached prefix between turns; a caching endpoint cuts latency and input cost sharply (cache-hit input is priced far cheaper)`;
  }
  if (window.allMissCount / window.sampleCount >= INTERMITTENT_RATIO) {
    return `llm cache quality: hit rate ${window.hitRate}% over last ${window.sampleCount} billed turns (${window.allMissCount} of ${window.sampleCount} turns fully missed) - caching is intermittent: this endpoint likely load-balances across instances without a shared cache, so latency and input cost will swing between turns`;
  }
  return `llm cache quality: hit rate ${window.hitRate}% over last ${window.sampleCount} billed turns - prompt caching is active on this endpoint`;
}

/** 测试隔离钩子：模块级窗口是进程全局态，测试必须显式清账
 *  （bun test 单进程判例——泄漏进别的用例就是顺序地雷）。 */
export function resetEndpointCacheQualityForTests(): void {
  windows.clear();
}
