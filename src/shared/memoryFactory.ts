// src/shared/memoryFactory.ts
// Both entrypoints wrap their backing memory store in WASMEmbeddingStore for
// local vector search: the CLI wraps an FSMemoryStore (disk, ~/.pure/memories),
// the GUI wraps a LocalStorageMemoryStore (browser). The wrapper must receive
// the SAME evolution config as the inner store, or the semantic-search dormant
// threshold silently diverges from the persisted decay one. This factory is
// that shared wrapper — one place to build it, no per-entrypoint drift.
import { WASMEmbeddingStore } from '../adapter/memory/WASMEmbeddingStore';
import type { EvolutionConfig } from '../adapter/memory/evolution';

type EmbeddingStoreOptions = ConstructorParameters<typeof WASMEmbeddingStore>[0];

export interface CreateEmbeddingMemoryStoreOptions {
  /** Concrete backing store (FS in the CLI, localStorage in the GUI). */
  store: EmbeddingStoreOptions['store'];
  /** Evolution config reader — MUST be the same source the inner store uses. */
  getEvolution?: () => Partial<EvolutionConfig> | undefined;
}

export function createEmbeddingMemoryStore(options: CreateEmbeddingMemoryStoreOptions): WASMEmbeddingStore {
  return new WASMEmbeddingStore({
    store: options.store,
    // Same config drives both the WASM search path and the inner store's
    // decay; a mismatch would make the two dormant filters disagree.
    getEvolution: options.getEvolution,
  });
}
