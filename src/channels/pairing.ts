// src/channels/pairing.ts
// 第一层入口信任（设计文档 §6.1）：dmPolicy: pairing(默认) | allowlist | open。
// 首次私信生成配对码，必须在本地 `pure channels approve <code>` 批准；未配对来源
// 根本不进 agent（不是靠提示词自觉）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export type DmPolicy = 'pairing' | 'allowlist' | 'open';

export interface PendingPairing {
  code: string;
  channelId: string;
  peerId: string;
  name?: string;
  createdAt: number;
}

export interface PairedPeer {
  channelId: string;
  peerId: string;
  name?: string;
  approvedAt: number;
}

export interface PairingCheck {
  allowed: boolean;
  /** 未配对且策略为 pairing 时给出的配对码。 */
  code?: string;
  /** 这次检查刚生成新码（用于只提示一次）。 */
  isNew?: boolean;
}

export interface PairingGateOptions {
  pendingPath: string;
  peersPath: string;
  now?: () => number;
  log?: (message: string) => void;
}

function keyOf(channelId: string, peerId: string): string {
  return `${channelId}:${peerId}`;
}

function randomCode(): string {
  // 8 位大写 base32-ish，避免易混字符。
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export class PairingGate {
  private pending = new Map<string, PendingPairing>();
  private peers = new Map<string, PairedPeer>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PairingGateOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.pending = this.load<PendingPairing>(options.pendingPath, (v) => typeof v.code === 'string' && typeof v.peerId === 'string');
    this.peers = this.load<PairedPeer>(options.peersPath, (v) => typeof v.peerId === 'string');
  }

  private load<T extends { peerId: string }>(path: string, valid: (v: Partial<T>) => boolean): Map<string, T> {
    const out = new Map<string, T>();
    try {
      if (!existsSync(path)) return out;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<T>>;
      for (const [key, value] of Object.entries(raw)) {
        if (value && valid(value)) out.set(key, value as T);
      }
    } catch {
      this.log(`pairing file unreadable: ${path} (starting empty)`);
    }
    return out;
  }

  private persist(path: string, data: Map<string, unknown>): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(Object.fromEntries(data), null, 2), 'utf8');
    } catch (err) {
      this.log(`pairing persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isPaired(channelId: string, peerId: string): boolean {
    return this.peers.has(keyOf(channelId, peerId));
  }

  check(channelId: string, peerId: string, policy: DmPolicy, name?: string): PairingCheck {
    if (policy === 'open' || this.isPaired(channelId, peerId)) return { allowed: true };
    if (policy === 'allowlist') return { allowed: false };

    const key = keyOf(channelId, peerId);
    const existing = this.pending.get(key);
    if (existing) return { allowed: false, code: existing.code };
    const pending: PendingPairing = { code: randomCode(), channelId, peerId, name, createdAt: this.now() };
    this.pending.set(key, pending);
    this.persist(this.options.pendingPath, this.pending);
    this.log(`pairing requested by ${key} — code ${pending.code}`);
    return { allowed: false, code: pending.code, isNew: true };
  }

  approve(code: string): PairedPeer | null {
    const normalized = code.trim().toUpperCase();
    for (const [key, pending] of this.pending) {
      if (pending.code !== normalized) continue;
      this.pending.delete(key);
      const peer: PairedPeer = { channelId: pending.channelId, peerId: pending.peerId, name: pending.name, approvedAt: this.now() };
      this.peers.set(key, peer);
      this.persist(this.options.pendingPath, this.pending);
      this.persist(this.options.peersPath, this.peers);
      return peer;
    }
    return null;
  }

  revoke(channelId: string, peerId: string): boolean {
    const key = keyOf(channelId, peerId);
    if (!this.peers.delete(key)) return false;
    this.persist(this.options.peersPath, this.peers);
    return true;
  }

  listPending(): PendingPairing[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  listPeers(): PairedPeer[] {
    return [...this.peers.values()].sort((a, b) => a.approvedAt - b.approvedAt);
  }
}

/** 未配对来源的固定文案（gateway 只回这一句，不进 agent）。 */
export function pairingNotice(code: string): string {
  return [
    '这是未配对的来源，已挡在 agent 之外。',
    `请让管理员在本机运行：pure channels approve ${code}`,
    '批准后这条会话才会开始工作。',
  ].join('\n');
}
