// src/adapter/memory/LocalStorageMemoryStore.ts
// v0.10 — localStorage-backed IMemoryStore for the GUI (WebView / browser dev
// server). Mirrors FSMemoryStore's semantics (per-project isolation, keyword
// search, decay) with the browser's only sync persistence: localStorage.

import type { IMemoryStore, MemoryEntry, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';
import { decayEntry, findSupersedeTarget, healthScore, lifecycleOf } from './evolution';

const STORAGE_KEY = 'pure_memories_v2';

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readAll(): MemoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: MemoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota / private mode — non-fatal */ }
}

export class LocalStorageMemoryStore implements IMemoryStore {
  /** Enumerate entries, optionally scoped to a project (used by
   *  WASMEmbeddingStore's search; not part of the IMemoryStore interface). */
  list(projectPath?: string): MemoryEntry[] {
    const all = readAll();
    if (projectPath === undefined) return all;
    return all.filter(e => e.projectPath === projectPath);
  }

  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    const entries = readAll();
    // All projects share one localStorage array — the dedupe MUST include
    // projectPath, or identical content in project B collapses into project
    // A's entry and B's memory is silently lost (search(B) finds nothing).
    const dup = entries.find(e =>
      e.type === entry.type && e.projectPath === entry.projectPath && (
        e.content === entry.content ||
        (!!entry.dedupeKey && e.dedupeKey === entry.dedupeKey)
      )
    );
    if (dup) return dup.id;
    const now = Date.now();
    // 进化：同情境新策略取代旧策略（见 evolution.ts）。localStorage 全量数组，
    // 取代判定已按 projectPath 隔离。
    const target = findSupersedeTarget(entries, entry);
    const id = newId();
    const seeded: MemoryEntry = { ...entry, id, timestamp: entry.timestamp ?? now };
    if (target) {
      target.supersededBy = id;
      target.lifecycle = 'degraded';
    }
    // 默认健康分按多维公式种子化；调用方显式给的 decayScore 优先。
    const score = entry.decayScore ?? healthScore(seeded, now);
    entries.push({ ...seeded, decayScore: score, lifecycle: entry.lifecycle ?? lifecycleOf(score) });
    writeAll(entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const hits = searchMemories(readAll(), query, opts);
    // 使用频率信号：命中即 +1 并刷新 lastUsedAt。localStorage 的条目每次都是
    // 重新 parse 的对象，必须写回才能持久。
    await this.recordHits(hits);
    return hits;
  }

  async recordHits(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const all = readAll();
    if (all.length === 0) return;
    const now = Date.now();
    const byId = new Map(all.map(e => [e.id, e]));
    let changed = false;
    for (const e of entries) {
      const target = byId.get(e.id);
      if (!target) continue;
      target.hitCount = (target.hitCount ?? 0) + 1;
      target.lastUsedAt = now;
      changed = true;
    }
    if (changed) writeAll(all);
  }

  async forget(sessionId: string): Promise<void> {
    const entries = readAll().filter(e => e.sessionId !== sessionId);
    writeAll(entries);
  }

  async decay(olderThan: number): Promise<void> {
    const now = Date.now();
    const entries = readAll();
    const kept: MemoryEntry[] = [];
    let changed = false;
    for (const e of entries) {
      const outcome = decayEntry(e, now, olderThan);
      if (outcome === 'deleted') { changed = true; continue; }
      if (outcome === 'updated') changed = true;
      kept.push(e);
    }
    if (changed) writeAll(kept);
  }
}
