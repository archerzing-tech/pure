// src/shared/__tests__/timing.test.ts
// 审计批 3 回归：限时等待的统一入口（settleWithin / withTimeout）。
// 病根：手写 Promise.race 不清输掉竞速的定时器——work 先落定后孤儿 timer
// 仍攥着事件循环，进程要白等到超时满额才退（审计实测 settleReflections：
// 立即返回，CLI 进程仍停 30.00 秒）。

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleWithin, withTimeout } from '../timing';

const TIMING_TS = join(import.meta.dir, '..', 'timing.ts');

describe('withTimeout（超时即错误）', () => {
  it('按时落定的 work 透传其值', async () => {
    const value = await withTimeout(new Promise<string>((r) => setTimeout(() => r('ok'), 10)), 5_000, 'probe');
    expect(value).toBe('ok');
  });

  it('超时以 `${label} timed out after ${ms}ms` 拒绝（与被收编的七处手写版错误文案逐字一致）', async () => {
    let err: unknown;
    await withTimeout(new Promise<string>(() => {}), 30, 'draft').catch((e: unknown) => { err = e; });
    expect((err as Error).message).toBe('draft timed out after 30ms');
  });

  it('work 先行拒绝则原样透传该错误', async () => {
    let err: unknown;
    await withTimeout(Promise.reject(new Error('boom')), 5_000, 'probe').catch((e: unknown) => { err = e; });
    expect((err as Error).message).toBe('boom');
  });
});

describe('settleWithin（超时是正常降级）', () => {
  it('按时落定透传其值；超时回落 fallback；不带 fallback 落 undefined', async () => {
    const v1 = await settleWithin(new Promise<string>((r) => setTimeout(() => r('ok'), 10)), 5_000, () => 'fb');
    expect(v1).toBe('ok');
    const v2 = await settleWithin(new Promise<string>(() => {}), 20, () => 'fb');
    expect(v2).toBe('fb');
    const v3 = await settleWithin(new Promise<string>(() => {}), 20);
    expect(v3).toBeUndefined();
  });

  it('work 先行拒绝则原样透传（subagentMemory 依赖这一点走外层 catch 降级）', async () => {
    let err: unknown;
    await settleWithin(Promise.reject(new Error('search down')), 5_000, () => [] as string[]).catch((e: unknown) => { err = e; });
    expect((err as Error).message).toBe('search down');
  });

  it('超时之后 work 才拒绝，不炸成 unhandled rejection', async () => {
    let fired = false;
    const onUnhandled = (): void => {
      fired = true;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await settleWithin(new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late')), 60)), 10, () => 'fb');
      await new Promise((r) => setTimeout(r, 100));
      expect(fired).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('定时器必须被清理（审计批 3 的咬合面）', () => {
  // 进程级口径，即审计复现的观察面（「立即返回，进程仍停 30.00 秒」的等比
  // 缩小）：脚本 await 完就靠事件循环自然排空退出——孤儿 timer 在场时进程
  // 要活满超时满额（3s），修复后毫秒级。（Bun 的 getActiveResourcesInfo
  // 不报 pending timer，句柄差值口径在此运行时上失明，不采用。）
  it('提前落定的限时等待不再把进程拖到超时满额（settleReflections 形状）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-timing-'));
    const fixture = join(dir, 'drain.mjs');
    // 与 Harness.settleReflections 同型：allSettled 秒胜，30s→3s 的定时器
    // 输掉竞速；旧代码会把它留在循环里，进程 3 秒后才退。
    writeFileSync(
      fixture,
      [
        `const { settleWithin, withTimeout } = await import(${JSON.stringify(TIMING_TS)});`,
        'const work = new Promise((r) => setTimeout(r, 20));',
        'await withTimeout(work, 3000, "probe");',
        'await settleWithin(Promise.allSettled([work]), 3000);',
        'console.log("settled");',
        '// 故意不 process.exit：孤儿 timer 是否还攥着事件循环，由退出墙钟作证。',
      ].join('\n'),
    );
    try {
      const t0 = Date.now();
      const proc = spawnSync(process.execPath, ['run', fixture], { timeout: 15_000 });
      const elapsed = Date.now() - t0;
      expect(proc.stdout.toString()).toContain('settled');
      // 旧代码 ≥3000ms；新代码 bun 冷启动也远到不了 2500。
      expect(elapsed).toBeLessThan(2500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
