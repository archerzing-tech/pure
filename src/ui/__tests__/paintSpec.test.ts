// src/ui/__tests__/paintSpec.test.ts
// Pure-parser tests for the ```paint DSL — no DOM. Mirrors leafletMap.test.ts.

import { describe, test, expect } from 'bun:test';
import {
  parsePaintSource,
  parsePathD,
  PAINT_MAX_SHAPES,
  PAINT_MAX_DEPTH,
} from '../paintSpec';

const okSpec = {
  version: 1,
  width: 640,
  height: 400,
  shapes: [
    { type: 'rect', x: 40, y: 40, w: 200, h: 80, r: 8, fill: '#3b82f6' },
    { type: 'circle', cx: 400, cy: 120, r: 50, stroke: '#111', strokeWidth: 3 },
    { type: 'ellipse', cx: 550, cy: 100, rx: 40 },
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 50, stroke: '#333' },
    { type: 'arrow', x1: 240, y1: 80, x2: 340, y2: 80, stroke: '#333' },
    { type: 'path', d: 'M0,0 L100,0 C150,0 150,100 200,100 Z', fill: '#eee' },
    { type: 'polygon', points: [0, 0, 50, 0, 25, 40], fill: '#fa0' },
    { type: 'polyline', points: [0, 0, 30, 30, 60, 0], stroke: '#333', fill: 'none' },
    { type: 'text', x: 60, y: 90, text: 'API 层', color: '#111', size: 16 },
    {
      type: 'group',
      transform: { translate: [10, 10], rotate: 45, scale: 2 },
      children: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000' }],
    },
  ],
  defs: {
    gradients: [
      { id: 'g1', from: [0, 0], to: [640, 0], stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
    ],
  },
};

describe('parsePaintSource — valid specs', () => {
  test('round-trips every shape type', () => {
    const { spec, repaired } = parsePaintSource(JSON.stringify(okSpec));
    expect(repaired).toBe(false);
    expect(spec.width).toBe(640);
    expect(spec.height).toBe(400);
    expect(spec.version).toBe(1);
    expect(spec.defs?.gradients).toHaveLength(1);
    // group children + flat shapes all present
    const group = spec.shapes.find((s) => s.type === 'group') as Extract<(typeof spec.shapes)[number], { type: 'group' }>;
    expect(group.children).toHaveLength(1);
    expect(group.transform?.translate).toEqual([10, 10]);
    expect(spec.shapes.filter((s) => s.type !== 'group')).toHaveLength(9);
  });

  test('extracts title for PNG export naming', () => {
    const { spec } = parsePaintSource(JSON.stringify({ ...okSpec, title: '架构图' }));
    expect(spec.title).toBe('架构图');
  });

  test('any version value is accepted (forward-compat slot)', () => {
    const { spec } = parsePaintSource(JSON.stringify({ ...okSpec, version: 99 }));
    expect(spec.version).toBe(99);
  });

  test('gradient reference is object-form only', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { gradient: 'g1' } }],
      defs: { gradients: [{ id: 'g1', stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] }] },
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.shapes[0]).toMatchObject({ fill: { gradient: 'g1' } });
  });
});

describe('parsePaintSource — defaults and clamps', () => {
  test('missing width/height fall back to 640×400', () => {
    const { spec } = parsePaintSource(JSON.stringify({ shapes: okSpec.shapes }));
    expect(spec.width).toBe(640);
    expect(spec.height).toBe(400);
  });

  test('width/height clamp to [16, 4000]', () => {
    const tiny = parsePaintSource(JSON.stringify({ width: 1, height: 99999, shapes: okSpec.shapes }));
    expect(tiny.spec.width).toBe(16);
    expect(tiny.spec.height).toBe(4000);
  });

  test('ellipse ry defaults to undefined (renderer mirrors rx)', () => {
    const { spec } = parsePaintSource(JSON.stringify(okSpec));
    const ell = spec.shapes.find((s) => s.type === 'ellipse') as { ry?: number };
    expect(ell.ry).toBeUndefined();
  });

  test('arrow defaults head=end and headSize=10', () => {
    const { spec } = parsePaintSource(JSON.stringify(okSpec));
    const arrow = spec.shapes.find((s) => s.type === 'arrow') as { head?: string; headSize: number };
    expect(arrow.head).toBeUndefined(); // renderer treats undefined as 'end'
    expect(arrow.headSize).toBe(10);
  });

  test('opacity clamps into [0,1]; dash scalar becomes [n]', () => {
    const src = {
      width: 10,
      height: 10,
      shapes: [{ type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, stroke: '#000', opacity: 7, dash: 4 }],
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    const line = spec.shapes[0] as { opacity: number; dash: number[] };
    expect(line.opacity).toBe(1);
    expect(line.dash).toEqual([4]);
  });
});

describe('parsePaintSource — repair', () => {
  test('prose-wrapped JSON repairs and reports the badge source', () => {
    const raw = 'Here is the drawing: ' + JSON.stringify(okSpec) + ' hope it helps';
    const { spec, repaired, repairedSource } = parsePaintSource(raw);
    expect(repaired).toBe(true);
    expect(spec.shapes.length).toBeGreaterThan(0);
    expect(() => JSON.parse(repairedSource!)).not.toThrow();
  });

  test('trailing commas and single quotes repair', () => {
    const raw = `{ width: 100, height: 80, shapes: [ { type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff', }, ], }`;
    const { repaired, spec } = parsePaintSource(raw);
    expect(repaired).toBe(true);
    expect(spec.shapes[0]?.type).toBe('rect');
  });

  test('stray fences around the body are stripped without marking repaired', () => {
    const raw = '```paint\n' + JSON.stringify(okSpec) + '\n```';
    const { repaired } = parsePaintSource(raw);
    expect(repaired).toBe(false);
  });

  test('unrepairable garbage throws with the paint message', () => {
    expect(() => parsePaintSource('totally not json at all !!!')).toThrow(/paint 数据需要是一个 JSON 对象/);
  });

  test('non-object payloads throw', () => {
    expect(() => parsePaintSource('[1,2,3]')).toThrow(/JSON 对象/);
    expect(() => parsePaintSource('42')).toThrow(/JSON 对象/);
  });
});

describe('parsePaintSource — shape-level tolerance', () => {
  test('one bad shape is skipped, the rest render', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [
        { type: 'megalodon', x: 0 },
        { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
        { type: 'rect', x: 'left', y: 0, w: 10, h: 10 }, // non-numeric coords
      ],
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.shapes).toHaveLength(1);
  });

  test('all shapes invalid → throw empty', () => {
    const src = { width: 100, height: 100, shapes: [{ type: 'rect', x: 0 }] };
    expect(() => parsePaintSource(JSON.stringify(src))).toThrow(/paint 绘图内容为空/);
  });

  test('line/arrow without stroke are skipped', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [
        { type: 'line', x1: 0, y1: 0, x2: 5, y2: 5 },
        { type: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5 },
        { type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, stroke: '#000' },
      ],
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.shapes).toHaveLength(1);
  });

  test('polygon without fill or stroke is skipped; polyline needs stroke', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [
        { type: 'polygon', points: [0, 0, 10, 0, 5, 5] },
        { type: 'polyline', points: [0, 0, 10, 10] },
        { type: 'polygon', points: [0, 0, 10, 0, 5, 5], fill: '#fff' },
      ],
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.shapes).toHaveLength(1);
  });
});

describe('parsePaintSource — points', () => {
  test('accepts flat arrays and nested pairs, truncates odd tails', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [
        { type: 'polygon', points: [0, 0, 10, 0, 5, 5, 7], fill: '#fff' }, // odd tail dropped
        { type: 'polygon', points: [[0, 0], [10, 0], [5, 5]], fill: '#fff' },
        { type: 'polygon', points: '0,0 10,0 5,5', fill: '#fff' }, // string form
      ],
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.shapes).toHaveLength(3);
    expect((spec.shapes[0] as { points: number[] }).points).toEqual([0, 0, 10, 0, 5, 5]);
    expect((spec.shapes[1] as { points: number[] }).points).toEqual([0, 0, 10, 0, 5, 5]);
    expect((spec.shapes[2] as { points: number[] }).points).toEqual([0, 0, 10, 0, 5, 5]);
  });

  test('fewer than two points is unusable', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'polygon', points: [0, 0], fill: '#fff' }],
    };
    expect(() => parsePaintSource(JSON.stringify(src))).toThrow(/绘图内容为空/);
  });
});

describe('parsePaintSource — gradients', () => {
  test('gradient without stops is dropped', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }],
      defs: { gradients: [{ id: 'bad', stops: [] }] },
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.defs).toBeUndefined();
  });

  test('stops offsets clamp to [0,1]; radial keeps cx/cy/r', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }],
      defs: {
        gradients: [
          { id: 'r1', type: 'radial', cx: 50, cy: 50, r: 60, stops: [{ offset: 5, color: '#fff' }, { offset: -1, color: '#000' }] },
        ],
      },
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    const g = spec.defs!.gradients![0];
    expect(g.type).toBe('radial');
    expect(g.stops[0].offset).toBe(1);
    expect(g.stops[1].offset).toBe(0);
  });

  test('empty-string stop color is dropped (real addColorStop throws on it)', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }],
      defs: {
        gradients: [
          { id: 'g', stops: [{ offset: 0, color: '   ' }, { offset: 1, color: '#000' }] },
        ],
      },
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    // The bad stop is gone; the gradient survives on its one good stop.
    expect(spec.defs!.gradients![0].stops.length).toBe(1);
    expect(spec.defs!.gradients![0].stops[0].color).toBe('#000');
  });

  test('radial gradient with negative radius is dropped (canvas would throw)', () => {
    const src = {
      width: 100,
      height: 100,
      shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }],
      defs: {
        gradients: [
          { id: 'r', type: 'radial', cx: 0, cy: 0, r: -5, stops: [{ offset: 0, color: '#fff' }] },
        ],
      },
    };
    const { spec } = parsePaintSource(JSON.stringify(src));
    expect(spec.defs).toBeUndefined();
  });
});

describe('parsePaintSource — limits', () => {
  test('shape count truncates at PAINT_MAX_SHAPES instead of throwing', () => {
    const shapes = Array.from({ length: PAINT_MAX_SHAPES + 50 }, () => ({
      type: 'rect', x: 0, y: 0, w: 1, h: 1,
    }));
    const { spec } = parsePaintSource(JSON.stringify({ width: 100, height: 100, shapes }));
    expect(spec.shapes.length).toBeLessThanOrEqual(PAINT_MAX_SHAPES);
  });

  test('group nesting deeper than PAINT_MAX_DEPTH is cut off', () => {
    // build a chain of nested groups deeper than the limit
    let node: Record<string, unknown> = { type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#fff' };
    for (let i = 0; i <= PAINT_MAX_DEPTH + 2; i++) {
      node = { type: 'group', children: [node] };
    }
    const { spec } = parsePaintSource(JSON.stringify({ width: 100, height: 100, shapes: [node] }));
    let depth = 0;
    let cur = spec.shapes[0] as { type: string; children?: unknown[] };
    while (cur?.type === 'group') {
      depth++;
      cur = cur.children![0] as typeof cur;
    }
    expect(depth).toBeLessThanOrEqual(PAINT_MAX_DEPTH);
  });
});

describe('parsePathD', () => {
  test('absolute M/L/C/Q/Z round-trip', () => {
    const cmds = parsePathD('M0,0 L100,0 C150,0 150,100 200,100 Z')!;
    expect(cmds).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 100, y: 0 },
      { c: 'C', x1: 150, y1: 0, x2: 150, y2: 100, x: 200, y: 100 },
      { c: 'Z' },
    ]);
  });

  test('implicit repeats: M pairs become linetos', () => {
    const cmds = parsePathD('M0,0 10,10 20,0')!;
    expect(cmds).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 10, y: 10 },
      { c: 'L', x: 20, y: 0 },
    ]);
  });

  test('relative commands flatten to absolute', () => {
    const cmds = parsePathD('M10,10 l20,0 l0,20 z')!;
    expect(cmds).toEqual([
      { c: 'M', x: 10, y: 10 },
      { c: 'L', x: 30, y: 10 },
      { c: 'L', x: 30, y: 30 },
      { c: 'Z' },
    ]);
  });

  test('H/V expand to linetos (absolute and relative)', () => {
    const cmds = parsePathD('M0,0 H50 V25 h-10 v-5')!;
    expect(cmds).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 50, y: 0 },
      { c: 'L', x: 50, y: 25 },
      { c: 'L', x: 40, y: 25 },
      { c: 'L', x: 40, y: 20 },
    ]);
  });

  test('S reflects the previous C control point; T reflects Q', () => {
    const s = parsePathD('M0,0 C10,10 20,10 30,0 S50,-10 60,0')!;
    expect(s[2]).toMatchObject({ c: 'C', x1: 40, y1: -10 }); // reflection of (20,10) about (30,0)
    const t = parsePathD('M0,0 Q10,10 20,0 T40,0')!;
    expect(t[2]).toMatchObject({ c: 'Q', x1: 30, y1: -10 });
  });

  test('A command flattens to cubics ending exactly on the endpoint', () => {
    const cmds = parsePathD('M0,0 A50,50 0 0,1 100,0')!;
    expect(cmds.length).toBeGreaterThanOrEqual(3);
    expect(cmds[1].c).toBe('C');
    const last = cmds[cmds.length - 1] as { x: number; y: number };
    expect(last.x).toBe(100);
    expect(last.y).toBe(0);
  });

  test('degenerate arc radii degrade to a line', () => {
    const cmds = parsePathD('M0,0 A0,0 0 0,1 100,50')!;
    expect(cmds).toEqual([{ c: 'M', x: 0, y: 0 }, { c: 'L', x: 100, y: 50 }]);
  });

  test('implicit repeats cover H/V/S/T, not just M/L/C/Q/A', () => {
    // SVG allows trailing coordinate sets on EVERY command; dropping them
    // silently corrupts the drawing (`H10 20` would only draw to x=10).
    const h = parsePathD('M0,0 H10 20 30')!;
    expect(h.map((c) => (c as { x: number }).x)).toEqual([0, 10, 20, 30]);
    const v = parsePathD('M0,0 V5 10')!;
    expect(v.map((c) => (c as { y: number }).y)).toEqual([0, 5, 10]);
    const s = parsePathD('M0,0 C10,10 20,10 30,0 S40,-10 50,0 60,-10 70,0')!;
    expect(s.length).toBe(4); // M + C + two S curves
    expect((s[3] as { x: number }).x).toBe(70);
    const t = parsePathD('M0,0 Q10,10 20,0 T40,0 60,0')!;
    expect(t.length).toBe(4); // M + Q + two T curves
    expect((t[3] as { x: number }).x).toBe(60);
  });

  test('S after Z does not reflect a control point from before the closepath', () => {
    const cmds = parsePathD('M0,0 C10,10 20,10 30,0 Z S50,-10 60,0')!;
    // Z is the previous command now — no C/S reflection: the first control
    // point collapses onto the current point, which Z reset to the subpath
    // start (0,0) (SVG contract).
    expect(cmds[3]).toMatchObject({ c: 'C', x1: 0, y1: 0, x2: 50, y2: -10, x: 60, y: 0 });
  });

  test('arc with coincident endpoints is omitted (no phantom quarter-ellipse)', () => {
    const cmds = parsePathD('M50,50 A40,40 0 0,1 50,50 L100,50')!;
    expect(cmds).toEqual([{ c: 'M', x: 50, y: 50 }, { c: 'L', x: 100, y: 50 }]);
  });

  test('semicolon separators and run-together negatives tokenize', () => {
    const cmds = parsePathD('M0,0;L10-2.5;L20,0')!;
    expect(cmds).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 10, y: -2.5 },
      { c: 'L', x: 20, y: 0 },
    ]);
  });

  test('ungtokenizable or command-less d returns null', () => {
    expect(parsePathD('hello world')).toBeNull();
    expect(parsePathD('')).toBeNull();
    expect(parsePathD('10,20 30,40')).toBeNull(); // numbers before any command
    expect(parsePathD('M0,0 X50')).toBeNull(); // unknown command
  });

  test('a "canvas" wrapper object is unfolded, top-level keys win', () => {
    // Real-machine shape: models sometimes wrap width/height/background in a
    // "canvas" object. Without unfolding, the wrapper is silently dropped and
    // the picture renders at default size with no background.
    const wrapped = parsePaintSource(
      '{"canvas":{"width":400,"height":400,"background":"#FFF8E1"},"shapes":[{"type":"circle","cx":50,"cy":50,"r":20}]}',
    );
    expect(wrapped.spec.width).toBe(400);
    expect(wrapped.spec.height).toBe(400);
    expect(wrapped.spec.background).toBe('#FFF8E1');
    // Top-level keys beat the wrapper's.
    const mixed = parsePaintSource(
      '{"canvas":{"width":999,"height":999},"width":320,"height":200,"shapes":[{"type":"rect","x":0,"y":0,"w":1,"h":1}]}',
    );
    expect(mixed.spec.width).toBe(320);
    expect(mixed.spec.height).toBe(200);
    // A non-object "canvas" key is inert, and a well-formed spec without a
    // wrapper is unaffected.
    expect(parsePaintSource('{"canvas":"none","shapes":[{"type":"rect","x":0,"y":0,"w":1,"h":1}]}').spec.width).toBe(640);
    expect(parsePaintSource('{"width":100,"shapes":[{"type":"rect","x":0,"y":0,"w":1,"h":1}]}').spec.width).toBe(100);
  });
});
