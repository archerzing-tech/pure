// src/ui/leafletMap.ts
// Leaflet renderer for ```map blocks. This module is the ONLY place leaflet is
// imported, and it is loaded lazily (dynamic import from markdown.ts) so the
// ~150KB leaflet chunk never touches startup. Leaflet itself is bundled by Vite
// from node_modules — the library is local, never fetched from a CDN.
//
// parseMapSource() is pure (no DOM, no leaflet instance) so it is unit-testable
// in bun; renderMapInto() owns the map instance lifecycle (dispose on re-render,
// ResizeObserver so sidebar toggles / window resizes re-fit the map). Tiles come
// from a reachability chain: the first source that serves a tile wins, and
// markers / the route are re-projected to match a GCJ-02 source (AMap/Tencent).

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseMapSource, type MapMarker, type MapSpec } from './mapSpec';
import { gcj02ToWgs84, wgs84ToGcj02 } from './mapCoord';
import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { t } from '../shared/i18n';

export { parseMapSource };
export type { MapMarker, MapSpec };


// Track live map instances per canvas so re-render disposes cleanly and the
// ResizeObserver never leaks across bubbles.
const mapInstances = new WeakMap<HTMLElement, { map: L.Map; observer: ResizeObserver | null; tileTimer: ReturnType<typeof setTimeout> | null }>();

const PIN_HTML = (label: string): string =>
  `<div class="map-pin">${label ? `<span class="map-pin-label">${escapeHtml(label)}</span>` : ''}` +
  `<svg width="28" height="36" viewBox="0 0 28 36" fill="none" aria-hidden="true">` +
  `<path d="M14 1C7.4 1 2 6.4 2 13c0 9 12 22 12 22s12-13 12-22C26 6.4 20.6 1 14 1z" fill="#ef4444" stroke="#fff" stroke-width="1.5"/>` +
  `<circle cx="14" cy="13" r="4.5" fill="#fff"/></svg></div>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

/** Popup body for a marker — title/label when present, coordinates always. */
function markerPopupContent(m: MapMarker): string {
  const title = m.title?.trim();
  const label = m.label?.trim();
  const heading = title || label || '';
  const secondary = title && label && label !== title ? label : '';
  const coords = `<div class="map-popup-coords">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>`;
  const parts: string[] = [];
  if (heading) parts.push(`<strong>${escapeHtml(heading)}</strong>`);
  if (secondary) parts.push(`<div class="map-pin-popup-label">${escapeHtml(secondary)}</div>`);
  parts.push(coords);
  return parts.join('');
}

/** Popup body for an arbitrary clicked spot on the map. */
function coordPopupContent(lat: number, lng: number): string {
  return `<div class="map-popup-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
}

// ── Tile source chain ──
// Ordered reachability chain for the basemap. China-native sources come first
// for the app's primary dashboard use case, followed by global providers. OSM's
// volunteer-run tile server is intentionally not used: its public policy does
// not permit this application's tile traffic. Each tile tries the sources in
// order and the first one to load becomes active for the whole map.
interface TileSource {
  label: string;
  template: string;
  subdomains: string;
  gcj02: boolean;
  requiresKey?: boolean;
}

const TILE_SOURCES: TileSource[] = [
  { label: 'tianditu', template: 'https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}', subdomains: '01234567', gcj02: false, requiresKey: true },
  { label: 'amap-standard', template: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}', subdomains: '1234', gcj02: true },
  { label: 'amap', template: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', subdomains: '1234', gcj02: true },
  { label: 'tencent', template: 'https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=3&version=115', subdomains: '0123', gcj02: true },
  { label: 'esri', template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', subdomains: '', gcj02: false },
  { label: 'carto', template: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', subdomains: 'abcd', gcj02: false },
];

const MEMORY_TILE_CACHE_MAX = 600;

function resolveTileUrl(source: TileSource, coords: L.Coords, key = ''): string {
  const s = source.subdomains
    ? source.subdomains[Math.abs(coords.x + coords.y) % source.subdomains.length]
    : '';
  return source.template
    .replace('{s}', s)
    .replace('{key}', encodeURIComponent(key))
    .replace('{z}', String(coords.z))
    .replace('{x}', String(coords.x))
    .replace('{y}', String(coords.y));
}

interface MarkerGroup {
  points: MapMarker[];
  center: [number, number];
}

function groupMarkers(markers: MapMarker[]): MarkerGroup[] {
  if (markers.length <= 80) return markers.map((point) => ({ points: [point], center: [point.lat, point.lng] }));
  const buckets = new Map<string, MapMarker[]>();
  for (const point of markers) {
    const key = `${Math.floor(point.lat * 4)}:${Math.floor(point.lng * 4)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(point);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).map((points) => ({
    points,
    center: [
      points.reduce((sum, point) => sum + point.lat, 0) / points.length,
      points.reduce((sum, point) => sum + point.lng, 0) / points.length,
    ],
  }));
}

// Session-memory tile cache (data URLs): a fast path above the Rust disk cache
// so panning back over already-seen tiles never re-hits IPC or the network.
const tileMemoryCache = new Map<string, string>();

function cacheTileDataUrl(url: string, dataUrl: string): void {
  tileMemoryCache.delete(url);
  tileMemoryCache.set(url, dataUrl);
  while (tileMemoryCache.size > MEMORY_TILE_CACHE_MAX) {
    const oldest = tileMemoryCache.keys().next().value as string;
    tileMemoryCache.delete(oldest);
  }
}

interface TileFetchConfig {
  proxyUrl: string;
  maxBytes: number;
  tileKey: string;
}

interface TileConfigResolvers {
  loadConfig: () => import('./config').PureConfig | null;
  defaultMapTileCacheMB: number;
  effectiveProxyUrl: typeof import('../shared/proxy').effectiveProxyUrl;
}

let tileConfigResolvers: TileConfigResolvers | undefined;

/** Resolve the app's tool proxy + tile cache budget. The dynamic imports (and
 * therefore the proxy URL) are resolved once per session, but the cache cap is
 * re-read from config on EVERY call so a Settings → General change takes effect
 * on the next tile load — no session reload or page refresh needed. */
async function resolveTileConfig(): Promise<TileFetchConfig> {
  if (!tileConfigResolvers) {
    try {
      const [{ loadConfig, DEFAULT_MAP_TILE_CACHE_MB }, { effectiveProxyUrl }] = await Promise.all([
        import('./config'),
        import('../shared/proxy'),
      ]);
      tileConfigResolvers = {
        loadConfig,
        defaultMapTileCacheMB: DEFAULT_MAP_TILE_CACHE_MB,
        effectiveProxyUrl,
      };
    } catch {
      tileConfigResolvers = {
        loadConfig: () => null,
        defaultMapTileCacheMB: 200,
        effectiveProxyUrl: () => '',
      };
    }
  }
  const cfg = tileConfigResolvers.loadConfig();
  return {
    proxyUrl: cfg?.proxy ? tileConfigResolvers.effectiveProxyUrl(cfg.proxy, 'tools') : '',
    maxBytes: (cfg?.mapTileCacheMB ?? tileConfigResolvers.defaultMapTileCacheMB) * 1024 * 1024,
    tileKey: cfg?.mapTileKey?.trim() ?? '',
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('tile read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Load one tile as a data URL. In the Tauri app the Rust backend serves it
 * from the disk cache (~/.pure/cache/map-tiles) or fetches + caches it, which
 * is what makes already-viewed areas available offline. Plain web dev falls
 * back to a direct CORS fetch. */
async function loadTile(url: string): Promise<string> {
  if (isTauriRuntime()) {
    const { proxyUrl, maxBytes } = await resolveTileConfig();
    const payload = await tauriInvoke<{ data: string; mime: string } | string>('fetch_map_tile', { url, proxyUrl, maxBytes });
    if (typeof payload === 'string') return `data:image/png;base64,${payload}`;
    return `data:${payload.mime || 'image/png'};base64,${payload.data}`;
  }
  const resp = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return blobToDataUrl(await resp.blob());
}

/** A tile layer that walks TILE_SOURCES in order until a tile loads, then
 * sticks with that source. Each fetch is bounded by the backend's 8s timeout
 * so a hung/geo-blocked source can't stall the fallback chain. */
class ChainedTileLayer extends L.TileLayer {
  private sources: TileSource[];
  private active = 0;
  private onChange: ((source: TileSource) => void) | null = null;
  private onTileReady: (() => void) | null = null;

  constructor(sources: TileSource[], options: L.TileLayerOptions) {
    super(sources[0].template, options);
    this.sources = sources;
  }

  setSourceChangeHandler(fn: (source: TileSource) => void): void {
    this.onChange = fn;
  }

  setTileReadyHandler(fn: () => void): void {
    this.onTileReady = fn;
  }

  protected createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    const attempt = (index: number): void => {
      if (index >= this.sources.length) {
        done(new Error('all tile sources unavailable'), img);
        return;
      }
      const source = this.sources[index];
      const load = (key: string): void => {
        const url = resolveTileUrl(source, coords, key);
        const settle = (err?: Error): void => {
        if (err) {
          attempt(index + 1);
          return;
        }
        if (index !== this.active) {
          this.active = index;
          this.onChange?.(source);
          }
          this.onTileReady?.();
          done(undefined, img);
        };
        const cached = tileMemoryCache.get(url);
        if (cached) {
          img.onload = () => settle();
          img.onerror = () => settle(new Error('cached tile failed'));
          img.src = cached;
          return;
        }
        loadTile(url)
          .then((dataUrl) => {
            cacheTileDataUrl(url, dataUrl);
            img.onload = () => settle();
            img.onerror = () => settle(new Error('tile failed'));
            img.src = dataUrl;
          })
          .catch(() => attempt(index + 1));
      };
      if (!source.requiresKey) {
        load('');
        return;
      }
      void resolveTileConfig()
        .then(({ tileKey }) => tileKey ? load(tileKey) : attempt(index + 1))
        .catch(() => attempt(index + 1));
    };
    attempt(this.active);
    return img;
  }
}

/** Options for renderMapInto. The inline transcript card is a STATIC preview
 * (no drag / zoom / popups); the fullscreen lightbox passes interactive: true
 * so the user can pan, zoom, and tap markers/spots. */
export interface RenderMapOptions {
  interactive?: boolean;
  onTileStatus?: (status: 'loading' | 'ready' | 'error', message?: string) => void;
}

/**
 * Render a Leaflet map (markers + route polyline) into `target`. Disposes any
 * previous map on the same target; a ResizeObserver keeps the tile view in sync
 * with the container (sidebar collapse, window resize). The basemap source is
 * chosen from the reachability chain and overlays are re-projected to GCJ-02
 * when a China-native source ends up serving the tiles.
 */
export function renderMapInto(target: HTMLElement, spec: MapSpec, options: RenderMapOptions = {}): void {
  const interactive = options.interactive === true;
  const existing = mapInstances.get(target);
  if (existing) {
    existing.observer?.disconnect();
    if (existing.tileTimer !== null) clearTimeout(existing.tileTimer);
    existing.map.remove();
    mapInstances.delete(target);
  }

  const map = L.map(target, {
    scrollWheelZoom: interactive,
    dragging: interactive,
    touchZoom: interactive,
    doubleClickZoom: interactive,
    boxZoom: interactive,
    keyboard: interactive,
    tapHold: interactive,
    zoomControl: interactive,
    // No Leaflet logo / attribution control: the map card stays clean.
    attributionControl: false,
    preferCanvas: true,
  });

  const overlays = L.layerGroup().addTo(map);
  let gcj02 = false;

  const project = (lat: number, lng: number): [number, number] =>
    gcj02 ? wgs84ToGcj02(lat, lng) : [lat, lng];

  function fit(points: L.LatLngExpression[]): void {
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48] });
    } else if (spec.center) {
      const [cLat, cLng] = project(spec.center[0], spec.center[1]);
      map.setView([cLat, cLng], spec.zoom ?? 6);
    } else {
      map.setView([35.0, 105.0], 4);
    }
  }

  function renderOverlays(): void {
    overlays.clearLayers();
    const points: L.LatLngExpression[] = [];
    for (const group of groupMarkers(spec.markers ?? [])) {
      const [lat, lng] = project(group.center[0], group.center[1]);
      points.push(...group.points.map((point) => project(point.lat, point.lng)));
      const isCluster = group.points.length > 1;
      const first = group.points[0];
      const label = first.label ?? first.title ?? '';
      const icon = isCluster
        ? L.divIcon({
            className: 'map-cluster-wrap',
            html: `<div class="map-cluster">${group.points.length}</div>`,
            iconSize: [38, 38],
            iconAnchor: [19, 19],
          })
        : L.divIcon({
            className: 'map-pin-wrap',
            html: PIN_HTML(label),
            iconSize: [28, 36],
            iconAnchor: [14, 34],
            popupAnchor: [0, -34],
          });
      const marker = L.marker([lat, lng], { icon });
      if (interactive) {
        if (isCluster) {
          marker.on('click', () => map.setView([lat, lng], Math.min(map.getZoom() + 2, 18)));
        } else {
          marker.bindPopup(markerPopupContent(first));
        }
      }
      marker.addTo(overlays);
    }
    if (spec.route && spec.route.length >= 2) {
      const route = spec.route.map((p) => {
        const [lat, lng] = project(p[0], p[1]);
        return [lat, lng] as [number, number];
      });
      points.push(...route);
      L.polyline(route, {
        color: '#3b82f6',
        renderer: L.canvas(),
        weight: 4,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(overlays);
    }
    fit(points);
  }

  // maxNativeZoom caps real tile requests at 18 so zooming in past a China
  // basemap's native ceiling over-zooms its last zoom level instead of blanking.
  let tileReady = false;
  let tileTimer: ReturnType<typeof setTimeout> | null = null;
  const markTileReady = (): void => {
    if (tileReady) return;
    tileReady = true;
    if (tileTimer !== null) clearTimeout(tileTimer);
    tileTimer = null;
    options.onTileStatus?.('ready');
  };
  const tiles = new ChainedTileLayer(TILE_SOURCES, { maxZoom: 19, maxNativeZoom: 18 });
  tiles.setTileReadyHandler(markTileReady);
  tiles.setSourceChangeHandler((source) => {
    if (source.gcj02 !== gcj02) {
      gcj02 = source.gcj02;
      renderOverlays();
    }
  });
  tiles.addTo(map);
  options.onTileStatus?.('loading');
  tileTimer = setTimeout(() => {
    tileTimer = null;
    if (!tileReady) options.onTileStatus?.('error', t('map.tileLoadFailed'));
  }, 12000);

  renderOverlays();

  // Click anywhere on the basemap to open a popup with that spot's coordinates
  // (reported back in WGS-84 even when the basemap is GCJ-02). Only wired in
  // the interactive lightbox — the inline card is a static preview.
  if (interactive) {
    map.on('click', (e: L.LeafletMouseEvent) => {
      const [lat, lng] = gcj02
        ? gcj02ToWgs84(e.latlng.lat, e.latlng.lng)
        : [e.latlng.lat, e.latlng.lng];
      L.popup().setLatLng(e.latlng).setContent(coordPopupContent(lat, lng)).openOn(map);
    });

    // Scale bar (bottom-left, metric only) + a live zoom readout (bottom-right)
    // so the user can judge real distances while panning/zooming the lightbox.
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 140 }).addTo(map);
    const zoomControl = new L.Control({ position: 'bottomright' });
    zoomControl.onAdd = (): HTMLElement => {
      const el = L.DomUtil.create('div', 'map-zoom-level');
      el.textContent = `z${map.getZoom()}`;
      map.on('zoom zoomend', () => {
        el.textContent = `z${map.getZoom()}`;
      });
      return el;
    };
    zoomControl.addTo(map);

    // Cursor coordinate display: a floating label follows the mouse so the
    // user can read lat / lng without clicking.
    const cursorCoords = L.DomUtil.create('div', 'map-cursor-coords');
    target.appendChild(cursorCoords);
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const [lat, lng] = gcj02
        ? gcj02ToWgs84(e.latlng.lat, e.latlng.lng)
        : [e.latlng.lat, e.latlng.lng];
      cursorCoords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      cursorCoords.style.left = `${e.containerPoint.x + 14}px`;
      cursorCoords.style.top = `${e.containerPoint.y + 14}px`;
      cursorCoords.style.display = '';
    });
    map.on('mouseout', () => {
      cursorCoords.style.display = 'none';
    });
  }

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(target);
  }
  mapInstances.set(target, { map, observer, tileTimer });
}

/** Dispose any live map on a canvas (used when a bubble is removed). */
export function disposeMap(target: HTMLElement): void {
  const existing = mapInstances.get(target);
  if (!existing) return;
  existing.observer?.disconnect();
  if (existing.tileTimer !== null) clearTimeout(existing.tileTimer);
  existing.map.remove();
  mapInstances.delete(target);
}

export function clearMapTileMemoryCache(): void {
  tileMemoryCache.clear();
}

/** Open a fullscreen lightbox with an INTERACTIVE copy of the map. The inline
 * transcript card stays a static preview; this is where the user can pan, zoom,
 * and tap markers / spots. Esc, the ✕ button, or a backdrop click closes it. */
export function openMapLightbox(spec: MapSpec): void {
  const overlay = document.createElement('div');
  overlay.className = 'map-lightbox';

  const header = document.createElement('div');
  header.className = 'map-lightbox-header';
  const heading = document.createElement('span');
  heading.className = 'map-lightbox-title';
  heading.textContent = spec.title?.trim() || t('map.title');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'map-lightbox-close';
  closeBtn.setAttribute('aria-label', t('map.close'));
  closeBtn.textContent = '✕';
  header.append(heading, closeBtn);

  const canvas = document.createElement('div');
  canvas.className = 'map-lightbox-canvas';

  overlay.append(header, canvas);
  document.body.appendChild(overlay);

  renderMapInto(canvas, spec, { interactive: true });

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    disposeMap(canvas);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
}
