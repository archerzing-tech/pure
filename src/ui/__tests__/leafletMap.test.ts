// src/ui/__tests__/leafletMap.test.ts
// Covers parseMapSource — the pure JSON parser for ```map blocks (no DOM, no
// leaflet instance needed, so it runs headlessly in bun).

import { describe, it, expect } from 'bun:test';
import { parseMapSource } from '../mapSpec';

describe('parseMapSource', () => {
  it('parses a full map spec with markers and a route', () => {
    const { spec } = parseMapSource(JSON.stringify({
      title: '西安 → 上海',
      center: [34.3416, 108.9398],
      zoom: 6,
      markers: [
        { lat: 34.3416, lng: 108.9398, title: '西安', label: '起点' },
        { lat: 31.2304, lng: 121.4737, title: '上海', label: '终点' },
      ],
      route: [[34.3416, 108.9398], [31.2304, 121.4737]],
    }));
    expect(spec.title).toBe('西安 → 上海');
    expect(spec.center).toEqual([34.3416, 108.9398]);
    expect(spec.zoom).toBe(6);
    expect(spec.markers).toHaveLength(2);
    expect(spec.markers![0]).toMatchObject({ lat: 34.3416, lng: 108.9398, label: '起点' });
    expect(spec.route).toHaveLength(2);
  });

  it('tolerates a clean fenced block without marking it repaired', () => {
    const { spec, repaired } = parseMapSource(
      '```map\n{"markers":[{"lat":1,"lng":2,"title":"A"}]}\n```',
    );
    expect(repaired).toBe(false);
    expect(spec.markers).toHaveLength(1);
  });

  it('recovers a JSON object wrapped in prose', () => {
    const { spec, repaired } = parseMapSource(
      '路线如下：\n{"route": [[0, 0], [1, 1]]}\n请查看。',
    );
    expect(repaired).toBe(true);
    expect(spec.route).toEqual([[0, 0], [1, 1]]);
  });

  it('recovers JSON preceded by a // comment line', () => {
    const { spec, repaired } = parseMapSource(
      '// 酒泉骑行路线\n{"markers":[{"lat":39.73,"lng":98.49,"title":"酒泉"}]}',
    );
    expect(repaired).toBe(true);
    expect(spec.markers).toHaveLength(1);
    expect(spec.markers![0].title).toBe('酒泉');
  });

  it('recovers JSON with inline // comments', () => {
    const { spec, repaired } = parseMapSource(
      '{\n  "title": "骑行去酒泉", // 标题\n  "route": [[39.73, 98.49], [39.73, 98.5]] // 路线\n}',
    );
    expect(repaired).toBe(true);
    expect(spec.title).toBe('骑行去酒泉');
    expect(spec.route).toHaveLength(2);
  });

  it('fails with a friendly error (not a raw JSON parse error) for unrepairable input', () => {
    expect(() => parseMapSource('// just a comment, no JSON')).toThrow('map 数据需要是一个 JSON 对象');
    expect(() => parseMapSource('/not/json')).toThrow('map 数据需要是一个 JSON 对象');
  });

  it('drops invalid markers and route points instead of failing', () => {
    const { spec } = parseMapSource(JSON.stringify({
      markers: [
        { lat: 34, lng: 108, title: 'ok' },
        { lat: 'bad', lng: 999, title: 'invalid' },
        { lat: 200, lng: 0, title: 'out of range' },
      ],
      route: [[34, 108], ['x', 'y'], [31, 121]],
    }));
    expect(spec.markers).toHaveLength(1);
    expect(spec.markers![0].title).toBe('ok');
    // only the two valid lat/lng pairs remain
    expect(spec.route).toEqual([[34, 108], [31, 121]]);
  });

  it('throws when the payload is not a JSON object with renderable content', () => {
    expect(() => parseMapSource('[]')).toThrow();
    expect(() => parseMapSource('"hello"')).toThrow();
    expect(() => parseMapSource('{"title":"only a title"}')).toThrow();
    expect(() => parseMapSource('not json at all')).toThrow();
  });

  it('attaches routeWarnings when a waypoint heads away from destination', () => {
    // Xi'an → Baoji (west) when destination is Shanghai (east)
    const { spec } = parseMapSource(JSON.stringify({
      title: '西安 → 上海',
      route: [
        [34.26, 108.94],
        [34.37, 107.24],
        [31.23, 121.47],
      ],
    }));
    expect(spec.routeWarnings).toBeDefined();
    expect(spec.routeWarnings!.length).toBeGreaterThanOrEqual(1);
    expect(spec.routeWarnings![0].waypointIndex).toBe(1);
    expect(spec.routeWarnings![0].deviation).toBeGreaterThan(90);
    expect(spec.routeWarningText).toContain('偏离目的地方向');
  });

  it('leaves routeWarnings absent when route is valid', () => {
    const { spec } = parseMapSource(JSON.stringify({
      route: [
        [34.34, 108.94],
        [33.5, 114.0],
        [31.23, 121.47],
      ],
    }));
    expect(spec.routeWarnings).toBeUndefined();
    expect(spec.routeWarningText).toBeUndefined();
  });
});
