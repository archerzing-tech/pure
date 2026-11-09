// src/shared/formProjections.ts
// 刀 4 投影降级器（docs/presentation-capability-library.md）：```chart /
// ```map / ```paint 围栏在 CLI 与外部渠道没有图形表面，这里把它们的载荷
// 投影成一段人可读的文本（条形图 / 标记清单 / 形状清单），替代此前的裸
// JSON / 源码直出。
// 纪律（承 cliDiagram 判例）：投影器解析不了就返回 null，调用方回退原始
// 源码——绝不产出一张错的照片。纯函数、无 DOM，headless 可测。
// mermaid / puml 不在这里：它们走 cliDiagram 的 ASCII 线框（历史通道）。
// 自定义卡 tag（刀 3）的投影是已知边界——主表面是 GUI，文本表面回退源码。

import { parseMapSource } from './mapSpec';

export type FormProjection = (source: string) => string | null;

/** 每个形式一个投影器：形式 id（含别名）→ 投影函数。与卡注册表 fence 字段
 *  同源（formProjections.test.ts 锁全集相等——leaflet 别名缺口就是这样被
 *  测试抓出来的：漏了它 CLI 收到 ```leaflet 围栏不会投影）。 */
export const FORM_PROJECTIONS: Record<string, FormProjection> = {
  chart: projectChart,
  charts: projectChart,
  map: projectMap,
  leaflet: projectMap,
  paint: projectPaint,
};

/** 查一个围栏 lang 的投影器（lang 先小写化取首词，与渲染层口径一致）。 */
export function projectionFor(lang: string): FormProjection | undefined {
  const key = (lang ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return FORM_PROJECTIONS[key];
}

/** 一次性投影：有投影器且解析成功返回投影文本，否则 null（回退源码）。 */
export function projectForm(lang: string, source: string): string | null {
  const project = projectionFor(lang);
  if (!project) return null;
  try {
    return project(source);
  } catch {
    return null;
  }
}

// ── chart：bar / hbar / pie → 水平条形图 ──
// chart 的 DSL 主体是文本行（`label value`，promptLayers.CHART_DSL_PROMPT 是
// 单源）；line/scatter/kline/radar/tree 系的趋势与层级文本行本身已可读，
// 投影不增值 → null 回退源码。JSON payload 形态试 {type, data:[{name,value}]}。

const BAR_WIDTH = 30;

interface ChartRow {
  label: string;
  value: number;
}

function projectChart(source: string): string | null {
  const trimmed = (source ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return projectChartJson(trimmed);
  return projectChartLines(trimmed);
}

function projectChartLines(text: string): string | null {
  let type = 'bar';
  let title = '';
  let unit = '';
  const rows: ChartRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const header = /^(type|title|unit):\s*(.*)$/i.exec(t);
    if (header) {
      const key = header[1].toLowerCase();
      if (key === 'type') type = header[2].trim().toLowerCase() || 'bar';
      else if (key === 'title') title = header[2].trim();
      else unit = header[2].trim();
      continue;
    }
    // `label value` 行：label 可含空格，value 是行尾最后一个数字。
    const row = /^(.+?)[ \t]+(-?\d+(?:\.\d+)?)\s*$/.exec(t);
    if (row) rows.push({ label: row[1].trim(), value: Number(row[2]) });
  }
  if (rows.length === 0) return null;
  if (!['bar', 'hbar', 'pie'].includes(type)) return null; // line/tree 系不投影
  return renderBars(rows, title, unit);
}

function projectChartJson(source: string): string | null {
  let payload: { type?: string; title?: string; unit?: string; data?: unknown };
  try {
    payload = JSON.parse(source);
  } catch {
    return null;
  }
  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : 'bar';
  if (!['bar', 'hbar', 'pie'].includes(type)) return null;
  if (!Array.isArray(payload.data)) return null;
  const rows: ChartRow[] = [];
  for (const item of payload.data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = rec.name ?? rec.label;
    const value = rec.value ?? rec.y;
    if (typeof label === 'string' && typeof value === 'number') {
      rows.push({ label, value });
    }
  }
  if (rows.length === 0) return null;
  return renderBars(rows, typeof payload.title === 'string' ? payload.title : '', typeof payload.unit === 'string' ? payload.unit : '');
}

function renderBars(rows: ChartRow[], title: string, unit: string): string {
  const widths = rows.map((r) => r.label.length);
  const labelWidth = Math.min(Math.max(...widths, 1), 24);
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const lines: string[] = [];
  if (title) lines.push(unit ? `${title}（${unit}）` : title);
  for (const row of rows) {
    const label = row.label.length > labelWidth ? row.label.slice(0, labelWidth - 1) + '…' : row.label.padEnd(labelWidth);
    // 负值不画条只报数（条形图表达负值会误导），比例按绝对值缩放。
    const filled = row.value >= 0 ? Math.round((row.value / max) * BAR_WIDTH) : 0;
    const bar = '█'.repeat(Math.max(filled, row.value > 0 ? 1 : 0));
    lines.push(`${label} | ${bar} ${row.value}`);
  }
  return lines.join('\n');
}

// ── map：markers + route → 标记清单 ──
// parseMapSpec（shared/mapSpec，纯解析器）是 GUI 渲染的同一入口——投影吃
// 它的产出，字段名永不漂移。

function projectMap(source: string): string | null {
  // parseMapSource 解析失败会 throw——projectForm 外层兜住转 null（诚实降级）。
  const { spec } = parseMapSource(source);
  if (!spec) return null;
  const markers = spec.markers ?? [];
  const route = spec.route ?? [];
  if (markers.length === 0 && route.length === 0) return null;
  const lines: string[] = [];
  if (spec.title) lines.push(spec.title);
  for (const marker of markers) {
    const name = marker.title || marker.label || '';
    const tag = marker.title && marker.label ? `（${marker.label}）` : '';
    const coords = `${marker.lat}, ${marker.lng}`;
    lines.push(name ? `● ${name}${tag} — ${coords}` : `● ${coords}`);
  }
  if (route.length > 0) {
    lines.push(`route: ${route.length} 个航点`);
  }
  return lines.join('\n');
}

// ── paint：shapes → 形状清单 ──
// paintSpec（ui/paintSpec.ts）的 parsePaintSource 会 throw 且带修复逻辑，
// 投影只需要一层轻量遍历；字段名由 formProjections.test.ts 以 PaintShape
// 类型字面量 fixture 编译期锁定，漂移即类型红。

interface PaintShapeLike {
  type: string;
  [key: string]: unknown;
}

function projectPaint(source: string): string | null {
  let payload: { width?: unknown; height?: unknown; shapes?: unknown };
  try {
    payload = JSON.parse((source ?? '').trim());
  } catch {
    return null;
  }
  if (!Array.isArray(payload.shapes) || payload.shapes.length === 0) return null;
  const lines: string[] = [];
  if (typeof payload.width === 'number' && typeof payload.height === 'number') {
    lines.push(`canvas ${payload.width}×${payload.height}`);
  }
  const MAX = 40;
  let emitted = 0;
  const walk = (shapes: unknown[], depth: number): void => {
    for (const shape of shapes) {
      if (emitted >= MAX) return;
      if (!shape || typeof shape !== 'object') continue;
      const s = shape as PaintShapeLike;
      if (s.type === 'group' && Array.isArray(s.children)) {
        walk(s.children, depth + 1);
        continue;
      }
      const line = describeShape(s);
      if (line) {
        lines.push(`${'  '.repeat(depth)}- ${line}`);
        emitted += 1;
      }
    }
  };
  walk(payload.shapes as unknown[], 0);
  if (emitted === 0) return null;
  const total = countShapes(payload.shapes as unknown[]);
  if (total > emitted) lines.push(`…and ${total - emitted} more`);
  return lines.join('\n');
}

function countShapes(shapes: unknown[]): number {
  let count = 0;
  for (const shape of shapes) {
    if (!shape || typeof shape !== 'object') continue;
    const s = shape as PaintShapeLike;
    if (s.type === 'group' && Array.isArray(s.children)) count += countShapes(s.children);
    else count += 1;
  }
  return count;
}

const num = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v)) : '?');

function describeShape(s: PaintShapeLike): string | null {
  switch (s.type) {
    case 'rect':
      return `rect (${num(s.x)},${num(s.y)}) ${num(s.w)}×${num(s.h)}`;
    case 'circle':
      return `circle @ (${num(s.cx)},${num(s.cy)}) r=${num(s.r)}`;
    case 'ellipse':
      return `ellipse @ (${num(s.cx)},${num(s.cy)}) rx=${num(s.rx)}`;
    case 'line':
      return `line (${num(s.x1)},${num(s.y1)}) → (${num(s.x2)},${num(s.y2)})`;
    case 'arrow':
      return `arrow (${num(s.x1)},${num(s.y1)}) → (${num(s.x2)},${num(s.y2)})`;
    case 'polygon':
    case 'polyline':
      return `${s.type} ${Array.isArray(s.points) ? Math.floor(s.points.length / 2) : '?'} 点`;
    case 'path':
      return `path ${typeof s.d === 'string' ? s.d.length : '?'} 字符`;
    case 'text':
      return `text "${typeof s.text === 'string' ? s.text : ''}" @ (${num(s.x)},${num(s.y)})`;
    default:
      return null;
  }
}
