// src/shared/readFileHead.ts
// 刀 D1（2026-10-10）read_file 真杠杆的共享面：默认（模型未给行范围）大文件
// 只返回头部切片 + 总行数 + 建议范围，不做硬截断。小文件零变化；真大文件
// 不再整份进上下文逼出引擎 40k 盲截（截掉的尾巴连总行数都不知道）。头部
// 预算按引擎 capToolResult 的 40k chars 留足余量——脚注在引擎截断下也能
// 存活。Rust 侧（src-tauri/src/lib.rs read_file_impl）镜像同一套常数与脚注
// 格式，改这里必须同步改那边。

/** 默认头部行数上限：绝大多数源码文件全文返回，不受任何影响。 */
export const READ_FILE_HEAD_LINES = 2000;

/** 头部字符预算：给引擎 40k 截断留足余量，保证脚注（总行数 + 建议范围）
 *  不被引擎截断吃掉。 */
export const READ_FILE_HEAD_MAX_CHARS = 32_000;

/** 头部切片：取前 READ_FILE_HEAD_LINES 行、且不超过 READ_FILE_HEAD_MAX_CHARS
 *  字符（按行整体取，行中不截断）。count < lines.length 表示截取发生。 */
export function readFileHeadSlice(lines: string[]): { text: string; count: number } {
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

/** 续读脚注：总行数 + 建议范围 + 定点查找指路。 */
export function readFileHeadFooter(count: number, total: number): string {
  return `[read_file：以上是前 ${count} 行，文件共 ${total} 行。继续读用 startLine=${count + 1}（可配 endLine）；定位内容用 code_searcher。]`;
}
