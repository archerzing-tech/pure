// src/adapter/memory/__tests__/OrtWebEmbedder.test.ts
// E0.4 — behavior of the compiled-CLI embedder that can be tested WITHOUT a
// model: lazy init failure surfaces as a clean rejection (WASMEmbeddingStore
// turns that into keyword fallback), endpoint fallback order matches
// resolveEndpoints, and cached assets short-circuit the network entirely.
// The real-inference path is verified by the compiled-binary smoke (see
// 改进进度记录.md E0.4) — the ort wasm runtime only extracts inside a binary.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrtWebEmbedder } from '../OrtWebEmbedder';

describe('OrtWebEmbedder init failures', () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'pure-ort-embedder-test-'));
  });

  afterEach(() => {
    // Temp caches stay behind in /tmp; nothing to restore.
  });

  it('rejects cleanly when every endpoint is unreachable, trying the mirror after the primary', async () => {
    const requested: string[] = [];
    const embedder = createOrtWebEmbedder({
      cacheRoot,
      fetchImpl: async (input: string | URL | Request) => {
        requested.push(String(input));
        throw new Error('offline');
      },
    });

    await expect(embedder.embed('hello')).rejects.toThrow(/embedding asset unavailable/);
    // resolveEndpoints order: primary (huggingface.co) first, mirror second —
    // per asset, tokenizer.json is the first of the parallel fetches.
    expect(requested[0]).toContain('https://huggingface.co/');
    expect(requested.some((url) => url.startsWith('https://hf-mirror.com/'))).toBe(true);
  });

  it('retries the load after a failure instead of staying dead', async () => {
    let calls = 0;
    const embedder = createOrtWebEmbedder({
      cacheRoot,
      fetchImpl: async () => {
        calls++;
        throw new Error('offline');
      },
    });

    await expect(embedder.embed('first')).rejects.toThrow();
    await expect(embedder.embed('second')).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('never touches the network when all assets are already cached', async () => {
    const modelDir = join(cacheRoot, 'models', 'Xenova/all-MiniLM-L6-v2');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'tokenizer.json'), '{}');
    writeFileSync(join(modelDir, 'tokenizer_config.json'), '{}');
    writeFileSync(join(modelDir, 'model_quantized.onnx'), Buffer.alloc(4));
    let fetchCalls = 0;
    const embedder = createOrtWebEmbedder({
      cacheRoot,
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error('must not be called');
      },
    });

    // Assets resolve from cache; init then fails INSIDE the pipeline (junk
    // model bytes) — but zero fetches happened and the runtime extracted.
    await expect(embedder.embed('hello')).rejects.toThrow();
    expect(fetchCalls).toBe(0);
    expect(existsSync(join(cacheRoot, 'ort', 'ort-wasm-simd-threaded.wasm'))).toBe(true);
    expect(readFileSync(join(cacheRoot, 'ort', 'ort-wasm-simd-threaded.wasm')).length).toBeGreaterThan(1_000_000);
  });
});
