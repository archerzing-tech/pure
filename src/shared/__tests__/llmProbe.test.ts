import { describe, expect, it } from 'bun:test';
import { probeLlmEndpoint, type LlmProbeResult } from '../llmProbe';

function fakeFetch(status: number, opts?: { throws?: boolean }): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    if (opts?.throws) throw new Error('fetch failed: ECONNREFUSED');
    return {
      ok: status >= 200 && status < 300,
      status,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('probeLlmEndpoint (browser mirror of Rust probe_llm_endpoint)', () => {
  it('probes {base}/models with the Authorization header and reports 2xx as ok', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const result = await probeLlmEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/', 'sk-abc', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-abc');
  });

  // ── 协议分流（可用性门禁 v2）：anthropic 端点探测必须与真实对话同款 ──

  it('anthropic protocol sends x-api-key + anthropic-version, never Bearer', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const result = await probeLlmEndpoint('https://api.anthropic.com/v1', 'sk-anthropic', { fetchImpl, anthropic: true });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0].headers['x-api-key']).toBe('sk-anthropic');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('anthropic protocol builds /v1/models for a bare anthropic-compat base', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    await probeLlmEndpoint('https://api.minimaxi.com/anthropic', 'sk', { fetchImpl, anthropic: true });
    expect(calls[0].url).toBe('https://api.minimaxi.com/anthropic/v1/models');
  });

  it('anthropic protocol with an empty key sends no auth header at all', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    await probeLlmEndpoint('https://api.minimaxi.com/anthropic', '', { fetchImpl, anthropic: true });
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  it('omits the Authorization header when no key is given (keyless endpoints)', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    await probeLlmEndpoint('http://localhost:11434/v1', '', { fetchImpl });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('reports 401/403 as a rejected key, not a connection success', async () => {
    const { fetchImpl } = fakeFetch(401);
    const result = await probeLlmEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-bad', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain('API key rejected');
  });

  it('reports 404 as degraded-reachable, not dead (火山 Agent Plan 网关不暴露 /models)', async () => {
    const { fetchImpl } = fakeFetch(404);
    const result = await probeLlmEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3', 'ark-key', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.status).toBe(404);
    expect(result.error).toContain('/models');
  });

  it('reports other non-2xx statuses with the raw HTTP code', async () => {
    const { fetchImpl } = fakeFetch(429);
    const result = await probeLlmEndpoint('https://example.com/v1', 'sk', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBeUndefined();
    expect(result.error).toBe('HTTP 429');
  });

  it('reports network failures as network error with the cause', async () => {
    const { fetchImpl } = fakeFetch(0, { throws: true });
    const result = await probeLlmEndpoint('https://example.com/v1', 'sk', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toContain('network error');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('strips a trailing slash before appending /models (mirrors Rust trim_end_matches)', async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    await probeLlmEndpoint('https://api.deepseek.com/', 'sk', { fetchImpl });
    expect(calls[0].url).toBe('https://api.deepseek.com/models');
  });

  it('uses the injected signal factory for timeout abort', async () => {
    const { fetchImpl } = fakeFetch(200);
    let factoryUsed = false;
    const result = await probeLlmEndpoint('https://example.com/v1', 'sk', {
      fetchImpl,
      signalFactory: (ms) => {
        factoryUsed = true;
        expect(ms).toBe(8000);
        return new AbortController().signal;
      },
    });
    expect(result.ok).toBe(true);
    expect(factoryUsed).toBe(true);
  });
});
