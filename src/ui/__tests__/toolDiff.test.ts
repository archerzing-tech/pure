// src/ui/__tests__/toolDiff.test.ts
// 工具行 diff 变更卡(二档刀 1,2026-10-18)的纯函数层:行级 diff、上下文
// 压缩、大输入防炸闸、渲染截断。渲染(renderToolDiff)的挂卡断言在
// toolRow.test.ts(那里有 fake document 基建)。
import { describe, it, expect } from 'bun:test';
import { buildDiffRows, MAX_DIFF_INPUT_LINES, MAX_DIFF_RENDER_ROWS, type ToolDiffRow } from '../toolDiff';

const kinds = (rows: ToolDiffRow[]) => rows.map((r) => r.kind);

describe('buildDiffRows 行级 diff', () => {
  it('替换一段:删行与加行成对,统计正确', () => {
    const d = buildDiffRows('const a = 1;\nconst b = 2;\nconst c = 3;', 'const a = 1;\nconst b = 42;\nconst c = 3;');
    expect(d).not.toBeNull();
    expect(d!.additions).toBe(1);
    expect(d!.removals).toBe(1);
    expect(kinds(d!.rows)).toEqual(['same', 'del', 'add', 'same']);
    expect(d!.rows[1].text).toBe('const b = 2;');
    expect(d!.rows[2].text).toBe('const b = 42;');
  });

  it('纯新增(write 新建文件):全 add,old 为空串', () => {
    const d = buildDiffRows('', 'line1\nline2\nline3');
    expect(d).not.toBeNull();
    expect(d!.removals).toBe(0);
    expect(d!.additions).toBe(3);
    expect(kinds(d!.rows)).toEqual(['add', 'add', 'add']);
  });

  it('内容完全一致:无改动簇 → 全部剪除,rows 空(调用方退回普通文案)', () => {
    const d = buildDiffRows('a\nb', 'a\nb');
    expect(d).not.toBeNull();
    expect(d!.additions).toBe(0);
    expect(d!.removals).toBe(0);
    expect(d!.rows).toHaveLength(0);
  });

  it('尾部换行差异不产生噪音行(与 markdown diffLines 同源约定)', () => {
    const withNl = buildDiffRows('a\nb\n', 'a\nb');
    expect(withNl).not.toBeNull();
    expect(withNl!.additions).toBe(0);
    expect(withNl!.removals).toBe(0);
  });
});

describe('buildDiffRows 上下文压缩', () => {
  it('远离改动的相同行折叠为 gap,改动簇两侧保留 2 行上下文', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const b = a.replace('line 11', 'line 11 CHANGED');
    const d = buildDiffRows(a, b);
    expect(d).not.toBeNull();
    expect(kinds(d!.rows)).toEqual(['same', 'same', 'del', 'add', 'same', 'same']);
    // 首尾 same 直接剪,中间 gap 不在这里出现——20 行输入,改动簇 ±2 恰好
    // 覆盖 9..13,两端 line 1..8 / 14..20 被剪,不产生 gap(不在两簇之间)。
  });

  it('两个远隔的改动簇之间合成一个 gap 行,带省略行数;首尾剪除不产生 gap', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const b = a.replace('line 3', 'L3').replace('line 27', 'L27');
    const d = buildDiffRows(a, b);
    expect(d).not.toBeNull();
    const gaps = d!.rows.filter((r) => r.kind === 'gap');
    expect(gaps).toHaveLength(1);
    // 32 个对齐位置(30 行 + 两处替换各 del/add),保留两簇 ±2 共 12 个;
    // 中间段 19 行合成 gap,开头 2 行与结尾 1 行(位置 31)静默剪除。
    expect(gaps[0].text).toBe('19');
  });
});

describe('buildDiffRows 防炸与截断', () => {
  it(`任一侧超 ${MAX_DIFF_INPUT_LINES} 行返回 null(调用方退回普通文案)`, () => {
    const big = Array.from({ length: MAX_DIFF_INPUT_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    expect(buildDiffRows(big, 'x')).toBeNull();
    expect(buildDiffRows('x', big)).toBeNull();
  });

  it(`渲染超 ${MAX_DIFF_RENDER_ROWS} 行截断,truncated=true,统计仍是全量`, () => {
    const a = Array.from({ length: 100 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 100 }, (_, i) => `new ${i}`).join('\n');
    const d = buildDiffRows(a, b);
    expect(d).not.toBeNull();
    expect(d!.truncated).toBe(true);
    expect(d!.rows).toHaveLength(MAX_DIFF_RENDER_ROWS);
    expect(d!.additions).toBe(100);
    expect(d!.removals).toBe(100);
  });

  it('不超上限时 truncated=false 且 rows 原样', () => {
    const d = buildDiffRows('a', 'b');
    expect(d!.truncated).toBe(false);
  });
});
