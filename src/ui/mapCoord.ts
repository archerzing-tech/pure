// src/ui/mapCoord.ts
// Pure WGS-84 ↔ GCJ-02 coordinate conversion (no DOM, unit-testable in bun).
// China-native basemaps (AMap / Tencent) are rendered in GCJ-02, while the
// map DSL and the OSM / Esri / CartoDB basemaps use WGS-84. Converting at the
// boundary keeps markers and the route polyline aligned with whichever basemap
// is actually reachable. Out-of-China coordinates are returned unchanged.

const PI = Math.PI;
const SEMI_MAJOR = 6378245.0; // Krasovsky 1940 semi-major axis
const ECC2 = 0.00669342162296594323; // first eccentricity squared

/** True when the point lies outside the Chinese GCJ-02 offset region. */
export function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02 ("火星坐标"). Outside China returns the input unchanged. */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ECC2 * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((SEMI_MAJOR * (1 - ECC2)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((SEMI_MAJOR / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

/** GCJ-02 → WGS-84 (iterative inverse, <1m after two iterations). */
export function gcj02ToWgs84(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 2; i++) {
    const [gLat, gLng] = wgs84ToGcj02(wgsLat, wgsLng);
    wgsLat -= gLat - lat;
    wgsLng -= gLng - lng;
  }
  return [wgsLat, wgsLng];
}
