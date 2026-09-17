// src/ui/__tests__/traySessions.test.ts
// Roadmap 5.3 — the tray payload builder: title passthrough, the menu-length
// cap (a runaway fleet must not turn the native menu into a scroll fest), and
// the empty case. Pure module — no DOM registration needed here.

import { describe, expect, it } from 'bun:test';
import { buildTraySessionItems } from '../traySessions';

describe('buildTraySessionItems', () => {
  it('pairs each running id with its resolved title', () => {
    const items = buildTraySessionItems(['a', 'b'], (id) => `Session ${id}`);
    expect(items).toEqual([
      { id: 'a', title: 'Session a' },
      { id: 'b', title: 'Session b' },
    ]);
  });

  it('caps the list so the native menu stays scannable', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const items = buildTraySessionItems(ids, (id) => id);
    expect(items.length).toBe(12);
    expect(items.map((it) => it.id)).toEqual(ids.slice(0, 12));
  });

  it('handles an idle fleet (and a custom cap)', () => {
    expect(buildTraySessionItems([], (id) => id)).toEqual([]);
    expect(buildTraySessionItems(['a', 'b'], (id) => id, 1)).toEqual([
      { id: 'a', title: 'a' },
    ]);
  });
});
