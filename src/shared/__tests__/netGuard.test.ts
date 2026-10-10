// src/shared/__tests__/netGuard.test.ts
// Covers the host circuit breaker + failure classification shared by the GUI
// and CLI tool adapters: two consecutive network failures trip a host, the
// blocked window fails instantly with a skip directive, any success clears
// it, and classifyFailure maps real error strings to recovery classes.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  HIJACK_JS_SCAN_CHARS,
  HIJACK_META_REFRESH_MAX_DELAY_SECS,
  HIJACK_VISIBLE_TEXT_MAX_CHARS,
  blockedHostMessage,
  blockedHosts,
  classifyFailure,
  detectHijack,
  detectResponseHijack,
  hijackErrorMessage,
  hijackReason,
  hostBlocked,
  hostOf,
  isHtmlContentType,
  isNetworkError,
  netFailureHint,
  recordNetFailure,
  recordNetSuccess,
  registrableDomain,
  sameRegistrableSite,
  visibleTextLength,
} from '../netGuard';

beforeAll(() => {
  GlobalRegistrator.register();
  localStorage.removeItem('pure.netGuard.hosts.v1');
});
afterAll(() => GlobalRegistrator.unregister());

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
//
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
