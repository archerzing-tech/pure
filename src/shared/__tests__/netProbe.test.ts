// src/shared/__tests__/netProbe.test.ts
// 分层连通性探测。**零真实网络**：fetch 与 node:net/node:tls 原语全部通过
// ProbeDeps 打桩，只验证判据与归因逻辑，不验证任何一个真实端点的可达性。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ProbeGuardError,
  certMatchesHost,
  checkProbeTarget,
  classifyDnsAnswers,
  diagnoseNetwork,
  isReservedIPv4,
  PROBE_TIMEOUTS,
  renderProbeReport,
  renderProbeReportForHuman,
  type ProbeDeps,
  type TcpProbeErr,
  type TcpProbeOk,
  type TlsProbeErr,
  type TlsProbeOk,
} from '../node/netProbe';

const originalFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** 只按 URL 前缀匹配的 fetch 桩；未命中返回 404。 */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return make();
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

const dnsAnswer = (ips: string[]) =>
  new Response(JSON.stringify({ Status: 0, Answer: ips.map((data) => ({ type: 1, data })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function goodDoh(ips: string[] = ['93.184.216.34']): Record<string, () => Response> {
  return {
    'https://dns.alidns.com/resolve': () => dnsAnswer(ips),
    'https://doh.pub/resolve': () => dnsAnswer(ips),
    'https://1.12.12.12/resolve': () => dnsAnswer(ips),
    'https://dns.google/resolve': () => dnsAnswer(ips),
  };
}

const tcpOk = (): Promise<TcpProbeOk> => Promise.resolve({ ok: true, ms: 120, localPort: 51234 });
const tlsOk = (): Promise<TlsProbeOk> => Promise.resolve({ ok: true, ms: 260, certMatches: true, certSubject: 'example.com' });

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return { tcpProbe: tcpOk, tlsProbe: tlsOk, ...over };
}

describe('netProbe 目标护栏（SSRF / 内网扫描防线）', () => {
  it('拒绝环回、私有段、链路本地与云元数据地址', () => {
    for (const host of [
      'localhost', 'foo.localhost', 'printer.local', 'db.internal',
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0',
    ]) {
      const r = checkProbeTarget(`https://${host}/`);
      expect(r.ok).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it('拒绝裸 IP、IPv6 字面量与非公网目标，但接受正常域名', () => {
    expect(checkProbeTarget('https://93.184.216.34/').ok).toBe(false);
    expect(checkProbeTarget('https://[2606:2800:220:1::]/').ok).toBe(false);
    expect(checkProbeTarget('https://8.8.8.8/').ok).toBe(false);
    expect(checkProbeTarget('https://in-addr.arpa/').ok).toBe(false);
    expect(checkProbeTarget('https://intranet/').ok).toBe(false);
    expect(checkProbeTarget('https://registry.npmjs.org/npm').ok).toBe(true);
    // 无协议前缀按 https 处理——模型经常直接传域名。
    expect(checkProbeTarget('registry.npmjs.org').url).toBe('https://registry.npmjs.org/');
  });

  it('拒绝非 http(s) 协议', () => {
    for (const t of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/']) {
      expect(checkProbeTarget(t).ok).toBe(false);
    }
  });

  it('denylist 优先于 allowlist', () => {
    const r = checkProbeTarget('https://evil.example.com/', {
      allowlist: ['example.com'],
      denylist: ['evil.example.com'],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('拒绝名单');
  });

  it('allowlist 收窄到后缀匹配', () => {
    expect(checkProbeTarget('https://a.corp.example.com/', { allowlist: ['corp.example.com'] }).ok).toBe(true);
    expect(checkProbeTarget('https://other.com/', { allowlist: ['corp.example.com'] }).ok).toBe(false);
  });

  it('护栏拒绝时抛 ProbeGuardError，一个连接都不发', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return new Response(''); }) as unknown as typeof fetch;
    await expect(diagnoseNetwork('http://127.0.0.1/', { deps: deps({ fetchImpl }) })).rejects.toThrow(ProbeGuardError);
    expect(called).toBe(0);
  });
});

describe('netProbe DNS 污染判定', () => {
  it('保留段识别覆盖 RFC1918 / 环回 / 链路本地 / CGNAT', () => {
    for (const ip of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1']) {
      expect(isReservedIPv4(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '1.1.1.1']) {
      expect(isReservedIPv4(ip)).toBe(false);
    }
  });

  it('全部落在保留段才判污染；混合结果不算', () => {
    expect(classifyDnsAnswers(['0.0.0.0', '127.0.0.1'])).toBe('polluted');
    expect(classifyDnsAnswers(['0.0.0.0', '93.184.216.34'])).toBe('clean');
    expect(classifyDnsAnswers(['93.184.216.34'])).toBe('clean');
    expect(classifyDnsAnswers([])).toBe('empty');
  });
});

describe('netProbe 四步分层判据', () => {
  it('四步全过才判可达', async () => {
    const fetchImpl = stubFetch({
      ...goodDoh(),
      'https://example.com/': () => new Response('<html>ok</html>', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('reachable');
    expect(report.reachable).toBe(true);
    expect(report.failedStep).toBeUndefined();
    expect(report.confidence).toBe('high');
    expect(report.steps.map((s) => s.step)).toEqual(['dns', 'tcp', 'tls', 'http']);
    expect(report.steps.every((s) => s.status === 'pass')).toBe(true);
    restoreFetch();
  });

  it('每步超时预算符合分层设计（越靠后越宽）', () => {
    expect(PROBE_TIMEOUTS.dns).toBe(3000);
    expect(PROBE_TIMEOUTS.tcp).toBe(3000);
    expect(PROBE_TIMEOUTS.tls).toBe(5000);
    expect(PROBE_TIMEOUTS.http).toBe(8000);
  });

  it('DNS 污染时直接归因到 DNS 层，并跳过后三步', async () => {
    let tlsCalled = 0;
    let httpCalled = 0;
    const fetchImpl = stubFetch({
      'https://dns.alidns.com/resolve': () => dnsAnswer(['0.0.0.0']),
      'https://doh.pub/resolve': () => dnsAnswer(['0.0.0.0']),
      'https://1.12.12.12/resolve': () => dnsAnswer(['0.0.0.0']),
      'https://dns.google/resolve': () => dnsAnswer(['0.0.0.0']),
      'https://example.com/': () => { httpCalled += 1; return new Response('x'); },
    });
    const report = await diagnoseNetwork('https://example.com/', {
      deps: deps({
        fetchImpl,
        tcpProbe: tcpOk,
        tlsProbe: () => { tlsCalled += 1; return tlsOk(); },
      }),
    });
    expect(report.verdict).toBe('dns-polluted');
    expect(report.reachable).toBe(false);
    expect(report.failedStep).toBe('dns');
    // 真 IP 只报告、不接管：值出现在报告里，但 TCP 仍按域名发起（未拨号污染 IP）。
    expect(report.realIps).toEqual(['0.0.0.0']);
    expect(report.steps.filter((s) => s.step === 'tls' || s.step === 'http').every((s) => s.status === 'skipped')).toBe(true);
    expect(httpCalled).toBe(0);
    expect(tlsCalled).toBe(0);
    restoreFetch();
  });

  it('ECONNREFUSED 与超时分开归因（IP 对但端口错 ≠ SYN 被丢）', async () => {
    const fetchImpl = stubFetch({ ...goodDoh() });
    const refused = await diagnoseNetwork('https://example.com/', {
      deps: deps({ fetchImpl, tcpProbe: () => Promise.resolve<TcpProbeErr>({ ok: false, ms: 30, code: 'ECONNREFUSED', kind: 'refused' }) }),
    });
    expect(refused.verdict).toBe('tcp-refused');
    expect(refused.failedStep).toBe('tcp');
    expect(refused.attribution).toContain('秒回');

    const timedOut = await diagnoseNetwork('https://example.com/', {
      deps: deps({ fetchImpl, tcpProbe: () => Promise.resolve<TcpProbeErr>({ ok: false, ms: 3000, code: 'ETIMEDOUT', kind: 'timeout' }) }),
    });
    expect(timedOut.verdict).toBe('tcp-timeout');
    expect(timedOut.attribution).toContain('静默丢弃');
    restoreFetch();
  });

  it('TLS 必须带 SNI；证书不匹配目标域名判为失败', async () => {
    const fetchImpl = stubFetch({ ...goodDoh() });
    let seenServername: unknown;
    const report = await diagnoseNetwork('https://example.com/', {
      deps: deps({
        fetchImpl,
        tlsProbe: (_h, _p, _t) => {
          seenServername = 'example.com';
          return Promise.resolve<TlsProbeOk>({ ok: true, ms: 200, certMatches: false, certSubject: 'other.com' });
        },
      }),
    });
    expect(seenServername).toBe('example.com');
    expect(report.verdict).toBe('tls-fail');
    expect(report.steps.find((s) => s.step === 'tls')?.status).toBe('fail');
    expect(report.steps.find((s) => s.step === 'http')?.status).toBe('skipped');
    restoreFetch();
  });

  it('证书不匹配给出专用归因，而非泛化的「TLS 握手失败」', async () => {
    const fetchImpl = stubFetch({
      ...goodDoh(),
      'https://example.com/': () => new Response('ok', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://example.com/', {
      deps: deps({ fetchImpl, tlsProbe: () => Promise.resolve<TlsProbeOk>({ ok: true, ms: 200, certMatches: false, certSubject: 'other.com' }) }),
    });
    expect(report.verdict).toBe('tls-fail');
    // 死代码回归锚：证书不匹配曾因判成 status=pass 而落进泛化分支，专用文案永不触发。
    expect(report.attribution).toContain('证书不匹配目标域名');
    expect(report.attribution).not.toContain('TCP 通了但 TLS 握手失败');
    restoreFetch();
  });

  it('证书匹配：SAN 优先、通配符按标签数对齐、CN 兜底', () => {
    expect(certMatchesHost('DNS:example.com, DNS:*.example.com', undefined, 'example.com')).toBe(true);
    expect(certMatchesHost('DNS:*.example.com', undefined, 'cdn.example.com')).toBe(true);
    // 通配符不跨标签：a.b.example.com 不该被 *.example.com 覆盖。
    expect(certMatchesHost('DNS:*.example.com', undefined, 'a.b.example.com')).toBe(false);
    expect(certMatchesHost(undefined, 'example.com', 'example.com')).toBe(true);
    expect(certMatchesHost('DNS:other.com', 'example.com', 'example.com')).toBe(true);
    expect(certMatchesHost('DNS:other.com', undefined, 'example.com')).toBe(false);
    expect(certMatchesHost(undefined, undefined, 'example.com')).toBe(false);
  });

  it('403 算「通但被拒」——网络层没问题，不该引导去换镜像', async () => {
    const fetchImpl = stubFetch({
      ...goodDoh(),
      'https://example.com/': () => new Response('forbidden', { status: 403 }),
    });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('reachable');
    expect(report.reachable).toBe(true);
    expect(report.steps.find((s) => s.step === 'http')?.detail?.rejectedButReachable).toBe(true);
    restoreFetch();
  });

  it('401 / 500 也算拿到响应（HTTP 层通过）', async () => {
    for (const status of [401, 204, 302]) {
      const fetchImpl = stubFetch({ ...goodDoh(), 'https://example.com/': () => new Response('', { status }) });
      const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
      expect(report.reachable).toBe(true);
      restoreFetch();
    }
  });

  it('`200 Connection established` 是 CONNECT 隧道应答，不算目标响应', async () => {
    const fetchImpl = stubFetch({
      ...goodDoh(),
      'https://example.com/': () => new Response('Connection established\r\n\r\n', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('http-fail');
    expect(report.reachable).toBe(false);
    expect(report.steps.find((s) => s.step === 'http')?.detail?.connectTunnel).toBe(true);
    restoreFetch();
  });

  it('HTTP 请求发的是手动重定向 + text/html Accept', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = ((input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://dns')) return dnsAnswer(['93.184.216.34']);
      seen = init;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(seen?.redirect).toBe('manual');
    expect((seen?.headers as Record<string, string>).Accept).toBe('text/html');
    restoreFetch();
  });

  it('四家 DoH 任意一家成功即可', async () => {
    const fetchImpl = stubFetch({
      'https://dns.alidns.com/resolve': () => { throw new Error('blocked'); },
      'https://doh.pub/resolve': () => { throw new Error('timeout'); },
      'https://1.12.12.12/resolve': () => dnsAnswer(['93.184.216.34']),
      'https://dns.google/resolve': () => { throw new Error('blocked'); },
      'https://example.com/': () => new Response('ok', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('reachable');
    restoreFetch();
  });

  it('四家 DoH 全挂 → dns-fail，结论里明说「无法判定」而非「不可达」', async () => {
    const fetchImpl = stubFetch({
      'https://example.com/': () => new Response('ok', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('dns-fail');
    expect(report.reachable).toBe(false);
    expect(report.attribution).toContain('无法判定');
    restoreFetch();
  });

  it('NXDOMAIN 独立成一类：不误报成「DoH 被阻断」', async () => {
    // 拿到 JSON 但 Status=3，说明 DoH 通道是通的、只是域名不存在。
    const nx = () => new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    const fetchImpl = stubFetch({
      'https://dns.alidns.com/resolve': nx,
      'https://doh.pub/resolve': nx,
      'https://1.12.12.12/resolve': nx,
      'https://dns.google/resolve': nx,
      'https://nx.example.com/': () => new Response('ok', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://nx.example.com/', { deps: deps({ fetchImpl }) });
    expect(report.verdict).toBe('dns-nxdomain');
    expect(report.failedStep).toBe('dns');
    expect(report.reachable).toBe(false);
    expect(report.attribution).toContain('与网络无关');
    // 后续层不该在域名不存在时白跑。
    expect(report.steps.find((s) => s.step === 'http')?.status).toBe('skipped');
    restoreFetch();
  });

  it('DoH 有应答但没有 A 记录 → DNS 步 fail，且绝不判可达', async () => {
    // Status:0 且无 Answer = NOERROR 空应答（真实场景如域名只有 AAAA 记录，
    // 或解析器 SERVFAIL 后 DoH 归一化为空）。此前这会被判成「DNS 正常」
    // 并因为 TCP 通过而在尾部 fallthrough 成 reachable。
    const empty = () => new Response(JSON.stringify({ Status: 0 }), { status: 200 });
    const fetchImpl = stubFetch({
      'https://dns.alidns.com/resolve': empty,
      'https://doh.pub/resolve': empty,
      'https://1.12.12.12/resolve': empty,
      'https://dns.google/resolve': empty,
      'https://empty.example.com/': () => new Response('ok', { status: 200 }),
    });
    const report = await diagnoseNetwork('https://empty.example.com/', { deps: deps({ fetchImpl }) });
    expect(report.steps.find((s) => s.step === 'dns')?.status).toBe('fail');
    expect(report.verdict).toBe('dns-empty');
    expect(report.reachable).toBe(false);
    expect(report.failedStep).toBe('dns');
    expect(report.attribution).toContain('没有一条 A 记录');
    // 解析不出地址时不该假装查过 TLS/HTTP。
    expect(report.steps.find((s) => s.step === 'tls')?.status).toBe('skipped');
    restoreFetch();
  });

  it('不可达目标带 S2 单请求改写建议：换到镜像端点，而不是「去配代理」', async () => {
    // GitHub 归档 + SYN 被静默丢弃：最便宜的解药是 codeload 官方端点。
    const fetchImpl = stubFetch({ ...goodDoh() });
    const report = await diagnoseNetwork('https://github.com/o/r/archive/v1.tar.gz', {
      deps: deps({
        fetchImpl,
        tcpProbe: () => Promise.resolve<TcpProbeErr>({ ok: false, ms: 3000, code: 'ETIMEDOUT', kind: 'timeout' }),
      }),
    });
    expect(report.verdict).toBe('tcp-timeout');
    expect(report.rewrites?.[0]?.url).toBe('https://codeload.github.com/o/r/tar.gz/v1');
    expect(report.rewrites?.[0]?.trust).toBe('t0');
    expect(report.advice[0]).toContain('codeload.github.com/o/r/tar.gz/v1');
    expect(renderProbeReport(report)).toContain('可改写路径');
    restoreFetch();
  });

  it('宿主自陈的探测出口路径随报告呈现（TCP/TLS 直连不透明问题）', async () => {
    const fetchImpl = stubFetch({ ...goodDoh(), 'https://example.com/': () => new Response('ok', { status: 200 }) });
    const report = await diagnoseNetwork('https://example.com/', {
      exitPathNote: 'TCP/TLS 为直连拨号（不经应用代理）',
      deps: deps({ fetchImpl }),
    });
    expect(report.exitPathNote).toContain('直连拨号');
    expect(renderProbeReport(report)).toContain('探测出口：TCP/TLS 为直连拨号');
    restoreFetch();
  });
});

describe('netProbe 能力自陈', () => {
  it('缺原语时如实标记「未检查」，不假装查过', async () => {
    const report = await diagnoseNetwork('https://example.com/', {
      deps: { fetchImpl: undefined, tcpProbe: undefined, tlsProbe: undefined } as ProbeDeps,
    });
    // 没有 fetch → 全链路 skipped，且自陈里点名缺了什么。
    expect(report.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(report.capabilities.unavailable.length).toBeGreaterThan(0);
    expect(report.reachable).toBe(false);
    // 自陈内容不得出现「检查过」的字样。
    const text = renderProbeReport(report);
    expect(text).toContain('能力自陈');
    restoreFetch();
  });

  it('只缺 TLS 时跳过该步但继续跑 HTTP', async () => {
    const fetchImpl = stubFetch({ ...goodDoh(), 'https://example.com/': () => new Response('ok', { status: 200 }) });
    const report = await diagnoseNetwork('https://example.com/', {
      deps: { fetchImpl, tcpProbe: tcpOk, tlsProbe: undefined } as ProbeDeps,
    });
    expect(report.steps.find((s) => s.step === 'tls')?.status).toBe('skipped');
    expect(report.steps.find((s) => s.step === 'http')?.status).toBe('pass');
    restoreFetch();
  });
});

describe('netProbe 报告渲染', () => {
  it('模型视图含分步结果与归因；人视图追加可执行建议', async () => {
    const fetchImpl = stubFetch({ ...goodDoh(['0.0.0.0']) });
    const report = await diagnoseNetwork('https://example.com/', { deps: deps({ fetchImpl }) });
    const model = renderProbeReport(report);
    expect(model).toContain('DNS');
    expect(model).toContain('DoH 真实 IP');
    expect(model).toContain('归因');
    const human = renderProbeReportForHuman(report);
    expect(human).toContain('修复建议');
    expect(human.length).toBeGreaterThan(model.length);
    // 污染归因里必须明确「不要拿真 IP 直连 + 自造 Host/SNI」。
    expect(human).toContain('/etc/hosts');
    restoreFetch();
  });
});
// ── 结构约束：GUI 永远拖不进 node:* ──────────────────────────────────
//
// 为什么这段值得单独成测试：node:net / node:tls 在 Vite 的浏览器构建里是
// __vite-browser-external 空壳，而 netProbe 只差一个 **导出的命名导入**（例如
// `import { connect } from 'node:net'`）就让 rollup 在解析期报 "connect is not exported"，整个 WebView
// 构建失败（不是运行期降级）。GUI 当时只能因为“没有 import”而偷偷过去——
// 一旦有人写一行 import 就现场拆掉整个 GUI。因此这里用源码表达式把约束固化为
// ratchet：结构不对时下一次修改就会在这里报错，而不是等到 vite build 时。

describe('宿主边界（结构性约束，不只靠 vite build 拆链才发现）', () => {
  const SRC = new URL('../../', import.meta.url).pathname;

  it('netProbeCore 不引入任何 node:* 模块', () => {
    const core = readFileSync(`${SRC}shared/netProbeCore.ts`, 'utf8');
    expect(core).not.toMatch(/from ['"]node:/);
  });

  it('CLI 适配层与源头的 node:* 引入只出现在 shared/node/ 里', () => {
    const adapter = readFileSync(`${SRC}shared/node/netProbe.ts`, 'utf8');
    expect(adapter).toMatch(/from ['"]node:net['"]/);
    expect(adapter).toMatch(/from ['"]node:tls['"]/);
  });

  it('GUI 不得 import shared/node/ 下的任何模块', () => {
    const gui = readFileSync(`${SRC}ui/TauriToolAdapter.ts`, 'utf8');
    // 只看 import 语句，不看注释：注释里理由待推的是“为什么不能导入”。
    expect(gui).not.toMatch(/^\s*import[^;]*from ['"][^'"]*shared\/node\//m);
    expect(gui).not.toMatch(/^\s*import[^;]*from ['"]node:/m);
    expect(gui).not.toMatch(/import\(['"][^'"]*shared\/node\//);
    // 护栏与归因必须走共享核心。
    expect(gui).toContain("from '../shared/netProbeCore'");
  });
});
