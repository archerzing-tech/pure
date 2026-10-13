// src/shared/__tests__/signalShutdown.test.ts
// 审计批 6④ — 双信号停机状态机。三个依赖全注入，测试不碰真实进程。
import { describe, expect, it } from 'bun:test';
import { createSignalShutdown } from '../signalShutdown';

describe('createSignalShutdown (审计批 6④)', () => {
  it('first signal runs graceful once and never force-exits', () => {
    let gracefulRuns = 0;
    const exits: number[] = [];
    const logs: string[] = [];
    const shutdown = createSignalShutdown(
      () => { gracefulRuns++; },
      (code) => exits.push(code),
      (m) => logs.push(m),
    );
    shutdown('SIGINT');
    expect(gracefulRuns).toBe(1);
    expect(exits).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('second signal while graceful is still hanging force-exits 130 (旧写法在这里吞掉第二击)', () => {
    const exits: number[] = [];
    let release!: () => void;
    const shutdown = createSignalShutdown(
      () => new Promise<void>((resolve) => { release = resolve; }), // 挂住不落定
      (code) => exits.push(code),
      () => {},
    );
    shutdown('SIGINT');
    shutdown('SIGINT');
    expect(exits).toEqual([130]);
    release();
  });

  it('a second signal force-exits even after graceful settled (契约：标志不复位；真实接线里优雅路径已完成即进程已死，多退无害)', async () => {
    const exits: number[] = [];
    const shutdown = createSignalShutdown(
      async () => {},
      (code) => exits.push(code),
      () => {},
    );
    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));
    shutdown('SIGTERM');
    expect(exits).toEqual([130]);
  });
});
