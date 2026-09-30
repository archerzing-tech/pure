// src/channels/audit.ts
// 通道审计（设计文档 §6.2）。默认**不落原文** —— 沿用 promptObservability 的
// 隐私姿态：只记时间、通道、peer 的哈希、会话键、决定、工具名、参数哈希。
// 排障需要全文时用 PURE_CHANNEL_AUDIT=full 显式打开。
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditDecision = 'routed' | 'unpaired' | 'rate-limited' | 'budget-exceeded' | 'ignored' | 'approved' | 'denied';

export interface AuditRecord {
  ts: number;
  channelId: string;
  peerHash: string;
  sessionKey?: string;
  decision: AuditDecision;
  tool?: string;
  argsHash?: string;
  /** 仅 PURE_CHANNEL_AUDIT=full 且调用方显式传入时才有。 */
  text?: string;
}

export interface ChannelAuditOptions {
  path: string;
  /** true 时记录原文（PURE_CHANNEL_AUDIT=full）。 */
  full?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

/** 稳定的短哈希：审计里不出现任何平台原始 id。 */
export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export class ChannelAuditLog {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  readonly full: boolean;

  constructor(private readonly options: ChannelAuditOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.full = options.full ?? process.env.PURE_CHANNEL_AUDIT === 'full';
  }

  record(input: Omit<AuditRecord, 'ts' | 'peerHash'> & { peerId: string; textLength?: number }): void {
    const record = {
      ts: this.now(),
      channelId: input.channelId,
      peerHash: hashId(input.peerId),
      sessionKey: input.sessionKey,
      decision: input.decision,
      tool: input.tool,
      argsHash: input.argsHash,
      ...(this.full && input.text !== undefined ? { text: input.text } : {}),
      ...(input.textLength !== undefined ? { textLength: input.textLength } : {}),
    };
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      appendFileSync(this.options.path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      // 审计写失败不能影响 agent 运行。
      this.log(`audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
