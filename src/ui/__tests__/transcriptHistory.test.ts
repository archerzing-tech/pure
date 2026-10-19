import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  createHistoryGroup,
  setTranscriptFlingTimings,
  FLING_SETTLE_MS,
  PARK_IDLE_MS,
  type HistoryGroupHandle,
} from '../transcriptHistory';

// Viewport-driven mounting/parking is driven by IntersectionObserver, which
// happy-dom lacks — the folding-model tests delete it. These cases assert the
// FLING POLICY itself, so a controllable stub takes its place.
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];
  callbacks: Array<{ isIntersecting: boolean; target: Element }> = [];
  constructor(private cb: IntersectionObserverCallback) {
    StubIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  emit(entries: Array<{ isIntersecting: boolean }>): void {
    this.cb(
      entries.map((e, i) => ({
        isIntersecting: e.isIntersecting,
        target: (this as unknown as { targets: Element[] }).targets?.[i],
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

let chat: HTMLElement;

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat"></div>';
  chat = document.getElementById('chat')!;
  StubIntersectionObserver.instances = [];
  // 测试时钟收紧:生产值见 FLING_SETTLE_MS / PARK_IDLE_MS(160ms / 900ms)。
  setTranscriptFlingTimings({ flingDeltaPx: 100, flingSettleMs: 40, parkIdleMs: 120 });
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = StubIntersectionObserver;
});

function fling(): void {
  chat.scrollTop = 0;
  chat.dispatchEvent(new Event('scroll'));
  chat.scrollTop = chat.scrollTop + 1000;
  chat.dispatchEvent(new Event('scroll'));
}

describe('transcript history fling policy', () => {
  it('slow scroll mounts immediately (small deltas never arm the fling clock)', () => {
    const group = createHistoryGroup({ parkOffscreen: true });
    chat.appendChild(group.el);
    group.adopt([document.createElement('div')]);
    group.park();
    const io = StubIntersectionObserver.instances.at(-1)!;
    chat.scrollTop = 5;
    chat.dispatchEvent(new Event('scroll')); // 小位移:慢速阅读
    io.emit([{ isIntersecting: true }]);
    expect(group.body.children.length).toBe(1);
  });

  it('mid-fling mount defers to the settle queue and mounts after settling', async () => {
    const group = createHistoryGroup({ parkOffscreen: true });
    chat.appendChild(group.el);
    group.adopt([document.createElement('div')]);
    group.park();
    const io = StubIntersectionObserver.instances.at(-1)!;
    fling();
    io.emit([{ isIntersecting: true }]);
    expect(group.body.children.length).toBe(0); // 甩动进行中:不手术
    await sleep(FLING_SETTLE_MS + 30);
    expect(group.body.children.length).toBe(1); // 落定后补做
  });

  it('parking waits out the idle window and cancels on re-entry', async () => {
    const group = createHistoryGroup({ parkOffscreen: true });
    chat.appendChild(group.el);
    group.adopt([document.createElement('div')]);
    const io = StubIntersectionObserver.instances.at(-1)!;
    io.emit([{ isIntersecting: false }]);
    await sleep(30);
    expect(group.body.children.length).toBe(1); // 迟滞:出带不立刻拔
    io.emit([{ isIntersecting: true }]);
    await sleep(PARK_IDLE_MS + 40);
    expect(group.body.children.length).toBe(1); // 重新入带取消了 park
  });

  it('a fling still in motion re-arms parking instead of ping-ponging', async () => {
    const group = createHistoryGroup({ parkOffscreen: true });
    chat.appendChild(group.el);
    group.adopt([document.createElement('div')]);
    const io = StubIntersectionObserver.instances.at(-1)!;
    io.emit([{ isIntersecting: false }]);
    await sleep(60);          // park 定时器已武装(t=60/120)
    fling();                  // t≈60 甩动:lastFlingAt≈60
    await sleep(80);          // t≈140:定时器重查 140-60=80 < 120 → 重武装
    expect(group.body.children.length).toBe(1); // 未 park
    await sleep(160);         // t≈300:300-60 ≥ 120 → 现在才 park
    expect(group.body.children.length).toBe(0);
  });

  it('whole-group renders run one at a time even when delivered in one batch', async () => {
    let active = 0;
    let overlapped = false;
    const groups: HistoryGroupHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const group = createHistoryGroup({});
      chat.appendChild(group.el);
      group.setLazyRenderer(async () => {
        active++;
        if (active > 1) overlapped = true;
        await sleep(15);
        active--;
      });
      groups.push(group);
    }
    // 每个 group 各持一个 observer 实例;真实风暴是同一次 observer 批投递
    // 触发的多个回调——这里在同一 tick 里同步打满三个回调,等价。
    for (const io of StubIntersectionObserver.instances.slice(-3)) {
      io.emit([{ isIntersecting: true }]);
    }
    await sleep(120);
    expect(groups.every(g => g.materialized)).toBe(true);
    expect(overlapped).toBe(false);
  });

  it('a queued settle job is dropped when the group left the band before the flush', async () => {
    let rendered = 0;
    const group = createHistoryGroup({});
    chat.appendChild(group.el);
    group.setLazyRenderer(() => {
      rendered++;
    });
    const io = StubIntersectionObserver.instances.at(-1)!;
    fling();
    io.emit([{ isIntersecting: true }]);  // 进队
    io.emit([{ isIntersecting: false }]); // 甩过站了:落定前已出带
    await sleep(FLING_SETTLE_MS + 30);
    expect(rendered).toBe(0);             // 白工不干
    io.emit([{ isIntersecting: true }]);  // 再回来(此时已落定)
    await sleep(10);
    expect(rendered).toBe(1);
  });
});
