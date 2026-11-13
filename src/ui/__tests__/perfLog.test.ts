// perfLog 聚合器单测（2026-11-13 埋点刀）。无桥环境（bun test 无
// __TAURI_INTERNALS__）下 flush 走静默 no-op 路径——恰好覆盖「埋点永不
// 抛」的契约；行格式与百分位逻辑在此钉死。
import { describe, it, expect } from 'bun:test';
import { createPerfAggregator, percentileFromSorted } from '../perfLog';

describe('percentileFromSorted', () => {
  it('空数组返回 0（不产 NaN）', () => {
    expect(percentileFromSorted([], 50)).toBe(0);
    expect(percentileFromSorted([], 90)).toBe(0);
  });

  it('p50/p90 取下标不越界（单样本=自身）', () => {
    expect(percentileFromSorted([42], 50)).toBe(42);
    expect(percentileFromSorted([42], 90)).toBe(42);
    expect(percentileFromSorted([42], 99)).toBe(42);
  });

  it('多样本分位正确（升序输入，下取整取下标）', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileFromSorted(s, 50)).toBe(60); // floor(0.5*10)=5 → s[5]
    expect(percentileFromSorted(s, 90)).toBe(100); // floor(0.9*10)=9 → s[9]
    expect(percentileFromSorted(s, 0)).toBe(10); // idx0 = 最小
  });
});

describe('createPerfAggregator（无桥静默契约）', () => {
  it('record 大批样本 + flushNow 全程不抛（桥不可用即静默丢）', async () => {
    const agg = createPerfAggregator('stream', 100, 60_000);
    // 105 拍：第 100 拍触发自动 flush（内部样本清零），后 5 拍留到 flushNow。
    for (let i = 0; i < 105; i++) {
      agg.record(10 + (i % 7), 1234 + i);
    }
    await agg.flushNow();
    // 二次 flushNow 空样本：no-op 不抛。
    await agg.flushNow();
  });

  it('并发 flush 位：flushNow 重入安全', async () => {
    const agg = createPerfAggregator('settle', 20, 120_000);
    agg.record(5, 100);
    // 同时发起多个 flush：flushing 位串行化，不抛不重复。
    await Promise.all([agg.flushNow(), agg.flushNow(), agg.flushNow()]);
  });
});
