// src/shared/repoMapSource.ts
// 仓库符号地图的采集层（2026-11-21）：一次递归清单 + 少量 read_file(outline)
// 走宿主已有的工具面，GUI（TauriToolAdapter）与 CLI（NodeToolAdapter）共用同一
// 份实现——扫描逻辑出现两份，两个面的地图迟早不一样。
//
// 为什么复用工具面而不是直接 fs：GUI 跑在 WebView 里没有 node:fs，工具面是
// 唯一在两端都成立的读路径；代价是每次读都过一次权限/可见性闸，所以只在
// 「动手类回合 + 仓库够大」时才扫，且扫完按清单指纹缓存——清单没变就不重读。
import type { ToolAdapter, ToolResult } from './types';
import {
  REPO_MAP_MIN_SOURCE_FILES,
  formatRepoMap,
  parseRepoMapListing,
  pickRepoMapSymbolFiles,
  repoMapFingerprint,
  repoMapSymbolNamesFromOutline,
  type RepoMapEntry,
} from './repoMap';

/** 清单字符硬上限（按条数已经封顶，这只是内存护栏）。 */
const LISTING_CHAR_CAP = 200_000;
/** 递归列举的条数上限：默认 800 条在 1000+ 文件的仓库里会把后半截目录整段
 *  截掉，地图就变成「只有字母序靠前的目录」——比没有地图更误导。 */
const LISTING_MAX_ENTRIES = 4_000;
/** 清单重扫窗口：一次递归列举在本仓库要 1.2s，每回合都付这笔钱不值得；
 *  60s 内的回合直接用上一份地图（头部已声明它是快照）。 */
const REFRESH_MS = 60_000;
/** 单次工具调用的等待上限：地图是加速器，不能自己变成首字的瓶颈。 */
const TOOL_TIMEOUT_MS = 6_000;
/** 大纲读取并发：太高会把权限闸和 IPC 排队塞满，反而更慢。 */
const OUTLINE_CONCURRENCY = 4;
/** 缓存寿命：清单指纹每回合现算，寿命只兜「指纹算不出来」的退路。 */
const CACHE_TTL_MS = 10 * 60_000;

interface RepoMapCacheEntry {
  fingerprint: string;
  text: string;
  at: number;
}

const cache = new WeakMap<ToolAdapter, RepoMapCacheEntry>();

function makeToolCall(toolName: string, args: Record<string, unknown>): { id: string; index: number; function: { name: string; arguments: string } } {
  return { id: `repo_map_${Math.random().toString(36).slice(2, 10)}`, index: 0, function: { name: toolName, arguments: JSON.stringify(args) } };
}

async function runTool(tools: ToolAdapter, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult | null> {
  if (signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tools.execute(makeToolCall(toolName, args) as never, signal),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TOOL_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resultText(result: ToolResult | null): string {
  if (!result?.success) return '';
  if (typeof result.result === 'string') return result.result;
  try { return JSON.stringify(result.result ?? ''); } catch { return ''; }
}

async function readOutlines(tools: ToolAdapter, paths: string[], signal?: AbortSignal): Promise<RepoMapEntry[]> {
  const entries: RepoMapEntry[] = [];
  for (let start = 0; start < paths.length; start += OUTLINE_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = paths.slice(start, start + OUTLINE_CONCURRENCY);
    const results = await Promise.all(batch.map((path) => runTool(tools, 'read_file', { path, outline: true }, signal)));
    results.forEach((result, index) => {
      const path = batch[index];
      const outline = resultText(result);
      // 读不到大纲（二进制/无权限/超时）就只留路径——地图仍要列出这个文件，
      // 静默丢掉会让模型以为文件不存在。
      entries.push({ path, symbols: outline ? repoMapSymbolNamesFromOutline(outline) : [] });
    });
  }
  return entries;
}

/**
 * 采集（或复用缓存的）仓库地图。返回空串表示「这一回合不该带地图」：
 * 仓库太小、没有工具面、清单读不到、或调用方已取消。
 *
 * 空串是正常结果，调用方无需分支——envFacts 对空段本来就不落字。
 */
export async function collectRepoMap(tools: ToolAdapter | undefined, options: { signal?: AbortSignal; minSourceFiles?: number; refreshMs?: number } = {}): Promise<string> {
  if (!tools || options.signal?.aborted) return '';
  const fresh = cache.get(tools);
  if (fresh && Date.now() - fresh.at < (options.refreshMs ?? REFRESH_MS)) return fresh.text;
  const listingResult = await runTool(tools, 'list_files', { path: '.', recursive: true, maxResults: LISTING_MAX_ENTRIES }, options.signal);
  if (!listingResult?.success) return '';
  const rawListing = resultText(listingResult);
  // 截断标记只看尾军：全串搜 truncated 会被一个叫 *TruncatedResult.ts 的文件
  // 误命中，把「完整清单」误报成截断（真机踩过）。
  const tail = rawListing.slice(-400);
  const truncated = /\[截断\]/.test(tail) || /\btruncated\b/i.test(tail);
  const paths = parseRepoMapListing(rawListing.slice(0, LISTING_CHAR_CAP));
  if (paths.length < (options.minSourceFiles ?? REPO_MAP_MIN_SOURCE_FILES)) return '';

  const fingerprint = repoMapFingerprint(paths);
  const cached = cache.get(tools);
  const now = Date.now();
  if (cached && cached.fingerprint === fingerprint && now - cached.at < CACHE_TTL_MS) return cached.text;

  // 只给挑出来的骨架文件读大纲；其余文件按目录树列出名字即可。地图省下的
  // 是「不知道去哪找」的时间，不是「读完全仓」的时间。
  const symbolFiles = pickRepoMapSymbolFiles(paths);
  const symbolized = await readOutlines(tools, symbolFiles, options.signal);
  const text = formatRepoMap({ entries: paths.map((path) => symbolized.find((entry) => entry.path === path) ?? { path, symbols: [] }), totalFiles: paths.length, truncated });
  cache.set(tools, { fingerprint, text, at: now });
  return text;
}

/** 只给测试用：清掉某个 adapter 的缓存，验证「清单变了就重扫」。 */
export function clearRepoMapCache(tools?: ToolAdapter): void {
  if (tools) cache.delete(tools);
}
