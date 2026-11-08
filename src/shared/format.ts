// src/shared/format.ts
// Shared formatting + arg-parsing helpers, used by the GUI adapter
// (TauriToolAdapter), the CLI adapter (NodeToolAdapter) and the engine layers.
// Single source of truth — these were previously duplicated in every adapter
// with identical bodies (and drift risk) on both sides of the runtime split.

import { t } from './i18n';

/** Parse a tool call's JSON arguments. Malformed input yields {} instead of
 * throwing — the LLM occasionally emits invalid JSON, and the tool then sees
 * no args rather than crashing the turn. The optional onError callback lets a
 * caller keep its own diagnostic logging on parse failure (DeepSeekAnthropic
 * warns with a truncated raw payload) without duplicating the parser. */
export function safeParseArgs(raw: string, onError?: (raw: string) => void): Record<string, unknown> {
  try { return JSON.parse(raw); } catch {
    onError?.(raw);
    return {};
  }
}

/** Build the error message for a failed command (non-zero exit code). */
export function formatCommandError(exitCode: number, output: string): string {
  const tail = output.trim() ? `:\n${output.trim()}` : '';
  return `Command failed with exit code ${exitCode}${tail}`;
}

// ── 良性 exit 1 白名单（电脑端操作能力 P1，2026-11-08；CLI/GUI 两侧同源）──
// grep/rg/find/diff/test/[ 与 `git diff|git grep` 的 exit 1 语义是「无匹配/
// 有差异」，不是执行失败——按失败报会把「没找到」烧进失败策略。只有
// exit 1 豁免，exit ≥2 仍是真失败。
const BENIGN_EXIT_ONE_FIRST_WORDS = new Set(['grep', 'rg', 'find', 'diff', 'test', '[']);

export function isBenignNoMatchExit(command: string, exitCode: number): boolean {
  if (exitCode !== 1) return false;
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? '';
  return BENIGN_EXIT_ONE_FIRST_WORDS.has(first) || /^git\s+(?:diff|grep)\b/.test(trimmed);
}

/** Human-readable byte size ("512 B", "12.3 KB", "1.5 MB") — used by the
 * write_file progress lines and the tool row's pending label. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前），复用记忆库那套 i18n 文案
 * ——同一个用户感受，不另造词。此前在三处各抄了一份，这里是唯一实现。 */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return t('memory.justNow', '刚刚');
  if (diff < HOUR) return t('memory.minAgo', '{n} 分钟前').replace('{n}', String(Math.floor(diff / MIN)));
  if (diff < DAY) return t('memory.hourAgo', '{n} 小时前').replace('{n}', String(Math.floor(diff / HOUR)));
  return t('memory.dayAgo', '{n} 天前').replace('{n}', String(Math.floor(diff / DAY)));
}
