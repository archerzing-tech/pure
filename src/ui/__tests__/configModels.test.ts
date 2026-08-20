import { describe, expect, it } from 'bun:test';
import { defaults, hasConfiguredKey, modelListForProvider, normalizeProviderModels, providerHasKey, SCRAPLING_MCP_PRESET, withDefaultModel } from '../config';

describe('provider model lists', () => {
  it('keeps a built-in provider usable with one default model', () => {
    const cfg = { ...defaults(), model: 'deepseek-v4-flash' };
    // Empty library falls back to the registry's default model list.
    expect(modelListForProvider(cfg, 'deepseek-openai')).toEqual(['deepseek-v4-flash', 'deepseek-reasoner']);
  });

  it('returns all configured models for a provider without mixing providers', () => {
    const cfg = {
      ...defaults(),
      providerModels: {
        'deepseek-openai': ['deepseek-v4-flash', 'deepseek-chat'],
        qwen: ['qwen3-coder-next'],
      },
    };
    expect(modelListForProvider(cfg, 'deepseek-openai')).toEqual(['deepseek-v4-flash', 'deepseek-chat']);
    expect(modelListForProvider(cfg, 'qwen')).toEqual(['qwen3-coder-next']);
  });

  it('does not resurrect a deleted registry default from an explicit library', () => {
    const cfg = {
      ...defaults(),
      provider: 'deepseek-openai',
      model: 'deepseek-reasoner',
      providerModels: { 'deepseek-openai': ['deepseek-reasoner'] },
    };
    expect(modelListForProvider(cfg, 'deepseek-openai')).toEqual(['deepseek-reasoner']);
  });

  it('preserves custom provider model lists as the compatibility source', () => {
    const cfg = {
      ...defaults(),
      customProviders: [{
        id: 'local',
        name: 'Local',
        baseURL: 'http://localhost:11434/v1',
        models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
        defaultModel: 'llama3.1:8b',
        apiKey: '',
        hasApiKey: false,
        local: true,
      }],
    };
    expect(modelListForProvider(cfg, 'local')).toEqual(['qwen2.5-coder:7b', 'llama3.1:8b']);
  });

  it('trims, deduplicates, and ignores malformed persisted lists', () => {
    expect(normalizeProviderModels({
      openai: [' gpt-4o ', 'gpt-4o', '', 42, 'gpt-4o-mini'],
      broken: 'not-an-array',
    })).toEqual({ openai: ['gpt-4o', 'gpt-4o-mini'] });
  });
});

describe('Scrapling MCP preset', () => {
  it('launches scrapling with the [ai] extra (bare uvx scrapling mcp lacks CLI deps)', () => {
    expect(SCRAPLING_MCP_PRESET).toEqual({
      name: 'scrapling',
      transport: 'stdio',
      command: ['uvx', '--from', 'scrapling[ai]', 'scrapling', 'mcp'],
      requestTimeoutMs: 120_000,
    });
  });

  it('sets a long request timeout for browser-backed tools', () => {
    expect(SCRAPLING_MCP_PRESET.requestTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it('is NOT part of the always-on defaults (Python + uv is opt-in)', () => {
    const d = defaults();
    expect(d.mcpServers.some(s => s.name === 'scrapling')).toBe(false);
  });

  it('defaults to no excluded MCP prefixes', () => {
    expect(defaults().mcpExcludedPrefixes).toEqual([]);
  });

  it('defaults to no built-in provider overrides', () => {
    expect(defaults().providerOverrides).toEqual({});
  });

  it('does not collide with the built-in web-search server name', () => {
    const names = new Set([...defaults().mcpServers, SCRAPLING_MCP_PRESET].map(s => s.name));
    expect(names.size).toBe(2); // web-search + scrapling
  });
});

describe('hasConfiguredKey', () => {
  it('accepts the legacy global key (browser / Rust)', () => {
    expect(hasConfiguredKey({ ...defaults(), apiKey: 'sk-x' })).toBe(true);
    expect(hasConfiguredKey({ ...defaults(), hasApiKey: true })).toBe(true);
  });

  it('accepts a custom provider (keyed or keyless)', () => {
    const cfg = {
      ...defaults(),
      customProviders: [{
        id: 'local', name: 'Local', baseURL: 'http://localhost:11434/v1',
        models: ['qwen2.5-coder:7b'], defaultModel: 'qwen2.5-coder:7b',
        apiKey: '', hasApiKey: false, local: true,
      }],
      provider: 'local',
    };
    expect(hasConfiguredKey(cfg)).toBe(true);
  });

  it('accepts a built-in with a per-provider override key', () => {
    const cfg = {
      ...defaults(),
      provider: 'qwen',
      providerOverrides: { qwen: { baseURL: 'https://mirror/v1', hasApiKey: true } },
    };
    expect(hasConfiguredKey(cfg)).toBe(true);
  });

  it('rejects an unconfigured built-in without any key', () => {
    const cfg = { ...defaults(), provider: 'glm', apiKey: '', hasApiKey: false };
    expect(hasConfiguredKey(cfg)).toBe(false);
  });
});

describe('providerHasKey', () => {
  const customProvider = (over: Partial<{ apiKey: string; hasApiKey: boolean; local: boolean; baseURL: string }> = {}) => ({
    id: 'local', name: 'Local', baseURL: 'http://localhost:11434/v1',
    models: ['qwen2.5-coder:7b'], defaultModel: 'qwen2.5-coder:7b',
    apiKey: '', hasApiKey: false, ...over,
  });

  it('accepts a built-in with the legacy global key', () => {
    expect(providerHasKey({ ...defaults(), apiKey: 'sk-x' }, 'deepseek-openai')).toBe(true);
    expect(providerHasKey({ ...defaults(), hasApiKey: true }, 'qwen')).toBe(true);
  });

  it('accepts a built-in with a per-provider override key', () => {
    const cfg = { ...defaults(), providerOverrides: { qwen: { hasApiKey: true } } };
    expect(providerHasKey(cfg, 'qwen')).toBe(true);
  });

  it('rejects a built-in without any key', () => {
    expect(providerHasKey(defaults(), 'glm')).toBe(false);
  });

  it('accepts a keyed custom provider and a keyless local endpoint', () => {
    expect(providerHasKey({ ...defaults(), customProviders: [customProvider({ apiKey: 'k' })] }, 'local')).toBe(true);
    expect(providerHasKey({ ...defaults(), customProviders: [customProvider({ local: true })] }, 'local')).toBe(true);
  });

  it('rejects a key-required custom provider without a key', () => {
    expect(providerHasKey({ ...defaults(), customProviders: [customProvider()] }, 'local')).toBe(false);
  });

  it('rejects a custom provider with a key but no Base URL', () => {
    expect(providerHasKey({ ...defaults(), customProviders: [customProvider({ apiKey: 'k', baseURL: '' })] }, 'local')).toBe(false);
  });

  it('rejects a keyless local endpoint without a Base URL', () => {
    expect(providerHasKey({ ...defaults(), customProviders: [customProvider({ local: true, baseURL: '' })] }, 'local')).toBe(false);
  });

  it('rejects a built-in whose override blanked the Base URL', () => {
    const cfg = { ...defaults(), providerOverrides: { qwen: { baseURL: '', hasApiKey: true } } };
    expect(providerHasKey(cfg, 'qwen')).toBe(false);
  });
});

describe('withDefaultModel (LLM page default-model bar)', () => {
  it('derives the provider and pins the model into a built-in library', () => {
    const cfg = { ...defaults(), provider: 'deepseek-openai', model: 'deepseek-v4-flash' };
    const next = withDefaultModel(cfg, 'qwen', 'qwen3-coder-next');
    expect(next.provider).toBe('qwen');
    expect(next.model).toBe('qwen3-coder-next');
    expect(next.providerModels.qwen).toContain('qwen3-coder-next');
    // The previous provider's config survives untouched.
    expect(next.providerModels['deepseek-openai']).toBeUndefined();
  });

  it('keeps an already-present model unique in the library', () => {
    const cfg = {
      ...defaults(),
      provider: 'deepseek-openai',
      providerModels: { qwen: ['qwen3-coder-next', 'qwen3-max'] },
    };
    const next = withDefaultModel(cfg, 'qwen', 'qwen3-coder-next');
    expect(next.providerModels.qwen).toEqual(['qwen3-coder-next', 'qwen3-max']);
  });

  it('updates a custom provider entry without touching built-in libraries', () => {
    const custom = {
      id: 'local', name: 'Local', baseURL: 'http://localhost:11434/v1',
      models: ['qwen2.5-coder:7b', 'llama3.1:8b'], defaultModel: 'qwen2.5-coder:7b',
      apiKey: '', hasApiKey: false, local: true,
    };
    const cfg = { ...defaults(), customProviders: [custom] };
    const next = withDefaultModel(cfg, 'local', 'llama3.1:8b');
    expect(next.provider).toBe('local');
    expect(next.model).toBe('llama3.1:8b');
    expect(next.customProviders[0].defaultModel).toBe('llama3.1:8b');
    expect(next.providerModels).toEqual({});
  });
});
