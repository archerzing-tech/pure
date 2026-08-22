// src/ui/leafletMap.ts
// Leaflet + OpenStreetMap renderer for ```map blocks. This module is the ONLY
// place leaflet is imported, and it is loaded lazily (dynamic import from
// markdown.ts) so the ~150KB leaflet chunk never touches startup.
//
// parseMapSource() is pure (no DOM, no leaflet instance) so it is unit-testable
// in bun; renderMapInto() owns the map instance lifecycle (dispose on re-render,
// ResizeObserver so sidebar toggles / window resizes re-fit the map).

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { parseMapSource, type MapMarker, type MapSpec } from './mapSpec';

export { parseMapSource };
export type { MapMarker, MapSpec };


// Track live map instances per canvas so re-render disposes cleanly and the
// ResizeObserver never leaks across bubbles.
const mapInstances = new WeakMap<HTMLElement, { map: L.Map; observer: ResizeObserver | null }>();

const PIN_HTML = (label: string): string =>
  `<div class="map-pin">${label ? `<span class="map-pin-label">${escapeHtml(label)}</span>` : ''}` +
  `<svg width="28" height="36" viewBox="0 0 28 36" fill="none" aria-hidden="true">` +
  `<path d="M14 1C7.4 1 2 6.4 2 13c0 9 12 22 12 22s12-13 12-22C26 6.4 20.6 1 14 1z" fill="#ef4444" stroke="#fff" stroke-width="1.5"/>` +
  `<circle cx="14" cy="13" r="4.5" fill="#fff"/></svg></div>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render a Leaflet map (OpenStreetMap tiles) with markers + route polyline into
 * `target`. Disposes any previous map on the same target; a ResizeObserver keeps
 * the tile view in sync with the container (sidebar collapse, window resize).
 */
export function renderMapInto(target: HTMLElement, spec: MapSpec): void {
  const existing = mapInstances.get(target);
  if (existing) {
    existing.observer?.disconnect();
    existing.map.remove();
    mapInstances.delete(target);
  }

  const map = L.map(target, {
    scrollWheelZoom: false,
    attributionControl: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

  const points: L.LatLngExpression[] = [];

  for (const m of spec.markers ?? []) {
    const ll: [number, number] = [m.lat, m.lng];
    points.push(ll);
    const label = m.label ?? m.title ?? '';
    const icon = L.divIcon({
      className: 'map-pin-wrap',
      html: PIN_HTML(label),
      iconSize: [28, 36],
      iconAnchor: [14, 34],
      popupAnchor: [0, -34],
    });
    const marker = L.marker(ll, { icon });
    if (m.title || m.label) {
      marker.bindPopup(
        `<strong>${escapeHtml(m.title ?? m.label ?? '')}</strong>` +
        (m.title && m.label && m.title !== m.label ? `<div class="map-pin-popup-label">${escapeHtml(m.label)}</div>` : ''),
      );
    }
    marker.addTo(map);
  }

  if (spec.route && spec.route.length >= 2) {
    const route = spec.route.map((p) => [p[0], p[1]] as [number, number]);
    points.push(...route);
    L.polyline(route, {
      color: '#3b82f6',
      weight: 4,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  }

  if (points.length > 0) {
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48] });
  } else if (spec.center) {
    map.setView(spec.center, spec.zoom ?? 6);
  } else {
    map.setView([35.0, 105.0], 4);
  }

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(target);
  }
  mapInstances.set(target, { map, observer });
}

/** Dispose any live map on a canvas (used when a bubble is removed). */
export function disposeMap(target: HTMLElement): void {
  const existing = mapInstances.get(target);
  if (!existing) return;
  existing.observer?.disconnect();
  existing.map.remove();
  mapInstances.delete(target);
}
