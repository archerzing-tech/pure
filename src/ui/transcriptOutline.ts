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
/** 单次测量最多扫描的用户气泡数（超长会话按等距抽样，读数成本封顶）。 */
const MAX_MEASURED_ROWS = 1200;
/** 刻度测量节流窗口：流式期间 DOM 每几拍就变，重新量一轮不必每次变更都做。 */
const MEASURE_INTERVAL_MS = 350;
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

  const paintThumb = (): void => {
    const scrollHeight = chatEl.scrollHeight;
    const clientHeight = chatEl.clientHeight;
    maxScroll = Math.max(0, scrollHeight - clientHeight);
    rail.hidden = !shouldShowOutline(scrollHeight, clientHeight);
    if (rail.hidden) return;
    // 轨道高度要在去掉 hidden 之后读，否则量到 0（display:none 的子树）。
    const geometry = outlineThumbGeometry(chatEl.scrollTop, scrollHeight, clientHeight, track.clientHeight);
    thumb.style.top = `${Math.round(geometry.top)}px`;
    thumb.style.height = `${Math.round(geometry.height)}px`;
  };

  const renderMarks = (marks: readonly OutlineMark[]): void => {
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
      marks.push({ offset, label: row.textContent ?? '', kind: 'turn' });
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
    renderMarks(collapseOutlineMarks(marks, track.clientHeight, maxScroll));
  };

  // 节流而不是防抖：流式期间 DOM 一直在变，防抖会永远推后；节流保证每
  // MEASURE_INTERVAL_MS 最多量一轮，会话再长也有上限成本。
  const scheduleMeasure = (): void => {
    if (measureTimer !== null) return;
    const wait = Math.max(0, MEASURE_INTERVAL_MS - (Date.now() - lastMeasureAt));
    measureTimer = setTimeout(() => {
      measureTimer = null;
      lastMeasureAt = Date.now();
      measureMarks();
    }, wait);
  };

  const refresh = (readPadding = false): void => {
    layout(readPadding);
    paintThumb();
    if (!rail.hidden) scheduleMeasure();
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

  chatEl.addEventListener('scroll', () => {
    if (typeof requestAnimationFrame !== 'function') {
      paintThumb();
      return;
    }
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      // 滚动只动滑块：尺子的 left/top/height 只跟 #chat 的盒子有关，滚动期
      // 间重算等于每帧多两次无意义的盒子读。
      paintThumb();
      // 钉底跟直播时不重测：旧刻度的内容坐标是稳的（上方内容高度不变），
      // 只有尾部几轮会有偏差，用户一往上翻就会再量一轮。
      if (!isElementPinnedToBottom(chatEl)) scheduleMeasure();
    });
  }, { passive: true });

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => refresh(true));
    observer.observe(chatEl);
    observer.observe(host);
  } else {
    window.addEventListener('resize', () => refresh(true));
  }

  if (typeof MutationObserver === 'function') {
    // 只看 childList 与 hidden 属性：流式 token 是 characterData，跟着它摇会
    // 白量几百次。hidden 是多会话切会话的信号（各会话的转写宿主同为 #chat
    // 子节点，切换只翻 hidden，不产生 childList），不跟就会沿用上一个会话的
    // 刻度。
    const observer = new MutationObserver(() => refresh());
    observer.observe(chatEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  refresh(true);
}
