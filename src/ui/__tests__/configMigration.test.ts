// src/ui/__tests__/configMigration.test.ts
// loadConfig() 级别的配置迁移回归测试（mock localStorage + window.location）。
// 重点覆盖 v10：修复「全局 Base URL 残留劫持」——迁移清空全局 baseURL 字段，
// 把非默认地址转入对应内置供应商的 providerOverrides，避免所有供应商卡片与
// 请求被一个陈旧的地址（如阿里百炼）劫持。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, invalidateConfigCache, STORAGE_KEY, type PureConfig } from '../config';

const mem: Record<string, string> = {};

function stubGlobals(): void {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => { mem[k] = v; },
    removeItem: (k: string) => { delete mem[k]; },
  };
  // config.ts's loadConfig() reads window.location.search (dev query params).
  (globalThis as Record<string, unknown>).window = { location: { search: '' } };
}

function seedConfig(partial: Record<string, unknown>): void {
  mem[STORAGE_KEY] = JSON.stringify({ configVersion: 9, ...partial });
}

beforeEach(() => {
  Object.keys(mem).forEach(k => delete mem[k]);
  invalidateConfigCache();
  stubGlobals();
});

afterEach(() => {
  Object.keys(mem).forEach(k => delete mem[k]);
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).window;
  invalidateConfigCache();
});

describe('config v10 migration — legacy global Base URL', () => {
  it('drops a stale global Base URL that matches a registry default (the hijack bug)', () => {
    // The exact regression: a DashScope URL left in the global field made
    // DeepSeek/GLM cards and requests all point at it. Matching a built-in
    // default means it was never a deliberate override → just scrub it.
    seedConfig({
      provider: 'deepseek-openai',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
    const cfg = loadConfig()!;
    expect(cfg.baseURL).toBe('');
    expect(cfg.providerOverrides).toEqual({});
    expect(cfg.configVersion).toBe(10);
  });

  it('moves a non-default global Base URL to the active built-in override', () => {
    // A genuinely custom endpoint (gateway / mirror) must survive the cleanup
    // — it lands on the provider it was last edited for.
    seedConfig({
      provider: 'glm',
      baseURL: 'https://my-gateway.example.com/v1',
    });
    const cfg = loadConfig()!;
    expect(cfg.baseURL).toBe('');
    expect(cfg.providerOverrides.glm?.baseURL).toBe('https://my-gateway.example.com/v1');
    expect(cfg.configVersion).toBe(10);
  });

  it('never overwrites an existing override during migration', () => {
    seedConfig({
      provider: 'glm',
      baseURL: 'https://old-global.example.com/v1',
      providerOverrides: { glm: { baseURL: 'https://existing.example.com/v1' } },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides.glm?.baseURL).toBe('https://existing.example.com/v1');
    expect(cfg.baseURL).toBe('');
  });

  it('does not migrate the global Base URL for non-built-in providers', () => {
    // Custom providers own their endpoint on their entry — a leftover global
    // value is meaningless for them and must not surface as an override.
    seedConfig({
      provider: 'my-custom',
      baseURL: 'https://custom.example.com/v1',
    });
    const cfg = loadConfig()!;
    expect(cfg.baseURL).toBe('');
    expect(cfg.providerOverrides).toEqual({});
    expect(cfg.configVersion).toBe(10);
  });

  it('persists the migrated config back to storage (idempotent re-read)', () => {
    seedConfig({
      provider: 'qwen',
      baseURL: 'https://gateway.example.com/v1',
    });
    loadConfig();
    const persisted = JSON.parse(mem[STORAGE_KEY]!) as PureConfig;
    expect(persisted.configVersion).toBe(10);
    expect(persisted.baseURL).toBe('');
    expect(persisted.providerOverrides.qwen?.baseURL).toBe('https://gateway.example.com/v1');
    // A second read must not re-migrate or change anything.
    invalidateConfigCache();
    const again = loadConfig()!;
    expect(again.configVersion).toBe(10);
    expect(again.baseURL).toBe('');
    expect(again.providerOverrides.qwen?.baseURL).toBe('https://gateway.example.com/v1');
  });

  it('leaves an already-migrated v10 config untouched (no rewrite)', () => {
    const v10 = {
      configVersion: 10,
      provider: 'qwen',
      baseURL: '',
      providerOverrides: { qwen: { baseURL: 'https://mirror.example.com/v1' } },
    };
    mem[STORAGE_KEY] = JSON.stringify(v10);
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides.qwen?.baseURL).toBe('https://mirror.example.com/v1');
    expect(cfg.configVersion).toBe(10);
    // needsPersist stays false → storage byte-identical.
    expect(JSON.parse(mem[STORAGE_KEY]!)).toEqual(v10);
  });

  it('chains older migrations (v1 → v10) without breaking the final state', () => {
    mem[STORAGE_KEY] = JSON.stringify({
      provider: 'glm',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-legacy',
      model: 'glm-5.2',
      toolBrowser: false, // pre-v2 decorative false must be restored
    });
    const cfg = loadConfig()!;
    expect(cfg.configVersion).toBe(10);
    expect(cfg.toolBrowser).toBe(true); // v2 restored the real gate
    expect(cfg.baseURL).toBe(''); // v10 scrubbed the global field
    expect(cfg.providerOverrides.glm?.baseURL).toBe('https://gateway.example.com/v1');
    expect(cfg.mcpServers.some(s => s.name === 'web-search')).toBe(true); // v3
    expect(cfg.hubSkills).toEqual([]); // v4
    expect(cfg.customProviders).toEqual([]); // v5
    expect(cfg.mcpExcludedPrefixes).toEqual([]); // v9
  });
});
