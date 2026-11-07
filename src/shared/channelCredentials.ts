// src/shared/channelCredentials.ts
// 通道凭据的两件共享地基：粘贴解析 + 平台探活。
//
// 「一键开通」的用户形态是从 QQ/飞书/钉钉开放平台页面上**整段复制**凭据文本
// 粘进一个框——平台的展示形态不统一（两行 key:value、JSON 片段、裸两个值都
// 出现过），让用户认哪个值填哪个框就是配置负担本身。解析是纯函数，GUI /
// configure_channel 工具（Bun）/ 测试三面同源。
//
// 探活 = 调各平台自己的 access_token 端点（与正式适配器同一端点：QQ 与
// wsTransport 的 QQTokenKeeper 逐字对齐）。凭据被拒与网络不通必须分开报——
// 前者该回平台核对，后者是本机网络问题，文案与动作完全不同。

export type OnboardChannelId = 'feishu' | 'dingtalk' | 'qq';

/** 各通道的凭据对：primary = 明文标识（appId / clientId），secondary = 密钥。 */
export interface ParsedCredentials {
  primary?: string;
  secondary?: string;
}

const FIELD_ALIASES: Record<OnboardChannelId, { primary: string[]; secondary: string[] }> = {
  feishu: { primary: ['appid', 'app_id', 'app id'], secondary: ['appsecret', 'app_secret', 'app secret', 'secret'] },
  dingtalk: { primary: ['clientid', 'client_id', 'client id', 'appkey', 'app_key'], secondary: ['clientsecret', 'client_secret', 'client secret', 'appsecret'] },
  qq: { primary: ['appid', 'app_id', 'app id'], secondary: ['appsecret', 'app_secret', 'app secret', 'clientsecret', 'secret'] },
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

function isAlias(key: string, aliases: string[]): boolean {
  const norm = normalizeKey(key);
  return aliases.includes(norm) || aliases.includes(norm.replace(/\s+/g, ''));
}

/** JSON 形态：平台开发者页常给一段 {"appId": "...", "appSecret": "..."}。 */
function fromJsonObject(obj: Record<string, unknown>, channel: OnboardChannelId): ParsedCredentials | null {
  const aliases = FIELD_ALIASES[channel];
  const out: ParsedCredentials = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (out.primary === undefined && isAlias(key, aliases.primary)) out.primary = value.trim();
    else if (out.secondary === undefined && isAlias(key, aliases.secondary)) out.secondary = value.trim();
  }
  return out.primary || out.secondary ? out : null;
}

/** key:value / key=value / key：value 行（中文冒号也认）。 */
function fromKeyLines(text: string, channel: OnboardChannelId): ParsedCredentials | null {
  const aliases = FIELD_ALIASES[channel];
  const out: ParsedCredentials = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：=]+?)\s*[:：=]\s*(\S+)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (out.primary === undefined && isAlias(key, aliases.primary)) out.primary = value;
    else if (out.secondary === undefined && isAlias(key, aliases.secondary)) out.secondary = value;
  }
  return out.primary || out.secondary ? out : null;
}

/** 裸值形态：用户只把两个值本身粘进来（各占一行，或一段里两个 token）。
 *  启发式：identifier 通常纯数字（QQ）或带品牌前缀（cli_xxx / ding_xxx）；
 *  secret 是随机串。两行时短/带前缀的当 identifier。 */
function fromBareValues(text: string, channel: OnboardChannelId): ParsedCredentials | null {
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 6 && !t.includes(':') && !t.includes('='));
  if (tokens.length !== 2) return null;
  const looksLikeId = (t: string): boolean => /^\d{6,}$/.test(t) || /^[a-z]+_[\w-]+$/i.test(t);
  const [first, second] = tokens;
  if (looksLikeId(first) && !looksLikeId(second)) return { primary: first, secondary: second };
  if (looksLikeId(second) && !looksLikeId(first)) return { primary: second, secondary: first };
  // 两行都看不出形状时按粘贴顺序（平台页面 identifier 恒在 secret 之前）。
  return { primary: first, secondary: second };
}

/** 从整段粘贴文本解析凭据。返回的字段可以只有一半（另一半缺失时调用方
 *  单独提示，不用整体失败）。完全无法识别返回 null。 */
export function parseCredentialPaste(text: string, channel: OnboardChannelId): ParsedCredentials | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // JSON 形态（含 ```json 围栏内的）：先剥围栏再试解析。
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [jsonMatch?.[1] ?? trimmed]) {
    try {
      const obj = JSON.parse(candidate) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const parsed = fromJsonObject(obj as Record<string, unknown>, channel);
        if (parsed) return parsed;
      }
    } catch { /* 非 JSON，继续行解析 */ }
  }
  const keyed = fromKeyLines(trimmed, channel);
  if (keyed) return keyed;
  return fromBareValues(trimmed, channel);
}

// ── 平台探活 ─────────────────────────────────────────────────────────────

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; kind: 'rejected'; detail: string }
  | { ok: false; kind: 'network'; detail: string };

const VERIFY_TIMEOUT_MS = 15_000;

interface VerifySpec {
  url: string;
  body: (primary: string, secondary: string) => unknown;
  /** 200 响应里判断「凭据有效」；返回 false 时给 detailExtractor 出平台原话。 */
  okCheck: (data: Record<string, unknown>) => boolean;
  detail: (data: Record<string, unknown>) => string;
}

/** 端点与请求体与正式适配器同源：QQ 逐字对齐 wsTransport 的 QQTokenKeeper
 *  （QQ 惯用 HTTP 200 包错误，真实原因只在 body 的 code/message 里）；飞书
 *  internal token 端点 code=0 即有效；钉钉 oauth2 端点给 accessToken 即有效。 */
const VERIFY_SPECS: Record<OnboardChannelId, VerifySpec> = {
  feishu: {
    url: 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    body: (primary, secondary) => ({ app_id: primary, app_secret: secondary }),
    okCheck: (d) => d.code === 0 && typeof d.app_access_token === 'string' && d.app_access_token !== '',
    detail: (d) => `code=${String(d.code)} ${String(d.msg ?? '')}`.trim(),
  },
  dingtalk: {
    url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    body: (primary, secondary) => ({ appKey: primary, appSecret: secondary }),
    okCheck: (d) => typeof d.accessToken === 'string' && d.accessToken !== '',
    detail: (d) => String(d.message ?? JSON.stringify(d).slice(0, 200)),
  },
  qq: {
    url: 'https://bots.qq.com/app/getAppAccessToken',
    body: (primary, secondary) => ({ appId: primary, clientSecret: secondary }),
    okCheck: (d) => typeof d.access_token === 'string' && d.access_token !== '',
    detail: (d) => String(d.message ?? JSON.stringify(d).slice(0, 200)),
  },
};

/** 平台凭据探活。网络失败与凭据被拒分两族——「被拒」是用户的凭据问题
 *  （回平台核对），「不通」是本机网络问题（检查代理/网络），文案据此分流。 */
export async function verifyChannelCredentials(
  channel: OnboardChannelId,
  primary: string,
  secondary: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyOutcome> {
  const spec = VERIFY_SPECS[channel];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(spec.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec.body(primary, secondary)),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch { /* 非 JSON 响应走下面的判负并带片段 */ }
    if (spec.okCheck(data)) return { ok: true };
    // HTTP 都没给 2xx 的（罕见，平台通常 200 包错误）也按被拒算，带状态码。
    const head = text.slice(0, 200);
    return { ok: false, kind: 'rejected', detail: res.status >= 300 ? `HTTP ${res.status} ${head}` : spec.detail(data) || head };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'network', detail };
  } finally {
    clearTimeout(timer);
  }
}
