// src/tools/impl/browser.ts
// Single-source implementation of the browser/screenshot tools (W4 visual
// loop): drive one shared headless Chrome — navigate, click, type, evaluate,
// screenshot — over bare CDP, the same zero-dependency pattern as
// channels/rasterize (system Chrome + WebSocket, no puppeteer/playwright).
// This module imports NOTHING from node — fetch/WebSocket/JSON-logic only —
// so it runs identically in Bun (CLI) and the WebView (GUI); the shipped CSP
// already allows loopback http/ws in connect-src. Everything that touches
// the OS (executable probing, Chrome spawn + stderr port parsing, throwaway
// profile dir, artifact persistence) lives behind ToolRuntime primitives.
// No external debugging port is ever bound: Chrome gets
// --remote-debugging-port=0 and the kernel picks a loopback port.
// Session model: one Chrome instance per process, kept warm between tool
// calls (navigation state is the point), closed after 5 idle minutes. A
// dead CDP connection (Chrome crashed or was killed) is rebuilt on the next
// call; page-level errors (bad URL, missing selector) do NOT tear the
// session down. A WebView refresh dropping module state can orphan a Chrome
// — the leftover process idles on a host-managed throwaway profile and is
// harmless; the accepted leak window is in the blueprint.
// 安全面裁定（蓝图 W4）：不做 SSRF/私网拒绝——与文件工具「绝对路径全盘可
// 达」同一契约，localhost/file:// 恰是「改→截→判→修」的核心场景。唯一的
// 纪律是不绑定外部调试端口（port=0）。

import { CdpSession } from '../../channels/rasterize/cdpSession';
import { allChromeCandidates } from '../../channels/rasterize/chromeCandidates';
import type { ToolRuntime } from '../runtime';

const IDLE_CLOSE_MS = 5 * 60_000;
/** Page.loadEventFired deadline for navigate; some pages never settle. */
const LOAD_TIMEOUT_MS = 20_000;
/** Viewport for screenshots (matches the channel rasterizer's window). */
const VIEWPORT = { width: 1400, height: 900 };

export const CHROME_NOT_FOUND_HINT =
  'no usable Chrome/Chromium found — install Google Chrome (or set PURE_CHROME_PATH to its executable)';

interface BrowserSession {
  session: CdpSession;
}

let sharedSession: BrowserSession | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeSharedSession();
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

export function closeSharedSession(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!sharedSession) return;
  // Browser.close makes Chrome tear itself down (and the host's wait task
  // then cleans the throwaway profile dir); send is best-effort.
  try {
    void sharedSession.session.send('Browser.close');
  } catch { /* best effort */ }
  sharedSession = null;
}

/** Launch Chrome (via the runtime primitive), open a page tab, and wire the
 * CDP session. The DevTools websocket URL comes from /json/new. */
async function openSharedSession(runtime: ToolRuntime): Promise<BrowserSession> {
  const { paths, whichNames } = allChromeCandidates();
  const chromePath = await runtime.resolveExecutable([...paths, ...whichNames]);
  if (!chromePath) throw new Error(CHROME_NOT_FOUND_HINT);
  const launchArgs = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ];
  const launch = await runtime.launchHeadlessChrome(chromePath, launchArgs);
  if (!launch) throw new Error('headless Chrome exited before reporting a DevTools port');
  const tab = await fetch(`http://127.0.0.1:${launch.port}/json/new?about:blank`, { method: 'PUT' })
    .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>);
  if (!tab.webSocketDebuggerUrl) throw new Error('headless Chrome did not hand out a page websocket');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
  });
  const session = new CdpSession(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { session };
}

/** Run `fn` against the shared session, rebuilding it if the previous one
 * died. CDP-level failures (the ws is gone) close the session; page-level
 * failures propagate as normal tool errors and keep the session. */
async function withSession<T>(runtime: ToolRuntime, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
  if (!sharedSession) sharedSession = await openSharedSession(runtime);
  armIdleClose();
  try {
    return await fn(sharedSession);
  } catch (err) {
    if (isDeadSession(err)) closeSharedSession();
    throw err;
  }
}

function isDeadSession(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('CDP websocket') || message.includes('already closed') || message.includes('timed out');
}

async function evaluateInPage<T>(session: BrowserSession, expression: string): Promise<T> {
  const message = await session.session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (message.error) throw new Error(message.error.message ?? 'CDP evaluate failed');
  const result = message.result as {
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    result?: { value?: T };
  };
  const details = result?.exceptionDetails;
  if (details) {
    throw new Error(details.exception?.description ?? details.text ?? 'evaluate threw');
  }
  return result?.result?.value as T;
}

/** JSON-stringify for embedding inside an evaluate() expression. */
const literal = (value: string): string => JSON.stringify(value);

async function navigatePage(session: BrowserSession, url: string): Promise<string> {
  const message = await session.session.send('Page.navigate', { url });
  if (message.error) throw new Error(message.error.message ?? 'navigation failed');
  const result = message.result as { errorText?: string };
  if (result?.errorText) return `navigation failed: ${result.errorText}`;
  // Wait for the load event so the model does not have to guess readiness;
  // pages that never settle resolve on the deadline with an honest note.
  try {
    await session.session.waitForEvent('Page.loadEventFired', LOAD_TIMEOUT_MS);
    return `navigated to ${url} (page loaded)`;
  } catch {
    return `navigated to ${url} (load event did not fire within ${LOAD_TIMEOUT_MS / 1000}s — the page may still be loading)`;
  }
}

export interface BrowserToolOutcome {
  ok: boolean;
  /** Human-readable summary for the model. */
  output: string;
  /** Screenshot payload when the action produced one — the engine folds
   * dataUrl into the next turn as an image block (P2-3 image channel). */
  screenshot?: { path: string; mimeType: 'image/png'; dataUrl: string };
}

async function captureScreenshot(runtime: ToolRuntime, session: BrowserSession, fullPage: boolean, label: string): Promise<BrowserToolOutcome> {
  const message = await session.session.send('Page.captureScreenshot', {
    format: 'png',
    ...(fullPage ? { captureBeyondViewport: true } : {}),
  });
  if (message.error) throw new Error(message.error.message ?? 'screenshot failed');
  const data = (message.result as { data?: string })?.data;
  if (!data) throw new Error('screenshot returned no image data');
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  // Chromium caps captureBeyondViewport output at 8192px on the long edge
  // (browserProjection hit this first); the file is reported either way.
  const slug = label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
  const path = await runtime.writeArtifact('screenshot', `${Date.now()}-${slug}.png`, bytes);
  return {
    ok: true,
    output: `Screenshot saved: ${path} (${bytes.length} bytes${fullPage ? ', full page' : ''})`,
    screenshot: { path, mimeType: 'image/png', dataUrl: `data:image/png;base64,${data}` },
  };
}

/** Expected failures (no Chrome, dead CDP) surface as outcomes, matching
 * the git single-source convention; only truly unexpected throws escape. */
async function asOutcome(run: () => Promise<BrowserToolOutcome>): Promise<BrowserToolOutcome> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** browser tool: one action against the shared headless Chrome.
 * Argument validation happens BEFORE the session spins up — a malformed
 * call must fail with its own message even on a machine with no Chrome. */
export async function runBrowserTool(
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  label = 'browser',
): Promise<BrowserToolOutcome> {
  const action = typeof args.action === 'string' ? args.action : '';
  if (!action) return { ok: false, output: 'browser requires an action (navigate / click / type / evaluate / screenshot)' };
  return await asOutcome(() => runBrowserAction(action, args, runtime, label));
}

async function runBrowserAction(
  action: string,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  label: string,
): Promise<BrowserToolOutcome> {
  switch (action) {
    case 'navigate': {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) return { ok: false, output: 'browser navigate requires a url' };
      return await withSession(runtime, async (session) => {
        const result = await navigatePage(session, url);
        return { ok: !result.startsWith('navigation failed'), output: result };
      });
    }
    case 'click': {
      const selector = typeof args.selector === 'string' ? args.selector : '';
      if (!selector) return { ok: false, output: 'browser click requires a CSS selector' };
      return await withSession(runtime, async (session) => {
        const outcome = await evaluateInPage<string>(session,
          `(() => { const el = document.querySelector(${literal(selector)}); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`);
        if (outcome === 'NOT_FOUND') return { ok: false, output: `no element matches ${selector}` };
        return { ok: true, output: `clicked ${selector}` };
      });
    }
    case 'type': {
      const selector = typeof args.selector === 'string' ? args.selector : '';
      const text = typeof args.text === 'string' ? args.text : null;
      if (!selector) return { ok: false, output: 'browser type requires a CSS selector' };
      if (text === null) return { ok: false, output: 'browser type requires text' };
      return await withSession(runtime, async (session) => {
        // Set value + dispatch input/change so React/Vue controlled inputs
        // register the edit (direct assignment alone does not).
        const typed = await evaluateInPage<boolean>(session,
          `(() => { const el = document.querySelector(${literal(selector)}); if (!el) return false;
            el.focus(); el.value = ${literal(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true; })()`);
        if (!typed) return { ok: false, output: `no element matches ${selector}` };
        return { ok: true, output: `typed ${text.length} characters into ${selector}` };
      });
    }
    case 'evaluate': {
      const expression = typeof args.expression === 'string' ? args.expression : '';
      if (!expression) return { ok: false, output: 'browser evaluate requires a js expression' };
      return await withSession(runtime, async (session) => {
        const value = await evaluateInPage<unknown>(session, expression);
        const rendered = value === undefined
          ? '(undefined)'
          : typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
        return { ok: true, output: rendered };
      });
    }
    case 'screenshot': {
      return await withSession(runtime, (session) => captureScreenshot(runtime, session, args.fullPage === true, label));
    }
    default:
      return { ok: false, output: `unknown browser action: ${action}` };
  }
}

/** screenshot tool: capture a URL, a local file:// page, or — with no target
 * — the current browser page. */
export async function runScreenshotTool(
  args: Record<string, unknown>,
  runtime: ToolRuntime,
  label = 'screenshot',
): Promise<BrowserToolOutcome> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const fullPage = args.fullPage === true;
  return await asOutcome(() => withSession(runtime, async (session) => {
    if (path) {
      const navigated = await navigatePage(session, `file://${path}`);
      if (navigated.startsWith('navigation failed')) return { ok: false, output: navigated };
      return await captureScreenshot(runtime, session, fullPage, path.split(/[\\/]/).pop() ?? 'file');
    }
    if (url) {
      const navigated = await navigatePage(session, url);
      if (navigated.startsWith('navigation failed')) return { ok: false, output: navigated };
    }
    return await captureScreenshot(runtime, session, fullPage, url ? url.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) : label);
  }));
}
