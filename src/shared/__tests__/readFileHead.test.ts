// src/shared/__tests__/readFileHead.test.ts
// 单行超长文件的头切片契约：不返回空正文、不切断 surrogate pair、脚注给出
// 行号续读之外的出路（行号范围表达不了"第 1 行的剩余部分"）。

import { describe, expect, it } from 'bun:test';
import {
  READ_FILE_HEAD_MAX_CHARS,
  readFileHeadFooter,
  readFileHeadSlice,
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
