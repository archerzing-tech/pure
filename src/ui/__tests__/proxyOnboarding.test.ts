// src/ui/__tests__/proxyOnboarding.test.ts
// 首启代理引导的判定与配置换算纯函数：什么时候弹、探测结果换成哪种配置形态。

import { describe, expect, it } from 'bun:test';
import {
  shouldOfferProxyOnboarding,
  proxyConfigPatchFromDetection,
  type DetectedProxyInfo,
  type ProxyOnboardingInput,
} from '../proxyOnboarding';
import { normalizeProxyConfig, type ProxyConfig } from '../../shared/proxy';

function detection(over: Partial<DetectedProxyInfo> = {}): DetectedProxyInfo {
  return { scheme: 'http://', host: '127.0.0.1', port: '7897', source: 'macos', detail: '', ...over };
}

function input(over: Partial<ProxyOnboardingInput> = {}): ProxyOnboardingInput {
  return {
    isDesktop: true,
    proxyEnabled: false,
    detection: detection(),
    askedThisLaunch: false,
    ...over,
  };
}

describe('shouldOfferProxyOnboarding', () => {
  it('四条件全满足才弹（桌面端 + 代理未启用 + 未问过 + 探测到代理）', () => {
    expect(shouldOfferProxyOnboarding(input())).toBe(true);
  });

  it('本次启动已经问过（弹过卡或点过「这次不用」）不再问', () => {
    expect(shouldOfferProxyOnboarding(input({ askedThisLaunch: true }))).toBe(false);
  });

  it('应用内代理已启用就不多嘴', () => {
    expect(shouldOfferProxyOnboarding(input({ proxyEnabled: true }))).toBe(false);
  });

  it('没探到任何代理不弹', () => {
    expect(shouldOfferProxyOnboarding(input({ detection: null }))).toBe(false);
  });

  it('浏览器模式不弹（读不到 OS 代理，弹也是空手）', () => {
    expect(shouldOfferProxyOnboarding(input({ isDesktop: false }))).toBe(false);
  });

  it('env / 本地端口来源一样弹——引导卡是用户拍板，不要求 OS 级可信', () => {
    expect(shouldOfferProxyOnboarding(input({ detection: detection({ source: 'env' }) }))).toBe(true);
    expect(shouldOfferProxyOnboarding(input({ detection: detection({ source: 'local' }) }))).toBe(true);
  });

  it('探测结果缺 host（写不出可用配置）不弹', () => {
    expect(shouldOfferProxyOnboarding(input({ detection: detection({ host: '' }) }))).toBe(false);
  });
});

describe('proxyConfigPatchFromDetection', () => {
  it('OS 级来源（macos）走 system 形态，不写死地址', () => {
    const patch = proxyConfigPatchFromDetection(detection({ source: 'macos' }));
    expect(patch.enabled).toBe(true);
    expect(patch.mode).toBe('system');
    expect(patch).not.toHaveProperty('url');
  });

  it('OS 级来源（windows）同样走 system 形态', () => {
    expect(proxyConfigPatchFromDetection(detection({ source: 'windows' })).mode).toBe('system');
  });

  it('env 来源走 manual，url 由 scheme/host/port 拼出', () => {
    const patch = proxyConfigPatchFromDetection(detection({ source: 'env', scheme: 'http://', host: '127.0.0.1', port: '7890' }));
    expect(patch.enabled).toBe(true);
    expect(patch.mode).toBe('manual');
    expect(patch.url).toBe('http://127.0.0.1:7890');
  });

  it('本地端口探活的 socks5 结果保留 scheme', () => {
    const patch = proxyConfigPatchFromDetection(detection({ source: 'local', scheme: 'socks5://', host: '127.0.0.1', port: '7897' }));
    expect(patch.mode).toBe('manual');
    expect(patch.url).toBe('socks5://127.0.0.1:7897');
  });

  it('补丁与现有配置合并 normalize 后可直接落盘：凭据等字段原样保留', () => {
    const existing: ProxyConfig = normalizeProxyConfig({
      url: '',
      username: 'alice',
      bypassProviders: ['ollama'],
    });
    const merged = normalizeProxyConfig({
      ...existing,
      ...proxyConfigPatchFromDetection(detection({ source: 'macos' })),
    });
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe('system');
    expect(merged.username).toBe('alice');
    expect(merged.bypassProviders).toEqual(['ollama']);
  });

  it('env 补丁合并后 enabled + manual + 具体地址', () => {
    const existing = normalizeProxyConfig({ mode: 'system' });
    const merged = normalizeProxyConfig({
      ...existing,
      ...proxyConfigPatchFromDetection(detection({ source: 'env', scheme: 'http://', host: '10.0.0.2', port: '3128' })),
    });
    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe('manual');
    expect(merged.url).toBe('http://10.0.0.2:3128');
  });
});
