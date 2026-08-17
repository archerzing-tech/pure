import { describe, expect, it } from 'bun:test';
import { composeProxyUrl, effectiveProxyUrl, normalizeProxyConfig, normalizeProxyList, parseProxyUrl, proxyUrlWithAuth, shouldBypassProxy } from '../proxy';

describe('proxy address split/compose', () => {
  it('splits a full URL into scheme, host, and port', () => {
    expect(parseProxyUrl('http://127.0.0.1:7890')).toEqual({ scheme: 'http://', host: '127.0.0.1', port: '7890' });
    expect(parseProxyUrl('socks5://proxy.example.com:1080')).toEqual({ scheme: 'socks5://', host: 'proxy.example.com', port: '1080' });
    expect(parseProxyUrl('https://10.0.0.1:443')).toEqual({ scheme: 'https://', host: '10.0.0.1', port: '443' });
  });

  it('accepts the scheme-less host:port shorthand', () => {
    expect(parseProxyUrl('127.0.0.1:7890')).toEqual({ scheme: 'http://', host: '127.0.0.1', port: '7890' });
  });

  it('strips embedded credentials and empty input defaults to http', () => {
    expect(parseProxyUrl('http://bob:p%40ss@127.0.0.1:7890')).toEqual({ scheme: 'http://', host: '127.0.0.1', port: '7890' });
    expect(parseProxyUrl('')).toEqual({ scheme: 'http://', host: '', port: '' });
  });

  it('composes scheme, host, and port into a stored URL', () => {
    expect(composeProxyUrl('http://', '127.0.0.1', '7890')).toBe('http://127.0.0.1:7890');
    expect(composeProxyUrl('socks5://', 'proxy.example.com', '1080')).toBe('socks5://proxy.example.com:1080');
    expect(composeProxyUrl('', '127.0.0.1', '7890')).toBe('http://127.0.0.1:7890');
    // Nothing configured stays empty — a bare scheme must not be persisted.
    expect(composeProxyUrl('', '', '')).toBe('');
    expect(composeProxyUrl('socks5://', '', '1080')).toBe('');
  });

  it('pulls a port pasted into the host field and strips a pasted scheme', () => {
    expect(composeProxyUrl('http://', '192.168.1.5:7890', '')).toBe('http://192.168.1.5:7890');
    expect(composeProxyUrl('http://', 'http://10.0.0.2:8080', '')).toBe('http://10.0.0.2:8080');
    expect(composeProxyUrl('http://', 'bob@127.0.0.1', '7890')).toBe('http://127.0.0.1:7890');
  });

  it('round-trips through parse and compose', () => {
    for (const url of ['http://127.0.0.1:7890', 'socks5://proxy.example.com:1080', 'https://10.0.0.1:443']) {
      const { scheme, host, port } = parseProxyUrl(url);
      expect(composeProxyUrl(scheme, host, port)).toBe(url);
    }
  });
});

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
