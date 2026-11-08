// src/shared/errorLog.ts
// 运行时错误台账的共享面：行格式与工具失败条目构造。
//
// ~/.pure/gui_errors.log 原本只收 GUI WebView 的未捕获异常（errorLedger），
// 现在扩成四源运行时错误台账——webview（页面内异常）/ rust（panic 钩子）/
// tool（工具调用失败，本模块构造）/ cli（CLI 侧自记）。JSONL 一行一条，
// 各宿主自选写入通道（CLI 直接 node:fs append；GUI WebView 走 Rust
// gui_error_log 命令；Rust 自身直接 append），写入方只认「一行一个 JSON
// 对象」的契约。轮转阈值 1MB：超限整文件改名为 .old（保一代），TS 与
// Rust 两侧各自实现同一数字——跨语言共享一个常量的机制成本大于收益。
//
// 字段纪律：message/detail/stack 一律截断到 4000 字符；工具失败条目**只
// 记工具名、错误文本与耗时，绝不记参数值**——configure_channel 这类工具
// 的参数里就是凭据明文，台账落盘即泄漏。

export type ErrorLogSource = 'webview' | 'rust' | 'tool' | 'cli';

export interface ErrorLogEntry {
  ts: number;
  source: ErrorLogSource;
  kind: string;
  message: string;
  detail?: string;
  stack?: string;
}

export const ERROR_LOG_FIELD_CAP = 4000;
/** 轮转阈值：主文件超过即整体改名保一代（两侧同值）。 */
export const ERROR_LOG_ROTATE_BYTES = 1_000_000;

const cap = (v: string): string => (v.length > ERROR_LOG_FIELD_CAP ? v.slice(0, ERROR_LOG_FIELD_CAP) : v);

/** 序列化一行 JSONL。undefined 字段整键省略，超长字段截断；永不抛。 */
export function formatErrorLine(entry: ErrorLogEntry): string {
  const out: Record<string, unknown> = {
    ts: entry.ts,
    source: entry.source,
    kind: entry.kind,
    message: cap(entry.message),
  };
  if (entry.detail !== undefined && entry.detail !== '') out.detail = cap(entry.detail);
  if (entry.stack !== undefined && entry.stack !== '') out.stack = cap(entry.stack);
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ ts: entry.ts, source: entry.source, kind: entry.kind, message: 'unserializable error entry' });
  }
}

/** 工具调用失败条目。错误文本截断在前（工具名本身短），耗时进 detail。 */
export function buildToolErrorEntry(ts: number, toolName: string, errorText: string, durationMs: number): ErrorLogEntry {
  return {
    ts,
    source: 'tool',
    kind: 'tool_error',
    message: cap(`${toolName}: ${errorText || '(no error text)'}`),
    detail: `durationMs=${durationMs}`,
  };
}
