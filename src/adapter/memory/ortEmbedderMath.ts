// src/adapter/memory/ortEmbedderMath.ts
// E0.4 — pure helpers for the OrtWebEmbedder, split out so the test suite can
// exercise the math without loading the embedder module (which statically
// imports the embedded ort-wasm assets and only ever loads inside a compiled
// release binary — see cliHarness.ts). No imports here on purpose.

/** MiniLM's context window: tokenized inputs are hard-truncated to this. */
export const ORT_MAX_SEQUENCE = 512;

/** ort-web inference chunk size — mirrors WASMEmbeddingStore's chunked
 *  batching (8 texts per session.run, yielding between chunks). */
export const ORT_EMBED_CHUNK_SIZE = 8;

/** Hard-truncate token ids to the model's context window. The hub
 *  tokenizer.json for all-MiniLM-L6-v2 ships no truncation config, so an
 *  unbounded input would silently produce a sequence the model can't accept. */
export function truncateTokenIds(ids: number[]): number[] {
  return ids.length > ORT_MAX_SEQUENCE ? ids.slice(0, ORT_MAX_SEQUENCE) : ids;
}

/**
 * Mask-weighted mean pooling + L2 normalization — the same math transformers.js
 * performs for `pooling: 'mean', normalize: true` (the semantics
 * WASMEmbeddingStore's vector search expects, so vectors stay comparable).
 *
 * @param data      last_hidden_state, flattened [batch, seq, dim]
 * @param batch     batch size (== texts.length for the chunk)
 * @param seq       padded sequence length of the chunk
 * @param dim       hidden dimension (384 for MiniLM-L6)
 * @param mask      attention_mask, flattened [batch, seq] (0 = padding)
 */
export function meanPoolBatch(
  data: Float32Array,
  batch: number,
  seq: number,
  dim: number,
  mask: ArrayLike<number>,
): number[][] {
  const vectors: number[][] = [];
  for (let b = 0; b < batch; b++) {
    const vec = new Array<number>(dim).fill(0);
    let tokens = 0;
    for (let s = 0; s < seq; s++) {
      if (!Number(mask[b * seq + s])) continue;
      tokens++;
      for (let d = 0; d < dim; d++) vec[d] += data[(b * seq + s) * dim + d];
    }
    // tokens ≥ 1 always holds: add_special_tokens guarantees at least [CLS].
    for (let d = 0; d < dim; d++) vec[d] /= tokens;
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    vectors.push(norm === 0 ? vec : vec.map((v) => v / norm));
  }
  return vectors;
}

/** Split texts into inference chunks of `size` (ORT_EMBED_CHUNK_SIZE). */
export function chunkTexts<T>(texts: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < texts.length; i += size) chunks.push(texts.slice(i, i + size));
  return chunks;
}

/**
 * Model/asset download endpoints, in try order: the configured endpoint first
 * (HF_ENDPOINT or huggingface.co), then hf-mirror.com as fallback — a large
 * share of deployments (this machine included) cannot reach huggingface.co
 * directly but the mirror serves the same files.
 */
export function resolveEndpoints(hfEndpointEnv?: string): string[] {
  const primary = hfEndpointEnv?.trim() || 'https://huggingface.co';
  const mirror = 'https://hf-mirror.com';
  return primary === mirror ? [primary] : [primary, mirror];
}
