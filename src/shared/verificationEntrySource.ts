// src/shared/verificationEntrySource.ts
// 验证入口的采集层：走宿主已有的工具面（GUI 没有 node:fs，工具面是两端唯一
// 成立的读路径），与 repoMapSource 同一套纪律——一次根目录清单 + 一次清单读取，
// 失败/超时一律返回空串，绝不把采集变成首字的瓶颈。
//
// 缓存按 adapter 隔离（WeakMap），TTL 2 分钟：验证入口在一个会话里几乎不变，
// 但模型刚给 package.json 加了 test 脚本的那几分钟内值得重新看一眼。

import type { ToolAdapter, ToolResult } from './types';
import {
  detectVerificationEntry,
  formatVerificationEntry,
  type VerificationManifestInput,
} from './verificationEntry';

const TOOL_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 120_000;
const LISTING_MAX = 500;

interface CacheEntry {
  text: string;
  at: number;
}

const cache = new WeakMap<ToolAdapter, CacheEntry>();

function makeToolCall(toolName: string, args: Record<string, unknown>): { id: string; index: number; function: { name: string; arguments: string } } {
  return { id: `verify_entry_${Math.random().toString(36).slice(2, 10)}`, index: 0, function: { name: toolName, arguments: JSON.stringify(args) } };
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

/** 清单优先级：一个项目通常只认其中一份，按声明强度排序。 */
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'makefile'] as const;

/**
 * 采集验证入口事实。返回空串表示「这一回合不该带」：没有工具面、清单读不到、
 * 或项目没有声明任何可识别的验证入口。调用方对空串零分支。
 */
export async function collectVerificationEntry(
  tools: ToolAdapter | undefined,
  options: { signal?: AbortSignal; refreshMs?: number } = {},
): Promise<string> {
  if (!tools || options.signal?.aborted) return '';
  const fresh = cache.get(tools);
  if (fresh && Date.now() - fresh.at < (options.refreshMs ?? CACHE_TTL_MS)) return fresh.text;

  const listingResult = await runTool(tools, 'list_files', { path: '.', maxResults: LISTING_MAX }, options.signal);
  const listing = resultText(listingResult);
  if (!listing) return '';
  const rootEntries = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('['));
  const rootSet = new Set(rootEntries);

  const manifest = MANIFESTS.find((name) => rootSet.has(name));
  if (!manifest) {
    cache.set(tools, { text: '', at: Date.now() });
    return '';
  }
  // 行号 gutter 是显示层：清单解析必须拿原文（read_file 默认带 N→ 前缀）。
  const raw = resultText(await runTool(tools, 'read_file', { path: manifest, lineNumbers: false }, options.signal));
  if (!raw) return '';

  const input: VerificationManifestInput = { rootEntries };
  if (manifest === 'package.json') input.packageJson = raw;
  else if (manifest === 'pyproject.toml') input.pyproject = raw;
  else if (manifest === 'Cargo.toml') input.cargoToml = raw;
  else if (manifest === 'go.mod') input.goMod = raw;
  else input.makefile = raw;

  const entry = detectVerificationEntry(input);
  const text = entry ? formatVerificationEntry(entry) : '';
  cache.set(tools, { text, at: Date.now() });
  return text;
}

/** 只给测试用：清掉某个 adapter 的缓存。 */
export function clearVerificationEntryCache(tools?: ToolAdapter): void {
  if (tools) cache.delete(tools);
}
