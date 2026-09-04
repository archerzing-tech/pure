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
  nextCustomProviderId,
  defaultModelFor,
  imageGenEnabled,
  imageGenModelFor,
  isImageModelName,
  isProviderId,
  promptBudgetForProvider,
  protocolForURL,
  firstTokenHintTimeoutMs,
  resolveProviderProtocol,
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
    expect(deepseek.contextWindowTokens).toBe(1_000_000);
    expect(deepseek.outputReserveTokens).toBe(131_072);
    expect(qwen.contextWindowTokens).toBe(262_144);
    expect(qwen.outputReserveTokens).toBe(65_536);
    // V4's million-token window dwarfs the 256k coder tier.
    expect(deepseek.availableInputTokens).toBeGreaterThan(qwen.availableInputTokens);
  });

  it('splits model tiers within a family (legacy vs long-context generations)', () => {
    const glm = resolvePromptBudget({ provider: 'glm', model: 'glm-5.3-flash' });
    expect(glm.contextWindowTokens).toBe(1_000_000);
    // Legacy V3-era DeepSeek endpoints keep the previous generation's window.
    const legacy = resolvePromptBudget({ provider: 'deepseek-openai', model: 'deepseek-chat' });
    expect(legacy.contextWindowTokens).toBe(128_000);
    // Claude 1M tiers (Sonnet 5 / Opus 5) vs the 4.5-and-earlier 200k window.
    expect(resolvePromptBudget({ provider: 'anthropic', model: 'claude-sonnet-5' }).contextWindowTokens).toBe(1_000_000);
    expect(resolvePromptBudget({ provider: 'anthropic', model: 'claude-sonnet-4-5' }).contextWindowTokens).toBe(200_000);
    // GPT-5.x: 400k total (272k in + 128k out).
    const gpt5 = resolvePromptBudget({ provider: 'openai', model: 'gpt-5.2' });
    expect(gpt5.contextWindowTokens).toBe(400_000);
    expect(gpt5.outputReserveTokens).toBe(128_000);
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
  it('falls back to builtin providerOverrides budgets for built-in providers', () => {
    const overrides: Record<string, ProviderOverride> = {
      'deepseek-openai': {
        contextWindowTokens: 96_000,
        outputReserveTokens: 12_000,
        modelBudgets: { 'deepseek-v4-flash': { contextWindowTokens: 32_000, outputReserveTokens: 4_000 } },
      },
    };
    // Model-specific override wins over the provider-wide fallback.
    const perModel = promptBudgetForProvider([], 'deepseek-openai', 'deepseek-v4-flash', overrides);
    expect(perModel.contextWindowTokens).toBe(32_000);
    expect(perModel.outputReserveTokens).toBe(4_000);
    // Another model on the same provider inherits the provider-wide budget.
    const providerWide = promptBudgetForProvider([], 'deepseek-openai', 'deepseek-chat', overrides);
    expect(providerWide.contextWindowTokens).toBe(96_000);
    expect(providerWide.outputReserveTokens).toBe(12_000);
    // No overrides → no budget (family defaults take over downstream).
    expect(promptBudgetForProvider([], 'deepseek-openai', 'deepseek-chat').contextWindowTokens).toBeUndefined();
  });
  it('prefers persisted custom-provider budgets over builtin providerOverrides', () => {
    const custom: CustomProvider = { ...OLLAMA, contextWindowTokens: 48_000 };
    const overrides: Record<string, ProviderOverride> = { ollama: { contextWindowTokens: 16_000 } };
    expect(promptBudgetForProvider([custom], 'ollama', 'tiny-coder', overrides).contextWindowTokens).toBe(48_000);
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

describe('nextCustomProviderId', () => {
  it('returns a zero-padded custom id and fills the first available slot', () => {
    expect(nextCustomProviderId([])).toBe('custom001');
    expect(nextCustomProviderId([{ id: 'custom001' }, { id: 'custom003' }])).toBe('custom002');
  });

  it('ignores legacy slug ids while avoiding exact custom-id collisions', () => {
    expect(nextCustomProviderId([{ id: 'custom' }, { id: 'custom-2' }, { id: 'custom001' }])).toBe('custom002');
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
    expect(customBaseURL([], 'glm')).toBe('https://api.z.ai/api/coding/paas/v4');
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

  it('keeps budget-only overrides instead of dropping them as tombstones', () => {
    const budgetOverrides: Record<string, ProviderOverride> = {
      'deepseek-openai': { contextWindowTokens: 96_000 },
      glm: { modelBudgets: { 'glm-5.3-flash': { outputReserveTokens: 8_000 } } },
    };
    expect(providerOverrideFor(budgetOverrides, 'deepseek-openai')).toEqual({ contextWindowTokens: 96_000 });
    expect(providerOverrideFor(budgetOverrides, 'glm')?.modelBudgets).toEqual({ 'glm-5.3-flash': { outputReserveTokens: 8_000 } });
  });

  it('customBaseURL honors a built-in override before the registry default', () => {
    expect(customBaseURL([], 'qwen', OVERRIDES)).toBe('https://my-mirror.example.com/v1');
    // Providers without an override keep the registry URL.
    expect(customBaseURL([], 'deepseek-openai', OVERRIDES)).toBe('https://api.deepseek.com');
    // Custom providers still win over the override map (they never appear in it).
    expect(customBaseURL([OLLAMA], 'ollama', OVERRIDES)).toBe('http://localhost:11434/v1');
    // Legacy call shape (no overrides) keeps working.
    expect(customBaseURL([], 'glm')).toBe('https://api.z.ai/api/coding/paas/v4');
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

  it('infers the wire protocol from the endpoint URL', () => {
    expect(protocolForURL('https://api.minimaxi.com/anthropic')).toBe('anthropic');
    expect(protocolForURL('https://api.minimaxi.com/anthropic/')).toBe('anthropic');
    expect(protocolForURL('https://api.deepseek.com/anthropic')).toBe('anthropic');
    expect(protocolForURL('https://api.openai.com/v1')).toBe('openai');
    expect(protocolForURL('https://openrouter.ai/api/v1')).toBe('openai');
    expect(protocolForURL('')).toBe('openai');
    expect(protocolForURL(undefined)).toBe('openai');
  });

  it('lets an overridden GLM Anthropic endpoint select the Anthropic wire protocol', () => {
    expect(resolveProviderProtocol(
      'openai',
      'https://open.bigmodel.cn/api/anthropic',
      true,
    )).toBe('anthropic');
    // An explicit protocol choice remains authoritative over URL detection.
    expect(resolveProviderProtocol(
      'openai',
      'https://open.bigmodel.cn/api/anthropic',
      true,
      'openai',
    )).toBe('openai');
    // The registry protocol remains the default when the endpoint is untouched.
    expect(resolveProviderProtocol('openai', 'https://api.z.ai/api/coding/paas/v4', false)).toBe('openai');
  });

  it('ships the 8 built-in providers with the official endpoints and model libraries', () => {
    expect(PROVIDERS).toHaveLength(8);
    expect(baseURLFor('moonshot')).toBe('https://api.moonshot.cn/v1');
    expect(baseURLFor('minimax')).toBe('https://api.minimaxi.com/anthropic');
    expect(baseURLFor('openai')).toBe('https://api.openai.com/v1');
    expect(baseURLFor('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(baseURLFor('nvidia')).toBe('https://integrate.api.nvidia.com/v1');
    expect(isProviderId('deepseek-anthropic')).toBe(false);
    expect(PROVIDERS.find((p) => p.id === 'minimax')?.protocol).toBe('anthropic');
    expect(PROVIDERS.find((p) => p.id === 'nvidia')?.protocol).toBe('openai');
    for (const def of PROVIDERS) {
      expect(def.models.length).toBeGreaterThan(0);
      expect(def.models[0]).toBe(def.defaultModel);
    }
  });

  describe('firstTokenHintTimeoutMs', () => {
    it('keeps the fast-chat default for quick providers and models', () => {
      expect(firstTokenHintTimeoutMs('qwen', 'qwen3-coder-next')).toBe(15_000);
      expect(firstTokenHintTimeoutMs('openai', 'gpt-4o')).toBe(15_000);
      expect(firstTokenHintTimeoutMs('anthropic', 'claude-sonnet')).toBe(15_000);
      expect(firstTokenHintTimeoutMs('glm', 'glm-4-plus')).toBe(15_000);
    });

    it('raises the budget for slow-reasoning models (deepseek-reasoner, o1/o3)', () => {
      expect(firstTokenHintTimeoutMs('deepseek-openai', 'deepseek-reasoner')).toBe(30_000);
      expect(firstTokenHintTimeoutMs('openai', 'o1')).toBe(30_000);
      expect(firstTokenHintTimeoutMs('openai', 'o3-mini')).toBe(30_000);
      // The deepseek family is slow to first token even on its fast chat model.
      expect(firstTokenHintTimeoutMs('deepseek-openai', 'deepseek-v4-flash')).toBe(30_000);
    });

    it('raises the budget for local endpoints (ollama / LM Studio)', () => {
      expect(firstTokenHintTimeoutMs('ollama', 'llama3.1')).toBe(30_000);
      expect(firstTokenHintTimeoutMs('lmstudio', 'qwen2.5-coder')).toBe(30_000);
    });

    it('is resilient to missing inputs', () => {
      expect(firstTokenHintTimeoutMs(undefined, undefined)).toBe(15_000);
      expect(firstTokenHintTimeoutMs('', '')).toBe(15_000);
      expect(firstTokenHintTimeoutMs(null, null)).toBe(15_000);
    });
  });
});
