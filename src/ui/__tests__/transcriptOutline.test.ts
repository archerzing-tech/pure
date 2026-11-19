// src/ui/__tests__/transcriptOutline.test.ts
// 左栏对话大纲刻度尺（transcriptOutline.ts）：两屏闸、刻度纵轴映射与去重、
// 滑块几何是纯函数；接线用例在 happy-dom 里桩掉盒子尺寸，锁「点刻度 → 该轮
// 偏移的 scrollTop」这条主链路。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  collapseOutlineMarks,
  outlineThumbGeometry,
  shouldShowOutline,
  wireTranscriptOutline,
} from '../transcriptOutline';
import { setPinnedToBottom } from '../scrollPin';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('shouldShowOutline', () => {
  it('stays hidden until the transcript is longer than two screens', () => {
    expect(shouldShowOutline(900, 800)).toBe(false);
    expect(shouldShowOutline(1600, 800)).toBe(false);
    expect(shouldShowOutline(1601, 800)).toBe(true);
  });

  it('treats a zero-height transcript (landing / squeezed view) as hidden', () => {
    expect(shouldShowOutline(5000, 0)).toBe(false);
    expect(shouldShowOutline(0, 800)).toBe(false);
  });
});

describe('collapseOutlineMarks', () => {
  it('maps content offsets onto the track and keeps input order irrelevant', () => {
    const marks = collapseOutlineMarks(
      [
        { offset: 3000, label: '第三轮', kind: 'turn' },
        { offset: 0, label: '第一轮', kind: 'turn' },
        { offset: 1500, label: '第二轮', kind: 'turn' },
      ],
      600,
      3000,
    );
    expect(marks.map(m => m.label)).toEqual(['第一轮', '第二轮', '第三轮']);
    expect(marks.map(m => m.y)).toEqual([0, 300, 600]);
  });

  it('merges ticks that would land closer than the minimum gap', () => {
    const marks = collapseOutlineMarks(
      [
        { offset: 0, label: 'a', kind: 'turn' },
        { offset: 5, label: 'b', kind: 'turn' },
        { offset: 400, label: 'c', kind: 'turn' },
      ],
      600,
      3000,
    );
    expect(marks.map(m => m.label)).toEqual(['a', 'c']);
  });

  it('clamps offsets past the scrollable range to the track end', () => {
    const marks = collapseOutlineMarks([{ offset: 9999, label: '末轮', kind: 'turn' }], 600, 3000);
    expect(marks).toHaveLength(1);
    expect(marks[0].y).toBe(600);
  });

  it('returns nothing when the track has not been laid out yet', () => {
    expect(collapseOutlineMarks([{ offset: 10, label: 'a', kind: 'turn' }], 0, 3000)).toEqual([]);
  });
});

describe('outlineThumbGeometry', () => {
  it('sizes the thumb by the visible fraction and slides it over the travel', () => {
    expect(outlineThumbGeometry(0, 4000, 1000, 600)).toEqual({ top: 0, height: 150 });
    // 滑块走满「轨道高 − 滑块高」= 450px：中点一半，到底端 450。
    expect(outlineThumbGeometry(1500, 4000, 1000, 600)).toEqual({ top: 225, height: 150 });
    expect(outlineThumbGeometry(3000, 4000, 1000, 600)).toEqual({ top: 450, height: 150 });
  });

  it('never shrinks below the grabbable minimum', () => {
    const geometry = outlineThumbGeometry(0, 400_000, 1000, 600);
    expect(geometry.height).toBe(24);
  });
});

// ── 接线：尺子挂在 #chat-view 上，刻度按用户气泡来，点击写 scrollTop ──

interface Box { top: number; left: number; height: number; width: number }

function stubSize(el: HTMLElement, box: Box, extra: { scrollHeight?: number; clientHeight?: number } = {}): void {
  el.getBoundingClientRect = () => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  }) as DOMRect;
  if (extra.scrollHeight !== undefined) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => extra.scrollHeight });
  }
  if (extra.clientHeight !== undefined) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => extra.clientHeight });
  }
}

function buildTranscript(rows: number[]): { chat: HTMLElement; view: HTMLElement } {
  document.body.innerHTML = '<div id="chat-view"><main id="chat"></main></div>';
  const view = document.getElementById('chat-view')!;
  const chat = document.getElementById('chat')!;
  stubSize(view, { top: 0, left: 0, height: 900, width: 1200 });
  stubSize(chat, { top: 0, left: 100, height: 800, width: 900 }, { scrollHeight: 3000, clientHeight: 800 });
  for (const [i, top] of rows.entries()) {
    const row = document.createElement('div');
    row.className = 'bubble-row user';
    row.textContent = `第 ${i + 1} 轮的问题`;
    stubSize(row, { top, left: 140, height: 40, width: 600 });
    chat.appendChild(row);
  }
  return { chat, view };
}

/** 连接线后第一次测量排在 setTimeout(0)，等一拍即可。 */
const flushMeasure = () => new Promise(resolve => setTimeout(resolve, 20));

describe('wireTranscriptOutline', () => {
  it('marks one tick per user turn and jumps to that turn on click', async () => {
    const { chat, view } = buildTranscript([200, 1200, 2100]);
    wireTranscriptOutline(chat);
    const rail = view.querySelector<HTMLElement>('.transcript-ruler')!;
    expect(rail).not.toBeNull();
    expect(rail.hidden).toBe(false);
    const track = rail.querySelector<HTMLElement>('.transcript-ruler-track')!;
    stubSize(track, { top: 20, left: 100, height: 600, width: 20 }, { clientHeight: 600 });

    await flushMeasure();
    const marks = [...track.querySelectorAll<HTMLElement>('.transcript-ruler-mark')];
    expect(marks).toHaveLength(3);
    expect(marks.map(m => m.dataset.offset)).toEqual(['200', '1200', '2100']);
    expect(marks[1].title).toContain('第 2 轮');

    marks[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 锚点顶部留 OUTLINE_JUMP_ALIGN_PX 的上下文。
    expect(chat.scrollTop).toBe(1200 - 24);
  });

  it('stays hidden for a short transcript and for a squeezed chat box', async () => {
    const { chat, view } = buildTranscript([200, 400]);
    stubSize(chat, { top: 0, left: 100, height: 800, width: 900 }, { scrollHeight: 900, clientHeight: 800 });
    wireTranscriptOutline(chat);
    const rail = view.querySelector<HTMLElement>('.transcript-ruler')!;
    expect(rail.hidden).toBe(true);
    await flushMeasure();
    expect(rail.querySelectorAll('.transcript-ruler-mark')).toHaveLength(0);
  });

  it('scrolls without re-measuring ticks, then measures once the scroll settles', async () => {
    // 2026-11-19 滚动路径去强制重排：滚动处理只读 scrollTop 并写滑块
    // transform；刻度位置在滚动中不变，重量只会在流式写入后逼一次整列重排。
    const { chat, view } = buildTranscript([200, 1200, 2100]);
    wireTranscriptOutline(chat);
    const track = view.querySelector<HTMLElement>('.transcript-ruler-track')!;
    stubSize(track, { top: 20, left: 100, height: 600, width: 20 }, { clientHeight: 600 });
    // 轨道尺寸是接好线之后才桩的：追加一个非回合节点触发一次 refresh，让缓存
    // 度量拿到轨道高度（真实页面上布局先于首帧 refresh，没这一步）。
    chat.appendChild(document.createElement('div'));
    await flushMeasure();
    expect(track.querySelectorAll('.transcript-ruler-mark')).toHaveLength(3);

    let rowReads = 0;
    for (const row of chat.querySelectorAll<HTMLElement>('.bubble-row.user')) {
      const original = row.getBoundingClientRect.bind(row);
      row.getBoundingClientRect = () => { rowReads++; return original(); };
    }

    // 未钉底 = 用户在看历史，停止后才会重量刻度。
    setPinnedToBottom(chat, false);
    chat.scrollTop = 1500;
    chat.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 40));
    // 滚动帧里一次行盒子都不读。
    expect(rowReads).toBe(0);
    // 滑块跟上了，而且是 transform（写 top 会让定位上下文每个滚动帧失效布局）。
    const thumb = track.querySelector<HTMLElement>('.transcript-ruler-thumb')!;
    // 1500/2200 走完 440px 行程 → 300px。
    expect(thumb.style.transform).toBe('translateY(300px)');
    expect(thumb.style.top).toBe('');

    // 停手 180ms 后重量一轮（这里等过 350ms 的刷新节流窗口）。
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(rowReads).toBeGreaterThan(0);
    // 行盒是静态桩（不随 scrollTop 平移），重量后点数不做精确断言。
    expect(track.querySelectorAll('.transcript-ruler-mark').length).toBeGreaterThan(0);
  });

  it('never re-measures while the transcript is pinned to the live tail', async () => {
    const { chat, view } = buildTranscript([200, 1200, 2100]);
    wireTranscriptOutline(chat);
    const track = view.querySelector<HTMLElement>('.transcript-ruler-track')!;
    stubSize(track, { top: 20, left: 100, height: 600, width: 20 }, { clientHeight: 600 });
    chat.appendChild(document.createElement('div'));
    await flushMeasure();

    let rowReads = 0;
    for (const row of chat.querySelectorAll<HTMLElement>('.bubble-row.user')) {
      const original = row.getBoundingClientRect.bind(row);
      row.getBoundingClientRect = () => { rowReads++; return original(); };
    }
    // 钉底跟直播：上方内容高度不变，旧刻度的坐标依旧成立。
    setPinnedToBottom(chat, true);
    chat.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(rowReads).toBe(0);
  });

  it('wires a transcript only once', () => {
    const { chat, view } = buildTranscript([200]);
    wireTranscriptOutline(chat);
    wireTranscriptOutline(chat);
    expect(view.querySelectorAll('.transcript-ruler')).toHaveLength(1);
  });
});
