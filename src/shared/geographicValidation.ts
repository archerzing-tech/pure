// src/shared/geographicValidation.ts
// Programmatic geographic validation for ```map route polylines.  Detects
// waypoints that head AWAY from the destination (bearing deviation > 90°)
// so the UI can surface a correction banner — belt-and-suspenders for the
// prompt-level plausibility review (src/shared/promptLayers.ts).

export interface GeographicViolation {
  /** Index inside the route array (1-based intermediate, never 0 or last). */
  waypointIndex: number;
  lat: number;
  lng: number;
  /** True bearing (0–360°) from previous point to this waypoint. */
  actualBearing: number;
  /** True bearing (0–360°) from previous point to the final destination. */
  expectedBearing: number;
  /** Smallest angle between actual and expected (0–180°). */
  deviation: number;
}

export interface GeographicValidationResult {
  valid: boolean;
  violations: GeographicViolation[];
  /** Haversine distance (meters) from start to destination. */
  destinationDistance: number;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Haversine distance between two WGS-84 points (meters). */
export function haversineDistance(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** True initial bearing (0–360° clockwise from north) from a to b. */
export function bearing(a: [number, number], b: [number, number]): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLng = toRad(b[1] - a[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings (0–180°). */
function angularDifference(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Validate that every intermediate waypoint in a route polyline advances
 * toward the final destination. A waypoint violates the rule when the
 * bearing from the previous point to this waypoint deviates more than
 * 90° from the bearing to the destination — i.e. it is heading away.
 *
 * Routes with fewer than 3 points (no intermediates) always pass.
 */
export function validateRoute(
  route: Array<[number, number]>,
): GeographicValidationResult {
  if (route.length < 3) {
    return { valid: true, violations: [], destinationDistance: 0 };
  }

  const start = route[0];
  const dest = route[route.length - 1];
  const destinationDistance = haversineDistance(start, dest);
  const violations: GeographicViolation[] = [];

  for (let i = 1; i < route.length - 1; i++) {
    const prev = route[i - 1];
    const curr = route[i];

    const actualBearing = bearing(prev, curr);
    const expectedBearing = bearing(prev, dest);
    const deviation = angularDifference(actualBearing, expectedBearing);

    if (deviation > 90) {
      violations.push({
        waypointIndex: i,
        lat: curr[0],
        lng: curr[1],
        actualBearing: Math.round(actualBearing * 10) / 10,
        expectedBearing: Math.round(expectedBearing * 10) / 10,
        deviation: Math.round(deviation * 10) / 10,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    destinationDistance,
  };
}

/**
 * Human-readable summary of route violations for UI banners.
 * Returns an empty string when the route is valid.
 */
export function describeViolations(
  result: GeographicValidationResult,
): string {
  if (result.valid || result.violations.length === 0) return '';
  const first = result.violations[0];
  if (result.violations.length === 1) {
    return `途经点 (${first.lat.toFixed(2)}, ${first.lng.toFixed(2)}) 偏离目的地方向 ${first.deviation}°，路线方向可能有误`;
  }
  return `${result.violations.length} 个途经点偏离目的地方向超过 90°（最大偏差 ${Math.max(...result.violations.map((v) => v.deviation))}°），路线规划可能有误`;
}
