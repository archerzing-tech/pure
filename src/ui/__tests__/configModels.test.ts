import { describe, expect, it } from 'bun:test';
import { defaults, modelListForProvider, normalizeProviderModels } from '../config';

describe('provider model lists', () => {
  it('keeps a built-in provider usable with one default model', () => {
    const cfg = { ...defaults(), model: 'deepseek-v4-flash' };
    expect(modelListForProvider(cfg, 'deepseek-openai')).toEqual(['deepseek-v4-flash']);
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
