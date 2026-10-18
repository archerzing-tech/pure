// src/ui/toolDiff.ts
// 工具行的紧凑红绿 diff(二档刀 1「diff 变更卡」,2026-10-18)。edit_file 的
// old→new、write_file 的旧→新内容在工具行 Output 面板里逐行呈现,改动一眼
// 可读,不用去开文件对。独立小模块:渲染链(toolRow.ts)静态 import 本文件,
// 刻意不 import markdown.ts——那会把整条懒加载重链(katex/echarts)拖进首屏;
// LCS 行对齐因此与 markdown.ts 的 diffLines(图修复浮层)同源算法、独立一份。

export interface ToolDiffRow {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
}

export interface ToolDiffData {
  rows: ToolDiffRow[];
  additions: number;
  removals: number;
  /** 渲染行截断后为 true(rows 只含前 MAX_DIFF_RENDER_ROWS 行)。 */
  truncated: boolean;
  /** write_file 覆盖了已有文件时为 true(头部徽标;新建文件为 false)。 */
  overwrite: boolean;
}

/** 任一侧超过此行数就不做逐行 diff(O(n·m) LCS 防炸),调用方退回普通文案。 */
export const MAX_DIFF_INPUT_LINES = 800;
/** 渲染行上限:一个工具调用的改动展示超过 60 行就该展开看文件了。 */
export const MAX_DIFF_RENDER_ROWS = 60;
/** 改动簇两侧保留的上下文行数(其余 same 行折叠)。 */
const DIFF_CONTEXT = 2;

type FlatRow = { kind: 'same' | 'del' | 'add'; text: string };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function lcsRows(a: string[], b: string[]): FlatRow[] {
  // 调用方用 MAX_DIFF_INPUT_LINES 挡过大输入,这里的 O(n·m) 表才有上界。
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: FlatRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      raw.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { raw.push({ kind: 'del', text: a[i] }); i++; }
  while (j < m) { raw.push({ kind: 'add', text: b[j] }); j++; }
  return raw;
}

/**
 * 行级 diff + 上下文压缩:远离改动的相同行折叠为 gap 行(渲染成「⋯ N 行未变 ⋯」),
 * 渲染超上限截断。输入超 MAX_DIFF_INPUT_LINES 时返回 null——调用方落回普通
 * 文案呈现,绝不在这里炸内存换一个美化视图。
 */
export function buildDiffRows(oldText: string, newText: string): Omit<ToolDiffData, 'overwrite'> | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_DIFF_INPUT_LINES || b.length > MAX_DIFF_INPUT_LINES) return null;
  const flat = lcsRows(a, b);
  const additions = flat.filter((r) => r.kind === 'add').length;
  const removals = flat.filter((r) => r.kind === 'del').length;

  // 上下文压缩:每个改动簇 ±DIFF_CONTEXT 内的 same 行保留;首尾前后的 same
  // 直接剪(开头一个 gap 没有信息量),中间被剪的段落合成一行 gap。
  const keep = new Array<boolean>(flat.length).fill(false);
  for (let k = 0; k < flat.length; k++) {
    if (flat[k].kind === 'same') continue;
    for (let d = Math.max(0, k - DIFF_CONTEXT); d <= Math.min(flat.length - 1, k + DIFF_CONTEXT); d++) {
      keep[d] = true;
    }
  }
  const rows: ToolDiffRow[] = [];
  let skipped = 0;
  for (let k = 0; k < flat.length; k++) {
    if (keep[k]) {
      if (skipped > 0 && rows.length > 0) rows.push({ kind: 'gap', text: String(skipped) });
      skipped = 0;
      rows.push({ kind: flat[k].kind, text: flat[k].text });
    } else {
      skipped++;
    }
  }

  let truncated = false;
  const shown = rows.length > MAX_DIFF_RENDER_ROWS ? (truncated = true, rows.slice(0, MAX_DIFF_RENDER_ROWS)) : rows;
  return { rows: shown, additions, removals, truncated };
}

/** 紧凑 diff 渲染:头(统计)+ 行列表(前缀符号 + 纯文本,textContent 防注入)。 */
export function renderToolDiff(host: HTMLElement, data: ToolDiffData): void {
  const head = document.createElement('div');
  head.className = 'tool-diff-head';
  const statAdd = document.createElement('span');
  statAdd.className = 'tool-diff-stat add';
  statAdd.textContent = `+${data.additions}`;
  head.appendChild(statAdd);
  const statDel = document.createElement('span');
  statDel.className = 'tool-diff-stat del';
  statDel.textContent = `−${data.removals}`;
  head.appendChild(statDel);
  if (data.overwrite) {
    const badge = document.createElement('span');
    badge.className = 'tool-diff-badge';
    badge.textContent = '覆盖已有文件';
    head.appendChild(badge);
  }
  host.appendChild(head);

  const list = document.createElement('div');
  list.className = 'tool-diff-rows';
  for (const row of data.rows) {
    const line = document.createElement('div');
    if (row.kind === 'gap') {
      line.className = 'tool-diff-row gap';
      line.textContent = `⋯ ${row.text} 行未变 ⋯`;
    } else {
      line.className = `tool-diff-row ${row.kind}`;
      line.textContent = `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`;
    }
    list.appendChild(line);
  }
  host.appendChild(list);

  if (data.truncated) {
    const more = document.createElement('div');
    more.className = 'tool-diff-more';
    more.textContent = '… 改动较多,其余行未显示';
    host.appendChild(more);
  }
}
