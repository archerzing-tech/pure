import { describe, it, expect } from 'bun:test';
import {
  CUSTOM_PRESETS,
  NVIDIA_PRESET,
  OLLAMA_PRESET,
  OPENAI_PRESET,
  OPENROUTER_PRESET,
  PROVIDERS,
  baseURLFor,
  customBaseURL,
  customDefaultModel,
  customProviderFor,
  customProviderLabel,
  defaultModelFor,
  imageGenEnabled,
  imageGenModelFor,
  isImageModelName,
  isProviderId,
  promptBudgetForProvider,
  providerOverrideFor,
  resolvePromptBudget,
  isCustomKeyless,
  isCustomProviderId,
  type CustomProvider,
  type ProviderOverride,
} from '../providers';

const OLLAMA: CustomProvider = { ...OLLAMA_PRESET };

const KEYED: CustomProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'],
  defaultModel: 'anthropic/claude-3.5-sonnet',
  apiKey: 'sk-test',
  hasApiKey: false,
};

describe('resolvePromptBudget', () => {
  it('adapts the input budget to provider/model families', () => {
    const deepseek = resolvePromptBudget({ provider: 'deepseek-openai', model: 'deepseek-v4-flash' });
    const qwen = resolvePromptBudget({ provider: 'qwen', model: 'qwen3-coder-next' });
    expect(deepseek.contextWindowTokens).toBe(64_000);
    expect(deepseek.outputReserveTokens).toBe(32_768);
    expect(qwen.contextWindowTokens).toBe(128_000);
    expect(qwen.availableInputTokens).toBeGreaterThan(deepseek.availableInputTokens);
  });

  it('uses explicit limits for unknown/custom models and accounts for consumed input', () => {
    const budget = resolvePromptBudget({
      provider: 'custom-local',
      model: 'my-model',
      contextWindowTokens: 1_000,
      outputReserveTokens: 200,
      safetyMarginTokens: 50,
      usedInputTokens: 100,
    });
    expect(budget.source).toBe('override');
    expect(budget.availableInputTokens).toBe(650);
  });
  it('uses persisted custom provider/model metadata before family fallbacks', () => {
    const custom: CustomProvider = {
      ...OLLAMA,
      contextWindowTokens: 48_000,
      outputReserveTokens: 6_000,
      modelBudgets: { 'tiny-coder': { contextWindowTokens: 16_000, outputReserveTokens: 2_000 } },
    };
    const input = promptBudgetForProvider([custom], 'ollama', 'tiny-coder');
    const budget = resolvePromptBudget(input);
    expect(budget.contextWindowTokens).toBe(16_000);
    expect(budget.outputReserveTokens).toBe(2_000);
    expect(budget.source).toBe('override');
  });
});

describe('customProviderFor', () => {
  it('finds a custom provider by id', () => {
    expect(customProviderFor([OLLAMA, KEYED], 'ollama')?.name).toBe('Ollama (local)');
    expect(customProviderFor([OLLAMA, KEYED], 'openrouter')?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('returns undefined for unknown ids / empty lists', () => {
    expect(customProviderFor([OLLAMA], 'nope')).toBeUndefined();
    expect(customProviderFor(undefined, 'ollama')).toBeUndefined();
    expect(customProviderFor(null, 'ollama')).toBeUndefined();
    expect(customProviderFor([], undefined)).toBeUndefined();
  });
});

describe('isCustomProviderId', () => {
  it('distinguishes custom ids from built-ins', () => {
    expect(isCustomProviderId([OLLAMA], 'ollama')).toBe(true);
    expect(isCustomProviderId([OLLAMA], 'deepseek-openai')).toBe(false);
    expect(isCustomProviderId(undefined, 'ollama')).toBe(false);
  });
});

describe('custom label / model / baseURL resolution', () => {
  it('resolves custom providers by their saved name', () => {
    expect(customProviderLabel([OLLAMA], 'ollama')).toBe('Ollama (local)');
    // Unknown ids fall back to the raw id.
    expect(customProviderLabel([], 'deepseek-openai')).toBe('DeepSeek');
    expect(customProviderLabel([], 'weird-id')).toBe('weird-id');
  });

  it('resolves default model and base URL, custom-first', () => {
    expect(customDefaultModel([OLLAMA], 'ollama')).toBe('qwen2.5-coder:7b');
    expect(customBaseURL([OLLAMA], 'ollama')).toBe('http://localhost:11434/v1');
    // Built-ins keep their registry defaults.
    expect(customDefaultModel([], 'qwen')).toBe(defaultModelFor('qwen'));
    expect(customBaseURL([], 'glm')).toBe('https://open.bigmodel.cn/api/paas/v4');
  });
});

describe('provider overrides (built-in name / endpoint / key edits)', () => {
  const OVERRIDES: Record<string, ProviderOverride> = {
    qwen: { baseURL: 'https://my-mirror.example.com/v1' },
    glm: { name: 'GLM 国内网关', baseURL: 'https://gateway.example.com/v1', hasApiKey: true },
    'deepseek-openai': {},
  };

  it('providerOverrideFor returns the entry, ignoring empty tombstones', () => {
    expect(providerOverrideFor(OVERRIDES, 'qwen')?.baseURL).toBe('https://my-mirror.example.com/v1');
    expect(providerOverrideFor(OVERRIDES, 'glm')?.name).toBe('GLM 国内网关');
    // An all-empty entry is a stale tombstone — treated as absent.
    expect(providerOverrideFor(OVERRIDES, 'deepseek-openai')).toBeUndefined();
    expect(providerOverrideFor(OVERRIDES, 'unknown')).toBeUndefined();
    expect(providerOverrideFor(undefined, 'qwen')).toBeUndefined();
  });

  it('customBaseURL honors a built-in override before the registry default', () => {
    expect(customBaseURL([], 'qwen', OVERRIDES)).toBe('https://my-mirror.example.com/v1');
    // Providers without an override keep the registry URL.
    expect(customBaseURL([], 'deepseek-openai', OVERRIDES)).toBe('https://api.deepseek.com');
    // Custom providers still win over the override map (they never appear in it).
    expect(customBaseURL([OLLAMA], 'ollama', OVERRIDES)).toBe('http://localhost:11434/v1');
    // Legacy call shape (no overrides) keeps working.
    expect(customBaseURL([], 'glm')).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('customProviderLabel honors a built-in name override before the registry label', () => {
    expect(customProviderLabel([], 'glm', OVERRIDES)).toBe('GLM 国内网关');
    expect(customProviderLabel([], 'qwen', OVERRIDES)).toBe('Qwen');
    // Custom providers resolve by their own name first.
    expect(customProviderLabel([OLLAMA], 'ollama', OVERRIDES)).toBe('Ollama (local)');
  });
});

describe('isCustomKeyless', () => {
  it('true only for custom providers with no key', () => {
    expect(isCustomKeyless([OLLAMA], 'ollama')).toBe(true);
    expect(isCustomKeyless([KEYED], 'openrouter')).toBe(false);
    expect(isCustomKeyless([OLLAMA], 'deepseek-openai')).toBe(false);
    expect(isCustomKeyless(undefined, 'ollama')).toBe(false);
  });

  it('a stored key (Rust secrets, hasApiKey) counts as configured', () => {
    const withStoredKey: CustomProvider = { ...OLLAMA, apiKey: '', hasApiKey: true };
    expect(isCustomKeyless([withStoredKey], 'ollama')).toBe(false);
  });
});

describe('OLLAMA_PRESET', () => {
  it('is a complete keyless local preset', () => {
    expect(OLLAMA_PRESET.id).toBe('ollama');
    expect(OLLAMA_PRESET.baseURL).toBe('http://localhost:11434/v1');
    expect(OLLAMA_PRESET.models.length).toBeGreaterThan(0);
    expect(OLLAMA_PRESET.defaultModel).toBe(OLLAMA_PRESET.models[0]);
    expect(OLLAMA_PRESET.apiKey).toBe('');
    expect(OLLAMA_PRESET.hasApiKey).toBe(false);
    expect(OLLAMA_PRESET.local).toBe(true);
  });
});

describe('cloud quick presets (OpenAI / OpenRouter / NVIDIA)', () => {
  it('OPENAI_PRESET points at the official OpenAI-compatible endpoint', () => {
    expect(OPENAI_PRESET.id).toBe('openai');
    expect(OPENAI_PRESET.baseURL).toBe('https://api.openai.com/v1');
    expect(OPENAI_PRESET.models.length).toBeGreaterThan(0);
    expect(OPENAI_PRESET.defaultModel).toBe(OPENAI_PRESET.models[0]);
    expect(OPENAI_PRESET.apiKey).toBe('');
    expect(OPENAI_PRESET.local).toBeUndefined();
    // Ships with text-to-image enabled (gpt-image-1) so image requests render
    // as real pictures instead of SVG.
    expect(OPENAI_PRESET.imageGen).toBe(true);
    expect(OPENAI_PRESET.imageGenModel).toBe('gpt-image-1');
  });

  it('OPENROUTER_PRESET uses the /api/v1 endpoint and model-per-org naming', () => {
    expect(OPENROUTER_PRESET.id).toBe('openrouter');
    expect(OPENROUTER_PRESET.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(OPENROUTER_PRESET.defaultModel).toMatch(/^[a-z0-9-]+\//);
  });

  it('NVIDIA_PRESET uses the NIM integrate endpoint', () => {
    expect(NVIDIA_PRESET.id).toBe('nvidia');
    expect(NVIDIA_PRESET.baseURL).toBe('https://integrate.api.nvidia.com/v1');
    expect(NVIDIA_PRESET.defaultModel).toMatch(/^[a-z0-9-]+\//);
  });

  it('CUSTOM_PRESETS lists all four chips with unique ids', () => {
    expect(CUSTOM_PRESETS.map(p => p.id)).toEqual(['ollama', 'openai', 'openrouter', 'nvidia']);
    expect(new Set(CUSTOM_PRESETS.map(p => p.id)).size).toBe(CUSTOM_PRESETS.length);
    for (const p of CUSTOM_PRESETS) {
      expect(p.baseURL).not.toBe('');
      expect(p.models.length).toBeGreaterThan(0);
    }
  });
});

describe('text-to-image capability detection', () => {
  it('detects image-capable model names', () => {
    expect(isImageModelName('gpt-image-1')).toBe(true);
    expect(isImageModelName('dall-e-3')).toBe(true);
    expect(isImageModelName('cogview-4')).toBe(true);
    expect(isImageModelName('flux-dev')).toBe(true);
    expect(isImageModelName('gemini-2.5-flash-image')).toBe(true);
    expect(isImageModelName('deepseek-v4-flash')).toBe(false);
    expect(isImageModelName('gpt-4o-mini')).toBe(false);
    expect(isImageModelName('')).toBe(false);
    expect(isImageModelName(undefined)).toBe(false);
  });

  it('enables via the explicit custom-provider flag', () => {
    const openai: CustomProvider = { ...OPENAI_PRESET };
    expect(imageGenEnabled([openai], 'openai', 'gpt-4o-mini')).toBe(true);
    expect(imageGenModelFor([openai], 'openai', 'gpt-4o-mini')).toBe('gpt-image-1');
  });

  it('enables via an image-capable chat model name even without the flag', () => {
    expect(imageGenEnabled([], 'openai', 'gpt-image-1')).toBe(true);
    expect(imageGenModelFor([], 'openai', 'gpt-image-1')).toBe('gpt-image-1');
    // Built-in providers light up the same way (e.g. a cogview model on GLM).
    expect(imageGenEnabled([], 'glm', 'cogview-4')).toBe(true);
  });

  it('prefers the explicit image model over the chat model', () => {
    const custom: CustomProvider = { ...OPENAI_PRESET, imageGenModel: 'dall-e-3' };
    expect(imageGenModelFor([custom], 'openai', 'gpt-4o-mini')).toBe('dall-e-3');
  });

  it('stays disabled for plain chat models without the flag', () => {
    expect(imageGenEnabled([], 'deepseek-openai', 'deepseek-v4-flash')).toBe(false);
    expect(imageGenEnabled([OLLAMA], 'ollama', 'qwen2.5-coder:7b')).toBe(false);
    expect(imageGenEnabled([], 'qwen', 'qwen3-coder-next')).toBe(false);
    expect(imageGenEnabled([], 'glm', 'glm-5.2')).toBe(false);
  });

  it('falls back to gpt-image-1 as the default image model', () => {
    const custom: CustomProvider = { ...OLLAMA, imageGen: true };
    expect(imageGenModelFor([custom], 'ollama', 'qwen2.5-coder:7b')).toBe('gpt-image-1');
  });

  it('treats the new built-in OpenAI entry as image-capable', () => {
    expect(imageGenEnabled([], 'openai', 'gpt-5.2')).toBe(true);
    expect(imageGenModelFor([], 'openai', 'gpt-5.2')).toBe('gpt-image-1');
    // A user-supplied custom entry with the same id wins over the built-in.
    const custom: CustomProvider = { ...OPENAI_PRESET, imageGenModel: 'dall-e-3' };
    expect(imageGenModelFor([custom], 'openai', 'gpt-5.2')).toBe('dall-e-3');
  });

  it('ships the 8 built-in providers with the official endpoints and model libraries', () => {
    expect(PROVIDERS).toHaveLength(8);
    expect(baseURLFor('moonshot')).toBe('https://api.moonshot.cn/v1');
    expect(baseURLFor('minimax')).toBe('https://api.minimaxi.com/v1');
    expect(baseURLFor('openai')).toBe('https://api.openai.com/v1');
    expect(baseURLFor('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(baseURLFor('nvidia')).toBe('https://integrate.api.nvidia.com/v1');
    expect(isProviderId('deepseek-anthropic')).toBe(false);
    for (const def of PROVIDERS) {
      expect(def.models.length).toBeGreaterThan(0);
      expect(def.models[0]).toBe(def.defaultModel);
    }
  });
});
