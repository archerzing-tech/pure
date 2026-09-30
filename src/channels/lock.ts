// src/channels/lock.ts
// 单实例进程锁（设计文档 §5.1 / R11）。飞书集群模式只有一个客户端收到消息、
// 企微新连接会踢掉旧连接 —— 第二个 gateway 实例会导致消息静默丢失且极难排查，
// 所以这是正确性问题，不是优化，P0 就要有。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GatewayLockInfo {
  pid: number;
  startedAt: number;
  channels: string[];
}

export class GatewayLockError extends Error {
  constructor(message: string, readonly holder?: GatewayLockInfo) {
    super(message);
    this.name = 'GatewayLockError';
  }
}

export interface GatewayLockHandle {
  path: string;
  info: GatewayLockInfo;
  release(): void;
}

/** 进程是否活着：EPERM 也算活着（存在但无权限发信号）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(path: string): GatewayLockInfo | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GatewayLockInfo>;
    if (typeof raw.pid !== 'number') return null;
    return { pid: raw.pid, startedAt: raw.startedAt ?? 0, channels: raw.channels ?? [] };
  } catch {
    return null;
  }
}

/**
 * 抢占 gateway 锁。锁文件里的 pid 还活着 → 抛 GatewayLockError（附持有者信息）；
 * 陈旧锁（pid 已死 / 文件损坏）直接覆盖。
 */
export function acquireGatewayLock(path: string, info: Omit<GatewayLockInfo, 'pid' | 'startedAt'> & { startedAt?: number }): GatewayLockHandle {
  mkdirSync(dirname(path), { recursive: true });
  const holder = readLock(path);
  // 同一个进程也不允许开第二个 gateway：进程内的第二个宿主同样会与第一个抢同一条
  // 平台连接（飞书集群模式/企微踢连接），冲突必须一样挡下。
  if (holder && isProcessAlive(holder.pid)) {
    throw new GatewayLockError(
      `已有实例在运行（pid ${holder.pid}，已连接 ${holder.channels.join(', ') || '无通道'}）。` +
      '多实例会导致消息随机丢失或被平台踢下线，已拒绝启动。',
      holder,
    );
  }
  const full: GatewayLockInfo = { pid: process.pid, startedAt: info.startedAt ?? Date.now(), channels: info.channels };
  writeFileSync(path, JSON.stringify(full, null, 2), 'utf8');
  return {
    path,
    info: full,
    release: () => {
      // 只删自己写的锁，避免误删后来者的锁。
      const current = readLock(path);
      if (current && current.pid === full.pid) {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    },
  };
}
