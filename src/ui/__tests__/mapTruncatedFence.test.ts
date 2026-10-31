// src/ui/__tests__/mapTruncatedFence.test.ts
// Settled-render tail hygiene (stripUnterminatedSlotFences): a turn
// interrupted mid-```map-fence leaves the persisted text ending INSIDE the
// fence; parsing that half payload used to mount a map slot whose parse
// error card could never be dismissed (retry re-parses the same broken raw —
// the 骑行郑州 live case). Now the unterminated slot fence is truncated from
// its opening line before the pipeline sees it. Every settled render
// (completed / interrupted / replay) funnels through renderMarkdown, so the
// tests exercise that entry point end to end.

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Same rationale as mapStreaming.test.ts: pass-through sanitize, trusted
// fixtures.
mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

const { renderMarkdown } = await import('../markdown');

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const BEFORE = '先看这段路的安排：\n\n';
// 半截 map fence：JSON 停在中途，没有任何闭合围栏（真机判例的形状）。
const TRUNCATED_MAP = '```map\n{"center": [34.746, 113.625], "markers": [{"position": [34.746';
const FULL_MAP = '```map\n{"center": [34.746, 113.625], "markers": [{"position": [34.746, 113.625], "title": "郑州"}]}\n```\n\n';

describe('settled-render tail hygiene (truncated slot fences)', () => {
  it('drops an unterminated ```map fence without mounting a slot; the prose above survives', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      await renderMarkdown(BEFORE + TRUNCATED_MAP, container, { yieldBeforeParse: false });
      // 旧链在这里挂出 parse 错误卡（.map-error）——现在半截数据根本不进管线。
      expect(container.querySelector('.map-slot')).toBeNull();
      expect(container.querySelector('.map-error')).toBeNull();
      expect(container.textContent).toContain('先看这段路的安排');
      // 围栏内容整体不可见：既没有源码视图也没有 JSON 残片。
      expect(container.textContent).not.toContain('"center"');
    } finally {
      container.remove();
    }
  });

  it('leaves one honest line when the message is nothing but the broken fence', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      await renderMarkdown(TRUNCATED_MAP, container, { yieldBeforeParse: false });
      expect(container.querySelector('.map-slot')).toBeNull();
      // 空气泡比错误卡更让人困惑——留一行真话（zh-CN 默认语言）。
      expect(container.textContent).toContain('生成在数据块中途被打断');
    } finally {
      container.remove();
    }
  });

  it('keeps a complete ```map fence intact — the hygiene only fires on unterminated tails', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      await renderMarkdown(BEFORE + FULL_MAP + '后面的文字。', container, { yieldBeforeParse: false });
      const slot = container.querySelector<HTMLElement>('.map-slot');
      expect(slot).toBeTruthy();
      expect(slot!.getAttribute('data-map-state')).toBe('loading');
      expect(container.textContent).toContain('后面的文字');
    } finally {
      container.remove();
    }
  });

  it('leaves plain unterminated code fences alone — a half code block renders fine as code', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      await renderMarkdown(BEFORE + '```js\nconsole.log("half', container, { yieldBeforeParse: false });
      expect(container.querySelector('.map-slot')).toBeNull();
      expect(container.querySelector('pre')).toBeTruthy();
      expect(container.textContent).toContain('console.log');
    } finally {
      container.remove();
    }
  });

  it('does not touch a text whose fences all close, even with several slot fences in sequence', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      await renderMarkdown(BEFORE + FULL_MAP + '中间说明。\n\n' + FULL_MAP, container, { yieldBeforeParse: false });
      const slots = container.querySelectorAll('.map-slot');
      expect(slots.length).toBe(2);
    } finally {
      container.remove();
    }
  });
});
