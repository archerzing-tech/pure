// src/ui/memoryStore.ts
// Cross-session memory store singleton (IMemoryStore, localStorage-backed
// persistence wrapped in WASMEmbeddingStore for local vector search per
// Adapter Layer 设计文档 §12.7). The Harness searches it at session start —
// memories are injected into the system prompt via PromptComposer — and writes
// a successful_pattern when a session completes. The Memory skill toggle gates
// both learning and injection (no store passed to CodingAgent = no memory).
// Semantic search is lazy (transformers.js model loads on first search and
// falls back to keyword matching when unavailable), so plain-chat users pay
// no cost until memory is actually retrieved.
//
// Own module (not chat.ts) so the settings panel can import the same instance
// for its memory dashboard without dragging the whole chat pipeline (adapters,
// CodingAgent, WASM, …) into the lazily-loaded settings chunk.
import { LocalStorageMemoryStore } from '../adapter/memory/LocalStorageMemoryStore';
import { WASMEmbeddingStore } from '../adapter/memory/WASMEmbeddingStore';
import { loadConfig } from './config';

export const memoryStore = new WASMEmbeddingStore({
  store: new LocalStorageMemoryStore(() => loadConfig()?.evolution),
  // 同一份配置同时驱动 WASM 路径的 dormant 过滤（健康分阈值由用户可调）。
  getEvolution: () => loadConfig()?.evolution,
});
