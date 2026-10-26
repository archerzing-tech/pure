// GitHub 下载加速的共享层：回退链是「下载不死」的唯一保证，所以这里锁的是
// 顺序与边界，而不是某个镜像当前能不能通（网络事实由设置页测速回答）。

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_GITHUB_MIRROR,
  GITHUB_MIRRORS,
  githubDownloadAttempts,
  githubFallbackPrefixes,
  githubMirrorPrefix,
  githubProbeEntries,
  isGithubDownloadUrl,
  latencyBucket,
  normalizeGithubMirrorKey,
  normalizeGithubMirrorPrefix,
  probeGithubMirrorLatency,
  withGithubMirrorPrefix,
} from '../githubAccel';

const PUBLIC_PREFIXES = GITHUB_MIRRORS
  .filter((m) => m.key !== 'custom' && m.key !== 'direct')
  .map((m) => m.prefix);

describe('GitHub 加速 · 节点与前缀', () => {
  it('默认关闭：direct 是默认值，未知 key 也回落到它', () => {
    expect(DEFAULT_GITHUB_MIRROR).toBe('direct');
    expect(normalizeGithubMirrorKey('')).toBe('direct');
    expect(normalizeGithubMirrorKey('nope')).toBe('direct');
    expect(normalizeGithubMirrorKey(' GHFAST ')).toBe('ghfast');
  });

  it('自定义前缀补 scheme、去尾斜杠，非 http(s) 判无效', () => {
    expect(normalizeGithubMirrorPrefix('gh.example.com/gh/')).toBe('https://gh.example.com/gh');
    expect(normalizeGithubMirrorPrefix('http://proxy.local:8080')).toBe('http://proxy.local:8080');
    expect(normalizeGithubMirrorPrefix('  ')).toBe('');
    expect(normalizeGithubMirrorPrefix('ftp://mirror.example.com')).toBe('');
  });

  it('选中的节点永远排第一，其余公共节点按声明顺序，直连收尾', () => {
    const chain = githubFallbackPrefixes('ghproxy-net');
    expect(chain[0]).toBe('https://ghproxy.net');
    expect(chain.at(-1)).toBe('');
    // 其余公共节点一个不少、顺序不变。
    const rest = chain.slice(1, -1);
    expect(rest).toEqual(PUBLIC_PREFIXES.filter((p) => p !== 'https://ghproxy.net'));
    // 无重复。
    expect(new Set(chain).size).toBe(chain.length);
  });

  it('direct = 只有直连一级，不做任何镜像尝试', () => {
    expect(githubFallbackPrefixes('direct')).toEqual(['']);
    expect(githubMirrorPrefix('direct', 'https://x.example.com')).toBe('');
  });

  it('自定义节点排在第一位；地址非法时退化为直连，绝不拿公共节点顶替', () => {
    const chain = githubFallbackPrefixes('custom', 'my-gh.example.com');
    expect(chain[0]).toBe('https://my-gh.example.com');
    expect(chain.at(-1)).toBe('');
    expect(githubFallbackPrefixes('custom', '')).toEqual(['']);
    expect(githubFallbackPrefixes('custom', 'not a url')).toEqual(['']);
  });

  it('前缀拼法是「前缀 + 原 URL」，且不重复拼已经代理过的地址', () => {
    const raw = 'https://github.com/o/r/releases/download/v1/a.zip';
    expect(withGithubMirrorPrefix('https://ghfast.top', raw)).toBe(`https://ghfast.top/${raw}`);
    expect(withGithubMirrorPrefix('', raw)).toBe(raw);
    const prefixed = `https://ghfast.top/${raw}`;
    expect(withGithubMirrorPrefix('https://ghfast.top/', prefixed)).toBe(prefixed);
    // 回退链不套娃。
    expect(githubDownloadAttempts(prefixed, 'ghfast')).toEqual([]);
  });
});

describe('GitHub 加速 · 可加速面与候选链', () => {
  it('只接 GitHub 公开下载面，不接 api.github.com 与非 GitHub 地址', () => {
    expect(isGithubDownloadUrl('https://github.com/o/r/releases/download/v1/a.zip')).toBe(true);
    expect(isGithubDownloadUrl('https://raw.githubusercontent.com/o/r/main/SKILL.md')).toBe(true);
    expect(isGithubDownloadUrl('https://codeload.github.com/o/r/zip/refs/heads/main')).toBe(true);
    expect(isGithubDownloadUrl('https://api.github.com/repos/o/r/contents')).toBe(false);
    expect(isGithubDownloadUrl('https://example.com/a.zip')).toBe(false);
    expect(isGithubDownloadUrl('not a url')).toBe(false);
  });

  it('加速关闭时没有候选（调用方保持原路径），打开后按回退链展开', () => {
    const raw = 'https://github.com/o/r/releases/download/v1/a.zip';
    expect(githubDownloadAttempts(raw, 'direct')).toEqual([]);
    expect(githubDownloadAttempts('https://example.com/a.zip', 'ghfast')).toEqual([]);

    const attempts = githubDownloadAttempts(raw, 'ghfast');
    expect(attempts.length).toBe(PUBLIC_PREFIXES.length + 1);
    expect(attempts[0]).toEqual({
      url: `https://ghfast.top/${raw}`,
      prefix: 'https://ghfast.top',
      mirrorKey: 'ghfast',
      label: 'GHFast',
    });
    expect(attempts.at(-1)).toEqual({ url: raw, prefix: '', mirrorKey: 'direct', label: '直连' });
  });

  it('自定义节点把原 URL 拼到自己的前缀后面', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/SKILL.md';
    const attempts = githubDownloadAttempts(raw, 'custom', 'https://mirror.example.com/gh');
    expect(attempts[0]?.url).toBe(`https://mirror.example.com/gh/${raw}`);
    expect(attempts[0]?.mirrorKey).toBe('custom');
  });

  it('测速候选包含公共节点 + 自定义（有效时）+ 直连', () => {
    const base = githubProbeEntries('');
    expect(base.map((e) => e.key)).toEqual([...GITHUB_MIRRORS.filter((m) => m.key !== 'custom' && m.key !== 'direct').map((m) => m.key), 'direct']);
    const withCustom = githubProbeEntries('mirror.example.com');
    expect(withCustom.some((e) => e.key === 'custom' && e.prefix === 'https://mirror.example.com')).toBe(true);
  });
});

describe('GitHub 加速 · 测速判定', () => {
  it('绿/黄/红/不可达四档：任何 HTTP 应答都算通', () => {
    expect(latencyBucket(300, true)).toBe('good');
    expect(latencyBucket(2500, true)).toBe('warn');
    expect(latencyBucket(9000, true)).toBe('bad');
    expect(latencyBucket(0, false)).toBe('dead');
  });

  it('单一节点测速用 HEAD，把 401/403 当可达，网络异常才判死', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const ok = await probeGithubMirrorLatency('https://ghfast.top', {
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        return new Response(null, { status: 403 });
      }) as unknown as typeof fetch,
    });
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(403);
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.url.startsWith('https://ghfast.top/https://github.com/')).toBe(true);

    const dead = await probeGithubMirrorLatency('https://ghfast.top', {
      fetchImpl: (async () => { throw new Error('connect timeout'); }) as unknown as typeof fetch,
    });
    expect(dead.ok).toBe(false);
    expect(dead.error).toContain('connect timeout');
  });
});
