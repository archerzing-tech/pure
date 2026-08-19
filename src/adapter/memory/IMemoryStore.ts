// [SPEC] MemoryEntry、IMemoryStore — 必须精确实现
// src/adapter/memory/IMemoryStore.ts
// Canonical definitions live in src/shared/types.ts (single source of truth,
// per 三层依赖关系总结.md); this module is the design-doc-specified home for
// the Memory Adapter's interface so adapter consumers import from one place.

export type { MemoryEntry, MemoryListOptions, MemorySearchOptions, MemoryType, IMemoryStore } from '../../shared/types';
