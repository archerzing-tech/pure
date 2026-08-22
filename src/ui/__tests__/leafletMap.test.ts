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
});
