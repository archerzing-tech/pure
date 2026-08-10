import { describe, it, expect } from 'bun:test';
import {
  OLLAMA_PRESET,
  customBaseURL,
  customDefaultModel,
  customProviderFor,
  customProviderLabel,
  defaultModelFor,
  isCustomKeyless,
  isCustomProviderId,
  type CustomProvider,
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
  });
});
