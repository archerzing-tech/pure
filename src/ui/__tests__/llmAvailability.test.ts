// src/ui/__tests__/llmAvailability.test.ts
// 可用性台账（docs/llm-availability-gate-2026-11.md v2）纯函数面：429 连败
// 降级、呈现过滤单缝、快照纪律（只记 ok:true / 身份失配作废）、设置保存
// 字段 diff、回合失败分类。模块级副作用（探测循环/localStorage）不在测。

import { describe, expect, it } from 'bun:test';
import {
  verdictFromProbe,
  filterModelOptionsByAvailability,
  snapshotFromLedger,
  adoptSnapshot,
  llmRelevantConfigChanged,
  isConnectionLayerTurnError,
  configuredEndpoints,
  type LlmAvailabilityInfo,
} from '../llmModelAvailability';

describe('verdictFromProbe — 429 连败降级', () => {
  it('前两次 429 保持可访问并计数（限流 ≠ 不可访问，下架让用户失去退路）', () => {
    const first = verdictFromProbe(undefined, { ok: false, status: 429 });
    expect(first.ok).toBe(true);
    expect(first.limitedStreak).toBe(1);
    const second = verdictFromProbe(first, { ok: false, status: 429 });
    expect(second.ok).toBe(true);
    expect(second.limitedStreak).toBe(2);
  });

  it('连续第三次 429 降级为不可访问（配额耗尽不该永久占列表）', () => {
    const third = verdictFromProbe(
      verdictFromProbe(verdictFromProbe(undefined, { ok: false, status: 429 }), { ok: false, status: 429 }),
      { ok: false, status: 429 },
    );
    expect(third.ok).toBe(false);
    expect(third.limitedStreak).toBe(3);
  });

  it('非 429 结果复位计数与结论', () => {
    const limited = verdictFromProbe(
      verdictFromProbe(verdictFromProbe(undefined, { ok: false, status: 429 }), { ok: false, status: 429 }),
      { ok: false, status: 429 },
    );
    expect(limited.ok).toBe(false);
    const recovered = verdictFromProbe(limited, { ok: true, status: 200 });
    expect(recovered.ok).toBe(true);
    expect(recovered.limitedStreak).toBe(0);
    expect(recovered.error).toBeUndefined();
  });

  it('401/403 判不可访问且不计入限流（key 被拒是另一类）', () => {
    const v = verdictFromProbe(undefined, { ok: false, status: 401, error: 'HTTP 401 — API key rejected' });
    expect(v.ok).toBe(false);
    expect(v.limitedStreak).toBe(0);
    const v3 = verdictFromProbe(undefined, { ok: false, status: 403 });
    expect(v3.ok).toBe(false);
  });

  it('2xx 判可访问、不带错误', () => {
    const v = verdictFromProbe(undefined, { ok: true, status: 200, latencyMs: 42 });
    expect(v.ok).toBe(true);
    expect(v.latencyMs).toBe(42);
    expect(v.error).toBeUndefined();
  });

  it('连接层失败判不可访问', () => {
    const v = verdictFromProbe(undefined, { ok: false, error: 'network error: connection refused' });
    expect(v.ok).toBe(false);
  });
});

describe('filterModelOptionsByAvailability — 呈现门禁单缝', () => {
  const entries = [
    { provider: 'glm', model: 'glm-5.3-flash', value: 'glm::0' },
    { provider: 'glm', model: 'glm-5.2', value: 'glm::1' },
    { provider: 'deepseek-openai', model: 'deepseek-flash', value: 'deepseek-openai::0' },
  ];

  it('不可访问 provider 的整组消失', () => {
    const out = filterModelOptionsByAvailability(entries, (p) => p === 'glm');
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.provider === 'glm')).toBe(true);
  });

  it('未知（lookup 返回 false）与不可访问同样不显示', () => {
    expect(filterModelOptionsByAvailability(entries, () => false)).toHaveLength(0);
  });

  it('全可访问原样通过', () => {
    expect(filterModelOptionsByAvailability(entries, () => true)).toHaveLength(3);
  });
});

describe('快照纪律 — 只记 ok:true、身份失配作废', () => {
  it('snapshotFromLedger 丢弃失败与限流降级条目，错误字段不进盘', () => {
    const snap = snapshotFromLedger([
      ['glm::https://x', { ok: true, checkedAt: 1, latencyMs: 5 } satisfies LlmAvailabilityInfo],
      ['ds::https://y', { ok: false, checkedAt: 2, error: 'network error' } satisfies LlmAvailabilityInfo],
      ['q::https://z', { ok: false, checkedAt: 3, status: 429, limitedStreak: 3, error: 'rate limited (429)' } satisfies LlmAvailabilityInfo],
    ]);
    expect(Object.keys(snap)).toEqual(['glm::https://x']);
    expect(snap['glm::https://x']).toEqual({ ok: true, checkedAt: 1, latencyMs: 5 });
  });

  it('adoptSnapshot 只采纳当前配置身份下的 ok:true 条目', () => {
    const adopted = adoptSnapshot(
      {
        'glm::https://x': { ok: true, checkedAt: 1 },
        'dead::https://old-endpoint': { ok: true, checkedAt: 2 },
        'ds::https://y': { ok: false, checkedAt: 3 },
      },
      new Set(['glm::https://x']),
    );
    expect(adopted).toEqual([['glm::https://x', { ok: true, checkedAt: 1 }]]);
  });

  it('adoptSnapshot 对 null/undefined/坏结构安全', () => {
    expect(adoptSnapshot(null, new Set(['k']))).toEqual([]);
    expect(adoptSnapshot(undefined, new Set(['k']))).toEqual([]);
    expect(adoptSnapshot({}, new Set(['k']))).toEqual([]);
  });
});

describe('llmRelevantConfigChanged — 设置保存字段 diff', () => {
  const base = { provider: 'glm', model: 'glm-5.3-flash', theme: 'light', fontSize: 'small' } as
    Record<string, unknown>;

  it('LLM 相关字段变化 → true', () => {
    expect(llmRelevantConfigChanged(base as never, { ...base, provider: 'deepseek-openai' } as never)).toBe(true);
    expect(llmRelevantConfigChanged(base as never, { ...base, model: 'glm-5.2' } as never)).toBe(true);
    expect(llmRelevantConfigChanged(base as never, { ...base, proxy: { url: 'http://127.0.0.1:7890' } } as never)).toBe(true);
    expect(llmRelevantConfigChanged(base as never, { ...base, customProviders: [{ id: 'x' }] } as never)).toBe(true);
    expect(llmRelevantConfigChanged(base as never, { ...base, hasApiKey: true } as never)).toBe(true);
  });

  it('外观字段变化 → false（改主题/字号不清模型列表）', () => {
    expect(llmRelevantConfigChanged(base as never, { ...base, theme: 'dark', fontSize: 'large' } as never)).toBe(false);
  });

  it('null 安全：从无到有算变化，双 null 算无变化', () => {
    expect(llmRelevantConfigChanged(null, base as never)).toBe(true);
    expect(llmRelevantConfigChanged(base as never, null)).toBe(true);
    expect(llmRelevantConfigChanged(null, null)).toBe(false);
  });
});

describe('isConnectionLayerTurnError — 回合失败分类', () => {
  it('连接层失败判 true（重探信号）', () => {
    expect(isConnectionLayerTurnError('network error: connection refused')).toBe(true);
    expect(isConnectionLayerTurnError('HTTP 401 — API key rejected')).toBe(true);
    expect(isConnectionLayerTurnError('stream_timeout_first_token: 300s 没等到首块')).toBe(true);
    expect(isConnectionLayerTurnError('请求被你所在网络的网关拦截（403）')).toBe(true);
    expect(isConnectionLayerTurnError('dns lookup failed for api.example.com')).toBe(true);
  });

  it('429/限流/业务错误判 false（链路是通的，不碰台账）', () => {
    expect(isConnectionLayerTurnError('HTTP 429 rate limited')).toBe(false);
    expect(isConnectionLayerTurnError('触发限流，请稍后重试')).toBe(false);
    expect(isConnectionLayerTurnError('maximum context length exceeded')).toBe(false);
    expect(isConnectionLayerTurnError('模型说这个功能做不了')).toBe(false);
    expect(isConnectionLayerTurnError('')).toBe(false);
  });
});

describe('configuredEndpoints — 枚举单缝与 key 解析同款', () => {
  it('无 config 返回空', () => {
    expect(configuredEndpoints(null)).toEqual([]);
  });

  it('按 providerHasKey 过滤；有 key 的内置 provider 进清单且带各自 secret 槽', () => {
    const cfg = {
      provider: 'glm',
      model: 'glm-5.3-flash',
      apiKey: 'global-key',
      hasApiKey: true,
      customProviders: [],
      providerOverrides: {
        'deepseek-openai': { apiKey: '', hasApiKey: true },
      },
    } as never;
    const endpoints = configuredEndpoints(cfg);
    const ids = endpoints.map((e) => e.provider);
    expect(ids).toContain('glm'); // 当前 provider，全局 key
    expect(ids).toContain('deepseek-openai'); // 非当前，但 override 槽有 key
    expect(ids).not.toContain('openai'); // 无 override key 的其他内置不进
    const glm = endpoints.find((e) => e.provider === 'glm')!;
    expect(glm.allowLegacyKeyFallback).toBe(true);
    expect(glm.anthropic).toBe(false);
    const ds = endpoints.find((e) => e.provider === 'deepseek-openai')!;
    expect(ds.secretKey).toBe('llm.apiKey.deepseek-openai');
  });

  it('anthropic 协议内置（minimax）标记 anthropic；keyless 本地 custom 进清单', () => {
    const cfg = {
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      apiKey: 'k',
      hasApiKey: true,
      customProviders: [
        { id: 'ollama', name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', models: ['q'], defaultModel: 'q', apiKey: '', local: true },
      ],
      providerOverrides: {},
    } as never;
    const endpoints = configuredEndpoints(cfg);
    const minimax = endpoints.find((e) => e.provider === 'minimax')!;
    expect(minimax.anthropic).toBe(true);
    const ollama = endpoints.find((e) => e.provider === 'ollama')!;
    expect(ollama).toBeTruthy();
    expect(ollama.anthropic).toBe(false);
    expect(ollama.allowLegacyKeyFallback).toBe(false);
  });
});
