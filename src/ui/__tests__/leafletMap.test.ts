// src/ui/__tests__/leafletMap.test.ts
// Covers parseMapSource — the pure JSON parser for ```map blocks (no DOM, no
// leaflet instance needed, so it runs headlessly in bun).

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseMapSource } from '../mapSpec';

const leafletSource = readFileSync(new URL('../leafletMap.ts', import.meta.url), 'utf8');

describe('map tile delivery chain', () => {
  it('keeps domestic sources ahead of global fallbacks and avoids OSM volunteer tiles', () => {
    expect(leafletSource).toContain("label: 'tianditu'");
    expect(leafletSource).toContain('tianditu.gov.cn/vec_w/wmts');
    expect(leafletSource).toContain("label: 'amap-standard'");
    expect(leafletSource).toContain('style=7');
    expect(leafletSource).toContain("label: 'amap'");
    expect(leafletSource).toContain("label: 'tencent'");
    expect(leafletSource).toContain("label: 'esri'");
    expect(leafletSource).toContain("label: 'carto'");
    expect(leafletSource).toContain('preferCanvas: true');
    expect(leafletSource).toContain('groupMarkers');
    expect(leafletSource).not.toContain('openstreetmap.org');
  });
});

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

// 审计批 4②：转写卡片地图从不 map.remove()（echarts 有脱离回收器，Leaflet
// 这边漏了），会话切换 innerHTML='' 时整张卡连同活地图一起被丢出 DOM。
// 收口形状：mapInstances 是 WeakMap 不可枚举，只能在三个**真丢弃**路径
// （forgetSession / 转写清空 / 会话重建前）按类名扫描子树回收；切换会话的
// 摘挂不在列——暖重挂要原样交互，地图必须活过挂载周期。
describe('live-map disposal on true-discard paths (审计批 4②)', () => {
  it('disposeMapsUnder scans the subtree by canvas class instead of enumerating the WeakMap', () => {
    expect(leafletSource).toContain(".querySelectorAll<HTMLElement>('.map-canvas, .map-lightbox-canvas')");
    expect(leafletSource).not.toContain('mapInstances.keys()');
  });

  it('chat.ts disposes maps in forgetSession and on transcript clear, via the lazy import', () => {
    const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    // 两处真丢弃点都要挂；且必须走动态 import——leafletMap 顶层 eager 加载
    // leaflet，chat 模块不许被它拖累。
    const forgetBlock = chatSource.slice(chatSource.indexOf('forgetSession(sessionId: string)'));
    expect(forgetBlock).toContain("import('./leafletMap')");
    expect(forgetBlock).toContain('disposeMapsUnder');
    expect(chatSource).toContain("import('./leafletMap')");
  });

  it('transcript clear collects canvases BEFORE the innerHTML wipe (异步回收扫的是清空后的子树，必空)', () => {
    const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    const collect = chatSource.indexOf("const canvases = [...transcript.querySelectorAll<HTMLElement>('.map-canvas, .map-lightbox-canvas')]");
    const wipe = chatSource.indexOf("transcript.innerHTML = ''");
    expect(collect).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(collect); // 收册在清空之前——顺序即正确性
    expect(chatSource).toContain('m.disposeCanvases(canvases)');
  });

  it('main.ts collects canvases before its wipe and registers the reap guard', () => {
    const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    const collect = mainSource.indexOf("const canvases = [...chatEl.querySelectorAll<HTMLElement>('.map-canvas, .map-lightbox-canvas')]");
    const wipe = mainSource.indexOf('chatEl.innerHTML = \'\'');
    expect(collect).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(collect);
    expect(mainSource).toContain('m.disposeCanvases(canvases)');
    expect(mainSource).toContain('onReapGuard'); // 冷会话回收的队列否决（批 4①）
  });
});

describe('lightbox ownership (审计批 4②补)', () => {
  it('forgetSession force-closes the body-mounted lightbox (宿主子树罩不到它)', () => {
    const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    const forgetBlock = chatSource.slice(chatSource.indexOf('forgetSession(sessionId: string)'));
    expect(forgetBlock).toContain('.map-lightbox');
    expect(forgetBlock).toContain('closeMapLightbox');
    // 必须走 ✕ click 复用 close() 全链，不许旁写清理。
    const leafletSource2 = readFileSync(new URL('../leafletMap.ts', import.meta.url), 'utf8');
    const closeFn = leafletSource2.slice(leafletSource2.indexOf('export function closeMapLightbox'));
    expect(closeFn).toContain("map-lightbox-close')?.click()");
  });
});
