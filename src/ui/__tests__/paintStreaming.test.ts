// src/ui/__tests__/paintStreaming.test.ts
// Covers the streaming-time paint gate in markdown.ts (same mechanism as
// mapStreaming): a closed ```paint fence must start rendering immediately and
// hold later blocks until the canvas has painted; an open fence keeps ONE
// stable placeholder; the completion render adopts the finished slot.

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Same pass-through rationale as mapStreaming.test.ts: trusted fixtures.
mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

const { flushStreamingRender, renderMarkdown, scheduleStreamingRender, streamingViewSlice } = await import('../markdown');

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  GlobalRegistrator.register();
  // Self-sufficient canvas stub: happy-dom ships no 2D context AND its
  // HTMLCanvasElement.prototype is shared across register cycles, so whatever
  // another file left on the prototype would leak in here (CI sorts files
  // differently than local bun — this exact leak broke this file once).
  // Mount our own full no-op 2D context so the render pipeline (claim → two
  // rAF → parse → draw → preview) always completes, restore afterwards.
  originalGetContext = window.HTMLCanvasElement.prototype.getContext;
  const noopCtx = () => ({
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    ellipse: () => {},
    arcTo: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    fillText: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    setLineDash: () => {},
    setTransform: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    measureText: (t: string) => ({ width: t.length * 7 }),
  });
  window.HTMLCanvasElement.prototype.getContext =
    noopCtx as unknown as typeof HTMLCanvasElement.prototype.getContext;
});
afterAll(() => {
  window.HTMLCanvasElement.prototype.getContext = originalGetContext;
  GlobalRegistrator.unregister();
});

const BEFORE = '看这张示意图：\n\n';
const PAINT =
  '```paint\n{"version":1,"width":320,"height":160,"shapes":[' +
  '{"type":"rect","x":10,"y":10,"w":120,"h":50,"r":6,"fill":"#3b82f6"},' +
  '{"type":"text","x":30,"y":40,"text":"API","color":"#fff"},' +
  '{"type":"arrow","x1":130,"y1":35,"x2":200,"y2":35,"stroke":"#64748b"}' +
  ']}\n```\n\n';
const AFTER = '图下面的说明文字。';

function renderOnce(container: HTMLElement, text: string): void {
  scheduleStreamingRender(text, container);
  flushStreamingRender(container);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `cond` holds, with a generous ceiling. The render pipeline
 *  (claim → double rAF → parse → draw) must never be awaited with a magic
 *  sleep — CI load varies and a fixed 80ms would flake there. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !cond()) await sleep(10);
  expect(cond(), what).toBe(true);
}

describe('streaming paint gate (diffStreaming)', () => {
  it('holds blocks below a still-loading paint slot and releases them once it previews', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + PAINT + AFTER);
      const slot = container.querySelector<HTMLElement>('.paint-slot');
      expect(slot).toBeTruthy();
      expect(slot!.getAttribute('data-state')).toBe('loading');
      expect(container.textContent).toContain('看这张示意图');
      expect(container.textContent).not.toContain(AFTER);

      // renderPaintNodes finishes asynchronously (claim → two rAF → draw →
      // preview). The next diff tick releases the hold on preview/error.
      await waitFor(() => slot!.getAttribute('data-state') === 'preview', 'paint slot previews');
      renderOnce(container, BEFORE + PAINT + AFTER + ' 完毕。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('完毕');
    } finally {
      container.remove();
    }
  });

  it('an open paint fence mounts ONE stable placeholder and never hydrates mid-growth', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const open1 = '```paint\n{"width":320,"height":160,"shapes":[{"type":"rect"';
      renderOnce(container, BEFORE + open1);
      const slot1 = container.querySelector<HTMLElement>('.paint-slot');
      expect(slot1).toBeTruthy();
      expect(slot1!.getAttribute('data-processed')).toBeNull();

      renderOnce(container, BEFORE + open1 + ',"x":0,"y":0,"w":10,"h":10}]}');
      const slot2 = container.querySelector<HTMLElement>('.paint-slot');
      expect(slot2).toBe(slot1);
      expect(slot2!.getAttribute('data-processed')).toBeNull();
    } finally {
      container.remove();
    }
  });

  it('a closed fence flips data-processed and kicks the render exactly once', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const open = '```paint\n{"width":320,"height":160,"shapes":[{"type":"rect"';
      renderOnce(container, BEFORE + open);
      const slot1 = container.querySelector<HTMLElement>('.paint-slot')!;
      renderOnce(container, BEFORE + PAINT + ' 之后的内容。');
      const slot3 = container.querySelector<HTMLElement>('.paint-slot');
      expect(slot3).not.toBe(slot1);
      expect(slot3!.getAttribute('data-processed')).toBe('true');
      expect(container.textContent).not.toContain('之后的内容');
      await waitFor(() => slot3!.getAttribute('data-state') === 'preview', 'closed-fence slot previews');
    } finally {
      container.remove();
    }
  });

  it('unparseable JSON lands in the error card and releases the hold', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const broken = '```paint\n{ this is not json }\n```\n\n';
      renderOnce(container, BEFORE + broken + AFTER);
      const slot = container.querySelector<HTMLElement>('.paint-slot');
      expect(slot).toBeTruthy();
      await waitFor(() => slot!.getAttribute('data-state') === 'error', 'broken JSON lands in the error card');
      // error is a terminal gate state — the stream must never wedge. (The
      // text grows on this tick: scheduleStreamingRender dedupes identical
      // text, so the real "more tokens arrived" case is what we model.)
      renderOnce(container, BEFORE + broken + AFTER + ' 完毕。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('完毕');
    } finally {
      container.remove();
    }
  });

  it('carries a finished paint slot across the completion render without rebuilding it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + PAINT + AFTER);
      const streamedSlot = container.querySelector<HTMLElement>('.paint-slot')!;
      await waitFor(() => streamedSlot.getAttribute('data-state') === 'preview', 'streamed slot previews');
      // The Completed handler re-renders the same text through renderMarkdown:
      // the painted canvas must be ADOPTED (same node), not rebuilt.
      await renderMarkdown(BEFORE + PAINT + AFTER, container, { yieldBeforeParse: false });
      const finalSlot = container.querySelector<HTMLElement>('.paint-slot');
      expect(finalSlot).toBe(streamedSlot);
      expect(finalSlot!.getAttribute('data-processed')).toBe('true');
    } finally {
      container.remove();
    }
  });
});

// ── 流式尾部窗口（2026-11-10 Windows 活锁判例）──
// 66KB/107KB 大消息流式期间每拍 lexer 全文 + 末块全量重渲染，是 WebView2
// 宿主活锁的燃料。封顶判据：超 32KB 只渲染末尾 + chip 交代去向；小文本
// 全文照旧；跨拍配对稳定（cut 不前移时头块不重建）。

describe('streaming tail window (streamingViewSlice)', () => {
  it('limit 以内返回 null（常规消息零行为变化）', () => {
    expect(streamingViewSlice('短文本')).toBeNull();
    expect(streamingViewSlice('a'.repeat(32_000))).toBeNull();
  });

  it('切点取双换行块边界，elidedChars 指向切点', () => {
    const text = 'a'.repeat(31_000) + '\n\n' + 'b'.repeat(32_500);
    const slice = streamingViewSlice(text)!;
    expect(slice).not.toBeNull();
    expect(text.slice(slice.elidedChars - 2, slice.elidedChars)).toBe('\n\n');
    expect(slice.view).toBe('b'.repeat(32_500));
    // 视图长度必须被压回窗口量级（lexer/渲染的每拍成本封顶）。
    expect(slice.view.length).toBeLessThanOrEqual(32_501);
  });

  it('视图开头落在未闭合围栏体内时补合成 ```（奇偶判定）', () => {
    // 围栏在切点之前打开且未闭合 → 前缀围栏标记 1 条（奇）→ 补。
    const openFence = '```js\ncode\n\n' + 'x'.repeat(33_000);
    expect(streamingViewSlice(openFence)!.view.startsWith('```\n')).toBe(true);
    // 前缀围栏已闭合 → 2 条（偶）→ 不补。
    const closedFence = '```js\nA\n```\n\n' + 'y'.repeat(33_000);
    expect(streamingViewSlice(closedFence)!.view.startsWith('```\n')).toBe(false);
  });
});

describe('streaming tail window (diffStreaming integration)', () => {
  it('超限文本：chip 占 children[0]、正文块从其后配对；小文本 chip 移除', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      // ~40KB（> 32KB 窗口），开头必须是干净段落块。
      const big = Array.from({ length: 2400 }, (_, i) => `段落${i}：内容行，填充体积。\n\n`).join('');
      scheduleStreamingRender(big, container);
      const chip = container.children[0] as HTMLElement;
      expect(chip.hasAttribute('data-stream-head')).toBe(true);
      expect(chip.textContent).toContain('KB');
      const firstBlock = container.children[1] as HTMLElement;
      // 尾窗切掉了开头（2400 段只留末尾窗口），首块不再是段落0——
      // 「开头不在 DOM 里」正是封顶的目的。
      expect(firstBlock.getAttribute('data-md-raw')).toContain('段落');
      expect(firstBlock.getAttribute('data-md-raw')).not.toContain('段落0：');
      expect(container.children.length).toBeGreaterThan(10);

      // 回到小文本：chip 移除，全文正常渲染。
      scheduleStreamingRender('一小段话', container);
      flushStreamingRender(container);
      expect((container.children[0] as HTMLElement).hasAttribute('data-stream-head')).toBe(false);
    } finally {
      container.remove();
    }
  });

  it('cut 不前移的跨拍生长：头块 data-md-raw 不变（配对稳定，不整帧重建）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const head = Array.from({ length: 2400 }, (_, i) => `段落${i}：内容行，填充体积。\n\n`).join('');
      scheduleStreamingRender(head, container);
      const firstRaw = (container.children[1] as HTMLElement).getAttribute('data-md-raw');
      scheduleStreamingRender(head + '（末段追加，不新增块边界）', container);
      flushStreamingRender(container);
      expect((container.children[1] as HTMLElement).getAttribute('data-md-raw')).toBe(firstRaw);
    } finally {
      container.remove();
    }
  });
});
