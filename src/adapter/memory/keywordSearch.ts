// src/adapter/memory/keywordSearch.ts
// v0.10 — Phase-1 memory retrieval: full-text keyword matching (Adapter Layer
// 设计文档 §12.5). Shared by FSMemoryStore and LocalStorageMemoryStore so both
// backends rank memories identically. v2.0 will swap this for vector similarity
// (WASMEmbeddingStore) behind the same IMemoryStore interface.

import type { MemoryEntry, MemorySearchOptions } from './IMemoryStore';
import { EVOLUTION, healthScore } from './evolution';

/**
 * Split a query into lowercase keyword tokens. Handles CJK text by emitting
 * each Han character as its own token (no spaces to split on).
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (m.length >= 2) out.add(m);
  }
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) out.add(ch);
  }
  return [...out];
}

/** Number of query tokens present in the entry content (0 = no match). */
function matchScore(content: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = content.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) score += 1;
  }
  return score;
}

/**
 * Rank entries by keyword overlap, then timestamp desc (newest first), and
 * return the top k. decayScore factors into the rank so decayed memories sink.
 * Dormant memories (健康分 ≤ DORMANT_MAX) are excluded from retrieval entirely
 * — the lifecycle's dormant stage means "asleep, not gone": they stop being
 * injected while decay still holds a grace window to delete them outright.
 */
export function searchMemories(
  entries: MemoryEntry[],
  query: string,
  opts?: MemorySearchOptions,
): MemoryEntry[] {
  const tokens = tokenize(query);
  const projectPath = opts?.projectPath;
  const type = opts?.type;
  const k = opts?.k ?? 5;
  const now = Date.now();

  return entries
    .filter(e => (projectPath === undefined || e.projectPath === projectPath))
    .filter(e => (type === undefined || e.type === type))
    .filter(e => healthScore(e, now) >= EVOLUTION.DORMANT_MAX)
    .map(e => ({ entry: e, score: matchScore(e.content, tokens) * (e.decayScore ?? 1) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    .slice(0, k)
    .map(x => x.entry);
}
