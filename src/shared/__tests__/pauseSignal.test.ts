// src/shared/__tests__/pauseSignal.test.ts
// S2 第四刀收口：升级硬停纯函数的判定与副作用契约。判定必须先于宿主的
// abort——本文件同时锁「升级不碰主信号」（reason 保留是宿主 cancel() 能
// 读到暂停态的前提，时序契约由调用方保证，这里锁的是函数自身零副作用）。

import { describe, expect, test } from 'bun:test';
import { BRANCH_ABORT_REASON, PAUSE_ABORT_REASON, isPauseAbort, upgradeToHardStop } from '../pauseSignal';

describe('upgradeToHardStop', () => {
  test('暂停态：升级——硬停通道当场打断，返回 true，主信号 reason 不被冲掉', () => {
    const main = new AbortController();
    const hardStop = new AbortController();
    main.abort(PAUSE_ABORT_REASON);
    expect(isPauseAbort(main.signal)).toBe(true);

    expect(upgradeToHardStop(main.signal, hardStop)).toBe(true);
    expect(hardStop.signal.aborted).toBe(true);
    // 升级本身不碰主信号：暂停 reason 原样保留，收尾的 abort 由宿主执行
    expect(isPauseAbort(main.signal)).toBe(true);
    expect((main.signal as { reason?: unknown }).reason).toBe(PAUSE_ABORT_REASON);
  });

  test('非暂停 abort（硬停/分支叫停）：不升级，返回 false，硬停通道不动', () => {
    const main = new AbortController();
    const hardStop = new AbortController();
    main.abort();
    expect(upgradeToHardStop(main.signal, hardStop)).toBe(false);
    expect(hardStop.signal.aborted).toBe(false);

    const branch = new AbortController();
    const other = new AbortController();
    branch.abort(BRANCH_ABORT_REASON);
    expect(upgradeToHardStop(branch.signal, other)).toBe(false);
    expect(other.signal.aborted).toBe(false);
  });

  test('null/undefined 容错：未升级路径零副作用', () => {
    expect(upgradeToHardStop(null, new AbortController())).toBe(false);
    expect(upgradeToHardStop(undefined, undefined)).toBe(false);
    const main = new AbortController();
    expect(upgradeToHardStop(main.signal, null)).toBe(false);
    expect(main.signal.aborted).toBe(false);
  });
});
