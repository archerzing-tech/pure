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
    expect(cfg.configVersion).toBe(14);
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
    expect(cfg.configVersion).toBe(14);
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
    expect(cfg.configVersion).toBe(14);
  });

  it('persists the migrated config back to storage (idempotent re-read)', () => {
    seedConfig({
      provider: 'qwen',
      baseURL: 'https://gateway.example.com/v1',
    });
    loadConfig();
    const persisted = JSON.parse(mem[STORAGE_KEY]!) as PureConfig;
    expect(persisted.configVersion).toBe(14);
    expect(persisted.baseURL).toBe('');
    expect(persisted.providerOverrides.qwen?.baseURL).toBe('https://gateway.example.com/v1');
    // A second read must not re-migrate or change anything.
    invalidateConfigCache();
    const again = loadConfig()!;
    expect(again.configVersion).toBe(14);
    expect(again.baseURL).toBe('');
    expect(again.providerOverrides.qwen?.baseURL).toBe('https://gateway.example.com/v1');
  });

  it('flips autoContinue on once when migrating a pre-v14 config', () => {
    const v13 = {
      configVersion: 13,
      provider: 'qwen',
      baseURL: '',
      autoContinue: false,
      providerOverrides: { qwen: { baseURL: 'https://mirror.example.com/v1' } },
    };
    mem[STORAGE_KEY] = JSON.stringify(v13);
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides.qwen?.baseURL).toBe('https://mirror.example.com/v1');
    expect(cfg.configVersion).toBe(14);
    // v14: long-task auto-continue becomes default-on for existing configs.
    expect(cfg.autoContinue).toBe(true);
    // Migrated → persisted; a re-read is stable and does NOT re-flip an
    // explicit user opt-out.
    invalidateConfigCache();
    const again = loadConfig()!;
    expect(again.autoContinue).toBe(true);
    mem[STORAGE_KEY] = JSON.stringify({ ...JSON.parse(mem[STORAGE_KEY]!), configVersion: 14, autoContinue: false });
    invalidateConfigCache();
    const explicitOff = loadConfig()!;
    expect(explicitOff.autoContinue).toBe(false);
    expect(explicitOff.configVersion).toBe(14);
  });

  it('chains older migrations (v1 → v11) without breaking the final state', () => {
    mem[STORAGE_KEY] = JSON.stringify({
      provider: 'glm',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-legacy',
      model: 'glm-5.2',
      toolBrowser: false, // pre-v2 decorative false must be restored
    });
    const cfg = loadConfig()!;
    expect(cfg.configVersion).toBe(14);
    expect(cfg.toolBrowser).toBe(true); // v2 restored the real gate
    expect(cfg.baseURL).toBe(''); // v10 scrubbed the global field
    expect(cfg.providerOverrides.glm?.baseURL).toBe('https://gateway.example.com/v1');
    expect(cfg.mcpServers.some(s => s.name === 'web-search')).toBe(true); // v3
    expect(cfg.hubSkills).toEqual([]); // v4
    expect(cfg.customProviders).toEqual([]); // v5
    expect(cfg.mcpExcludedPrefixes).toEqual([]); // v9
  });
});

describe('config v11 migration — scrub registry-default override leftovers', () => {
  it('removes a trailing-slash copy of a registry default from its own provider', () => {
    // e.g. the v10 migration could have carried 'https://dashscope.…/v1/'
    // (exact string differs from the registry → migrated) — v11 normalizes
    // and recognizes it as the default again, so the card shows the clean
    // official endpoint.
    seedConfig({
      provider: 'qwen',
      providerOverrides: { qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' } },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides).toEqual({});
    expect(cfg.configVersion).toBe(14);
  });

  it('removes a cross-provider default (DashScope URL sitting on DeepSeek)', () => {
    // The hijack-era contamination: a DashScope URL stored as DeepSeek's
    // override. It equals a registry default → scrub, restoring DeepSeek's
    // official endpoint.
    seedConfig({
      provider: 'deepseek-openai',
      providerOverrides: {
        'deepseek-openai': { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides).toEqual({});
  });

  it('keeps a genuine custom endpoint override', () => {
    seedConfig({
      provider: 'glm',
      providerOverrides: { glm: { baseURL: 'https://my-gateway.example.com/v1' } },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides.glm?.baseURL).toBe('https://my-gateway.example.com/v1');
  });

  it('drops only the default endpoint, keeping sibling override fields', () => {
    seedConfig({
      provider: 'glm',
      providerOverrides: {
        glm: { name: 'GLM 网关', baseURL: 'https://open.bigmodel.cn/api/paas/v4', hasApiKey: true },
      },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides.glm?.baseURL).toBeUndefined();
    expect(cfg.providerOverrides.glm?.name).toBe('GLM 网关');
    expect(cfg.providerOverrides.glm?.hasApiKey).toBe(true);
  });

  it('case/whitespace variants of a default are scrubbed too', () => {
    seedConfig({
      provider: 'glm',
      providerOverrides: { glm: { baseURL: '  HTTPS://OPEN.BIGMODEL.CN/API/PAAS/V4/  ' } },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides).toEqual({});
  });
});

describe('config v12 migration — DeepSeek is ONE provider', () => {
  it('repoints the active provider from the retired anthropic id', () => {
    seedConfig({ provider: 'deepseek-anthropic', model: 'deepseek-v4-flash' });
    const cfg = loadConfig()!;
    expect(cfg.provider).toBe('deepseek-openai');
    expect(cfg.model).toBe('deepseek-v4-flash');
  });

  it('merges the retired model library into deepseek-openai', () => {
    seedConfig({
      provider: 'deepseek-openai',
      providerModels: {
        'deepseek-anthropic': ['deepseek-reasoner', 'deepseek-chat'],
        'deepseek-openai': ['deepseek-v4-flash'],
      },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerModels['deepseek-anthropic']).toBeUndefined();
    expect(cfg.providerModels['deepseek-openai']).toEqual(['deepseek-v4-flash', 'deepseek-reasoner', 'deepseek-chat']);
  });

  it('merges the retired override into deepseek-openai without clobbering existing fields', () => {
    seedConfig({
      provider: 'deepseek-anthropic',
      providerOverrides: {
        'deepseek-anthropic': { name: 'DeepSeek 网关', hasApiKey: true },
        'deepseek-openai': { baseURL: 'https://gateway.example.com/v1' },
      },
    });
    const cfg = loadConfig()!;
    expect(cfg.providerOverrides['deepseek-anthropic']).toBeUndefined();
    expect(cfg.providerOverrides['deepseek-openai']).toEqual({
      baseURL: 'https://gateway.example.com/v1',
      name: 'DeepSeek 网关',
      hasApiKey: true,
    });
  });

  it('stays put when the config is already at v14', () => {
    const raw = JSON.stringify({ configVersion: 14, provider: 'glm', model: 'glm-5.2', autoContinue: false });
    mem[STORAGE_KEY] = raw;
    const cfg = loadConfig()!;
    expect(cfg.configVersion).toBe(14);
    // Already at the newest schema → no rewrite, and an explicit user opt-out
    // (v14 flipped the default once) is preserved byte-identically.
    expect(cfg.autoContinue).toBe(false);
    expect(mem[STORAGE_KEY]).toBe(raw);
  });
});

describe('reasoning effort normalization', () => {
  it('backfills medium for old configs and snaps unknown values back', () => {
    // A config persisted before reasoningEffort existed → defaults() fills it.
    seedConfig({});
    expect(loadConfig()?.reasoningEffort).toBe('medium');

    // A hand-edited or stale value must not reach the wire.
    seedConfig({ reasoningEffort: 'ultra' });
    invalidateConfigCache();
    expect(loadConfig()?.reasoningEffort).toBe('medium');

    // Real values pass through untouched.
    seedConfig({ reasoningEffort: 'high' });
    invalidateConfigCache();
    expect(loadConfig()?.reasoningEffort).toBe('high');
  });
});
