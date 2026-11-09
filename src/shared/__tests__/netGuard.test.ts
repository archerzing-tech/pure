// src/shared/__tests__/netGuard.test.ts
// Covers the host circuit breaker + failure classification shared by the GUI
// and CLI tool adapters: two consecutive network failures trip a host, the
// blocked window fails instantly with a skip directive, any success clears
// it, and classifyFailure maps real error strings to recovery classes.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  HIJACK_BLOCKPAGE_PATTERNS,
  HIJACK_JS_SCAN_CHARS,
  HIJACK_META_REFRESH_MAX_DELAY_SECS,
  HIJACK_VISIBLE_TEXT_MAX_CHARS,
  JS_ASSIGN_RE,
  JS_REPLACE_RE,
  MULTI_LABEL_PUBLIC_SUFFIXES,
  blockedHostMessage,
  blockedHosts,
  classifyFailure,
  detectHijack,
  detectResponseHijack,
  hijackErrorMessage,
  hijackReason,
  hostBlocked,
  hostOf,
  isGatewayBlockedText,
  isHtmlContentType,
  isNetworkError,
  isPayloadIndependentHttp4xx,
  isProviderHttp4xx,
  netFailureHint,
  parseProviderContextLimit,
  recordNetFailure,
  recordNetSuccess,
  registrableDomain,
  sameRegistrableSite,
  visibleTextLength,
} from '../netGuard';

beforeAll(() => {
  // bun test is single-process and file order drifts with the file set: an
  // earlier test file's happy-dom registration may still be up when we load
  // (2026-10-18 full-suite case: register() throws "already registered").
  // A leftover registration is equivalent for our purposes — its DOM is the
  // same fresh happy-dom — so consume it instead of dying on it.
  try {
    GlobalRegistrator.register();
  } catch {
    GlobalRegistrator.unregister();
    GlobalRegistrator.register();
  }
  localStorage.removeItem('pure.netGuard.hosts.v1');
});
afterAll(() => GlobalRegistrator.unregister());

// ── P2-5b 劫持检测跨语言双锁（2026-11-04）──────────────────────────────
// 蓝图四之三刀序 5 的「劫持检测单源」：TS/Rust 两份运行时实现（netGuard.ts ↔
// lib.rs detect_response_hijack）在浏览器 bundle 与 Rust 传输层必须逐条一致，
// 但 Rust 不能 import TS——真单源不可达，机械锁可达。两把锁：
//   锁 1（数据锁）：本文件直接读 lib.rs 源码，把 static_regex! 全表、后缀表、
//     三阈值与 TS 侧逐条比对——「逐条对齐」注释升格为机械断言，漂移即红。
//   锁 2（行为锁）：__fixtures__/hijackFixtures.json 共享 fixture，TS 与 Rust
//     测试同源消费，一侧改判定另一侧立刻现红。
// fenceRegistry 双向同源锁的跨语言同款哲学：锁管在场，不管实现形态。

import hijackFixtures from '../__fixtures__/hijackFixtures.json';

/** Rust raw string 字面量 → (pattern, rustFlags)：剥 (?flags) inline 前缀。 */
function rustPatternToJs(rust: string): { source: string; flags: string } {
  const m = /^\(\?([a-z]+)\)/.exec(rust);
  const flags = m ? m[1]! : '';
  return { source: rust.slice(m ? m[0].length : 0), flags };
}

/** JS RegExp.source 归一：①正则字面量里 / 被转义成 \/（Rust raw string 不转义）；
 *  ②Bun/JSC 的 source 对非 ASCII 输出 \uXXXX 转义（V8 保持明文）——序列化行为
 *  差异，两侧都解码到明文再比（判例 2026-11-04：Bun source 不可直接跨语言比对
 *  中文模式）。 */
function jsSource(re: RegExp): string {
  return unescapeUnicode(re.source.replace(/\\\//g, '/'));
}

function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

describe('hijack detection cross-language locks (P2-5b 劫持检测双锁)', () => {
  const rustSrc = readFileSync(new URL('../../../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  it('锁 1a — blockpage 指纹表与 Rust static_regex! 逐条相等且同序', () => {
    // 抽 Rust 侧全部 static_regex!(name, r"...") / r#"..."# 声明。
    const decls = new Map<string, string>();
    for (const m of rustSrc.matchAll(/static_regex!\(\s*(\w+)\s*,\s*r(#*)"(.*?)"\2\s*,?\s*\)/gs)) {
      decls.set(m[1]!, m[3]!);
    }
    // hijack_blockpage_patterns() 的 vec 顺序 = 权威顺序。
    const fnBody = rustSrc.match(/fn hijack_blockpage_patterns\(\)[\s\S]*?vec!\s*\[([\s\S]*?)\]/);
    expect(fnBody, 'Rust hijack_blockpage_patterns() must exist').toBeTruthy();
    const order = [...(fnBody![1]!.matchAll(/(hijack_\w+_re)\(\)/g))].map((m) => m[1]!);
    expect(order.length).toBe(HIJACK_BLOCKPAGE_PATTERNS.length);
    for (let i = 0; i < order.length; i++) {
      const rustPattern = decls.get(order[i]!);
      expect(rustPattern, `Rust decl for ${order[i]}`).toBeTruthy();
      const { source, flags } = rustPatternToJs(rustPattern!);
      const js = HIJACK_BLOCKPAGE_PATTERNS[i]!;
      expect(jsSource(js), `${order[i]} pattern body`).toBe(unescapeUnicode(source));
      expect(js.flags, `${order[i]} flags`).toBe(flags);
    }
  });

  it('锁 1b — JS 跳转两式与 Rust hijack_js_*_re 相等', () => {
    for (const [rustName, jsRe] of [
      ['hijack_js_assign_re', JS_ASSIGN_RE],
      ['hijack_js_replace_re', JS_REPLACE_RE],
    ] as const) {
      const m = new RegExp(`static_regex!\\(\\s*${rustName}\\s*,\\s*r(?:#*)"(.*?)"(?:#*)\\s*\\)`, 's').exec(rustSrc);
      expect(m, `Rust decl for ${rustName}`).toBeTruthy();
      const { source, flags } = rustPatternToJs(m![1]!);
      expect(jsSource(jsRe), rustName).toBe(source);
      expect(jsRe.flags, `${rustName} flags`).toBe(flags);
    }
  });

  it('锁 1c — 多标签公共后缀表与 Rust 数组集合相等', () => {
    const block = rustSrc.match(/const MULTI_LABEL_PUBLIC_SUFFIXES:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
    expect(block, 'Rust MULTI_LABEL_PUBLIC_SUFFIXES must exist').toBeTruthy();
    const rustEntries = [...(block![1]!.matchAll(/"([^"]+)"/g))].map((m) => m[1]!);
    expect(rustEntries.length).toBe(MULTI_LABEL_PUBLIC_SUFFIXES.size);
    for (const entry of rustEntries) {
      expect(MULTI_LABEL_PUBLIC_SUFFIXES.has(entry), `suffix "${entry}" missing in TS`).toBe(true);
    }
  });

  it('锁 1d — 三阈值常量两侧同值', () => {
    const rustConst = (name: string): string | undefined =>
      new RegExp(`const ${name}:\\s*\\w+\\s*=\\s*(\\d+);`).exec(rustSrc)?.[1];
    expect(rustConst('HIJACK_VISIBLE_TEXT_MAX_CHARS')).toBe(String(HIJACK_VISIBLE_TEXT_MAX_CHARS));
    expect(rustConst('HIJACK_META_REFRESH_MAX_DELAY_SECS')).toBe(String(HIJACK_META_REFRESH_MAX_DELAY_SECS));
    expect(rustConst('HIJACK_JS_SCAN_CHARS')).toBe(String(HIJACK_JS_SCAN_CHARS));
  });

  it('锁 2 — 行为 fixtures：与 Rust detect_response_hijack 同输入同 verdict', () => {
    const cases = (hijackFixtures as { cases: Array<{ name: string; requestUrl: string; finalUrl: string; contentType: string; body: string; expectSignal: string | null }> }).cases;
    expect(cases.length).toBeGreaterThanOrEqual(15);
    for (const c of cases) {
      const verdict = detectResponseHijack({ requestUrl: c.requestUrl, finalUrl: c.finalUrl, contentType: c.contentType, body: c.body });
      expect(verdict?.signal ?? null, `case "${c.name}"`).toBe(c.expectSignal);
    }
  });
});

describe('host circuit breaker', () => {
  it('extracts the host from a URL and rejects garbage', () => {
    expect(hostOf('https://cdn.example.com/a/lib.js')).toBe('cdn.example.com');
    expect(hostOf('not a url')).toBeNull();
  });

  it('distinguishes connection-level failures from HTTP status errors', () => {
    expect(isNetworkError('request: error sending request for url (https://nominatim.openstreetmap.org/search)')).toBe(true);
    expect(isNetworkError('Connection reset by peer')).toBe(true);
    expect(isNetworkError('请求超时：operation timed out after 8000ms')).toBe(true);
    // A 404 means the host answered — the resource is the problem, not the network.
    expect(isNetworkError('HTTP 404 not found')).toBe(false);
  });

  it('recognizes Bun 的真实连接失败措辞（连接拒绝 / DNS / 坏代理同一句）', () => {
    // Bun fetch 对 connection refused / DNS 失败 / 代理不可达 实测都吐同一句。
    // 只认 `connection` 会漏掉最常见的真实失败，兜底重试与熔断会静默失效。
    const bunMsg = 'Unable to connect. Is the computer able to access the url?';
    expect(isNetworkError(bunMsg)).toBe(true);
    expect(classifyFailure(bunMsg)).toBe('network');
    expect(isNetworkError('Unable to resolve host')).toBe(true);
  });

  it('trips after two consecutive network failures and blocks the host', () => {
    const url = 'https://dead-host.example.com/file.zip';
    expect(hostBlocked(url)).toBe(false);
    const first = recordNetFailure(url);
    expect(first.tripped).toBe(false);
    const second = recordNetFailure(url);
    expect(second.tripped).toBe(true);
    expect(hostBlocked(url)).toBe(true);
    expect(blockedHosts()).toContain('dead-host.example.com');
    // Other hosts are untouched.
    expect(hostBlocked('https://healthy.example.com/x')).toBe(false);
  });

  it('clears the trip on success and fails blocked hosts instantly with guidance', () => {
    const url = 'https://flaky-host.example.com/a';
    recordNetFailure(url);
    recordNetSuccess(url);
    recordNetFailure(url); // consecutive counter restarted — not tripped yet
    expect(hostBlocked(url)).toBe(false);

    recordNetFailure(url);
    recordNetFailure(url);
    expect(hostBlocked(url)).toBe(true);
    const msg = blockedHostMessage(url, 'connection reset');
    expect(msg).toContain('flaky-host.example.com');
    expect(msg).toContain('熔断');
    expect(msg).toContain('connection reset');
    expect(netFailureHint(url, 'timeout')).toContain('请勿原样重试');
  });

  it('S2 改写建议：有镜像端点的 URL 在失败文案里给出确切替代地址（无则不加）', () => {
    // npm tarball 有 npmmirror 镜像：文案必须带上确切 URL，而不是只教「换镜像」。
    const npm = netFailureHint('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', 'timeout');
    expect(npm).toContain('https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz');
    expect(npm).toContain('无需先配代理');
    // 熔断文案同样带上确切端点。
    expect(blockedHostMessage('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'))
      .toContain('https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz');
    // 没有镜像端点的普通 URL 不出现任何替代 URL。
    const plain = netFailureHint('https://no-mirror.example.com/a.tgz', 'timeout');
    expect(plain).not.toContain('可直接改用');
  });

  it('persists trip history so a NEW session inherits the planning knowledge', () => {
    const url = 'https://persist-dead.example.com/x';
    recordNetFailure(url);
    recordNetFailure(url); // trip → written to localStorage
    const stored = JSON.parse(localStorage.getItem('pure.netGuard.hosts.v1') ?? '[]') as { host: string }[];
    expect(stored.some(p => p.host === 'persist-dead.example.com')).toBe(true);

    // Simulate a fresh session: the in-memory cooldowns are gone, but the
    // planner brief (blockedHosts) still lists the historically dead host —
    // while hostBlocked (instant-fail) correctly does NOT, because the
    // cooldown may have expired and the host could have recovered.
    localStorage.setItem('pure.netGuard.hosts.v1', JSON.stringify([{ host: 'history-dead.example.com', lastTripAt: Date.now() }]));
    expect(blockedHosts()).toContain('history-dead.example.com');
    expect(hostBlocked('https://history-dead.example.com/a')).toBe(false);

    // Entries older than the 24h retention fall out of the brief.
    localStorage.setItem('pure.netGuard.hosts.v1', JSON.stringify([{ host: 'ancient.example.com', lastTripAt: Date.now() - 25 * 60 * 60_000 }]));
    expect(blockedHosts()).not.toContain('ancient.example.com');
  });
});

describe('classifyFailure', () => {
  it('maps real error strings to recovery classes', () => {
    expect(classifyFailure('request: error sending request for url (https://x)')).toBe('network');
    expect(classifyFailure('operation timed out after 30000ms')).toBe('timeout');
    expect(classifyFailure('HTTP 401 Unauthorized: bad api key')).toBe('auth');
    expect(classifyFailure('permission denied: /etc/hosts')).toBe('permission');
    expect(classifyFailure('HTTP 404 — resource not found')).toBe('not-found');
    expect(classifyFailure('HTTP 429 too many requests')).toBe('rate-limit');
    expect(classifyFailure('Unsupported content type: application/json')).toBe('content');
    expect(classifyFailure('something inexplicable happened')).toBe('generic');
  });

  it('classifies strict-endpoint schema rejections as schema, not content/generic (2026-11-01 rea 判例)', () => {
    // The exact wire shape from the field: the Rust transport head + the
    // provider's validator body. Deterministic, conversation-independent —
    // its guidance must not tell the user to shrink the context.
    expect(classifyFailure('400 Bad Request: {"error":{"message":"Invalid schema for function \'rea__capture_process_scenario\': \\"^[^=\\\\0]+$\\" is not a \\"regex\\"","type":"invalid_request_error"}}')).toBe('schema');
    expect(classifyFailure('Invalid schema for tool \'x\': pattern is not a regex')).toBe('schema');
    // Content-class neighbors must NOT drift into schema.
    expect(classifyFailure('invalid json in response body')).toBe('content');
  });

  it('classifies gateway/SWG interception pages as gateway, not auth/network (2026-11-02 内网判例)', () => {
    // 真机形态：公司 NetentSec SWG 策略阻断，403 + 网关自产页。网关页含
    // connection/network 字样会被 network 抢类、403 会被 auth 抢类——
    // gateway 判据必须先于两者。
    expect(classifyFailure('403 Forbidden: <html><body>NetentSec SWG: 访问被策略阻断</body></html>')).toBe('gateway');
    expect(classifyFailure('403 Forbidden: request blocked by corporate proxy policy')).toBe('gateway');
    expect(classifyFailure('403 Forbidden: <html>Access Denied — your request was rejected by the firewall</html> this connection was reset')).toBe('gateway');
    // API 的 JSON 403/401（凭证/配额）仍归 auth——网关判据不得吞掉它。
    expect(classifyFailure('403 Forbidden: {"error":{"code":"invalid_api_key"}}')).toBe('auth');
    expect(classifyFailure('HTTP 401 Unauthorized: bad api key')).toBe('auth');
    // 没有网关特征的普通 403（如空体）不盲判，保持 auth 现状。
    expect(classifyFailure('403 Forbidden')).toBe('auth');
  });

  it('classifies the openrouter management-key 401 as auth in both quote forms (2026-11-06 nemotron 判例)', () => {
    // 真机形态：管理型 key 调 chat/completions → 401 + JSON 错误体。原生引号
    // （引擎内存态）与转义引号（落盘/序列化态）都必须归 auth——转义形态若
    // 漏排除，isGatewayBlockedText 的特征词（rejected 等）会把它抢判成网关。
    expect(classifyFailure('401 Unauthorized: {"error":{"message":"User not found.","code":401}}')).toBe('auth');
    expect(classifyFailure('401 Unauthorized: {\\"error\\":{\\"message\\":\\"User not found.\\",\\"code\\":401}}')).toBe('auth');
  });

  it('isGatewayBlockedText does not misread serialized API error bodies as gateway pages', () => {
    // 排除正则须同时认原生与转义引号：原生是内存形态，转义是 events.jsonl
    // /IPC 形态——只认原生会让序列化形态漏进网关分支。
    expect(isGatewayBlockedText('401 Unauthorized: {"error":{"message":"User not found."}}')).toBe(false);
    expect(isGatewayBlockedText('401 Unauthorized: {\\"error\\":{\\"message\\":\\"User not found.\\"}}')).toBe(false);
    // 真网关页仍然命中。
    expect(isGatewayBlockedText('403 Forbidden: <html>blocked by corporate proxy</html>')).toBe(true);
  });
});

// ── 2026-10-29 会话楔死修复（刀1/刀2 的判别与学习原料）──

describe('isProviderHttp4xx', () => {
  it('recognizes the transport heads the Rust layer emits, minus retryable/auth codes', () => {
    expect(isProviderHttp4xx('400 Bad Request: {"error":{"code":"1214"}}')).toBe(true);
    expect(isProviderHttp4xx('HTTP 404 Not Found')).toBe(true);
    expect(isProviderHttp4xx('422 Unprocessable Entity: bad schema')).toBe(true);
    // Rate limit / auth are the ladder's business, not payload surgery.
    expect(isProviderHttp4xx('429 Too Many Requests')).toBe(false);
    expect(isProviderHttp4xx('401 Unauthorized')).toBe(false);
    expect(isProviderHttp4xx('403 Forbidden')).toBe(false);
    // Connection-class errors and bodies that merely CONTAIN "400" never match.
    expect(isProviderHttp4xx('request: error sending request for url (https://x)')).toBe(false);
    expect(isProviderHttp4xx('stream stalled: no data for 180s; got HTTP 400 earlier')).toBe(false);
  });
});

describe('isPayloadIndependentHttp4xx', () => {
  it('picks the codes no amount of shrinking can fix', () => {
    expect(isPayloadIndependentHttp4xx('404 Not Found: model gpt-99 does not exist')).toBe(true);
    expect(isPayloadIndependentHttp4xx('HTTP 405 Method Not Allowed')).toBe(true);
    expect(isPayloadIndependentHttp4xx('410 Gone')).toBe(true);
    expect(isPayloadIndependentHttp4xx('422 Unprocessable Entity: bad schema')).toBe(true);
    // Payload-size suspects stay eligible for the compaction attempt.
    expect(isPayloadIndependentHttp4xx('400 Bad Request: {"error":{"code":"1214"}}')).toBe(false);
    expect(isPayloadIndependentHttp4xx('413 Payload Too Large')).toBe(false);
    expect(isPayloadIndependentHttp4xx('connection reset')).toBe(false);
  });
});

describe('parseProviderContextLimit', () => {
  it('reads the real limit from the canonical provider body shapes', () => {
    expect(parseProviderContextLimit('400 bad request {"error":{"message":"This model\'s maximum context length is 65536 tokens. However, your messages resulted in 81234 tokens."}}')).toBe(65536);
    // Anthropic names the cap after the '>' — the leading number is the offender.
    expect(parseProviderContextLimit('prompt is too long: 208045 tokens > 200000 maximum')).toBe(200000);
    expect(parseProviderContextLimit('400 Bad Request: maximum context length is 131,072 tokens')).toBe(131072);
  });
  it('reads Chinese-language bodies by anchoring the cap word, not the requested size', () => {
    expect(parseProviderContextLimit('输入的token数量为200000，超过模型上限131072')).toBe(131072);
    expect(parseProviderContextLimit('{"error":{"message":"上下文最大长度 65536 tokens","code":"1113"}}')).toBe(65536);
    expect(parseProviderContextLimit('长度不能超过 32768')).toBe(32768);
    expect(parseProviderContextLimit('Input is too long: limit is 98304 tokens')).toBe(98304);
  });
  it('returns undefined when no credible number is stated', () => {
    expect(parseProviderContextLimit('400 Bad Request: {"error":{"code":"1214","message":"messages 参数非法"}}')).toBeUndefined();
    // "limit is 60 seconds" — noise below the credibility floor.
    expect(parseProviderContextLimit('rate limit is 60 seconds')).toBeUndefined();
    expect(parseProviderContextLimit('stream stalled: no data from the LLM API for 180s')).toBeUndefined();
    // Upper bound: a 100M+ "limit" is a parse artifact, not a real window.
    expect(parseProviderContextLimit('400 Bad Request: context length is 200000000 tokens')).toBeUndefined();
  });
});

describe('detectHijack', () => {
  it('flags a 200 interstitial rewritten into an error page', () => {
    const verdict = detectHijack('<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><hr><center>nginx</center></body></html>', {
      url: 'https://github.com/anthropics/anthropic-sdk-python',
      expectContent: true,
    });
    expect(verdict.hijacked).toBe(true);
    expect(verdict.signal).toBe('blockpage-fingerprint');
    expect(hijackReason(verdict)).toContain('劫持');
  });

  it('flags a redirect rewritten to an unrelated domain', () => {
    const verdict = detectHijack('<html><head><meta http-equiv="refresh" content="0;url=http://ads.example-top.com/go"></head><body></body></html>', {
      url: 'https://raw.githubusercontent.com/vercel/next.js/canary/README.md',
      expectContent: true,
    });
    expect(verdict.hijacked).toBe(true);
    expect(verdict.signal).toBe('redirect-to-ads.example-top.com');
  });

  it('flags an empty 200 body only when the caller expected content', () => {
    expect(detectHijack('', { url: 'https://example.com/a', expectContent: true }).signal).toBe('empty-body');
    expect(detectHijack('   \n ', { url: 'https://example.com/a', expectContent: true }).hijacked).toBe(true);
    // JSON / API 类响应可能合法为空，调用方不声明 expectContent 就不判。
    expect(detectHijack('', { url: 'https://api.example.com/v1/x' }).hijacked).toBe(false);
    expect(detectHijack(null).hijacked).toBe(false);
  });

  it('lets ordinary pages through — false positives cost a wasted retry', () => {
    const article = `<html><body><h1>Release notes</h1><p>${'We shipped a bunch of fixes to the retry logic and the streaming path. '.repeat(20)}</p></body></html>`;
    expect(detectHijack(article, { url: 'https://example.com/notes', expectContent: true }).hijacked).toBe(false);
    // 真实内容里提到 403 也不该被当成挡板页。
    const mentions = '<html><body><p>When the upstream returns 403 Forbidden you should back off and retry later, this is documented behavior for anonymous clients.</p></body></html>';
    expect(detectHijack(mentions, { url: 'https://example.com/api-docs', expectContent: true }).hijacked).toBe(false);
  });

  it('treats a same-site redirect as normal site behavior', () => {
    const verdict = detectHijack('<html><head><meta http-equiv="refresh" content="0;url=https://docs.example.com/en/latest/"></head></html>', {
      url: 'https://docs.example.com/',
      expectContent: true,
    });
    expect(verdict.hijacked).toBe(false);
    // 子域 → 父域也算同站。
    expect(detectHijack('<meta http-equiv="refresh" content="0;url=https://example.com/next">', {
      url: 'https://docs.example.com/a',
      expectContent: true,
    }).hijacked).toBe(false);
  });
});

// ── 与 Rust 侧 detect_response_hijack 的对齐 ─────────────────────────────────
// Rust（src-tauri/src/lib.rs）在 fetch_page_with_follow 里对每个 2xx 应答跑这套
// 四信号判定；JS 侧此前完全没有，于是 CLI 的 web_fetch 对「被改写的 200 广告页」
// 完全不设防。下面每条判例都对着 Rust 的同名测试写，阈值也直接引常量，
// 任何一侧改数字都会在这里炸。

describe('可注册域（修掉裸切最后两段的漏判）', () => {
  it('ccTLD 二级后缀不再被当成同一个站', () => {
    // 这条是本轮的核心判例：裸切最后两段会让 github.co.uk 与 evil.co.uk
    // 同域，最常见的钓鱼拼接因此判不出来。
    expect(registrableDomain('github.co.uk')).toBe('github.co.uk');
    expect(registrableDomain('evil.co.uk')).toBe('evil.co.uk');
    expect(sameRegistrableSite('github.co.uk', 'evil.co.uk')).toBe(false);
    // 同站子域仍然是同站。
    expect(sameRegistrableSite('github.co.uk', 'api.github.co.uk')).toBe(true);
    // 其他常见 ccTLD 二级后缀同样覆盖。
    expect(registrableDomain('a.com.cn')).toBe('a.com.cn');
    expect(sameRegistrableSite('foo.com.cn', 'bar.com.cn')).toBe(false);
    expect(sameRegistrableSite('foo.com.au', 'bar.com.au')).toBe(false);
    expect(sameRegistrableSite('foo.co.jp', 'bar.co.jp')).toBe(false);
  });

  it('托管平台的每个子域是独立站点，不能按同一可注册域看待', () => {
    // 否则 A 信号在这些平台上永远为假（Rust 侧为此专门列了这一段表）。
    expect(sameRegistrableSite('alice.github.io', 'evil.github.io')).toBe(false);
    expect(sameRegistrableSite('a.vercel.app', 'evil.vercel.app')).toBe(false);
    expect(sameRegistrableSite('bucket.s3.amazonaws.com', 'other.s3.amazonaws.com')).toBe(false);
  });

  it('后缀拼接钓鱼仍判得出来（走「最后两段」兜底）', () => {
    expect(sameRegistrableSite('github.com', 'github.com.evil.net')).toBe(false);
    expect(sameRegistrableSite('github.com', 'evil.net')).toBe(false);
  });

  it('IP 字面量或空 host 一律视为同站——缺信号不能当成跨域', () => {
    expect(sameRegistrableSite('127.0.0.1', 'example.com')).toBe(true);
    expect(sameRegistrableSite('', 'example.com')).toBe(true);
  });
});

describe('detectResponseHijack（与 Rust 四信号判定逐条对齐）', () => {
  const ok = (over: Partial<Parameters<typeof detectResponseHijack>[0]> = {}) => detectResponseHijack({
    requestUrl: 'https://example.com/post',
    finalUrl: 'https://example.com/post',
    contentType: 'text/html; charset=utf-8',
    body: `<html><body><p>${'Real content paragraph that is definitely long enough. '.repeat(6)}</p></body></html>`,
    ...over,
  });

  it('阈值与 Rust 常量一致（改数字必须两边一起改）', () => {
    expect(HIJACK_VISIBLE_TEXT_MAX_CHARS).toBe(200);
    expect(HIJACK_META_REFRESH_MAX_DELAY_SECS).toBe(3);
    expect(HIJACK_JS_SCAN_CHARS).toBe(4096);
  });

  it('正常内容页一律放过', () => {
    expect(ok()).toBeNull();
  });

  it('C && B：同域挡板页（正文几乎为空 + 命中指纹）即定罪', () => {
    const v = detectResponseHijack({
      requestUrl: 'https://github.com/x/y',
      finalUrl: 'https://github.com/x/y',
      contentType: 'text/html',
      body: '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1><hr><center>nginx</center></body></html>',
    });
    expect(v?.signal).toBe('blockpage-fingerprint');
  });

  it('A && B：跨可注册域 + 几乎空白的 html', () => {
    const v = detectResponseHijack({
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      body: '<html><body>hi</body></html>',
    });
    expect(v?.signal).toBe('cross-domain-short-html');
  });

  it('A && C：跨可注册域 + 命中挡板指纹', () => {
    const v = detectResponseHijack({
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      // 正文够长（不满足 B），只靠 A && C 定罪。
      body: `<html><head><title>Just a moment...</title></head><body><p>${'Checking your browser before accessing. '.repeat(10)}</p></body></html>`,
    });
    expect(v?.signal).toBe('cross-domain-blockpage');
  });

  it('A && D：跨可注册域 + 立即跳站外', () => {
    const v = detectResponseHijack({
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      // 正文够长、无指纹，只靠 D。
      body: `<html><head><meta http-equiv="refresh" content="0;url=http://ads.evil-top.com/go"></head><body><p>${'Padding so the body is long. '.repeat(10)}</p></body></html>`,
    });
    expect(v?.signal).toBe('cross-domain-immediate-redirect');
  });

  it('D 必须配 A：同域的立即跳转是站点自己的行为，放过', () => {
    expect(ok({
      body: '<html><head><meta http-equiv="refresh" content="0;url=https://docs.example.com/new"></head><body></body></html>',
    })).toBeNull();
  });

  it('头部里先同域后站外的 JS 跳转仍然算信号', () => {
    // 页面常在头部先写一个同域的 location.href（回退基准地址）。只看第一个匹配
    // 会漏掉真正的站外跳转（Rust 侧用 captures_iter 逐个定位）。
    const v = detectResponseHijack({
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      body: `<html><head><script>location.href = "https://example.com/canonical";location.href='http://ads.evil-top.com/go';</script></head><body><p>${'Padding so the body is long. '.repeat(10)}</p></body></html>`,
    });
    expect(v?.signal).toBe('cross-domain-immediate-redirect');
  });

  it('meta refresh 延迟 > 3s 不算「立即跳转」', () => {
    // 站点自己的「我们搬家了」页通常给 5 秒以上并带正文。
    expect(ok({
      finalUrl: 'https://cdn.evil.net/post',
      body: `<html><head><meta http-equiv="refresh" content="30;url=http://ads.evil-top.com/go"></head><body><p>${'Padding so the body is long. '.repeat(10)}</p></body></html>`,
    })).toBeNull();
  });

  it('非 html / 非 http(s) 的应答不参与 B 与 C（只有 A && D 还能定罪）', () => {
    // content-type 是 JSON：正文再短也不该被判成挡板页（合法短 JSON 很常见）。
    expect(detectResponseHijack({
      requestUrl: 'https://api.example.com/v1/x',
      finalUrl: 'https://api.example.com/v1/x',
      contentType: 'application/json',
      body: '{}',
    })).toBeNull();
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
    expect(isHtmlContentType('')).toBe(true);
    expect(isHtmlContentType('application/json')).toBe(false);
  });

  it('可见正文长度：script/style 不计，标签剥掉后折叠空白', () => {
    expect(visibleTextLength('<script>var x=1;</script><style>.c{}</style><p>Clean</p>')).toBe('Clean'.length);
    // 标签边界断行后逐行 trim 再用 \n 连接（与 Rust 侧 strip_html_full 同形）。
    expect(visibleTextLength('<h1>Title</h1><p>Hello world</p>')).toBe('Title\nHello world'.length);
  });

  it('错误文案必须含 "Network interception"——上层靠这个词归类成网络失败', () => {
    // 隐式契约：isNetworkError / classifyFailure 都靠它触发兜底路由重试。
    const v = detectResponseHijack({
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      body: '<html><body>hi</body></html>',
    })!;
    const msg = hijackErrorMessage(v, {
      requestUrl: 'https://example.com/post',
      finalUrl: 'https://cdn.evil.net/post',
      contentType: 'text/html',
      body: '<html><body>hi</body></html>',
    });
    expect(msg).toContain('Network interception');
    expect(msg).toContain('cross-domain-short-html');
    expect(isNetworkError(msg)).toBe(true);
    expect(classifyFailure(msg)).toBe('network');
  });
});
