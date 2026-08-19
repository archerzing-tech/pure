// src/adapter/memory/LocalStorageMemoryStore.ts
// v0.10 — localStorage-backed IMemoryStore for the GUI (WebView / browser dev
// server). Mirrors FSMemoryStore's semantics (per-project isolation, keyword
// search, decay) with the browser's only sync persistence: localStorage.

import type { IMemoryStore, MemoryEntry, MemoryListOptions, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';
import { EVOLUTION, decayEntry, findSupersedeTarget, healthScore, lifecycleOf, type EvolutionConfig } from './evolution';
import { GLOBAL_MEMORY_SCOPE } from '../../shared/types';

const STORAGE_KEY = 'pure_memories_v2';
// 衰减运行元信息（设置面板记忆页诊断区用）：上次衰减时间 + 上次删除/更新条数。
// 独立 key，避免污染记忆数据本体（旧版本代码读不到也无碍）。
const META_KEY = 'pure_memories_meta_v1';

export interface MemoryDecayInfo {
  /** 上次 decay() 实际执行的时刻（毫秒时间戳）。 */
  lastDecayAt?: number;
  /** 上次衰减删除的条目数。 */
  lastDeleted?: number;
  /** 上次衰减更新（重算健康分/生命周期）的条目数。 */
  lastUpdated?: number;
  /** 旧版本项目作用域 tool_preference 一次性迁移完成的时刻（见 migrateLegacyToolPreferences）。 */
  migratedToolPrefsAt?: number;
}

function readMeta(): MemoryDecayInfo {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MemoryDecayInfo;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMeta(info: MemoryDecayInfo): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(info));
  } catch { /* quota / private mode — non-fatal */ }
}

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
  /**
   * 进化阈值读取器（Settings → Memory → 遗忘速度）。每次操作时调用，保证
   * 用户在设置面板的改动即时生效（无需重启 / 重建 store）。adapter 层不直接
   * 依赖 GUI 的 config 模块 —— 由构造方注入取数函数，保持解耦。
   */
  private getConfig: () => Partial<EvolutionConfig> | undefined;
  // 内存缓存（与 FSMemoryStore 的 cache 同理）：仪表盘每次打开/切页都调
  // list()，长会话每轮都调 search()——没有缓存会全量 JSON.parse 整个数组。
  // 写操作（add/forget/decay/recordHits）后更新；GUI 是单例，无需跨实例同步。
  private cache: MemoryEntry[] | null = null;

  constructor(getConfig?: () => Partial<EvolutionConfig> | undefined) {
    this.getConfig = getConfig ?? (() => undefined);
    // 一次性迁移：旧版本（v1.9.11 之前）按项目隔离写入的 tool_preference
    // 搬进机器级全局作用域，避免与常驻注入重复。幂等 + meta 标记只跑一次。
    this.migrateLegacyToolPreferences();
  }

  /**
   * 一次性迁移：旧版本把 tool_preference 按项目隔离写入；现在它们属于机器级
   * 全局作用域（跨项目常驻注入）。把项目作用域的 tool_preference 搬进全局
   * 并去重（dedupeKey 优先，其次 type+content+platform），保留原 id / 使用
   * 频率 / 取代链。meta 记 migratedToolPrefsAt 标记，之后不再扫描；无旧条目
   * 时也不写标记（空库读取几乎零成本）。
   */
  private migrateLegacyToolPreferences(): void {
    const meta = readMeta();
    if (meta.migratedToolPrefsAt) return;
    const all = this.read();
    const tools = all.filter(e => e.type === 'tool_preference' && e.projectPath !== GLOBAL_MEMORY_SCOPE);
    if (tools.length === 0) return;
    const matches = (a: MemoryEntry, b: MemoryEntry): boolean =>
      a.type === b.type && a.platform === b.platform && (
        (!!a.dedupeKey && a.dedupeKey === b.dedupeKey) ||
        (!a.dedupeKey && !b.dedupeKey && a.content === b.content)
      );
    const global = all.filter(e => e.projectPath === GLOBAL_MEMORY_SCOPE);
    const moved: MemoryEntry[] = [];
    for (const t of tools) {
      // 跨项目 / 已有全局条目去重：同工具只保留一条（已有的优先，跳过迁移）。
      if (global.some(g => matches(g, t)) || moved.some(m => matches(m, t))) continue;
      moved.push({ ...t, projectPath: GLOBAL_MEMORY_SCOPE });
    }
    if (moved.length > 0) {
      const kept = all.filter(e => e.type !== 'tool_preference' || e.projectPath === GLOBAL_MEMORY_SCOPE);
      this.write([...kept, ...moved]);
    }
    writeMeta({ ...meta, migratedToolPrefsAt: Date.now() });
  }

  /** 读全部条目（命中内存缓存则不 parse）；返回的是缓存数组引用，调用方
   *   mutate 即更新缓存，写操作后经 write() 落盘。 */
  private read(): MemoryEntry[] {
    if (this.cache) return this.cache;
    this.cache = readAll();
    return this.cache;
  }

  private write(entries: MemoryEntry[]): void {
    writeAll(entries);
    this.cache = entries;
  }

  /** Enumerate entries, optionally scoped to a project (used by
   *  WASMEmbeddingStore's search and the Harness's machine-global
   *  always-inject). Accepts a project path string (legacy) or filter
   *  options; activeOnly drops dormant entries (健康分 ≤ dormantMax).
   *  不记录命中（list 是枚举，不是检索）。 */
  list(opts?: string | MemoryListOptions): MemoryEntry[] {
    const project = typeof opts === 'string' ? opts : opts?.projectPath;
    let all = project === undefined ? this.read() : this.read().filter(e => e.projectPath === project);
    if (opts && typeof opts !== 'string') {
      const now = Date.now();
      const cfg = this.getConfig();
      const dormantMax = cfg?.dormantMax ?? EVOLUTION.DORMANT_MAX;
      if (opts.type !== undefined) all = all.filter(e => e.type === opts.type);
      if (opts.platform !== undefined) all = all.filter(e => e.platform === opts.platform);
      if (opts.activeOnly) all = all.filter(e => healthScore(e, now, cfg) >= dormantMax);
    }
    return all;
  }

  /** 上次衰减运行信息（设置面板记忆页诊断区）。非 IMemoryStore 接口成员。 */
  getLastDecayInfo(): MemoryDecayInfo {
    return readMeta();
  }

  /** 批量导入（Settings → Memory → 导出/导入，迁移到新机器）。
   *   非 IMemoryStore 接口成员（与 list() 同为具体 store 扩展）。
   *   语义：
   *   - 保留原字段（id/supersededBy/hitCount/lastUsedAt/decayScore/lifecycle
   *     /timestamp/sessionId/projectPath）——取代链与使用频率信号迁移后仍成立。
   *   - 去重：id 已存在，或 (type, projectPath, content|dedupeKey) 与现有条目
   *     相同 → 跳过（与 add() 的去重口径一致）。
   *   返回 { imported, skipped }。 */
  async importEntries(entries: MemoryEntry[]): Promise<{ imported: number; skipped: number }> {
    if (entries.length === 0) return { imported: 0, skipped: 0 };
    // 拷贝而非别名：read() 返回的是缓存数组引用，直接 push 会原地修改缓存
    // （配额失败回滚时 prev 也指向同一数组，等于没回滚）。
    const all = this.read().slice();
    let imported = 0;
    let skipped = 0;
    for (const e of entries) {
      const dup = all.find(x =>
        x.id === e.id ||
        (x.type === e.type && x.projectPath === e.projectPath && (
          x.content === e.content ||
          (!!e.dedupeKey && x.dedupeKey === e.dedupeKey)
        ))
      );
      if (dup) { skipped++; continue; }
      all.push(e);
      imported++;
    }
    if (imported === 0) return { imported: 0, skipped };
    // 写失败必须可见（writeAll 会静默吞掉 localStorage 配额错误 —— 导入一个
    // 大记忆库到配额不足的环境，若静默则 toast 显示成功但实际什么都没落盘）。
    // 这里绕过 write() 的静默捕获，直接 setItem 让配额异常抛出；失败时恢复
    // 内存缓存并转成可识别的错误。
    const prev = this.cache;
    this.cache = all;
    try {
      // 裸 setItem：writeAll 内部会吞掉配额异常，这里必须让异常冒泡。
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      this.cache = prev;
      throw new Error('storage-full');
    }
    return { imported, skipped };
  }

  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    const entries = this.read();
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
    const cfg = this.getConfig();
    const target = findSupersedeTarget(entries, entry, cfg);
    const id = newId();
    const seeded: MemoryEntry = { ...entry, id, timestamp: entry.timestamp ?? now };
    if (target) {
      target.supersededBy = id;
      target.lifecycle = 'degraded';
    }
    // 默认健康分按多维公式种子化；调用方显式给的 decayScore 优先。
    const score = entry.decayScore ?? healthScore(seeded, now, cfg);
    entries.push({ ...seeded, decayScore: score, lifecycle: entry.lifecycle ?? lifecycleOf(score, cfg) });
    this.write(entries);
    return id;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const hits = searchMemories(this.read(), query, opts, this.getConfig());
    // 使用频率信号：命中即 +1 并刷新 lastUsedAt。localStorage 的条目每次都是
    // 重新 parse 的对象，必须写回才能持久。
    await this.recordHits(hits);
    return hits;
  }

  async recordHits(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const all = this.read();
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
    if (changed) this.write(all);
  }

  async forget(sessionId: string): Promise<void> {
    const entries = this.read().filter(e => e.sessionId !== sessionId);
    this.write(entries);
  }

  async removeById(id: string): Promise<boolean> {
    const all = this.read();
    const idx = all.findIndex(e => e.id === id);
    if (idx === -1) return false;
    // 被删除条目的取代者引用（supersededBy）指向它时，一并解除——否则面板
    // 上被取代徽章的悬浮提示会解析到不存在的 id。
    let changed = true;
    for (const e of all) {
      if (e.supersededBy === id) {
        delete e.supersededBy;
        if (e.lifecycle === 'degraded') e.lifecycle = undefined;
      }
    }
    all.splice(idx, 1);
    // 与 importEntries 一致：裸 setItem，让配额异常冒泡（删除失败必须可见）。
    const prev = this.cache;
    this.cache = all;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      this.cache = prev;
      throw err;
    }
    return changed;
  }

  async decay(olderThan: number): Promise<void> {
    const now = Date.now();
    const entries = this.read();
    const kept: MemoryEntry[] = [];
    let changed = false;
    let deleted = 0;
    let updated = 0;
    const cfg = this.getConfig();
    for (const e of entries) {
      const outcome = decayEntry(e, now, olderThan, cfg);
      if (outcome === 'deleted') { changed = true; deleted++; continue; }
      if (outcome === 'updated') { changed = true; updated++; }
      kept.push(e);
    }
    if (changed) this.write(kept);
    // 记录运行信息（无论是否有变化——decay 本身执行了，供诊断区显示
    // 上次运行时间与处理结果）。
    writeMeta({ lastDecayAt: now, lastDeleted: deleted, lastUpdated: updated });
  }
}
