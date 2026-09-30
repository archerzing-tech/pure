import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGatewayLock, GatewayLockError, isProcessAlive, readLock } from '../lock';

describe('gateway lock', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-chlock-'));
    path = join(dir, 'nested', 'gateway.lock');
    mkdirSync(join(dir, 'nested'), { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('acquires a free lock and writes holder info', () => {
    const handle = acquireGatewayLock(path, { channels: ['webchat'] });
    const info = readLock(path);
    expect(info?.pid).toBe(process.pid);
    expect(info?.channels).toEqual(['webchat']);
    handle.release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to start when a live instance holds the lock', () => {
    // pid 1 (launchd/init) is always alive on POSIX; EPERM also counts as alive.
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: 1, channels: ['feishu'] }));
    expect(isProcessAlive(1)).toBe(true);
    expect(() => acquireGatewayLock(path, { channels: [] })).toThrow(GatewayLockError);
    try {
      acquireGatewayLock(path, { channels: [] });
    } catch (err) {
      expect((err as GatewayLockError).holder?.pid).toBe(1);
      expect((err as Error).message).toContain('已有实例在运行');
    }
  });

  it('overwrites a stale lock whose process is gone', () => {
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, startedAt: 1, channels: [] }));
    const handle = acquireGatewayLock(path, { channels: ['webchat'] });
    expect(readLock(path)?.pid).toBe(process.pid);
    handle.release();
  });

  it('tolerates a corrupted lock file', () => {
    writeFileSync(path, 'not json');
    const handle = acquireGatewayLock(path, { channels: [] });
    expect(handle.info.pid).toBe(process.pid);
    handle.release();
  });

  it('release does not delete a lock owned by someone else', () => {
    const handle = acquireGatewayLock(path, { channels: [] });
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: 2, channels: [] }));
    handle.release();
    expect(existsSync(path)).toBe(true);
    expect(readLock(path)?.pid).toBe(1);
  });
});
