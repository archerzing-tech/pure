// src/shared/netProbeCore.ts
// 四步分层连通性探测的**判定核心**：护栏 / DNS 判定 / 归因合并 / 置信度 /
// 报告渲染 / 能力自陈。这个文件**零 node 依赖**（只用 URL / fetch / 正则），
// 因此 CLI 与 GUI（WebView）共用同一份判据。
//
// 为什么分层：agent 过去看到的失败只有一句 `fetch failed`，而「fetch failed」
// 至少对应五种完全不同的病因——DNS 污染 / SYN 被静默丢弃 / TLS 被 RST /
// CDN 403 劫持改写 / 代理认证失败——五种病的修法没有一种相同。分层探测的
// 唯一价值就是把这五种分开归因，让模型能对症下药（换源 vs 换代理 vs 找用户）。
//
// 为什么判据偏保守（宁可多花 200ms 确认）：误判代价不对称。把「通」判成
// 「不通」→ 走镜像，慢但最终能用；把「不通」判成「通」→ 直接用官方源下载，
// 大文件卡到超时，整个任务失败。所以四步全过才算通，任何一步失败都不算通。
//
// 为什么核心与宿主适配层分开：`src/shared/` 的其余模块会被 WebView 打包，
// 而本模块的旧版本在**模块作用域** import 了 node:net / node:tls。GUI 侧
// 于是被迫另写了一套护栏与归因（两边不一致 = GUI 上有 SSRF 缺口）。现在
// 「判定」在这里共享，「拨号」在 src/shared/node/netProbe.ts（仅 CLI）。
//
// DNS 只诊断，绝不接管：DoH 的结果**只用于报告**（是否污染、真 IP 是多少、
// 卡在哪一步）。绝不允许拿真 IP 直连 + 自造 SNI/Host —— 那是绕过 DNS 的
// 旁路实现，既治不了根（Gfw 匹配的是 SNI 不是 IP），又制造了一个新的
// 安全面（证书仍要真域名，Host 头自造则会被 CDN 判为异常流量）。
//
// 全行业没有第二家把分层网络诊断做成模型可直接调用的工具（Cursor 只有按钮、
// Claude Code 只教用户敲 curl），这就是这个模块存在的理由。

import { sourceRewriteCandidates } from './sourceRewrite';

// ── 探测预算 ──
// 每步独立超时，且**总预算 < 任何一次 10 分钟下载超时**的零头。串行四步的最坏
// 情况是 19s，远小于「拿错误的自信去跑大文件下载」的代价。

export const PROBE_TIMEOUTS = {
  dns: 3_000,
  tcp: 3_000,
  tls: 5_000,
  http: 8_000,
} as const;

export type ProbeStep = 'dns' | 'tcp' | 'tls' | 'http';

/**
 * 四家 DoH JSON API，一个 GET 出结果。
 *
 * 刻意不用 getaddrinfo：它走 hosts 文件与 NSS 解析器，拿到的正是**已经被污染
 * 过的**答案——用它问「DNS 有没有污染」等于问污染源自己。四家并行、任意一家
 * 成功即可，是为了抗单家被干扰（GFW 对 DoH 的阻断是概率性的）。
 */
export const DOH_ENDPOINTS: readonly string[] = [
  'https://dns.alidns.com/resolve',
  'https://doh.pub/resolve',
  'https://1.12.12.12/resolve',
  'https://dns.google/resolve',
];

// ── 目标护栏 ──

export interface TargetCheck {
  ok: boolean;
  /** 规范化后的 URL（ok 为 true 时有效）。 */
  url?: string;
  host?: string;
  reason?: string;
}

/**
 * 拒绝的目标类型。工具的输入来自模型，而模型的输入来自用户（或更糟，网页
 * 里的注入文本），所以这个工具同时是内网扫描器与 SSRF 入口——业界已有
 * network-mcp 因为同样的疏漏被当成扫描器用。一律在**发起任何连接之前**拒绝。
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^.*\.localdomain$/i,
];

// 裸 IPv4：只要目标是 IP 字面量就拒绝，理由不是 IP 危险，而是**诊断一个 IP
// 没有意义**——真实业务失败几乎总是发生在「域名 + CDN 调度」这一层，让模型
// 直接打 IP 会让它误以为「IP 通 = 域名通」。
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 保留段：环回 / 私有 / 链路本地 / CGNAT / 保留。 */
export function isReservedIPv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0) return true; // 0.0.0.0/8「本网络」
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254 在此段）
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

function isBareIPv6(host: string): boolean {
  return host.startsWith('[') || host.includes(':');
}

/**
 * 探测目标的准入检查。allowlist 非空时收窄到这些主机后缀（denylist 始终优先）。
 * 顺序刻意是「先解析失败 → 协议 → IP 字面量 → 保留段 → 域名黑名单 →
 * allowlist」，让拒绝原因本身对模型可读——「你让我探测 10.0.0.1」需要回一句
 * 解释，而不是一个空泛的 refused。
 *
 * CLI 与 GUI 共用这一份：护栏不一致等于 GUI 上留了一个能扫内网的工具。
 */
export function checkProbeTarget(
  rawTarget: string,
  opts: { allowlist?: readonly string[]; denylist?: readonly string[] } = {},
): TargetCheck {
  const target = String(rawTarget ?? '').trim();
  if (!target) return { ok: false, reason: '目标为空——必须给出要诊断的 URL 或域名' };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`);
  } catch {
    return { ok: false, reason: `无法解析为目标 URL：${target}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只诊断 http/https 目标，拒绝 ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: `目标缺少主机名：${target}` };
  if (isBareIPv6(host)) {
    return { ok: false, reason: `拒绝 IPv6 字面量目标（${host}）：诊断 IP 字面量无法定位业务层故障，且易被用作内网探测` };
  }
  if (IPV4_RE.test(host)) {
    return isReservedIPv4(host)
      ? { ok: false, reason: `拒绝内网/保留地址目标（${host}）` }
      : { ok: false, reason: `拒绝裸 IP 目标（${host}）：请给出域名——真实故障几乎总是发生在「域名 + CDN 调度」这一层` };
  }
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: `拒绝环回/内网域名（${host}）` };
  }
  // .arpa（反向 DNS）、无点的主机名同样排除：前者是基础设施区，后者多半是
  // 拼错的域名，让它去烧 19 秒探测预算没有产出。
  if (host.endsWith('.arpa') || !host.includes('.')) {
    return { ok: false, reason: `拒绝非公网目标（${host}）` };
  }

  const denylist = (opts.denylist ?? []).map((d) => d.toLowerCase().replace(/^\./, ''));
  const allowlist = (opts.allowlist ?? []).map((a) => a.toLowerCase().replace(/^\./, ''));
  const inDeny = denylist.some((d) => host === d || host.endsWith(`.${d}`));
  if (inDeny) return { ok: false, reason: `主机在拒绝名单内：${host}` };
  if (allowlist.length > 0 && !allowlist.some((a) => host === a || host.endsWith(`.${a}`))) {
    return { ok: false, reason: `主机不在允许名单内：${host}（允许：${allowlist.join(', ')}）` };
  }

  return { ok: true, url: url.toString(), host };
}

// ── DNS 污染判定 ──

/**
 * 污染判定只认「所有解析结果都落在保留段」。混合结果（一个污染 + 一个真实）
 * 不算污染——判定过重会把「CDN 顺带返回了一条私网地址做 GeoDNS 分流」误报成
 * DNS 污染，而那种网络其实是通的。
 */
export function classifyDnsAnswers(ips: readonly string[]): 'clean' | 'polluted' | 'empty' {
  if (ips.length === 0) return 'empty';
  return ips.every((ip) => isReservedIPv4(ip)) ? 'polluted' : 'clean';
}

// ── 分步结果形状 ──

export type StepStatus = 'pass' | 'fail' | 'skipped';

export interface ProbeStepResult {
  step: ProbeStep;
  status: StepStatus;
  ms: number;
  /** 一行人类可读摘要。 */
  summary: string;
  /** 结构化字段，给模型做下一步判断。 */
  detail?: Record<string, unknown>;
}

export type NetVerdict =
  | 'reachable'
  | 'dns-polluted'
  | 'dns-nxdomain'
  | 'dns-fail'
  /** DoH 通道拿到了应答，但没有 A 记录（NOERROR 空应答或 SERVFAIL）：解析器此刻给不出可用地址。 */
  | 'dns-empty'
  | 'tcp-refused'
  | 'tcp-timeout'
  | 'tls-fail'
  | 'http-fail'
  /** 有关键层没查、又确实失败了：只能确认「没拿到应答」，不能定位到层。 */
  | 'inconclusive'
  | 'guard-rejected';

export type Confidence = 'high' | 'medium' | 'low';

export interface CapabilityReport {
  dns: boolean;
  tcp: boolean;
  tls: boolean;
  http: boolean;
  /** 未检查项的原因（空数组表示能力齐全）。 */
  unavailable: string[];
}

export interface NetProbeReport {
  target: string;
  host: string;
  verdict: NetVerdict;
  reachable: boolean;
  /** 第一个失败层（四步全过则为 undefined）。 */
  failedStep?: ProbeStep;
  confidence: Confidence;
  /** 归因结论：一句话说清卡在哪一层、为什么。 */
  attribution: string;
  steps: ProbeStepResult[];
  capabilities: CapabilityReport;
  /** DoH 拿到的真实 IP —— 只报告，绝不用于拨号。 */
  realIps?: string[];
  /** 可执行修复建议（给人看）。 */
  advice: string[];
  /** 宿主对探测出口路径的自陈（见 ProbeOptions.exitPathNote）。 */
  exitPathNote?: string;
  /** S2 单请求改写候选（t0/t1）：目标 URL 若有字节一致的镜像端点，列在这里。 */
  rewrites?: Array<{ url: string; trust: string; rule: string }>;
}

export class ProbeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeGuardError';
  }
}

// ── 可注入依赖（让探测在零真实网络下可测，也让 GUI 能只跑它能跑的两层）──

export interface TcpProbeOk {
  ok: true;
  ms: number;
  localPort: number;
}

export interface TcpProbeErr {
  ok: false;
  ms: number;
  code: string;
  /** refused = 对端秒回 RST（IP 对、端口错）；timeout = SYN 被静默丢弃。 */
  kind: 'refused' | 'timeout' | 'unreachable' | 'other';
}

export interface TlsProbeOk {
  ok: true;
  ms: number;
  /** 证书是否匹配目标域名（SNI 已带，此处独立校验 CN/SAN）。 */
  certMatches: boolean;
  certSubject?: string;
  certIssuer?: string;
}

export interface TlsProbeErr {
  ok: false;
  ms: number;
  code: string;
  reason: string;
}

/** HTTP 层探测：默认用 fetch 跑一次真实 GET；GUI 注入走 Rust 的版本。 */
export type HttpProbe = (url: string, host: string, timeoutMs: number) => Promise<ProbeStepResult>;

export interface ProbeDeps {
  /** 显式传 null 表示「本运行环境没有 fetch 原语」——与「不传，用全局 fetch」不同。 */
  fetchImpl?: typeof fetch | null;
  tcpProbe?: ((host: string, port: number, timeoutMs: number) => Promise<TcpProbeOk | TcpProbeErr>) | null;
  tlsProbe?: ((host: string, port: number, timeoutMs: number) => Promise<TlsProbeOk | TlsProbeErr>) | null;
  /** 不传 = 用 fetch 版默认实现；传 null = 本宿主没有可用的 HTTP 探测原语。 */
  httpProbe?: HttpProbe | null;
}

/** 缺原语时的能力自陈文案。宿主不同，措辞不同（CLI 说 node:net，GUI 说 WebView）。 */
export interface UnavailableNotes {
  dns?: string;
  tcp?: string;
  tls?: string;
  http?: string;
}

function nowMs(): number {
  return Date.now();
}

/** 证书是否覆盖目标域名：SAN 优先（现代证书只有 SAN），退回 CN。纯字符串判定，两端共用。 */
export function certMatchesHost(subjectAltName: string | undefined, commonName: string | undefined, host: string): boolean {
  const target = host.toLowerCase();
  if (subjectAltName) {
    for (const entry of subjectAltName.split(',')) {
      const pattern = entry.trim().toLowerCase();
      if (!pattern) continue;
      if (pattern.startsWith('dns:')) {
        const name = pattern.slice(4);
        if (name === target) return true;
        if (name.startsWith('*.') && target.endsWith(name.slice(1)) && target.split('.').length === name.split('.').length) return true;
      }
    }
  }
  if (commonName && commonName.toLowerCase() === target) return true;
  return false;
}

/** 「未检查」步骤的统一形状：ms=0 + 说明为什么没查，绝不假装查过。 */
export function skippedStep(step: ProbeStep, summary: string): ProbeStepResult {
  return { step, status: 'skipped', ms: 0, summary };
}

// ── 第 1 步：DNS（DoH）──

interface DohAnswerPayload {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/** DoH JSON 的 NXDOMAIN 状态码：域名不存在（与「解析失败/被阻断」是两回事）。 */
const DNS_STATUS_NXDOMAIN = 3;

export interface DnsProbeOutcome {
  step: ProbeStepResult;
  ips: string[];
  state: 'clean' | 'polluted' | 'empty';
  /** 至少一家 DoH 通道返回了合法应答（哪怕答的是 NXDOMAIN）。 */
  answered: number;
  /** 所有应答一致为 NXDOMAIN。 */
  nxdomain: boolean;
}

/**
 * DoH 探测。CLI 与 GUI 都用这一份（端点表可覆盖：WebView 里 CORS 会掐掉几家，
 * 但「四家并行、任意一家成功即可」的判据不变）。
 */
export async function probeDnsStep(
  host: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  endpoints: readonly string[] = DOH_ENDPOINTS,
): Promise<DnsProbeOutcome> {
  const started = nowMs();
  const attempts = endpoints.map(async (endpoint) => {
    const url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`;
    try {
      const resp = await fetchImpl(url, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as DohAnswerPayload;
      // 拿到 JSON 就说明**这条 DoH 通道是通的**——哪怕它答的是 NXDOMAIN。
      // 把 Status!=0 一律当 null 会把「域名不存在」误报成「DoH 被阻断」，
      // 而这两者的下一步动作完全相反（一个去核对域名，一个去查代理）。
      if (typeof data.Status !== 'number') return null;
      const ips = (data.Answer ?? [])
        .filter((a) => a.type === 1 && typeof a.data === 'string')
        .map((a) => (a.data as string).trim());
      return { status: data.Status, ips };
    } catch {
      return null;
    }
  });

  // 任意一家成功即可（GFW 对 DoH 的阻断是概率性的，四家并行摊掉这个风险）。
  const settled = await Promise.allSettled(attempts);
  const ips: string[] = [];
  let okCount = 0;
  let nxdomain = 0;
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) {
      okCount += 1;
      if (s.value.status === DNS_STATUS_NXDOMAIN) nxdomain += 1;
      for (const ip of s.value.ips) if (!ips.includes(ip)) ips.push(ip);
    }
  }
  const ms = nowMs() - started;
  const state = classifyDnsAnswers(ips);
  const step: ProbeStepResult = okCount === 0
    ? {
        step: 'dns',
        status: 'fail',
        ms,
        summary: `四家 DoH 全部失败（${endpoints.length} 家在 ${ms}ms 内无有效应答）——DoH 本身被阻断或本机到 DoH 不通`,
        detail: { dohEndpoints: endpoints.length, answered: 0 },
      }
    : nxdomain === okCount
      ? {
          step: 'dns',
          status: 'fail',
          ms,
          summary: `${okCount}/${endpoints.length} 家 DoH 一致回答 NXDOMAIN：域名不存在。这是名字写错或域名已注销，与网络无关。`,
          detail: { answered: okCount, nxdomain: true, realIps: [] },
        }
      : state === 'polluted'
        ? {
            step: 'dns',
            status: 'fail',
            ms,
            summary: `DNS 污染：${okCount}/${endpoints.length} 家 DoH 一致返回保留段地址 ${ips.join(', ')}`,
            detail: { answered: okCount, realIps: ips, pollution: 'all-reserved' },
          }
        // 「拿到了应答」不等于「拿到了地址」：NOERROR 空应答（域名只有 AAAA）
        // 与 SERVFAIL(2) 都会走到这里，两者都没有 A 记录。判成 pass 会让报告
        // 自相矛盾——DNS 步写着「正常」却一个 IP 都没有，而后续层因非 clean
        // 全被跳过，只剩 TCP 通过就能落进尾部的 reachable 分支，最终对一个
        // 根本解析不出地址的域名报「可达」。宁可当失败，让它走到 dns-empty 归因。
        : ips.length === 0
          ? {
              step: 'dns',
              status: 'fail',
              ms,
              summary: `${okCount}/${endpoints.length} 家 DoH 给出了应答，但没有一条 A 记录（NOERROR 空应答或 SERVFAIL）——解析器此刻给不出可用地址`,
              detail: { answered: okCount, realIps: [] },
            }
          : {
              step: 'dns',
              status: 'pass',
              ms,
              summary: `DNS 正常：${okCount}/${endpoints.length} 家 DoH 返回 ${ips.join(', ')}`,
              detail: { answered: okCount, realIps: ips },
            };
  return { step, ips, state, answered: okCount, nxdomain: nxdomain === okCount && okCount > 0 };
}

// ── 第 4 步：HTTP（fetch 版默认实现）──

/**
 * CONNECT 隧道响应检测。`200 Connection established` 是 HTTP 代理对 CONNECT
 * 方法的应答，**不是目标站点的响应**——把它算作「HTTP 层通过」会让探测在
 * 「代理只完成隧道、目标站其实拒绝」时误报为通。
 */
function isConnectTunnelResponse(status: number, bodyPrefix: string): boolean {
  if (status !== 200) return false;
  return /^connection established/i.test(bodyPrefix.trim());
}

/** 默认 HTTP 层探测（CLI 与任何有可用 fetch 的宿主）。 */
export async function fetchHttpProbe(
  url: string,
  host: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeStepResult> {
  const started = nowMs();
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'GET',
      // redirect: manual 是必须的：跟随跳转后可能落到一个 CDN 错误页上，那会
      // 把「目标站拒绝」伪装成「拿到了首页」。
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'pure-netprobe/1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      step: 'http',
      status: 'fail',
      ms: nowMs() - started,
      summary: `HTTP 请求失败：${(err as Error).message}`,
      detail: { error: (err as Error).message },
    };
  }
  const ms = nowMs() - started;

  let prefix = '';
  try {
    const lenHeader = Number(resp.headers.get('content-length') ?? '0');
    if (Number.isFinite(lenHeader) && lenHeader > 0 && lenHeader <= 4096) {
      prefix = (await resp.text()).slice(0, 64);
    } else {
      // 大响应不整体读取：只读流的前 64 字节，够识别 CONNECT 隧道应答，
      // 又不会为了一个诊断把整页/整文件拉下来。
      const reader = resp.body?.getReader();
      if (reader) {
        const first = await reader.read();
        prefix = new TextDecoder().decode(first.value ?? new Uint8Array()).slice(0, 64);
        reader.cancel().catch(() => { /* released */ });
      }
    }
  } catch {
    prefix = '';
  }

  if (isConnectTunnelResponse(resp.status, prefix)) {
    return {
      step: 'http',
      status: 'fail',
      ms,
      summary: `收到 200 "Connection established"——这是 HTTP 代理的 CONNECT 隧道应答，不是目标站点的响应；代理只打通了隧道，目标站点实际未被验证`,
      detail: { status: resp.status, connectTunnel: true, bodyPrefix: prefix.slice(0, 32) },
    };
  }

  // 只看「有没有拿到任何响应」，不看状态码：403 = 通但被拒（网络层完全正常，
  // 该换凭据或换源，而不是换网络）；2xx/3xx/401/403 都证明链路健康。
  return {
    step: 'http',
    status: 'pass',
    ms,
    summary: `HTTP ${resp.status} ${resp.statusText || ''}`.trim() + `（${ms}ms）——目标站点给出了响应，网络层可达`,
    detail: {
      status: resp.status,
      // 403 是最容易被误读的信号：它证明链路通到「业务层拒绝」，此时换镜像
      // 是错的方向（镜像同样会 403），正确方向是换凭据/换用户。
      rejectedButReachable: resp.status === 401 || resp.status === 403,
      location: resp.headers.get('location') ?? undefined,
    },
  };
}

// ── 归因与建议 ──

interface Attribution {
  verdict: NetVerdict;
  failedStep?: ProbeStep;
  confidence: Confidence;
  attribution: string;
  advice: string[];
}

/** HTTP 层失败时，宿主是否已经定位到具体成因（GUI 的 Rust 判定能做到这一点）。 */
const CLASSIFIED = 'classified';

function attribute(
  steps: ProbeStepResult[],
  dnsState: 'clean' | 'polluted' | 'empty',
  dnsAnswered: number,
  dnsNxdomain: boolean,
): Attribution {
  const byStep = (s: ProbeStep): ProbeStepResult | undefined => steps.find((x) => x.step === s);

  if (dnsNxdomain) {
    return {
      verdict: 'dns-nxdomain',
      failedStep: 'dns',
      confidence: 'high',
      attribution: '权威 DoH 解析器一致回答 NXDOMAIN：这个域名不存在。与网络无关——换代理、换镜像、加 NO_PROXY 都不会让它出现。',
      advice: [
        '先核对域名拼写。权威解析器明确说它不存在，多半是拼错、少了一个后缀，或域名已注销。',
        '确认拼写无误仍 NXDOMAIN，说明该域名已停止解析：换一个真实存在的源，不要在这里继续排查网络。',
        '若域名正确但你确信它该存在，检查你的 DNS 上游或 /etc/hosts 里是否留了把该域名指向无效地址的旧条目（本工具不修改它们）。',
      ],
    };
  }
  if (dnsAnswered === 0) {
    return {
      verdict: 'dns-fail',
      failedStep: 'dns',
      confidence: 'medium',
      attribution: 'DNS 层拿不到任何可信应答（DoH 全被阻断或本机到 DoH 不通）：DoH 通道本身被阻断或本机到 DoH 不通，DNS 层结论不可用，因此**无法判定**目标是否可达——注意这不等于目标不可达，只等于无法判定。',
      advice: [
        '先确认本机到公共 DoH 是否可达：在浏览器打开 https://dns.alidns.com/resolve?name=example.com&type=A 看是否有 JSON 返回。',
        '若 DoH 也不可达，问题在「本机 → 公网」这一段（代理未生效 / 网关故障），与目标站点无关。',
        '若你能提供可用的 HTTP 代理，设置 HTTPS_PROXY 后重试；不要试图改系统 DNS（本工具不接管 DNS）。',
      ],
    };
  }
  if (dnsState === 'polluted') {
    return {
      verdict: 'dns-polluted',
      failedStep: 'dns',
      confidence: 'high',
      attribution: 'DNS 被污染：权威 DoH 解析器一致返回保留段地址。后续 TCP/TLS/HTTP 三步在污染场景下没有诊断价值（本机对保留段地址的 443 必然被拒），所以直接归因到 DNS 层。',
      advice: [
        '结论是「DNS 层被污染」，不是「站点挂了」——换镜像源通常能绕过，因为镜像是国内域名、不走被污染的解析路径。',
        '让用户配置一个可用的 HTTP 代理（HTTPS_PROXY 环境变量）后重试，这是唯一不碰系统配置的解法。',
        '不要建议改 /etc/hosts 或改系统 DNS：前者需要管理员权限且掩盖真实故障，后者在 Linux 上被 systemd-resolved 接管、macOS/Windows 上根本不生效。',
        `真实 IP 已在上方列出，仅供诊断参考——不要拿它直连并自造 Host/SNI 头，那既治不了根（Gfw 匹配 SNI）也会制造异常流量。`,
      ],
    };
  }
  // 空应答：DoH 通道是通的（answered > 0）但给不出 A 记录。它不是污染，也
  // 不是「DNS 被阻断」，因此既不能判可达也不能借用别的层结论——只能如实说
  // 「此刻解析不出地址」。此分支必须在 tcp/tls/http 之前：解析不出地址就无从
  // 谈「DNS 正常但 SYN 被丢弃」之类。
  if (dnsState === 'empty') {
    return {
      verdict: 'dns-empty',
      failedStep: 'dns',
      confidence: 'medium',
      attribution: 'DoH 通道拿到了应答，但没有一条 A 记录（NOERROR 空应答或 SERVFAIL）：解析器此刻给不出可用地址，因此**无法判定**目标是否可达——这不等于目标不可达，也不等于 DNS 污染。',
      advice: [
        '先核对域名：只有 AAAA 记录、或解析器临时 SERVFAIL，都会长这样；用 diagnose_network 换一个 type 或稍后重试即可。',
        '若域名确定有 A 记录，说明当前 DoH 上游答不出来（被限流/故障），换代理或换网络再试。',
        '不要据此改 /etc/hosts 或系统 DNS：本工具不接管 DNS，也没有证据表明本地解析被污染。',
      ],
    };
  }

  const tcp = byStep('tcp');
  if (tcp?.status === 'fail') {
    const kind = tcp.detail?.kind;
    if (kind === 'timeout') {
      return {
        verdict: 'tcp-timeout',
        failedStep: 'tcp',
        confidence: 'high',
        attribution: 'DNS 正常但 SYN 被静默丢弃（等满超时无 RST）。这是「IP 可路由、端口被丢包」的典型形态——墙或出口防火墙丢 SYN 时不回任何响应，与「主机宕机」的表现不同（宕机会秒回 RST）。',
        advice: [
          '改用代理（设置 HTTPS_PROXY）或换国内可达的镜像源；重试同一目标不会变好，SYN 丢弃是确定性的。',
          '若走代理仍然超时，检查代理是否只对特定网段放行。',
          '可以对照 diagnose_network 探测一个已知通的域名（如 https://mirrors.aliyun.com/）以区分「全局断网」与「按域名屏蔽」。',
        ],
      };
    }
    if (kind === 'refused') {
      return {
        verdict: 'tcp-refused',
        failedStep: 'tcp',
        confidence: 'high',
        attribution: '对端秒回 RST（ECONNREFUSED）：IP 是对的、路由是通的，但 443 端口上没有服务。这与「被墙」是相反的结论——被墙会超时，秒回说明根本没拦你。',
        advice: [
          '换目标端点（很多站只开 80 或特定路径），或确认该域名是否已停止服务/改了端口。',
          '不要换镜像：镜像解决的是「可达性」，而这里端口本身是通的。',
          '如果目标其实是 http:// 站点（本工具探测 443），请改用其真实协议再测一次。',
        ],
      };
    }
    return {
      verdict: 'tcp-timeout',
      failedStep: 'tcp',
      confidence: 'medium',
      attribution: `TCP 连接失败：${String(tcp.detail?.code ?? tcp.summary)}。`,
      advice: ['检查本机网络与代理设置；换用国内可达的镜像源作为替代路径。'],
    };
  }

  // 证书不匹配必须先于泛化的 TLS 失败判定：握手本身是通的（步骤带 certMatches
  // 字段），只是拿到的证书不是目标域名——这是「IP 指向了别的站（劫持/CDN 回
  // 错站）」的强信号，与「握手被 RST」是两个方向完全不同的修法。此前这条分支
  // 写在 `status === 'pass' && certMatches === false` 下，而 certMatches 为假时
  // 该步已被写成 fail，条件恒不成立，专用归因成了死代码——证书不匹配一律被
  // 泛化成「TLS 握手失败」。
  const tls = byStep('tls');
  if (tls?.status === 'fail' && tls.detail?.certMatches === false) {
    return {
      verdict: 'tls-fail',
      failedStep: 'tls',
      confidence: 'high',
      attribution: 'TLS 握手成功但证书不匹配目标域名：SNI 拿到了另一张证书，说明这个 IP 不是你要的那个站（典型是 DNS 指向了被劫持的地址，或 CDN 回错了默认站点）。',
      advice: [
        '这已经接近「被劫持」而非「不通」：先换镜像源或代理，DNS 层已判定非污染，所以更可能是目标侧的调度问题。',
        '把上面的 realIps 与 diagnose_network 探测到的实际握手对象一起报告给用户，不要自行拼 Host 头硬连。',
      ],
    };
  }
  if (tls?.status === 'fail') {
    return {
      verdict: 'tls-fail',
      failedStep: 'tls',
      confidence: 'high',
      attribution: 'TCP 通了但 TLS 握手失败：链路到端口是通的，坏在 TLS 层——常见于中间设备 RST、SNI 被阻断、或证书校验失败。',
      advice: [
        '若是证书错误（如 SELF_SIGNED_CERT_CHAIN）：站点证书链有问题或本机 CA 库过期，本工具**不会**建议安装自签 CA 或跳过校验。',
        '若是连接被重置：典型的 TLS 阻断（按 SNI 识别并 RST），改用代理或换镜像源。',
        '企业网络做 TLS 审计时会替换证书；此时所有 https 目标都会失败，请对照探测一个已知可信的站点确认。',
      ],
    };
  }

  const http = byStep('http');
  if (http?.status === 'fail') {
    // 宿主已经定位到成因（GUI 的 Rust 侧能区分「被劫持」「5xx」「被拒」）时，
    // 直接采信它的结论；否则有关键层没查过，只能报 inconclusive。
    const classified = http.detail?.[CLASSIFIED] === true;
    const layerUnknown = tcp?.status === 'skipped' || tls?.status === 'skipped';
    const hostAdvice = Array.isArray(http.detail?.advice)
      ? (http.detail?.advice as string[])
      : undefined;
    if (!classified && layerUnknown) {
      return {
        verdict: 'inconclusive',
        failedStep: 'http',
        confidence: 'low',
        attribution: `DNS 正常但 HTTP 未拿到应答（${http.summary}），而 TCP 与 TLS 两层在本宿主没有独立验证的原语——只能确认「HTTP 层没拿到应答」，无法判定卡在哪一层。归因不可靠，不要据此断定是 DNS 问题。`,
        advice: [
          '在能跑套接字与证书校验的宿主（CLI 环境的 diagnose_network）重跑一次：那里可以逐层区分 TCP 超时、TLS 握手失败与证书不匹配。',
          '若本机配置了代理，先用设置里的「测试连接」确认代理本身可达。',
        ],
      };
    }
    return {
      verdict: 'http-fail',
      failedStep: 'http',
      confidence: classified ? 'medium' : 'medium',
      attribution: `TCP 与 TLS 都通，但 HTTP 请求没能拿到响应：网络链路是通的，问题在 HTTP 层（代理认证、CDN 拒绝连接、或响应被中途丢弃）。${http.summary}`,
      advice: hostAdvice ?? [
        '若是代理认证失败（407），让用户提供带凭据的代理 URL。',
        '若是响应体为空但状态码缺失，检查中间设备是否在 TLS 解密后丢弃了响应。',
      ],
    };
  }

  // 全过：措辞必须与「有没有未检查的层」一致。GUI 只有 DNS/HTTP 两层，
  // 说「四步全过」就是在编造它没做过的事。
  const hasSkip = steps.some((s) => s.status === 'skipped');
  return {
    verdict: 'reachable',
    confidence: hasSkip ? 'medium' : 'high',
    attribution: hasSkip
      ? '已检查的层全部通过（DNS 非污染、HTTP 拿到目标站点的真实响应）；未检查的层在本宿主没有原语，因此不宣称「四步全过」。'
      : '四步全过：DNS 非污染、TCP 443 握手成功、TLS 带 SNI 握手成功且证书匹配目标域名、HTTP 拿到目标站点的真实响应。可判定为业务可达。',
    advice: ['无需换源。若后续仍出现下载慢，那属于带宽/限速问题，不是连通性问题——换镜像依然有效，但那不是本工具的判断范围。'],
  };
}

function buildCapabilities(
  deps: { tcpProbe?: unknown; tlsProbe?: unknown; httpProbe?: unknown },
  fetchImpl: typeof fetch | null,
  notes: UnavailableNotes = {},
): CapabilityReport {
  const unavailable: string[] = [];
  const dns = Boolean(fetchImpl);
  const tcp = Boolean(deps.tcpProbe);
  const tls = Boolean(deps.tlsProbe);
  const http = Boolean(deps.httpProbe);
  if (!dns) unavailable.push(notes.dns ?? 'DNS/DoH：运行环境没有可用的 fetch 原语');
  if (!tcp) unavailable.push(notes.tcp ?? 'TCP：本运行环境没有 node:net 连接原语');
  if (!tls) unavailable.push(notes.tls ?? 'TLS：本运行环境没有 node:tls 握手原语');
  if (!http) unavailable.push(notes.http ?? 'HTTP：本运行环境没有可用的 fetch 原语');
  return { dns, tcp, tls, http, unavailable };
}

/** 宿主注入的 HTTP 层结果若已自带成因，用这两个 helper 标记它。 */
export function httpStepFromClassified(
  summary: string,
  reason: string,
  advice?: readonly string[],
): ProbeStepResult {
  return {
    step: 'http',
    status: 'fail',
    ms: 0,
    summary,
    detail: { [CLASSIFIED]: true, reason, ...(advice ? { advice } : {}) },
  };
}

// ── 主入口 ──

export interface ProbeOptions {
  allowlist?: readonly string[];
  denylist?: readonly string[];
  /** 端口，默认 443。 */
  port?: number;
  deps?: ProbeDeps;
  /** 缺原语时的能力自陈文案（宿主特有）。 */
  unavailableNotes?: UnavailableNotes;
  /** DoH 端点覆盖（宿主特有，例如 WebView 只敢列其中几家）。 */
  dohEndpoints?: readonly string[];
  /**
   * 宿主对「探测拨号走哪条出口」的自陈。设置后随报告一起呈现给模型。
   *
   * 存在的理由是一处会让归因指错方向的现实：TCP / TLS 是裸套接字拨号，**不经过
   * 应用代理**，而 DoH 与 HTTP 走宿主的出口路由（含代理）。在「必须走代理才通」
   * 的网络里，直连 TCP 会超时并把结论写成 tcp-timeout，可真实下载路径其实是通的。
   * 核心不知道宿主怎么拨号，只能由宿主如实声明。
   */
  exitPathNote?: string;
}

/**
 * 对一个目标做四步分层探测。
 *
 * 抛 `ProbeGuardError` 表示**根本没开始探测**（护栏拒绝）；返回报告里
 * `reachable === false` 表示探测跑完并给出了归因。这两者的区别很重要：前者是
 * 「你的请求不合法」，后者是「我查过了，通不了」，模型对二者的下一步动作完全
 * 不同。
 *
 * TCP / TLS 的原语必须由宿主注入（`deps.tcpProbe` / `deps.tlsProbe`）：核心层
 * 不知道 socket 怎么开，CLI 适配层才知道（见 src/shared/node/netProbe.ts）。
 */
export async function diagnoseNetwork(rawTarget: string, opts: ProbeOptions = {}): Promise<NetProbeReport> {
  const check = checkProbeTarget(rawTarget, { allowlist: opts.allowlist, denylist: opts.denylist });
  if (!check.ok || !check.url || !check.host) {
    throw new ProbeGuardError(check.reason ?? '目标被护栏拒绝');
  }
  const target = check.url;
  const host = check.host;
  const port = opts.port ?? 443;
  // 四种原语都是三态：不传 = 用宿主默认/真实实现；传 null = 本运行环境没有
  // 该原语（能力自陈要用）；传函数 = 打桩。把它压成 `?? default` 会让调用方
  // 无法声明「没有」，而「假装检查过」比「明说没检查」危险得多。
  const deps = opts.deps ?? {};
  const fetchImpl = 'fetchImpl' in deps
    ? (deps.fetchImpl ?? null)
    : (typeof fetch === 'function' ? fetch : null);
  const tcpProbe = deps.tcpProbe ?? null;
  const tlsProbe = deps.tlsProbe ?? null;
  const httpProbe: HttpProbe | null = 'httpProbe' in deps
    ? (deps.httpProbe ?? null)
    : fetchImpl ? (url, h, t) => fetchHttpProbe(url, h, fetchImpl, t) : null;
  const capabilities = buildCapabilities({ tcpProbe, tlsProbe, httpProbe }, fetchImpl, opts.unavailableNotes);

  const steps: ProbeStepResult[] = [];

  // ── 1 DNS ──
  let ips: string[] = [];
  let dnsState: 'clean' | 'polluted' | 'empty' = 'empty';
  // answered / nxdomain 必须与「这一步 pass 了吗」分开：污染与 NXDOMAIN 时
  // step 都是 fail，但「拿到了权威应答」这件事成立。归因只看 pass/fail 会把
  // 污染误报成「DoH 全被阻断」，把 NXDOMAIN 误报成同一句——两者下一步动作
  // 完全不同（一个查代理，一个核对域名）。
  let dnsAnswered = 0;
  let dnsNxdomain = false;
  if (capabilities.dns && fetchImpl) {
    const dns = await probeDnsStep(host, fetchImpl, PROBE_TIMEOUTS.dns, opts.dohEndpoints ?? DOH_ENDPOINTS);
    ips = dns.ips;
    dnsState = dns.state;
    dnsAnswered = dns.answered;
    dnsNxdomain = dns.nxdomain;
    steps.push(dns.step);
  } else {
    steps.push(skippedStep('dns', `未检查：${opts.unavailableNotes?.dns ?? '本运行环境缺少 DNS/DoH 探测原语'}`));
  }

  // ── 2 TCP ──
  let tcpStep: ProbeStepResult;
  if (capabilities.tcp && tcpProbe) {
    const r = await tcpProbe(host, port, PROBE_TIMEOUTS.tcp);
    tcpStep = r.ok
      ? { step: 'tcp', status: 'pass', ms: r.ms, summary: `TCP ${port} 握手成功（${r.ms}ms）`, detail: { port, localPort: r.localPort } }
      : {
          step: 'tcp',
          status: 'fail',
          ms: r.ms,
          summary: r.kind === 'refused'
            ? `TCP ${port} 被对端拒绝（ECONNREFUSED，${r.ms}ms）——IP 对但端口无服务`
            : r.kind === 'timeout'
              ? `TCP ${port} 超时（${r.ms}ms 无响应）——SYN 被静默丢弃`
              : r.kind === 'unreachable'
                ? `TCP ${port} 主机不可达（${r.code}，${r.ms}ms）`
                : `TCP ${port} 连接失败（${r.code}，${r.ms}ms）`,
          detail: { port, code: r.code, kind: r.kind },
        };
  } else {
    tcpStep = skippedStep('tcp', `未检查：${opts.unavailableNotes?.tcp ?? '本运行环境缺少 node:net 连接原语'}`);
  }
  steps.push(tcpStep);

  // 污染时后三步没有诊断价值（对保留段地址的 443 必然被拒），继续跑只是烧掉
  // 11 秒预算去确认一个已知答案——这就是「污染时直接归因到 DNS 层」的含义。
  if (dnsAnswered && dnsState === 'clean') {
    // ── 3 TLS ──
    let tlsFailed = false;
    if (capabilities.tls && tlsProbe) {
      const r = await tlsProbe(host, port, PROBE_TIMEOUTS.tls);
      tlsFailed = !r.ok || !r.certMatches;
      steps.push(r.ok
        ? {
            step: 'tls',
            status: r.certMatches ? 'pass' : 'fail',
            ms: r.ms,
            summary: r.certMatches
              ? `TLS 握手成功且证书匹配 ${host}（${r.ms}ms）`
              : `TLS 握手成功但证书不匹配 ${host}（实际：${r.certSubject ?? '未知'}）`,
            detail: { certMatches: r.certMatches, certSubject: r.certSubject, certIssuer: r.certIssuer, servername: host },
          }
        : {
            step: 'tls',
            status: 'fail',
            ms: r.ms,
            summary: r.reason,
            detail: { code: r.code, servername: host },
          });
    } else {
      steps.push(skippedStep('tls', `未检查：${opts.unavailableNotes?.tls ?? '本运行环境缺少 node:tls 握手原语'}`));
    }

    // ── 4 HTTP ──
    // TLS 真的失败时不发 HTTP：对一个握手失败的目标发 HTTP 只会得到同一个
    // TLS 错误，把它算成「HTTP 层也失败」会污染归因（看起来像两个独立问题）。
    // 但 TLS 只是**缺原语**（skipped）时仍然发——fetch 自己会完成 TLS 握手，
    // 这一步的通过本身就是 TLS 层可用的证据。
    if (!tlsFailed && capabilities.http && httpProbe) {
      steps.push(await httpProbe(target, host, PROBE_TIMEOUTS.http));
    } else {
      steps.push(skippedStep('http', capabilities.http && httpProbe
        ? '未检查：TLS 层握手失败，对握手失败的目标发 HTTP 只会复现同一个错误'
        : `未检查：${opts.unavailableNotes?.http ?? '本运行环境缺少 fetch 原语'}`));
    }
  } else {
    for (const s of ['tls', 'http'] as ProbeStep[]) {
      steps.push(skippedStep(s, dnsState === 'polluted'
        ? '未检查：DNS 已判定污染，对保留段地址的该层探测没有诊断价值'
        : '未检查：DNS 层未能确认目标可达，跳过后续层'));
    }
  }

  const verdictInfo = attribute(steps, dnsState, dnsAnswered, dnsNxdomain);
  const hasSkip = steps.some((s) => s.status === 'skipped');
  const reachable = verdictInfo.verdict === 'reachable'
    && !steps.some((s) => s.status === 'fail');
  // S2 单请求改写：诊断出「不可达」之后，最便宜的解药往往不是配代理，而是把
  // 这一次请求换到一个字节一致的镜像端点上。这里只把候选列进报告与建议，
  // 不替模型做决定（本工具只诊断，不接管）——但把「有什么现成改法」摆到它眼前。
  const rewrites = sourceRewriteCandidates(target);
  const advice = (!reachable && rewrites.length > 0)
    ? [
        `无需先配代理：这个 URL 有一个字节一致的镜像端点——单请求改写为 ${rewrites[0].url}（${rewrites[0].rule}），不落盘、可自回退。`,
        ...verdictInfo.advice,
      ]
    : verdictInfo.advice;
  return {
    target,
    host,
    verdict: verdictInfo.verdict,
    reachable,
    ...(verdictInfo.failedStep ? { failedStep: verdictInfo.failedStep } : {}),
    // 有任何一步未检查就把置信度降一档：四步里少看了两步的「通」不能和
    // 四步全过同等看待——尤其在「宁可多花 200ms 确认」的判据下。
    confidence: reachable && hasSkip ? 'medium' : verdictInfo.confidence,
    attribution: verdictInfo.attribution,
    steps,
    capabilities,
    ...(ips.length > 0 ? { realIps: ips } : {}),
    advice,
    ...(opts.exitPathNote ? { exitPathNote: opts.exitPathNote } : {}),
    ...(rewrites.length > 0 ? { rewrites: rewrites.map((r) => ({ url: r.url, trust: r.trust, rule: r.rule })) } : {}),
  };
}

// ── 报告渲染 ──

/** 给模型看的紧凑结构化文本：分步结果 + 归因，一屏读完。 */
export function renderProbeReport(report: NetProbeReport): string {
  const lines: string[] = [];
  const hasSkip = report.steps.some((s) => s.status === 'skipped');
  lines.push(`目标：${report.target}`);
  lines.push(`结论：${report.reachable
    ? (hasSkip ? '可达（已检查的层全过，另有层未检查）' : '可达（四步全过）')
    : '不可达'}｜归因=${report.verdict}｜失败层=${report.failedStep ?? '无'}｜置信度=${report.confidence}`);
  lines.push('分步结果：');
  for (const s of report.steps) {
    lines.push(`  [${s.status === 'pass' ? 'OK  ' : s.status === 'fail' ? 'FAIL' : 'SKIP'}] ${s.step.toUpperCase().padEnd(4)} ${s.summary}`);
  }
  if (report.realIps?.length) {
    lines.push(`DoH 真实 IP（仅报告，未用于拨号）：${report.realIps.join(', ')}`);
  }
  if (report.capabilities.unavailable.length > 0) {
    lines.push(`能力自陈：${report.capabilities.unavailable.join('；')}`);
  }
  if (report.exitPathNote) {
    lines.push(`探测出口：${report.exitPathNote}`);
  }
  if (report.rewrites?.length) {
    lines.push(`可改写路径（单请求，字节一致的镜像端点）：${report.rewrites.map((r) => `${r.url} [${r.trust}]`).join('；')}`);
  }
  lines.push(`归因：${report.attribution}`);
  return lines.join('\n');
}

/** 给人看的报告：在结构化结果之上追加可执行修复建议。 */
export function renderProbeReportForHuman(report: NetProbeReport): string {
  const lines = [renderProbeReport(report), '', '修复建议：'];
  report.advice.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  return lines.join('\n');
}