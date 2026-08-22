import { describe, expect, it } from 'bun:test';
import {
  bearing,
  haversineDistance,
  validateRoute,
  describeViolations,
} from '../geographicValidation';

describe('bearing', () => {
  it('returns ~0° for due north', () => {
    expect(bearing([34.0, 108.0], [35.0, 108.0])).toBeCloseTo(0, 0);
  });

  it('returns ~90° for due east', () => {
    expect(bearing([34.0, 108.0], [34.0, 109.0])).toBeCloseTo(90, 0);
  });

  it('returns ~180° for due south', () => {
    expect(bearing([35.0, 108.0], [34.0, 108.0])).toBeCloseTo(180, 0);
  });

  it('returns ~270° for due west', () => {
    expect(bearing([34.0, 109.0], [34.0, 108.0])).toBeCloseTo(270, 0);
  });
});

describe('haversineDistance', () => {
  it('returns ~0 for identical points', () => {
    expect(haversineDistance([34.0, 108.0], [34.0, 108.0])).toBeCloseTo(0, 0);
  });

  it('returns ~111 km for 1° latitude difference', () => {
    const d = haversineDistance([34.0, 108.0], [35.0, 108.0]);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('validateRoute', () => {
  it('passes routes with fewer than 3 points', () => {
    const r = validateRoute([
      [34.0, 108.0],
      [31.0, 121.0],
    ]);
    expect(r.valid).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('passes a straight route (no deviation)', () => {
    const r = validateRoute([
      [34.0, 108.0],
      [33.0, 112.0],
      [31.0, 121.0],
    ]);
    expect(r.valid).toBe(true);
  });

  it('passes a route that bends but still heads toward destination', () => {
    const r = validateRoute([
      [34.0, 108.0],
      [35.0, 113.0],
      [31.0, 121.0],
    ]);
    expect(r.valid).toBe(true);
  });

  it('catches a waypoint heading west when destination is east', () => {
    // Xi'an (34.26, 108.94) → Baoji (34.37, 107.24) is WEST
    // Destination is Shanghai (31.23, 121.47) which is EAST
    const r = validateRoute([
      [34.26, 108.94],
      [34.37, 107.24],
      [31.23, 121.47],
    ]);
    expect(r.valid).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    expect(r.violations[0].deviation).toBeGreaterThan(90);
    expect(r.violations[0].waypointIndex).toBe(1);
  });

  it('catches a waypoint heading northwest when destination is southeast', () => {
    // Xi'an → Gannan (35.0, 102.9) is northwest
    // Destination is Shanghai (31.23, 121.47) which is southeast
    const r = validateRoute([
      [34.26, 108.94],
      [35.0, 102.9],
      [31.23, 121.47],
    ]);
    expect(r.valid).toBe(false);
    expect(r.violations[0].deviation).toBeGreaterThan(90);
  });

  it('reports multiple violations when several waypoints head wrong', () => {
    const r = validateRoute([
      [34.0, 108.0],
      [35.0, 104.0],
      [36.0, 100.0],
      [31.0, 121.0],
    ]);
    expect(r.valid).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag a detour that still heads roughly east', () => {
    // A slight detour north then south, but generally eastward
    const r = validateRoute([
      [34.0, 108.0],
      [35.5, 112.0],
      [31.0, 121.0],
    ]);
    expect(r.valid).toBe(true);
  });
});

describe('describeViolations', () => {
  it('returns empty string when valid', () => {
    expect(describeViolations({ valid: true, violations: [], destinationDistance: 0 })).toBe('');
  });

  it('describes a single violation', () => {
    const result = validateRoute([
      [34.26, 108.94],
      [34.37, 107.24],
      [31.23, 121.47],
    ]);
    const text = describeViolations(result);
    expect(text).toContain('偏离目的地方向');
    expect(text).toContain('°');
  });

  it('describes multiple violations', () => {
    const result = validateRoute([
      [34.0, 108.0],
      [35.0, 104.0],
      [36.0, 100.0],
      [31.0, 121.0],
    ]);
    const text = describeViolations(result);
    expect(text).toContain('个途经点');
  });
});
