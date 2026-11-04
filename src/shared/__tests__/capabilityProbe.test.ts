// src/shared/__tests__/capabilityProbe.test.ts
// W1b-1 自探测：/models 元数据解析（openrouter 形状）、模型定位（精确/尾段）、
// 协议头（anthropic 不认 Bearer）、以及「端点活着但没给窗口」的诚实出口。

import { describe, expect, it } from 'bun:test';
import {
  findModelEntry,
  parseModelWindow,
  probeModelCapability,
  probedCapabilityKey,
} from '../capabilityProbe';

const OPENROUTER_ENTRY = {
  id: 'moonshotai/kimi-k2.6',
  context_length: 262_144,
  top_provider: { context_length: 262_144, max_completion_tokens: 65_536 },
};

describe('findModelEntry', () => {
  const data = [OPENROUTER_ENTRY, { id: 'deepseek/deepseek-v4' }, 'not-an-object'];

  it('matches exact id first and falls back to a one-level vendor tail', () => {
    expect(findModelEntry(data, 'deepseek/deepseek-v4')).toEqual(data[1]);
    expect(findModelEntry(data, 'kimi-k2.6')).toEqual(OPENROUTER_ENTRY);
    expect(findModelEntry(data, 'moonshotai/kimi-k2.6')).toEqual(OPENROUTER_ENTRY);
  });

  it('misses unknown models and non-string ids', () => {
    expect(findModelEntry(data, 'mystery-1')).toBeUndefined();
    expect(findModelEntry(data, '')).toBeUndefined();
    expect(findModelEntry([], 'x')).toBeUndefined();
  });
});

describe('parseModelWindow', () => {
  it('prefers top_provider and reads the completion cap', () => {
    expect(parseModelWindow(OPENROUTER_ENTRY))
      .toEqual({ contextWindowTokens: 262_144, outputReserveTokens: 65_536 });
  });

  it('accepts flat shapes and misses honestly when no field exists', () => {
    expect(parseModelWindow({ id: 'x', context_window: 131_072 }).contextWindowTokens).toBe(131_072);
    expect(parseModelWindow({ id: 'x', max_model_len: 32_768 }).contextWindowTokens).toBe(32_768);
    expect(parseModelWindow({ id: 'claude-sonnet-5' })).toEqual({});
    expect(parseModelWindow({ id: 'x', context_length: 0 })).toEqual({});
    expect(parseModelWindow(null)).toEqual({});
  });
});

function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 假 fetch 工厂（llmProbe.test 同款形状）：记录 URL 与头，按 payload/status 回应。 */
function fakeFetch(payload: unknown, opts: { status?: number } = {}): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('probeModelCapability', () => {
  const openrouterBody = { data: [OPENROUTER_ENTRY, { id: 'openai/gpt-5.2' }] };

  it('reads the window the endpoint publishes for the model', async () => {
    const { fetchImpl, calls } = fakeFetch(openrouterBody);
    const result = await probeModelCapability('https://openrouter.ai/api/v1/', 'sk-test', 'kimi-k2.6', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.modelFound).toBe(true);
    expect(result.contextWindowTokens).toBe(262_144);
    expect(result.outputReserveTokens).toBe(65_536);
    expect(result.error).toBe('');
    // 尾部斜杠剥掉后拼 /models；openai 协议 = Bearer（Headers 规范化键名为小写）。
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models');
    expect(calls[0].headers.authorization).toBe('Bearer sk-test');
  });

  it('sends anthropic headers for the anthropic protocol', async () => {
    const { fetchImpl, calls } = fakeFetch({ data: [{ id: 'claude-sonnet-5' }] });
    await probeModelCapability('https://api.anthropic.com/v1', 'key-1', 'claude-sonnet-5', { protocol: 'anthropic', fetchImpl });
    expect(calls[0].headers['x-api-key']).toBe('key-1');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('reports a listed-but-windowless model without inventing numbers', async () => {
    const { fetchImpl } = fakeFetch({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude' }] });
    const result = await probeModelCapability('https://x/v1', 'k', 'claude-sonnet-5', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.modelFound).toBe(true);
    expect(result.contextWindowTokens).toBeUndefined();
    expect(result.error).toContain('no context window');
  });

  it('distinguishes unlisted models, non-list bodies and key rejections', async () => {
    const unlistedFetch = fakeFetch(openrouterBody);
    const unlisted = await probeModelCapability('https://x/v1', 'k', 'nope', { fetchImpl: unlistedFetch.fetchImpl });
    expect(unlisted.modelFound).toBe(false);
    expect(unlisted.ok).toBe(true);

    const noListFetch = fakeFetch({ object: 'list' });
    const noList = await probeModelCapability('https://x/v1', 'k', 'x', { fetchImpl: noListFetch.fetchImpl });
    expect(noList.ok).toBe(true);
    expect(noList.modelFound).toBe(false);
    expect(noList.error).toContain('data[]');

    const rejectedFetch = fakeFetch({}, { status: 401 });
    const rejected = await probeModelCapability('https://x/v1', 'bad', 'x', { fetchImpl: rejectedFetch.fetchImpl });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('API key rejected');
  });

  it('survives network errors and honors the timeout signal', async () => {
    // 只 throw 的函数会被推断成 Promise<never>，与 typeof fetch 任何方向都不重叠；
    // 显式标注 Promise<Response> 让 cast 合法（llmProbe.test 的工厂天然带返回类型）。
    const errFetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const netErr = await probeModelCapability('https://x/v1', 'k', 'x', { fetchImpl: errFetch });
    expect(netErr.ok).toBe(false);
    expect(netErr.error).toContain('ECONNREFUSED');

    let signaled = false;
    // 真 fetch 在 signal 触发后会抛 AbortError——假实现模拟同款行为。
    const slowFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if ((init?.signal as AbortSignal).aborted) throw new Error('The operation was aborted.');
      return jsonOk(openrouterBody);
    }) as typeof fetch;
    const slow = await probeModelCapability('https://x/v1', 'k', 'x', {
      timeoutMs: 50,
      signalFactory: (ms) => { signaled = true; return AbortSignal.timeout(ms); },
      fetchImpl: slowFetch,
    });
    expect(signaled).toBe(true);
    expect(slow.ok).toBe(false);
    expect(slow.error).toContain('aborted');
  });
});

describe('probedCapabilityKey', () => {
  it('is provider::model', () => {
    expect(probedCapabilityKey('openrouter', 'moonshot-v1-8k')).toBe('openrouter::moonshot-v1-8k');
  });
});
