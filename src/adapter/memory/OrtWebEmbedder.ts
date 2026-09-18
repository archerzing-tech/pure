// src/adapter/memory/OrtWebEmbedder.ts
// E0.4 — local embedding backend for the COMPILED release CLI (spike verdict:
// feasible via direct onnxruntime-web WASM + @huggingface/tokenizers, both
// pure JS; transformers.js itself cannot be bundled — it statically imports
// the onnxruntime-node native binding, which bun cannot embed in a single
// file).
//
// This module is ONLY loaded inside compiled binaries: cliHarness.ts reaches
// it through a dynamic import gated on PURE_CLI_VERSION (the build's
// --define). Its static `with { type: 'file' }` imports embed the ort-wasm
// binary + JS factory into the executable; at init they are extracted to the
// cache dir and handed to ORT via env.wasm.wasmPaths. The model (q8 MiniLM,
// ~23MB — a quarter of the fp32 the GUI path downloads) and tokenizer are
// fetched on first use into the same cache, huggingface.co first with
// hf-mirror.com as the fallback endpoint (HF_ENDPOINT overrides).
//
// Every failure (offline, extraction, session) throws — WASMEmbeddingStore
// catches injected-embedder rejections and falls back to keyword search, and
// its retry cooldown paces re-attempts. In dev (`bun run cli`) this module
// never loads; the transformers.js WASM path stays as-is.

import * as ort from 'onnxruntime-web/wasm';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm' with { type: 'file' };
import ortWasmFactory from 'onnxruntime-web/ort-wasm-simd-threaded.mjs' with { type: 'file' };
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  chunkTexts,
  meanPoolBatch,
  resolveEndpoints,
  truncateTokenIds,
} from './ortEmbedderMath';
import type { EmbedBatchFunction, EmbedFunction } from './WASMEmbeddingStore';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_FILE = 'model_quantized.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
const WASM_BINARY_NAME = 'ort-wasm-simd-threaded.wasm';
const WASM_FACTORY_NAME = 'ort-wasm-simd-threaded.mjs';
const ORT_EMBED_DIM = 384;

/** Minimal fetch shape (no static properties — tests inject plain callables). */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OrtWebEmbedderOptions {
  /** Cache root for extracted runtime + downloaded assets. Defaults to
   *  PURE_CACHE_DIR or ~/.pure/cache. */
  cacheRoot?: string;
  /** Progress notes (first-use downloads land here). Defaults to silent. */
  onProgress?: (message: string) => void;
  /** Fetch implementation override (tests). */
  fetchImpl?: FetchLike;
}

export interface OrtEmbedder {
  embed: EmbedFunction;
  embedBatch: EmbedBatchFunction;
}

/**
 * Build the embed functions handed to WASMEmbeddingStore's injection seam
 * (`embed`/`embedBatch`). Initialization is lazy and single-flight; a failed
 * init clears itself so the next search retries (the wrapper's cooldown
 * paces how often).
 */
export function createOrtWebEmbedder(options: OrtWebEmbedderOptions = {}): OrtEmbedder {
  const cacheRoot = options.cacheRoot
    ?? process.env.PURE_CACHE_DIR
    ?? join(homedir(), '.pure', 'cache');
  const progress = options.onProgress ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  let initPromise: Promise<EmbedSession> | undefined;

  const embedBatch: EmbedBatchFunction = async (texts) => {
    if (texts.length === 0) return [];
    if (!initPromise) {
      initPromise = init(cacheRoot, progress, fetchImpl).catch((err) => {
        // Drop the failed init so the next search retries the whole load
        // instead of staying dead for the process lifetime (the wrapper's
        // cooldown paces how often that retry happens).
        initPromise = undefined;
        throw err;
      });
    }
    const { session, tokenizer } = await initPromise;
    const vectors: number[][] = [];
    for (const [index, chunk] of chunkTexts(texts, 8).entries()) {
      // Yield between chunks (macrotask) so the Harness memory-search timeout
      // can fire during long corpus embeddings instead of blocking past it.
      if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      vectors.push(...(await embedChunk(session, tokenizer, chunk)));
    }
    return vectors;
  };

  return {
    embed: async (text: string) => (await embedBatch([text]))[0],
    embedBatch,
  };
}

interface EmbedSession {
  session: ort.InferenceSession;
  tokenizer: Tokenizer;
}

async function init(cacheRoot: string, progress: (m: string) => void, fetchImpl: FetchLike): Promise<EmbedSession> {
  const modelDir = join(cacheRoot, 'models', MODEL_REPO);
  const runtimeDir = join(cacheRoot, 'ort');
  await Promise.all([
    fetchAsset(`${MODEL_REPO}/resolve/main/${TOKENIZER_FILE}`, join(modelDir, TOKENIZER_FILE), progress, fetchImpl),
    fetchAsset(`${MODEL_REPO}/resolve/main/${TOKENIZER_CONFIG_FILE}`, join(modelDir, TOKENIZER_CONFIG_FILE), progress, fetchImpl),
    fetchAsset(`${MODEL_REPO}/resolve/main/onnx/${MODEL_FILE}`, join(modelDir, MODEL_FILE), progress, fetchImpl),
  ]);
  extractEmbeddedRuntime(runtimeDir, progress);
  // Hand ORT the extracted runtime explicitly — without this it resolves the
  // wasm factory relative to the executable (/$bunfs/root inside a compiled
  // binary), which does not exist. Single-threaded: no worker plumbing needed
  // (measured ~50ms per chunk of 8 texts, plenty for memory search).
  ort.env.wasm.wasmPaths = {
    wasm: pathToFileURL(join(runtimeDir, WASM_BINARY_NAME)).href,
    mjs: pathToFileURL(join(runtimeDir, WASM_FACTORY_NAME)).href,
  };
  ort.env.wasm.numThreads = 1;
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(modelDir, TOKENIZER_FILE), 'utf-8')),
    JSON.parse(readFileSync(join(modelDir, TOKENIZER_CONFIG_FILE), 'utf-8')),
  );
  const session = await ort.InferenceSession.create(
    new Uint8Array(readFileSync(join(modelDir, MODEL_FILE))),
    { executionProviders: ['wasm'] },
  );
  return { session, tokenizer };
}

/** One chunk through the session + mean-pool/L2 (same math as transformers.js
 *  pooling:'mean', normalize:true, so vectors stay comparable). */
async function embedChunk(session: ort.InferenceSession, tokenizer: Tokenizer, texts: string[]): Promise<number[][]> {
  const encodings = texts.map((t) => tokenizer.encode(t, { add_special_tokens: true }));
  const ids = encodings.map((e) => truncateTokenIds([...e.ids]));
  const masks = encodings.map((e) => truncateTokenIds([...(e.attention_mask ?? e.ids.map(() => 1))]));
  const seq = Math.max(...ids.map((tokens) => tokens.length));
  const pad = (tokens: number[]) => [...tokens, ...new Array<number>(seq - tokens.length).fill(0)];
  const flatIds = ids.flatMap(pad);
  const flatMask = masks.flatMap(pad);
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(flatIds.map(BigInt)), [texts.length, seq]),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(flatMask.map(BigInt)), [texts.length, seq]),
    token_type_ids: new ort.Tensor('int64', new BigInt64Array(texts.length * seq), [texts.length, seq]),
  });
  const hidden = out.last_hidden_state ?? Object.values(out)[0];
  return meanPoolBatch(hidden.data as Float32Array, texts.length, seq, ORT_EMBED_DIM, flatMask);
}

async function fetchAsset(
  remotePath: string,
  dest: string,
  progress: (m: string) => void,
  fetchImpl: FetchLike,
): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  const endpoints = resolveEndpoints(process.env.HF_ENDPOINT);
  const errors: string[] = [];
  for (const base of endpoints) {
    try {
      const res = await fetchImpl(`${base}/${remotePath}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
      progress(`cached ${remotePath} (${Math.round(body.length / 1024 / 1024)}MB) -> ${dest}`);
      return;
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`embedding asset unavailable (${errors.join(' | ')})`);
}

function extractEmbeddedRuntime(runtimeDir: string, progress: (m: string) => void): void {
  const binary = join(runtimeDir, WASM_BINARY_NAME);
  const factory = join(runtimeDir, WASM_FACTORY_NAME);
  if (existsSync(binary) && existsSync(factory) && statSync(binary).size > 0 && statSync(factory).size > 0) return;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(binary, readEmbeddedAsset(ortWasm, WASM_BINARY_NAME));
  writeFileSync(factory, readEmbeddedAsset(ortWasmFactory, WASM_FACTORY_NAME));
  progress(`extracted ort wasm runtime to ${runtimeDir}`);
}

function readEmbeddedAsset(assetPath: string, name: string): Buffer {
  try {
    return readFileSync(assetPath);
  } catch (err) {
    throw new Error(`embedded ort asset ${name} unreadable at ${assetPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
