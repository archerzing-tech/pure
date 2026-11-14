// src/shared/llmProbe.ts
// Browser-mode LLM endpoint probe — the semantic mirror of the Rust
// `probe_llm_endpoint` (src-tauri/src/lib.rs). Desktop probing runs in Rust
// through the same reqwest path as real chats; browser dev mode has no Rust
// backend, so this fetch-based probe keeps the EXACT same success semantics
// and result shape: only 2xx is a success, 401/403 is a rejected key, 404 is
// a degraded-but-reachable endpoint, and the first /models probe decides (no
// bare-baseURL fallback — mirrors Rust).

export interface LlmProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error: string;
  /** 404 降级：端点连通层活着但不暴露 /models（火山 Agent Plan 专属网关
   * 实测形态）。ok 保持 false，UI 显示 ⚠ 而非 ✗。 */
  degraded?: boolean;
}

export interface LlmProbeOptions {
  timeoutMs?: number;
  /** Wire protocol: anthropic endpoints take x-api-key + anthropic-version
   * (never Bearer) and a /v1/models URL shape — mirrors the Rust
   * apply_auth_headers / models_url_for split. Default openai. */
  anthropic?: boolean;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal factory; defaults to AbortSignal.timeout with an
   * AbortController fallback for older WKWebView. */
  signalFactory?: (ms: number) => AbortSignal;
}

/// Models-list URL by protocol — TS mirror of Rust `models_url_for`.
export function modelsUrlFor(baseURL: string, anthropic: boolean): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (anthropic) {
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

export async function probeLlmEndpoint(
  baseURL: string,
  apiKey: string,
  opts: LlmProbeOptions = {},
): Promise<LlmProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const signalFactory = opts.signalFactory ?? abortSignal;
  const anthropic = opts.anthropic === true;
  const url = modelsUrlFor(baseURL, anthropic);
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Empty-valued auth headers are worse than none (strict servers reject the
  // empty string) — mirror apply_auth_headers: no key → no header at all.
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: signalFactory(timeoutMs) });
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      error: `network error: ${(err as Error)?.message || String(err)}`,
    };
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  if (response.ok) {
    return { ok: true, status: response.status, latencyMs, error: '' };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: `HTTP ${response.status} — API key rejected`,
    };
  }
  if (response.status === 404) {
    // 404 ≠ 端点死（mirror Rust probe_llm_endpoint）：拿到响应 = 连通层全通，
    // 只是端点不提供 /models。degraded 上报，UI 显示 ⚠ 而非 ✗。
    return {
      ok: false,
      degraded: true,
      status: response.status,
      latencyMs,
      error: 'HTTP 404 — endpoint does not expose /models (inference may still work)',
    };
  }
  return { ok: false, status: response.status, latencyMs, error: `HTTP ${response.status}` };
}

/** AbortSignal.timeout needs Safari 16+ (macOS 13). Older WKWebView versions
 * throw a TypeError here — fall back to AbortController + setTimeout. */
function abortSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}
