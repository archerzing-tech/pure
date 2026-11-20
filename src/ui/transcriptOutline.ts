// src/ui/transcriptOutline.ts
// 对话大纲刻度尺（2026-11-19 用户提案，替代右下角双向箭头）。
//
// 诉求：会话超过两屏后，在对话内容左侧的空白栏长出一把「尺子」，按关键节点
// 打点；点节点直达该轮锚点，点尺子两端回开头 / 最新；跳转途中中间内容不渲染。
//
// 为什么这把尺子能做得这么轻：跳转就是一次 `scrollTop` 赋值，而 #chat 上的
// fling 判据（transcriptHistory.ts 的 wireFlingClock）本来就把 ≥240px 的单次
// 位移记成 fling——中途经过的历史分组只保持摘要条，不挂载不绘制，落点之后由
// IntersectionObserver 正常挂载。折叠组的泊车用 min-height 占位（同文件
// park()），滚动几何不塌，所以在内容没挂载的情况下刻度位置依然是准的。
//
// 刻度来源只认两种 DOM，两条生产路径（直播 / 磁盘恢复）都产出它们：
//   • 用户气泡 `.bubble-row.user` → 一轮的锚点，hover 显示这句的原文片段；
//   • 已泊车的 `.transcript-history-group` → 老历史按组给一个刻度（组内每一轮
//     的 DOM 此刻不在文档里，量不到 offset，但组本身的占位高度是准的）。
// 组内容挂载后，组内每轮会各出一个刻度，组刻度自动让位（否则同位置两个点）。

import { t } from '../shared/i18n';
import { forceScrollToBottom, isElementPinnedToBottom } from './scrollPin';

/** 内容不足两屏不出现——短会话里这把尺子是纯噪音。 */
export const OUTLINE_MIN_SCREENS = 2;
/** 相邻刻度在轨道上靠得比这还近就合并：一个像素一条线，看不成尺子。 */
export const OUTLINE_MARK_MIN_GAP_PX = 5;
/** 点刻度时目标轮顶部留出的上下文（像素）。 */
export const OUTLINE_JUMP_ALIGN_PX = 24;
/** 单次测量最多扫描的用户气泡数（超长会话按等距抽样，读数成本封顶）。
 *  1200 个气泡在 1200 轮会话上实测一次同步测量 ~0.5s；尺子在 20px 轨道上
 *  最多也就能放下 ~160 个点，扫 1200 个是纯浪费。480 已覆盖 4K 轨道上限。 */
const MAX_MEASURED_ROWS = 480;
/** 刻度测量节流窗口：流式期间 DOM 每几拍就变，重新量一轮不必每次变更都做。 */
const MEASURE_INTERVAL_MS = 350;
/** resize 停手后再全量测量：拖动窗口时每个 resize 都量一遍会把主线程塞满。 */
const RESIZE_SETTLE_MS = 200;
/** 滑块最矮高度：内容再长也要能看见、能抓。 */
const THUMB_MIN_HEIGHT_PX = 24;
/** 尺子占的宽度（与 styles.css 的 .transcript-ruler 对齐）。 */
const RAIL_WIDTH_PX = 20;
/** 尺子右缘与正文左缘的呼吸位（2026-11-19 用户定稿：比 8px 再远一点）。 */
const CONTENT_GAP_PX = 14;

export type OutlineMarkKind = 'turn' | 'group';

export interface OutlineMarkInput {
  /** 该节点在 #chat 内容坐标里的顶部偏移（scrollTop 坐标系）。 */
  offset: number;
  label: string;
  kind: OutlineMarkKind;
}

export interface OutlineMark extends OutlineMarkInput {
  /** 在轨道上的像素位置。 */
  y: number;
}

export function shouldShowOutline(
  scrollHeight: number,
  clientHeight: number,
  minScreens = OUTLINE_MIN_SCREENS,
): boolean {
  if (clientHeight <= 0 || scrollHeight <= 0) return false;
  return scrollHeight > clientHeight * minScreens;
}

/**
 * 把内容坐标换算成轨道像素并去掉挤在一起的点。纵轴映射用的是可滚动范围
 * （scrollHeight − clientHeight）而不是 scrollHeight：这样「刻度 y 对应的
 * scrollTop」与滑块位置是同一套坐标，点哪儿到哪儿，底部一轮也不会落到轨道外面。
 */
export function collapseOutlineMarks(
  marks: readonly OutlineMarkInput[],
  trackHeight: number,
  maxScroll: number,
  minGapPx = OUTLINE_MARK_MIN_GAP_PX,
): OutlineMark[] {
  if (trackHeight <= 0 || marks.length === 0) return [];
  const span = Math.max(1, maxScroll);
  const sorted = [...marks].sort((a, b) => a.offset - b.offset);
  const out: OutlineMark[] = [];
  let lastY = Number.NEGATIVE_INFINITY;
  for (const mark of sorted) {
    const y = Math.min(trackHeight, Math.max(0, (mark.offset / span) * trackHeight));
    if (y - lastY < minGapPx) continue;
    out.push({ ...mark, y });
    lastY = y;
  }
  return out;
}

/**
 * 滑块几何：高度按可视比例缩，但不少于 THUMB_MIN_HEIGHT_PX；位置滑满
 * 「轨道高 − 滑块高」。轨道比滑块还短时钳到 0，不产生负的 top。
 */
export function outlineThumbGeometry(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
): { top: number; height: number } {
  if (trackHeight <= 0 || scrollHeight <= 0 || clientHeight <= 0) return { top: 0, height: 0 };
  const height = Math.min(trackHeight, Math.max(THUMB_MIN_HEIGHT_PX, (clientHeight / scrollHeight) * trackHeight));
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll <= 0) return { top: 0, height };
  const travel = Math.max(0, trackHeight - height);
  const top = Math.min(travel, Math.max(0, (scrollTop / maxScroll) * travel));
  return { top, height };
}

/** 刻度换行都压成一行短标签：尺子只有 hover 的原生 tooltip，长文本会被截。 */
function markLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * 给 #chat 挂上刻度尺。幂等（dataset 闸），直播 send 与磁盘恢复各调一次都安全。
 * 尺子挂在 #chat-view 上（绝对定位的覆盖层）：不能进 #chat，否则它会跟着内容
 * 一起滚走。
 */
export function wireTranscriptOutline(chatEl: HTMLElement): void {
  const host = document.getElementById('chat-view');
  if (!host) return;
  if (chatEl.dataset.outlineWired === '1') return;
  chatEl.dataset.outlineWired = '1';

  const rail = document.createElement('div');
  rail.className = 'transcript-ruler';
  rail.hidden = true;
  rail.setAttribute('role', 'navigation');
  rail.setAttribute('aria-label', t('chat.outline'));

  const topCap = document.createElement('button');
  topCap.type = 'button';
  topCap.className = 'transcript-ruler-cap is-top';
  topCap.textContent = '↑';
  topCap.title = t('chat.outline.top');
  topCap.setAttribute('aria-label', t('chat.outline.top'));

  const track = document.createElement('div');
  track.className = 'transcript-ruler-track';
  track.title = t('chat.outline.track');

  const thumb = document.createElement('div');
  thumb.className = 'transcript-ruler-thumb';
  track.appendChild(thumb);

  const bottomCap = document.createElement('button');
  bottomCap.type = 'button';
  bottomCap.className = 'transcript-ruler-cap is-bottom';
  bottomCap.textContent = '↓';
  bottomCap.title = t('chat.outline.bottom');
  bottomCap.setAttribute('aria-label', t('chat.outline.bottom'));

  rail.append(topCap, track, bottomCap);
  host.appendChild(rail);

  // 刻度元素复用池：一次长会话几百个点，每次重测都重建 DOM 会在流式期间
  // 制造无谓的节点风暴。
  const markEls: HTMLElement[] = [];
  let maxScroll = 0;
  let measureTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMeasureAt = 0;
  let scrollFrame = 0;
  let resizeFrame = 0;
  let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let resizing = false;
  let repaintTimer: ReturnType<typeof setTimeout> | null = null;
  // 正文列的左内边距（桌面 32px / 窄窗 14px）只在窗口尺寸变了才变，缓存它：
  // 流式期间每次 mutation 都读 getComputedStyle 是白付一次样式重算。
  let contentPadLeft = 32;

  const layout = (readPadding = false): void => {
    if (readPadding) contentPadLeft = Number.parseFloat(getComputedStyle(chatEl).paddingLeft) || contentPadLeft;
    const chatRect = chatEl.getBoundingClientRect();
    const viewRect = host.getBoundingClientRect();
    // landing / 设置页挤压时 #chat 没有高度，尺子无处可放。
    if (chatRect.height < 120) {
      rail.style.display = 'none';
      return;
    }
    rail.style.display = '';
    // 位置：正文列左缘再往左一个尺子宽 + 14px 的呼吸位——落在左侧空白带
    // 里、靠内容那一侧，整体偏左上（Word 大纲窗格与正文的关系）。宽度用实测
    // 的 padding 而不是写死值：窄窗的左右内边距会从 32px 收到 14px。
    const contentLeft = chatRect.left + contentPadLeft;
    rail.style.top = `${Math.round(chatRect.top - viewRect.top + 12)}px`;
    rail.style.height = `${Math.round(chatRect.height - 24)}px`;
    // 窄到 #chat 宽满视口时（左内边距放不下尺子 + 呼吸位），停靠在视口左缘
    // 不再往左推——再往外会被 #chat-view 的 overflow 剪掉刻度。
    rail.style.left = `${Math.round(Math.max(2, contentLeft - viewRect.left - RAIL_WIDTH_PX - CONTENT_GAP_PX))}px`;
  };

  // 盒子度量只在 refresh 时读一次并缓存：滚动处理里读 scrollHeight/clientHeight
  // 会和上一帧写滑块样式交替，构成「写→读」的强制重排——长转写里每帧一次，
  // 快速翻动时就是那种节律性的卡。滚动路径只读 scrollTop（不触发布局）。
  const metrics = { scrollHeight: 0, clientHeight: 0, trackHeight: 0, maxScroll: 0 };
  let railShown = false;
  let thumbTop = -1;
  let thumbHeight = -1;

  const syncMetrics = (): void => {
    metrics.scrollHeight = chatEl.scrollHeight;
    metrics.clientHeight = chatEl.clientHeight;
    metrics.maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    maxScroll = metrics.maxScroll;
    const visible = shouldShowOutline(metrics.scrollHeight, metrics.clientHeight);
    if (railShown !== visible) {
      railShown = visible;
      rail.hidden = !visible;
    }
    // 轨道高度要在尺子可见时读，否则量到 0（display:none 的子树）。
    metrics.trackHeight = visible ? track.clientHeight : 0;
  };

  const paintThumb = (): void => {
    if (!railShown) return;
    const geometry = outlineThumbGeometry(
      chatEl.scrollTop, metrics.scrollHeight, metrics.clientHeight, metrics.trackHeight,
    );
    const top = Math.round(geometry.top);
    const height = Math.round(geometry.height);
    // 改 top 会让滑块的定位上下文失效布局，下一帧的度量读取又要为它重排一次；
    // transform 只走合成器。两处都先比较再写，滚动时多数帧其实只有一个值在变。
    if (top !== thumbTop) {
      thumbTop = top;
      thumb.style.transform = `translateY(${top}px)`;
    }
    if (height !== thumbHeight) {
      thumbHeight = height;
      thumb.style.height = `${height}px`;
    }
  };

  // 上一次画出来的刻度快照：一层没变时整轮只看字符串比较，不碰 DOM。
  let lastMarksKey = '';
  // 上一次全量测量的偏移（scrollTop 坐标）。流式只改尾部高度时这些偏移
  // 仍然成立，重画刻度只需要按新的 maxScroll 重映射，不必再扫一遍 DOM。
  let cachedMarks: OutlineMarkInput[] = [];
  // 用户气泡的文本只在追加那一刻定型；滚动/流式重测时反复读 textContent
  // 会把整段长文本再拼一遍。
  const labelCache = new WeakMap<HTMLElement, string>();
  const labelOf = (row: HTMLElement): string => {
    let label = labelCache.get(row);
    if (label === undefined) {
      label = row.textContent ?? '';
      labelCache.set(row, label);
    }
    return label;
  };

  const renderMarks = (marks: readonly OutlineMark[]): void => {
    const key = marks.map((m) => `${Math.round(m.offset)}:${Math.round(m.y)}:${m.kind}`).join(',');
    if (key === lastMarksKey) return;
    lastMarksKey = key;
    while (markEls.length > marks.length) markEls.pop()?.remove();
    for (let i = 0; i < marks.length; i++) {
      let el = markEls[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'transcript-ruler-mark';
        track.appendChild(el);
        markEls[i] = el;
      }
      const mark = marks[i];
      el.style.top = `${Math.round(mark.y)}px`;
      el.dataset.offset = String(Math.round(mark.offset));
      el.classList.toggle('is-group', mark.kind === 'group');
      el.title = markLabel(mark.label);
    }
  };

  const measureMarks = (): void => {
    const chatRect = chatEl.getBoundingClientRect();
    if (chatRect.height <= 0 || rail.hidden) return;
    // 轨道高度只在可见时量得到，而首帧 refresh 可能早于轨道完成布局；每次全量
    // 测量顺手校准一次（一次读数），否则会一直用 0 映射，尺子上一根刻度都没有。
    const trackHeight = track.clientHeight;
    if (trackHeight <= 0) return;
    metrics.trackHeight = trackHeight;
    const scrollTop = chatEl.scrollTop;
    const offsetOf = (el: HTMLElement): number | null => {
      const rect = el.getBoundingClientRect();
      // 隐藏会话的转写也挂在这个 #chat 里（多会话模式），它们的盒量是 0。
      if (rect.width <= 0 && rect.height <= 0) return null;
      return rect.top - chatRect.top + scrollTop;
    };

    const marks: OutlineMarkInput[] = [];
    const rows = chatEl.querySelectorAll<HTMLElement>('.bubble-row.user');
    const stride = Math.max(1, Math.ceil(rows.length / MAX_MEASURED_ROWS));
    for (let i = 0; i < rows.length; i += stride) {
      const row = rows[i];
      const offset = offsetOf(row);
      if (offset === null) continue;
      marks.push({ offset, label: labelOf(row), kind: 'turn' });
    }
    // 老历史按折叠组打点：组体泊车时组内每一轮的 DOM 不在文档里，量不到。
    // 组体挂载后组里已经有用户气泡，逐轮刻度接管，组刻度让位。
    for (const group of chatEl.querySelectorAll<HTMLElement>('.transcript-history-group')) {
      if (group.querySelector('.bubble-row.user')) continue;
      const offset = offsetOf(group);
      if (offset === null) continue;
      const summary = group.querySelector('.transcript-history-group-summary')?.textContent ?? '';
      marks.push({ offset, label: summary, kind: 'group' });
    }
    cachedMarks = marks;
    renderMarks(collapseOutlineMarks(marks, trackHeight, maxScroll));
  };

  // 节流而不是防抖：流式期间 DOM 一直在变，防抖会永远推后；节流保证每
  // MEASURE_INTERVAL_MS 最多量一轮，会话再长也有上限成本。
  const scheduleMeasure = (): void => {
    if (resizing || measureTimer !== null) return;
    const wait = Math.max(0, MEASURE_INTERVAL_MS - (Date.now() - lastMeasureAt));
    measureTimer = setTimeout(() => {
      measureTimer = null;
      lastMeasureAt = Date.now();
      measureMarks();
    }, wait);
  };

  /** 只重映射缓存偏移：流式尾部变高只改 maxScroll，旧偏移仍然有效。 */
  const repaintCachedMarks = (): void => {
    if (!railShown || cachedMarks.length === 0) return;
    renderMarks(collapseOutlineMarks(cachedMarks, metrics.trackHeight, maxScroll));
  };

  const scheduleCachedRepaint = (): void => {
    if (repaintTimer !== null || resizing) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      repaintCachedMarks();
    }, MEASURE_INTERVAL_MS);
  };

  /** 流式与尺子无关的 DOM 变化：只同步几何和滑块，刻度按缓存重映射。 */
  const refresh = (readPadding = false, remeasure = true): void => {
    const wasShown = railShown;
    layout(readPadding);
    syncMetrics();
    paintThumb();
    if (!railShown) return;
    // 刚从隐藏变可见时缓存是空的/过期的，必须走一次全量测量。
    if (remeasure || !wasShown) scheduleMeasure();
    else scheduleCachedRepaint();
  };

  /** 拖动窗口期间每个 ResizeObserver 回调都全量测量会堆出秒级卡顿：
   *  逐帧只做轨道几何与滑块，停手 RESIZE_SETTLE_MS 后再扫一次刻度。 */
  const onResize = (): void => {
    resizing = true;
    // 上一帧排队的测量/重画不能落进拖动中：那正是 0.5s 长任务的入口。
    if (measureTimer !== null) { clearTimeout(measureTimer); measureTimer = null; }
    if (repaintTimer !== null) { clearTimeout(repaintTimer); repaintTimer = null; }
    if (resizeSettleTimer !== null) clearTimeout(resizeSettleTimer);
    resizeSettleTimer = setTimeout(() => {
      resizeSettleTimer = null;
      resizing = false;
      refresh(true);
    }, RESIZE_SETTLE_MS);
    if (typeof requestAnimationFrame !== 'function') {
      refresh(true, false);
      return;
    }
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      // 拖动中只做便宜的部分：padding 首帧读一次，后续帧沿用缓存。
      refresh(false, false);
    });
  };

  /**
   * 跳转就是一次 scrollTop 赋值：不滚动画（长会话动画几十帧等于把中间内容
   * 逐帧拖过合成器），也不手动挂载途经的分组——大位移会被 fling 判据吃掉，
   * 落点由观察器按需挂载，这正是「直达目的、中间不渲染」。
   */
  const jumpTo = (offset: number): void => {
    chatEl.scrollTop = Math.min(maxScroll, Math.max(0, offset));
  };

  topCap.addEventListener('click', () => jumpTo(0));
  // 回底端走共享的钉底入口：它同时把「跟最新」重新钉上，否则下一次流式
  // 内容不会再自动跟下来。
  bottomCap.addEventListener('click', () => forceScrollToBottom(chatEl));

  track.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.transcript-ruler-mark') : null;
    if (target?.dataset.offset) {
      jumpTo(Number(target.dataset.offset) - OUTLINE_JUMP_ALIGN_PX);
      return;
    }
    // 空白处按比例落位（尺子兼作滚动条）：与滑块同一套坐标，点哪儿去哪儿。
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (event.clientY - rect.top) / rect.height;
    jumpTo(ratio * maxScroll);
  });

  /** 滚动停下后再量刻度：滚动本身不改变任何刻度位置，滚动中重量只是把上千
   *  次 rect 读塞进甩动里——而每次读都可能接着流式写入触发整列重排，正是
   *  「快速翻动时一顿一顿」的那个来源。停手 180ms 后一次量完。 */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const SCROLL_SETTLE_MS = 180;
  const scheduleMeasureAfterSettle = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      scheduleMeasure();
    }, SCROLL_SETTLE_MS);
  };

  chatEl.addEventListener('scroll', () => {
    if (typeof requestAnimationFrame !== 'function') {
      paintThumb();
      scheduleMeasureAfterSettle();
      return;
    }
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      // 滚动只动滑块：尺子的 left/top/height 只跟 #chat 的盒子有关，滚动期
      // 间重算等于每帧多几次无意义的盒子读。
      paintThumb();
      // 钉底跟直播时不必重测：旧刻度的内容坐标是稳的（上方内容高度不变），
      // 只有尾部几轮会有偏差，用户一往上翻就会再量一轮。
      if (!isElementPinnedToBottom(chatEl)) scheduleMeasureAfterSettle();
    });
  }, { passive: true });

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(onResize);
    observer.observe(chatEl);
    observer.observe(host);
  } else {
    window.addEventListener('resize', onResize);
  }

  if (typeof MutationObserver === 'function') {
    // 只看 childList 与 hidden 属性：流式 token 是 characterData，跟着它摇会
    // 白量几百次。hidden 是多会话切会话的信号（各会话的转写宿主同为 #chat
    // 子节点，切换只翻 hidden，不产生 childList），不跟就会沿用上一个会话的
    // 刻度。
    // 一帧最多刷一次：流式追加经常一帧好几处 childList，观察器直接调 refresh
    // 就是每处各读一遍盒子。
    let refreshFrame = 0;
    // 只有会移动刻度锚点的结构变化才全量测量：流式追加的 assistant 块只改
    // 尾部高度，用缓存偏移重映射即可；每 350ms 扫全部用户回合正是长会话在
    // 流式 + resize 时卡死的来源。
    const STRUCTURAL = '.bubble-row.user, .transcript-history-group';
    const needsMeasure = (records: MutationRecord[]): boolean => records.some((record) => {
      if (record.type === 'attributes') return true;
      if (record.type !== 'childList') return false;
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches(STRUCTURAL) || el.querySelector(STRUCTURAL)) return true;
      }
      return false;
    });
    const observer = new MutationObserver((records) => {
      const structural = needsMeasure(records);
      if (typeof requestAnimationFrame !== 'function') {
        refresh(false, structural);
        return;
      }
      if (refreshFrame) return;
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = 0;
        refresh(false, structural);
      });
    });
    observer.observe(chatEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  refresh(true);
}
