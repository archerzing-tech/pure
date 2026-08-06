// src/adapter/memory/LocalStorageMemoryStore.ts
// v0.10 — localStorage-backed IMemoryStore for the GUI (WebView / browser dev
// server). Mirrors FSMemoryStore's semantics (per-project isolation, keyword
// search, decay) with the browser's only sync persistence: localStorage.

import type { IMemoryStore, MemoryEntry, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';

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
    const id = newId();
    entries.push({ ...entry, id, decayScore: entry.decayScore ?? 1 });
    writeAll(entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    return searchMemories(readAll(), query, opts);
  }

  async forget(sessionId: string): Promise<void> {
    const entries = readAll().filter(e => e.sessionId !== sessionId);
    writeAll(entries);
  }

  async decay(olderThan: number): Promise<void> {
    const cutoff = Date.now() - olderThan;
    let changed = false;
    const entries = readAll();
    for (const e of entries) {
      if (e.timestamp < cutoff && (e.decayScore ?? 1) > 0.05) {
        e.decayScore = (e.decayScore ?? 1) / 2;
        changed = true;
      }
    }
    if (changed) writeAll(entries);
  }
}
