// src/shared/__tests__/parallelNudge.test.ts
// 生产侧并行提醒的记账面（2026-11-18 大屏复测判例：114.9KB 主线直写零委派）。

import { describe, it, expect, beforeEach } from 'bun:test';
import { createTurnWriteTracker, recordMainThreadWriteBytes, resetParallelNudgeForTests, takeBuildParallelNudge } from '../parallelNudge';

beforeEach(() => resetParallelNudgeForTests());

describe('recordMainThreadWriteBytes / takeBuildParallelNudge', () => {
  it('越过阈值才落处方：小写入零注入', () => {
    recordMainThreadWriteBytes(10_000, 4);
    expect(takeBuildParallelNudge()).toBe('');
  });

  it('累计越阈（调用方传累计总量）落一条含体量的处方', () => {
    recordMainThreadWriteBytes(12_000, 2);
    expect(takeBuildParallelNudge()).toBe('');
    recordMainThreadWriteBytes(20_000, 3);
    expect(takeBuildParallelNudge()).toBe('');
    // 2026-11-20：阈值降到 24KB——60KB 时往往已连写四五个模块，拆分窗口
    // 已经过去；提前到第二三个模块，让模型在还有活可拆时做决定。
    recordMainThreadWriteBytes(26_000, 4);
    const nudge = takeBuildParallelNudge();
    expect(nudge).toContain('25 KB');
    expect(nudge).toContain('before the next module');
    expect(nudge).toContain('code_editor');
    // 是体量事实不是指令：明说 solo 也行
    expect(nudge).toContain('not an order');
  });

  it('sticky：pending 在场时后续记账不覆盖，读过即清后可再记（下一回合）', () => {
    recordMainThreadWriteBytes(70_000, 5);
    const first = takeBuildParallelNudge();
    expect(first).not.toBe('');
    // 取走后同回合的更高体量仍会再记（chat.ts 只在零委派时调用——
    // 真实形状里 take 发生在下一回合装配，天然是新回合）。
    recordMainThreadWriteBytes(90_000, 6);
    expect(takeBuildParallelNudge()).toContain('88 KB');
    resetParallelNudgeForTests();
    recordMainThreadWriteBytes(70_000, 5);
    expect(takeBuildParallelNudge()).not.toBe('');
  });
});

// 2026-11-23 收口：引擎是唯一记账人，tracker 自己累加（宿主不再传累计值）。
describe('createTurnWriteTracker', () => {
  const big = (n: number) => 'x'.repeat(n);
  const args = (chars: number) => JSON.stringify({ path: 'a.ts', content: big(chars) });
  const call = (chars: number) => JSON.stringify({ path: 'a.ts', content: big(chars) });

  it('小写入不落处方，累计越阈才落一条含文件数与体量的处方', () => {
    const t = createTurnWriteTracker();
    t.observe('write_file', call(10_000), true, false);
    t.observe('write_file', call(10_000), true, false);
    expect(takeBuildParallelNudge()).toBe('');
    t.observe('write_file', call(10_000), true, false);
    const nudge = takeBuildParallelNudge();
    expect(nudge).toContain('29 KB');
    expect(nudge).toContain('3 whole-file write(s)');
  });

  it('失败与非 write_file 不记账', () => {
    const t = createTurnWriteTracker();
    t.observe('write_file', args(50_000), false, false);
    t.observe('edit_file', args(50_000), true, false);
    expect(takeBuildParallelNudge()).toBe('');
  });

  it('委派现身即封口：之后的整写不再触发（模型已经自己拆过路）', () => {
    const t = createTurnWriteTracker();
    t.observe('code_editor', JSON.stringify({ task: '写模块' }), true, true);
    t.observe('write_file', call(40_000), true, true);
    expect(takeBuildParallelNudge()).toBe('');
  });

  it('append 分段也计体量；参数坏掉的那笔不记（不猜）', () => {
    const t = createTurnWriteTracker();
    t.observe('write_file', JSON.stringify({ path: 'a.ts', content: big(9_000), append: true }), true, false);
    t.observe('write_file', JSON.stringify({ path: 'a.ts', content: big(9_000), append: true }), true, false);
    t.observe('write_file', JSON.stringify({ path: 'a.ts', content: big(9_000), append: true }), true, false);
    expect(takeBuildParallelNudge()).toContain('26 KB');
    resetParallelNudgeForTests();
    const t2 = createTurnWriteTracker();
    t2.observe('write_file', '{broken', true, false);
    expect(takeBuildParallelNudge()).toBe('');
  });

  it('MCP 前缀名按基础名识别', () => {
    const t = createTurnWriteTracker();
    t.observe('mcp__fs__write_file', call(30_000), true, false);
    expect(takeBuildParallelNudge()).toContain('29 KB');
  });
});
