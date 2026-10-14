// src/adapter/mcp/__tests__/tauriStdioTransport.test.ts
// 审计批 4⑥：ensureSpawned 的单飞闸。没有它，并发首调各自看到
// spawned=false 就各 invoke 一遍 spawn_mcp，Rust 侧同键注册表覆盖旧
// handle——旧子进程从此没人杀，每个重复 spawn 泄漏一个进程。
//
// 懒重生：Rust 侧判死丢句柄后给错误打「MCP server process gone」前缀，
// TS 侧据此摘 spawned 闩，下一次 send/notify 经 ensureSpawned 懒重生——
// GUI 版的 CLI StdioTransport「exit→teardown→下次 send 重生」。
//
// 走法：直接驱动私有 ensureSpawned、用实例级覆写替掉 doSpawn（仓库既有
// 的 (x as unknown as {...}) 私有访问惯例）。不碰模块级 mock——mock.module
// 是全进程注册，全量跑时会与别的测试文件互踩。

import { describe, expect, it } from 'bun:test';
import { TauriStdioTransport } from '../TauriStdioTransport';

interface SpawnSeam {
  ensureSpawned(): Promise<void>;
  doSpawn(): Promise<void>;
  invokeCommand(cmd: string, args: Record<string, unknown>): Promise<unknown>;
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

// ── 懒重生：子进程死亡 → 当次请求明确失败 → 下一次 send 重生 ──────────

/** 假 Rust 回答：按请求的 id 原样回一张成功 JSON-RPC 响应（真 mcp_request
 *  按 id 匹配回包，mock 保持同一契约）。 */
function echoOk(args: Record<string, unknown>): Promise<string> {
  const req = JSON.parse(args.request as string) as { id: number };
  return Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }));
}

describe('TauriStdioTransport lazy respawn after child death', () => {
  it('a dead child fails the current request clearly and the next send respawns', async () => {
    const { transport, seam } = makeTransport();
    let spawnCount = 0;
    seam.doSpawn = () => {
      spawnCount += 1;
      return Promise.resolve();
    };
    let requestCount = 0;
    seam.invokeCommand = (cmd, args) => {
      if (cmd === 'mcp_request') {
        requestCount += 1;
        // 首次：Rust 判死丢句柄后的标记错误（前缀与 mcp.rs 成对）。
        if (requestCount === 1) {
          return Promise.reject(
            new Error('MCP server process gone: MCP server closed stdout (process exited)'),
          );
        }
        return echoOk(args);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    };

    // 当次请求拿到明确失败（前缀 + 原始细节），不当场悄悄重试。
    await expect(transport.send('tools/list')).rejects.toThrow(
      'MCP server process gone: MCP server closed stdout',
    );
    expect(spawnCount).toBe(1);

    // 下一次 send 懒重生：重新 spawn、请求成功。
    const result = (await transport.send('tools/list')) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(spawnCount).toBe(2);
    expect(requestCount).toBe(2);
  });

  it('a stale handle ("MCP not found") un-latches the same way', async () => {
    const { transport, seam } = makeTransport();
    let spawnCount = 0;
    seam.doSpawn = () => {
      spawnCount += 1;
      return Promise.resolve();
    };
    let requestCount = 0;
    seam.invokeCommand = (cmd, args) => {
      if (cmd === 'mcp_request') {
        requestCount += 1;
        // 死亡检测丢句柄与下一请求查表竞态时，第二者拿到的是查表失败。
        if (requestCount === 1) {
          return Promise.reject(new Error('MCP not found: sess:srv'));
        }
        return echoOk(args);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    };

    await expect(transport.send('tools/list')).rejects.toThrow('MCP not found');
    const result = (await transport.send('tools/list')) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(spawnCount).toBe(2);
  });

  it('ordinary failures keep the latch — the next send reuses the process', async () => {
    const { transport, seam } = makeTransport();
    let spawnCount = 0;
    seam.doSpawn = () => {
      spawnCount += 1;
      return Promise.resolve();
    };
    seam.invokeCommand = () => Promise.reject(new Error('MCP error -32000: server said no'));

    await expect(transport.send('tools/list')).rejects.toThrow('server said no');
    await expect(transport.send('tools/list')).rejects.toThrow('server said no');
    // JSON-RPC 错误与重生无关：不摘闩、不重生。
    expect(spawnCount).toBe(1);
  });

  it('notify on a dead child un-latches so the next notify respawns', async () => {
    const { transport, seam } = makeTransport();
    let spawnCount = 0;
    seam.doSpawn = () => {
      spawnCount += 1;
      return Promise.resolve();
    };
    let notifyCount = 0;
    seam.invokeCommand = (cmd) => {
      if (cmd === 'mcp_notify') {
        notifyCount += 1;
        if (notifyCount === 1) {
          return Promise.reject(new Error('MCP server process gone: write stdin: Broken pipe'));
        }
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    };

    await expect(transport.notify('initialized')).rejects.toThrow('MCP server process gone');
    await transport.notify('initialized');
    expect(spawnCount).toBe(2);
  });
});
