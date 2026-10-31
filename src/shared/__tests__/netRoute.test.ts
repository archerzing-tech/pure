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

// ── 期2 路由脑：时延 EMA（期3「谁快用谁」的数据底座，归槽形态） ─────────────
describe('latencyEma（响应头时延学习，双路归槽）', () => {
  // persist 用真实 Date.now() 做 30 分钟过期过滤，时间基准必须挂真实时钟，
  // 否则带过去时间戳的行根本落不了盘。
  it('first sample seeds the slot, later samples blend at α=0.3', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema.test', 'direct', true, t0, 100);
    netRoute.recordNetOutcome('ema.test', 'direct', true, t0 + 1, 200);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    // 100×0.7 + 200×0.3 = 130 —— 进直连槽
    expect(raw['ema.test'].latencyEmaDirect).toBe(130);
    expect(raw['ema.test'].lastOkAt).toBe(t0 + 1);
    expect(raw['ema.test'].at).toBe(t0 + 1);
  });

  it('persists slot EMA through a reload', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema-persist.test', 'proxy', true, t0, 320);
    netRoute.resetLearnedRoutes();
    // 重载后再来一次同路成功，EMA 应从存档里的 320 起步而非重置：
    // 320×0.7 + 80×0.3 = 248
    netRoute.recordNetOutcome('ema-persist.test', 'proxy', true, t0 + 1, 80);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['ema-persist.test'].latencyEmaProxy).toBe(248);
  });

  it('absent headersMs keeps refreshing lastOkAt without touching the slot', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordNetOutcome('ema-absent.test', 'direct', true, t0, 100);
    netRoute.recordNetOutcome('ema-absent.test', 'direct', true, t0 + 5);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['ema-absent.test'].latencyEmaDirect).toBe(100);
    expect(raw['ema-absent.test'].lastOkAt).toBe(t0 + 5);
  });

  it('legacy single-slot latencyEma migrates into the route-matched slot on load', () => {
    const t0 = Date.now() - 1_000;
    localStorage.setItem('pure.netRoute.v1', JSON.stringify({
      'legacy-direct.test': { route: 'direct', at: t0, latencyEma: 120 },
      'legacy-proxy.test': { route: 'proxy', at: t0, latencyEma: 900 },
    }));
    netRoute.resetLearnedRoutes();
    // 迁移落槽后，一次同路成功就在双槽上混合，而不是重置：
    // direct 120×0.7+300×0.3=174；proxy 900×0.7+100×0.3=660
    netRoute.recordNetOutcome('legacy-direct.test', 'direct', true, t0 + 1, 300);
    netRoute.recordNetOutcome('legacy-proxy.test', 'proxy', true, t0 + 1, 100);
    const raw = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(raw['legacy-direct.test'].latencyEmaDirect).toBe(174);
    expect(raw['legacy-proxy.test'].latencyEmaProxy).toBe(660);
    expect(raw['legacy-direct.test'].latencyEma).toBeUndefined();
  });
});

// ── 期3 路由脑：谁快用谁（双路 EMA 对比选路） ───────────────────────────────
describe('谁快用谁（双路时延裁定）', () => {
  // race.openai.com 命中 openai.com 后缀规则 = proxy-first：分类面首选代理，
  // 快路裁定要证的是「真实时延压过分类与钉路」。
  const P = 'http://race-proxy.test:7890';
  const T = 'race.openai.com';
  // 时间基准挂真实时钟（persist 30 分钟过滤 + 记忆 30 分钟 TTL 的判例）。
  const t0 = () => Date.now() - 1_000;

  it('decisively faster direct wins over both the classification and the pinned route', () => {
    // 代理先 serving（proxy-first 分类首选）且慢（爬行链路），直连快一倍以上
    // 且绝对省 ≥500ms：钉着的 proxy 记忆与 proxy-first 分类被真实时延压过。
    netRoute.recordNetOutcome(T, 'proxy', true, t0(), 1500);
    netRoute.recordNetOutcome(T, 'direct', true, t0() + 1, 200); // 换路，proxy 槽保留
    expect(netRoute.resolveNetRoute(T, true, t0() + 2, P)).toBe('direct');
  });

  it('decisively faster proxy wins back a slow direct', () => {
    // 直连爬行、代理快的反相：快路裁定同样向 proxy 翻（对称规则）。
    netRoute.recordNetOutcome('slowdirect.openai.com', 'direct', true, t0(), 1500);
    netRoute.recordNetOutcome('slowdirect.openai.com', 'proxy', true, t0() + 1, 200);
    expect(netRoute.resolveNetRoute('slowdirect.openai.com', true, t0() + 2, P)).toBe('proxy');
  });

  it('modest gaps do NOT flip the route (no flip-flopping over 200-300ms)', () => {
    // 直连 200 / 代理 300 的本地代理典型开销：300×0.5=150 ≤ 200 不满足比例
    // 判据，钉什么走什么——不值得为两三百毫秒翻路。
    netRoute.recordNetOutcome('modest.openai.com', 'proxy', true, t0(), 300);
    netRoute.recordNetOutcome('modest.openai.com', 'direct', true, t0() + 1, 200);
    expect(netRoute.resolveNetRoute('modest.openai.com', true, t0() + 2, P)).toBe('direct');
  });

  it('a single sample on the opposite route flips via the race rule, not the dead path', () => {
    // 直连 2s 爬行（未到 4s 慢直连判据）：换路钉 direct 后，双槽对比
    // 200×0.5 ≤ 300 不成立 → 300 < 1000 且差 1700ms ≥ 500 → 快路翻回 proxy。
    netRoute.recordNetOutcome('single.openai.com', 'proxy', true, t0(), 300);
    netRoute.recordNetOutcome('single.openai.com', 'direct', true, t0() + 1, 2000);
    expect(netRoute.resolveNetRoute('single.openai.com', true, t0() + 2, P)).toBe('proxy');
  });

  it('dead-route takes precedence over any latency evidence', () => {
    // 直连刚失败进死期：无论它时延槽里多快，死期内绝不选——死期优先于快路。
    netRoute.recordNetOutcome('deadrace.openai.com', 'proxy', true, t0(), 1500);
    netRoute.recordNetOutcome('deadrace.openai.com', 'direct', true, t0() + 1, 200);
    netRoute.recordNetOutcome('deadrace.openai.com', 'direct', false, t0() + 2); // direct 死路半边
    expect(netRoute.resolveNetRoute('deadrace.openai.com', true, t0() + 3, P)).toBe('proxy');
  });

  it('memory expired mid-session rescues both latency slots for one final race call', () => {
    // 运行期过期（会话开着超 30 分钟）：钉哪条路的结论作废，双路时延事实
    // 仍新鲜——抢救出来做最后一次快路裁定，不让 proxy-first 分类把主机
    // 判回 1.5s 的爬行代理。跨启动场景过期行在读档时即丢，样本不参与
    // （读档过滤走 at，本用例钉的是运行期路径）。
    const t = Date.now();
    localStorage.setItem('pure.netRoute.v1', JSON.stringify({
      'expire.openai.com': {
        route: 'proxy',
        at: t - 29 * 60_000, // 未过 TTL：能被 loadOrInit 导入
        latencyEmaProxy: 1500,
        latencyEmaDirect: 200,
      },
    }));
    netRoute.resetLearnedRoutes();
    // now 拨到 +2min：行在选路面变为 31min 前 = 过期，走抢救分支。
    expect(netRoute.resolveNetRoute('expire.openai.com', true, t + 2 * 60_000, P)).toBe('direct');
    // 行已过期删除，双槽证据随之退役——下一次是干净的分类面。
    const after = JSON.parse(localStorage.getItem('pure.netRoute.v1') ?? '{}');
    expect(after['expire.openai.com']).toBeUndefined();
  });
});

// ── 网络状态矩阵（2026-10-30 用户点名场景） ────────────────────────────────
// 应用第一次打开与第二次打开遇到的网络状况可能不同；用户机子上的代理服务
// 一会开一会关。每个用例对应一张场景卡：A=代理健康维度的四种相，B=跨启动
// 的学习记忆，C=两层（代理健康 × 主机学习）独立时的组合行为。
// 时间基准一律挂真实时钟（Date.now()-1s）：netRouteProxyPair/persist 内部
// 硬用 Date.now()，过去时间戳会让死期判定与落盘过滤双双失真。
describe('网络状态矩阵（用户点名场景）', () => {
  const P = 'http://matrix-proxy.test:7890';

  it('A1 代理开着：探测活，proxy-first 主机走代理', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordProxyProbe(P, true, t0, 180);
    expect(netRoute.proxyHealthInfo(P, t0 + 1).state).toBe('alive');
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1, P)).toBe('proxy');
    expect(netRoute.netRouteProxyPair('https://api.openai.com/v1', P).proxyUrl).toBe(P);
  });

  it('A2+A3 代理没开、或开了但配错：两种死法同判，死期内全线翻直连', () => {
    // 「没开」= 端口无监听连接被拒；「开了但配错」= 端口活着但上游转发
    // 断/认证错——两种死法在探测侧都表现为拿不到响应头，同一个 dead 判。
    // 这里对两个不同的代理地址各记一次失败，验证判定不区分死法。
    const t0 = Date.now() - 1_000;
    const P2 = 'http://matrix-broken.test:7891';
    netRoute.recordProxyProbe(P, false, t0);
    netRoute.recordProxyProbe(P2, false, t0);
    expect(netRoute.proxyHealthInfo(P, t0 + 1).state).toBe('dead');
    expect(netRoute.proxyHealthInfo(P2, t0 + 1).state).toBe('dead');
    // 三个消费口同一翻向：选路、成对契约、打通枚举。
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1, P)).toBe('direct');
    expect(netRoute.netRouteProxyPair('https://api.openai.com/v1', P).proxyUrl).toBe('');
    const plan = netRoute.unblockAttemptsBeforeMirror('https://api.openai.com/v1', P);
    expect(plan.map((a) => a.route)).toEqual(['direct', 'proxy', 'direct']);
  });

  it('A4 代理一会开一会关：关→直连，重开重探→切回，往返可逆', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordProxyProbe(P, true, t0, 200); // 开着
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 1, P)).toBe('proxy');
    netRoute.recordProxyProbe(P, false, t0 + 2); // 关了（探测失败）
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 3, P)).toBe('direct');
    netRoute.recordProxyProbe(P, true, t0 + 4, 210); // 又开了
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + 5, P)).toBe('proxy');
    // 死期结论被新活证覆盖：健康行只剩最后一次探测的相。
    expect(netRoute.proxyHealthInfo(P, t0 + 5)).toEqual({ state: 'alive', latencyMs: 210 });
  });

  it('A5 第一次用（从没探过）：unknown 按可用处理，不把新配置打成直连', () => {
    const t0 = Date.now() - 1_000;
    expect(netRoute.proxyHealthInfo(P, t0).state).toBe('unknown');
    expect(netRoute.proxyHealthy(P, t0)).toBe(true);
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0, P)).toBe('proxy');
  });

  it('A6 隔天打开：昨天的活证过期，不能拿它当今天活着', () => {
    const t0 = Date.now() - 1_000;
    netRoute.recordProxyProbe(P, true, t0, 100);
    expect(netRoute.proxyHealthInfo(P, t0 + 1).state).toBe('alive');
    // 30 分钟后（比如隔天重启）：健康数据整体过期回 unknown，让启动探测
    // 重新落行——alive 的语义是「刚探过是活的」，不是「曾经活着」。
    expect(netRoute.proxyHealthInfo(P, t0 + netRoute.LEARNED_ROUTE_TTL_MS + 1).state).toBe('unknown');
    // unknown 按可用处理：分类照常走代理（下一轮探测马上会给真结论）。
    expect(netRoute.resolveNetRoute('api.openai.com', true, t0 + netRoute.LEARNED_ROUTE_TTL_MS + 1, P)).toBe('proxy');
  });

  it('C1 上次直连通、这次重启直连断了：旧记忆先生效，首连撞墙后本会话直跳代理零重演', () => {
    // 重启语义 = 内存清空、localStorage 存档重读。上次会话把 direct 钉上。
    const now = Date.now();
    localStorage.setItem('pure.netRoute.v1', JSON.stringify({
      'matrix-c1.test': { route: 'direct', at: now - 10 * 60_000, lastOkAt: now - 10 * 60_000 },
    }));
    netRoute.resetLearnedRoutes();
    // 刚打开：学习记忆 30min 内仍生效（不能一上来就推翻它），继续直连。
    expect(netRoute.resolveNetRoute('matrix-c1.test', true, now, P)).toBe('direct');
    // 首连撞墙（直连环境变了）：死路半边落信号——这就是「快速处理」，
    // 学费只交这一次。
    netRoute.recordNetOutcome('matrix-c1.test', 'direct', false, now + 1);
    expect(netRoute.resolveNetRoute('matrix-c1.test', true, now + 2, P)).toBe('proxy');
    // 本会话后续：代理成功钉上，每个请求不再重演「失败→换路」。
    netRoute.recordNetOutcome('matrix-c1.test', 'proxy', true, now + 3, 300);
    expect(netRoute.resolveNetRoute('matrix-c1.test', true, now + 4, P)).toBe('proxy');
  });

  it('C2 上次走代理、这次打开直连也通了：30 分钟内学习赢不折腾，隔天回落分类；谁快用谁归期3', () => {
    // 场景：上次代理 ok（学习钉 proxy）。两次打开间隔不同，处理不同——
    const now = Date.now();
    const writeArchive = (ageMs: number) => {
      localStorage.setItem('pure.netRoute.v1', JSON.stringify({
        'api.openai.com': { route: 'proxy', at: now - ageMs, lastOkAt: now - ageMs, latencyEma: 400 },
      }));
      netRoute.resetLearnedRoutes();
    };
    // a) 快速重启（<30min）：学习记忆仍有效。代理活着（A5 未知=按可用），
    //    就不折腾——直连虽然也通，但换路没有收益证据（EMA 对比是期3 的活）。
    writeArchive(5 * 60_000);
    expect(netRoute.resolveNetRoute('api.openai.com', true, now, P)).toBe('proxy');
    // b) 隔天打开（>30min）：学习过期。分类面（proxy-first 先验=出国路走
    //    代理）接手——直连「也通」不构成弃代理的证据，除非代理探测判死
    //    （那是 A2 的翻向）。这是期2 的有意裁定，不是疏漏。
    writeArchive(31 * 60_000);
    expect(netRoute.resolveNetRoute('api.openai.com', true, now, P)).toBe('proxy');
    // 同一根学习行在 direct-first 主机上过期后回落直连（对照：TTL 行为
    // 与主机分类无关，变的只是回落目标）。
    localStorage.setItem('pure.netRoute.v1', JSON.stringify({
      'api.deepseek.com': { route: 'proxy', at: now - 31 * 60_000 },
    }));
    netRoute.resetLearnedRoutes();
    expect(netRoute.resolveNetRoute('api.deepseek.com', true, now, P)).toBe('direct');
  });

  it('D2 代理死期中直连成功、之后代理复活：直连学习是活路证据，不被拽回代理', () => {
    const now = Date.now();
    netRoute.recordProxyProbe(P, false, now); // 代理关着
    expect(netRoute.resolveNetRoute('api.openai.com', true, now + 1, P)).toBe('direct');
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, now + 2, 250); // 直连真通了
    netRoute.recordProxyProbe(P, true, now + 3, 220); // 用户又把代理点开了
    // 代理复活不立刻改道：直连刚被证明是活路（学习），流量不折腾。
    expect(netRoute.resolveNetRoute('api.openai.com', true, now + 4, P)).toBe('direct');
    // 学习 30min 过期后：分类+健康两个维度都指向代理，流量回归代理。
    expect(netRoute.resolveNetRoute('api.openai.com', true, now + netRoute.LEARNED_ROUTE_TTL_MS + 5, P)).toBe('proxy');
  });

  it('E1 探测活但主机走代理失败：两层独立，代理活着不拦主机层的死路信号', () => {
    // 代理全链路活着 ≠ 经它能到目标站（目标端屏蔽/风控/地域墙）。真实
    // 请求的结论永远比探测更接近真相：host 层死路半边照常落，下一请求
    // 直跳直连——探测的 alive 不豁免它。
    const now = Date.now();
    netRoute.recordProxyProbe(P, true, now, 150);
    netRoute.recordNetOutcome('api.openai.com', 'proxy', false, now + 1);
    expect(netRoute.resolveNetRoute('api.openai.com', true, now + 2, P)).toBe('direct');
    expect(netRoute.netRouteProxyPair('https://api.openai.com/v1', P).proxyUrl).toBe('');
  });

  it('E2 探测死且直连成功：两层同向翻直连，直连学习钉上（死代理期间零代理流量）', () => {
    const now = Date.now();
    netRoute.recordProxyProbe(P, false, now);
    netRoute.recordNetOutcome('api.openai.com', 'direct', true, now + 1, 280);
    // 健康层 dead + 学习层 direct 活证：两层给出同一个答案。
    expect(netRoute.resolveNetRoute('api.openai.com', true, now + 2, P)).toBe('direct');
    // 打通枚举也不给代理步（学习把首选翻 direct，代理只剩反向兜底步）。
    expect(netRoute.unblockAttemptsBeforeMirror('https://api.openai.com/v1', P).map((a) => a.route))
      .toEqual(['direct', 'proxy', 'direct']);
  });
});
// ── 证据读侧（GitHub 加速 auto 模式的数据源）─────────────────────────────
// 「直连这会儿行不行」只有学习表能回答；镜像决策读这里，静态分类不参与。
describe('directRouteDead 与尸检覆盖', () => {
  const T0 = 1_700_000_000_000;

  it('只认 direct 路的死；代理路失败与死期过期都不算', () => {
    netRoute.recordNetOutcome('readside-gh.test', 'direct', false, T0);
    expect(netRoute.directRouteDead('readside-gh.test', T0 + 1)).toBe(true);
    // 传 URL 与传裸 host 同一 entry（归一化收口）。
    expect(netRoute.directRouteDead('https://readside-gh.test/x.zip', T0 + 1)).toBe(true);
    expect(netRoute.directRouteDead('readside-gh.test', T0 + netRoute.DEAD_ROUTE_TTL_MS + 1)).toBe(false);
    // 代理路的死不是直连的死（下一轮打通预算会自己落到直连）。
    netRoute.resetLearnedRoutes();
    netRoute.recordNetOutcome('readside-gh.test', 'proxy', false, T0);
    expect(netRoute.directRouteDead('readside-gh.test', T0 + 1)).toBe(false);
  });

  it('两条路先后死光：带死期的反向记忆被最新死因覆盖；活的反向记忆仍然不动', () => {
    // 尸检报告（proxy 已带死期）不是活路证据 → direct 的死允许落表：
    // 否则「代理死、直连也死」的机器上镜像自动先行永远不会触发。
    netRoute.recordNetOutcome('autopsy-gh.test', 'proxy', false, T0);
    netRoute.recordNetOutcome('autopsy-gh.test', 'direct', false, T0 + 1);
    expect(netRoute.directRouteDead('autopsy-gh.test', T0 + 2)).toBe(true);
    // 对照（既有判例不动）：钉着的**活**记忆不被另一条路的死路信号覆盖。
    netRoute.resetLearnedRoutes();
    netRoute.recordNetOutcome('pin-live.test', 'proxy', true, T0);
    netRoute.recordNetOutcome('pin-live.test', 'direct', false, T0 + 1);
    expect(netRoute.directRouteDead('pin-live.test', T0 + 2)).toBe(false);
    expect(netRoute.resolveNetRoute('pin-live.test', true, T0 + 2)).toBe('proxy');
  });
});
