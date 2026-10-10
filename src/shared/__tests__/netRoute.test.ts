// src/shared/__tests__/netRoute.test.ts
// 路由契约的两层语义：分类面只回答「谁是首选」，通用契约回答「有没有兜底」——
// 配了代理的远程主机一律有反向兜底，环回/内网一律没有。学习记忆按 host 归一
// （调用点传 URL 还是 host 都行）且带 30 分钟 TTL，过期回落分类。
// 每个测试用一个不重复的 host —— 学习表是模块状态，同一文件内刻意跨用例存活。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let netRoute: typeof import('../netRoute');

beforeAll(async () => {
  GlobalRegistrator.register();
  netRoute = await import('../netRoute');
});

beforeEach(() => {
  localStorage.removeItem('pure.netRoute.v1');
});

afterAll(() => GlobalRegistrator.unregister());

describe('classifyHost', () => {
  it('routes known-blocked foreign hosts proxy-first', () => {
    expect(netRoute.classifyHost('api.openai.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('claude.ai')).toBe('proxy-first');
    expect(netRoute.classifyHost('anthropic.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('huggingface.co')).toBe('proxy-first');
    expect(netRoute.classifyHost('openrouter.ai')).toBe('proxy-first');
  });

  it('covers the developer-infra hosts that are unusable direct in CN', () => {
    // 这一组是修 2 的核心：github / crates / jsdelivr 在大陆基本不通，
    // 旧名单（4 个 LLM 域名）把它们全判成 direct，于是无兜底也走不通。
    expect(netRoute.classifyHost('github.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('api.github.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('raw.githubusercontent.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('codeload.github.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('objects.githubusercontent.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('static.crates.io')).toBe('proxy-first');
    expect(netRoute.classifyHost('cdn.jsdelivr.net')).toBe('proxy-first');
    expect(netRoute.classifyHost('proxy.golang.org')).toBe('proxy-first');
    // 子域从父域规则继承：api.z.ai 不必单列。
    expect(netRoute.classifyHost('api.z.ai')).toBe('proxy-first');
  });

  it('keeps domestic sites and unknown hosts direct-first', () => {
    expect(netRoute.classifyHost('integrate.api.nvidia.com')).toBe('proxy-first');
    expect(netRoute.classifyHost('api.deepseek.com')).toBe('direct-first');
    expect(netRoute.classifyHost('open.bigmodel.cn')).toBe('direct-first');
    expect(netRoute.classifyHost('registry.npmmirror.com')).toBe('direct-first');
    expect(netRoute.classifyHost('hf-mirror.com')).toBe('direct-first');
    expect(netRoute.classifyHost('goproxy.cn')).toBe('direct-first');
    expect(netRoute.classifyHost('example.org')).toBe('direct-first');
    expect(netRoute.classifyHost('some-random-cn-site.cn')).toBe('direct-first');
  });

  it('matches suffixes only on a label boundary', () => {
    // 裸 endsWith 会让 evil-anthropic.com / notopenai.com 命中，是修 2 里
    // 「避免误命中」的具体要求。
    expect(netRoute.classifyHost('evil-anthropic.com')).toBe('direct-first');
    expect(netRoute.classifyHost('notopenai.com')).toBe('direct-first');
    expect(netRoute.classifyHost('huggingface.co.evil.net')).toBe('direct-first');
    expect(netRoute.classifyHost('evil.net/huggingface.co')).toBe('direct-first');
  });

  it('treats loopback / private / mDNS as neutral — never proxied', () => {
    expect(netRoute.classifyHost('localhost')).toBe('neutral');
    expect(netRoute.classifyHost('app.localhost:3000')).toBe('neutral');
    expect(netRoute.classifyHost('127.0.0.1')).toBe('neutral');
    expect(netRoute.classifyHost('192.168.1.10')).toBe('neutral');
    expect(netRoute.classifyHost('172.20.0.5')).toBe('neutral');
    expect(netRoute.classifyHost('10.1.2.3')).toBe('neutral');
    expect(netRoute.classifyHost('printer.local')).toBe('neutral');
    expect(netRoute.classifyHost('api.internal')).toBe('neutral');
  });

  it('accepts both a bare host and a full URL', () => {
    expect(netRoute.classifyHost('https://api.anthropic.com/v1/messages')).toBe('proxy-first');
    expect(netRoute.classifyHost('HTTP://API.OpenAI.COM')).toBe('proxy-first');
  });
});

describe('resolveNetRoute', () => {
  it('routes proxy-first hosts proxy-first when a proxy exists', () => {
    expect(netRoute.resolveNetRoute('api.openai.com', true)).toBe('proxy');
    expect(netRoute.resolveNetRoute('github.com', true)).toBe('proxy');
  });

  it('routes everything else direct-first', () => {
    expect(netRoute.resolveNetRoute('resolve-direct.test', true)).toBe('direct');
    expect(netRoute.resolveNetRoute('resolve-mirror.test', true)).toBe('direct');
  });

  it('never proxies neutral hosts and falls back to direct with no proxy', () => {
    expect(netRoute.resolveNetRoute('127.0.0.1', true)).toBe('direct');
    expect(netRoute.resolveNetRoute('api.openai.com', false)).toBe('direct');
  });

  it('honours a learned route over classification in both directions', () => {
    netRoute.recordNetOutcome('learned-proxy.test', 'proxy', true);
    expect(netRoute.resolveNetRoute('learned-proxy.test', true)).toBe('proxy');
    netRoute.recordNetOutcome('learned-direct.openai.com', 'direct', true);
    expect(netRoute.resolveNetRoute('learned-direct.openai.com', true)).toBe('direct');
  });

  it('a failure clears ONLY the route that failed', () => {
    netRoute.recordNetOutcome('keep-entry.test', 'proxy', true);
    netRoute.recordNetOutcome('keep-entry.test', 'direct', false);
    expect(netRoute.resolveNetRoute('keep-entry.test', true)).toBe('proxy');
    netRoute.recordNetOutcome('keep-entry.test', 'proxy', false);
    expect(netRoute.resolveNetRoute('keep-entry.test', true)).toBe('direct');
  });

  it('normalizes the key so a full URL and a bare host hit the SAME entry', () => {
    // 修 3：写入侧历史上传完整 URL、读取侧用 hostOf(url)，两边永不相等，
    // 学习表写的是死条目。
    netRoute.recordNetOutcome('https://github.com/anthropics/anthropic-cookbook', 'direct', true);
    expect(netRoute.resolveNetRoute('github.com', true)).toBe('direct');
    netRoute.recordNetOutcome('normalize.test', 'proxy', true);
    expect(netRoute.resolveNetRoute('https://normalize.test/some/path', true)).toBe('proxy');
  });

  it('drops a port so :443 and plain hosts share one learned entry', () => {
    netRoute.recordNetOutcome('port-norm.test:8443', 'direct', true);
    expect(netRoute.resolveNetRoute('port-norm.test', true)).toBe('direct');
  });

  it('never learns a neutral host', () => {
    netRoute.recordNetOutcome('localhost', 'proxy', true);
    expect(netRoute.resolveNetRoute('localhost', true)).toBe('direct');
  });

  it('expires a learned route after the TTL and falls back to classification', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('ttl-host.test', 'proxy', true, t0);
    expect(netRoute.resolveNetRoute('ttl-host.test', true, t0)).toBe('proxy');
    // TTL 内：记忆仍然有效。
    expect(netRoute.resolveNetRoute('ttl-host.test', true, t0 + netRoute.LEARNED_ROUTE_TTL_MS - 1)).toBe('proxy');
    // TTL 之后：回落分类（该 host 分类为 direct-first）。
    expect(netRoute.resolveNetRoute('ttl-host.test', true, t0 + netRoute.LEARNED_ROUTE_TTL_MS + 1)).toBe('direct');
  });

  // 上一条用 LEARNED_ROUTE_TTL_MS 自身构造时间偏移，于是 TTL 被改成 0 时它
  // 依然自洽通过——测试与实现共用同一个数，锚不住「TTL 整体失效」。这里用
  // 字面时长把 TTL 的取值本身钉住：学习记忆的价值是「短期内省掉重试」，
  // TTL 归零等于这个机制不存在；TTL 过长则切了网络环境也照样用旧判断。
  it('anchors the TTL to a literal window, not to whatever the constant is', () => {
    expect(netRoute.LEARNED_ROUTE_TTL_MS).toBe(30 * 60_000);

    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('ttl-window.test', 'proxy', true, t0);
    expect(netRoute.resolveNetRoute('ttl-window.test', true, t0 + 29 * 60_000)).toBe('proxy');
    expect(netRoute.resolveNetRoute('ttl-window.test', true, t0 + 31 * 60_000)).toBe('direct');
  });

  it('never expires a proxy-first classification — only the memory has a TTL', () => {
    const t0 = 1_700_000_000_000;
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 10 * netRoute.LEARNED_ROUTE_TTL_MS)).toBe('proxy');
  });

  it('persists learned routes to localStorage', () => {
    netRoute.recordNetOutcome('persist-write.test', 'proxy', true);
    const raw = localStorage.getItem('pure.netRoute.v1');
    expect(raw).toContain('persist-write.test');
    expect(JSON.parse(raw ?? '{}')['persist-write.test']?.route).toBe('proxy');
    localStorage.removeItem('pure.netRoute.v1');
  });
});

describe('netRouteProxyPair', () => {
  it('proxy-first hosts get the proxy as primary and DIRECT as fallback', () => {
    const pair = netRoute.netRouteProxyPair('https://api.openai.com/v1', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('http://127.0.0.1:7890');
    expect(pair.fallbackProxyUrl).toBe('');
    expect(pair.host).toBe('api.openai.com');
  });

  it('direct-first hosts go direct first with the proxy as one-shot fallback', () => {
    // 用一个别的测试文件绝不会碰的 host：学习表是模块状态，bun 在同一进程里
    // 跑完 src/ui 的适配器测试后再跑这里，example.org 可能已经被学成 proxy。
    const pair = netRoute.netRouteProxyPair('https://direct-first-pair.test/x', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBe('http://127.0.0.1:7890');
    expect(pair.host).toBe('direct-first-pair.test');
  });

  it('gives EVERY remote host a fallback when a proxy is configured', () => {
    // 修 2 的核心断言：名单只决定谁是首选，不决定有没有兜底。
    for (const url of ['https://github.com/x', 'https://crates.io/api', 'https://registry.npmmirror.com/x', 'https://unknown-vendor-gateway.example/v1']) {
      const pair = netRoute.netRouteProxyPair(url, 'http://127.0.0.1:7890');
      expect(pair.fallbackProxyUrl).not.toBeNull();
    }
  });

  it('never proxies a neutral host and gives it no fallback either', () => {
    const pair = netRoute.netRouteProxyPair('http://127.0.0.1:5173/api', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBeNull();
    expect(pair.host).toBe('127.0.0.1');
  });

  it('without a proxy there is no fallback and no route decision at all', () => {
    const pair = netRoute.netRouteProxyPair('https://api.openai.com/v1', '');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBeNull();
    expect(pair.host).toBeNull();
  });

  it('the two legs are always opposite routes, never the same one twice', () => {
    for (const url of ['https://github.com/x', 'https://leg-opposite.test/x']) {
      const pair = netRoute.netRouteProxyPair(url, 'http://127.0.0.1:7890');
      expect(Boolean(pair.proxyUrl)).toBe(!Boolean(pair.fallbackProxyUrl));
    }
  });
});

describe('netRouteSurfacePair (无单一目标 host 的出口)', () => {
  it('gives retryable surfaces both legs — a primary AND an opposite fallback', () => {
    // 只断言结构，不断言「首选是直连」：web_search 面可能被同进程里更早的
    // 适配器测试学成 proxy-first（那是学习在起作用，不是契约被破坏）。
    for (const surface of ['web_search', 'web_public_api', 'image'] as const) {
      const pair = netRoute.netRouteSurfacePair(surface, 'http://127.0.0.1:7890');
      expect(Boolean(pair.proxyUrl)).toBe(!Boolean(pair.fallbackProxyUrl));
    }
  });

  it('a fresh retryable surface is direct-first with the proxy as fallback', () => {
    // 用一个没被任何测试写过的面验证默认值，再自己把它写回 direct-first，
    // 免得污染后续断言。
    netRoute.recordNetSurfaceOutcome('image', 'direct', true);
    const pair = netRoute.netRouteSurfacePair('image', 'http://127.0.0.1:7890');
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('gives non-retryable surfaces a primary route but NO fallback', () => {
    // command / mcp 会把代理注入子进程，换路重跑是有害的，所以没有兜底。
    for (const surface of ['command', 'mcp'] as const) {
      const pair = netRoute.netRouteSurfacePair(surface, 'http://127.0.0.1:7890');
      expect(pair.proxyUrl).toBe('http://127.0.0.1:7890');
      expect(pair.fallbackProxyUrl).toBeNull();
    }
  });

  it('learns a surface route from a real outcome', () => {
    netRoute.recordNetSurfaceOutcome('web_search', 'proxy', true);
    expect(netRoute.netRouteSurfacePair('web_search', 'http://127.0.0.1:7890').proxyUrl).toBe('http://127.0.0.1:7890');
    // 失败把记忆清掉，回到分类面（直连优先）。
    netRoute.recordNetSurfaceOutcome('web_search', 'proxy', false);
    expect(netRoute.netRouteSurfacePair('web_search', 'http://127.0.0.1:7890').proxyUrl).toBe('');
  });

  it('with no proxy configured every surface is direct with no fallback', () => {
    expect(netRoute.netRouteSurfacePair('command', '')).toEqual({ proxyUrl: '', fallbackProxyUrl: null });
    expect(netRoute.netRouteSurfacePair('web_search', '')).toEqual({ proxyUrl: '', fallbackProxyUrl: null });
  });
});

describe('unblockAttemptsBeforeMirror（打通路径的 75% 预算）', () => {
  const PROXY = 'http://127.0.0.1:7890';

  it('预算 = ceil(4 × 0.75) = 3：只试前三步就切镜像', () => {
    expect(netRoute.UNBLOCK_ATTEMPT_STEPS).toBe(4);
    expect(netRoute.MIRROR_AFTER_ATTEMPTS).toBe(3);
  });

  it('直连优先主机：直连 → 代理 → 直连重试（第四步反向重试被 75% 预算切掉）', () => {
    const plan = netRoute.unblockAttemptsBeforeMirror('https://direct-first-plan.test/x', PROXY);
    expect(plan.map((a) => a.proxyUrl)).toEqual(['', PROXY, '']);
    expect(plan.map((a) => a.route)).toEqual(['direct', 'proxy', 'direct']);
    expect(plan.map((a) => a.retry)).toEqual([false, false, true]);
    // 完整枚举确实是四步（第四个是这个主机的反向重试）。
    expect(netRoute.unblockAttemptPlan('https://direct-first-plan.test/x', PROXY)).toHaveLength(4);
  });

  it('代理优先主机：代理 → 直连 → 代理重试', () => {
    // 用未被本文件其他用例记过学习结果的 host（学习表是模块状态、跨用例存活）。
    const plan = netRoute.unblockAttemptsBeforeMirror('https://together.ai/x', PROXY);
    expect(plan.map((a) => a.proxyUrl)).toEqual([PROXY, '', PROXY]);
    expect(plan.map((a) => a.route)).toEqual(['proxy', 'direct', 'proxy']);
  });

  it('没配代理、或目标为环回/私网：只有一次直连，不凭空造出反向', () => {
    expect(netRoute.unblockAttemptsBeforeMirror('https://no-proxy-plan.test/x', '')).toEqual([
      { route: 'direct', proxyUrl: '', retry: false },
    ]);
    expect(netRoute.unblockAttemptsBeforeMirror('http://127.0.0.1:5173/api', PROXY)).toEqual([
      { route: 'direct', proxyUrl: '', retry: false },
    ]);
  });

  it('已学习首选路时，枚举跟随学习结果翻面', () => {
    netRoute.recordNetOutcome('learned-plan.test', 'proxy', true);
    const plan = netRoute.unblockAttemptsBeforeMirror('https://learned-plan.test/x', PROXY);
    expect(plan.map((a) => a.proxyUrl)).toEqual([PROXY, '', PROXY]);
  });
});