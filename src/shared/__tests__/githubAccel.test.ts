// GitHub 下载加速的共享层：回退链是「下载不死」的唯一保证，所以这里锁的是
// 顺序与边界，而不是某个镜像当前能不能通（网络事实由设置页测速回答）。

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_GITHUB_MIRROR,
  GITHUB_MIRRORS,
  MIRROR_HEALTH_TTL_MS,
  githubAllPathsDeadNotice,
  githubAutoMirrorFirst,
  githubDownloadAttempts,
  githubFallbackPrefixes,
  githubMirrorLadderPrefixes,
  githubMirrorPrefix,
  githubProbeEntries,
  isGithubDownloadUrl,
  mirrorIsDead,
  recordMirrorOutcome,
  resetMirrorHealth,
  unwrapGithubMirrorUrl,
  latencyBucket,
  normalizeGithubMirrorKey,
  normalizeGithubMirrorPrefix,
  probeGithubMirrorLatency,
  withGithubMirrorPrefix,
} from '../githubAccel';
import { recordNetOutcome, resetLearnedRoutes } from '../netRoute';

const PUBLIC_PREFIXES = GITHUB_MIRRORS
  .filter((m) => m.key !== 'custom' && m.key !== 'direct' && m.key !== 'auto')
  .map((m) => m.prefix);

describe('GitHub 加速 · 节点与前缀', () => {
  it('默认智能：auto 是默认值，未知 key 也回落到它', () => {
    expect(DEFAULT_GITHUB_MIRROR).toBe('auto');
    expect(normalizeGithubMirrorKey('')).toBe('auto');
    expect(normalizeGithubMirrorKey('nope')).toBe('auto');
    expect(normalizeGithubMirrorKey(' GHFAST ')).toBe('ghfast');
    expect(normalizeGithubMirrorKey('direct')).toBe('direct');
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

  it('解包：已知前缀（公共 + 自定义）还原原 URL，陌生前缀与尾巴非 GitHub 面一律不解', () => {
    const raw = 'https://github.com/o/r/releases/download/v1/a.zip';
    expect(unwrapGithubMirrorUrl(`https://ghfast.top/${raw}`)).toEqual({
      original: raw,
      prefix: 'https://ghfast.top',
      mirrorKey: 'ghfast',
    });
    expect(unwrapGithubMirrorUrl(`https://mirror.example.com/gh/${raw}`, 'https://mirror.example.com/gh')).toEqual({
      original: raw,
      prefix: 'https://mirror.example.com/gh',
      mirrorKey: 'custom',
    });
    // 陌生前缀不解——把任意 host 当镜像剥壳等于给劫持页洗白。
    expect(unwrapGithubMirrorUrl(`https://evil.example/${raw}`)).toBeNull();
    // 尾巴不是 GitHub 下载面也不解。
    expect(unwrapGithubMirrorUrl('https://ghfast.top/https://example.com/a.zip')).toBeNull();
    expect(unwrapGithubMirrorUrl(raw)).toBeNull();
    expect(unwrapGithubMirrorUrl('')).toBeNull();
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
    // auto 的候选链与显式节点同形：镜像档 + 直连尾（顺序由调用方的先行判定决定）。
    expect(githubDownloadAttempts(raw, 'auto').length).toBe(PUBLIC_PREFIXES.length + 1);

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

  it('测速候选包含公共节点 + 自定义（有效时）+ 直连，auto 不在列（它是决策不是链路）', () => {
    const base = githubProbeEntries('');
    expect(base.map((e) => e.key)).toEqual([...GITHUB_MIRRORS.filter((m) => m.key !== 'custom' && m.key !== 'direct' && m.key !== 'auto').map((m) => m.key), 'direct']);
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

describe('GitHub 加速 · 节点健康缓存（全灭处理）', () => {
  beforeEach(() => {
    // 用例间互不污染（同文件其他组也会驱动真实记账路径）。
    resetMirrorHealth();
  });

  it('记账后 TTL 内判死，过期后自动复活', () => {
    recordMirrorOutcome('ghfast', false, 'connect timeout');
    expect(mirrorIsDead('ghfast')).toBe(true);
    // TTL 边界内仍判死。
    expect(mirrorIsDead('ghfast', Date.now() + 4 * 60_000)).toBe(true);
    // 过 TTL 复活：节点恢复后自然重新入选，不需要手动刷新。
    expect(mirrorIsDead('ghfast', Date.now() + MIRROR_HEALTH_TTL_MS + 1_000)).toBe(false);
  });

  it('成功记账清除死亡标记，direct 与空 key 不参与记账', () => {
    recordMirrorOutcome('gh-proxy', false);
    expect(mirrorIsDead('gh-proxy')).toBe(true);
    recordMirrorOutcome('gh-proxy', true);
    expect(mirrorIsDead('gh-proxy')).toBe(false);
    // direct 不是加速节点：记录无操作，读出来永远不是「已知死亡」。
    recordMirrorOutcome('direct', false);
    expect(mirrorIsDead('direct')).toBe(false);
    recordMirrorOutcome('', false);
    expect(mirrorIsDead('')).toBe(false);
  });

  it('全灭聚合消息列出打过的、跳过的、直连错误和出口建议', () => {
    const notice = githubAllPathsDeadNotice(
      [{ label: 'ghfast.top', error: 'connection timeout' }, { label: 'gh-proxy.com' }],
      ['ghproxy.net'],
      'connection reset by peer',
    );
    expect(notice).toContain('所有路径均不可用');
    expect(notice).toContain('- 加速节点 ghfast.top：connection timeout');
    // 缺错误文本时落到「失败」占位，不出 undefined。
    expect(notice).toContain('- 加速节点 gh-proxy.com：失败');
    expect(notice).toContain('- 加速节点 ghproxy.net：近期已失败，本次跳过');
    expect(notice).toContain('- 直连：connection reset by peer');
    expect(notice).toContain('设置 → 网络代理');
    expect(notice).toContain('手动下载');
  });
});

describe('GitHub 加速 · auto 模式（证据先行，不读静态分类）', () => {
  const scrub = (): void => {
    resetLearnedRoutes();
    resetMirrorHealth();
    // resetLearnedRoutes 只清内存并置 loaded=false：若前序测试文件留下了
    // 全局 localStorage（GlobalRegistrator 未注销），下一次 ensureLoaded 会
    // 把档里陈旧的 github.com 记录拉回来翻面断言——持久档一并清掉。
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem('pure.netRoute.v1');
    } catch { /* 无存储环境照常 */ }
  };
  beforeEach(scrub);
  // 路由学习是模块级单例：本组写入的结局不清掉，会翻面后续文件里的
  // resolveNetRoute / 下载链断言（2026-10-26 download_file 镜像测试踩中过）。
  afterEach(scrub);

  it('无证据直连先行；直连实测失败后镜像先行；死期过期自动回到直连重探', () => {
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    expect(githubAutoMirrorFirst(url)).toBe(false);
    recordNetOutcome(url, 'direct', false);
    expect(githubAutoMirrorFirst(url)).toBe(true);
    // 5 分钟死期内镜像先行，死期一过重探直连（恢复即走直连，成本一次探路）。
    expect(githubAutoMirrorFirst(url, Date.now() + 4 * 60_000)).toBe(true);
    expect(githubAutoMirrorFirst(url, Date.now() + 6 * 60_000)).toBe(false);
  });

  it('直连成功与代理路失败都不是镜像先行的证据', () => {
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    recordNetOutcome(url, 'direct', true);
    expect(githubAutoMirrorFirst(url)).toBe(false);
    // 代理路死不是直连死的证据：下一轮打通预算会自己落到直连。
    recordNetOutcome(url, 'proxy', false);
    expect(githubAutoMirrorFirst(url)).toBe(false);
  });

  it('两条路先后死光：尸检报告允许被最新死因覆盖，direct 的死能被读到', () => {
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    recordNetOutcome(url, 'proxy', false);
    recordNetOutcome(url, 'direct', false);
    expect(githubAutoMirrorFirst(url)).toBe(true);
  });

  it('hub 镜像档：auto 只在直连死时给链；显式节点恒给；显式 direct 恒空', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/SKILL.md';
    expect(githubMirrorLadderPrefixes(raw, 'direct')).toEqual([]);
    expect(githubMirrorLadderPrefixes(raw, 'ghfast')).toEqual(githubFallbackPrefixes('ghfast'));
    expect(githubMirrorLadderPrefixes(raw, 'auto')).toEqual([]);
    recordNetOutcome(raw, 'direct', false);
    expect(githubMirrorLadderPrefixes(raw, 'auto')).toEqual(githubFallbackPrefixes('auto'));
  });
});
