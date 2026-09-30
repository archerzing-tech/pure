// src/channels/projection/browserProjection.ts
// 「通道里看到的样子 = 桌面端的样子」的执行体。
//
// 做法是把**桌面端自己的渲染管线**搬进一个 headless 页面：同一份
// `src/ui/markdown.ts`（marked + hljs + DOMPurify + mermaid + echarts + plantuml）
// 打包成浏览器 bundle，同一份 `src/ui/styles.css`，同一个 DOM 层级
// （#app-shell → #main → #view-container → #chat-view → main#chat → .bubble-row
// .assistant > .bubble），再按桌面端聊天列的同一宽度（1120 − 2×48 = 1024 CSS px）
// 出图。所以这里没有「把样式翻译成另一套」的部分 —— 图就是那块 DOM 的截图。
//
// 与桌面端的两处**有意差异**（用户明确要求「表现一样、但去掉交互」）：
//  1. 固定浅色（`data-theme="light"`）：IM 聊天背景普遍是浅色，深色卡片很突兀；
//  2. 截图前拆掉所有交互件（复制/保存按钮、图表控制条），只留视觉。
//
// 截图受 Chromium 的一条硬限制约束：超过 8192px 的输出会损坏（issue 40724721），
// 所以先按 2× 出图，太高就退回 1×，仍然过高则拒绝并让调用方降级。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBrowserBundle } from '../rasterize/browserBundle';
import { HeadlessChrome, findChromePath } from '../rasterize/headlessChrome';

export interface ProjectionPageOptions {
  chromePath?: string;
  log?: (message: string) => void;
  /** 空闲多久关掉 Chrome（毫秒，默认 5 分钟；0 = 不自动关）。 */
  idleTimeoutMs?: number;
  /** 桌面端聊天列的内容宽度（#chat 1120 − padding 48×2）。 */
  contentWidth?: number;
  /** 出图倍率（默认 2×，长块自动退回 1×）。 */
  pixelRatio?: number;
}

export interface ProjectionPage {
  /** 把一段 markdown 渲染成与桌面端同款的 PNG；失败返回 null。 */
  render(markdown: string): Promise<Uint8Array | null>;
  dispose(): void;
}

const DEFAULT_CONTENT_WIDTH = 1024;
const CHROME_LIMIT_PX = 8192;

function markdownBundleEntry(): string {
  const entry = fileURLToPath(new URL('../../ui/markdown.ts', import.meta.url));
  return [
    `import { renderMarkdown } from ${JSON.stringify(entry)};`,
    'Object.assign(globalThis.__pureProjection || (globalThis.__pureProjection = {}), { renderMarkdown });',
  ].join('\n');
}

/** 桌面端样式表原文；`</style` 会被转义，免得把注入的 style 元素提前闭合。 */
function readProjectionStyles(): string {
  const css = readFileSync(new URL('../../ui/styles.css', import.meta.url), 'utf8');
  return css.replace(/<\/style/gi, '<\\/style');
}

function frameOverrideCss(contentWidth: number): string {
  // 桌面端把聊天列交给 #app-shell/#view-container 的 app 布局（grid + 侧栏）去定宽；
  // 投影页没有侧栏，所以直接把 #chat 钉成同一列宽，让截图取到的是同一把尺子。
  const columnWidth = contentWidth + 96; // #chat 的左右 padding（48×2）
  return `
html, body { height: auto !important; min-height: 0 !important; margin: 0 !important; overflow: visible !important; }
#app-shell, #main, #view-container, #chat-view { display: block !important; height: auto !important; overflow: visible !important; padding: 0 !important; }
#chat {
  display: flex !important;
  height: auto !important;
  overflow: visible !important;
  width: ${columnWidth}px !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 48px !important;
  box-sizing: content-box !important;
}
#pure-projection { animation: none !important; }
`;
}

const FRAME_HTML = [
  '<div id="app-shell"><div id="main"><div id="view-container"><div id="chat-view"><main id="chat">',
  '<div class="bubble-turn"><div class="bubble-row assistant">',
  '<div class="bubble md-rendered" id="pure-projection"></div>',
  '</div></div>',
  '</main></div></div></div></div>',
].join('');

/** 只读投影：截图前拆掉所有交互件（复制/保存按钮、图表控制条）。 */
const STRIP_INTERACTIVE = `(function () {
  var el = document.getElementById('pure-projection');
  var selectors = 'button, .diagram-controls, .chart-controls, .svg-controls, .mermaid-controls, .puml-controls, .map-controls, .code-copy-btn';
  Array.prototype.forEach.call(el.querySelectorAll(selectors), function (node) { node.remove(); });
  return true;
})()`;

const MEASURE = `(function () {
  var el = document.getElementById('pure-projection');
  var rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 建一个投影页。找不到 Chrome 就返回 null —— 调用方据此退回「只发文本」。
 */
export function createProjectionPage(options: ProjectionPageOptions = {}): ProjectionPage | null {
  const log = options.log;
  if (!findChromePath(options.chromePath)) {
    log?.('channel projection unavailable: no Chrome executable found (set PURE_CHROME_PATH to override)');
    return null;
  }

  const contentWidth = options.contentWidth ?? DEFAULT_CONTENT_WIDTH;
  const pixelRatio = options.pixelRatio ?? 2;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  // 视口只要容得下 #chat 那一列即可（列宽由 frameOverrideCss 显式钉住；
  // 留出余量，免得横向滚动条参与布局）。
  const viewportWidth = contentWidth + 200;

  let chromePromise: Promise<HeadlessChrome> | null = null;
  let ready: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  function chrome(): Promise<HeadlessChrome> {
    if (!chromePromise) {
      chromePromise = HeadlessChrome.launch({ chromePath: options.chromePath, log }).catch((err: unknown) => {
        chromePromise = null;
        throw err;
      });
    }
    return chromePromise;
  }

  function closePage(reason: string): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const pending = chromePromise;
    chromePromise = null;
    ready = null;
    if (!pending) return;
    log?.(`closing projection page (${reason})`);
    void pending.then((browser) => browser.close()).catch(() => undefined);
  }

  function scheduleIdleClose(): void {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => closePage('idle'), idleTimeoutMs);
    idleTimer.unref?.();
  }

  function serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(() => scheduleIdleClose(), () => scheduleIdleClose());
    return run;
  }

  /** 一次性装配：视口 + 桌面端样式 + DOM 骨架 + markdown 渲染管线。 */
  async function ensureReady(): Promise<HeadlessChrome> {
    const browser = await chrome();
    if (!ready) {
      ready = (async () => {
        await browser.cdp('Emulation.setDeviceMetricsOverride', {
          width: viewportWidth,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const styles = readProjectionStyles();
        await browser.evaluate(
          `(function (css, frameCss, html) {` +
          `  document.documentElement.setAttribute('data-theme', 'light');` +
          `  document.head.innerHTML = '<meta charset="utf-8"><style>' + css + '</style><style>' + frameCss + '</style>';` +
          `  document.body.innerHTML = html;` +
          `})( ${JSON.stringify(styles)}, ${JSON.stringify(frameOverrideCss(contentWidth))}, ${JSON.stringify(FRAME_HTML)} )`,
        );
        const bundle = await buildBrowserBundle('ui-markdown-projection', markdownBundleEntry());
        await browser.evaluate(bundle);
        log?.(`projection page ready (${viewportWidth}px viewport, markdown pipeline injected)`);
      })().catch((err: unknown) => {
        ready = null;
        throw err;
      });
    }
    await ready;
    return browser;
  }

  return {
    async render(markdown: string): Promise<Uint8Array | null> {
      return serialize(async () => {
        try {
          const browser = await ensureReady();
          await browser.evaluate(
            `(function () { var el = document.getElementById('pure-projection'); el.innerHTML = ''; el.classList.remove('md-rendered'); return true; })()`,
          );
          await browser.evaluate(
            `globalThis.__pureProjection.renderMarkdown(${JSON.stringify(markdown)}, ` +
            `document.getElementById('pure-projection'), { yieldBeforeParse: false })`,
          );
          // 字体加载会影响换行与高度，量尺寸前先等它稳定。
          await browser.evaluate(`document.fonts.ready.then(function () { return true; })`);
          await browser.evaluate(STRIP_INTERACTIVE);
          let rect = await browser.evaluate<Rect>(MEASURE);
          if (!rect || rect.width < 1 || rect.height < 1) return null;

          let scale = pixelRatio;
          if (rect.height * scale > CHROME_LIMIT_PX) scale = 1;
          if (rect.height * scale > CHROME_LIMIT_PX) {
            log?.(`projection block too tall to rasterize (${Math.round(rect.height)}px) — falling back to text`);
            return null;
          }
          rect = { ...rect, width: Math.min(rect.width, contentWidth) };

          const shot = await browser.cdp('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
          });
          const data = shot.data;
          if (typeof data !== 'string' || data.length === 0) return null;
          return new Uint8Array(Buffer.from(data, 'base64'));
        } catch (err) {
          log?.(`projection render failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      });
    },

    dispose(): void {
      closePage('closed');
    },
  };
}
