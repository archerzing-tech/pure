// src/adapter/memory/toolCorrections.ts
// E1.3 — 工具/服务级自修正建议：把 error_pattern 记忆按（工具 × 错误分类）
// 聚簇，N 天内同类失败 ≥ 阈值 → 产出工具使用注意（note）建议。建议给用户，
// 点头才落库（设置页工具卡「采纳」/后续 CLI 命令）——绝不自动写：聚类只能
// 说明"这个工具在这台机器上常这么坏"，不说明怎么改才对，措辞交给用户把关。
//
// 采纳后的 note 复用 tool_preference 类型落到机器级全局作用域（platform 标注
// + dedupeKey 防重），注入端（Harness.composeMemoryPrompt 的机器级常驻注入）
// 原样携带进 <session_memory> 的 tools 段——零新类型、零新注入通道。

import { FAILURE_CLASS_HINTS, classifyFailure, type FailureClass } from '../../shared/netGuard';
import { GLOBAL_MEMORY_SCOPE, type IMemoryStore, type MemoryEntry } from '../../shared/types';

export interface ToolCorrectionOptions {
  /** 聚类窗口（天）。默认 14 —— 太短会追着偶发抖动跑，太长会建议早就修好的东西。 */
  windowDays?: number;
  /** 达到多少次才算"簇"。默认 3。 */
  minCluster?: number;
  now?: number;
}

export interface ToolCorrectionSuggestion {
  toolName: string;
  errorClass: FailureClass;
  count: number;
  windowDays: number;
  /** 簇里第一条原始错误（设置页展示用，给用户判断建议是否靠谱）。 */
  sampleMessage: string;
  /** 采纳后落库的 note 文本（tool_preference content）。 */
  note: string;
  /** 落库用的 dedupeKey —— 同（工具×分类）只有一条；扫描器靠它排除已采纳对。 */
  dedupeKey: string;
}

/** 已采纳 note 的 dedupeKey 前缀 —— 扫描器与落库共用，是"建议 ↔ 已处理"的唯一凭据。 */
export const TOOL_NOTE_DEDUPE_PREFIX = 'tool-note:';

/** 所有错误写入方（writeErrorPattern / Repeated / Single / Recovered）都把
 *  工具名包在 `(tool: xxx)` 里 —— 这是唯一的结构化来源，没有就归因不了。 */
const TOOL_TAG_RE = /\(tool: ([^)\s]+)\)/;

/** 平台判定 —— 与 Harness.currentPlatform 同一逻辑（私有方法无法复用）：
 *  process.platform 优先，浏览器环境按 UA，最后 unknown。 */
export function detectPlatform(): string {
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return 'win32';
    if (/Mac/i.test(ua)) return 'darwin';
    if (/Linux/i.test(ua)) return 'linux';
  }
  return 'unknown';
}

/**
 * 聚类扫描：纯函数、同步、O(entries)。输入一条记忆列表（通常 memory.list()
 * 全量，跨项目 —— 工具注意是机器级的，不该按项目切片），输出按失败次数降序
 * 的建议（封顶 8 条，避免设置页被刷屏）。已采纳（tool_preference 里有对应
 * dedupeKey）的（工具×分类）对不再重复建议。
 */
export function scanToolCorrections(entries: MemoryEntry[], options: ToolCorrectionOptions = {}): ToolCorrectionSuggestion[] {
  const windowDays = options.windowDays ?? 14;
  const minCluster = options.minCluster ?? 3;
  const now = options.now ?? Date.now();
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

  const approved = new Set(
    entries
      .filter((e) => e.type === 'tool_preference' && typeof e.dedupeKey === 'string' && e.dedupeKey.startsWith(TOOL_NOTE_DEDUPE_PREFIX))
      .map((e) => (e.dedupeKey as string).slice(TOOL_NOTE_DEDUPE_PREFIX.length)),
  );

  const clusters = new Map<string, { count: number; sample: string }>();
  for (const entry of entries) {
    if (entry.type !== 'error_pattern') continue;
    if (entry.timestamp < windowStart || entry.timestamp > now) continue;
    const tool = TOOL_TAG_RE.exec(entry.content)?.[1];
    if (!tool) continue;
    const errorClass = classifyFailure(entry.content);
    const key = `${tool}::${errorClass}`;
    const bucket = clusters.get(key) ?? { count: 0, sample: entry.content };
    bucket.count++;
    clusters.set(key, bucket);
  }

  return [...clusters.entries()]
    .filter(([key, bucket]) => bucket.count >= minCluster && !approved.has(key))
    .map(([key, bucket]) => {
      const [toolName, errorClass] = key.split('::') as [string, FailureClass];
      const hint = FAILURE_CLASS_HINTS[errorClass];
      return {
        toolName,
        errorClass,
        count: bucket.count,
        windowDays,
        sampleMessage: bucket.sample,
        note: `Caution: ${toolName} hit ${bucket.count} ${errorClass} failures in ${windowDays} days on this machine.${hint ? ` ${hint}` : ''}`,
        dedupeKey: `${TOOL_NOTE_DEDUPE_PREFIX}${key}`,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/**
 * 采纳：把 note 以 tool_preference 落到机器级全局作用域（platform 标注，注入
 * 端按平台过滤），dedupeKey 保证同一（工具×分类）只落一条。store 需要支持
 * add() —— CLI 传 FSMemoryStore，GUI 传包装后的 memoryStore 单例。
 */
export async function approveToolCorrection(
  store: Pick<IMemoryStore, 'add'>,
  suggestion: ToolCorrectionSuggestion,
  platform: string = detectPlatform(),
): Promise<string> {
  return store.add({
    type: 'tool_preference',
    content: suggestion.note.slice(0, 300),
    timestamp: Date.now(),
    sessionId: 'tool-correction',
    projectPath: GLOBAL_MEMORY_SCOPE,
    platform,
    dedupeKey: suggestion.dedupeKey,
  });
}
