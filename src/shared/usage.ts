// src/shared/usage.ts
// Per-request token usage normalization + session cost estimation.
//
// Providers report usage in different shapes (OpenAI-style `usage.prompt_tokens`,
// DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`), so the
// adapters pass the raw object through and normalize here. Cost uses the
// pricing table below (USD per 1M tokens); unknown models fall back to the
// provider family default, and unknown families report $0 (shown as "—").

import type { TokenUsage } from './types';

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  /** Price of prompt tokens served from the provider's context cache. */
  cacheHitPerM: number;
}

const PRICE_FALLBACK: ModelPrice = { inputPerM: 0, outputPerM: 0, cacheHitPerM: 0 };

// Per-provider family pricing. Prices are public list prices (USD per 1M
// tokens) as of Aug 2026; cache-hit pricing is what DeepSeek/Qwen/GLM charge
// for context-cached input. Treated as estimates — actual bills follow the
// provider's current rate card.
const PROVIDER_PRICES: Record<string, ModelPrice> = {
  // DeepSeek V4-flash line (deepseek-chat successor): input $0.14, cache hit $0.0028, output $0.28
  'deepseek-openai': { inputPerM: 0.14, outputPerM: 0.28, cacheHitPerM: 0.0028 },
  'deepseek-anthropic': { inputPerM: 0.14, outputPerM: 0.28, cacheHitPerM: 0.0028 },
  // Qwen3-coder: ~$0.22 input, ~$0.11 cached input, ~$0.90 output
  qwen: { inputPerM: 0.22, outputPerM: 0.9, cacheHitPerM: 0.11 },
  // GLM-5 family: ~$1.00 input, ~$0.20 cached input, ~$3.20 output
  glm: { inputPerM: 1.0, outputPerM: 3.2, cacheHitPerM: 0.2 },
};

/** Look up a price for a provider id (falling back to zeros for unknown). */
export function priceFor(provider: string): ModelPrice {
  return PROVIDER_PRICES[provider] ?? PRICE_FALLBACK;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize a provider's raw usage object (OpenAI-compatible / DeepSeek) into
 * the canonical TokenUsage shape. Returns undefined when nothing usable is
 * present. DeepSeek reports cache split at the top level
 * (`prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`); OpenAI-style
 * providers put it in `prompt_tokens_details.cached_tokens`.
 */
export function normalizeTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const promptTokens = num(r.prompt_tokens);
  const completionTokens = num(r.completion_tokens);
  const cacheHitTokens = num(r.prompt_cache_hit_tokens ?? r.prompt_tokens_details?.cached_tokens);
  const cacheMissTokens = num(
    r.prompt_cache_miss_tokens ??
      (promptTokens !== undefined && cacheHitTokens !== undefined
        ? Math.max(0, promptTokens - cacheHitTokens)
        : undefined),
  );
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheHitTokens === undefined &&
    cacheMissTokens === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens };
}

/** Sum two usage objects field-by-field (undefined-safe). */
export function mergeTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
    cacheHitTokens: (a.cacheHitTokens ?? 0) + (b.cacheHitTokens ?? 0),
    cacheMissTokens: (a.cacheMissTokens ?? 0) + (b.cacheMissTokens ?? 0),
  };
}

/** Estimated cost in USD for a usage total under a provider's rate card. */
export function estimateCostUsd(usage: TokenUsage | undefined, provider: string): number {
  if (!usage) return 0;
  const p = priceFor(provider);
  const miss = usage.cacheMissTokens ?? usage.promptTokens ?? 0;
  const hit = usage.cacheHitTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  return (miss * p.inputPerM + hit * p.cacheHitPerM + output * p.outputPerM) / 1_000_000;
}

/** Format a USD amount compactly (e.g. `$0.0037`, `$1.24`). */
export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '—';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format a token count with thousands separators. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || n <= 0) return '0';
  return n.toLocaleString('en-US');
}

/**
 * Compact token formatting for tight spaces (sidebar rows): `1.2k`, `3.4M`;
 * falls back to plain numbers below 1k.
 */
export function formatTokensCompact(n: number | undefined): string {
  if (n === undefined || n <= 0) return '0';
  if (n >= 1_000_000) {
    // 1.2M, 12.3M; whole 10M+ (no noisy decimals).
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    // 1.2k, 12.3k, 123.5k; whole 1000k+ (10^6 handled above, so cap is 999.9k).
    const k = n / 1_000;
    return `${k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}
