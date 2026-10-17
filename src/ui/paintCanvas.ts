// src/ui/paintCanvas.ts
// Canvas-2D renderer for ```paint blocks — pure's own declarative drawing DSL
// (vocabulary + parsing live in paintSpec.ts). No third-party dependency
// (unlike echarts/leaflet) so markdown.ts imports this statically; the module
// still lives in its own file to keep the parser headlessly testable and the
// canvas lifecycle out of markdown.ts. Lifecycle mirrors echartsChart.ts:
// dispose on re-render, ResizeObserver refit, detached-target cleanup via a
// document MutationObserver. All drawing happens in spec-logical coordinates
// after a single setTransform — any display size stays sharp.

import {
  parsePathD,
  PAINT_DEFAULT_TEXT_COLOR,
  type PaintShape,
  type PaintSpec,
  type PaintStyle,
  type PaintGradientDef,
  type PaintTransform,
} from './paintSpec';

export { parsePaintSource } from './paintSpec';

interface PaintEntry {
  canvas: HTMLCanvasElement;
  ro: ResizeObserver | null;
}

const instances = new WeakMap<HTMLElement, PaintEntry>();
const paintTargets = new Set<HTMLElement>();
let detachedPaintObserver: MutationObserver | null = null;

function disposePaintTarget(target: HTMLElement): void {
  const existing = instances.get(target);
  if (existing) {
    existing.ro?.disconnect();
    instances.delete(target);
  }
  paintTargets.delete(target);
  if (paintTargets.size === 0) {
    detachedPaintObserver?.disconnect();
    detachedPaintObserver = null;
  }
}

function ensureDetachedPaintObserver(): void {
  if (detachedPaintObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return;
  detachedPaintObserver = new MutationObserver(() => {
    for (const target of [...paintTargets]) {
      if (!target.isConnected) disposePaintTarget(target);
    }
  });
  detachedPaintObserver.observe(document.body, { childList: true, subtree: true });
}

// ── drawing ──

type GradientTable = Map<string, PaintGradientDef>;
type ResolvedPaint = string | CanvasGradient | null;

interface DrawCtx {
  gradients: GradientTable;
  built: Map<string, CanvasGradient>; // lazily created, per-render cache
}

function resolvePaint(
  ctx: CanvasRenderingContext2D,
  paint: PaintStyle['fill'],
  state: DrawCtx,
): ResolvedPaint {
  if (paint === undefined) return null;
  if (typeof paint === 'string') return paint;
  const def = state.gradients.get(paint.gradient);
  if (!def) return null; // unknown id — treated as no paint
  const cached = state.built.get(paint.gradient);
  if (cached) return cached;
  // A spec color that slips past the parser's sanity check (an exotic invalid
  // CSS color, say) throws on the REAL canvas inside createRadialGradient /
  // addColorStop. One bad gradient must not take the whole painting down:
  // degrade it to no paint, exactly like an unknown id.
  try {
    let grad: CanvasGradient;
    if (def.type === 'radial') {
      grad = ctx.createRadialGradient(def.cx ?? 0, def.cy ?? 0, 0, def.cx ?? 0, def.cy ?? 0, def.r ?? 0);
    } else {
      const from = def.from ?? [0, 0];
      const to = def.to ?? [1, 0];
      grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
    }
    for (const stop of def.stops) grad.addColorStop(stop.offset, stop.color);
    state.built.set(paint.gradient, grad);
    return grad;
  } catch (err) {
    console.debug(`[paint] gradient "${paint.gradient}" dropped:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function buildFont(s: Extract<PaintShape, { type: 'text' }>): string {
  const parts: string[] = [];
  if (s.italic) parts.push('italic');
  if (s.bold) parts.push('bold');
  parts.push(`${s.size ?? 14}px`);
  parts.push(s.family ?? 'system-ui, -apple-system, sans-serif');
  return parts.join(' ');
}

function drawRoundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawArrowHeads(ctx: CanvasRenderingContext2D, s: Extract<PaintShape, { type: 'arrow' }>): void {
  const size = s.headSize ?? 10;
  const color = typeof s.stroke === 'string' ? s.stroke : '#333';
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const head = (tipX: number, tipY: number, dir: number): void => {
    const wing = 0.42; // ~24° half-angle
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - size * Math.cos(dir - wing), tipY - size * Math.sin(dir - wing));
    ctx.lineTo(tipX - size * Math.cos(dir + wing), tipY - size * Math.sin(dir + wing));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  if (s.head === 'both' || s.head === 'end' || s.head === undefined) head(s.x2, s.y2, angle);
  if (s.head === 'both' || s.head === 'start') head(s.x1, s.y1, angle + Math.PI);
}

/** Rough bbox of a shape list — only good enough as a rotate-around center. */
function bboxOf(shapes: PaintShape[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const walk = (list: PaintShape[]): void => {
    for (const s of list) {
      if (s.type === 'rect') { add(s.x, s.y); add(s.x + s.w, s.y + s.h); }
      else if (s.type === 'circle') { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); }
      else if (s.type === 'ellipse') { add(s.cx - s.rx, s.cy - (s.ry ?? s.rx)); add(s.cx + s.rx, s.cy + (s.ry ?? s.rx)); }
      else if (s.type === 'line' || s.type === 'arrow') { add(s.x1, s.y1); add(s.x2, s.y2); }
      else if (s.type === 'polygon' || s.type === 'polyline') {
        for (let i = 0; i < s.points.length; i += 2) add(s.points[i], s.points[i + 1]);
      } else if (s.type === 'text') { add(s.x, s.y - (s.size ?? 14)); add(s.x + s.text.length * (s.size ?? 14) * 0.6, s.y); }
      else if (s.type === 'group') walk(s.children);
    }
  };
  walk(shapes);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function applyTransform(ctx: CanvasRenderingContext2D, t: PaintTransform, children: PaintShape[]): void {
  if (t.translate) ctx.translate(t.translate[0], t.translate[1]);
  if (t.rotate !== undefined) {
    const rad = (typeof t.rotate === 'number' ? t.rotate : t.rotate.deg) * (Math.PI / 180);
    if (typeof t.rotate === 'number') {
      // rotate around the children's own bbox center
      const bb = bboxOf(children);
      const cx = (bb.minX + bb.maxX) / 2;
      const cy = (bb.minY + bb.maxY) / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rad);
      ctx.translate(-cx, -cy);
    } else {
      const cx = t.rotate.cx ?? 0;
      const cy = t.rotate.cy ?? 0;
      ctx.translate(cx, cy);
      ctx.rotate(rad);
      ctx.translate(-cx, -cy);
    }
  }
  if (t.scale !== undefined) {
    if (typeof t.scale === 'number') ctx.scale(t.scale, t.scale);
    else ctx.scale(t.scale[0], t.scale[1]);
  }
}

function drawShape(ctx: CanvasRenderingContext2D, s: PaintShape, state: DrawCtx): void {
  ctx.save();
  ctx.globalAlpha *= s.opacity ?? 1;
  if (s.dash) ctx.setLineDash(Array.isArray(s.dash) ? s.dash : [s.dash]);

  if (s.type === 'group') {
    if (s.transform) applyTransform(ctx, s.transform, s.children);
    for (const child of s.children) drawShape(ctx, child, state);
    ctx.restore();
    return;
  }

  const fill = resolvePaint(ctx, s.fill, state);
  const stroke = resolvePaint(ctx, s.stroke, state);
  ctx.lineWidth = s.strokeWidth ?? 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.type === 'rect') {
    ctx.beginPath();
    if (s.r) drawRoundRectPath(ctx, s.x, s.y, s.w, s.h, s.r);
    else ctx.rect(s.x, s.y, s.w, s.h);
    paintFillStroke(ctx, fill, stroke);
  } else if (s.type === 'circle') {
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
    paintFillStroke(ctx, fill, stroke);
  } else if (s.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry ?? s.rx, 0, 0, Math.PI * 2);
    paintFillStroke(ctx, fill, stroke);
  } else if (s.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    if (stroke) ctx.strokeStyle = stroke;
    ctx.stroke();
  } else if (s.type === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    if (stroke) ctx.strokeStyle = stroke;
    ctx.stroke();
    drawArrowHeads(ctx, s);
  } else if (s.type === 'path') {
    const cmds = parsePathD(s.d);
    if (cmds) {
      ctx.beginPath();
      let started = false;
      for (const cmd of cmds) {
        if (cmd.c === 'M') { ctx.moveTo(cmd.x, cmd.y); started = true; }
        else if (cmd.c === 'L') { if (!started) { ctx.moveTo(cmd.x, cmd.y); started = true; } else ctx.lineTo(cmd.x, cmd.y); }
        else if (cmd.c === 'C') ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
        else if (cmd.c === 'Q') ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
        else if (cmd.c === 'Z') ctx.closePath();
      }
      if (started) paintFillStroke(ctx, fill, stroke);
    }
  } else if (s.type === 'polygon' || s.type === 'polyline') {
    ctx.beginPath();
    for (let i = 0; i < s.points.length; i += 2) {
      if (i === 0) ctx.moveTo(s.points[0], s.points[1]);
      else ctx.lineTo(s.points[i], s.points[i + 1]);
    }
    if (s.type === 'polygon') {
      ctx.closePath();
      paintFillStroke(ctx, fill, stroke);
    } else {
      if (stroke) ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  } else if (s.type === 'text') {
    ctx.font = buildFont(s);
    ctx.textAlign = s.align ?? 'left';
    ctx.textBaseline = s.baseline ?? 'alphabetic';
    ctx.fillStyle = s.color ?? PAINT_DEFAULT_TEXT_COLOR;
    ctx.fillText(s.text, s.x, s.y);
  }
  ctx.restore();
}

function paintFillStroke(ctx: CanvasRenderingContext2D, fill: ResolvedPaint, stroke: ResolvedPaint): void {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/** Draw the full scene in spec-logical space. The caller has already set the
 *  transform so 1 unit = 1 spec px. `backgroundOverride` replaces spec.background
 *  (PNG export passes the card color when the spec has none). */
function drawScene(ctx: CanvasRenderingContext2D, spec: PaintSpec, backgroundOverride?: string | null): void {
  const state: DrawCtx = {
    gradients: new Map((spec.defs?.gradients ?? []).map((g) => [g.id, g])),
    built: new Map(),
  };
  const bg = backgroundOverride !== undefined ? backgroundOverride : spec.background;
  if (bg !== undefined && bg !== null) {
    const resolved = typeof bg === 'string' ? bg : resolvePaint(ctx, bg, state);
    if (resolved) {
      ctx.fillStyle = resolved;
      ctx.fillRect(0, 0, spec.width, spec.height);
    }
  }
  for (const shape of spec.shapes) drawShape(ctx, shape, state);
}

// ── lifecycle (mirrors echartsChart.ts) ──

/**
 * Render a parsed paint spec into `target` (the `.paint-target` div). Disposes
 * any previous rendering on the same target (retry / re-render) and re-fits on
 * container resize via a ResizeObserver. The backing store is display-size ×
 * devicePixelRatio; drawing coordinates stay in spec space.
 */
export function renderPaintInto(target: HTMLElement, spec: PaintSpec): void {
  // An async render can finish after its transcript row was replaced. Never
  // create a canvas for an already-detached target.
  if (!target.isConnected) return;
  const hadCanvas = instances.has(target);
  disposePaintTarget(target);
  if (hadCanvas) target.innerHTML = '';

  const canvas = document.createElement('canvas');
  target.appendChild(canvas);

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        // rAF-throttle: a layout storm should coalesce into one redraw
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (target.isConnected && instances.has(target)) fitAndDraw(target, canvas, spec);
          });
        } else {
          fitAndDraw(target, canvas, spec);
        }
      })
    : null;
  ro?.observe(target);
  instances.set(target, { canvas, ro });
  paintTargets.add(target);
  ensureDetachedPaintObserver();

  fitAndDraw(target, canvas, spec);
}

function fitAndDraw(target: HTMLElement, canvas: HTMLCanvasElement, spec: PaintSpec): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  // Measure the container; fall back to spec width when unmeasured (tests,
  // pre-layout). Scale may exceed 1 — the canvas fills the card width.
  const targetW = target.clientWidth > 40 ? target.clientWidth : spec.width;
  const scale = Math.max(0.05, targetW / spec.width);
  canvas.width = Math.round(spec.width * scale * dpr);
  canvas.height = Math.round(spec.height * scale * dpr);
  canvas.style.aspectRatio = `${spec.width} / ${spec.height}`;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  drawScene(ctx, spec);
}

/**
 * Rasterize a spec at `scale`× over a background (solid color, gradient, or
 * null = transparent) into a PNG blob. Isolated from the live canvas so the
 * export path and tests share one implementation; `toBlob` is injectable
 * because happy-dom (and some webviews) lack canvas.toBlob.
 */
export function renderPaintToBlob(
  spec: PaintSpec,
  background: string | null | undefined,
  scale = 2,
  toBlob: (c: HTMLCanvasElement, cb: (b: Blob | null) => void) => void = (c, cb) => c.toBlob(cb),
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(spec.width * scale);
    canvas.height = Math.round(spec.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawScene(ctx, spec, background);
    const timer = setTimeout(() => resolve(null), 5000);
    toBlob(canvas, (blob) => {
      clearTimeout(timer);
      resolve(blob);
    });
  });
}

/** The slot's canvas as a data URL (viewer popup path). Empty string on failure. */
export function paintCanvasToDataUrl(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}
