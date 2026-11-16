import { stripToolCallXml as stripToolCallXmlCore } from './markdownCore';

type MarkdownModule = typeof import('./markdown');

let markdownModule: MarkdownModule | null = null;
let markdownModulePromise: Promise<MarkdownModule> | null = null;
const streamGenerations = new WeakMap<HTMLElement, number>();

function loadMarkdown(): Promise<MarkdownModule> {
  if (markdownModule) return Promise.resolve(markdownModule);
  if (!markdownModulePromise) {
    markdownModulePromise = import('./markdown')
      .then((module) => {
        markdownModule = module;
        return module;
      })
      .catch((error) => {
        markdownModulePromise = null;
        throw error;
      });
  }
  return markdownModulePromise;
}

export function stripToolCallXml(text: string): string {
  return stripToolCallXmlCore(text);
}

export function renderMarkdown(
  text: string,
  container: HTMLElement,
  options?: { yieldBeforeParse?: boolean; visualTiming?: 'serial' | 'parallel' },
): Promise<void> {
  return loadMarkdown()
    .then((module) => module.renderMarkdown(text, container, options))
    .catch((error) => {
      // Keep the assistant message readable if the renderer is unavailable;
      // the next completed message can retry the import.
      // 2026-11-16 bug2：这个兜底此前连「渲染管线自身抛错」（md.parse /
      // DOMPurify / 图卡管线）也一并吞掉——整条气泡静默变回 markdown 源码，
      // 无日志、本条不再重试，复现时无法归因。至少留一行错误现场。
      if (typeof console !== 'undefined') {
        console.error(`[markdown] render failed → degraded fallback (len=${text.length})`, error);
      }
      // 二刀：先试最小渲染（parse + sanitize），保住标题/粗体/代码围栏的
      // 成形；只有连 parse 都失败（或模块没加载）才退回纯原文。
      try {
        if (markdownModule?.renderMarkdownFallback(text, container)) return;
      } catch {
        /* fall through to raw text */
      }
      container.textContent = text;
    });
}

export function scheduleStreamingRender(
  text: string,
  container: HTMLElement,
  onRendered?: () => void,
): void {
  const generation = (streamGenerations.get(container) ?? 0) + 1;
  streamGenerations.set(container, generation);
  if (markdownModule) {
    markdownModule.scheduleStreamingRender(text, container, onRendered);
    return;
  }
  void loadMarkdown()
    .then((module) => {
      if (streamGenerations.get(container) !== generation) return;
      module.scheduleStreamingRender(text, container, onRendered);
    })
    .catch(() => {
      // The caller already keeps the raw streaming text in the bubble.
    });
}

export function flushStreamingRender(container: HTMLElement, fallbackText = ''): void {
  if (markdownModule) {
    markdownModule.flushStreamingRender(container);
    return;
  }
  // If the optional renderer has not finished loading yet, preserve the full
  // latest text before the pending import is invalidated by cancellation.
  if (fallbackText) container.textContent = fallbackText;
}

export function cancelStreamingRender(container: HTMLElement): void {
  streamGenerations.set(container, (streamGenerations.get(container) ?? 0) + 1);
  // Cancelling before the first render must not download the optional markdown
  // renderer just to clear a state object that does not exist yet.
  markdownModule?.cancelStreamingRender(container);
}

// ── 块级流式渲染（streamingRender=false 的形态，2026-11-16）────────────
// 模块未就绪时先把原文直出（与旧行为一致），加载完成后由下一拍接管；
// 已就绪时交给 markdown.ts 的调度器（闭合块渲染 + 尾段原文增量）。
const pendingBlockText = new WeakMap<HTMLElement, string>();

export function scheduleBlockRender(
  text: string,
  container: HTMLElement,
  onRendered?: () => void,
): void {
  pendingBlockText.set(container, text);
  if (markdownModule) {
    markdownModule.scheduleBlockRender(text, container, onRendered);
    return;
  }
  if (container.textContent !== text) container.textContent = text;
  void loadMarkdown()
    .then((module) => {
      const latest = pendingBlockText.get(container);
      if (latest === undefined) return;
      module.scheduleBlockRender(latest, container, onRendered);
    })
    .catch(() => {
      /* 原文已直出，模块加载失败就是旧行为 */
    });
}

export function flushBlockRender(container: HTMLElement): void {
  if (markdownModule) {
    markdownModule.flushBlockRender(container);
    return;
  }
  const latest = pendingBlockText.get(container);
  if (latest) container.textContent = latest;
}

export function cancelBlockRender(container: HTMLElement): void {
  pendingBlockText.delete(container);
  markdownModule?.cancelBlockRender(container);
}
