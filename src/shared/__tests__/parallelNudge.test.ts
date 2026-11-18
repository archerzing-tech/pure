// src/shared/__tests__/parallelNudge.test.ts
// 生产侧并行提醒的记账面（2026-11-18 大屏复测判例：114.9KB 主线直写零委派）。

import { describe, it, expect, beforeEach } from 'bun:test';
import { recordMainThreadWriteBytes, resetParallelNudgeForTests, takeBuildParallelNudge } from '../parallelNudge';

beforeEach(() => resetParallelNudgeForTests());

describe('recordMainThreadWriteBytes / takeBuildParallelNudge', () => {
  it('越过阈值才落处方：小写入零注入', () => {
    recordMainThreadWriteBytes(30_000, 4);
    expect(takeBuildParallelNudge()).toBe('');
  });

  it('累计越阈（调用方传累计总量）落一条含体量的处方', () => {
    recordMainThreadWriteBytes(20_000, 2);
    expect(takeBuildParallelNudge()).toBe('');
    recordMainThreadWriteBytes(45_000, 3);
    expect(takeBuildParallelNudge()).toBe('');
    recordMainThreadWriteBytes(65_000, 4);
    const nudge = takeBuildParallelNudge();
    expect(nudge).toContain('63 KB');
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
