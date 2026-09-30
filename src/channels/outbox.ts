// src/channels/outbox.ts
// 出站可靠投递（设计文档 §7 双队列）。进度帧是可丢的，最终结果 / 审批 / 错误
// 走 outbox：失败重试 + 重启重放。
//
// 持久化（P2 前移）：给了 `path` 就落 ~/.pure/channels/outbox.jsonl —— 每条入队
// 即写、每次投递/放弃即重写整份文件。进程在 drain 中途挂掉，未投递的条目仍在
// 盘上，下次启动重放。附件以 base64 过 JSON。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelSender, ChannelTarget, OutboundAttachment, OutboundMessage } from './types';

export interface OutboxOptions {
  maxAttempts?: number;
  backoffMs?: number;
  /** 注入的睡眠函数（测试用），默认真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** JSONL 落盘路径；省略则为纯内存队列。 */
  path?: string;
}

interface OutboxEntry {
  seq: number;
  channelId: string;
  target: ChannelTarget;
  message: OutboundMessage;
  attempts: number;
}

export interface DrainResult {
  delivered: number;
  failed: number;
}

interface SerializedEntry {
  seq: number;
  channelId: string;
  target: ChannelTarget;
  message: Omit<OutboundMessage, 'attachments'> & { attachments?: Array<Omit<OutboundAttachment, 'data'> & { dataBase64: string }> };
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function serialize(entry: OutboxEntry): SerializedEntry {
  const { attachments, ...message } = entry.message;
  return {
    seq: entry.seq,
    channelId: entry.channelId,
    target: entry.target,
    attempts: entry.attempts,
    message: {
      ...message,
      attachments: attachments?.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        dataBase64: Buffer.from(a.data).toString('base64'),
      })),
    },
  };
}

function deserialize(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SerializedEntry>;
  if (typeof value.seq !== 'number' || typeof value.channelId !== 'string' || !value.target || !value.message) return null;
  const { attachments, ...message } = value.message as SerializedEntry['message'];
  return {
    seq: value.seq,
    channelId: value.channelId,
    target: value.target,
    attempts: value.attempts ?? 0,
    message: {
      ...message,
      attachments: attachments?.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        data: new Uint8Array(Buffer.from(a.dataBase64, 'base64')),
      })),
    },
  };
}

export class MemoryOutbox {
  /** seq → entry。Map 保留插入顺序，drain 按入队顺序投递。 */
  private entries = new Map<number, OutboxEntry>();
  private seq = 0;
  private draining = false;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly path?: string;

  constructor(private readonly resolveSender: (channelId: string) => ChannelSender | undefined, options: OutboxOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 250;
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? ((m) => console.warn(`[channels] ${m}`));
    this.path = options.path;
    if (this.path) this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim());
      for (const line of lines) {
        const entry = deserialize(JSON.parse(line));
        if (!entry) continue;
        this.entries.set(entry.seq, entry);
        if (entry.seq > this.seq) this.seq = entry.seq;
      }
      if (this.entries.size > 0) this.log(`replayed ${this.entries.size} queued message(s) from ${this.path}`);
    } catch (err) {
      this.log(`outbox file unreadable (${err instanceof Error ? err.message : String(err)}); starting empty`);
      this.entries.clear();
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = [...this.entries.values()].map((entry) => JSON.stringify(serialize(entry))).join('\n');
      writeFileSync(this.path, body ? `${body}\n` : '', 'utf8');
    } catch (err) {
      this.log(`outbox persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  enqueue(channelId: string, target: ChannelTarget, message: OutboundMessage): number {
    const entry: OutboxEntry = { seq: ++this.seq, channelId, target, message, attempts: 0 };
    this.entries.set(entry.seq, entry);
    this.persist();
    return entry.seq;
  }

  get pendingCount(): number {
    return this.entries.size;
  }

  /** 依次尝试投递所有条目；失败的重试到上限后丢弃。中途崩溃的条目仍留在盘上。 */
  async drain(): Promise<DrainResult> {
    if (this.draining) return { delivered: 0, failed: 0 };
    this.draining = true;
    const result: DrainResult = { delivered: 0, failed: 0 };
    try {
      for (const entry of [...this.entries.values()]) {
        if (!this.entries.has(entry.seq)) continue;
        const sender = this.resolveSender(entry.channelId);
        if (!sender) {
          this.log(`no adapter for channel "${entry.channelId}" — dropping message`);
          this.entries.delete(entry.seq);
          this.persist();
          result.failed += 1;
          continue;
        }
        let ok = false;
        while (entry.attempts < this.maxAttempts) {
          entry.attempts += 1;
          try {
            await sender.send(entry.target, entry.message, { edit: !!entry.message.messageId });
            ok = true;
            break;
          } catch {
            if (entry.attempts >= this.maxAttempts) break;
            await this.sleep(this.backoffMs * entry.attempts);
          }
        }
        this.entries.delete(entry.seq);
        this.persist();
        if (ok) result.delivered += 1;
        else {
          result.failed += 1;
          this.log(`message ${entry.seq} abandoned after ${entry.attempts} attempts`);
        }
      }
    } finally {
      this.draining = false;
    }
    return result;
  }
}
