// src/adapter/memory/FSMemoryStore.ts
// v0.10 — file-based IMemoryStore (Adapter Layer 设计文档 §12.5 Phase 1).
// Layout: ~/.pure/memories/{projectHash}/memories.jsonl — one JSON MemoryEntry
// per line, isolated per project path. search() = keyword matching (see
// keywordSearch.ts), timestamp desc, top k. v2.0 swaps in WASMEmbeddingStore.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IMemoryStore, MemoryEntry, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';

function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class FSMemoryStore implements IMemoryStore {
  private rootPath: string;
  private defaultProject: string;
  // Per-project in-memory cache so search()/list() don't re-read + re-parse the
  // whole JSONL on every turn (a long session retrieves memory on EVERY turn).
  // Invalidated on add/forget/decay — the only mutating operations.
  private cache = new Map<string, MemoryEntry[]>();

  constructor(rootPath = `${process.env.HOME || homedir()}/.pure/memories`, defaultProject = '') {
    this.rootPath = rootPath;
    this.defaultProject = defaultProject;
  }

  private projectDir(projectPath: string): string {
    return join(this.rootPath, projectHash(projectPath || this.defaultProject));
  }

  private fileFor(projectPath: string): string {
    return join(this.projectDir(projectPath), 'memories.jsonl');
  }

  private load(projectPath: string): MemoryEntry[] {
    const dir = projectPath || this.defaultProject;
    const cached = this.cache.get(dir);
    if (cached) return cached;
    const entries = this.loadFromFile(this.fileFor(dir));
    this.cache.set(dir, entries);
    return entries;
  }

  private persist(projectPath: string, entries: MemoryEntry[]): void {
    const dir = this.projectDir(projectPath);
    mkdirSync(dir, { recursive: true });
    const body = entries.map(e => JSON.stringify(e)).join('\n');
    writeFileSync(join(dir, 'memories.jsonl'), body ? `${body}\n` : '', 'utf-8');
    this.cache.set(projectPath || this.defaultProject, entries);
  }

  /** Enumerate all entries for a project (used by WASMEmbeddingStore's search
   *  to embed + rank the full set; not part of the IMemoryStore interface). */
  list(projectPath?: string): MemoryEntry[] {
    return this.load(projectPath ?? this.defaultProject);
  }

  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    const project = entry.projectPath || this.defaultProject;
    const entries = this.load(project);
    // Skip exact or keyed duplicates (same type + project) so repeated
    // continuation turns do not pile up the same reusable lesson.
    const duplicate = entries.find(e =>
      e.type === entry.type && (
        e.content === entry.content ||
        (!!entry.dedupeKey && e.dedupeKey === entry.dedupeKey)
      )
    );
    if (duplicate) return duplicate.id;
    const id = newId();
    entries.push({ ...entry, id, decayScore: entry.decayScore ?? 1 });
    this.persist(project, entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const project = opts?.projectPath ?? this.defaultProject;
    return searchMemories(this.load(project), query, { ...opts, projectPath: project });
  }

  async forget(sessionId: string): Promise<void> {
    if (!existsSync(this.rootPath)) return;
    for (const dir of readdirSync(this.rootPath)) {
      const file = join(this.rootPath, dir, 'memories.jsonl');
      if (!existsSync(file)) continue;
      const entries = this.loadFromFile(file);
      const remaining = entries.filter(e => e.sessionId !== sessionId);
      if (remaining.length !== entries.length) {
        const body = remaining.map(e => JSON.stringify(e)).join('\n');
        writeFileSync(file, body ? `${body}\n` : '', 'utf-8');
      }
    }
    // Cache keys are project paths, dirs are hashes — nuke the whole mirror
    // (forget is rare; the next search re-reads from disk).
    this.cache.clear();
  }

  async decay(olderThan: number): Promise<void> {
    if (!existsSync(this.rootPath)) return;
    const cutoff = Date.now() - olderThan;
    let changedAny = false;
    for (const dir of readdirSync(this.rootPath)) {
      const file = join(this.rootPath, dir, 'memories.jsonl');
      if (!existsSync(file)) continue;
      const entries = this.loadFromFile(file);
      const kept: MemoryEntry[] = [];
      let changed = false;
      for (const e of entries) {
        const score = e.decayScore ?? 1;
        if (e.timestamp < cutoff && score > 0.05) {
          const next = score / 2;
          if (next <= 0.05) {
            // Halving would sink this memory below the forget floor — delete it
            // outright so stale, unused lessons eventually leave the file
            // ("慢慢降级，然后删除"), not just sink in ranking forever.
            changed = true;
            continue;
          }
          e.decayScore = next;
          changed = true;
        }
        kept.push(e);
      }
      if (changed) {
        changedAny = true;
        const body = kept.map(e => JSON.stringify(e)).join('\n');
        writeFileSync(file, body ? `${body}\n` : '', 'utf-8');
      }
    }
    // Only nuke the cache mirror when decay actually rewrote something —
    // otherwise a per-turn decay() (Harness schedules it at every run) would
    // clear the cache unconditionally and defeat the point of caching at all.
    if (changedAny) this.cache.clear();
  }

  /** Raw file loader used by forget/decay which iterate hashed dirs directly. */
  private loadFromFile(file: string): MemoryEntry[] {
    if (!existsSync(file)) return [];
    const entries: MemoryEntry[] = [];
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return entries;
  }
}
