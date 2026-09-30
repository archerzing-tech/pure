// src/channels/sessionIndex.ts
// ~/.pure/channels/sessions.json —— sessionKey → { sessionId, lastActivityAt, workspace }。
// 重启后凭 sessionId 让 Harness 从 checkpoint 恢复同一会话（设计文档 §5.2）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionIndexEntry {
  sessionId: string;
  lastActivityAt: number;
  workspace: string | null;
}

export class ChannelSessionIndex {
  private entries = new Map<string, SessionIndexEntry>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, SessionIndexEntry>;
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value.sessionId === 'string') this.entries.set(key, value);
      }
    } catch {
      // 索引损坏不应阻止启动：当作空索引，会话从新开始。
      this.entries.clear();
    }
  }

  get(sessionKey: string): SessionIndexEntry | undefined {
    return this.entries.get(sessionKey);
  }

  set(sessionKey: string, entry: SessionIndexEntry): void {
    this.entries.set(sessionKey, entry);
    this.persist();
  }

  touch(sessionKey: string, at: number): void {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    entry.lastActivityAt = at;
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.entries), null, 2), 'utf8');
    } catch {
      // 索引写失败只影响重启恢复，不影响当前进程的会话。
    }
  }
}
