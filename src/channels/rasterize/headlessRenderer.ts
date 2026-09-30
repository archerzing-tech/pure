// src/channels/rasterize/headlessRenderer.ts
// 富输出降级矩阵里最难的一格：```mermaid / ```puml 光栅化成 PNG。
//
// 两者都必须在真实浏览器里跑 —— mermaid 依赖真实 SVG 测量（happy-dom 下
// `render()` 只返回空字符串），PlantUML 的 TeaVM 引擎在 happy-dom 下直接挂死。
// 所以这里的路线是：headless Chrome 渲出 SVG（复用 UI 同一批引擎与同一份
// 离线语义）→ `@resvg/resvg-js` 光栅化成 PNG → 交给通道适配器的 `sendImage`。
//
// 能力是「可选的」：找不到 Chrome 时**不返回** mermaidToPng / pumlToPng，让
// richOutput 走「没有可用的 headless 渲染器」的降级分支。渲染中途失败则返回
// null，走「渲染失败」分支。两条路都不让附件生成拖垮回复本身。
import type { RichRenderers } from '../richOutput';
import { buildBrowserBundle, resolveModuleEntry } from './browserBundle';
import { HeadlessChrome, findChromePath } from './headlessChrome';
import { createLocalRichRenderers, rasterizeSvg } from './localRenderer';

export interface HeadlessRendererOptions {
  /** 显式指定 Chrome 可执行文件（缺省按平台探测）。 */
  chromePath?: string;
  /**
   * 空多久后关掉 Chrome（毫秒，默认 5 分钟；0 = 不自动关）。
   * 渲图是偶发的，但常驻一个 Chromium 会白占上百 MB —— 下一次用到再重启。
   */
  idleTimeoutMs?: number;
  log?: (message: string) => void;
}

export type GatewayRichRenderers = RichRenderers & { dispose?: () => void };

const RENDER_GLOBAL = 'globalThis.__pureRender';

/** mermaid 的入口：关掉自动扫描，只暴露 render()。 */
function mermaidEntry(): string {
  const entry = resolveModuleEntry('mermaid');
  return [
    `import mermaid from ${JSON.stringify(entry)};`,
    'mermaid.initialize({ startOnLoad: false });',
    `Object.assign(${RENDER_GLOBAL} || (${RENDER_GLOBAL} = {}), { mermaid });`,
  ].join('\n');
}

/** PlantUML 的入口：只暴露渲染函数，引擎状态与 stdlib 由页面侧控制。 */
function pumlEntry(): string {
  const entry = resolveModuleEntry('@plantuml/core');
  return [
    `import { renderToString } from ${JSON.stringify(entry)};`,
    `Object.assign(${RENDER_GLOBAL} || (${RENDER_GLOBAL} = {}), { puml: renderToString });`,
  ].join('\n');
}

/**
 * 归一化 PlantUML 源码成引擎要的行数组：补上模型常忘的 @startuml/@enduml。
 * 与 `src/ui/plantumlDiagram.ts` 的 normalizePlantumlSource 同一目标，但这里保持
 * 纯字符串处理 —— gateway 侧不该为几张图把 UI 模块（及其 i18n/DOM 依赖）拖进来。
 */
export function normalizePlantumlSource(source: string): string[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return [];
  const hasStart = lines.some((line) => line.trim().startsWith('@start'));
  const hasEnd = lines.some((line) => line.trim().startsWith('@end'));
  if (!hasStart && !hasEnd) return ['@startuml', ...lines, '@enduml'];
  if (!hasStart) return ['@startuml', ...lines];
  if (!hasEnd) return [...lines, '@enduml'];
  return lines;
}

/**
 * 建一个 headless 渲染器。没有 Chrome 就返回空对象 —— 调用方据此知道
 * mermaid/puml 这一格仍然走文本降级。
 */
export function createHeadlessRichRenderers(options: HeadlessRendererOptions = {}): GatewayRichRenderers {
  const log = options.log;
  if (!findChromePath(options.chromePath)) {
    log?.('mermaid/puml rasterization unavailable: no Chrome executable found (set PURE_CHROME_PATH to override)');
    return {};
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  let session: Promise<HeadlessChrome> | null = null;
  const injected = new Set<'mermaid' | 'puml'>();
  let renderSeq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // PlantUML 引擎共享内部状态，mermaid 也有全局配置：所有渲染串行。
  let queue: Promise<unknown> = Promise.resolve();

  function chrome(): Promise<HeadlessChrome> {
    if (!session) {
      session = HeadlessChrome.launch({ chromePath: options.chromePath, log }).catch((err: unknown) => {
        session = null; // 下次调用重试，不把一次启动失败变成永久降级
        throw err;
      });
    }
    return session;
  }

  function closeSession(reason: string): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const pending = session;
    session = null;
    injected.clear();
    if (!pending) return;
    log?.(`closing headless Chrome (${reason})`);
    void pending.then((browser) => browser.close()).catch(() => undefined);
  }

  function scheduleIdleClose(): void {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => closeSession('idle'), idleTimeoutMs);
    idleTimer.unref?.();
  }

  function serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(() => scheduleIdleClose(), () => scheduleIdleClose());
    return run;
  }

  async function inject(kind: 'mermaid' | 'puml'): Promise<HeadlessChrome> {
    const browser = await chrome();
    if (injected.has(kind)) return browser;
    const code = await buildBrowserBundle(kind, kind === 'mermaid' ? mermaidEntry() : pumlEntry());
    if (kind === 'puml') {
      // 引擎会去拿 themes/emoji/openiconic 这些 stdlib bundle；不打包它们，
      // 但必须显式失败 —— 否则引擎会去建一个远端 <script>，在离线的
      // headless 页面里变成一次注定失败的等待。
      await browser.evaluate(
        `globalThis.PLANTUML_STDLIB_LOADER = function (name, ok, fail) { fail('stdlib not bundled: ' + name); return true; };`,
      );
    }
    await browser.evaluate(code);
    injected.add(kind);
    log?.(`${kind} renderer injected into headless Chrome`);
    return browser;
  }

  return {
    async mermaidToPng(source: string): Promise<Uint8Array | null> {
      return serialize(async () => {
        try {
          const browser = await inject('mermaid');
          const id = `pure_mermaid_${++renderSeq}`;
          const svg = await browser.evaluate<string>(
            `${RENDER_GLOBAL}.mermaid.render(${JSON.stringify(id)}, ${JSON.stringify(source)}).then(function (r) { return r.svg; })`,
          );
          if (!svg) return null;
          return await rasterizeSvg(svg);
        } catch (err) {
          log?.(`mermaid rasterization failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      });
    },

    async pumlToPng(source: string): Promise<Uint8Array | null> {
      return serialize(async () => {
        try {
          const browser = await inject('puml');
          const lines = normalizePlantumlSource(source);
          if (lines.length === 0) return null;
          const svg = await browser.evaluate<string>(
            `new Promise(function (resolve, reject) { ${RENDER_GLOBAL}.puml(${JSON.stringify(lines)},` +
            ` function (svg) { resolve(svg); }, function (err) { reject(new Error(String(err))); }); })`,
          );
          if (!svg) return null;
          return await rasterizeSvg(svg);
        } catch (err) {
          log?.(`puml rasterization failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      });
    },

    dispose(): void {
      closeSession('gateway stopped');
    },
  };
}

/** gateway 的默认渲染器：DOM-free 的 chart/svg + 可选的 headless mermaid/puml。 */
export function createDefaultRichRenderers(options: HeadlessRendererOptions = {}): GatewayRichRenderers {
  return { ...createLocalRichRenderers(), ...createHeadlessRichRenderers(options) };
}
