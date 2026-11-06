// src/coding-agent/__tests__/routerWaitBudget.test.ts
// 等待预算状态机的判据锁。时间一律显式传 now——setSystemTime 是进程全局
// 泄漏源（43c8518 判例）；模块级状态每用例 reset（bun test 单进程判例：
// 不清账就是顺序地雷）。

import { afterEach, describe, expect, it } from 'bun:test';
import {
  BASE_ROUTE_TIMEOUT_MS,
  SHRUNK_ROUTE_TIMEOUT_MS,
  recordRouterOutcome,
  resetRouterWaitBudgetForTests,
  routerTimeoutMs,
} from '../routerWaitBudget';

const T0 = 1_700_000_000_000;

afterEach(() => {
  resetRouterWaitBudgetForTests();
});

describe('routerTimeoutMs（自适应等待线）', () => {
  it('defaults to the baseline line with no history', () => {
    expect(routerTimeoutMs(T0)).toBe(BASE_ROUTE_TIMEOUT_MS);
    expect(BASE_ROUTE_TIMEOUT_MS).toBe(3_000);
  });

  it('one timeout is an accident - the line holds', () => {
    recordRouterOutcome(false, T0);
    expect(routerTimeoutMs(T0 + 1)).toBe(BASE_ROUTE_TIMEOUT_MS);
  });

  it('two consecutive timeouts shrink the line (slow endpoint: stop paying the full wait)', () => {
    recordRouterOutcome(false, T0);
    recordRouterOutcome(false, T0 + 1);
    expect(routerTimeoutMs(T0 + 2)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
    expect(SHRUNK_ROUTE_TIMEOUT_MS).toBe(2_200);
  });

  it('two verdicts under the shrunk line recover the baseline (endpoint caught up)', () => {
    recordRouterOutcome(false, T0);
    recordRouterOutcome(false, T0 + 1);
    expect(routerTimeoutMs(T0 + 2)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
    // 降线下成功必然 <2.2s——连续两笔是端点缓过来的证据。
    recordRouterOutcome(true, T0 + 3);
    expect(routerTimeoutMs(T0 + 4)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
    recordRouterOutcome(true, T0 + 5);
    expect(routerTimeoutMs(T0 + 6)).toBe(BASE_ROUTE_TIMEOUT_MS);
  });

  it('a timeout breaks the recovery streak (still shrunk)', () => {
    recordRouterOutcome(false, T0);
    recordRouterOutcome(false, T0 + 1);
    recordRouterOutcome(true, T0 + 2);
    recordRouterOutcome(false, T0 + 3);
    expect(routerTimeoutMs(T0 + 4)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
    recordRouterOutcome(true, T0 + 5);
    // 成功 streak 被失败打断后只有一笔，不够回升。
    expect(routerTimeoutMs(T0 + 6)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
  });

  it('a baseline-time verdict resets the timeout streak (no shrink)', () => {
    recordRouterOutcome(false, T0);
    recordRouterOutcome(true, T0 + 1);
    recordRouterOutcome(false, T0 + 2);
    expect(routerTimeoutMs(T0 + 3)).toBe(BASE_ROUTE_TIMEOUT_MS);
  });

  it('a 30min gap resets everything on read AND on record', () => {
    recordRouterOutcome(false, T0);
    recordRouterOutcome(false, T0 + 1);
    expect(routerTimeoutMs(T0 + 2)).toBe(SHRUNK_ROUTE_TIMEOUT_MS);
    // 读侧：隔久未跑路由，降线不该从旧时段继承。
    expect(routerTimeoutMs(T0 + 31 * 60 * 1000)).toBe(BASE_ROUTE_TIMEOUT_MS);
    // 记账侧：断档后的第一笔失败从 1 重数，不直接降线。
    recordRouterOutcome(false, T0 + 32 * 60 * 1000);
    expect(routerTimeoutMs(T0 + 32 * 60 * 1000 + 1)).toBe(BASE_ROUTE_TIMEOUT_MS);
  });
});
