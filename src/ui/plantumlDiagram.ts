// src/ui/plantumlDiagram.ts
// Offline PlantUML renderer for ```puml / ```plantuml blocks.
//
// The engine is the official PlantUML build compiled to JavaScript with TeaVM
// (@plantuml/core) plus its Graphviz layout (Viz.js). Both run inside the
// WebView: no plantuml.com request, no Java, no CDN — which is the whole point,
// because the previous online route (an <img> pointing at the public PlantUML
// server) renders a blank card the moment the machine has no usable network,
// sits behind a proxy, or plantuml.com is unreachable.
//
// This module is the ONLY place the engine is imported, and it is loaded
// lazily (dynamic import from markdown.ts) so its ~6MB of engine + layout
// chunks never touch startup — the cost is paid once, on the first ```puml
// block of the session.
//
// Two engine constraints shape this module:
//  1. viz-global.js publishes the global `Viz` and must be present as a
//     CLASSIC script before the engine runs, so it is served from the app
//     (vite.config.ts emits it to /plantuml/viz-global.js, with a dev
//     middleware reading it straight out of node_modules) and injected once.
//  2. Renders share internal engine state and must be SERIALIZED — a second
//     render started while the first is in flight silently overwrites it — so
//     every call goes through one promise queue.

import { t } from '../shared/i18n';
import { normalizePlantumlSource } from '../shared/plantumlSource';

// 归一化单源在 shared/plantumlSource.ts（2026-10-31 审计 P2-5）；这里再导出，
// 图内聊天的既有导入方不受影响。
export { normalizePlantumlSource };

/** Where viz-global.js is served from (see the plantumlAssets plugin). */
const VIZ_SCRIPT_URL = '/plantuml/viz-global.js';

type RenderToString = (
  lines: string[],
  onSuccess: (svg: string) => void,
  onError: (message: string) => void,
  options?: { dark?: boolean },
) => void;

export interface PlantumlRenderOptions {
  /** Render with the engine's dark palette (matches the app's dark theme). */
  dark?: boolean;
}

// Bundles the engine pulls in through PLANTUML_STDLIB_LOADER. Each one is an
// IIFE that publishes its data on a window global, so importing the local
// module registers it exactly like the script tag the engine would have built
// — minus the network round trip. They stay separate lazy chunks: a diagram
// that never uses emoji never pays for it.
const LOCAL_BUNDLES: Record<string, () => Promise<unknown>> = {
  'themes.js': () => import('@plantuml/core/themes.js'),
  'emoji.js': () => import('@plantuml/core/emoji.js'),
  'openiconic.js': () => import('@plantuml/core/openiconic.js'),
};

interface BundleLoaderHost {
  PLANTUML_STDLIB_LOADER?: (name: string, ok: () => void, fail: (message?: string) => void) => boolean;
}

/**
 * Route every engine bundle request to a local module. Standard-library
 * includes (`!include <C4/C4_Context>`, AWS/Azure/IBM sprites, …) are not part
 * of this package — failing them HERE is what keeps rendering network-free:
 * the diagram reports the missing include instead of hanging on a request that
 * cannot succeed offline. Returning true marks the request as handled, so the
 * engine never falls back to building a <script src> for a remote URL.
 */
function installBundleLoader(): void {
  const host = globalThis as typeof globalThis & BundleLoaderHost;
  host.PLANTUML_STDLIB_LOADER = (name, ok, fail) => {
    const request = name.split('/').pop() ?? name;
    const load = LOCAL_BUNDLES[request];
    if (load) {
      load().then(
        () => ok(),
        (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
      );
      return true;
    }
    fail(`${t('diagram.pumlStdlibUnavailable')} (${name})`);
    return true;
  };
}

let vizPromise: Promise<void> | null = null;

/**
 * Inject viz-global.js once, as a classic script (the engine reads the global
 * `Viz` it publishes). A failed load is deliberately non-fatal: the engine
 * falls back to its own Smetana layout engine, so most diagram types still
 * render even if this asset is missing.
 */
function ensureViz(): Promise<void> {
  const host = globalThis as typeof globalThis & { Viz?: { instance?: unknown } };
  if (host.Viz && typeof host.Viz.instance === 'function') return Promise.resolve();
  if (!vizPromise) {
    vizPromise = new Promise<void>((resolve) => {
      if (typeof document === 'undefined') {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = VIZ_SCRIPT_URL;
      script.async = true;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => {
        console.warn('[pure] PlantUML: viz-global.js unavailable, using the built-in layout engine');
        resolve();
      }, { once: true });
      document.head.appendChild(script);
    });
  }
  return vizPromise;
}

let enginePromise: Promise<RenderToString> | null = null;

async function loadEngine(): Promise<RenderToString> {
  installBundleLoader();
  await ensureViz();
  const engine = await import('@plantuml/core');
  return engine.renderToString;
}

function ensureEngine(): Promise<RenderToString> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((error: unknown) => {
      // A failed import must stay retryable: nothing is cached, so the next
      // puml block (or the slot's 重试 button) tries again.
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

// One queue for every render: the engine's internal state is shared, so a
// concurrent render would overwrite the SVG another call is waiting for.
let renderQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Render a ```puml source to SVG entirely locally. Resolves with the SVG
 * document the engine produced (which, for a syntax error, is PlantUML's own
 * error picture — that is the engine's contract, and a readable failure beats
 * a blank card). Rejects only when the engine itself cannot run.
 */
export function renderPlantumlToSvg(source: string, options: PlantumlRenderOptions = {}): Promise<string> {
  const lines = normalizePlantumlSource(source);
  if (lines.length === 0) return Promise.reject(new Error(t('diagram.pumlEmptySource')));
  return serialize(async () => {
    const renderToString = await ensureEngine();
    return new Promise<string>((resolve, reject) => {
      try {
        renderToString(
          lines,
          (svg) => resolve(svg),
          (message) => reject(new Error(message || t('diagram.renderFailed'))),
          options.dark ? { dark: true } : undefined,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
