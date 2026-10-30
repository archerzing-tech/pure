// src/shared/__tests__/netRoute.test.ts
// 路由契约的两层语义：分类面只回答「谁是首选」，通用契约回答「有没有兜底」——
// 配了代理的远程主机一律有反向兜底，环回/内网一律没有。学习记忆按 host 归一
// （调用点传 URL 还是 host 都行）且带 30 分钟 TTL，过期回落分类。
// 每个测试用一个不重复的 host；学习表在**单个用例内**刻意存活供断言，用例间
// 由 beforeEach 清空——跨文件的下载类测试会写入 github.com 等真实 host 的记录，
// 不清空会把这里的分类断言翻面（见 resetLearnedRoutes）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let netRoute: typeof import('../netRoute');

beforeAll(async () => {
  GlobalRegistrator.register();
  netRoute = await import('../netRoute');
});

beforeEach(() => {
  localStorage.removeItem('pure.netRoute.v1');
  // 学习表是模块级单例：同文件其他用例刻意让它存活，但跨文件的下载类测试
  // 会写入 github.com 等真实 host 的记录，把这里的分类断言翻面。每个用例
  // 前清空内存记忆（文件头「跨用例存活」的语义由各用例自行构造，不依赖
  // 前一个用例的残留）。
  netRoute?.resetLearnedRoutes();
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

  it('a failure leaves a dead-route signal that flips the next picks, not just an erased memory', () => {
    // 2026-10-29 真机判例：z.ai（proxy-first）首选代理首连失败、直连兜底
    // 慢通（>4s 不钉），只删记忆让分类面下一轮照样选代理——每个请求重演
    // 一次「这条路不通，换条线路再试」。死路半边补上「别再选它」的信号。
    const t0 = 1_700_000_000_000;
    // 无记忆 + 首选失败：死路信号是这次失败能学到的全部。
    netRoute.recordNetOutcome('dead-flip.openai.com', 'proxy', false, t0);
    expect(netRoute.resolveNetRoute('dead-flip.openai.com', true, t0 + 1)).toBe('direct');
    expect(netRoute.resolveNetRoute('dead-flip.openai.com', true, t0 + netRoute.DEAD_ROUTE_TTL_MS - 1)).toBe('direct');
    // 死期过后照常重探：回落分类首选（proxy-first → proxy）。
    expect(netRoute.resolveNetRoute('dead-flip.openai.com', true, t0 + netRoute.DEAD_ROUTE_TTL_MS + 1)).toBe('proxy');
  });

  it('anchors DEAD_ROUTE_TTL_MS to a literal 5-minute window', () => {
    expect(netRoute.DEAD_ROUTE_TTL_MS).toBe(5 * 60_000);
  });

  it('a pinned opposite memory survives a failure of the other route', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('pin-guard.test', 'direct', true, t0);
    netRoute.recordNetOutcome('pin-guard.test', 'proxy', false, t0 + 1);
    // 钉着的 direct 是活路证据，不被 proxy 的死路信号覆盖。
    expect(netRoute.resolveNetRoute('pin-guard.test', true, t0 + 2)).toBe('direct');
  });

  it('normalizes the key so a full URL and a bare host hit the SAME entry', () => {
    // 修 3：写入侧历史上传完整 URL、读取侧用 hostOf(url)，两边永不相等，
    // 学习表写的是死条目。用一次性 host：学习表是进程级模块状态（CI 上跨
    // 测试文件共享），不能把 github.com 这种知名主机学成 direct 污染别人。
    netRoute.recordNetOutcome('https://norm-url.test/anthropic-cookbook', 'direct', true);
    expect(netRoute.resolveNetRoute('norm-url.test', true)).toBe('direct');
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

  // 慢直连判据（2026-10-20）：响应头耗时只含 TCP+TLS+代理协商，不受模型
  // prefill/思考污染。proxy-first 主机的直连「连上了但头爬了秒级」不是可用
  // 性证据——此前它照样把 direct 钉 30 分钟，下一轮继续爬。
  it('does not pin direct after a slow-headers success on a proxy-first host', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0, 5000);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1)).toBe('proxy');
  });

  it('unpins an existing direct memory when a slow-headers direct success arrives', () => {
    const t0 = 1_700_000_000_000;
    // 先有一次快速成功把 direct 钉上，随后一次慢成功把它清掉，分类翻回代理。
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0, 200);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1)).toBe('direct');
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0 + 2, 6000);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 3)).toBe('proxy');
  });

  it('leaves direct-first hosts alone: slow domestic successes are normal, not evidence', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('api.deepseek.com', 'direct', true, t0, 6000);
    expect(netRoute.resolveNetRoute('api.deepseek.com', true, t0 + 1)).toBe('direct');
  });

  it('still pins fast successes and proxy-route successes regardless of header timing', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0, 300);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1)).toBe('direct');
    // 慢头时间只对 direct 路线有判据意义——代理路线慢说明代理本身排队，
    // 但那是唯一出国通道，照旧钉住。
    netRoute.recordNetOutcome('relay2-openai.test', 'proxy', true, t0, 9000);
    expect(netRoute.resolveNetRoute('relay2-openai.test', true, t0 + 1)).toBe('proxy');
  });

  it('ignores the slow-direct criterion when headersMs is absent (old callers)', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1)).toBe('direct');
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

// ── 期2 路由脑：代理健康行 ────────────────────────────────────────────────
// 配置里有代理 ≠ 代理可用（FlClash 停止态真机判例）。代理 endpoint 是路径
// 健康表的一等行：一次探测覆盖所有 proxy-first 主机，死期内整体翻直连，
// 不必每个主机各自撞一次墙。
describe('proxyHealth（代理健康行）', () => {
  const P = 'http://proxy-health.test:7890';

  it('unknown → alive → dead 三态按探测结论翻面', () => {
    const t0 = 1_700_000_000_000;
    // 没探过：unknown，按可用处理（新配置一上来不能全打成直连）。
    expect(netRoute.proxyHealthInfo(P, t0).state).toBe('unknown');
    expect(netRoute.proxyHealthy(P, t0)).toBe(true);
    netRoute.recordProxyProbe(P, true, t0, 240);
    expect(netRoute.proxyHealthInfo(P, t0)).toEqual({ state: 'alive', latencyMs: 240 });
    netRoute.recordProxyProbe(P, false, t0 + 1);
    expect(netRoute.proxyHealthInfo(P, t0 + 2).state).toBe('dead');
    expect(netRoute.proxyHealthy(P, t0 + 2)).toBe(false);
  });

  it('失败探测的死期结束回 unknown（重探），不谎报 alive', () => {
    // ok=false 的行只有死期内的价值：死期一过既不是 dead 也不是 alive——
    // 该重探了。旧行为会让它落进 alive 分支，把一次失败报成「可达」。
    const t0 = 1_700_000_000_000;
    netRoute.recordProxyProbe(P, false, t0);
    expect(netRoute.proxyHealthInfo(P, t0 + netRoute.PROXY_DEAD_TTL_MS - 1).state).toBe('dead');
    expect(netRoute.proxyHealthInfo(P, t0 + netRoute.PROXY_DEAD_TTL_MS + 1).state).toBe('unknown');
    expect(netRoute.proxyHealthInfo(P, t0 + 10 * 60_000).state).toBe('unknown');
  });

  it('存活数据的保鲜期与学习记忆同窗（30 分钟），过期回 unknown', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordProxyProbe(P, true, t0, 100);
    expect(netRoute.proxyHealthInfo(P, t0 + netRoute.LEARNED_ROUTE_TTL_MS - 1).state).toBe('alive');
    expect(netRoute.proxyHealthInfo(P, t0 + netRoute.LEARNED_ROUTE_TTL_MS + 1).state).toBe('unknown');
  });

  it('anchors PROXY_DEAD_TTL_MS to a literal 5-minute window', () => {
    expect(netRoute.PROXY_DEAD_TTL_MS).toBe(5 * 60_000);
  });

  it('代理 key 规范化：大小写与首尾空白共用一行', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordProxyProbe(' HTTP://Proxy-Health.Test:7890 ', true, t0, 55);
    expect(netRoute.proxyHealthInfo(P, t0)).toEqual({ state: 'alive', latencyMs: 55 });
  });

  it('代理死期内 proxy-first 主机的选路整体翻直连，死期后恢复代理', () => {
    // 一次探测覆盖所有 proxy-first 主机：api.openai.com 不必亲自撞墙。
    // 时间基准挂真实时钟（Date.now()-1s）：netRouteProxyPair/persist 内部
    // 用 Date.now()，过去时间戳会让死期判定与落盘过滤双双失真。
    const t0 = Date.now() - 1_000;
    netRoute.recordProxyProbe(P, false, t0);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1, P)).toBe('direct');
    const pair = netRoute.netRouteProxyPair('https://api.openai.com/v1', P);
    expect(pair.proxyUrl).toBe('');
    expect(pair.fallbackProxyUrl).toBe(P);
    // 死期过后（按调用方时钟）照常重探：分类首选（proxy）回归。pair 恢复
    // 形态由下一条「代理活着」用例覆盖——pair 读真实时钟，这里操纵不了。
    const t1 = t0 + netRoute.PROXY_DEAD_TTL_MS + 1;
    expect(netRoute.resolveNetRoute('api.openai.com', true, t1, P)).toBe('proxy');
  });

  it('代理活着或未探测时不改变任何选路', () => {
    const t0 = 1_700_000_000_000;
    // unknown：没探过不判死。
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0, P)).toBe('proxy');
    // alive：代理优先照旧。
    netRoute.recordProxyProbe(P, true, t0, 100);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1, P)).toBe('proxy');
    expect(netRoute.netRouteProxyPair('https://api.openai.com/v1', P).proxyUrl).toBe(P);
  });

  it('代理健康行与 host 路由行同 map 隔离，互不覆盖', () => {
    // route key 空间由 proxy: 前缀隔离；学过的 host 路由不受代理探测影响。
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, t0);
    netRoute.recordProxyProbe(P, false, t0 + 1);
    // host 学习（direct 活路证据）仍在：resolve 走学习而非死期翻面。
    // （proxy-first 主机 + 代理死期时兜底翻 direct 与 host 学习语义一致，
    // 这里验证的是 learned 行本身没被 proxy 行顶掉。）
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['api.openai.com']?.route).toBe('direct');
    expect(raw[`proxy:${P}`]?.ok).toBe(false);
  });

  it('persists proxy health rows and reloads them across a fresh load', () => {
    const t0 = 1_700_000_000_000;
    netRoute.recordProxyProbe(P, false, t0);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw[`proxy:${P}`]).toEqual({ proxy: true, at: t0, ok: false, deadUntil: t0 + netRoute.PROXY_DEAD_TTL_MS });
    // 模拟重启：内存表清空、从存档重读，死期结论仍然成立。
    netRoute.resetLearnedRoutes();
    expect(netRoute.proxyHealthInfo(P, t0 + 1).state).toBe('dead');
  });

  it('imports legacy route-only rows and drops malformed proxy rows', () => {
    const t0 = Date.now();
    const legacy = {
      'legacy-host.test': { route: 'proxy', at: t0 },
      [`proxy:${P}`]: { proxy: true }, // 缺 at/ok —— 结构不完整，丢弃
      'bad-row.test': { proxy: 'yes' }, // 既非 proxy 行也非 route 行
    };
    localStorage.setItem('pure.netRoute.v1', JSON.stringify(legacy));
    netRoute.resetLearnedRoutes();
    expect(netRoute.resolveNetRoute('legacy-host.test', true, t0 + 1)).toBe('proxy');
    expect(netRoute.proxyHealthInfo(P, t0 + 1).state).toBe('unknown');
  });
});

// ── 期2 路由脑：时延 EMA（期3 双路对比的数据底座） ─────────────────────────
describe('latencyEma（响应头时延学习）', () => {
  // persist 用真实 Date.now() 做 30 分钟过期过滤，时间基准必须挂真实时钟，
  // 否则带过去时间戳的行根本落不了盘。
  it('first sample seeds the EMA, later samples blend at α=0.3', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema.test', 'direct', true, t0, 100);
    netRoute.recordNetOutcome('ema.test', 'direct', true, t0 + 1, 200);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    // 100×0.7 + 200×0.3 = 130
    expect(raw['ema.test'].latencyEma).toBe(130);
    expect(raw['ema.test'].lastOkAt).toBe(t0 + 1);
    expect(raw['ema.test'].at).toBe(t0 + 1);
  });

  it('persists latencyEma/lastOkAt through a reload', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema-persist.test', 'proxy', true, t0, 320);
    netRoute.resetLearnedRoutes();
    // 重载后再来一次同路成功，EMA 应从存档里的 320 起步而非重置：
    // 320×0.7 + 80×0.3 = 248
    netRoute.recordNetOutcome('ema-persist.test', 'proxy', true, t0 + 1, 80);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['ema-persist.test'].latencyEma).toBe(248);
  });

  it('absent headersMs keeps refreshing lastOkAt without touching the EMA', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema-absent.test', 'direct', true, t0, 100);
    netRoute.recordNetOutcome('ema-absent.test', 'direct', true, t0 + 5);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['ema-absent.test'].latencyEma).toBe(100);
    expect(raw['ema-absent.test'].lastOkAt).toBe(t0 + 5);
  });
});