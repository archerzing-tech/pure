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
import { applyHits, decayEntry, findSupersedeTarget, healthScore, lifecycleOf } from './evolution';

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
    const now = Date.now();
    // 进化：新策略/流程/偏好与同类型旧条目针对同一情境时，新条目取代旧条目 ——
    // 旧条目打 supersededBy 标记并立即降级，之后更快走完 降级→休眠→删除。
    const target = findSupersedeTarget(entries, entry);
    const id = newId();
    const seeded: MemoryEntry = { ...entry, id, timestamp: entry.timestamp ?? now };
    if (target) {
      target.supersededBy = id;
      target.lifecycle = 'degraded';
    }
    // 默认健康分按多维公式种子化；调用方显式给的 decayScore 优先（兼容
    // 语义注入），lifecycle 与存储分数保持一致。
    const score = entry.decayScore ?? healthScore(seeded, now);
    entries.push({ ...seeded, decayScore: score, lifecycle: entry.lifecycle ?? lifecycleOf(score) });
    this.persist(project, entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const project = opts?.projectPath ?? this.defaultProject;
    const hits = searchMemories(this.load(project), query, { ...opts, projectPath: project });
    // 使用频率信号：命中即 +1 并刷新 lastUsedAt（进内存缓存，decay 时落盘）。
    await this.recordHits(hits);
    return hits;
  }

  async recordHits(entries: MemoryEntry[]): Promise<void> {
    // search()/list() 返回的就是内存缓存里的对象，直接变更即更新缓存；
    // 下一次 persist()/decay() 会把 hitCount/lastUsedAt 落盘 —— 每次检索都写
    // 文件会抵消缓存存在的意义（长会话每轮都检索记忆）。
    applyHits(entries);
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
    const now = Date.now();
    let changedAny = false;
    for (const dir of readdirSync(this.rootPath)) {
      const file = join(this.rootPath, dir, 'memories.jsonl');
      if (!existsSync(file)) continue;
      const entries = this.loadFromFile(file);
      // 合并 recordHits() 只写进内存缓存的命中数据 —— decay 直接读盘（而非缓存），
      // 不合并会把 hitCount/lastUsedAt 弄丢；合并本身也要落盘，否则这些使用频率
      // 信号会在下一次缓存清理时蒸发。
      const cached = this.cachedForDir(dir);
      let mergedAny = false;
      if (cached) {
        const byId = new Map(cached.map(c => [c.id, c]));
        for (const e of entries) {
          const c = byId.get(e.id);
          if (c && (c.hitCount ?? 0) > (e.hitCount ?? 0)) {
            e.hitCount = c.hitCount;
            e.lastUsedAt = c.lastUsedAt ?? e.lastUsedAt;
            mergedAny = true;
          }
        }
      }
      const kept: MemoryEntry[] = [];
      let changed = mergedAny;
      for (const e of entries) {
        const outcome = decayEntry(e, now, olderThan);
        if (outcome === 'deleted') { changed = true; continue; }
        if (outcome === 'updated') changed = true;
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

  /** 反向映射：hashed 目录 → 内存缓存列表（decay 合并命中数据用）。 */
  private cachedForDir(dir: string): MemoryEntry[] | undefined {
    for (const [project, list] of this.cache) {
      if (projectHash(project || this.defaultProject) === dir) return list;
    }
    return undefined;
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
