// src/ui/__tests__/diagramStreaming.test.ts
// 2026-09-23 用户实测 + 明确要求（自己出案例验证）：
//  ① 缺陷：```mermaid / ```puml / ```echarts 图要等「图后面所有文字都显示完」
//     （整条消息 Completed）才渲染出来。
//  ② 要求：只要存在图像显示的步骤，一定是等这个图渲染完了，这个图后面的
//     文字才开始输出和显示。
// 落地语义：闭合计时启动渲染（不再等 Completed），同时像 ```map 一样闸住
// 后续文本，直到 data-state → preview（渲染失败 → error 也放行，绝不卡死流，
// Completed 的最终渲染完全无视闸门，收尾文字必达）。
// svg / puml 走行为验证（渲染路径全本地，puml 跑真引擎）；mermaid / chart
// 共用同一套闸门/过滤/收养机制，在源码契约测试里锁定接线。

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// DOMPurify needs a real browser DOM to initialize its default export; under
// happy-dom in bun tests `.sanitize` is undefined. These fixtures are trusted
// test strings, so stub sanitize as a pass-through (same rationale as
// mapStreaming.test.ts).
mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));
// The ```puml case below runs the REAL local engine — no module mock. bun's
// module registry is shared across test files on serialized runners, and a
// renderPlantumlToSvg stub registered here leaked into plantumlDiagram.test.ts
// on the Windows release run (export-not-found at link time). The DOM setup
// mirrors that file's contract for the engine instead.

const { flushStreamingRender, renderMarkdown, scheduleStreamingRender } = await import('../markdown');
const fs = await import('node:fs');

beforeAll(() => {
  // A real page URL matters: Emscripten-based engine bundles resolve their own
  // asset paths against location.href, and "about:blank" is not a valid base.
  GlobalRegistrator.register({ url: 'http://localhost:1420/' });
  // happy-dom ships no canvas 2D context, and the engine measures every label
  // with one before laying a diagram out. The stub only has to answer
  // measureText — glyph widths move pixels around, they do not decide whether
  // an SVG comes back.
  const canvasPrototype = window.HTMLCanvasElement.prototype as unknown as {
    getContext(id: string): unknown;
  };
  canvasPrototype.getContext = () => ({
    font: '',
    measureText: (text: string) => ({
      width: text.length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
  });
  // Graphviz layout as a classic script — the same contract the app satisfies
  // with a <script src="/plantuml/viz-global.js"> (publishes globalThis.Viz).
  const host = globalThis as typeof globalThis & { Viz?: { instance?: unknown } };
  if (!host.Viz || typeof host.Viz.instance !== 'function') {
    const source = readFileSync(
      new URL('../../../node_modules/@plantuml/core/viz-global.js', import.meta.url),
      'utf8',
    );
    new Function(source)();
  }
});
afterAll(() => GlobalRegistrator.unregister());

const BEFORE = '先看结构：\n\n';
const SVG = '```svg\n<svg width="40" height="10" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="10" fill="teal"/></svg>\n```\n\n';
const PUML = '```puml\n@startuml\nA -> B\n@enduml\n```\n\n';
const AFTER = '图后面的说明文字。';

function renderOnce(container: HTMLElement, text: string): void {
  // scheduleStreamingRender's first call renders on the leading edge; flush
  // forces the pending diff synchronously so assertions run against the frame
  // the user would see on that tick.
  scheduleStreamingRender(text, container);
  flushStreamingRender(container);
}

/** The hydration passes commit the loading state synchronously and paint the
 *  SVG after two animation frames — give them that frame budget. */
const paint = (): Promise<void> => Bun.sleep(30);

/** The ```puml hydration loads the real 6MB TeaVM engine, so settling takes
 *  seconds, not frames — poll like the gate does until it can release. */
async function waitForSettled(slot: HTMLElement, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = slot.getAttribute('data-state');
    if (state === 'preview' || state === 'error') return;
    await Bun.sleep(100);
  }
  throw new Error(`diagram slot never settled (state=${slot.getAttribute('data-state')})`);
}

describe('streaming diagram gate (图渲染完，后面的文字才开始显示)', () => {
  it('a closed ```svg fence renders in place and HOLDS the text below until it paints', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + SVG + AFTER);

      // 图的槽位当场就开始渲染（不再等整条消息完结）……
      const slot = container.querySelector<HTMLElement>('.svg-slot');
      expect(slot).toBeTruthy();
      await paint();
      expect(slot!.getAttribute('data-processed')).toBe('true');
      expect(slot!.getAttribute('data-state')).toBe('preview');
      expect(slot!.querySelector('.svg-target svg')).toBeTruthy();
      // ……但闸门闭着：图还没画完的那一拍，图后面的文字绝不能已经在 DOM 里。
      expect(container.textContent).not.toContain(AFTER);

      // 下一拍（流式文本继续到达）：图已 preview，闸门放行，被闸住的文字落位。
      renderOnce(container, BEFORE + SVG + AFTER + ' 完毕。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('完毕');
    } finally {
      container.remove();
    }
  });

  it('never hydrates a still-open fence, does not hold on it, and mounts ONE stable placeholder', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      // Tick 1: fence OPEN — placeholder mounts, no hydration (source 未写完).
      const open1 = '```svg\n<svg width="40" height="10"';
      renderOnce(container, BEFORE + open1);
      const slot1 = container.querySelector<HTMLElement>('.svg-slot');
      expect(slot1).toBeTruthy();
      expect(slot1!.getAttribute('data-processed')).toBeNull();

      // Tick 2: the source grows — the SAME placeholder survives untouched
      // (per-tick teardown/rebuild was the residual map flicker; diagrams
      // share the append-only stability rule). While the fence is open the
      // tail is lexed INSIDE the growing code token, so there is no "text
      // below" yet — the placeholder stays unprocessed either way.
      renderOnce(container, BEFORE + open1 + ' fill="teal"/></svg>\n\n图后面的说明文字。');
      const slot2 = container.querySelector<HTMLElement>('.svg-slot');
      expect(slot2).toBe(slot1);
      expect(slot2!.getAttribute('data-processed')).toBeNull();

      // Tick 3: fence CLOSES — the slot is replaced once, hydration kicks,
      // and the gate now holds: the text that used to flow gets pulled until
      // the picture paints.
      renderOnce(container, BEFORE + SVG + AFTER + ' 完毕。');
      const slot3 = container.querySelector<HTMLElement>('.svg-slot');
      expect(slot3).not.toBe(slot1);
      expect(container.textContent).not.toContain(AFTER);
      expect(container.textContent).not.toContain('完毕');
      await paint();
      expect(slot3!.getAttribute('data-state')).toBe('preview');

      // Tick 4: gate released.
      renderOnce(container, BEFORE + SVG + AFTER + ' 完毕。最终。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('完毕');
      expect(container.textContent).toContain('最终');
    } finally {
      container.remove();
    }
  });

  it('a closed ```puml fence mounts a slot mid-stream, renders via the engine, and holds the text below', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + PUML + AFTER);
      const slot = container.querySelector<HTMLElement>('.puml-slot');
      expect(slot).toBeTruthy();
      expect(slot!.getAttribute('data-diagram-kind')).toBe('puml');
      // The fence did NOT fall back to a plain top-level code block (the
      // slot's own hidden source view is a nested pre and does not count).
      expect(container.querySelector<HTMLElement>(':scope > pre > code.language-puml')).toBeNull();
      // Held: the text below waits for the engine render.
      expect(container.textContent).not.toContain(AFTER);

      await waitForSettled(slot!);
      expect(slot!.getAttribute('data-processed')).toBe('true');
      expect(slot!.getAttribute('data-state')).toBe('preview');
      expect(slot!.querySelector('.puml-target svg')).toBeTruthy();

      renderOnce(container, BEFORE + PUML + AFTER + ' 好。');
      expect(container.textContent).toContain(AFTER);
      expect(container.textContent).toContain('好');
    } finally {
      container.remove();
    }
  }, 70_000);

  it('carries a painted diagram across the completion render without rebuilding it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      renderOnce(container, BEFORE + SVG + AFTER);
      const streamedSlot = container.querySelector<HTMLElement>('.svg-slot')!;
      await paint();
      expect(streamedSlot.getAttribute('data-state')).toBe('preview');

      // The Completed handler re-renders the same text through renderMarkdown.
      // The painted diagram must be ADOPTED (same node), not torn down and
      // rebuilt — that rebuild flashed painted → loading → painted.
      await renderMarkdown(BEFORE + SVG + AFTER, container, { yieldBeforeParse: false });
      const finalSlot = container.querySelector<HTMLElement>('.svg-slot');
      expect(finalSlot).toBe(streamedSlot);
      expect(finalSlot!.getAttribute('data-processed')).toBe('true');
      expect(finalSlot!.querySelector('.svg-target svg')).toBeTruthy();
      // The completion render ignores gates: the held tail always lands.
      expect(container.textContent).toContain(AFTER);
    } finally {
      container.remove();
    }
  });

  it('adopts every slot of a streamed multi-SVG gallery through the wrapper', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const two = '```svg\n<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>\n<svg width="12" height="12" xmlns="http://www.w3.org/2000/svg"><circle r="6"/></svg>\n```\n\n';
      renderOnce(container, BEFORE + two + AFTER);
      const gallery = container.querySelector<HTMLElement>('.svg-gallery');
      expect(gallery).toBeTruthy();
      const streamed = Array.from(gallery!.querySelectorAll<HTMLElement>('.svg-slot'));
      expect(streamed.length).toBe(2);
      await paint();
      for (const slot of streamed) expect(slot.getAttribute('data-state')).toBe('preview');

      await renderMarkdown(BEFORE + two + AFTER, container, { yieldBeforeParse: false });
      const finalGallery = container.querySelector<HTMLElement>('.svg-gallery');
      expect(finalGallery).toBeTruthy();
      const finalSlots = Array.from(finalGallery!.querySelectorAll<HTMLElement>('.svg-slot'));
      expect(finalSlots).toHaveLength(2);
      expect(finalSlots[0]).toBe(streamed[0]);
      expect(finalSlots[1]).toBe(streamed[1]);
    } finally {
      container.remove();
    }
  });

  it('gates mermaid/puml/chart through the same hold paths (source contract)', () => {
    // The engine-backed kinds share the gate/filter/adoption machinery
    // exercised above; lock the wiring itself so a refactor cannot silently
    // strand them back on the Completed pass or drop the hold.
    const src = fs.readFileSync(new URL('../markdown.ts', import.meta.url), 'utf8');
    // puml mounts the same slot mid-stream as the completed render.
    expect(src).toContain("if (lang === 'puml' || lang === 'plantuml') return diagramSlot('puml', token.text, '');");
    // The hold-gate sits on all three diff paths: equal-raw skip, the slot
    // stability keep, and the fresh mount.
    expect(src.split('streamingDiagramGate(oldEl, container)').length - 1).toBeGreaterThanOrEqual(2);
    expect(src).toContain('streamingDiagramGate(newEl, container)');
    // Re-kick protection: a slow engine load is not re-started every tick.
    expect(src).toContain("slot.setAttribute('data-stream-kick', '1')");
    // Open fences can never hydrate, in any scan of the bubble.
    const filterCount = src.split('!streamFenceOpen(slot)').length - 1;
    expect(filterCount).toBeGreaterThanOrEqual(4);
    // The completion render adopts painted diagram slots (no repaint flicker).
    expect(src).toContain('adoptPreservedDiagramSlots(container, preservedDiagrams);');
  });
});
