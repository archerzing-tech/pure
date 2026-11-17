// src/shared/__tests__/readFileHead.test.ts
// 单行超长文件的头切片契约：不返回空正文、不切断 surrogate pair、脚注给出
// 行号续读之外的出路（行号范围表达不了"第 1 行的剩余部分"）。

import { describe, expect, it } from 'bun:test';
import {
  READ_FILE_HEAD_MAX_CHARS,
  READ_FILE_LINE_MAX_CHARS,
  readFileHeadFooter,
  readFileHeadSlice,
  readFileRangeFooter,
  readFileRangeSlice,
} from '../readFileHead';

describe('readFileHeadSlice', () => {
  it('returns every line of a small file', () => {
    expect(readFileHeadSlice(['a', 'b', 'c'])).toEqual({ text: 'a\nb\nc', count: 3 });
  });

  it('stops at whole lines when the budget is hit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `f${i}-` + 'a'.repeat(8000));
    const head = readFileHeadSlice(lines);
    expect(head.count).toBe(3);
    expect(head.partialFirstLine).toBeUndefined();
    expect(head.text).toContain('f2-');
    expect(head.text).not.toContain('f3-');
  });

  it('returns a bounded prefix for one overlong line instead of empty text', () => {
    const head = readFileHeadSlice(['x'.repeat(40_000)]);
    expect(head.count).toBe(0);
    expect(head.text.length).toBe(READ_FILE_HEAD_MAX_CHARS - 1);
    expect(head.partialFirstLine).toEqual({
      shown: READ_FILE_HEAD_MAX_CHARS - 1,
      total: 40_000,
    });
    const footer = readFileHeadFooter(head.count, 1, head.partialFirstLine);
    expect(footer).toContain('首行过长');
    expect(footer).toContain('无法续读');
    expect(footer).not.toContain('以上是前 0 行');
  });

  it('does not split a surrogate pair at the cut', () => {
    const emoji = '😀';
    const line = 'a'.repeat(READ_FILE_HEAD_MAX_CHARS - 2) + emoji + 'b'.repeat(10);
    const head = readFileHeadSlice([line]);
    expect(head.partialFirstLine).toBeDefined();
    expect(head.text.length).toBe(READ_FILE_HEAD_MAX_CHARS - 2);
    expect(head.text.endsWith('\ud83d')).toBe(false);
  });

  it('keeps the normal continuation footer for multi-line files', () => {
    const footer = readFileHeadFooter(3, 10);
    expect(footer).toContain('继续读用 startLine=4');
  });
});

// 显式范围（startLine/endLine）输出预算（2026-11-17）：范围请求本身也可能
// 大到撞引擎 40k 盲截，盲截 notice 的循环指路（「请用 startLine/endLine」）
// 由这层预算堵死。Rust 侧 finish_explicit_range 逐字镜像。
describe('readFileRangeSlice — 显式范围预算（2026-11-17）', () => {
  it('keeps a small range verbatim', () => {
    const slice = readFileRangeSlice(['a', 'b', 'c']);
    expect(slice).toEqual({ text: 'a\nb\nc', totalLines: 3, shownLines: 3, clippedLines: 0 });
  });

  it('clips an overlong line with a length marker', () => {
    const slice = readFileRangeSlice(['x'.repeat(5000)]);
    expect(slice.clippedLines).toBe(1);
    expect(slice.shownLines).toBe(slice.totalLines);
    expect(slice.text.startsWith('x'.repeat(READ_FILE_LINE_MAX_CHARS))).toBe(true);
    expect(slice.text).toContain('本行共 5000 字符，已截断');
    expect(slice.text.length).toBeLessThan(3000);
  });

  it('does not split a surrogate pair when clipping', () => {
    const emoji = '😀';
    const line = 'a'.repeat(READ_FILE_LINE_MAX_CHARS - 1) + emoji + 'b'.repeat(50);
    const slice = readFileRangeSlice([line]);
    expect(slice.clippedLines).toBe(1);
    expect(slice.text.includes(emoji)).toBe(false);
    expect(slice.text).toContain('已截断');
  });

  it('cuts by whole lines at the range budget and reports the continue point', () => {
    // 每行 1900 字符（≤2000，不触发行内截断）×20 行 ≈ 38k > 32k → 取前
    // 16 行；续读起点 = 范围首行号 1 + 已显示 16 = 17。
    const lines = Array.from({ length: 20 }, (_, i) => `f${i + 1}-` + 'a'.repeat(1897));
    const slice = readFileRangeSlice(lines);
    expect(slice.shownLines).toBe(16);
    expect(slice.totalLines).toBe(20);
    expect(slice.clippedLines).toBe(0);
    expect(slice.text).toContain('f16-');
    expect(slice.text).not.toContain('f17-');
    const footer = readFileRangeFooter(1, slice.shownLines, slice.totalLines);
    expect(footer).toContain('范围共 20 行，以上显示前 16 行');
    expect(footer).toContain('继续读用 startLine=17');
  });
});
