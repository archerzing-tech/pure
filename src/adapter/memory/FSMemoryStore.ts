// src/adapter/memory/FSMemoryStore.ts
// v0.10 — file-based IMemoryStore (Adapter Layer 设计文档 §12.5 Phase 1).
// Layout: ~/.pure/memories/{projectHash}/memories.jsonl — one JSON MemoryEntry
// per line, isolated per project path. search() = keyword matching (see
// keywordSearch.ts), timestamp desc, top k. v2.0 swaps in WASMEmbeddingStore.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IMemoryStore, MemoryEntry, MemoryListOptions, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';
import { EVOLUTION, applyHits, decayEntry, findSupersedeTarget, healthScore, lifecycleOf, type EvolutionConfig } from './evolution';
import type { MemoryDecayInfo } from './LocalStorageMemoryStore';
import { GLOBAL_MEMORY_SCOPE } from '../../shared/types';

function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class FSMemoryStore implements IMemoryStore {
  private rootPath: string;
  private defaultProject: string;
  // 进化阈值（Settings → Memory → 遗忘速度；CLI 经环境变量 PURE_MEMORY_*）。
  // 静态快照 —— CLI 无 UI，进程启动时固定；GUI 用 LocalStorageMemoryStore。
  private evolution?: Partial<EvolutionConfig>;
  // 衰减运行信息缓存（meta.json 的读缓存；decay 后同步更新）。
  private decayInfo: MemoryDecayInfo | null = null;
  // Per-project in-memory cache so search()/list() don't re-read + re-parse the
  // whole JSONL on every turn (a long session retrieves memory on EVERY turn).
  // Invalidated on add/forget/decay — the only mutating operations.
  private cache = new Map<string, MemoryEntry[]>();

  constructor(
    rootPath = `${process.env.HOME || homedir()}/.pure/memories`,
    defaultProject = '',
    evolution?: Partial<EvolutionConfig>,
  ) {
    this.rootPath = rootPath;
    this.defaultProject = defaultProject;
    this.evolution = evolution;
    // 一次性迁移：把旧版本（v1.9.11 之前）按项目隔离写入的 tool_preference
    // 搬进机器级全局作用域，避免与常驻注入重复。幂等 + meta 标记只跑一次。
    this.migrateLegacyToolPreferences();
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

  /** Enumerate entries for a project (used by WASMEmbeddingStore's search to
   *  embed + rank the full set, and by the Harness for machine-global
   *  always-inject). Accepts a project path string (legacy) or filter
   *  options; activeOnly drops dormant entries (健康分 ≤ dormantMax).
   *  不记录命中（list 是枚举，不是检索）。 */
  list(opts?: string | MemoryListOptions): MemoryEntry[] {
    const project = typeof opts === 'string' ? opts : (opts?.projectPath ?? this.defaultProject);
    let entries = this.load(project);
    if (opts && typeof opts !== 'string') {
      const now = Date.now();
      const cfg = this.evolution;
      const dormantMax = cfg?.dormantMax ?? EVOLUTION.DORMANT_MAX;
      if (opts.type !== undefined) entries = entries.filter(e => e.type === opts.type);
      if (opts.platform !== undefined) entries = entries.filter(e => e.platform === opts.platform);
      if (opts.activeOnly) entries = entries.filter(e => healthScore(e, now, cfg) >= dormantMax);
    }
    return entries;
  }

  /** 上次衰减运行信息（诊断用；非 IMemoryStore 接口成员）。返回拷贝，
   *  调用方 mutate 不影响内部缓存（与 LocalStorageMemoryStore 每次
   *  readMeta() 重新 parse 的"新鲜独立对象"语义一致）。 */
  getLastDecayInfo(): MemoryDecayInfo {
    if (this.decayInfo) return { ...this.decayInfo };
    try {
      const file = join(this.rootPath, 'meta.json');
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as MemoryDecayInfo;
      this.decayInfo = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this.decayInfo = {};
    }
    return { ...this.decayInfo };
  }

  private writeDecayInfo(info: MemoryDecayInfo): void {
    this.decayInfo = info;
    try {
      mkdirSync(this.rootPath, { recursive: true });
      writeFileSync(join(this.rootPath, 'meta.json'), JSON.stringify(info), 'utf-8');
    } catch { /* non-fatal */ }
  }

  /**
   * 一次性迁移：旧版本把 tool_preference 按项目隔离写入；现在它们属于机器级
   * 全局作用域（跨项目常驻注入）。扫描所有项目文件，把项目作用域的
   * tool_preference 搬进全局文件并去重（dedupeKey 优先，其次 type+content+
   * platform），保留原 id / 使用频率 / 取代链。meta.json 记 migratedToolPrefsAt
   * 标记，之后进程不再扫描；无旧条目时也不写标记（空库扫描几乎零成本）。
   */
  private migrateLegacyToolPreferences(): void {
    if (this.decayInfo?.migratedToolPrefsAt) return;
    if (!existsSync(this.rootPath)) return;
    const globalDir = projectHash(GLOBAL_MEMORY_SCOPE);
    let global = this.loadFromFile(this.fileFor(GLOBAL_MEMORY_SCOPE));
    const matches = (a: MemoryEntry, b: MemoryEntry): boolean =>
      a.type === b.type && a.platform === b.platform && (
        (!!a.dedupeKey && a.dedupeKey === b.dedupeKey) ||
        (!a.dedupeKey && !b.dedupeKey && a.content === b.content)
      );
    const moved: MemoryEntry[] = [];
    let foundAny = false;
    for (const dir of readdirSync(this.rootPath)) {
      if (dir === 'meta.json' || dir === globalDir) continue;
      const file = join(this.rootPath, dir, 'memories.jsonl');
      if (!existsSync(file)) continue;
      const entries = this.loadFromFile(file);
      const tools = entries.filter(e => e.type === 'tool_preference' && e.projectPath !== GLOBAL_MEMORY_SCOPE);
      if (tools.length === 0) continue;
      foundAny = true;
      const kept = entries.filter(e => e.type !== 'tool_preference' || e.projectPath === GLOBAL_MEMORY_SCOPE);
      for (const t of tools) {
        // 跨项目 / 已有全局条目去重：同工具只保留一条（已有的优先，跳过迁移）。
        if (global.some(g => matches(g, t)) || moved.some(m => matches(m, t))) continue;
        t.projectPath = GLOBAL_MEMORY_SCOPE;
        moved.push(t);
      }
      writeFileSync(file, kept.length ? `${kept.map(e => JSON.stringify(e)).join('\n')}\n` : '', 'utf-8');
      // 缓存同步：该目录对应项目若在内存缓存中，原地移除已搬走的条目。
      const cached = this.cachedForDir(dir);
      if (cached) {
        for (let i = cached.length - 1; i >= 0; i--) {
          if (cached[i].type === 'tool_preference' && cached[i].projectPath !== GLOBAL_MEMORY_SCOPE) cached.splice(i, 1);
        }
      }
    }
    if (moved.length > 0) {
      global = [...global, ...moved];
      mkdirSync(this.projectDir(GLOBAL_MEMORY_SCOPE), { recursive: true });
      writeFileSync(this.fileFor(GLOBAL_MEMORY_SCOPE), `${global.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
      this.cache.set(GLOBAL_MEMORY_SCOPE, global);
    }
    if (foundAny) this.writeDecayInfo({ ...this.decayInfo, migratedToolPrefsAt: Date.now() });
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
    const cfg = this.evolution;
    const target = findSupersedeTarget(entries, entry, cfg);
    const id = newId();
    const seeded: MemoryEntry = { ...entry, id, timestamp: entry.timestamp ?? now };
    if (target) {
      target.supersededBy = id;
      target.lifecycle = 'degraded';
    }
    // 默认健康分按多维公式种子化；调用方显式给的 decayScore 优先（兼容
    // 语义注入），lifecycle 与存储分数保持一致。
    const score = entry.decayScore ?? healthScore(seeded, now, cfg);
    entries.push({ ...seeded, decayScore: score, lifecycle: entry.lifecycle ?? lifecycleOf(score, cfg) });
    this.persist(project, entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const project = opts?.projectPath ?? this.defaultProject;
    const hits = searchMemories(this.load(project), query, { ...opts, projectPath: project }, this.evolution);
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

  async removeById(id: string): Promise<boolean> {
    if (!existsSync(this.rootPath)) return false;
    let removed = false;
    for (const dir of readdirSync(this.rootPath)) {
      if (dir === 'meta.json') continue;
      const file = join(this.rootPath, dir, 'memories.jsonl');
      if (!existsSync(file)) continue;
      const entries = this.loadFromFile(file);
      const kept = entries.filter(e => e.id !== id);
      if (kept.length === entries.length) continue;
      // 被删除条目的取代者引用指向它时一并解除（与 LocalStorage 实现一致）。
      for (const e of kept) {
        if (e.supersededBy === id) {
          delete e.supersededBy;
          if (e.lifecycle === 'degraded') e.lifecycle = undefined;
        }
      }
      const body = kept.map(e => JSON.stringify(e)).join('\n');
      writeFileSync(file, body ? `${body}\n` : '', 'utf-8');
      this.cache.clear();
      removed = true;
    }
    return removed;
  }

  async decay(olderThan: number): Promise<void> {
    if (!existsSync(this.rootPath)) return;
    const now = Date.now();
    let changedAny = false;
    let deleted = 0;
    let updated = 0;
    for (const dir of readdirSync(this.rootPath)) {
      if (dir === 'meta.json') continue; // 元信息文件不是项目记忆目录
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
        const outcome = decayEntry(e, now, olderThan, this.evolution);
        if (outcome === 'deleted') { changed = true; deleted++; continue; }
        if (outcome === 'updated') { changed = true; updated++; }
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
    this.writeDecayInfo({ lastDecayAt: now, lastDeleted: deleted, lastUpdated: updated });
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
