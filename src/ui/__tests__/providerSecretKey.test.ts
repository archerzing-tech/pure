// src/ui/__tests__/providerSecretKey.test.ts
// 判例（2026-11-02，OpenRouter 全轮「已中断」）：内置 provider 的 key 槽
// 曾经由 per-provider override 的 hasApiKey 标记决定——标记没置位（key 由
// CLI 交接或手改 secrets 写入）时请求落到全局 llm.apiKey 槽，那里坐的是
// 另一家 provider 的 key，OpenRouter 每轮回 401，UI 只看到「连续多次尝试
// 均失败」。槽位解析改成以 provider 身份为准：内置走 llm.apiKey.<id>，
// 自定义走 llm.apiKey.<customId>，与 hasApiKey 标记无关。

import { describe, it, expect } from 'bun:test';
import { providerSecretKeyFor, customSecretKey } from '../config';
import type { CustomProvider } from '../../shared/providers';

const custom: CustomProvider[] = [
  {
    id: 'my-local',
    name: 'My Local',
    baseURL: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    defaultModel: 'local-model',
    apiKey: '',
    hasApiKey: false,
  },
];

describe('providerSecretKeyFor（内置 provider 不再依赖 hasApiKey 标记）', () => {
  it('内置 provider 一律取自己的专属槽，即使没有 override 条目', () => {
    // 判例现场：providerOverrides 里没有 openrouter 条目，secrets 里却有
    // llm.apiKey.openrouter。旧逻辑返回 undefined → 全局槽 → 401。
    expect(providerSecretKeyFor('openrouter', [])).toBe('llm.apiKey.openrouter');
    expect(providerSecretKeyFor('nvidia', [])).toBe('llm.apiKey.nvidia');
    expect(providerSecretKeyFor('moonshot', [])).toBe('llm.apiKey.moonshot');
  });

  it('自定义 provider 取它自己的槽（id 与内置同名时也不串）', () => {
    expect(providerSecretKeyFor('my-local', custom)).toBe(customSecretKey('my-local'));
  });

  it('没有 provider 时不指定槽（调用方按遗留行为处理）', () => {
    expect(providerSecretKeyFor(undefined, custom)).toBeUndefined();
    expect(providerSecretKeyFor('', custom)).toBeUndefined();
  });

  it('槽名格式与 storeCustomSecretInRust 写入的完全一致', () => {
    // 写入用 customSecretKey(id)，读取必须逐字相同，否则 key 永远取不到。
    expect(providerSecretKeyFor('openrouter', [])).toBe(customSecretKey('openrouter'));
  });
});
