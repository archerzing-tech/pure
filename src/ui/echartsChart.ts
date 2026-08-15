// src/ui/echartsChart.ts
// ECharts-backed renderer for ```chart blocks. This module is the ONLY place
// echarts is imported, and it is loaded lazily (dynamic import from markdown.ts)
// so the ~400KB tree-shaken echarts chunk never touches startup. We register
// just the chart types / components / renderer we use (SVG renderer keeps the
// existing PNG-export + viewer pipeline working — the chart's DOM is an <svg>).
//
// buildChartOption() is pure (no DOM, no echarts instance) so it is unit-testable
// in bun; renderEchartInto() owns the instance lifecycle (dispose on re-render,
// ResizeObserver so sidebar toggles / window resizes re-fit the chart).

import * as echarts from 'echarts/core';
import {
  BarChart,
  CandlestickChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
} from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { ChartSpec } from './markdown';

echarts.use([
  BarChart,
  CandlestickChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  SunburstChart,
  TreeChart,
  TreemapChart,
  GridComponent,
  AxisPointerComponent,
  DataZoomComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

// ── Theme tokens (colors are baked at render time, like mermaid) ──

interface ChartTheme {
  text: string;
  subtext: string;
  grid: string;
  axisLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  palette: string[];
}

const LIGHT_THEME: ChartTheme = {
  text: '#374151',
  subtext: '#6b7280',
  grid: '#e5e7eb',
  axisLine: '#d1d5db',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e5e7eb',
  palette: ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'],
};

const DARK_THEME: ChartTheme = {
  text: '#e5e7eb',
  subtext: '#9ca3af',
  grid: '#334155',
  axisLine: '#475569',
  tooltipBg: '#1e293b',
  tooltipBorder: '#334155',
  palette: ['#818cf8', '#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#2dd4bf'],
};

function chartTheme(dark: boolean): ChartTheme {
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** Compact number for axis ticks: 1200 → 1.2k, 2_400_000 → 2.4M. */
function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Build the echarts option for a parsed ```chart spec. Pure — no DOM access,
 * no echarts instance — so the result is unit-testable headlessly. Text colors
 * come from the theme snapshot (passed in), matching mermaid's render-time
 * theming. Returns a minimal option object; renderEchartInto adds the UI font.
 */
export function buildChartOption(spec: ChartSpec, dark: boolean): EChartsOption {
  const theme = chartTheme(dark);
  const { title, unit, data } = spec;
  const labels = data.map((d) => d.label);
  const values = data.map((d) => d.value);
  const showValueLabels = data.length <= 12;

  const tooltipBase = {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: theme.text, fontSize: 12 },
    confine: true,
  };

  const base: EChartsOption = {
    animation: true,
    animationDuration: 350,
    animationEasing: 'cubicOut',
    textStyle: { color: theme.text },
    title: title
      ? { text: title, left: 4, top: 8, textStyle: { fontSize: 14, fontWeight: 600, color: theme.text } }
      : undefined,
  };

  if (spec.type === 'scatter') {
    const scatterSeries = spec.scatter ?? [{
      name: '数据',
      points: data.map((d, i) => ({ name: d.label, value: [i, d.value] as [number, number] })),
    }];
    const valueAxis = {
      type: 'value' as const,
      axisLabel: { color: theme.subtext, fontSize: 11, formatter: (v: number) => fmtNum(v) },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
    };
    return {
      ...base,
      legend: scatterSeries.length > 1
        ? { top: title ? 44 : 8, left: 'center', itemWidth: 14, itemHeight: 10, textStyle: { color: theme.subtext, fontSize: 11 } }
        : undefined,
      grid: {
        left: 8, right: 20, top: title ? (scatterSeries.length > 1 ? 84 : 48) : 20, bottom: 4,
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      tooltip: {
        ...tooltipBase,
        trigger: 'item',
        formatter: (params: { seriesName?: string; name: string; value: number[] }): string => {
          const series = params.seriesName && scatterSeries.length > 1 ? ` (${params.seriesName})` : '';
          return `${params.name}${series}: (${fmtNum(params.value[0])}, ${fmtNum(params.value[1])})${unit}`;
        },
      },
      xAxis: valueAxis,
      yAxis: valueAxis,
      series: scatterSeries.map((s, i) => ({
        name: s.name,
        type: 'scatter',
        symbolSize: 10,
        data: s.points.map((p) => ({ value: p.value, name: p.name })),
        itemStyle: { color: theme.palette[i % theme.palette.length] },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.25)' } },
      })),
    } as EChartsOption;
  }

  if (spec.type === 'kline') {
    const ohlc = spec.ohlc ?? [];
    const withZoom = ohlc.length > 20;
    return {
      ...base,
      grid: {
        left: 8, right: 20, top: title ? 48 : 20, bottom: withZoom ? 44 : 4,
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      tooltip: {
        ...tooltipBase,
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: theme.axisLine } },
        formatter: (params: Array<{ name: string; value: number | number[] }>): string => {
          const p = params[0];
          if (!p) return '';
          const [open, close, low, high] = Array.isArray(p.value) ? p.value : [];
          const color = close >= open ? '#ef4444' : '#10b981';
          const lines = [
            p.name,
            `开盘: <span style="color:${color}">${fmtNum(open)}</span>`,
            `收盘: <span style="color:${color}">${fmtNum(close)}</span>`,
            `最低: ${fmtNum(low)}`,
            `最高: ${fmtNum(high)}`,
          ];
          return lines.join('\n');
        },
      },
      xAxis: {
        type: 'category',
        data: ohlc.map((r) => r.date),
        axisLabel: { color: theme.subtext, fontSize: 11, interval: 'auto' },
        axisLine: { lineStyle: { color: theme.axisLine } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { color: theme.subtext, fontSize: 11, formatter: (v: number) => fmtNum(v) },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
      },
      dataZoom: withZoom
        ? [{ type: 'inside' as const, start: 0, end: 100 }, { type: 'slider' as const, height: 20, bottom: 0, borderColor: theme.axisLine }]
        : undefined,
      series: [{
        type: 'candlestick',
        data: ohlc.map((r) => r.value),
        itemStyle: {
          color: '#ef4444', color0: '#10b981',
          borderColor: '#ef4444', borderColor0: '#10b981',
        },
      }],
    } as EChartsOption;
  }

  if (spec.type === 'radar') {
    const values = spec.radarData ?? [];
    const names = spec.indicators ?? [];
    const maxes = names.map((_, i) => Math.max(1, ...values.map((r) => r.value[i] ?? 0)));
    return {
      ...base,
      legend: values.length > 1
        ? { top: title ? 44 : 8, left: 'center', itemWidth: 14, itemHeight: 10, textStyle: { color: theme.subtext, fontSize: 11 } }
        : undefined,
      tooltip: { ...tooltipBase, trigger: 'item' },
      radar: {
        indicator: names.map((name, i) => ({ name, max: maxes[i] * 1.15 })),
        radius: '62%',
        splitNumber: 4,
        axisName: { color: theme.text, fontSize: 11 },
        splitArea: { areaStyle: { color: [withAlpha(theme.palette[0], 0.06), 'transparent'] } },
        splitLine: { lineStyle: { color: theme.grid } },
        axisLine: { lineStyle: { color: theme.grid } },
      },
      series: [{
        type: 'radar',
        data: values.map((r, i) => ({
          name: r.name,
          value: r.value,
          itemStyle: { color: theme.palette[i % theme.palette.length] },
          lineStyle: { color: theme.palette[i % theme.palette.length], width: 2 },
          areaStyle: { opacity: 0.12 },
        })),
      }],
    } as EChartsOption;
  }

  if (spec.type === 'tree') {
    return {
      ...base,
      tooltip: { ...tooltipBase, trigger: 'item', triggerOn: 'mousemove' },
      series: [{
        type: 'tree',
        data: spec.tree ? [spec.tree] : [],
        top: title ? 44 : 8,
        left: '8%',
        right: '10%',
        bottom: 8,
        symbol: 'circle',
        symbolSize: 7,
        expandAndCollapse: true,
        initialTreeDepth: 3,
        label: { color: theme.text, fontSize: 11, position: 'left', verticalAlign: 'middle' },
        leaves: { label: { position: 'right' } },
        itemStyle: { color: theme.palette[0], borderWidth: 1 },
        lineStyle: { color: theme.axisLine, width: 1.2 },
        emphasis: { focus: 'descendant' },
      }],
    } as EChartsOption;
  }

  if (spec.type === 'treemap' || spec.type === 'sunburst') {
    const tooltipFormatter = (params: { name: string; value: number; treePathInfo?: Array<{ name: string }> }): string => {
      const path = (params.treePathInfo ?? []).map((p) => p.name).filter(Boolean).join(' / ');
      return `${path}\n${fmtNum(params.value)}${unit}`;
    };
    if (spec.type === 'treemap') {
      return {
        ...base,
        color: theme.palette,
        tooltip: { ...tooltipBase, formatter: tooltipFormatter },
        series: [{
          type: 'treemap',
          data: spec.tree ? [spec.tree] : [],
          left: 8, right: 8, top: title ? 44 : 8, bottom: 8,
          breadcrumb: {
            show: true,
            itemStyle: { color: theme.tooltipBg, borderColor: theme.axisLine, textStyle: { color: theme.text, fontSize: 11 } },
          },
          label: { color: theme.text, fontSize: 11 },
          itemStyle: { borderColor: theme.tooltipBg, borderWidth: 1, gapWidth: 1 },
          emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.2)' } },
        }],
      } as EChartsOption;
    }
    return {
      ...base,
      color: theme.palette,
      tooltip: { ...tooltipBase, formatter: tooltipFormatter },
      series: [{
        type: 'sunburst',
        data: spec.tree ? [spec.tree] : [],
        radius: ['12%', '78%'],
        center: ['50%', '55%'],
        sort: 'desc',
        label: { color: theme.text, fontSize: 11 },
        itemStyle: { borderColor: theme.tooltipBg, borderWidth: 1 },
        emphasis: { focus: 'ancestor' },
      }],
    } as EChartsOption;
  }

  if (spec.type === 'pie') {
    const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
    if (total <= 0) throw new Error('pie chart needs positive values');
    const pct = (v: number): string => `${fmtNum(v)} · ${((Math.max(0, v) / total) * 100).toFixed(1)}%`;
    return {
      ...base,
      legend: {
        orient: 'vertical',
        right: 8,
        top: 'middle',
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 12,
        textStyle: { color: theme.subtext, fontSize: 11 },
        formatter: (name: string): string => {
          const row = data.find((d) => d.label === name);
          return row ? `${name}  ${pct(row.value)}` : name;
        },
      },
      tooltip: {
        ...tooltipBase,
        trigger: 'item',
        formatter: (params: { name: string; value: number; percent?: number }): string =>
          `${params.name}: ${fmtNum(params.value)}${unit} (${params.percent?.toFixed(1) ?? ''}%)`,
      },
      series: [{
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['36%', '50%'],
        data: data.map((d, i) => ({
          name: d.label,
          value: d.value,
          itemStyle: { color: theme.palette[i % theme.palette.length] },
        })),
        label: { color: theme.text, fontSize: 11, formatter: '{b} {d}%' },
        labelLine: { lineStyle: { color: theme.axisLine } },
        emphasis: { itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.25)' } },
      }],
    } as EChartsOption;
  }

  // Multi-series (header + ≥2 numeric columns): one line/bar per column, a
  // top legend, and an axis-linked tooltip that compares every series at the
  // hovered category (`名称: 值单位` per line). No area fill / value labels —
  // they would clutter overlapping lines. (Pie already returned above.)
  if (spec.series && spec.series.length >= 2) {
    const isHbar = spec.type === 'hbar';
    const isLine = spec.type === 'line';
    const multiLabels = spec.series[0].data.map((d) => d.label);
    const showSymbols = multiLabels.length <= 12;
    const valueAxis = {
      type: 'value' as const,
      axisLabel: { color: theme.subtext, fontSize: 11, formatter: (v: number) => fmtNum(v) },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
    };
    const categoryAxis = (inverse: boolean) => ({
      type: 'category' as const,
      inverse,
      data: multiLabels,
      axisLabel: { color: theme.subtext, fontSize: 11, interval: 'auto' as const },
      axisLine: { show: !inverse, lineStyle: { color: theme.axisLine } },
      axisTick: { show: false },
    });
    return {
      ...base,
      legend: {
        top: title ? 44 : 8,
        left: 'center',
        itemWidth: 14,
        itemHeight: 10,
        icon: isLine ? 'roundRect' : 'rect',
        textStyle: { color: theme.subtext, fontSize: 11 },
      },
      grid: {
        left: 8,
        right: isHbar ? 56 : 20,
        top: title ? 84 : 40,
        bottom: 4,
        outerBoundsMode: 'same',
        outerBoundsContain: 'axisLabel',
      },
      tooltip: {
        ...tooltipBase,
        trigger: 'axis',
        axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: theme.axisLine } },
        formatter: (params: Array<{ seriesName: string; name: string; value: number | number[] }>): string => {
          const head = params[0]?.name ?? '';
          const body = params
            .map((p) => `${p.seriesName}: ${fmtNum(Array.isArray(p.value) ? p.value[0] : p.value)}${unit}`)
            .join('\n');
          return head ? `${head}\n${body}` : body;
        },
      },
      xAxis: isHbar ? valueAxis : categoryAxis(false),
      yAxis: isHbar ? categoryAxis(true) : valueAxis,
      series: spec.series.map((s, i) => {
        const seriesColor = theme.palette[i % theme.palette.length];
        return {
          name: s.name,
          type: isLine ? 'line' : 'bar',
          data: s.data.map((d) => d.value),
          ...(isLine
            ? {
                showSymbol: showSymbols,
                symbolSize: 5,
                smooth: true,
                lineStyle: { width: 2.5, color: seriesColor, cap: 'round' as const, join: 'round' as const },
                itemStyle: { color: seriesColor },
              }
            : {
                barMaxWidth: 30,
                itemStyle: { color: seriesColor, borderRadius: isHbar ? [0, 4, 4, 0] : [4, 4, 0, 0] },
              }),
          label: { show: false },
        };
      }),
    } as EChartsOption;
  }

  const isHbar = spec.type === 'hbar';
  const isLine = spec.type === 'line';
  const color = theme.palette[0];

  return {
    ...base,
    grid: {
      left: 8,
      right: isHbar ? 56 : 20,
      top: title ? 48 : 20,
      bottom: 4,
      // echarts 6 native replacement for the deprecated `containLabel`:
      // keep axis labels inside the grid rect (shrink the plot to fit).
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
    tooltip: {
      ...tooltipBase,
      trigger: 'axis',
      axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: theme.axisLine } },
      formatter: (params: Array<{ name: string; value: number }>): string => {
        const first = params[0];
        return first ? `${first.name}: ${fmtNum(first.value)}${unit}` : '';
      },
    },
    xAxis: isHbar ? {
      type: 'value',
      axisLabel: { color: theme.subtext, fontSize: 11, formatter: (v: number) => fmtNum(v) },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
    } : {
      type: 'category',
      data: labels,
      axisLabel: { color: theme.subtext, fontSize: 11, interval: 'auto' },
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisTick: { show: false },
    },
    yAxis: isHbar ? {
      type: 'category',
      inverse: true,
      data: labels,
      axisLabel: { color: theme.subtext, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    } : {
      type: 'value',
      axisLabel: { color: theme.subtext, fontSize: 11, formatter: (v: number) => fmtNum(v) },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
    },
    series: [{
      type: isLine ? 'line' : 'bar',
      data: isLine ? values : values.map((v, i) => ({
        value: v,
        itemStyle: { color: theme.palette[i % theme.palette.length] },
      })),
      ...(isLine
        ? {
            showSymbol: showValueLabels,
            symbolSize: 6,
            smooth: true,
            lineStyle: { width: 2.5, color, cap: 'round', join: 'round' },
            itemStyle: { color },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: withAlpha(color, 0.25) },
                  { offset: 1, color: withAlpha(color, 0.02) },
                ],
              },
            },
          }
        : {
            barMaxWidth: 44,
            itemStyle: isHbar
              ? { borderRadius: [0, 6, 6, 0] }
              : { borderRadius: [6, 6, 0, 0] },
          }),
      label: showValueLabels
        ? {
            show: true,
            position: isHbar ? 'right' : 'top',
            color: theme.subtext,
            fontSize: 11,
            formatter: (params: { value: number }) => fmtNum(params.value),
          }
        : { show: false },
    }],
  } as EChartsOption;
}

// ── Instance lifecycle ──

interface ChartEntry {
  chart: ReturnType<typeof echarts.init>;
  ro: ResizeObserver | null;
}

const instances = new WeakMap<HTMLElement, ChartEntry>();
const chartTargets = new Set<HTMLElement>();
let detachedChartObserver: MutationObserver | null = null;

function disposeEchartTarget(target: HTMLElement): void {
  const existing = instances.get(target);
  if (existing) {
    existing.ro?.disconnect();
    existing.chart.dispose();
    instances.delete(target);
  }
  chartTargets.delete(target);
  if (chartTargets.size === 0) {
    detachedChartObserver?.disconnect();
    detachedChartObserver = null;
  }
}

function ensureDetachedChartObserver(): void {
  if (detachedChartObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return;
  detachedChartObserver = new MutationObserver(() => {
    for (const target of [...chartTargets]) {
      if (!target.isConnected) disposeEchartTarget(target);
    }
  });
  detachedChartObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Render a parsed chart spec into `target` (the `.chart-target` div of a
 * chart slot). Disposes any previous instance on the same target (retry /
 * theme re-render) and keeps the chart fitted to its container via a
 * ResizeObserver — sidebar toggles and window resizes stay correct.
 */
export function renderEchartInto(target: HTMLElement, spec: ChartSpec): void {
  // An async chart render can finish after its transcript row was replaced.
  // Never create an ECharts instance for an already-detached target; there is
  // no future mutation in document.body that could reclaim it.
  if (!target.isConnected) return;
  const hadInstance = instances.has(target);
  disposeEchartTarget(target);
  if (hadInstance) target.innerHTML = '';
  // Defensive sizing: echarts renders an invisible 0-sized SVG when the
  // container measures 0 at init (e.g. inside a content-visibility-skipped
  // bubble during session restore, or before CSS loads). Force a synchronous
  // reflow so clientWidth/clientHeight reflect the real layout, and give the
  // target a floor height so the chart is never blank; the ResizeObserver
  // re-fits it once the container actually lays out.
  void target.offsetWidth;
  if (target.clientWidth < 100 || target.clientHeight < 60) {
    target.style.minHeight = '320px';
  }
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const option = buildChartOption(spec, dark);
  const font = typeof getComputedStyle === 'function'
    ? getComputedStyle(document.body).fontFamily || undefined
    : undefined;
  if (font) option.textStyle = { ...option.textStyle, fontFamily: font };
  const chart = echarts.init(target, undefined, { renderer: 'svg' });
  chart.setOption(option);
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => chart.resize())
    : null;
  ro?.observe(target);
  instances.set(target, { chart, ro });
  chartTargets.add(target);
  ensureDetachedChartObserver();
}
