const DEFAULT_MAX_CHARS = 8000;
const HEAD_CHARS = 1200;
const TAIL_CHARS = 600;

export interface ToolResultDigestSummary {
  toolName?: string;
  sizeChars: number;
  truncated: boolean;
  summary: string;
}

export function summarizeToolResult(
  toolName: string | undefined,
  content: string | undefined,
  maxChars = DEFAULT_MAX_CHARS,
): ToolResultDigestSummary | null {
  const raw = content ?? '';
  const size = raw.length;
  if (size < maxChars) return null;

  const head = raw.slice(0, HEAD_CHARS);
  const tail = raw.slice(Math.max(0, size - TAIL_CHARS));
  const summary = `[${toolName ?? 'tool'}: 约 ${Math.round(size / 1024)}k 字符，首 ${HEAD_CHARS} + ... + 尾 ${TAIL_CHARS} 截断] ${head}${tail.length ? ' ... ' + tail : ''}`.slice(0, 2000);
  return {
    toolName,
    sizeChars: size,
    truncated: true,
    summary,
  };
}
