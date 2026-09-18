// src/adapter/memory/__tests__/ortEmbedderMath.test.ts
// E0.4 — pure math for the compiled-CLI OrtWebEmbedder. These tests never
// import OrtWebEmbedder.ts itself (its static `with { type: 'file' }` asset
// imports only resolve inside a compiled binary; see cliHarness.ts).

import { describe, it, expect } from 'bun:test';
import {
  ORT_EMBED_CHUNK_SIZE,
  ORT_MAX_SEQUENCE,
  chunkTexts,
  meanPoolBatch,
  resolveEndpoints,
  truncateTokenIds,
} from '../ortEmbedderMath';

describe('truncateTokenIds', () => {
  it('passes through short inputs untouched', () => {
    const ids = [101, 2023, 2003];
    expect(truncateTokenIds(ids)).toEqual(ids);
  });

  it('hard-truncates to the model context window', () => {
    const ids = Array.from({ length: ORT_MAX_SEQUENCE + 50 }, (_, i) => i);
    const truncated = truncateTokenIds(ids);
    expect(truncated).toHaveLength(ORT_MAX_SEQUENCE);
    // The head of the sequence is kept ([CLS]/[SEP] live at the edges).
    expect(truncated[0]).toBe(0);
  });
});

describe('meanPoolBatch', () => {
  it('mask-weighted means over sequence positions and L2-normalizes', () => {
    // batch=2, seq=3, dim=2. Second position of b0 is padding (masked out).
    // b0 tokens: [1,1] -> values [1,3] and [3,5] -> mean [2,4], norm sqrt(20)
    // b1 tokens: [1,1,1] -> [1,1],[3,3],[5,5] -> mean [3,3], norm sqrt(18)
    const data = new Float32Array([
      1, 3, 3, 5, 0, 0,
      1, 1, 3, 3, 5, 5,
    ]);
    const mask = [1, 1, 0, 1, 1, 1];
    const [v0, v1] = meanPoolBatch(data, 2, 3, 2, mask);
    const n0 = Math.sqrt(2 * 2 + 4 * 4);
    const n1 = Math.sqrt(3 * 3 + 3 * 3);
    expect(v0[0]).toBeCloseTo(2 / n0, 12);
    expect(v0[1]).toBeCloseTo(4 / n0, 12);
    expect(v1[0]).toBeCloseTo(3 / n1, 12);
    expect(v1[1]).toBeCloseTo(3 / n1, 12);
  });

  it('produces unit-norm vectors', () => {
    const data = new Float32Array([2, 0, 0, 4, 0, 0]);
    const [v] = meanPoolBatch(data, 1, 3, 2, [1, 1, 1]);
    const norm = Math.hypot(v[0], v[1]);
    expect(norm).toBeCloseTo(1, 12);
  });
});

describe('chunkTexts', () => {
  it('splits into ORT_EMBED_CHUNK_SIZE pieces and keeps order', () => {
    const texts = Array.from({ length: 19 }, (_, i) => `t${i}`);
    const chunks = chunkTexts(texts, ORT_EMBED_CHUNK_SIZE);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(ORT_EMBED_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(3);
    expect(chunks.flat()).toEqual(texts);
  });

  it('returns a single chunk for small inputs and none for empty', () => {
    expect(chunkTexts(['a'], 8)).toEqual([['a']]);
    expect(chunkTexts([], 8)).toEqual([]);
  });
});

describe('resolveEndpoints', () => {
  it('tries the default endpoint then the mirror', () => {
    expect(resolveEndpoints(undefined)).toEqual(['https://huggingface.co', 'https://hf-mirror.com']);
  });

  it('respects HF_ENDPOINT and dedupes the mirror', () => {
    expect(resolveEndpoints('https://hf-mirror.com')).toEqual(['https://hf-mirror.com']);
    expect(resolveEndpoints(' https://example.com/hf ')).toEqual(['https://example.com/hf', 'https://hf-mirror.com']);
  });
});
