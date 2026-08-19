// src/adapter/memory/WASMEmbeddingStore.ts
// v2.1 — semantic memory retrieval via transformers.js WASM (Adapter Layer
// 设计文档 §12.7). Composes an inner IMemoryStore for persistence — per the
// doc's "WASMEmbeddingStore 负责语义检索，FSStore 负责持久化" — and replaces
// keyword matching with local vector similarity behind the SAME interface
// (IMemoryStore is unchanged; the wrapper satisfies it).
//
// Design decisions:
// - The transformers.js pipeline is lazy: it is only imported + the model only
//   downloaded (~80MB, cached after first use) on the first search() that
//   actually has entries to embed — and an EMPTY corpus never touches the
//   model at all, so a fresh install with no memories triggers zero download.
// - v2.1: uncached entries are embedded in ONE batched WASM inference call
//   (transformers.js accepts string[]) instead of N sequential model
//   invocations — the difference between ~50ms and ~2s on a full corpus.
//   The remaining work (cosine scoring) is a plain JS loop.
// - Any embedder failure (offline, model missing, WASM unavailable) falls back
//   to the keyword search from keywordSearch.ts, so memory never breaks.
// - Entry embeddings are cached by id+content so repeat searches don't
//   re-embed the whole corpus. The cache is bounded: it is pruned to the
//   current corpus on each search (so decayed/deleted entries release their
//   vectors + duplicated content instead of lingering) and capped by size.
//
// NOTE: the official successor of the doc's `@xenova/transformers` is
// `@huggingface/transformers` (same API: pipeline('feature-extraction', …)).

import type { IMemoryStore, MemoryEntry, MemoryListOptions, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';
import { EVOLUTION, healthScore, type EvolutionConfig } from './evolution';
import type { MemoryDecayInfo } from './LocalStorageMemoryStore';

export type EmbedFunction = (text: string) => Promise<number[]>;
export type EmbedBatchFunction = (texts: string[]) => Promise<number[][]>;

export interface WASMEmbeddingStoreOptions {
  /**
   * Inner persistence store. `add`/`forget`/`decay` delegate to it; `list()`
   * (a concrete-store extension, not part of IMemoryStore) feeds the search
   * path with the entries to embed + rank. `getLastDecayInfo()` is the same
   * kind of concrete-store extension (settings-panel diagnostics).
   */
  store: IMemoryStore & {
    list(projectPath?: string | MemoryListOptions): MemoryEntry[];
    getLastDecayInfo?(): MemoryDecayInfo;
    importEntries?(entries: MemoryEntry[]): Promise<{ imported: number; skipped: number }>;
  };
  /** Feature-extraction model id (default: all-MiniLM-L6-v2). */
  model?: string;
  /** Cosine-similarity threshold; entries below it are excluded (default 0.2). */
  minScore?: number;
  /** 进化阈值读取器（Settings → Memory → 遗忘速度）。与内层 store 同源，
   *  保证 WASM 路径的 dormant 过滤与持久化层的衰减使用同一份配置。 */
  getEvolution?: () => Partial<EvolutionConfig> | undefined;
  /** Inject a single-text embedder (tests / custom backends). Defaults to
   * transformers.js. When only `embed` is provided, the batched path falls
   * back to sequential per-text calls (keeps the old API working). */
  embed?: EmbedFunction;
  /** Inject a batched embedder (preferred): ONE WASM inference call for the
   * whole batch instead of N sequential ones. Defaults to transformers.js. */
  embedBatch?: EmbedBatchFunction;
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Cooldown between embedder load attempts after a failure. The model is an
 * ~80MB download, so a persistent outage (offline, missing cache) must not
 * re-attempt it on every search; a transient network blip resolves within
 * this window and semantic search comes back on the next retry.
 */
const EMBEDDER_RETRY_COOLDOWN_MS = 60_000;

interface Embedder {
  embed: EmbedFunction;
  embedBatch: EmbedBatchFunction;
}

export class WASMEmbeddingStore implements IMemoryStore {
  // Bounds the embedding cache: entries are pruned to the current corpus and
  // capped by size (insertion order evicts oldest), so the duplicated content
  // text cached alongside each vector can't accumulate without limit.
  static readonly MAX_VEC_CACHE_ENTRIES = 1000;

  private store: WASMEmbeddingStoreOptions['store'];
  private model: string;
  private minScore: number;
  private customEmbed?: EmbedFunction;
  private customEmbedBatch?: EmbedBatchFunction;
  private getEvolution?: () => Partial<EvolutionConfig> | undefined;
  private embedderPromise?: Promise<Embedder>;
  /** When the last embedder load attempt started (retry-cooldown clock). */
  private lastEmbedderAttempt = 0;
  private vecCache = new Map<string, { content: string; vec: number[] }>();

  constructor(opts: WASMEmbeddingStoreOptions) {
    this.store = opts.store;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.minScore = opts.minScore ?? 0.2;
    this.customEmbed = opts.embed;
    this.customEmbedBatch = opts.embedBatch;
    this.getEvolution = opts.getEvolution;
  }

  async add(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    // Delegate persistence; the cache is keyed by id+content so a fresh
    // entry (new id) can never hit a stale vector, and dedupe-returned ids
    // have identical content anyway.
    return this.store.add(entry);
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const projectPath = opts?.projectPath;
    const type = opts?.type;
    const k = opts?.k ?? 5;
    const all = this.store.list(projectPath);

    // No corpus → nothing to rank. Return before touching the embedder so the
    // first ~80MB model download only ever happens when there are real
    // memories to search (fresh installs stay zero-cost).
    if (all.length === 0) return [];

    // 进化阈值（用户自定义遗忘速度）—— search 全程（含 fallback）共用一份，
    // 避免对 getEvolution 的重复调用。
    const cfg = this.getEvolution?.();
    const dormantMax = cfg?.dormantMax ?? EVOLUTION.DORMANT_MAX;

    // Drop cache entries no longer in the current corpus before scanning:
    // decay()/forget() remove from the store, but the cache would otherwise
    // keep stale vectors + their cached content text alive indefinitely.
    // Entries from other projects fall out too (they re-embed on the next
    // visit) — a bounded tradeoff that keeps the cache in sync with the
    // corpus actually being searched.
    if (this.vecCache.size > all.length) {
      const liveIds = new Set(all.map(e => e.id));
      for (const id of [...this.vecCache.keys()]) {
        if (!liveIds.has(id)) this.vecCache.delete(id);
      }
    }

    // Embedder unavailable → keyword fallback keeps memory working offline.
    const embedder = await this.getEmbedder().catch(() => undefined);
    if (!embedder) return this.fallbackSearch(all, query, opts, cfg);

    const queryVec = await embedder.embed(query).catch(() => undefined);
    if (!queryVec) return this.fallbackSearch(all, query, opts, cfg);

    // Embed every uncached (matching-type) entry in ONE batched WASM call —
    // transformers.js runs the whole batch through the model at once. The
    // loop below then only does cosine scoring in JS. Dormant memories are
    // skipped before embedding (they are excluded from retrieval anyway and
    // would only waste the WASM inference cost).
    const nowForEmbed = Date.now();
    const uncached: MemoryEntry[] = [];
    for (const entry of all) {
      if (type !== undefined && entry.type !== type) continue;
      if (healthScore(entry, nowForEmbed, cfg) < dormantMax) continue;
      const cached = this.vecCache.get(entry.id);
      if (cached && cached.content === entry.content) continue;
      uncached.push(entry);
    }
    if (uncached.length > 0) {
      const vecs = await embedder.embedBatch(uncached.map(e => e.content)).catch(() => undefined);
      if (vecs && vecs.length === uncached.length) {
        uncached.forEach((e, i) => this.vecCache.set(e.id, { content: e.content, vec: vecs[i] }));
        // Bound cache size: Map preserves insertion order, so evict the
        // oldest entries once the cap is exceeded.
        while (this.vecCache.size > WASMEmbeddingStore.MAX_VEC_CACHE_ENTRIES) {
          const oldest = this.vecCache.keys().next().value;
          if (oldest === undefined) break;
          this.vecCache.delete(oldest);
        }
      } else {
        // The batch embedder failed for the whole set (e.g. one pathological
        // entry). Fall back to keyword search instead of silently returning
        // no results — same recovery path as an unavailable embedder.
        return this.fallbackSearch(all, query, opts, cfg);
      }
    }

    const now = Date.now();
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of all) {
      if (type !== undefined && entry.type !== type) continue;
      // 休眠记忆不进检索（健康分 ≤ dormantMax）—— 也不付 embedding 的 WASM
      // 成本。与 keyword 路径的 dormant 过滤保持一致。
      if (healthScore(entry, now, cfg) < dormantMax) continue;
      // Entries whose embedding failed stay out of the cache → skipped,
      // mirroring the old per-entry `.catch(() => undefined)` semantics.
      const cached = this.vecCache.get(entry.id);
      if (!cached) continue;
      const sim = cosineSimilarity(queryVec, cached.vec);
      // minScore gates the RELEVANCE (cosine) only; the live health score then
      // sinks stale memories in the ranking but never drops them — mirroring
      // the keyword fallback's semantics (filter by match, rank by health).
      if (sim >= this.minScore) scored.push({ entry, score: sim * healthScore(entry, now, cfg) });
    }

    scored.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);
    const results = scored.slice(0, k).map(s => s.entry);
    // 使用频率信号：命中即 +1（委托内层 store —— FS 进内存缓存、decay 落盘；
    // localStorage 直接写回）。
    await this.recordHits(results);
    return results;
  }

  /** Keyword fallback（embedder 不可用/失败）—— 与语义路径一致地记录命中。
   *   cfg 由 search() 解析一次传入，避免对 getEvolution 的重复调用。 */
  private async fallbackSearch(
    all: MemoryEntry[],
    query: string,
    opts?: MemorySearchOptions,
    cfg?: Partial<EvolutionConfig>,
  ): Promise<MemoryEntry[]> {
    const results = searchMemories(all, query, opts, cfg);
    await this.recordHits(results);
    return results;
  }

  async forget(sessionId: string): Promise<void> {
    this.vecCache.clear();
    return this.store.forget(sessionId);
  }

  async removeById(id: string): Promise<boolean> {
    // 与 forget 一致：删除后该条目的向量/内容缓存必须失效，否则下一次
    // search 的 corpus 修剪（vecCache.size > all.length）可能残留陈旧条目。
    this.vecCache.delete(id);
    return this.store.removeById(id);
  }

  async decay(olderThan: number): Promise<void> {
    return this.store.decay(olderThan);
  }

  async recordHits(entries: MemoryEntry[]): Promise<void> {
    await this.store.recordHits(entries);
  }

  /** 枚举全部记忆（设置面板记忆库可视化、机器级常驻注入用）。委托内层
   *  持久化 store，与 FSMemoryStore/LocalStorageMemoryStore 的 list()
   *  过滤语义保持一致。 */
  list(opts?: string | MemoryListOptions): MemoryEntry[] {
    return this.store.list(opts);
  }

  /** 上次衰减运行信息（设置面板诊断区）。委托内层持久化 store。 */
  getLastDecayInfo(): MemoryDecayInfo {
    return this.store.getLastDecayInfo?.() ?? {};
  }

  /** 批量导入（设置面板记忆页导出/导入，迁移到新机器）。委托内层 store。 */
  importEntries(entries: MemoryEntry[]): Promise<{ imported: number; skipped: number }> {
    if (!this.store.importEntries) return Promise.resolve({ imported: 0, skipped: entries.length });
    return this.store.importEntries(entries);
  }

  /**
   * Lazy transformers.js pipeline. First call imports the package and loads
   * the model; subsequent calls reuse the promise. A FAILED load clears the
   * cached promise (see loadEmbedder) so the next search retries instead of
   * permanently degrading to keyword matching; the retry cooldown paces how
   * often a persistent failure re-attempts the ~80MB download.
   */
  private getEmbedder(): Promise<Embedder> {
    if (this.customEmbed || this.customEmbedBatch) {
      const single = this.customEmbed;
      const batch = this.customEmbedBatch ?? (async (texts: string[]): Promise<number[][]> => {
        const out: number[][] = [];
        for (const t of texts) out.push(await single!(t));
        return out;
      });
      return Promise.resolve({
        embed: single ?? (async (text: string) => (await batch([text]))[0]),
        embedBatch: batch,
      });
    }
    if (!this.embedderPromise) {
      const now = Date.now();
      if (now - this.lastEmbedderAttempt < EMBEDDER_RETRY_COOLDOWN_MS) {
        // The previous load failed less than the cooldown ago — pace retries
        // instead of hammering the network on every search. search() catches
        // this rejection and uses the keyword fallback for now.
        return Promise.reject(new Error('embedder load failed recently; retry pending'));
      }
      this.lastEmbedderAttempt = now;
      this.embedderPromise = this.loadEmbedder();
    }
    return this.embedderPromise;
  }

  /**
   * Import transformers.js + load the model pipeline. On ANY failure the
   * cached embedderPromise is cleared so the next getEmbedder() call retries
   * the load (a transient network blip no longer bricks semantic search for
   * the rest of the session) — the caller still receives the rejection now.
   */
  private async loadEmbedder(): Promise<Embedder> {
    try {
      const transformers = await import('@huggingface/transformers');
      // The browser build otherwise defaults to the asyncify runtime (~23MB).
      // Configure the standard SIMD runtime (~13MB) before creating a session;
      // Vite emits both files as cacheable, lazy assets.
      if (typeof window !== 'undefined') {
        const { configureTransformersWasm } = await import('./wasmRuntime');
        configureTransformersWasm(transformers.env);
      }
      const extractor = await transformers.pipeline('feature-extraction', this.model);
      return {
        embed: async (text: string): Promise<number[]> => {
          const out = await extractor(text, { pooling: 'mean', normalize: true });
          return Array.from(out.data as Float32Array);
        },
        embedBatch: async (texts: string[]): Promise<number[][]> => {
          // Batched inference: ONE WASM call for the whole array instead of
          // N sequential extractor() invocations — the ~10-50× speedup that
          // makes full-corpus recall feel instant. The model returns a
          // [batch, dim] tensor; slice it back into per-text vectors.
          if (texts.length === 1) {
            const out = await extractor(texts[0], { pooling: 'mean', normalize: true });
            return [Array.from(out.data as Float32Array)];
          }
          const out = await extractor(texts, { pooling: 'mean', normalize: true });
          const data = out.data as Float32Array;
          const dims = out.dims as number[] | undefined;
          const dim = dims?.[1] ?? (data.length > 0 ? data.length / texts.length : 0);
          const result: number[][] = [];
          for (let i = 0; i < texts.length; i++) {
            result.push(Array.from(data.slice(i * dim, (i + 1) * dim)));
          }
          return result;
        },
      };
    } catch (err) {
      // Transient failure (network / missing cache / unsupported runtime):
      // drop the cached rejection so the next search retries the model load
      // instead of staying on keyword matching until the app restarts. The
      // retry cooldown in getEmbedder paces how often that retry can happen.
      this.embedderPromise = undefined;
      throw err;
    }
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
