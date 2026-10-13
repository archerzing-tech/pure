// src/adapter/mcp/__tests__/tauriStdioTransport.test.ts
// 审计批 4⑥：ensureSpawned 的单飞闸。没有它，并发首调各自看到
// spawned=false 就各 invoke 一遍 spawn_mcp，Rust 侧同键注册表覆盖旧
// handle——旧子进程从此没人杀，每个重复 spawn 泄漏一个进程。
//
// 走法：直接驱动私有 ensureSpawned、用实例级覆写替掉 doSpawn（仓库既有
// 的 (x as unknown as {...}) 私有访问惯例）。不碰模块级 mock——mock.module
// 是全进程注册，全量跑时会与别的测试文件互踩。

import { describe, expect, it } from 'bun:test';
import { TauriStdioTransport } from '../TauriStdioTransport';

interface SpawnSeam {
  ensureSpawned(): Promise<void>;
  doSpawn(): Promise<void>;
}

function makeTransport(): { transport: TauriStdioTransport; seam: SpawnSeam } {
  const transport = new TauriStdioTransport('sess', 'srv', ['some-server']);
  const seam = transport as unknown as SpawnSeam;
  return { transport, seam };
}

describe('TauriStdioTransport spawn single-flight (审计批 4⑥)', () => {
  it('concurrent first calls share one in-flight spawn', async () => {
    const { seam } = makeTransport();
    let spawnCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seam.doSpawn = () => {
      spawnCount += 1;
      // 首次 spawn 押住：第二个并发调用必须等同一个在飞 promise，而不是
      // 自己再 spawn 一遍。
      return spawnCount === 1 ? gate : Promise.resolve();
    };

    const p1 = seam.ensureSpawned();
    const p2 = seam.ensureSpawned();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnCount).toBe(1);

    release();
    await Promise.all([p1, p2]);
    expect(spawnCount).toBe(1); // spawn_mcp 只 invoke 一次
  });

  it('a failed spawn does not wedge the gate — the next call retries', async () => {
    const { seam } = makeTransport();
    let count = 0;
    seam.doSpawn = () => {
      count += 1;
      return count === 1 ? Promise.reject(new Error('spawn blew up')) : Promise.resolve();
    };

    await expect(seam.ensureSpawned()).rejects.toThrow('spawn blew up');
    await seam.ensureSpawned(); // 失败不锁门
    expect(count).toBe(2);
  });
});
