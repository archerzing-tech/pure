// src/shared/readFileHead.ts
// 刀 D1（2026-10-10）read_file 真杠杆的共享面：默认（模型未给行范围）大文件
// 只返回头部切片 + 总行数 + 建议范围，不做硬截断。小文件零变化；真大文件
// 不再整份进上下文逼出引擎 40k 盲截（截掉的尾巴连总行数都不知道）。头部
// 预算按引擎 capToolResult 的 40k chars 留足余量——脚注在引擎截断下也能
// 存活。Rust 侧（src-tauri/src/lib.rs read_file_impl / slice_read_file_text）
// 镜像同一套常数与脚注文案，改这里必须同步改那边。

/** 默认头部行数上限：绝大多数源码文件全文返回，不受任何影响。 */
export const READ_FILE_HEAD_LINES = 2000;

/** 头部字符预算：给引擎 40k 截断留足余量，保证脚注（总行数 + 建议范围）
 *  不被引擎截断吃掉。 */
export const READ_FILE_HEAD_MAX_CHARS = 32_000;

/** 首行本身超出预算时的说明：行号续读无法表达"第 1 行的剩余部分"
 *  （startLine=2 会整行跳过），所以必须换一条出路文案。 */
export interface ReadFileHeadPartialFirstLine {
  /** 已展示的字符数。 */
  shown: number;
  /** 首行总字符数。 */
  total: number;
}

export interface ReadFileHeadSlice {
  text: string;
  /** 完整纳入切片的行数；首行超长时恒为 0。 */
  count: number;
  /** 首行超长（单行 JSON / minified JS / 单行 CSV）：text 是首行前缀。 */
  partialFirstLine?: ReadFileHeadPartialFirstLine;
}

/** 按码点边界截断，避免把 surrogate pair 切成两半。 */
function sliceAtCodePointBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.charCodeAt(limit - 1) >= 0xd800 && text.charCodeAt(limit - 1) <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, Math.max(1, cut));
}

// ── 显式范围（startLine/endLine）输出预算（2026-11-17）──────────────────
// 旧语义「显式范围原样给、不加脚注」只对小范围成立：范围请求本身也可能大到
// 撞引擎 capToolResult 的 40k 盲截，而盲截 notice 只会循环指路（「请用
// startLine/endLine」——模型刚做过这件事，拿到半截还不知道尾巴有多长）。
// 预算哲学与头部切片同款：32k 字符，给引擎 40k 留余量，保证脚注在盲截下
// 存活。行内超长（minified JS / 单行 JSON / 长 base64）参照 Claude Code 的
// 按行截断：整行过桥只会烧 IPC 再被盲截，截断加标记让模型至少知道这行有
// 多长。Rust 侧镜像在 src-tauri/src/lib.rs 的 finish_explicit_range，改这里
// 必须同步改那边（常数 + 标记 + 脚注逐字一致）。

/** 单行截断阈值（Claude Code 同款 2000 字符）。 */
export const READ_FILE_LINE_MAX_CHARS = 2_000;

/** 显式范围输出的字符预算。 */
export const READ_FILE_RANGE_MAX_CHARS = 32_000;

export interface ReadFileRangeSlice {
  /** 处理后的文本：行内超长已截断加标记，整体超预算已按行截到整行。 */
  text: string;
  /** 请求范围内的总行数。 */
  totalLines: number;
  /** 实际展示的行数；< totalLines 表示超预算截断（应追加续读脚注）。 */
  shownLines: number;
  /** 行内超长被截断标记过的行数（标记已内联在 text 里）。 */
  clippedLines: number;
}

/** 行内截断：按码点数取前 READ_FILE_LINE_MAX_CHARS 个字符再补标记。先用
 * UTF-16 长度做廉价上界快判，超界才做 O(n) 码点计数——10MB 单行不再生成
 * 百万元素数组。 */
function clipLine(line: string): { text: string; clipped: boolean } {
  if (line.length <= READ_FILE_LINE_MAX_CHARS) return { text: line, clipped: false };
  const total = [...line].length;
  if (total <= READ_FILE_LINE_MAX_CHARS) return { text: line, clipped: false };
  const shown = sliceAtCodePointBoundary(line, READ_FILE_LINE_MAX_CHARS);
  return {
    text: `${shown}…[本行共 ${total} 字符，已截断；读剩余部分用 execute_command 分段提取]`,
    clipped: true,
  };
}

/** 显式范围切片：行内超长截断加标记 → 整体超预算按行截断。首行恒保留
 * （clip 后每行 ≤ 约 2.1k 字符，必然落在预算内）。 */
export function readFileRangeSlice(lines: string[]): ReadFileRangeSlice {
  let clippedLines = 0;
  let chars = 0;
  let shown = 0;
  const processed: string[] = [];
  for (const line of lines) {
    const clip = clipLine(line);
    if (clip.clipped) clippedLines++;
    if (shown > 0 && chars + clip.text.length + 1 > READ_FILE_RANGE_MAX_CHARS) break;
    chars += clip.text.length + 1;
    shown++;
    processed.push(clip.text);
  }
  return { text: processed.join('\n'), totalLines: lines.length, shownLines: shown, clippedLines };
}

/** 超预算截断的续读脚注：范围总行数 + 已显示行数 + 续读起点。
 * rangeStartLine 是该范围第一行的 1 基行号（模型视角）。 */
export function readFileRangeFooter(rangeStartLine: number, shownLines: number, totalLines: number): string {
  return `[read_file：范围共 ${totalLines} 行，以上显示前 ${shownLines} 行（超字符预算，已按行截断）。继续读用 startLine=${rangeStartLine + shownLines}（可配 endLine）；定位内容用 code_searcher。]`;
}

/** 头部切片：取前 READ_FILE_HEAD_LINES 行、且不超过 READ_FILE_HEAD_MAX_CHARS
 *  字符（按行整体取，行中不截断）。count < lines.length 表示截取发生。
 *  首行单行超预算时不再返回空文本（旧行为 count=0 → 模型只拿到"前 0 行"
 *  的脚注，正文全丢）：改为返回首行前缀 + partialFirstLine 标记。 */
export function readFileHeadSlice(lines: string[]): ReadFileHeadSlice {
  const first = lines[0] ?? '';
  if (first.length + 1 > READ_FILE_HEAD_MAX_CHARS) {
    const text = sliceAtCodePointBoundary(first, READ_FILE_HEAD_MAX_CHARS - 1);
    return {
      text,
      count: 0,
      partialFirstLine: { shown: text.length, total: first.length },
    };
  }
  let chars = 0;
  let count = 0;
  for (const line of lines) {
    if (count >= READ_FILE_HEAD_LINES) break;
    if (chars + line.length + 1 > READ_FILE_HEAD_MAX_CHARS) break;
    chars += line.length + 1;
    count++;
  }
  return { text: lines.slice(0, count).join('\n'), count };
}

/** 续读脚注：总行数 + 建议范围 + 定点查找指路。首行超长时给字节/字符
 *  分段提取的出路——行号范围到不了"同一行的后半段"。 */
export function readFileHeadFooter(
  count: number,
  total: number,
  partialFirstLine?: ReadFileHeadPartialFirstLine,
): string {
  if (partialFirstLine) {
    return `[read_file：首行过长（共 ${partialFirstLine.total} 字符），以上只显示该行前 ${partialFirstLine.shown} 字符——按行号无法续读这一行的剩余部分。剩余内容请用 execute_command 按字节/字符分段提取（如 tail -c +N），或用 code_searcher 定位。]`;
  }
  return `[read_file：以上是前 ${count} 行，文件共 ${total} 行。继续读用 startLine=${count + 1}（可配 endLine）；定位内容用 code_searcher。]`;
}
