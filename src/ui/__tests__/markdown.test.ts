// src/ui/__tests__/markdown.test.ts
// Covers pure-logic helpers from the markdown renderer that don't need a DOM:
//  • suggestFilename — default name for the code-block save dialog
//  • highlightExt   — the `==text==` → <mark> inline highlight extension
//    (marked parses headlessly; no document/window required)

import { describe, it, expect } from 'bun:test';
import { Marked } from 'marked';
import { suggestFilename, highlightExt, parseChartSource, groupAdjacentSvgSlots, diagramSlot, type DiagramKind } from '../markdown';
import { buildChartOption } from '../echartsChart';

// ── ==text== highlight extension ──

describe('highlightExt (==text== → <mark>)', () => {
  const md = new Marked({ gfm: true, breaks: true });
  md.use({ extensions: [highlightExt] });

  it('wraps ==text== in <mark>', () => {
    const html = md.parse('这是 ==重要提示== 内容') as string;
    expect(html).toContain('<mark>重要提示</mark>');
  });

  it('renders the surrounding prose untouched', () => {
    const html = md.parse('前 ==高亮== 后') as string;
    expect(html).toContain('前 ');
    expect(html).toContain(' 后');
  });

  it('leaves comparisons and code-like text literal (no false positives)', () => {
    expect(md.parse('a == b') as string).not.toContain('<mark>');
    expect(md.parse('x === y') as string).not.toContain('<mark>');
    expect(md.parse('if (a==b) return;') as string).not.toContain('<mark>');
    expect(md.parse('`==inline==`') as string).not.toContain('<mark>');
  });

  it('rejects empty / whitespace-led content', () => {
    expect(md.parse('== ==') as string).not.toContain('<mark>');
    expect(md.parse('== spaced ==') as string).not.toContain('<mark>');
  });

  it('escapes the highlighted content', () => {
    const html = md.parse('==<b>x</b>==') as string;
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('suggestFilename', () => {
  it('prefers an explicit file/filename comment hint', () => {
    expect(suggestFilename('// file: main.ts\nconst x = 1;', 'ts')).toBe('main.ts');
    expect(suggestFilename('# filename: script.py\nprint(1)', 'python')).toBe('script.py');
    expect(suggestFilename('<!-- file: index.html -->\n<p>hi</p>', 'html')).toBe('index.html');
    expect(suggestFilename('-- file: db.sql\nSELECT 1;', 'sql')).toBe('db.sql');
  });

  it('maps a shebang to script.sh', () => {
    expect(suggestFilename('#!/usr/bin/env bash\necho hi', 'bash')).toBe('script.sh');
  });

  it('uses the canonical Dockerfile / Makefile names', () => {
    expect(suggestFilename('FROM node:20', 'dockerfile')).toBe('Dockerfile');
    expect(suggestFilename('all:;@echo hi', 'makefile')).toBe('Makefile');
  });

  it('falls back to code.<ext> by language, or code.txt for unknown langs', () => {
    expect(suggestFilename('fn main() {}', 'rust')).toBe('code.rs');
    expect(suggestFilename('print("hi")', 'python')).toBe('code.py');
    expect(suggestFilename('const x = 1;', 'typescript')).toBe('code.ts');
    expect(suggestFilename('???', 'weirdlang')).toBe('code.txt');
  });
});

function fakeElement(classes: string[], parent?: FakeElement): FakeElement {
  const classSet = new Set(classes);
  const element: FakeElement = {
    className: '',
    children: [],
    parentElement: parent,
    classList: {
      contains: (name: string) => classSet.has(name),
      add: (name: string) => { classSet.add(name); },
    },
    appendChild(child: FakeElement) {
      const oldParent = child.parentElement;
      if (oldParent) {
        const oldIndex = oldParent.children.indexOf(child);
        if (oldIndex >= 0) oldParent.children.splice(oldIndex, 1);
      }
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    insertBefore(child: FakeElement, reference: FakeElement) {
      const index = element.children.indexOf(reference);
      if (index < 0) return child;
      child.parentElement = element;
      element.children.splice(index, 0, child);
      return child;
    },
  };
  return element;
}

type FakeElement = {
  className: string;
  children: FakeElement[];
  parentElement?: FakeElement;
  classList: {
    contains(name: string): boolean;
    add(name: string): void;
  };
  appendChild(child: FakeElement): FakeElement;
  insertBefore(child: FakeElement, reference: FakeElement): FakeElement;
};

describe('diagramSlot', () => {
  it('starts with a ring loading placeholder and keeps the raw source for recovery', () => {
    const html = diagramSlot('svg', '<svg><text>secret</text></svg>', '');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('data-view="preview"');
    expect(html).toContain('diagram-loading-ring');
    expect(html).toContain('diagram-loading-label');
    expect(html).toContain('secret');
  });

  it('renders a single 下载图片 button and no view/source toggle', () => {
    const html = diagramSlot('svg', '<svg />', '<svg class="rendered" />');
    expect(html).toContain('>下载图片</button>');
    expect(html).toContain('class="diagram-preview svg-target"');
    // Source view is gone entirely: no toggle buttons, no format split.
    expect(html).not.toContain('data-diagram-view');
    expect(html).not.toContain('>查看源码</button>');
    expect(html).not.toContain('data-diagram-download');
  });

  it('keeps the full raw SVG source in the source block and data-raw for the viewer', () => {
    const raw = '<svg viewBox="0 0 10 10"><text>描述文字</text></svg>';
    const html = diagramSlot('svg', raw, '');
    // The source block escapes the markup but preserves every character.
    expect(html).toContain('&lt;svg viewBox="0 0 10 10"&gt;&lt;text&gt;描述文字&lt;/text&gt;&lt;/svg&gt;');
    // The data-raw attribute keeps the verbatim source for internal recovery.
    expect(html).toContain(`data-raw="${encodeURIComponent(raw)}"`);
  });

  it('gives every image kind the same single 下载图片 button with no source toggle', () => {
    const samples: Array<[DiagramKind, string]> = [
      ['svg', '<svg />'],
      ['chart', 'type: bar\nA 1\nB 2'],
      ['mermaid', 'graph TD; A-->B'],
      ['puml', '@startuml\nA-->B\n@enduml'],
    ];
    for (const [kind, source] of samples) {
      const html = diagramSlot(kind, source, '');
      expect(html).toContain('>下载图片</button>');
      expect(html).not.toContain('data-diagram-view');
      expect(html).not.toContain('data-diagram-download');
    }
  });

  it('keeps the raw chart DSL in the hidden source block for parse recovery', () => {
    const html = diagramSlot('chart', 'type: bar\nA 1\nB 2', '');
    expect(html).toContain('class="diagram-source chart-source"');
    expect(html).toContain('A 1');
  });
});

describe('groupAdjacentSvgSlots', () => {
  it('places consecutive SVG slots in a spaced gallery and leaves separated slots alone', () => {
    const oldDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: () => fakeElement([]),
    };
    try {
      const root = fakeElement([]);
      const first = fakeElement(['svg-slot'], root);
      const separator = fakeElement(['paragraph'], root);
      const second = fakeElement(['svg-slot'], root);
      const third = fakeElement(['svg-slot'], root);
      root.children.push(first, separator, second, third);

      groupAdjacentSvgSlots(root as unknown as HTMLElement);

      expect(root.children).toHaveLength(3);
      expect(root.children[0]).toBe(first);
      expect(root.children[1]).toBe(separator);
      expect(root.children[2].className).toBe('svg-gallery');
      expect(root.children[2].children).toEqual([second, third]);
    } finally {
      if (oldDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = oldDocument;
    }
  });
});

// ── ```chart DSL parsing + SVG generation ──

describe('parseChartSource', () => {
  it('parses type/title/unit config and label-value rows', () => {
    const spec = parseChartSource(`type: bar
title: 月度销售额
unit: 万元
一月 120
二月 180
三月 90`);
    expect(spec.type).toBe('bar');
    expect(spec.title).toBe('月度销售额');
    expect(spec.unit).toBe('万元');
    expect(spec.data).toEqual([
      { label: '一月', value: 120 },
      { label: '二月', value: 180 },
      { label: '三月', value: 90 },
    ]);
  });

  it('accepts a bare type word and CSV/tab separators', () => {
    const spec = parseChartSource('line\nA, 1\nB\t2\nC:3');
    expect(spec.type).toBe('line');
    expect(spec.data.map(d => d.value)).toEqual([1, 2, 3]);
    expect(spec.data[0].label).toBe('A');
  });

  it('maps hbar / horizontal bar / pie shorthand', () => {
    expect(parseChartSource('hbar\nX 1').type).toBe('hbar');
    expect(parseChartSource('horizontal bar\nX 1').type).toBe('hbar');
    expect(parseChartSource('pie\nA 1\nB 2').type).toBe('pie');
  });

  it('accepts a JSON payload', () => {
    const spec = parseChartSource(JSON.stringify({
      type: 'pie',
      title: '占比',
      data: [['A', 30], ['B', 70]],
    }));
    expect(spec.type).toBe('pie');
    expect(spec.title).toBe('占比');
    expect(spec.data).toHaveLength(2);
  });

  it('skips malformed lines and throws with no data rows', () => {
    const spec = parseChartSource('title: t\nnote about something\n# comment\nX 5');
    expect(spec.data).toEqual([{ label: 'X', value: 5 }]);
    expect(() => parseChartSource('title: nothing here')).toThrow();
    expect(() => parseChartSource('')).toThrow();
  });

  it('accepts common weather rows with full-width punctuation and temperature units', () => {
    const spec = parseChartSource(`type：line\ntitle：未来一周天气趋势\nunit：℃\n周一：25℃\n周二：26°C\n周三 | 24度\n周四, 23`);
    expect(spec.type).toBe('line');
    expect(spec.title).toBe('未来一周天气趋势');
    expect(spec.unit).toBe('℃');
    expect(spec.data).toEqual([
      { label: '周一', value: 25 },
      { label: '周二', value: 26 },
      { label: '周三', value: 24 },
      { label: '周四', value: 23 },
    ]);
  });

  it('accepts Markdown table rows emitted by weather responses', () => {
    const spec = parseChartSource(`日期 | 平均气温\n--- | ---\n| 周五 | 22℃ |\n| 周六 | 21°C |`);
    expect(spec.data).toEqual([
      { label: '周五', value: 22 },
      { label: '周六', value: 21 },
    ]);
  });

  it('accepts JSON weather values that include units', () => {
    const spec = parseChartSource(JSON.stringify({
      type: 'line',
      data: [{ label: '周日', value: '20℃' }],
    }));
    expect(spec.data).toEqual([{ label: '周日', value: 20 }]);
  });

  it('rejects JSON with no numeric rows after filtering', () => {
    expect(() => parseChartSource(JSON.stringify({
      type: 'line',
      data: [{ label: '周日', value: '暂无数据' }],
    }))).toThrow('at least one data row');
  });

  it('keeps date labels intact in Markdown tables', () => {
    const spec = parseChartSource('| 2026-08-06 | 25℃ |\n| 2026-08-07 | 26℃ |');
    expect(spec.data).toEqual([
      { label: '2026-08-06', value: 25 },
      { label: '2026-08-07', value: 26 },
    ]);
  });

  it('chooses the temperature column instead of a later wind column', () => {
    const spec = parseChartSource(`日期 | 天气 | 平均气温 | 风力\n--- | --- | --- | ---\n周一 | 晴 | 25℃ | 3级\n周二 | 阴 | 23℃ | 2级`);
    expect(spec.data).toEqual([
      { label: '周一 / 晴', value: 25 },
      { label: '周二 / 阴', value: 23 },
    ]);
  });

  it('does not extract digits from invalid numeric text', () => {
    expect(() => parseChartSource('周一 暂无数据12')).toThrow('at least one data row');
  });

  it('parses a multi-series table (header + ≥2 numeric columns) into named series', () => {
    const spec = parseChartSource(`type: line\ntitle: 双城气温\nunit: ℃\n日期 北京 上海\n周一 25 27\n周二 26 28\n周三 24 26`);
    expect(spec.type).toBe('line');
    expect(spec.series).toHaveLength(2);
    expect(spec.series?.[0].name).toBe('北京');
    expect(spec.series?.[1].name).toBe('上海');
    expect(spec.series?.[0].data.map(d => d.value)).toEqual([25, 26, 24]);
    expect(spec.series?.[1].data.map(d => d.value)).toEqual([27, 28, 26]);
    expect(spec.series?.[0].data[0].label).toBe('周一');
  });

  it('parses a markdown-table multi-series chart', () => {
    const spec = parseChartSource(`| 日期 | 北京 | 上海 |\n| --- | --- | --- |\n| 周一 | 25 | 27 |\n| 周二 | 26 | 28 |`);
    expect(spec.series?.[0].name).toBe('北京');
    expect(spec.series?.[1].name).toBe('上海');
    expect(spec.series?.[1].data.map(d => d.value)).toEqual([27, 28]);
  });

  it('parses CSV multi-series and defaults series names without a header', () => {
    const spec = parseChartSource('line\nA, 10, 20\nB, 11, 21');
    expect(spec.type).toBe('line');
    expect(spec.series?.[0].name).toBe('系列1');
    expect(spec.series?.[1].name).toBe('系列2');
    expect(spec.series?.[0].data.map(d => d.value)).toEqual([10, 11]);
  });

  it('keeps a numeric first column as the x label (years are not series values)', () => {
    const spec = parseChartSource(`line\n2024 10 20\n2025 15 25\n2026 22 30`);
    expect(spec.series).toHaveLength(2);
    expect(spec.series?.[0].name).toBe('系列1');
    expect(spec.series?.[0].data.map(d => d.label)).toEqual(['2024', '2025', '2026']);
    expect(spec.series?.[0].data.map(d => d.value)).toEqual([10, 15, 22]);
    expect(spec.series?.[1].data.map(d => d.value)).toEqual([20, 25, 30]);
  });

  it('keeps single-series weather tables single (categorical columns stay non-numeric)', () => {
    const spec = parseChartSource(`日期 | 天气 | 平均气温 | 风力\n--- | --- | --- | ---\n周一 | 晴 | 25℃ | 3级\n周二 | 阴 | 23℃ | 2级`);
    expect(spec.series).toBeUndefined();
    expect(spec.data).toEqual([
      { label: '周一 / 晴', value: 25 },
      { label: '周二 / 阴', value: 23 },
    ]);
  });

  it('keeps a pie chart with header + multi-columns single-series (no overlapping donuts)', () => {
    const spec = parseChartSource(`type: pie\ntitle: 来源占比\n渠道 线上 线下\n一月 60 40\n二月 55 45`);
    expect(spec.series).toHaveLength(2);
    const option = buildChartOption(spec, false);
    const series = option.series as Array<{ type?: string }>;
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('pie');
  });

  it('builds an echarts option from a complete weather chart response', () => {
    const spec = parseChartSource(`type：line\ntitle：未来一周天气\nunit：℃\n周一：25℃\n周二：26℃\n周三：24℃`);
    const option = buildChartOption(spec, false);
    const series = option.series as Array<{ type?: string }>;
    expect(series[0].type).toBe('line');
    expect((option.xAxis as { data?: string[] }).data).toEqual(['周一', '周二', '周三']);
    expect(option.title).toMatchObject({ text: '未来一周天气' });
  });
});

describe('buildChartOption', () => {
  const spec = (type: 'bar' | 'hbar' | 'line' | 'pie', data: Array<[string, number]>) => ({
    type,
    title: 'T',
    unit: '个',
    data: data.map(([label, value]) => ({ label, value })),
  });

  it('bar charts map categories to xAxis and values to the series', () => {
    const option = buildChartOption(spec('bar', [['A', 3], ['B', 7]]), false);
    const series = option.series as Array<{ type?: string; data?: Array<{ value: number }>; itemStyle?: { borderRadius?: number[] } }>;
    expect(series[0].type).toBe('bar');
    expect((option.xAxis as { data?: string[] }).data).toEqual(['A', 'B']);
    expect(series[0].data?.map(d => d.value)).toEqual([3, 7]);
    expect(series[0].itemStyle?.borderRadius).toEqual([6, 6, 0, 0]);
  });

  it('hbar maps categories to the inverted yAxis (first item on top)', () => {
    const option = buildChartOption(spec('hbar', [['A', 1], ['B', 2]]), false);
    const yAxis = option.yAxis as { inverse?: boolean; data?: string[] };
    expect((option.series as Array<{ type?: string }>)[0].type).toBe('bar');
    expect(yAxis.inverse).toBe(true);
    expect(yAxis.data).toEqual(['A', 'B']);
  });

  it('line charts use a line series with a gradient area fill', () => {
    const option = buildChartOption(spec('line', [['a', 1], ['b', 2]]), false);
    expect((option.series as Array<{ type?: string }>)[0].type).toBe('line');
    const area = (option.series as Array<{ areaStyle?: { color?: { type?: string } } }>)[0].areaStyle;
    expect(area?.color?.type).toBe('linear');
  });

  it('pie charts use donut radius, per-slice colors, and a vertical legend', () => {
    const option = buildChartOption(spec('pie', [['X', 25], ['Y', 75]]), false);
    const series = (option.series as Array<{ type?: string; radius?: string[]; data?: Array<{ value: number }> }>)[0];
    expect(series.type).toBe('pie');
    expect(series.radius).toEqual(['42%', '68%']);
    expect(series.data?.map(d => d.value)).toEqual([25, 75]);
    expect(option.legend).toMatchObject({ orient: 'vertical' });
  });

  it('throws for a pie with no positive values', () => {
    expect(() => buildChartOption(spec('pie', [['a', 0]]), false)).toThrow('positive');
  });

  it('appends the unit to axis-triggered tooltip lines', () => {
    const option = buildChartOption(spec('bar', [['A', 3], ['B', 7]]), false) as unknown as {
      tooltip: { formatter: (params: Array<{ name: string; value: number }>) => string };
    };
    expect(option.tooltip.formatter([{ name: 'A', value: 3 }])).toBe('A: 3个');
  });

  it('dark theme swaps text and palette colors', () => {
    const light = buildChartOption(spec('bar', [['A', 1]]), false);
    const dark = buildChartOption(spec('bar', [['A', 1]]), true);
    const lText = (light.textStyle as { color?: string }).color;
    const dText = (dark.textStyle as { color?: string }).color;
    expect(lText).not.toBe(dText);
    const lSeries = (light.series as Array<{ data?: Array<{ itemStyle: { color: string } }> }>)[0];
    const dSeries = (dark.series as Array<{ data?: Array<{ itemStyle: { color: string } }> }>)[0];
    expect(lSeries.data?.[0].itemStyle.color).not.toBe(dSeries.data?.[0].itemStyle.color);
  });

  it('keeps model labels as plain data strings (no HTML injection path)', () => {
    const option = buildChartOption({
      type: 'bar',
      title: '<script>alert(1)</script>',
      unit: '',
      data: [{ label: '<img onerror=x>', value: 1 }],
    }, false);
    expect((option.xAxis as { data?: string[] }).data).toEqual(['<img onerror=x>']);
    // echarts renders labels as SVG text nodes (never parsed HTML), so the raw
    // string is safe by construction.
    expect(option.title).toMatchObject({ text: '<script>alert(1)</script>' });
  });

  it('keeps every long label instead of truncating', () => {
    const label = '2026年第一季度华东区域销售额';
    const option = buildChartOption({ type: 'bar', title: '', unit: '', data: [{ label, value: 12 }] }, false);
    expect((option.xAxis as { data?: string[] }).data).toEqual([label]);
  });

  it('shows line symbols only up to 12 points', () => {
    const many = buildChartOption(spec('line', Array.from({ length: 20 }, (_, i) => [`k${i}`, i])), false);
    expect((many.series as Array<{ showSymbol?: boolean }>)[0].showSymbol).toBe(false);
    const few = buildChartOption(spec('line', [['a', 1], ['b', 2]]), false);
    expect((few.series as Array<{ showSymbol?: boolean }>)[0].showSymbol).toBe(true);
  });
});

describe('buildChartOption multi-series', () => {
  const multiSpec = {
    type: 'line' as const,
    title: '双城气温',
    unit: '℃',
    data: [{ label: '周一', value: 25 }],
    series: [
      { name: '北京', data: [{ label: '周一', value: 25 }, { label: '周二', value: 26 }] },
      { name: '上海', data: [{ label: '周一', value: 27 }, { label: '周二', value: 28 }] },
    ],
  };

  it('emits one line series per named column', () => {
    const option = buildChartOption(multiSpec, false);
    const series = option.series as Array<{ name?: string; type?: string; data?: number[] }>;
    expect(series).toHaveLength(2);
    expect(series[0].name).toBe('北京');
    expect(series[0].type).toBe('line');
    expect(series[0].data).toEqual([25, 26]);
    expect(series[1].data).toEqual([27, 28]);
  });

  it('shows a legend and an axis-linked tooltip with the unit on every series line', () => {
    const option = buildChartOption(multiSpec, false) as unknown as {
      legend: { top: number | string };
      tooltip: { trigger: string; formatter: (params: Array<{ seriesName: string; name: string; value: number }>) => string };
    };
    expect(option.legend).toBeTruthy();
    expect(option.tooltip.trigger).toBe('axis');
    const out = option.tooltip.formatter([
      { seriesName: '北京', name: '周一', value: 25 },
      { seriesName: '上海', name: '周一', value: 27 },
    ]);
    expect(out).toContain('周一');
    expect(out).toContain('北京: 25℃');
    expect(out).toContain('上海: 27℃');
  });

  it('renders grouped bars for multi-series bar charts', () => {
    const option = buildChartOption({ ...multiSpec, type: 'bar' }, false);
    const series = option.series as Array<{ type?: string; name?: string }>;
    expect(series).toHaveLength(2);
    expect(series[0].type).toBe('bar');
    expect(series[1].name).toBe('上海');
  });
});
