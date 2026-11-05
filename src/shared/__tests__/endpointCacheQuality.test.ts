// src/shared/__tests__/endpointCacheQuality.test.ts
// 端点缓存质量观测的口径锁。时间一律显式传 now——setSystemTime 是进程全局
// 泄漏源（43c8518 判例），这里不用；模块级窗口每用例 reset（bun test 单进程
// 判例：不清账就是顺序地雷）。

import { afterEach, describe, expect, it } from 'bun:test';
import {
  cacheQualityFor,
  cacheQualityLiveLine,
  recordEndpointCacheOutcome,
  resetEndpointCacheQualityForTests,
} from '../endpointCacheQuality';

const T0 = 1_700_000_000_000;

function billed(hit: number, miss: number) {
  return { cacheHitTokens: hit, cacheMissTokens: miss };
}

afterEach(() => {
  resetEndpointCacheQualityForTests();
});

describe('recordEndpointCacheOutcome（归账口径）', () => {
  it('usage without cache fields is a no-op - no sample, streak untouched', () => {
    recordEndpointCacheOutcome('glm', 'glm-5.3-flash', billed(0, 39000), T0);
    // 无缓存概念的 provider 两字段都缺席：不计样本、不清连续计数。
    recordEndpointCacheOutcome('glm', 'glm-5.3-flash', {}, T0 + 1);
    recordEndpointCacheOutcome('glm', 'glm-5.3-flash', undefined, T0 + 2);
    recordEndpointCacheOutcome('glm', 'glm-5.3-flash', billed(0, 40000), T0 + 3);
    const window = cacheQualityFor('glm', 'glm-5.3-flash', T0 + 4)!;
    expect(window.sampleCount).toBe(2);
    expect(window.consecutiveAllMiss).toBe(2);
    expect(window.hitRate).toBe(0);
  });

  it('a cache hit resets the all-miss streak', () => {
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0);
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + 1);
    recordEndpointCacheOutcome('glm', 'm', billed(500, 100), T0 + 2);
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + 3);
    expect(cacheQualityFor('glm', 'm', T0 + 4)!.consecutiveAllMiss).toBe(1);
  });

  it('a gap over the TTL magnitude resets the streak on record AND on read', () => {
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0);
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + 1);
    // 隔 31min：断档后的全 miss 是前缀过期，不是端点质量证据。
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + 31 * 60 * 1000);
    expect(cacheQualityFor('glm', 'm', T0 + 31 * 60 * 1000 + 1)!.consecutiveAllMiss).toBe(1);
    // 归账侧同样清零：命中断档后的下一笔全 miss 从 1 起数。
    recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + 32 * 60 * 1000);
    expect(cacheQualityFor('glm', 'm', T0 + 32 * 60 * 1000 + 1)!.consecutiveAllMiss).toBe(2);
    // 读侧：归账后隔很久才读，读数不代表现状，连续计数归零。
    expect(cacheQualityFor('glm', 'm', T0 + 63 * 60 * 1000)!.consecutiveAllMiss).toBe(0);
  });

  it('window slides: sample count caps at 12, hitRate uses the window sum', () => {
    for (let i = 0; i < 12; i++) recordEndpointCacheOutcome('glm', 'm', billed(0, 100), T0 + i);
    // 13 笔：最早一笔（全 miss）滑出窗口，新笔带命中。
    recordEndpointCacheOutcome('glm', 'm', billed(300, 100), T0 + 12);
    const window = cacheQualityFor('glm', 'm', T0 + 13)!;
    expect(window.sampleCount).toBe(12);
    expect(window.hitRate).toBe(20); // 300 hit / (300 + 11*100 + 100 miss)
    // 连续计数不受滑动影响：最后一笔有命中 → streak=0。
    expect(window.consecutiveAllMiss).toBe(0);
  });

  it('keys are isolated per provider/model', () => {
    recordEndpointCacheOutcome('glm', 'glm-5.3-flash', billed(0, 100), T0);
    expect(cacheQualityFor('glm', 'glm-5.3-flash', T0)!.sampleCount).toBe(1);
    expect(cacheQualityFor('deepseek-openai', 'deepseek-v4-pro', T0)).toBeUndefined();
    expect(cacheQualityFor('glm', 'glm-5.3-turbo', T0)).toBeUndefined();
  });

  it('all-zero billing yields hitRate null but still counts as a sample', () => {
    recordEndpointCacheOutcome('glm', 'm', billed(0, 0), T0);
    const window = cacheQualityFor('glm', 'm', T0)!;
    expect(window.sampleCount).toBe(1);
    expect(window.hitRate).toBeNull();
  });
});

describe('cacheQualityLiveLine（sys_info 姊妹行的三态）', () => {
  it('no samples at all -> no line (never blames a cache-less provider)', () => {
    expect(cacheQualityLiveLine('glm', 'm', T0)).toBeUndefined();
    // 报过账但全是无缓存字段：仍无样本，行不出现。
    recordEndpointCacheOutcome('glm', 'm', {}, T0);
    expect(cacheQualityLiveLine('glm', 'm', T0)).toBeUndefined();
  });

  it('under 3 samples -> not-enough-signal wording', () => {
    recordEndpointCacheOutcome('glm', 'm', billed(0, 1000), T0);
    const line = cacheQualityLiveLine('glm', 'm', T0 + 1)!;
    expect(line).toContain('only 1 billed turn observed');
    expect(line).toContain('not enough signal yet');
  });

  it('sustained all-miss -> the blame line with streak and hit rate', () => {
    for (let i = 0; i < 3; i++) recordEndpointCacheOutcome('glm', 'glm-5.3-flash', billed(0, 40000), T0 + i);
    const line = cacheQualityLiveLine('glm', 'glm-5.3-flash', T0 + 3)!;
    expect(line).toContain('hit rate 0%');
    expect(line).toContain('(3 consecutive all-miss)');
    expect(line).toContain('likely lacks prompt caching');
  });

  it('hitRate 0% over the window blames even when the streak was gap-reset', () => {
    for (let i = 0; i < 4; i++) recordEndpointCacheOutcome('glm', 'm', billed(0, 1000), T0 + i);
    // 全 miss 但连续计数被 31min 断档清成 0：hitRate 仍为 0%，照样告警。
    const line = cacheQualityLiveLine('glm', 'm', T0 + 31 * 60 * 1000)!;
    expect(line).toContain('hit rate 0%');
    expect(line).toContain('likely lacks prompt caching');
  });

  it('intermittent: all-miss share >= 40% says so even with a positive hit rate (GLM flash draw-lottery shape)', () => {
    // 2026-11-05 实测形态的锐化版：同一端点轮间命中率大幅抖动——hitRate
    // 均值看着 active，4/8 轮真全 miss（hit=0）的「间歇缓存」必须说成真话。
    const turns = [billed(0, 60000), billed(10048, 51469), billed(0, 68188), billed(72320, 2053), billed(0, 69384), billed(0, 50000), billed(3264, 58986), billed(53376, 31299)];
    turns.forEach((usage, i) => recordEndpointCacheOutcome('glm', 'glm-5.3-flash', usage, T0 + i));
    const line = cacheQualityLiveLine('glm', 'glm-5.3-flash', T0 + turns.length)!;
    expect(line).toContain('4 of 8 turns fully missed');
    expect(line).toContain('caching is intermittent');
    expect(line).toContain('load-balances across instances without a shared cache');
    expect(line).not.toContain('prompt caching is active');
  });

  it('healthy: all-miss share under 40% keeps the active line', () => {
    // 7 笔里 2 笔全 miss = 29% < 40%：抖动但不判间歇。
    const turns = [billed(70000, 5000), billed(70000, 5000), billed(0, 75000), billed(70000, 5000), billed(0, 75000), billed(70000, 5000), billed(70000, 5000)];
    turns.forEach((usage, i) => recordEndpointCacheOutcome('glm', 'm', usage, T0 + i));
    const line = cacheQualityLiveLine('glm', 'm', T0 + turns.length)!;
    expect(line).toContain('prompt caching is active');
    expect(line).not.toContain('fully missed');
  });

  it('sustained streak outranks intermittent (3 consecutive all-miss is the live failure)', () => {
    // 窗口内前 5 笔健康、最后 3 笔连续全 miss：占比 3/8=37.5% 不触发
    // intermittent，但 streak>=3 的全 miss 态必须优先说话。
    const turns = [billed(70000, 5000), billed(70000, 5000), billed(70000, 5000), billed(70000, 5000), billed(70000, 5000), billed(0, 75000), billed(0, 75000), billed(0, 75000)];
    turns.forEach((usage, i) => recordEndpointCacheOutcome('glm', 'm', usage, T0 + i));
    const line = cacheQualityLiveLine('glm', 'm', T0 + turns.length)!;
    expect(line).toContain('(3 consecutive all-miss)');
    expect(line).toContain('likely lacks prompt caching');
    expect(line).not.toContain('fully missed');
  });

  it('healthy hit rate -> the active line with the number', () => {
    for (let i = 0; i < 3; i++) recordEndpointCacheOutcome('deepseek-openai', 'm', billed(75000, 25000), T0 + i);
    const line = cacheQualityLiveLine('deepseek-openai', 'm', T0 + 3)!;
    expect(line).toContain('hit rate 75%');
    expect(line).toContain('prompt caching is active');
  });
});
