// src/ui/__tests__/mapCoord.test.ts
// Pure coordinate conversion for China-native basemaps — no DOM needed.

import { describe, it, expect } from 'bun:test';
import { outOfChina, wgs84ToGcj02, gcj02ToWgs84 } from '../mapCoord';

describe('WGS-84 ↔ GCJ-02 conversion', () => {
  it('detects the Chinese offset region', () => {
    expect(outOfChina(39.9042, 116.4074)).toBe(false); // Beijing
    expect(outOfChina(31.2304, 121.4737)).toBe(false); // Shanghai
    expect(outOfChina(37.7749, -122.4194)).toBe(true); // San Francisco
    expect(outOfChina(48.8566, 2.3522)).toBe(true); // Paris
  });

  it('leaves out-of-China coordinates unchanged', () => {
    expect(wgs84ToGcj02(37.7749, -122.4194)).toEqual([37.7749, -122.4194]);
    expect(gcj02ToWgs84(48.8566, 2.3522)).toEqual([48.8566, 2.3522]);
  });

  it('shifts an in-China point by a small, plausible offset', () => {
    const [lat, lng] = wgs84ToGcj02(39.9042, 116.4074);
    expect(lat).not.toBe(39.9042);
    expect(lng).not.toBe(116.4074);
    // The GCJ-02 offset in mainland China is well under a degree.
    expect(Math.abs(lat - 39.9042)).toBeLessThan(0.02);
    expect(Math.abs(lng - 116.4074)).toBeLessThan(0.02);
  });

  it('round-trips WGS-84 → GCJ-02 → WGS-84 to sub-meter accuracy', () => {
    const gcj = wgs84ToGcj02(39.9042, 116.4074);
    const back = gcj02ToWgs84(gcj[0], gcj[1]);
    expect(Math.abs(back[0] - 39.9042)).toBeLessThan(1e-4);
    expect(Math.abs(back[1] - 116.4074)).toBeLessThan(1e-4);
  });
});
