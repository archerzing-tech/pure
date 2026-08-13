import { describe, expect, it } from 'bun:test';
import { effectiveProxyUrl, normalizeProxyConfig, normalizeProxyList, shouldBypassProxy } from '../proxy';

describe('proxy configuration', () => {
  it('normalizes comma and newline separated bypass entries', () => {
    expect(normalizeProxyList(' Ollama, deepseek-openai\nOLLAMA， qwen ')).toEqual([
      'ollama',
      'deepseek-openai',
      'qwen',
    ]);
  });

  it('keeps a fresh or missing enabled flag disabled by default', () => {
    const config = normalizeProxyConfig({ url: 'http://127.0.0.1:7890' });
    expect(config.enabled).toBe(false);
    expect(config.llmEnabled).toBe(false);
    expect(config.toolsEnabled).toBe(false);
    expect(effectiveProxyUrl(config, 'llm')).toBe('');
    expect(effectiveProxyUrl(config, 'tools')).toBe('');
  });

  it('disables an empty proxy without changing the configured bypass rules', () => {
    const config = normalizeProxyConfig({
      enabled: true,
      url: '  ',
      bypassProviders: ['ollama'],
      bypassModels: ['qwen'],
    });
    expect(effectiveProxyUrl(config)).toBe('');
    expect(config.bypassProviders).toEqual(['ollama']);
  });

  it('ignores malformed proxy URLs instead of breaking the request path', () => {
    const config = normalizeProxyConfig({ enabled: true, url: 'not-a-proxy' });
    expect(effectiveProxyUrl(config, 'llm')).toBe('');
    expect(effectiveProxyUrl(config, 'tools')).toBe('');
  });

  it('supports independent LLM and tool proxy switches', () => {
    const config = normalizeProxyConfig({
      enabled: true,
      llmEnabled: false,
      toolsEnabled: true,
      url: 'socks5://127.0.0.1:1080',
    });
    expect(effectiveProxyUrl(config, 'llm')).toBe('');
    expect(effectiveProxyUrl(config, 'tools')).toBe('socks5://127.0.0.1:1080');

    config.llmEnabled = true;
    config.toolsEnabled = false;
    expect(effectiveProxyUrl(config, 'llm')).toBe('socks5://127.0.0.1:1080');
    expect(effectiveProxyUrl(config, 'tools')).toBe('');
  });

  it('bypasses LLM traffic by provider or model name', () => {
    const config = normalizeProxyConfig({
      enabled: true,
      url: 'socks5://127.0.0.1:1080',
      bypassProviders: ['ollama'],
      bypassModels: ['deepseek-r1:8b'],
    });
    expect(shouldBypassProxy('ollama', 'qwen2.5-coder:7b', config)).toBe(true);
    expect(shouldBypassProxy('custom', 'deepseek-r1:8b', config)).toBe(true);
    expect(shouldBypassProxy('qwen', 'qwen3-coder-next', config)).toBe(false);
  });
});
