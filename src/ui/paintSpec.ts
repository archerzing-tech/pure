// src/ui/paintSpec.ts
// Pure parser for ```paint blocks — the declarative drawing DSL for static
// geometric illustration (architecture sketches, flow schematics, geometry,
// icons). No canvas / DOM import here so the whole vocabulary validates
// headlessly in bun; paintCanvas.ts imports these types + parser and owns the
// renderer. JSON repair reuses repairJsonSource (the same parser chart/map
// use) — this module never invents geometry on the model's behalf.

import { repairJsonSource } from '../shared/parseRepair';

export const PAINT_SPEC_VERSION = 1;

/** Total shape nodes (groups included) collected before truncation. */
export const PAINT_MAX_SHAPES = 500;

/** group nesting depth limit — guards against pathological recursion. */
export const PAINT_MAX_DEPTH = 8;

/** Fallback text color — theme-neutral gray; the prompt asks for explicit colors. */
export const PAINT_DEFAULT_TEXT_COLOR = '#475569';

/** A fill/stroke: any CSS color string, or a gradient reference. The string
 *  form is deliberately the ONLY way to write a plain color — `'#g1'` would
 *  be ambiguous with hex, so gradient refs are object-only. */
export type PaintPaint = string | { gradient: string };

export interface PaintColorStop {
  offset: number; // 0..1, clamped
  color: string;
}

export interface PaintGradientDef {
  id: string;
  type?: 'linear' | 'radial'; // default 'linear'
  from?: [number, number]; // linear start, absolute canvas px (default [0, 0])
  to?: [number, number]; // linear end (default [width, 0])
  cx?: number; // radial center
  cy?: number;
  r?: number; // radial radius (default: half the canvas diagonal)
  stops: PaintColorStop[];
}

export interface PaintDefs {
  gradients?: PaintGradientDef[];
}

export interface PaintStyle {
  fill?: PaintPaint; // default: none
  stroke?: PaintPaint; // default: none (line/arrow/polyline without one are skipped)
  strokeWidth?: number; // default 2
  dash?: number[]; // logical px; a bare number n is normalized to [n]
  opacity?: number; // 0..1, clamped
}

export interface PaintTransform {
  translate?: [number, number];
  rotate?: number | { deg: number; cx?: number; cy?: number };
  scale?: number | [number, number];
}

export type PaintShape = PaintStyle & (
  | { type: 'rect'; x: number; y: number; w: number; h: number; r?: number }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry?: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | {
      type: 'arrow';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      head?: 'end' | 'start' | 'both';
      headSize?: number;
    }
  | { type: 'path'; d: string }
  | { type: 'polygon' | 'polyline'; points: number[] }
  | {
      type: 'text';
      x: number;
      y: number;
      text: string;
      size?: number;
      color?: string;
      align?: 'left' | 'center' | 'right';
      baseline?: 'alphabetic' | 'top' | 'middle' | 'bottom';
      bold?: boolean;
      italic?: boolean;
      family?: string;
    }
  | { type: 'group'; transform?: PaintTransform; children: PaintShape[] }
);

export interface PaintSpec {
  version?: number; // informational only — never validated (forward compat)
  title?: string; // optional, PNG export filename only
  width: number; // logical px, default 640, clamped [16, 4000]
  height: number; // logical px, default 400, clamped [16, 4000]
  background?: PaintPaint; // default: transparent (card shows through)
  shapes: PaintShape[];
  defs?: PaintDefs;
}

// Absolute-coordinate path command list produced by parsePathD and consumed
// by the renderer (relative commands are flattened away at parse time).
export type PathCmd =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; rot: number; largeArc: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { c: 'Z' };

// ── helpers ──

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function numOr(v: unknown, fallback: number, lo?: number, hi?: number): number {
  const n = num(v);
  if (n === null) return fallback;
  if (lo !== undefined && hi !== undefined) return clamp(n, lo, hi);
  return n;
}

/** Parse a fill/stroke value. Returns null when the value is unusable. */
function parsePaint(v: unknown): PaintPaint | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const g = (v as Record<string, unknown>).gradient;
    if (typeof g === 'string' && g.trim()) return { gradient: g.trim() };
  }
  return null;
}

function parseDash(v: unknown): number[] | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return [v];
  if (Array.isArray(v)) {
    const out = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/** points: flat [x1,y1,x2,y2,…]; nested [[x,y],…] pairs are flattened. Odd
 *  tails are truncated (a dangling coordinate pair-less number is dropped). */
function parsePoints(v: unknown): number[] | null {
  let flat: number[];
  if (Array.isArray(v)) {
    flat = [];
    for (const item of v) {
      if (typeof item === 'number' && Number.isFinite(item)) flat.push(item);
      else if (Array.isArray(item)) {
        for (const n of item) {
          if (typeof n === 'number' && Number.isFinite(n)) flat.push(n);
        }
      }
    }
  } else if (typeof v === 'string') {
    flat = (v.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
  } else {
    return null;
  }
  if (flat.length < 4) return null; // need at least two points
  if (flat.length % 2 === 1) flat = flat.slice(0, -1);
  return flat;
}

function parseTransform(v: unknown): PaintTransform | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const t: PaintTransform = {};
  if (Array.isArray(o.translate)) {
    const [tx, ty] = o.translate.map((n) => num(n));
    if (tx !== null && ty !== null) t.translate = [tx, ty];
  }
  if (typeof o.rotate === 'number' && Number.isFinite(o.rotate)) {
    t.rotate = o.rotate;
  } else if (typeof o.rotate === 'object' && o.rotate !== null) {
    const r = o.rotate as Record<string, unknown>;
    const deg = num(r.deg);
    if (deg !== null) {
      const cx = num(r.cx);
      const cy = num(r.cy);
      t.rotate = cx !== null && cy !== null ? { deg, cx, cy } : { deg };
    }
  }
  if (typeof o.scale === 'number' && Number.isFinite(o.scale)) {
    t.scale = o.scale;
  } else if (Array.isArray(o.scale)) {
    const [sx, sy] = o.scale.map((n) => num(n));
    if (sx !== null && sy !== null) t.scale = [sx, sy];
  }
  return Object.keys(t).length > 0 ? t : undefined;
}

// ── path `d` parsing (SVG subset: M L H V C S Q T A Z, both cases) ──

interface PathToken {
  cmd: string;
  args: number[];
}

/** Tokenize a `d` string into (command, args) pairs. Accepts `;` or whitespace
 *  as separators and SVG-style run-together numbers ("10-2.5" → 10, -2.5). */
function tokenizePathD(d: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  let i = 0;
  const readNumber = (): number | null => {
    while (i < d.length && /[\s,;]/.test(d[i])) i++;
    const start = i;
    if (i < d.length && (d[i] === '+' || d[i] === '-')) i++;
    let seenDot = false;
    let seenDigit = false;
    while (i < d.length) {
      const ch = d[i];
      if (ch >= '0' && ch <= '9') { seenDigit = true; i++; }
      else if (ch === '.' && !seenDot) { seenDot = true; i++; }
      else break;
    }
    if (!seenDigit) {
      i = start;
      return null;
    }
    // exponent
    if (i < d.length && (d[i] === 'e' || d[i] === 'E')) {
      let j = i + 1;
      if (j < d.length && (d[j] === '+' || d[j] === '-')) j++;
      if (j < d.length && d[j] >= '0' && d[j] <= '9') {
        i = j;
        while (i < d.length && d[i] >= '0' && d[i] <= '9') i++;
      }
    }
    return Number(d.slice(start, i));
  };
  while (i < d.length) {
    while (i < d.length && /[\s,;]/.test(d[i])) i++;
    if (i >= d.length) break;
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      tokens.push({ cmd: ch, args: [] });
      i++;
      continue;
    }
    const n = readNumber();
    if (n === null) return null; // untokenizable
    if (tokens.length === 0) return null; // number before any command
    tokens[tokens.length - 1].args.push(n);
  }
  return tokens;
}

/** Endpoint-to-center parameterization of an SVG arc (W3C spec F.6.5). */
function arcToCurves(
  x1: number, y1: number, rx: number, ry: number, rotDeg: number,
  largeArc: 0 | 1, sweep: 0 | 1, x2: number, y2: number,
): Array<{ c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }> {
  if (rx === 0 || ry === 0) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = denom === 0 ? 0 : sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry) / denom - 1));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;
  // Split into ≤90° cubic segments (standard approximation).
  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const delta = deltaTheta / segments;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: Array<{ c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }> = [];
  let th = theta1;
  for (let s = 0; s < segments; s++) {
    const th2 = th + delta;
    const cos1 = Math.cos(th);
    const sin1 = Math.sin(th);
    const cos2 = Math.cos(th2);
    const sin2 = Math.sin(th2);
    // ellipse-space endpoints of this segment, then rotate+translate out
    const e1x = rx * cos1;
    const e1y = ry * sin1;
    const e2x = rx * cos2;
    const e2y = ry * sin2;
    const d1x = -rx * sin1;
    const d1y = ry * cos1;
    const d2x = -rx * sin2;
    const d2y = ry * cos2;
    const toCanvas = (ex: number, ey: number): [number, number] => [
      cosPhi * ex - sinPhi * ey + cx,
      sinPhi * ex + cosPhi * ey + cy,
    ];
    const toCanvasVec = (ex: number, ey: number): [number, number] => [
      cosPhi * ex - sinPhi * ey,
      sinPhi * ex + cosPhi * ey,
    ];
    const [cp1x, cp1y] = toCanvas(e1x + t * d1x, e1y + t * d1y);
    const [cp2x, cp2y] = toCanvas(e2x - t * d2x, e2y - t * d2y);
    const [ex, ey] = toCanvas(e2x, e2y);
    out.push({ c: 'C', x1: cp1x, y1: cp1y, x2: cp2x, y2: cp2y, x: ex, y: ey });
    th = th2;
  }
  // Guard against drift: snap the final point to the requested endpoint.
  if (out.length > 0) {
    out[out.length - 1].x = x2;
    out[out.length - 1].y = y2;
  }
  return out;
}

/** Parse a path `d` string into absolute PathCmds. Returns null when the
 *  string cannot be tokenized or starts before any M (renderer skips it). */
export function parsePathD(d: string): PathCmd[] | null {
  const tokens = tokenizePathD(d);
  if (!tokens || tokens.length === 0) return null;
  const out: PathCmd[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let lastCmd = '';
  // Second control point of the most recent C/S segment — the point S reflects.
  let lastC2x = 0;
  let lastC2y = 0;
  let lastQx = 0;
  let lastQy = 0;
  for (const tok of tokens) {
    const cmd = tok.cmd;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const a = tok.args;
    let k = 0;
    // Callers pass the current coordinate on the same axis as the value being
    // read, so relative resolution is uniform: `rel ? base + v : v`. The arc
    // command is the exception (radii / rotation / flags are never relative)
    // and reads args directly below.
    const take = (base: number): number | null => {
      const v = a[k++];
      if (v === undefined) return null;
      return rel ? base + v : v;
    };
    let firstPair = true;
    do {
      if (C === 'M') {
        const x = take(cx);
        const y = take(cy);
        if (x === null || y === null) return null;
        if (!firstPair) {
          // implicit repeat after M is a lineto in SVG semantics
          cx = x;
          cy = y;
          out.push({ c: 'L', x, y });
        } else {
          cx = x;
          cy = y;
          startX = x;
          startY = y;
          out.push({ c: 'M', x, y });
        }
      } else if (C === 'L') {
        const x = take(cx);
        const y = take(cy);
        if (x === null || y === null) return null;
        cx = x;
        cy = y;
        out.push({ c: 'L', x, y });
      } else if (C === 'H') {
        const x = take(cx);
        if (x === null) return null;
        cx = x;
        out.push({ c: 'L', x, y: cy });
      } else if (C === 'V') {
        const y = take(cy);
        if (y === null) return null;
        cy = y;
        out.push({ c: 'L', x: cx, y });
      } else if (C === 'C') {
        const x1 = take(cx);
        const y1 = take(cy);
        const x2 = take(cx);
        const y2 = take(cy);
        const x = take(cx);
        const y = take(cy);
        if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) return null;
        cx = x;
        cy = y;
        lastC2x = x2;
        lastC2y = y2;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
      } else if (C === 'S') {
        const x2 = take(cx);
        const y2 = take(cy);
        const x = take(cx);
        const y = take(cy);
        if (x2 === null || y2 === null || x === null || y === null) return null;
        // reflect the previous C/S second control point about the current point
        const rx1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * cx - lastC2x : cx;
        const ry1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * cy - lastC2y : cy;
        cx = x;
        cy = y;
        lastC2x = x2;
        lastC2y = y2;
        out.push({ c: 'C', x1: rx1, y1: ry1, x2, y2, x, y });
      } else if (C === 'Q') {
        const x1 = take(cx);
        const y1 = take(cy);
        const x = take(cx);
        const y = take(cy);
        if (x1 === null || y1 === null || x === null || y === null) return null;
        cx = x;
        cy = y;
        lastQx = x1;
        lastQy = y1;
        out.push({ c: 'Q', x1, y1, x, y });
      } else if (C === 'T') {
        const x = take(cx);
        const y = take(cy);
        if (x === null || y === null) return null;
        const qx1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * cx - lastQx : cx;
        const qy1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * cy - lastQy : cy;
        cx = x;
        cy = y;
        lastQx = qx1;
        lastQy = qy1;
        out.push({ c: 'Q', x1: qx1, y1: qy1, x, y });
      } else if (C === 'A') {
        const rx = a[k++];
        const ry = a[k++];
        const rot = a[k++];
        const laf = a[k++];
        const sf = a[k++];
        const ax = a[k++];
        const ay = a[k++];
        if (rx === undefined || ry === undefined || rot === undefined || laf === undefined || sf === undefined || ax === undefined || ay === undefined) return null;
        // Only the endpoint participates in relative semantics (SVG spec):
        // radii, rotation and the two flags do not.
        const x = rel ? cx + ax : ax;
        const y = rel ? cy + ay : ay;
        if (x === cx && y === cy) {
          // SVG: identical endpoints omit the arc segment entirely (the
          // endpoint parameterization degenerates — no center exists).
        } else {
          const segs = arcToCurves(cx, cy, rx, ry, rot, laf ? 1 : 0, sf ? 1 : 0, x, y);
          if (segs.length === 0) {
            // degenerate radii — degrade to a straight line
            cx = x;
            cy = y;
            out.push({ c: 'L', x, y });
          } else {
            for (const seg of segs) out.push(seg);
            cx = x;
            cy = y;
          }
        }
      } else if (C === 'Z') {
        out.push({ c: 'Z' });
        cx = startX;
        cy = startY;
      } else {
        return null; // unknown command — skip the whole shape
      }
      // Z is deliberately recorded: it is neither C/S nor Q/T, so a following
      // S/T must NOT reflect a control point from before the closepath.
      lastCmd = C;
      firstPair = false;
    } while (
      k < a.length &&
      (C === 'M' || C === 'L' || C === 'H' || C === 'V' || C === 'C' || C === 'S' || C === 'Q' || C === 'T' || C === 'A')
    ); // implicit repeats (SVG allows trailing coordinate sets for every command)
  }
  if (out.length === 0) return null;
  return out;
}

// ── shape parsing ──

interface ParseCtx {
  count: number; // total nodes collected (for PAINT_MAX_SHAPES)
}

function parseStyleCommon(o: Record<string, unknown>): PaintStyle {
  const style: PaintStyle = {};
  const fill = parsePaint(o.fill);
  if (fill !== null) style.fill = fill;
  const stroke = parsePaint(o.stroke);
  if (stroke !== null) style.stroke = stroke;
  const sw = num(o.strokeWidth);
  if (sw !== null && sw >= 0) style.strokeWidth = sw;
  const dash = parseDash(o.dash);
  if (dash) style.dash = dash;
  const op = num(o.opacity);
  if (op !== null) style.opacity = clamp(op, 0, 1);
  return style;
}

/** Parse one shape object; returns null when the shape is unusable (the rest
 *  of the drawing must not be dragged down by one bad node). */
function parseShape(o: Record<string, unknown>, depth: number, ctx: ParseCtx): PaintShape | null {
  const type = o.type;
  if (typeof type !== 'string') return null;
  const style = parseStyleCommon(o);

  if (type === 'rect') {
    const x = num(o.x);
    const y = num(o.y);
    const w = num(o.w);
    const h = num(o.h);
    if (x === null || y === null || w === null || h === null) return null;
    const r = num(o.r);
    return { type, x, y, w, h, r: r !== null && r > 0 ? r : undefined, ...style };
  }
  if (type === 'circle') {
    const cx = num(o.cx);
    const cy = num(o.cy);
    const r = num(o.r);
    if (cx === null || cy === null || r === null) return null;
    return { type, cx, cy, r, ...style };
  }
  if (type === 'ellipse') {
    const cx = num(o.cx);
    const cy = num(o.cy);
    const rx = num(o.rx);
    if (cx === null || cy === null || rx === null) return null;
    const ry = num(o.ry);
    return { type, cx, cy, rx, ry: ry !== null ? ry : undefined, ...style };
  }
  if (type === 'line' || type === 'arrow') {
    const x1 = num(o.x1);
    const y1 = num(o.y1);
    const x2 = num(o.x2);
    const y2 = num(o.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    if (style.stroke === undefined) return null; // an unstroked line is invisible
    if (type === 'line') return { type, x1, y1, x2, y2, ...style };
    const head = o.head;
    const headOk = head === 'end' || head === 'start' || head === 'both' ? head : undefined;
    return { type, x1, y1, x2, y2, head: headOk, headSize: numOr(o.headSize, 10, 1, 200), ...style };
  }
  if (type === 'path') {
    if (typeof o.d !== 'string' || !o.d.trim()) return null;
    const cmds = parsePathD(o.d);
    if (!cmds) return null;
    return { type, d: o.d, ...style };
  }
  if (type === 'polygon' || type === 'polyline') {
    const points = parsePoints(o.points);
    if (!points) return null;
    if (type === 'polygon' && style.fill === undefined && style.stroke === undefined) return null;
    if (type === 'polyline' && style.stroke === undefined) return null;
    return { type, points, ...style };
  }
  if (type === 'text') {
    if (typeof o.text !== 'string' || !o.text) return null;
    const x = num(o.x);
    const y = num(o.y);
    if (x === null || y === null) return null;
    const align = o.align === 'left' || o.align === 'center' || o.align === 'right' ? o.align : undefined;
    const baseline =
      o.baseline === 'alphabetic' || o.baseline === 'top' || o.baseline === 'middle' || o.baseline === 'bottom'
        ? o.baseline
        : undefined;
    return {
      type,
      x,
      y,
      text: o.text,
      size: numOr(o.size, 14, 1, 400),
      color: typeof o.color === 'string' && o.color.trim() ? o.color.trim() : undefined,
      align,
      baseline,
      bold: o.bold === true ? true : undefined,
      italic: o.italic === true ? true : undefined,
      family: typeof o.family === 'string' && o.family.trim() ? o.family.trim() : undefined,
      ...style,
    };
  }
  if (type === 'group') {
    if (depth >= PAINT_MAX_DEPTH) return null;
    const children = parseShapeList(o.children, depth + 1, ctx);
    if (!children) return null;
    return { type, transform: parseTransform(o.transform), children, ...style };
  }
  return null;
}

function parseShapeList(v: unknown, depth: number, ctx: ParseCtx): PaintShape[] | null {
  if (!Array.isArray(v)) return null;
  const out: PaintShape[] = [];
  for (const item of v) {
    if (ctx.count >= PAINT_MAX_SHAPES) break; // truncate, don't throw
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    ctx.count++;
    const shape = parseShape(item as Record<string, unknown>, depth, ctx);
    if (shape) out.push(shape);
  }
  return out;
}

function parseGradients(defs: unknown): Map<string, PaintGradientDef> {
  const map = new Map<string, PaintGradientDef>();
  if (typeof defs !== 'object' || defs === null || Array.isArray(defs)) return map;
  const grads = (defs as Record<string, unknown>).gradients;
  if (!Array.isArray(grads)) return map;
  for (const g of grads) {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) continue;
    const o = g as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || map.has(id)) continue;
    const stops: PaintColorStop[] = [];
    if (Array.isArray(o.stops)) {
      for (const s of o.stops) {
        if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
        const so = s as Record<string, unknown>;
        const offset = num(so.offset);
        // The color must survive real-canvas addColorStop: an empty string
        // throws there, which would take the whole painting down with it.
        const color = typeof so.color === 'string' && so.color.trim() ? so.color.trim() : null;
        if (offset === null || color === null) continue;
        stops.push({ offset: clamp(offset, 0, 1), color });
      }
    }
    if (stops.length === 0) continue; // a gradient without stops is unusable
    const type = o.type === 'radial' ? 'radial' : 'linear';
    const def: PaintGradientDef = { id, type, stops };
    if (type === 'linear') {
      const from = Array.isArray(o.from) ? o.from.map((n) => num(n)) : [];
      const to = Array.isArray(o.to) ? o.to.map((n) => num(n)) : [];
      def.from = from.length === 2 && from[0] !== null && from[1] !== null ? [from[0], from[1]] : undefined;
      def.to = to.length === 2 && to[0] !== null && to[1] !== null ? [to[0], to[1]] : undefined;
    } else {
      def.cx = numOr(o.cx, 0);
      def.cy = numOr(o.cy, 0);
      def.r = numOr(o.r, 0);
      if (!(def.r > 0)) continue; // zero/negative radius throws on the canvas
    }
    map.set(id, def);
  }
  return map;
}

/**
 * Parse a ```paint fenced block into a validated PaintSpec. Accepts a bare
 * JSON object; tolerates stray ``` fences and prose around the JSON (repair
 * comes from repairJsonSource, same as chart/map). One unusable shape is
 * skipped silently — the rest of the drawing still renders.
 */
export function parsePaintSource(raw: string): {
  spec: PaintSpec;
  repaired: boolean;
  repairedSource?: string;
} {
  const trimmed = (raw ?? '').trim().replace(/^```(?:paint)\s*/i, '').replace(/```\s*$/g, '');
  let parsed: unknown;
  let repaired = false;
  let source = trimmed;
  try {
    parsed = JSON.parse(source);
  } catch {
    const result = repairJsonSource(source);
    if (!result.repaired) {
      throw new Error('paint 数据需要是一个 JSON 对象（{ "width": 640, "height": 400, "shapes": [...] }）');
    }
    parsed = JSON.parse(result.source);
    repaired = true;
    source = result.source;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('paint 数据需要是一个 JSON 对象');
  }
  const obj = parsed as Record<string, unknown>;

  const ctx: ParseCtx = { count: 0 };
  const shapes = parseShapeList(obj.shapes, 0, ctx) ?? [];
  if (shapes.length === 0) {
    throw new Error('paint 绘图内容为空（shapes 为空或全部无效）');
  }

  const spec: PaintSpec = {
    width: numOr(obj.width, 640, 16, 4000),
    height: numOr(obj.height, 400, 16, 4000),
    shapes,
  };
  if (typeof obj.version === 'number' && Number.isFinite(obj.version)) spec.version = obj.version;
  if (typeof obj.title === 'string' && obj.title.trim()) spec.title = obj.title.trim();
  const bg = parsePaint(obj.background);
  if (bg !== null) spec.background = bg;
  const gradients = parseGradients(obj.defs);
  if (gradients.size > 0) spec.defs = { gradients: Array.from(gradients.values()) };

  return { spec, repaired, repairedSource: repaired ? source : undefined };
}
