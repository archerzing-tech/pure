// src/ui/__tests__/markdown.test.ts
// Covers pure-logic helpers from the markdown renderer that don't need a DOM:
//  • suggestFilename — default name for the code-block save dialog
//  • highlightExt   — the `==text==` → <mark> inline highlight extension
//    (marked parses headlessly; no document/window required)

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { suggestFilename, highlightExt, renderer, parseChartSource, parseChartSourceWithMeta, groupAdjacentSvgSlots, splitTopLevelSvgSources, diagramSlot, diffLines, streamRenderThrottleMs, type DiagramKind } from '../markdown';
import { buildChartOption } from '../echartsChart';

// ── ==text== highlight extension ──

describe('streaming render scheduling', () => {
  it('backs off only the preview cadence as text and render cost grow', () => {
    expect(streamRenderThrottleMs(1000)).toBe(100);
    expect(streamRenderThrottleMs(24_000)).toBe(160);
    expect(streamRenderThrottleMs(80_000)).toBe(220);
    expect(streamRenderThrottleMs(1000, 18)).toBe(160);
  });
});

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

describe('renderer.image (inline markdown images → double-clickable wrapper)', () => {
  const md = new Marked({ gfm: true, breaks: true, renderer });

  it('wraps an https image in .md-img-wrap with the .md-img class', () => {
    const html = md.parse('![alt text](https://example.com/pic.svg)') as string;
    expect(html).toContain('<span class="md-img-wrap" data-viewer="img">');
    expect(html).toContain('<img class="md-img" src="https://example.com/pic.svg" alt="alt text"');
  });

  it('keeps data: (SVG/PNG) images wrappable', () => {
    const html = md.parse('![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)') as string;
    expect(html).toContain('class="md-img-wrap"');
    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="');
  });

  it('keeps scheme-less relative / protocol-relative images (no regression)', () => {
    const rel = md.parse('![local](/img/arch.svg)') as string;
    expect(rel).toContain('class="md-img-wrap"');
    expect(rel).toContain('src="/img/arch.svg"');
    const protoRel = md.parse('![cdn](//cdn.example/pic.png)') as string;
    expect(protoRel).toContain('class="md-img-wrap"');
    expect(protoRel).toContain('src="//cdn.example/pic.png"');
  });

  it('renders the alt text for disallowed schemes (never an executable src)', () => {
    const html = md.parse('![bad](javascript:alert(1))') as string;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('bad');
  });

  it('escapes src and alt attributes (no attribute breakout from model output)', () => {
    // Ampersands and angle brackets in a real image URL must be attribute-escaped.
    const html = md.parse('![a<b>](https://x.test/pic?a=1&b=2)') as string;
    expect(html).toContain('class="md-img-wrap"');
    expect(html).toContain('alt="a&lt;b&gt;"');
    expect(html).not.toContain('alt="a<b>"');
    expect(html).toContain('&amp;b=2');
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

describe('splitTopLevelSvgSources', () => {
  it('splits two root SVGs emitted inside one fenced block', () => {
    const sources = splitTopLevelSvgSources(`
      <svg viewBox="0 0 100 100"><rect width="100" height="100" /></svg>
      <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>
    `);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain('<rect');
    expect(sources[1]).toContain('<circle');
  });

  it('does not split nested SVG elements inside one root', () => {
    const sources = splitTopLevelSvgSources(
      '<svg><svg x="10" y="10" width="20" height="20"><path d="M0 0" /></svg></svg>',
    );
    expect(sources).toHaveLength(1);
  });

  it('handles uppercase roots, self-closing roots, and quoted greater-than signs', () => {
    const sources = splitTopLevelSvgSources(
      `<SVG data-label=">" />\n<svg><text>literal &lt;svg&gt;</text></svg>`,
    );
    expect(sources).toHaveLength(2);
  });

  it('does not split when prose separates the roots, but allows comments', () => {
    expect(splitTopLevelSvgSources('<svg />\n说明\n<svg />')).toHaveLength(1);
    expect(splitTopLevelSvgSources('<svg />\n<!-- option 2 -->\n<svg />')).toHaveLength(2);
  });

  it('keeps incomplete source intact for the SVG repair path', () => {
    const source = '<svg><rect /></svg>\n<svg><circle />';
    expect(splitTopLevelSvgSources(source)).toEqual([source]);
  });

  it('makes two independent slots when marked receives one svg fence', () => {
    const md = new Marked({ gfm: true, breaks: true, renderer });
    const html = md.parse('```svg\n<svg><rect /></svg>\n<svg><circle /></svg>\n```') as string;
    expect((html.match(/class="diagram-slot svg-slot"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('&lt;rect');
    expect(html).toContain('&lt;circle');
    expect(html).toContain('<div class="svg-gallery">');
    expect(html.indexOf('<div class="svg-gallery">')).toBeLessThan(html.indexOf('class="diagram-slot svg-slot"'));
  });
});

describe('multi-SVG placeholder layout', () => {
  it('keeps loading slots in the two-column gallery before rendering completes', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.bubble .svg-gallery .svg-slot[data-state="loading"]');
    expect(css).toContain('width: 100%;');
    expect(css).toContain('min-width: 0;');
    expect(css).toContain('min-height: 0;');
    expect(css).toContain('aspect-ratio: 1;');
  });

  it('groups independent SVG slots during streaming before the final render pass', () => {
    const src = readFileSync(new URL('../markdown.ts', import.meta.url), 'utf8');
    expect(src).toContain('return svgSourcesHtml(splitTopLevelSvgSources(token.text));');
    expect(src).toContain('groupAdjacentSvgSlots(container);');
  });
});

describe('diagramSlot', () => {
  it('starts with a ring loading placeholder and keeps the raw source for recovery', () => {
    const html = diagramSlot('svg', '<svg><text>secret</text></svg>', '');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-view="preview"');
    expect(html).toContain('diagram-loading-visual');
    expect(html).toContain('diagram-loading-ring');
    expect(html).toContain('diagram-loading-orbit');
    expect(html).toContain('diagram-loading-label');
    expect(html).toContain('secret');
  });

  it('renders a single icon-only download button and no view/source toggle', () => {
    const html = diagramSlot('svg', '<svg />', '<svg class="rendered" />');
    // The download action is icon-only: a download-arrow SVG inside the button,
    // with the label carried by title/aria-label (no visible text).
    expect(html).toContain('class="diagram-download-btn" title="下载图片" aria-label="下载图片"');
    expect(html).toContain('polyline points="7 10 12 15 17 10"');
    expect(html).not.toContain('>下载图片</button>');
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

  it('gives every image kind the same single icon-only download button with no source toggle', () => {
    const samples: Array<[DiagramKind, string]> = [
      ['svg', '<svg />'],
      ['chart', 'type: bar\nA 1\nB 2'],
      ['mermaid', 'graph TD; A-->B'],
      ['puml', '@startuml\nA-->B\n@enduml'],
    ];
    for (const [kind, source] of samples) {
      const html = diagramSlot(kind, source, '');
      expect(html).toContain('class="diagram-download-btn"');
      expect(html).toContain('polyline points="7 10 12 15 17 10"');
      expect(html).not.toContain('>下载图片</button>');
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

  it('repairs slightly-broken JSON payloads (unquoted keys + single quotes + trailing commas)', () => {
    const spec = parseChartSource(`{ type: 'pie', data: [['A', 30], ['B', 70],], }`);
    expect(spec.type).toBe('pie');
    expect(spec.data).toEqual([
      { label: 'A', value: 30 },
      { label: 'B', value: 70 },
    ]);
  });

  it('repairs a code-fenced JSON payload', () => {
    const spec = parseChartSource('```json\n{ type: \'line\', data: [{ label: \'A\', value: 1 }] }\n```');
    expect(spec.type).toBe('line');
    expect(spec.data).toEqual([{ label: 'A', value: 1 }]);
  });

  it('reports the repair flag through parseChartSourceWithMeta', () => {
    expect(parseChartSourceWithMeta('{ "type": "pie", "data": [["A", 1]], }')).toMatchObject({ repaired: true });
    expect(parseChartSourceWithMeta('line\nA 1\nB 2')).toMatchObject({ repaired: false });
  });

  it('exposes the repaired JSON source for the diff view', () => {
    // Trailing comma + unquoted key → repaired payload must be valid JSON.
    const { spec, repaired, repairedSource } = parseChartSourceWithMeta('{ type: \'pie\', data: [[\'A\', 1]], }');
    expect(repaired).toBe(true);
    expect(spec.type).toBe('pie');
    expect(repairedSource).toBeTruthy();
    expect(() => JSON.parse(repairedSource!)).not.toThrow();
    // A non-repaired parse carries no repaired source.
    expect(parseChartSourceWithMeta('line\nA 1').repairedSource).toBeUndefined();
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

// ── Scatter / kline / radar / hierarchy chart families ──

describe('parseChartSource new families', () => {
  it('parses scatter `name x y` rows into points', () => {
    const spec = parseChartSource(`type: scatter
title: 身高体重
小明 170 65
小红 160 50`);
    expect(spec.type).toBe('scatter');
    expect(spec.scatter).toEqual([
      {
        name: '数据',
        points: [
          { name: '小明', value: [170, 65] },
          { name: '小红', value: [160, 50] },
        ],
      },
    ]);
  });

  it('maps 散点图 / k线 / 雷达图 / 矩形树图 / 旭日图 shorthand to the right type', () => {
    expect(parseChartSource('散点图\nA 1 2\nB 3 4').type).toBe('scatter');
    expect(parseChartSource('k线图\nD 1 2 0 3\nE 2 3 1 4').type).toBe('kline');
    expect(parseChartSource('雷达图\n速度 攻击\nA 80 90').type).toBe('radar');
    expect(parseChartSource('矩形树图\nA 1\nB 2').type).toBe('treemap');
    expect(parseChartSource('旭日图\nA 1\nB 2').type).toBe('sunburst');
    expect(parseChartSource('树\n公司\n  技术部').type).toBe('tree');
  });

  it('parses kline rows as open/close/low/high candles', () => {
    const spec = parseChartSource(`kline
日期 开盘 收盘 最低 最高
2026-08-01 10 12 9 13
2026-08-02 12 11 10 12`);
    expect(spec.type).toBe('kline');
    expect(spec.ohlc).toEqual([
      { date: '2026-08-01', value: [10, 12, 9, 13] },
      { date: '2026-08-02', value: [12, 11, 10, 12] },
    ]);
  });

  it('parses radar indicators + per-row series values', () => {
    const spec = parseChartSource(`type: radar
indicators: 速度 攻击 防御
A 80 90 70
B 60 70 80`);
    expect(spec.type).toBe('radar');
    expect(spec.indicators).toEqual(['速度', '攻击', '防御']);
    expect(spec.radarData).toEqual([
      { name: 'A', value: [80, 90, 70] },
      { name: 'B', value: [60, 70, 80] },
    ]);
  });

  it('parses indentation-based tree DSL', () => {
    const spec = parseChartSource(`type: tree
公司
  技术部
    前端
    后端
  市场部`);
    expect(spec.tree).toEqual({
      name: '公司',
      children: [
        { name: '技术部', children: [{ name: '前端' }, { name: '后端' }] },
        { name: '市场部' },
      ],
    });
  });

  it('parses treemap DSL with values and sums missing parent values', () => {
    const spec = parseChartSource(`type: treemap
销售
  电子 500
    手机 300
    电脑 200
  家电 300`);
    expect(spec.tree).toEqual({
      name: '销售',
      children: [
        { name: '电子', value: 500, children: [{ name: '手机', value: 300 }, { name: '电脑', value: 200 }] },
        { name: '家电', value: 300 },
      ],
      value: 800,
    });
  });

  it('accepts JSON for all new families', () => {
    const scatter = parseChartSource(JSON.stringify({
      type: 'scatter', data: [['A', 1, 2], ['B', 3, 4]],
    }));
    expect(scatter.scatter?.[0].points).toContainEqual({ name: 'A', value: [1, 2] });

    const kline = parseChartSource(JSON.stringify({
      type: 'kline', data: [['D1', 10, 12, 9, 13]],
    }));
    expect(kline.ohlc).toEqual([{ date: 'D1', value: [10, 12, 9, 13] }]);

    const radar = parseChartSource(JSON.stringify({
      type: 'radar', indicators: ['速度'], data: [['A', 80]],
    }));
    expect(radar.indicators).toEqual(['速度']);
    expect(radar.radarData).toEqual([{ name: 'A', value: [80] }]);

    const tree = parseChartSource(JSON.stringify({
      type: 'tree', data: { name: '根', children: [{ name: '子' }] },
    }));
    expect(tree.tree).toEqual({ name: '根', children: [{ name: '子' }] });

    const sunburst = parseChartSource(JSON.stringify({
      type: 'sunburst', data: [['A', 1], ['B', 2]],
    }));
    expect(sunburst.tree?.children).toHaveLength(2);
    expect(sunburst.tree?.value).toBe(3);
  });
});

describe('buildChartOption new families', () => {
  it('scatter maps points to value axes and a scatter series', () => {
    const option = buildChartOption(parseChartSource('scatter\nA 1 2\nB 3 4'), false);
    const series = option.series as Array<{ type?: string; data?: Array<{ value: number[]; name: string }> }>;
    expect(series[0].type).toBe('scatter');
    expect(series[0].data).toEqual([{ value: [1, 2], name: 'A' }, { value: [3, 4], name: 'B' }]);
    expect((option.xAxis as { type?: string }).type).toBe('value');
    expect((option.yAxis as { type?: string }).type).toBe('value');
  });

  it('kline renders a candlestick series with scale on the value axis', () => {
    const option = buildChartOption(parseChartSource('kline\nD1 10 12 9 13\nD2 12 11 10 12'), false);
    const series = option.series as Array<{ type?: string; data?: number[][] }>;
    expect(series[0].type).toBe('candlestick');
    expect(series[0].data).toEqual([[10, 12, 9, 13], [12, 11, 10, 12]]);
    expect((option.yAxis as { scale?: boolean }).scale).toBe(true);
  });

  it('radar renders a radar series with indicators and a legend', () => {
    const option = buildChartOption(parseChartSource('radar\nindicators: 速度 攻击\nA 80 90\nB 60 70'), false);
    const series = option.series as Array<{ type?: string; data?: Array<{ name: string; value: number[] }> }>;
    expect(series[0].type).toBe('radar');
    expect(series[0].data?.map((r) => ({ name: r.name, value: r.value }))).toEqual([
      { name: 'A', value: [80, 90] },
      { name: 'B', value: [60, 70] },
    ]);
    expect((option.radar as { indicator?: Array<{ name: string; max: number }> }).indicator?.map((i) => i.name)).toEqual(['速度', '攻击']);
    // Each axis max scales above its largest data value so shapes never clip.
    const indicatorMax = (option.radar as { indicator?: Array<{ name: string; max: number }> }).indicator ?? [];
    expect(indicatorMax[0].max).toBeGreaterThan(80);
    expect(indicatorMax[1].max).toBeGreaterThan(90);
  });

  it('tree renders a tree series carrying the root node', () => {
    const option = buildChartOption(parseChartSource('tree\n公司\n  技术部'), false);
    const series = option.series as Array<{ type?: string; data?: Array<Record<string, unknown>> }>;
    expect(series[0].type).toBe('tree');
    expect(series[0].data).toEqual([{ name: '公司', children: [{ name: '技术部' }] }]);
  });

  it('treemap and sunburst render with their series types', () => {
    const tm = buildChartOption(parseChartSource('treemap\n销售\n  电子 500'), false);
    expect((tm.series as Array<{ type?: string }>)[0].type).toBe('treemap');
    const sb = buildChartOption(parseChartSource('sunburst\n销售\n  电子 500'), false);
    expect((sb.series as Array<{ type?: string }>)[0].type).toBe('sunburst');
  });
});

// ── diffLines (repair-diff viewer core — pure, no DOM) ──

describe('diffLines (original vs repaired source)', () => {
  it('returns per-line same rows for identical sources', () => {
    expect(diffLines('A\nB\nC', 'A\nB\nC')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
      { kind: 'same', left: 'B', right: 'B' },
      { kind: 'same', left: 'C', right: 'C' },
    ]);
  });

  it('marks a pure trailing addition', () => {
    expect(diffLines('A', 'A\nB')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
      { kind: 'changed', left: undefined, right: 'B' },
    ]);
  });

  it('marks a pure removal', () => {
    expect(diffLines('A\nB', 'A')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
      { kind: 'changed', left: 'B', right: undefined },
    ]);
  });

  it('pairs adjacent removed/added runs into aligned changed rows', () => {
    // `A X Y B` vs `A X2 B`: the X→X2 replacement and the Y removal read as
    // one aligned block (red-left/green-right) instead of misaligned rows.
    expect(diffLines('A\nX\nY\nB', 'A\nX2\nB')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
      { kind: 'changed', left: 'X', right: 'X2' },
      { kind: 'changed', left: 'Y', right: undefined },
      { kind: 'same', left: 'B', right: 'B' },
    ]);
  });

  it('handles empty and one-sided inputs without phantom empty lines', () => {
    expect(diffLines('', '')).toEqual([]);
    expect(diffLines('A', '')).toEqual([{ kind: 'changed', left: 'A', right: undefined }]);
    expect(diffLines('', 'A')).toEqual([{ kind: 'changed', left: undefined, right: 'A' }]);
    // A trailing-newline difference alone must not render an empty diff row.
    expect(diffLines('A\n', 'A')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
    ]);
  });

  it('keeps a real blank final line (source that ends with a newline)', () => {
    expect(diffLines('A\n\n', 'A\n')).toEqual([
      { kind: 'same', left: 'A', right: 'A' },
      { kind: 'changed', left: '', right: undefined },
    ]);
  });

  it('aligns a real-world mermaid repair: unclosed label closer', () => {
    const original = 'graph TD\n  A[\"Server\"] --> B[\"DB\"]\n  B --query--> C[(db)'; // cut: label closer missing
    const repaired = 'graph TD\n  A[\"Server\"] --> B[\"DB\"]\n  B --query--> C[(db)]';
    const rows = diffLines(original, repaired);
    expect(rows[0]).toEqual({ kind: 'same', left: 'graph TD', right: 'graph TD' });
    const changed = rows.filter((r) => r.kind === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].left).toBe('  B --query--> C[(db)');
    expect(changed[0].right).toBe('  B --query--> C[(db)]');
  });
});
