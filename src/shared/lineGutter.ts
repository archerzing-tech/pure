// src/shared/lineGutter.ts
// read_file 的行号 gutter 与 edit_file 的改动回显（2026-11-22 编码回路刀 1）。
//
// 为什么要有行号：模型报 `path:line`、复核自己刚改的 20 行、把 outline 的
// 行号与正文对上，都需要一个稳定坐标系。此前正文是裸文本，模型只能数行——
// outline 给行号、正文不给，同一文件两套坐标系。
//
// 为什么剥离要「整块都带 gutter」才动手：直接剥 `^\d+→` 会误伤真实内容
// （配置文件里以「12→」开头的行是合法的）。只有模型把整段编号正文复制进
// oldString 时，每一行才都带前缀——这个形状足以把「复制了显示层」与「文件
// 本来就这样」区分开。返回 null 表示「不是编号块」，调用方原样使用。

const GUTTER_LINE = /^[ \t]*\d+→/;

/** 给一段正文加 `N→` 前缀；startLine 是该段第一行的 1 基行号。 */
export function formatNumberedLines(lines: string[], startLine = 1): string {
  return lines.map((line, index) => `${startLine + index}→${line}`).join('\n');
}

/**
 * 剥掉整块行号 gutter。仅当每一行（空行除外）都带前缀且至少命中一行时
 * 才返回剥离结果；否则返回 null，调用方保留原文。
 */
export function stripLineNumberGutter(text: string): string | null {
  const lines = text.split('\n');
  let any = false;
  const output: string[] = [];
  for (const line of lines) {
    if (GUTTER_LINE.test(line)) {
      any = true;
      output.push(line.replace(GUTTER_LINE, ''));
      continue;
    }
    // 末尾换行产生的空串是合法的；非空且不带前缀 ⇒ 不是编号块。
    if (line === '') {
      output.push('');
      continue;
    }
    return null;
  }
  return any ? output.join('\n') : null;
}

/** 替换片段在改后文本里的行范围（1 基，endLine 按片段自身的换行数）。 */
export function lineRangeAt(
  text: string,
  index: number,
  replacement: string,
): { startLine: number; endLine: number } {
  const before = text.slice(0, Math.max(0, Math.min(index, text.length)));
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
  return {
    startLine,
    endLine: startLine + (replacement.match(/\n/g)?.length ?? 0),
  };
}

export interface EditHunkOptions {
  /** 改动点前后各留几行，默认 3。 */
  context?: number;
  /** 回显总行数上限，默认 10——回显是核对用的，不是把文件再贴一遍。 */
  maxLines?: number;
}

/**
 * 改动区域的带行号片段。超过 maxLines 时保留改动起点附近的窗口（模型的
 * 疑问几乎总在「我改的起点对不对」），而不是尾部。
 */
export function formatEditHunk(
  text: string,
  startLine: number,
  endLine: number,
  options: EditHunkOptions = {},
): string {
  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 10;
  const lines = text.split('\n');
  const from = Math.max(1, startLine - context);
  let to = Math.min(lines.length, Math.max(endLine, startLine) + context);
  if (to >= from && to - from + 1 > maxLines) to = from + maxLines - 1;
  if (from > lines.length) return '';
  return formatNumberedLines(lines.slice(from - 1, to), from);
}

/** 文件总行数（与 read_file 的 1 基行号同口径）。 */
export function totalLineCount(text: string): number {
  return text.split('\n').length;
}
