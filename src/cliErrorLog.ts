// src/cliErrorLog.ts
// 错误台账的 CLI 面：写入（append + 轮转）与读取（pure errors）。
//
// CLI 宿主有 node:fs，直写 ~/.pure/gui_errors.log——与 GUI WebView（Rust
// gui_error_log 命令）、Rust panic 钩子共认同一份 JSONL。轮转阈值与 TS/Rust
// 两侧同值（shared/errorLog.ts 的 ERROR_LOG_ROTATE_BYTES）。
//
// `pure errors [N] [--json] [--clear]` 是调测入口：tail 最近 N 条（默认
// 20）人读格式；--json 原样吐行；--clear 清空重开（调测会话常用的隔离
// 动作，显式 flag 才删数据）。

import { appendFileSync, existsSync, renameSync, readFileSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ERROR_LOG_ROTATE_BYTES, formatErrorLine, buildToolErrorEntry } from './shared/errorLog';

export const CLI_ERROR_LOG_PATH = join(homedir(), '.pure', 'gui_errors.log');
const ROTATED_SUFFIX = '.old';

/** 超限整文件让位给 .old（同名 .old 直接覆盖，只保一代）。 */
export function rotateCliErrorLogIfNeeded(path: string = CLI_ERROR_LOG_PATH, maxBytes: number = ERROR_LOG_ROTATE_BYTES): void {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return;
    const old = `${path}${ROTATED_SUFFIX}`;
    if (existsSync(old)) unlinkSync(old);
    renameSync(path, old);
  } catch {
    // 轮转失败不阻断写入主路径——台账永远不能成为新故障源。
  }
}

/** 单行落盘（append + 超限轮转）。永不抛。 */
export function appendCliErrorLogLine(line: string, path: string = CLI_ERROR_LOG_PATH): void {
  try {
    rotateCliErrorLogIfNeeded(path);
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    // 写不进就丢弃——台账自身皮实优先。
  }
}

/** CLI registry 的工具失败记账 sink：拿到的是已序列化的 JSONL 行。 */
export function createCliErrorLogSink(): (line: string) => void {
  return (line: string) => appendCliErrorLogLine(line);
}

/** 便捷入口：直接从条目字段落一条（CLI 侧自记错误用）。 */
export function recordCliError(kind: string, message: string, detail?: string): void {
  appendCliErrorLogLine(formatErrorLine({ ts: Date.now(), source: 'cli', kind, message, ...(detail ? { detail } : {}) }));
}

export interface ParsedErrorRow {
  ts: number;
  source: string;
  kind: string;
  message: string;
  detail?: string;
  stack?: string;
  raw: string;
}

/** 解析 JSONL 台账；坏行原样保留（raw），读取永不抛。 */
export function parseErrorLog(text: string): ParsedErrorRow[] {
  const rows: ParsedErrorRow[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      rows.push({
        ts: typeof o.ts === 'number' ? o.ts : 0,
        source: typeof o.source === 'string' ? o.source : '(legacy)',
        kind: typeof o.kind === 'string' ? o.kind : '?',
        message: typeof o.message === 'string' ? o.message : '',
        detail: typeof o.detail === 'string' ? o.detail : undefined,
        stack: typeof o.stack === 'string' ? o.stack : undefined,
        raw: line,
      });
    } catch {
      rows.push({ ts: 0, source: '(corrupt)', kind: '?', message: line.slice(0, 200), raw: line });
    }
  }
  return rows;
}

const twoDigits = (n: number): string => String(n).padStart(2, '0');

function formatTimestamp(ts: number): string {
  if (!ts) return '?';
  const d = new Date(ts);
  return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`;
}

/** 人读渲染：时间 源/类别 消息（detail 次行缩进）。纯函数便于测试。 */
export function formatErrorRows(rows: ParsedErrorRow[]): string {
  if (rows.length === 0) return '（台账为空——没有记录到运行时错误）';
  return rows
    .map((r) => {
      const head = `${formatTimestamp(r.ts)} [${r.source}/${r.kind}] ${r.message}`;
      return r.detail ? `${head}\n    ${r.detail}` : head;
    })
    .join('\n');
}

export function runErrorLogCommand(rest: string[], logPath: string = CLI_ERROR_LOG_PATH): number {
  const wantsJson = rest.includes('--json');
  const wantsClear = rest.includes('--clear');
  const countArg = rest.find((a) => /^\d+$/.test(a));
  const count = Math.max(1, Math.min(500, countArg ? Number(countArg) : 20));

  if (wantsClear) {
    try {
      truncateSync(logPath, 0);
      process.stdout.write(`已清空 ${logPath}\n`);
    } catch (err) {
      process.stdout.write(`清空失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }

  let rows: ParsedErrorRow[] = [];
  try {
    if (existsSync(logPath)) rows = parseErrorLog(readFileSync(logPath, 'utf8'));
  } catch (err) {
    process.stdout.write(`读取失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const total = rows.length;
  const tail = rows.slice(-count);
  if (wantsJson) {
    for (const row of tail) process.stdout.write(`${row.raw}\n`);
  } else {
    const header = total > tail.length ? `最近 ${tail.length} 条 / 共 ${total} 条（全部：pure errors ${Math.min(total, 500)}）\n` : `共 ${total} 条\n`;
    process.stdout.write(`${header}${formatErrorRows(tail)}\n`);
  }
  return 0;
}

// 工具失败条目在本模块的再导出：cliHarness 装配 sink 时用同一构造器，
// 保证 CLI 与 GUI 记出的 tool 行同构。
export { buildToolErrorEntry };
