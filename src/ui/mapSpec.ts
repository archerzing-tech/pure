// src/ui/mapSpec.ts
// Pure parser for ```map blocks — no leaflet import, so it is unit-testable
// headlessly in bun (leaflet itself requires window/document at import time).
// leafletMap.ts imports the types + parser from here and adds the DOM renderer.

export interface MapMarker {
  lat: number;
  lng: number;
  title?: string;
  label?: string;
}

export interface MapSpec {
  title?: string;
  center?: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  route?: Array<[number, number]>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseLatLng(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const lat = v[0];
  const lng = v[1];
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/**
 * Parse a ```map fenced block into a validated MapSpec. Accepts a bare JSON
 * object; tolerates stray ``` fences and prose around the JSON. Returns the
 * repaired source when the JSON was recovered from a fenced/prose-wrapped body
 * so the UI can show the "已自动修复" badge (same contract as chart/mermaid).
 */
export function parseMapSource(raw: string): { spec: MapSpec; repaired?: boolean; repairedSource?: string } {
  const trimmed = (raw ?? '').trim().replace(/^```(?:map|leaflet)\s*/i, '').replace(/```\s*$/g, '');
  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('map 数据需要是一个 JSON 对象（{ "markers": [...], "route": [...] }）');
    try {
      parsed = JSON.parse(match[0]);
      repaired = true;
    } catch (err) {
      throw err instanceof Error ? err : new Error('map JSON 解析失败');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('map 数据需要是一个 JSON 对象');
  }
  const obj = parsed as Record<string, unknown>;

  const spec: MapSpec = {};
  if (typeof obj.title === 'string' && obj.title.trim()) spec.title = obj.title.trim();
  if (typeof obj.zoom === 'number' && Number.isFinite(obj.zoom)) spec.zoom = obj.zoom;
  const center = parseLatLng(obj.center);
  if (center) spec.center = center;

  if (Array.isArray(obj.markers)) {
    const markers: MapMarker[] = [];
    for (const m of obj.markers) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      const ll = parseLatLng([mm.lat, mm.lng]);
      if (!ll) continue;
      markers.push({
        lat: ll[0],
        lng: ll[1],
        title: typeof mm.title === 'string' ? mm.title : undefined,
        label: typeof mm.label === 'string' ? mm.label : undefined,
      });
    }
    if (markers.length > 0) spec.markers = markers;
  }

  if (Array.isArray(obj.route)) {
    const route: Array<[number, number]> = [];
    for (const p of obj.route) {
      const ll = parseLatLng(p);
      if (ll) route.push(ll);
    }
    if (route.length >= 2) spec.route = route;
  }

  if (!spec.markers && !spec.route && !spec.center) {
    throw new Error('map 数据缺少可渲染内容（需要 markers、route 或 center）');
  }
  return { spec, repaired, repairedSource: repaired ? trimmed : undefined };
}
