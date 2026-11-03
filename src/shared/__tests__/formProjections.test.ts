// src/shared/__tests__/formProjections.test.ts
// 刀 4 投影降级器的契约：三个投影器（chart 条形 / map 清单 / paint 清单）的
// 输出形态、诚实降级（解析不了 → null 回退源码，绝不产出错图）、以及与卡
// 注册表（textFallback: 'projection'）和 FENCE_ROUTES tag 的三方同源锁。
// paint 字段名用 paintSpec 的类型字面量 fixture 编译期锁定——漂移即类型红。

import { describe, expect, it } from 'bun:test';
import { FORM_PROJECTIONS, projectForm, projectionFor } from '../formProjections';
import { PRESENTATION_CARDS } from '../presentationLibrary';
import { parseMapSource } from '../mapSpec';
import type { PaintShape } from '../../ui/paintSpec';

describe('chart projection (bar / hbar / pie → ASCII bars)', () => {
  it('renders label-value rows as scaled ASCII bars with title/unit', () => {
    const out = projectForm('chart', 'type: bar\ntitle: 一季度销售\nunit: 万元\n一月 120\n二月 60\n');
    expect(out).toContain('一季度销售（万元）');
    expect(out).toMatch(/一月 \| █+ 120/);
    expect(out).toMatch(/二月 \| █+ 60/);
    // 满条值与半条值：120 的条必须比 60 的条长一倍左右。
    const full = out!.match(/一月 \| (█+)/)![1].length;
    const half = out!.match(/二月 \| (█+)/)![1].length;
    expect(half).toBe(Math.round(full / 2));
  });

  it('defaults to bar when the type: line is missing and treats pie like bars', () => {
    expect(projectForm('chart', '苹果 10\n香蕉 20')).toMatch(/香蕉 \| █+ 20/);
    expect(projectForm('chart', 'type: pie\n苹果 10\n香蕉 20')).toMatch(/苹果 \| █+ 10/);
    expect(projectForm('chart', 'type: hbar\n苹果 10')).toMatch(/苹果 \| █+ 10/);
  });

  it('returns null for trend/hierarchy types (their rows are already readable)', () => {
    expect(projectForm('chart', 'type: line\n一月 120\n二月 60')).toBeNull();
    expect(projectForm('chart', 'type: scatter\n小明 170 65')).toBeNull();
    expect(projectForm('chart', 'type: kline\n日期 开盘 收盘 最低 最高\n1-1 10 12 9 13')).toBeNull();
    expect(projectForm('chart', 'type: tree\n根\n  子 500')).toBeNull();
  });

  it('accepts the JSON payload form ({type, data:[{name,value}]})', () => {
    const payload = JSON.stringify({ type: 'bar', title: 'Q1', data: [{ name: 'a', value: 5 }, { name: 'b', value: 10 }] });
    const out = projectForm('chart', payload);
    expect(out).toContain('Q1');
    expect(out).toMatch(/b \| █+ 10/);
  });

  it('never invents a chart from junk (null, not a wrong picture)', () => {
    expect(projectForm('chart', '')).toBeNull();
    expect(projectForm('chart', 'type: bar\nno numbers here')).toBeNull();
    expect(projectForm('chart', '{ broken json')).toBeNull();
    expect(projectForm('chart', JSON.stringify({ type: 'bar' }))).toBeNull(); // 无 data
  });
});

describe('map projection (markers + route → list)', () => {
  const spec = {
    title: '西安 → 上海',
    markers: [
      { lat: 34.3416, lng: 108.9398, title: '西安', label: '起点' },
      { lat: 31.2304, lng: 121.4737, title: '上海', label: '终点' },
    ],
    route: [[34.3416, 108.9398], [35.0, 110.0], [31.2304, 121.4737]],
  };

  it('lists every marker with name, label and coordinates', () => {
    const out = projectForm('map', JSON.stringify(spec));
    expect(out).toContain('西安 → 上海');
    expect(out).toContain('● 西安（起点） — 34.3416, 108.9398');
    expect(out).toContain('● 上海（终点） — 31.2304, 121.4737');
    expect(out).toContain('route: 3 个航点');
  });

  it('parses through the SAME entry the GUI renderer uses (parseMapSource)', () => {
    // 同源：投影吃 parseMapSource 的产出——字段名/容错口径永不漂移。
    const { spec: parsed } = parseMapSource(JSON.stringify(spec));
    expect(parsed.markers).toHaveLength(2);
    expect(projectForm('map', JSON.stringify(parsed))).toContain('● 西安（起点）');
  });

  it('supports the leaflet alias and tolerates bare-marker payloads', () => {
    expect(projectForm('leaflet', JSON.stringify({ markers: [{ lat: 1, lng: 2 }] }))).toContain('● 1, 2');
  });

  it('returns null when nothing is listable (honest degradation)', () => {
    expect(projectForm('map', 'not json')).toBeNull();
    expect(projectForm('map', JSON.stringify({ title: '只有标题' }))).toBeNull();
    expect(projectForm('map', JSON.stringify({ markers: [{ lat: 999, lng: 999 }] }))).toBeNull(); // 坐标越界被 parseMapSpec 弹掉
  });
});

describe('paint projection (shapes → list)', () => {
  // 字段名编译期锁：fixture 用 PaintShape 类型书写，paintSpec 改字段名即类型红。
  const shapes: PaintShape[] = [
    { type: 'rect', x: 120, y: 40, w: 200, h: 80 },
    { type: 'text', x: 300, y: 480, text: 'MySQL', align: 'center' },
    { type: 'arrow', x1: 320, y1: 80, x2: 320, y2: 160 },
    { type: 'circle', cx: 60, cy: 60, r: 20 },
    { type: 'group', children: [{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }] },
  ];
  const payload = JSON.stringify({ version: 1, width: 720, height: 560, shapes });

  it('lists every shape with geometry; groups recurse indented', () => {
    const out = projectForm('paint', payload)!;
    expect(out).toContain('canvas 720×560');
    expect(out).toContain('- rect (120,40) 200×80');
    expect(out).toContain('- text "MySQL" @ (300,480)');
    expect(out).toContain('- arrow (320,80) → (320,160)');
    expect(out).toContain('- circle @ (60,60) r=20');
    expect(out).toContain('  - line (0,0) → (10,10)'); // group 递归带缩进
  });

  it('truncates very long shape lists with an "and N more" tail', () => {
    const many: PaintShape[] = Array.from({ length: 60 }, (_, i) => ({ type: 'rect', x: i, y: 0, w: 1, h: 1 }));
    const out = projectForm('paint', JSON.stringify({ width: 100, height: 100, shapes: many }))!;
    expect(out).toContain('…and 20 more');
    expect(out.split('\n')).toHaveLength(42); // canvas 行 + 40 条 + 尾行
  });

  it('returns null on junk / empty shapes (never a wrong list)', () => {
    expect(projectForm('paint', 'not json')).toBeNull();
    expect(projectForm('paint', JSON.stringify({ width: 10, height: 10, shapes: [] }))).toBeNull();
    expect(projectForm('paint', JSON.stringify({ shapes: 'nope' }))).toBeNull();
  });
});

describe('projection registry ↔ card table 同源锁（刀 4 三方一致）', () => {
  it('every projection-form card has a registered projector for all its fence tags', () => {
    for (const card of PRESENTATION_CARDS) {
      if (card.textFallback !== 'projection') continue;
      for (const tag of card.fence ?? []) {
        expect(FORM_PROJECTIONS[tag], `${card.id} claims projection but tag "${tag}" has no projector`).toBeDefined();
      }
    }
  });

  it('wireframe cards do not squat in the projection registry', () => {
    // mermaid/puml 的降级走 cliDiagram 线框，注册表混入 = 双头降级。
    for (const tag of ['mermaid', 'puml', 'plantuml', 'svg', 'math', 'latex', 'tex']) {
      expect(FORM_PROJECTIONS[tag], `tag "${tag}" should stay out of the projection registry`).toBeUndefined();
    }
  });

  it('projectionFor normalizes lang the same way the render layer does', () => {
    expect(projectionFor('CHART')?.name).toBe(projectionFor('chart')?.name);
    expect(projectionFor('  map extra-info')).toBeDefined();
    expect(projectionFor('zzz_no_such')).toBeUndefined();
  });
});
