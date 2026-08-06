// src/ui/__tests__/markdown.test.ts
// Covers pure-logic helpers from the markdown renderer that don't need a DOM:
//  • suggestFilename — default name for the code-block save dialog
//  • highlightExt   — the `==text==` → <mark> inline highlight extension
//    (marked parses headlessly; no document/window required)

import { describe, it, expect } from 'bun:test';
import { Marked } from 'marked';
import { suggestFilename, highlightExt, parseChartSource, buildChartSvg, groupAdjacentSvgSlots } from '../markdown';

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

  it('builds an SVG from a complete weather chart response', () => {
    const spec = parseChartSource(`type：line\ntitle：未来一周天气\nunit：℃\n周一：25℃\n周二：26℃\n周三：24℃`);
    const svg = buildChartSvg(spec);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('周一');
    expect(svg).toContain('26');
  });
});

describe('buildChartSvg', () => {
  it('renders bars as rects with value labels for bar charts', () => {
    const svg = buildChartSvg({ type: 'bar', title: 'T', unit: '个', data: [{ label: 'A', value: 3 }, { label: 'B', value: 7 }] });
    expect(svg).toContain('<svg');
    expect(svg).toContain('chart-title');
    expect(svg).toContain('T');
    expect(svg).toContain('<path'); // rounded bars
    expect(svg).toContain('>7</text>'); // value label
  });

  it('renders a polyline for line charts', () => {
    const svg = buildChartSvg({ type: 'line', title: '', unit: '', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] });
    expect(svg).toContain('<polyline');
    expect(svg).toContain('<circle');
  });

  it('renders donut slices + a legend for pie charts', () => {
    const svg = buildChartSvg({ type: 'pie', title: 'P', unit: '%', data: [{ label: 'X', value: 25 }, { label: 'Y', value: 75 }] });
    expect(svg).toContain('<path'); // arcs
    expect(svg).toContain('chart-legend');
    expect(svg).toContain('75%');
    expect(svg).toContain('25');
  });

  it('escapes model-provided labels so charts can never inject markup', () => {
    const svg = buildChartSvg({ type: 'bar', title: '<script>alert(1)</script>', unit: '', data: [{ label: '<img onerror=x>', value: 1 }] });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('throws for a pie with no positive values', () => {
    expect(() => buildChartSvg({ type: 'pie', title: '', unit: '', data: [{ label: 'a', value: 0 }] }))
      .toThrow('positive');
  });

  it('keeps negative bars inside the viewBox on a two-sided axis', () => {
    const svg = buildChartSvg({ type: 'bar', title: '', unit: '', data: [
      { label: 'A', value: -30 }, { label: 'B', value: 20 },
    ] });
    // Every path/text coordinate must stay within the 0..360 viewBox — the
    // old single-sided scale drew -30 as a bar extending past the bottom.
    const ys = [...svg.matchAll(/[MLQ]\s*-?[\d.]+\s+(-?[\d.]+)/g)].map(m => parseFloat(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(360);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(svg).toContain('chart-axis'); // zero baseline
    expect(svg).toContain('-30');       // negative value label
  });

  it('renders hbar negatives extending left from the zero line', () => {
    const svg = buildChartSvg({ type: 'hbar', title: '', unit: '', data: [
      { label: 'A', value: -4 }, { label: 'B', value: 6 },
    ] });
    // Old code emitted width="-…" (invalid); now every rect has a positive
    // width and stays inside the 640-wide viewBox.
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
      .map(m => ({ x: parseFloat(m[1]), w: parseFloat(m[2]) }));
    expect(rects.length).toBe(2);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.x + r.w).toBeLessThanOrEqual(640);
      expect(r.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('line charts keep negative points inside the plot area', () => {
    const svg = buildChartSvg({ type: 'line', title: '', unit: '', data: [
      { label: 'a', value: -5 }, { label: 'b', value: 10 },
    ] });
    const cy = [...svg.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map(m => parseFloat(m[1]));
    expect(cy.length).toBe(2);
    for (const y of cy) {
      expect(y).toBeGreaterThanOrEqual(48 - 1);
      expect(y).toBeLessThanOrEqual(296 + 1);
    }
  });

  it('keeps long labels instead of truncating them', () => {
    const label = '2026年第一季度华东区域销售额';
    const bar = buildChartSvg({ type: 'bar', title: '', unit: '', data: [{ label, value: 12 }] });
    const line = buildChartSvg({ type: 'line', title: '', unit: '', data: [{ label, value: 12 }] });
    const hbar = buildChartSvg({ type: 'hbar', title: '', unit: '', data: [{ label, value: 12 }] });
    expect(bar).toContain(label.slice(0, 12));
    expect(bar).toContain(label.slice(12));
    expect(line).toContain(label.slice(0, 12));
    expect(hbar).toContain(label.slice(0, 18));
    expect(hbar).toContain(label.slice(18));
    expect(bar).not.toContain('…');
    expect(line).not.toContain('…');
    expect(hbar).not.toContain('…');
  });

  it('expands the pie viewBox for every legend row', () => {
    const data = Array.from({ length: 14 }, (_, i) => ({ label: `分类-${i + 1}`, value: i + 1 }));
    const svg = buildChartSvg({ type: 'pie', title: '完整图例', unit: '', data });
    const viewBox = svg.match(/viewBox="0 0 640 (\d+)"/);
    expect(viewBox).not.toBeNull();
    expect(Number(viewBox?.[1])).toBeGreaterThan(360);
    expect(svg).toContain('分类-14');
  });
});
