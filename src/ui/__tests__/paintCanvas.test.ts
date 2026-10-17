// src/ui/__tests__/paintCanvas.test.ts
// Renderer tests for ```paint — happy-dom has no canvas 2D, so a recording
// Context2D stub is mounted on the prototype (diagramStreaming.test.ts
// precedent) and assertions run against the recorded op list.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { renderPaintInto, renderPaintToBlob, paintCanvasToDataUrl } from '../paintCanvas';
import type { PaintSpec } from '../paintSpec';

type Op = [string, ...unknown[]];

// One shared recording context per test: getContext returns `currentCtx`, so
// assertions read the ops that renderPaintInto actually produced.
let currentCtx: Record<string, unknown> | null = null;

function useRecording(): Op[] {
  const ops: Op[] = [];
  // addColorStop mimics the REAL canvas contract (SyntaxError on an invalid
  // color): without it, the tolerance path in resolvePaint is untestable —
  // the stub would happily accept `#12345` that a real canvas rejects.
  const validColor = (color: unknown): boolean =>
    typeof color === 'string' &&
    (/^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/.test(color.trim()) ||
      /^(rgba?\(|hsla?\(|[a-z]+)$/i.test(color.trim()));
  const gradient = {
    addColorStop: (offset: number, color: string) => {
      ops.push(['addColorStop', offset, color]);
      if (!validColor(color)) throw new SyntaxError(`The string did not match the expected pattern.: "${color}"`);
    },
  };
  currentCtx = {
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => ops.push(['save']),
    restore: () => ops.push(['restore']),
    beginPath: () => ops.push(['beginPath']),
    closePath: () => ops.push(['closePath']),
    moveTo: (...a: unknown[]) => ops.push(['moveTo', ...a]),
    lineTo: (...a: unknown[]) => ops.push(['lineTo', ...a]),
    arc: (...a: unknown[]) => ops.push(['arc', ...a]),
    ellipse: (...a: unknown[]) => ops.push(['ellipse', ...a]),
    arcTo: () => ops.push(['arcTo']),
    rect: (...a: unknown[]) => ops.push(['rect', ...a]),
    fill: () => ops.push(['fill']),
    stroke: () => ops.push(['stroke']),
    fillRect: (...a: unknown[]) => ops.push(['fillRect', ...a]),
    fillText: (...a: unknown[]) => ops.push(['fillText', ...a]),
    bezierCurveTo: () => ops.push(['bezierCurveTo']),
    quadraticCurveTo: () => ops.push(['quadraticCurveTo']),
    setLineDash: (...a: unknown[]) => ops.push(['setLineDash', ...a]),
    setTransform: (...a: unknown[]) => ops.push(['setTransform', ...a]),
    translate: () => ops.push(['translate']),
    rotate: () => ops.push(['rotate']),
    scale: () => ops.push(['scale']),
    createLinearGradient: (...a: unknown[]) => {
      ops.push(['createLinearGradient', ...a]);
      return gradient;
    },
    createRadialGradient: (...a: unknown[]) => {
      ops.push(['createRadialGradient', ...a]);
      return gradient;
    },
    measureText: (t: string) => ({ width: t.length * 7 }),
  };
  return ops;
}

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost:1420/' });
  originalGetContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = (() =>
    currentCtx) as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  // Restore before unregister: the window (and its patched prototype) goes
  // away with the registration. Without the unregister the next file's
  // top-level GlobalRegistrator.register() throws (single bun process).
  window.HTMLCanvasElement.prototype.getContext = originalGetContext;
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  currentCtx = null;
});

function mount(): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  return target;
}

const baseSpec: PaintSpec = {
  width: 200,
  height: 100,
  shapes: [],
};

describe('renderPaintInto', () => {
  test('appends exactly one canvas whose backing store covers the spec', () => {
    useRecording();
    const target = mount();
    renderPaintInto(target, baseSpec);
    const canvases = target.querySelectorAll('canvas');
    expect(canvases.length).toBe(1);
    const c = canvases[0] as HTMLCanvasElement;
    // happy-dom clientWidth is 0 → falls back to spec width, dpr ≥ 1
    expect(c.width).toBeGreaterThanOrEqual(baseSpec.width);
    expect(c.height).toBeGreaterThanOrEqual(baseSpec.height);
    target.remove();
  });

  test('re-render replaces the canvas instead of stacking', () => {
    useRecording();
    const target = mount();
    renderPaintInto(target, baseSpec);
    renderPaintInto(target, baseSpec);
    expect(target.querySelectorAll('canvas').length).toBe(1);
    target.remove();
  });

  test('detached target never gets a canvas', () => {
    useRecording();
    const target = document.createElement('div'); // never appended
    renderPaintInto(target, baseSpec);
    expect(target.querySelectorAll('canvas').length).toBe(0);
  });

  test('a null 2D context aborts drawing without throwing', () => {
    currentCtx = null;
    const target = mount();
    expect(() => renderPaintInto(target, baseSpec)).not.toThrow();
    target.remove();
  });
});

describe('drawing ops', () => {
  test('spec.background is the first paint and covers the full canvas', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, { ...baseSpec, background: '#ff0000' });
    target.remove();
    const firstPaint = ops.find((o) => o[0] === 'fillRect' || o[0] === 'fill');
    expect(firstPaint?.[0]).toBe('fillRect');
    expect(firstPaint?.slice(1)).toEqual([0, 0, baseSpec.width, baseSpec.height]);
  });

  test('rect/circle/text/dash/arrow/polygon produce their characteristic ops', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, {
      width: 100,
      height: 50,
      shapes: [
        { type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#111', r: 2 },
        { type: 'circle', cx: 50, cy: 25, r: 10, stroke: '#222' },
        { type: 'text', x: 5, y: 20, text: 'hi', size: 16, bold: true },
        { type: 'line', x1: 0, y1: 0, x2: 9, y2: 9, stroke: '#333', dash: 4 as unknown as number[] },
        { type: 'arrow', x1: 0, y1: 40, x2: 90, y2: 40, stroke: '#444' },
        { type: 'polygon', points: [0, 0, 10, 0, 5, 5], fill: '#555' },
      ],
    });
    target.remove();
    const names = ops.map((o) => o[0]);
    expect(names).toContain('fill'); // rect + polygon + arrow heads
    expect(names).toContain('stroke'); // circle/line strokes
    expect(names).toContain('arc'); // circle
    expect(names).toContain('fillText');
    expect(ops.find((o) => o[0] === 'fillText')?.[1]).toBe('hi');
    expect(ops.find((o) => o[0] === 'setLineDash')?.[1]).toEqual([4]);
    expect(names.filter((n) => n === 'fill').length).toBeGreaterThanOrEqual(3);
  });

  test('group wraps children in save/restore pairs and applies transform', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, {
      width: 100,
      height: 50,
      shapes: [
        {
          type: 'group',
          transform: { translate: [5, 5], rotate: 45, scale: 2 },
          children: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000' }],
        },
      ],
    });
    target.remove();
    const names = ops.map((o) => o[0]);
    expect(names.filter((n) => n === 'save').length).toBe(names.filter((n) => n === 'restore').length);
    expect(names).toContain('translate');
    expect(names).toContain('rotate');
    expect(names).toContain('scale');
  });

  test('gradient defs resolve to createLinearGradient + ordered stops', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, {
      width: 100,
      height: 50,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { gradient: 'g1' } }],
      defs: {
        gradients: [
          { id: 'g1', from: [0, 0], to: [100, 0], stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
        ],
      },
    });
    target.remove();
    expect(ops.some((o) => o[0] === 'createLinearGradient')).toBe(true);
    const stops = ops.filter((o) => o[0] === 'addColorStop');
    expect(stops.length).toBe(2);
    expect(stops[0][1]).toBe(0);
    expect(stops[1][1]).toBe(1);
  });

  test('unknown gradient id leaves the shape unpainted but standing', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, {
      width: 100,
      height: 50,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { gradient: 'nope' } }],
    });
    target.remove();
    expect(ops.some((o) => o[0] === 'createLinearGradient')).toBe(false);
    expect(ops.some((o) => o[0] === 'fill')).toBe(false); // fill skipped…
    expect(ops.some((o) => o[0] === 'beginPath')).toBe(true); // …path still built
  });

  test('a stop color the real canvas would reject degrades to no paint, not a thrown render', () => {
    // The stub's addColorStop now throws like a real canvas does; resolvePaint
    // must catch it and drop just this gradient (unknown-id treatment), so the
    // rest of the drawing stands and no exception escapes renderPaintInto.
    const ops = useRecording();
    const target = mount();
    let threw: unknown = null;
    try {
      renderPaintInto(target, {
        width: 100,
        height: 50,
        shapes: [
          { type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { gradient: 'bad' } },
          { type: 'rect', x: 20, y: 0, w: 10, h: 10, fill: '#3b82f6' },
        ],
        defs: {
          gradients: [
            { id: 'bad', stops: [{ offset: 0, color: '#12345' }, { offset: 1, color: '#000' }] },
          ],
        },
      });
    } catch (err) {
      threw = err;
    }
    target.remove();
    expect(threw).toBeNull();
    // The bad gradient's own fill is skipped…
    expect(ops.some((o) => o[0] === 'createLinearGradient')).toBe(true); // attempted…
    expect(ops.filter((o) => o[0] === 'addColorStop').length).toBe(1); // stopped at the bad color
    expect(ops.some((o) => o[0] === 'fill')).toBe(true); // …the good solid shape still paints
  });

  test('every shape scope is balanced save/restore', () => {
    const ops = useRecording();
    const target = mount();
    renderPaintInto(target, {
      width: 100,
      height: 50,
      shapes: [
        { type: 'rect', x: 0, y: 0, w: 5, h: 5, fill: '#000', opacity: 0.3 },
        { type: 'text', x: 1, y: 1, text: 'x' },
        { type: 'group', children: [{ type: 'circle', cx: 1, cy: 1, r: 1, stroke: '#000' }] },
      ],
    });
    target.remove();
    const saves = ops.filter((o) => o[0] === 'save').length;
    const restores = ops.filter((o) => o[0] === 'restore').length;
    expect(saves).toBe(restores);
    expect(saves).toBeGreaterThanOrEqual(3);
  });
});

describe('renderPaintToBlob', () => {
  test('uses the injected toBlob and resolves with its blob', async () => {
    useRecording(); // the scene draw needs a 2D context to exist
    const fake = new Blob(['png'], { type: 'image/png' });
    const blob = await renderPaintToBlob(
      { ...baseSpec, background: '#fff' },
      '#fff',
      2,
      (_canvas, cb) => cb(fake),
    );
    expect(blob).toBe(fake);
  });

  test('null-background export still completes the scene draw', async () => {
    const ops = useRecording();
    await renderPaintToBlob(baseSpec, null, 1, (_c, cb) => cb(null));
    expect(ops.some((o) => o[0] === 'setTransform')).toBe(true);
    expect(ops.some((o) => o[0] === 'fillRect')).toBe(false); // no background forced
  });

  test('undefined background override lets the spec background paint (export path)', async () => {
    // exportDiagramPng passes `spec.background ? undefined : cardBg` — with a
    // spec background the override must be undefined so drawScene renders it
    // (null here would mean force-transparent and drop the art's own ground).
    const ops = useRecording();
    await renderPaintToBlob(
      { width: 50, height: 40, background: '#123456', shapes: [] },
      undefined,
      1,
      (_c, cb) => cb(null),
    );
    const fill = ops.find((o) => o[0] === 'fillRect');
    expect(fill).toBeTruthy();
    expect(ops.filter((o) => o[0] === 'fillRect').length).toBe(1); // only the background
  });
});

describe('paintCanvasToDataUrl', () => {
  test('returns the data url when the canvas supports it', () => {
    const canvas = document.createElement('canvas');
    const orig = canvas.toDataURL.bind(canvas);
    (canvas as unknown as { toDataURL: () => string }).toDataURL = () => 'data:image/png;base64,XYZ';
    expect(paintCanvasToDataUrl(canvas)).toBe('data:image/png;base64,XYZ');
    (canvas as unknown as { toDataURL: () => string }).toDataURL = orig;
  });

  test('returns empty string when toDataURL throws', () => {
    const canvas = document.createElement('canvas');
    (canvas as unknown as { toDataURL: () => string }).toDataURL = () => {
      throw new Error('no canvas');
    };
    expect(paintCanvasToDataUrl(canvas)).toBe('');
  });
});
