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
  options?: { yieldBeforeParse?: boolean },
): Promise<void> {
  return loadMarkdown()
    .then((module) => module.renderMarkdown(text, container, options))
    .catch(() => {
      // Keep the assistant message readable if the optional renderer chunk is
      // unavailable; the next completed message can retry the import.
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
  void loadMarkdown()
    .then((module) => {
      if (streamGenerations.get(container) !== generation) return;
      module.scheduleStreamingRender(text, container, onRendered);
    })
    .catch(() => {
      // The caller already keeps the raw streaming text in the bubble.
    });
}

export function cancelStreamingRender(container: HTMLElement): void {
  streamGenerations.set(container, (streamGenerations.get(container) ?? 0) + 1);
  // Cancelling before the first render must not download the optional markdown
  // renderer just to clear a state object that does not exist yet.
  markdownModule?.cancelStreamingRender(container);
}
