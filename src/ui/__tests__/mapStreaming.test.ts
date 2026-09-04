// src/ui/__tests__/mapStreaming.test.ts
// Covers the streaming-time map gate in markdown.ts: a closed ```map fence
// must (a) start hydrating immediately instead of waiting for the completed
// render, and (b) hold every later streamed block below it until the map has
// actually painted (data-map-state → preview), so text never piles up under
// a slot that is still showing its loading spinner.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { flushStreamingRender, scheduleStreamingRender } from '../markdown';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const BEFORE = '先看位置：\n\n';
const MAP = '```map\n{"center": [31.2304, 121.4737], "markers": [{"position": [31.2304, 121.4737], "title": "上海"}]}\n```\n\n';
const AFTER = '地图下面的说明文字。';

function renderOnce(container: HTMLElement, text: string): void {
  // scheduleStreamingRender's first call renders on the leading edge; later
  // calls inside the 100ms throttle window are deferred — flush forces the
  // pending diff synchronously so the assertions below run against the frame
  // the user would see on that tick.
  scheduleStreamingRender(text, container);
  flushStreamingRender(container);
}

describe('streaming map gate (diffStreaming)', () => {
  it('holds blocks below a still-loading map slot and releases them once it renders', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + MAP + AFTER);

      // The map slot mounted and is still loading: the held text after it
      // must NOT be in the DOM yet.
      const slot = container.querySelector<HTMLElement>('.map-slot');
      expect(slot).toBeTruthy();
      expect(slot!.getAttribute('data-map-state')).toBe('loading');
      expect(container.textContent).toContain('先看位置');
      expect(container.textContent).not.toContain(AFTER);

      // Simulate the tile layer's ready signal (leafletMap onTileStatus →
      // setMapState preview): the next throttled tick releases the hold.
      slot!.setAttribute('data-map-state', 'preview');
      renderOnce(container, BEFORE + MAP + AFTER + ' 完毕。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('完毕');
    } finally {
      container.remove();
    }
  });

  it('releases the hold immediately for a map that already finished or failed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + MAP);
      const slot = container.querySelector<HTMLElement>('.map-slot')!;
      // An erroring map (tile sources unavailable, bad data, …) must never
      // wedge the stream: error is a terminal gate state like preview.
      slot.setAttribute('data-map-state', 'error');
      renderOnce(container, BEFORE + MAP + AFTER);
      expect(container.textContent).toContain(AFTER);
    } finally {
      container.remove();
    }
  });
});
