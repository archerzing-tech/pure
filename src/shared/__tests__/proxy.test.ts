import { describe, expect, it } from 'bun:test';
import { effectiveProxyUrl, normalizeProxyConfig, normalizeProxyList, proxyUrlWithAuth, shouldBypassProxy } from '../proxy';

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

  it('embeds percent-encoded proxy credentials into the effective URL', () => {
    const config = normalizeProxyConfig({
      enabled: true,
      toolsEnabled: true,
      url: 'http://127.0.0.1:7890',
      username: 'bob',
      password: 'p@ss',
    });
    expect(effectiveProxyUrl(config)).toBe('http://bob:p%40ss@127.0.0.1:7890/');
  });

  it('embeds credentials into SOCKS5 URLs too', () => {
    expect(proxyUrlWithAuth('socks5://127.0.0.1:1080', 'bob', 'p@ss')).toBe('socks5://bob:p%40ss@127.0.0.1:1080');
  });

  it('ignores a password without a username and trims the username', () => {
    expect(proxyUrlWithAuth('http://127.0.0.1:7890', '', 'secret')).toBe('http://127.0.0.1:7890');
    expect(proxyUrlWithAuth('http://127.0.0.1:7890', '  bob  ', '')).toBe('http://bob@127.0.0.1:7890/');
  });

  it('omits the password when it is stored in Rust secrets (hasPassword)', () => {
    const config = normalizeProxyConfig({
      enabled: true,
      toolsEnabled: true,
      url: 'http://127.0.0.1:7890',
      username: 'bob',
      hasPassword: true,
    });
    // The URL carries only the username; the backend injects the password.
    expect(effectiveProxyUrl(config)).toBe('http://bob@127.0.0.1:7890/');
  });

  it('keeps hasPassword false by default and normalizes it strictly', () => {
    expect(normalizeProxyConfig({}).hasPassword).toBe(false);
    expect(normalizeProxyConfig({ hasPassword: true }).hasPassword).toBe(true);
    expect(normalizeProxyConfig({ hasPassword: 'yes' as unknown as boolean }).hasPassword).toBe(false);
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
