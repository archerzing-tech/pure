// src/ui/__tests__/blockSerialTiming.test.ts
// 块级串行时序不变量（2026-11-03 用户定调）：对话流内任意相邻块 a→b，b 进入
// 可见 DOM 前 a 必须已落「渲染终态」（preview/error 或图片 load/error），形式
// 无关。三层防线各有契约：
//   completion 面 → renderAsyncBlocksInDocumentOrder（文档序 dispatcher +
//     map 瓦片 settle 等待 + 图片 load settle）；
//   流式面 → streamingImageGate（map/diagram gate 的图片补刀）。
// 本文件锁：dispatcher 的选择器并集与接线、settle 等待的状态机、img gate 的
// hold/放行/保险丝行为，以及 renderMarkdown 不再按形式分批的负锚。

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

mock.module('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

const markdown = await import('../markdown');
const { waitForMapSlotSettled, waitForImagesSettled, streamingImageGate } = markdown;

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe('document-order dispatcher (completion 面接线契约)', () => {
  it('renderMarkdown 走文档序 dispatcher，不再按形式分批', async () => {
    // 源码契约：旧的按形式分批调用（svg→chart→paint→map→puml→mermaid）是
    // 形式间乱序的根——completion 面只允许出现一次 dispatcher 调用。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'markdown.ts'), 'utf8');
    expect(src.split("await renderAsyncBlocksInDocumentOrder(container, options.visualTiming ?? 'parallel')").length - 1).toBe(1);
    // 负锚：分批调用不得在 renderMarkdown 复活（这些名字仍被主题重渲面和
    // 暖 host 补渲面合法使用——那两面渲的是已在屏块，无「出现顺序」问题）。
    expect(src.split('renderOneSlotInOrder(').length - 1).toBeGreaterThanOrEqual(2);
    // dispatcher 循环内：map 瓦片 settle 等待只扣「下一个异步块的放行」
    // （renderMapInto 同步返回但瓦片异步 ready；尾部绑定/chips 不是可视块）。
    expect(src).toContain('await waitForMapSlotSettled(unit, DIAGRAM_HOLD_BUDGET_MS)');
    expect(src).toContain("i < units.length - 1");
    // serial/parallel 双模：活渲染 serial（文档序），恢复/回放 parallel（旧批
    // 序）——默认 parallel，chat.ts 两处活渲染点显式 serial。
    expect(src).toContain("timing === 'parallel'");
    const chatSrc = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'ui', 'chat.ts'), 'utf8');
    expect(chatSrc.split("visualTiming: 'serial'").length - 1).toBe(2);
    // markdown 图片在 dispatcher 序列内（.md-img-wrap 不在 = 图片乱序回归）。
    expect(src).toContain("'.md-img-wrap:not([data-timing-pass])'");
  });

  it('waitForMapSlotSettled: preview/error 立即放行，loading 等到终态', async () => {
    const slot = document.createElement('div');
    slot.setAttribute('data-map-state', 'preview');
    await waitForMapSlotSettled(slot, 50); // 已终态：不耗预算立即过

    slot.setAttribute('data-map-state', 'loading');
    const pending = waitForMapSlotSettled(slot, 5_000);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 80));
    expect(resolved).toBe(false); // loading 期间不放行
    slot.setAttribute('data-map-state', 'error'); // 静默重试耗尽也落 error
    await pending; // 终态放行
  });

  it('waitForMapSlotSettled: 预算是挂死保险丝——loading 卡死时到点放行', async () => {
    const slot = document.createElement('div');
    slot.setAttribute('data-map-state', 'loading');
    const start = Date.now();
    await waitForMapSlotSettled(slot, 120);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100); // 等满预算才放
  });

  it('waitForImagesSettled: 未完成图等到 load，complete 视口外 lazy 图跳过', async () => {
    const wrap = document.createElement('span');
    wrap.className = 'md-img-wrap';
    const done = document.createElement('img');
    done.className = 'md-img';
    Object.defineProperty(done, 'complete', { configurable: true, value: true });
    const lazy = document.createElement('img');
    lazy.className = 'md-img';
    Object.defineProperty(lazy, 'complete', { configurable: true, value: false });
    Object.defineProperty(lazy, 'getBoundingClientRect', {
      value: () => ({ bottom: -10, top: -50 }), // 视口外：lazy 未 fetch ≠ 未完成
    });
    const loading = document.createElement('img');
    loading.className = 'md-img';
    Object.defineProperty(loading, 'complete', { configurable: true, value: false });
    Object.defineProperty(loading, 'getBoundingClientRect', {
      value: () => ({ bottom: 200, top: 100 }),
    });
    wrap.append(done, lazy, loading);
    document.body.appendChild(wrap);
    try {
      const pending = waitForImagesSettled(wrap, 5_000);
      let resolved = false;
      void pending.then(() => { resolved = true; });
      await new Promise((r) => setTimeout(r, 60));
      expect(resolved).toBe(false); // loading 图未 settle
      loading.dispatchEvent(new Event('load'));
      await pending; // load 事件放行
    } finally {
      wrap.remove();
    }
  });
});

describe('streamingImageGate (流式面图片补刀)', () => {
  function imgWrapFixture(complete: boolean, top: number): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'md-img-wrap';
    const img = document.createElement('img');
    img.className = 'md-img';
    Object.defineProperty(img, 'complete', { configurable: true, value: complete });
    Object.defineProperty(img, 'getBoundingClientRect', {
      value: () => ({ bottom: top + 40, top }),
    });
    wrap.appendChild(img);
    return wrap;
  }

  it('前方未完成图 hold 住后块；complete 后放行', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      const wrap = imgWrapFixture(false, 100);
      const later = document.createElement('p');
      later.textContent = '图片下面的文字';
      root.append(wrap, later);
      expect(streamingImageGate(later)).toBe(true); // hold

      Object.defineProperty(wrap.querySelector('img')!, 'complete', { value: true });
      expect(streamingImageGate(later)).toBe(false); // 放行
    } finally {
      root.remove();
    }
  });

  it('el 自身块内的未完成图也 hold（文字块带图，后块等它）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      const para = document.createElement('p');
      para.appendChild(imgWrapFixture(false, 100).firstChild as HTMLImageElement);
      const later = document.createElement('p');
      root.append(para, later);
      expect(streamingImageGate(para)).toBe(true);
    } finally {
      root.remove();
    }
  });

  it('视口外 lazy 图不 hold（未 fetch ≠ 未完成）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      const wrap = imgWrapFixture(false, -500); // 视口上方外
      const later = document.createElement('p');
      root.append(wrap, later);
      expect(streamingImageGate(later)).toBe(false);
    } finally {
      root.remove();
    }
  });

  it('15s 预算是保险丝：hold-since 到点放行，不 wedge 流', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      const wrap = imgWrapFixture(false, 100);
      const later = document.createElement('p');
      root.append(wrap, later);
      expect(streamingImageGate(later)).toBe(true); // 第一 tick 记 hold-since
      wrap.setAttribute('data-hold-since', String(Date.now() - 16_000));
      expect(streamingImageGate(later)).toBe(false); // 超预算放行
      // one-shot：released 后即使图仍未完成也不再 hold
      expect(streamingImageGate(later)).toBe(false);
    } finally {
      root.remove();
    }
  });

  it('diffStreaming 三处 gate 路径全部接入 img gate（源码契约）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'markdown.ts'), 'utf8');
    // 定义 1 处 + 接入 3 处（skip 路径 ×2 + mount 后路径 ×1）。
    expect(src.split('streamingImageGate(').length - 1).toBe(4);
    expect(src.split('if (streamingImageGate(').length - 1).toBe(3);
  });
});
