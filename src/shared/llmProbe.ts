// src/shared/llmProbe.ts
// Browser-mode LLM endpoint probe — the semantic mirror of the Rust
// `probe_llm_endpoint` (src-tauri/src/lib.rs). Desktop probing runs in Rust
// through the same reqwest path as real chats; browser dev mode has no Rust
// backend, so this fetch-based probe keeps the EXACT same success semantics
// and result shape: only 2xx is a success, 401/403 is a rejected key, and the
// first /models probe decides (no bare-baseURL fallback — mirrors Rust).

export interface LlmProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error: string;
}

export interface LlmProbeOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal factory; defaults to AbortSignal.timeout with an
   * AbortController fallback for older WKWebView. */
  signalFactory?: (ms: number) => AbortSignal;
}

export async function probeLlmEndpoint(
  baseURL: string,
  apiKey: string,
  opts: LlmProbeOptions = {},
): Promise<LlmProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const signalFactory = opts.signalFactory ?? abortSignal;
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
