// src/adapter/memory/WASMEmbeddingStore.ts
// v2.0 — semantic memory retrieval via transformers.js WASM (Adapter Layer
// 设计文档 §12.7). Composes an inner IMemoryStore for persistence — per the
// doc's "WASMEmbeddingStore 负责语义检索，FSStore 负责持久化" — and replaces
// keyword matching with local vector similarity behind the SAME interface
// (IMemoryStore is unchanged; the wrapper satisfies it).
//
// Design decisions:
// - The transformers.js pipeline is lazy: it is only imported + the model only
//   downloaded (~80MB, cached after first use) on the first search() that
//   needs embeddings. Zero cost until semantic search is actually used.
// - Any embedder failure (offline, model missing, WASM unavailable) falls back
//   to the keyword search from keywordSearch.ts, so memory never breaks.
// - Entry embeddings are cached by id+content so repeat searches don't
//   re-embed the whole corpus.
//
// NOTE: the official successor of the doc's `@xenova/transformers` is
// `@huggingface/transformers` (same API: pipeline('feature-extraction', …)).

import type { IMemoryStore, MemoryEntry, MemorySearchOptions } from './IMemoryStore';
import { searchMemories } from './keywordSearch';

export type EmbedFunction = (text: string) => Promise<number[]>;

export interface WASMEmbeddingStoreOptions {
  /**
   * Inner persistence store. `add`/`forget`/`decay` delegate to it; `list()`
   * (a concrete-store extension, not part of IMemoryStore) feeds the search
   * path with the entries to embed + rank.
   */
  store: IMemoryStore & { list(projectPath?: string): MemoryEntry[] };
  /** Feature-extraction model id (default: all-MiniLM-L6-v2). */
  model?: string;
  /** Cosine-similarity threshold; entries below it are excluded (default 0.2). */
  minScore?: number;
  /** Inject an embedder (tests / custom backends). Defaults to transformers.js. */
  embed?: EmbedFunction;
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

export class WASMEmbeddingStore implements IMemoryStore {
  private store: WASMEmbeddingStoreOptions['store'];
  private model: string;
  private minScore: number;
  private customEmbed?: EmbedFunction;
  private embedderPromise?: Promise<EmbedFunction>;
  private vecCache = new Map<string, { content: string; vec: number[] }>();

  constructor(opts: WASMEmbeddingStoreOptions) {
    this.store = opts.store;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.minScore = opts.minScore ?? 0.2;
    this.customEmbed = opts.embed;
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

    // Embedder unavailable → keyword fallback keeps memory working offline.
    const embed = await this.getEmbedder().catch(() => undefined);
    if (!embed) return searchMemories(all, query, opts);

    const queryVec = await embed(query).catch(() => undefined);
    if (!queryVec) return searchMemories(all, query, opts);

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of all) {
      if (type !== undefined && entry.type !== type) continue;
      const vec = await this.vecFor(entry, embed).catch(() => undefined);
      if (!vec) continue;
      const sim = cosineSimilarity(queryVec, vec);
      // minScore gates the RELEVANCE (cosine) only; decayScore then sinks
      // stale memories in the ranking but never drops them — mirroring the
      // keyword fallback's semantics (filter by match, rank by decay).
      if (sim >= this.minScore) scored.push({ entry, score: sim * (entry.decayScore ?? 1) });
    }

    scored.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);
    return scored.slice(0, k).map(s => s.entry);
  }

  async forget(sessionId: string): Promise<void> {
    this.vecCache.clear();
    return this.store.forget(sessionId);
  }

  async decay(olderThan: number): Promise<void> {
    return this.store.decay(olderThan);
  }

  /** Cached per-entry embedding, keyed by id + content. */
  private async vecFor(entry: MemoryEntry, embed: EmbedFunction): Promise<number[]> {
    const cached = this.vecCache.get(entry.id);
    if (cached && cached.content === entry.content) return cached.vec;
    const vec = await embed(entry.content);
    this.vecCache.set(entry.id, { content: entry.content, vec });
    return vec;
  }

  /**
   * Lazy transformers.js pipeline. First call imports the package and loads
   * the model; subsequent calls reuse the promise. Any failure (network,
   * missing cache, unsupported runtime) rejects — search() catches and
   * falls back to keyword matching.
   */
  private getEmbedder(): Promise<EmbedFunction> {
    if (this.customEmbed) return Promise.resolve(this.customEmbed);
    if (!this.embedderPromise) {
      this.embedderPromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline('feature-extraction', this.model);
        return async (text: string): Promise<number[]> => {
          const out = await extractor(text, { pooling: 'mean', normalize: true });
          return Array.from(out.data as Float32Array);
        };
      })();
    }
    return this.embedderPromise;
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
