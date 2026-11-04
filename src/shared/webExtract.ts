// src/shared/webExtract.ts
// web 抓取后提炼层(期4 第一刀,2026-10-30)。病根:web_fetch/web_scrape 把
// 页面前 2 万字符原文整个灌回模型上下文,汇总类任务抓几页就是几万字,且
// 之后每一轮 THINK 都要重复 prefill——「处理大数据耗时」的真身是上下文
// 膨胀,不是抓取本身。超阈值全文先经一次 flash 档提炼压成要点,主上下文
// 只进要点;模型需要精确原文时传 raw: true 旁路(诚实注明,不给死胡同)。
// 本模块只放纯逻辑(prompt/阈值/包裹/缓存/编排);提炼调用是宿主注入的
// summarizeForExtract 回调——GUI(chat.ts)与 CLI(cliAdapter)各自构造,
// 工具端(TauriToolAdapter / NodeToolAdapter)调同一份 condenseToolBody。

/** 宿主提炼回调的形状:发一次非流式 complete,返回要点文本。 */
export type SummarizeForExtract = (url: string, text: string, signal?: AbortSignal) => Promise<string>;

/** 全文超过该字符数才提炼:短页面提炼反而丢信息+白付一次调用。 */
export const EXTRACT_THRESHOLD_CHARS = 8000;
/** 提炼输出的软上限(字符),写进 prompt 让模型自己收着。 */
export const EXTRACT_TARGET_CHARS = 2500;
/** 提炼调用超时:flash 档 2.5k 输出应 <15s,45s 是宽上限。 */
export const EXTRACT_TIMEOUT_MS = 45_000;

export function shouldExtractText(text: string): boolean {
  return text.length > EXTRACT_THRESHOLD_CHARS;
}

/** 提炼 prompt:通用要点化(工具层拿不到任务目标,不做定向问答)。 */
export function buildExtractPrompt(url: string, text: string): string {
  return [
    '你是一个网页内容提炼器。把下面的网页正文提炼成要点,供一个正在做信息汇总的智能体直接使用。',
    '',
    '要求:',
    '- 保留:核心结论、关键数字、日期、名称、因果结构;代码/命令/路径/型号等标识符逐字保留。',
    '- 丢弃:导航、广告、重复表述、模板文字。',
    '- 不编造:原文没有的信息一律不写;拿不准的注明「原文未明说」。',
    `- 输出不超过 ${EXTRACT_TARGET_CHARS} 字,用页面主要语言;短段落+列表,不要开场白和总结客套。`,
    '',
    `网页地址:${url}`,
    '网页正文:',
    text,
  ].join('\n');
}

/** 要点返回的包裹头:说清「这是提炼」并给出原文旁路,模型不会死胡同。 */
export function wrapSummary(summary: string, url: string, originalChars: number): string {
  const k = Math.round(originalChars / 1000);
  return [
    `[已提炼:本页原文约 ${k}k 字符,以上内容为要点。需要精确原文片段时,重新调用并传 raw: true(配 maxChars 控制长度)。]`,
    summary.trim(),
  ].join('\n');
}

// ── 提炼结果缓存:同页二次工具调用零成本命中(TTL 30min,容量 50) ──
// Rust 侧 page cache 只省抓取;提炼是一次 LLM 调用,模型循环里同 URL
// 重复取(web_fetch 补查、scrape 换 selector)不该重复付费。
const EXTRACT_TTL_MS = 30 * 60_000;
/** 缓存容量(导出给测试做淘汰探测):50 页要点远超单会话用量。 */
export const EXTRACT_CACHE_CAP = 50;
const extractCache = new Map<string, { summary: string; at: number }>();

/** 缓存键:URL + selector + maxChars 桶(输入形态不同,要点可能不同)。 */
export function extractCacheKey(url: string, selector?: string, maxChars?: number): string {
  const bucket = !maxChars || maxChars <= 20000 ? 'std' : 'big';
  return `${url}|${selector ?? ''}|${bucket}`;
}

export function cacheExtract(key: string, summary: string): void {
  if (extractCache.size >= EXTRACT_CACHE_CAP) {
    const oldest = extractCache.keys().next().value;
    if (oldest !== undefined) extractCache.delete(oldest);
  }
  extractCache.set(key, { summary, at: Date.now() });
}

export function getCachedExtract(key: string): string | undefined {
  const hit = extractCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > EXTRACT_TTL_MS) {
    extractCache.delete(key);
    return undefined;
  }
  // LRU 触碰:命中即挪到队尾,容量淘汰让位给最久未用。
  extractCache.delete(key);
  extractCache.set(key, hit);
  return hit.summary;
}

/** 测试隔离:清空提炼缓存。 */
export function resetExtractCache(): void {
  extractCache.clear();
}

// ── 提炼编排(2026-11-04 从 TauriToolAdapter.maybeExtract 抽出,单源) ──
// 之前只 GUI 主聊天接了提炼,CLI 与 overlay 流拿不到(description 却对所有
// 端承诺 auto-condensed = 虚假承诺);两端工具适配器现在都走这份编排。

/** 抓取返回体的统一入口:raw:true / 短页 / 回调缺席 → 原文;超时双保险
 * (signal 交守约通道 + Promise.race 硬上限);空要点或越提越长回退原文,
 * 不拿空壳冒充提炼。 */
export async function condenseToolBody(
  url: string,
  args: Record<string, unknown>,
  text: string,
  summarize: SummarizeForExtract | undefined,
): Promise<string> {
  if (args.raw === true || !shouldExtractText(text) || !summarize) return text;
  const key = extractCacheKey(
    url,
    typeof args.selector === 'string' ? args.selector : undefined,
    typeof args.maxChars === 'number' ? args.maxChars : undefined,
  );
  const cached = getCachedExtract(key);
  if (cached) return wrapSummary(cached, url, text.length);
  try {
    // 双保险:signal 交给守约的 LLM 通道,Promise.race 兜底硬上限——
    // 通道若无视 signal 也不许提炼把工具调用拖死。
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new Error(`提炼超时(${Math.round(EXTRACT_TIMEOUT_MS / 1000)}s)`)); }, EXTRACT_TIMEOUT_MS);
    });
    let summary: string;
    try {
      summary = await Promise.race([summarize(url, text, ac.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const trimmed = summary.trim();
    // 空要点或越提越长=没提炼出东西,回退原文。
    if (!trimmed || trimmed.length >= text.length) return text;
    cacheExtract(key, trimmed);
    return wrapSummary(trimmed, url, text.length);
  } catch {
    return text;
  }
}
