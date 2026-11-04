// src/shared/capabilityProbe.ts
// W1b-1 —— 模型能力自探测：manifest（modelCapabilities.ts）只认「厂商策展
// 的模型名」这条证据线；provider 侧收窄后（2026-11-04），自定义 provider +
// 未知模型名的组合落在无档保守（全局 32k）。这个空档的权威读数不在命名里，
// 在端点上：openrouter 这类聚合商的 /models 元数据带着每个模型的真实窗口
// （context_length / top_provider.context_length）。本模块在 manifest 未
// 声明时向端点要这个读数，结果由调用方写进 config.json 的 capabilityProbes
// 缓存（键 provider::model，含 endpoint——换端点即失效）。
//
// 边界（与蓝图口径一致）：探测是**填空档**不是推翻族知识——消费层把探得值
// 插在 manifest 之后、保守回落之前，manifest 有档（deepseek/glm/…）的模型
// 根本不会触发探测。官方 API 的 /models 多数不返回窗口，此时如实报告
// modelFound 但不带预算，调用方走「明确告警」而不是编一个数。
//
// 蓝图原写「/models + 一次极小请求」；落地裁定砍掉极小请求（2026-11-04）：
// 探测挂点之前已有连通性 probe 兜底可用性，而窗口元数据是聚合商特权、官方
// 端点的极小请求同样拿不到窗口——多一次真实调用只买一个薄读数。等真机
// 复验后按 /models 缺失率决定要不要补。
//
// 本模块与 llmProbe.ts 同款形状（fetchImpl/signalFactory 注入、有界超时），
// 但职责不同：llmProbe 判连通，本模块读元数据。

/** 探测读数。`contextWindowTokens` 缺席 = 端点活着但没给窗口（明确告警出口）。 */
export interface CapabilityProbeResult {
  /** /models 返回 2xx。 */
  ok: boolean;
  /** 清单里定位到了目标模型（id 精确或 vendor/model 尾段匹配）。 */
  modelFound: boolean;
  /** 端点自述的上下文窗口（token 数）。 */
  contextWindowTokens?: number;
  /** 端点自述的输出上限（openrouter top_provider.max_completion_tokens）。 */
  outputReserveTokens?: number;
  latencyMs: number;
  error: string;
}

export interface CapabilityProbeOptions {
  protocol?: 'openai' | 'anthropic';
  timeoutMs?: number;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal factory（老 WKWebView 兜底），同 llmProbe 约定。 */
  signalFactory?: (ms: number) => AbortSignal;
}

/** config.json `capabilityProbes` 的单条缓存（键 `provider::model`）。 */
export interface ProbedCapability {
  contextWindowTokens: number;
  outputReserveTokens?: number;
  /** 探测时的端点——provider 后来改了 baseURL，旧读数作废。 */
  endpoint?: string;
  /** ISO 时间，诊断用。 */
  probedAt: string;
}

/** 缓存键。与 promptBudgetForProvider / 设置面的口径一致。 */
export function probedCapabilityKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/** 从一条 /models 元数据里读窗口与输出上限。字段优先级：聚合商的
 * top_provider（更精确）> 顶层字段；识别 openrouter / vLLM / ollama 常见
 * 命名。全缺席返回空对象——不编数。 */
export function parseModelWindow(entry: unknown): { contextWindowTokens?: number; outputReserveTokens?: number } {
  if (!entry || typeof entry !== 'object') return {};
  const e = entry as Record<string, unknown>;
  const top = (e.top_provider && typeof e.top_provider === 'object') ? e.top_provider as Record<string, unknown> : undefined;
  const contextWindowTokens = pickPositiveInt(top?.context_length)
    ?? pickPositiveInt(e.context_length)
    ?? pickPositiveInt(e.context_window)
    ?? pickPositiveInt(e.max_model_len);
  const outputReserveTokens = pickPositiveInt(top?.max_completion_tokens)
    ?? pickPositiveInt(e.max_output_tokens);
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(outputReserveTokens ? { outputReserveTokens } : {}),
  };
}

function pickPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** 在 /models 清单里定位目标模型：精确 id 优先，其次 `vendor/model` 的尾段
 * （调用方传的 model 可能带或不带网关前缀）。 */
export function findModelEntry(data: unknown[], model: string): unknown {
  const target = model.trim();
  if (!target) return undefined;
  const lower = target.toLowerCase();
  let tailMatch: unknown;
  for (const entry of data) {
    const id = (entry && typeof entry === 'object') ? (entry as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string') continue;
    const lid = id.toLowerCase();
    if (lid === lower) return entry;
    // 尾段：`openrouter` 上的模型清单是 `vendor/model`，会话配置可能是裸名
    // （或反过来）。只允许一层 vendor 前缀，防止 `a/b/c` 误配 `b/c` 之外的形状。
    if (!tailMatch && (lid === `/${lower}` || lid.endsWith(`/${lower}`)) && lid.split('/').length === 2) {
      tailMatch = entry;
    }
  }
  return tailMatch;
}

/**
 * 有界探测：GET `{baseURL}/models`（按协议带头），解析目标模型的窗口元数据。
 * 只判 2xx 与元数据——不发起对话请求（见文件头裁定）。
 */
export async function probeModelCapability(
  baseURL: string,
  apiKey: string,
  model: string,
  opts: CapabilityProbeOptions = {},
): Promise<CapabilityProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const signalFactory = opts.signalFactory ?? abortSignal;
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.protocol === 'anthropic') {
    // anthropic 官方不认 Bearer；探测头与真实对话同款（x-api-key + version）。
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: signalFactory(timeoutMs) });
  } catch (err) {
    return {
      ok: false,
      modelFound: false,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      error: `network error: ${(err as Error)?.message || String(err)}`,
    };
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403
      ? `HTTP ${response.status} — API key rejected`
      : `HTTP ${response.status}`;
    return { ok: false, modelFound: false, latencyMs, error: reason };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: true, modelFound: false, latencyMs, error: `unreadable /models body: ${(err as Error)?.message || String(err)}` };
  }
  const data = (body && typeof body === 'object') ? (body as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) {
    // 2xx 但形状不是清单（有的端点 /models 返回对象）：如实报告，不猜。
    return { ok: true, modelFound: false, latencyMs, error: '/models returned no data[] list' };
  }
  const entry = findModelEntry(data, model);
  if (!entry) {
    return { ok: true, modelFound: false, latencyMs, error: `model "${model}" not listed on the endpoint` };
  }
  const window = parseModelWindow(entry);
  return {
    ok: true,
    modelFound: true,
    ...window,
    latencyMs,
    error: window.contextWindowTokens ? '' : 'endpoint lists the model but publishes no context window',
  };
}

/** AbortSignal.timeout 需要 Safari 16+（macOS 13）；老 WKWebView 抛 TypeError
 * ——回退 AbortController + setTimeout（与 llmProbe 同款兜底）。 */
function abortSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}
