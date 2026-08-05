// src/adapter/memory/__tests__/WASMEmbeddingStore.test.ts

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { WASMEmbeddingStore, cosineSimilarity } from '../WASMEmbeddingStore';
import { FSMemoryStore } from '../FSMemoryStore';
import type { MemoryEntry } from '../IMemoryStore';

// Deterministic, collision-free fake embedder: each distinct word gets its OWN
// dimension (unknown words share one bucket), so overlapping words ALWAYS
// produce overlap, and non-overlapping words NEVER collide. This makes the
// ranking assertions structural instead of hash-luck.
function makeFakeEmbed(): { embed: (t: string) => Promise<number[]>; calls: () => number } {
  const vocab = new Map<string, number>();
  const other = 63; // shared bucket for unknown words
  let nextDim = 0;
  let calls = 0;
  return {
    embed: (text: string): Promise<number[]> => {
      calls++;
      const vec = new Array(64).fill(0);
      for (const m of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let dim = vocab.get(m);
        if (dim === undefined) {
          dim = nextDim++;
          vocab.set(m, dim);
        }
        vec[dim] += 1;
      }
      if (vec.every(v => v === 0)) vec[other] = 1;
      return Promise.resolve(vec);
    },
    calls: () => calls,
  };
}

function makeStore() {
  const dir = mkdtempSync('/tmp/pure-wasm-embed-');
  const inner = new FSMemoryStore(dir, '/proj');
  const { embed, calls } = makeFakeEmbed();
  const store = new WASMEmbeddingStore({ store: inner, minScore: 0.1, embed });
  return { store, inner, dir, calls };
}

function entry(over: Partial<MemoryEntry>): Omit<MemoryEntry, 'id'> {
  return {
    type: 'user_preference',
    content: '',
    timestamp: Date.now(),
    sessionId: 's1',
    projectPath: '/proj',
    ...over,
  };
}

describe('WASMEmbeddingStore', () => {
  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    });
    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    });
    it('scales with magnitude of the overlap', () => {
      expect(cosineSimilarity([2, 0, 0], [1, 0, 0])).toBeCloseTo(1);
      const a = cosineSimilarity([1, 1, 0], [1, 0, 0]);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(1);
    });
    it('handles zero vectors', () => {
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });
  });

  describe('search', () => {
    it('ranks entries by semantic similarity (top-k)', async () => {
      const { store } = makeStore();
      await store.add(entry({ content: 'user prefers the TypeScript language' }));
      await store.add(entry({ content: 'user likes coffee in the morning' }));
      await store.add(entry({ content: 'project uses typescript and vite' }));

      const results = await store.search('typescript developer', { k: 2 });
      expect(results).toHaveLength(2);
      // Both typescript entries outrank the coffee one.
      const typescriptHits = results.filter(r => r.content.includes('typescript') || r.content.includes('TypeScript'));
      expect(typescriptHits).toHaveLength(2);
    });

    it('applies projectPath filter', async () => {
      const { store } = makeStore();
      await store.add(entry({ content: 'prefers pnpm', projectPath: '/proj' }));
      await store.add(entry({ content: 'prefers npm', projectPath: '/other' }));

      const results = await store.search('prefers pnpm', { projectPath: '/proj' });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('pnpm');
    });

    it('applies type filter', async () => {
      const { store } = makeStore();
      await store.add(entry({ content: 'user prefers rust', type: 'user_preference' }));
      await store.add(entry({ content: 'error E0308 resolved by adding lifetime', type: 'error_pattern' }));

      const errors = await store.search('error E0308', { type: 'error_pattern' });
      expect(errors).toHaveLength(1);
      expect(errors[0].content).toContain('E0308');
    });

    it('returns [] for a query with no similarity above minScore', async () => {
      // Explicit vector control (not hash collisions): every entry embeds to
      // dim0, the query to dim1 → cosine is exactly 0 → below minScore.
      const dir = mkdtempSync('/tmp/pure-wasm-embed-nomatch-');
      const inner = new FSMemoryStore(dir, '/proj');
      const store = new WASMEmbeddingStore({
        store: inner,
        minScore: 0.5,
        embed: async (text: string) => (text === 'quantum electrodynamics' ? [0, 1, 0] : [1, 0, 0]),
      });
      await store.add(entry({ content: 'user prefers dark mode' }));
      const results = await store.search('quantum electrodynamics', { k: 5 });
      expect(results).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    });

    it('decayScore sinks a memory in ranking', async () => {
      const { store } = makeStore();
      await store.add(entry({ content: 'prefers pnpm over npm', decayScore: 1 }));
      await store.add(entry({ content: 'prefers pnpm because faster', decayScore: 0.2 }));
      const results = await store.search('prefers pnpm');
      expect(results[0].decayScore ?? 1).toBeGreaterThan(results[1].decayScore ?? 0);
    });

    it('falls back to keyword search when the embedder fails', async () => {
      const dir = mkdtempSync('/tmp/pure-wasm-embed-fail-');
      const inner = new FSMemoryStore(dir, '/proj');
      const failingEmbed = async () => { throw new Error('no wasm'); };
      const store = new WASMEmbeddingStore({ store: inner, embed: failingEmbed });
      await store.add(entry({ content: 'user prefers the TypeScript language' }));
      await store.add(entry({ content: 'user likes coffee' }));

      const results = await store.search('TypeScript');
      // Keyword path: only the entry literally containing the token matches.
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('TypeScript');
      rmSync(dir, { recursive: true, force: true });
    });

    it('caches entry embeddings across searches', async () => {
      const { store, calls } = makeStore();
      await store.add(entry({ content: 'prefers pnpm' }));
      await store.add(entry({ content: 'prefers rust' }));
      await store.search('pnpm');
      const afterFirst = calls();
      await store.search('pnpm again');
      const afterSecond = calls();
      // First search: query + 2 entries. Second search reuses the cache and
      // only embeds the new query.
      expect(afterFirst).toBe(3);
      expect(afterSecond - afterFirst).toBe(1);
    });
  });

  describe('delegation', () => {
    it('add/forget/decay delegate to the inner store', async () => {
      const { store, inner } = makeStore();
      const id = await store.add(entry({ content: 'prefers pnpm' }));
      expect(inner.list('/proj')).toHaveLength(1);

      await store.forget('s1');
      expect(inner.list('/proj')).toHaveLength(0);

      await store.add(entry({ content: 'prefers pnpm', timestamp: Date.now() - 100_000 }));
      await store.decay(50_000);
      const afterDecay = inner.list('/proj')[0];
      expect(afterDecay.decayScore).toBeLessThan(1);
      expect(id).toBeTruthy();
    });
  });
});
