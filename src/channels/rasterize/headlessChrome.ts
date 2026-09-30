// src/channels/rasterize/headlessChrome.ts
// 给通道富输出用的一次性 headless Chrome：只做「把图源码渲成 SVG」这件事，
// 渲染能力来自真实 Chromium —— mermaid 依赖真实的 SVG 测量 API（happy-dom 下
// render() 只会返回空字符串），PlantUML 的 TeaVM 引擎在 happy-dom 下直接挂死。
//
// 不引入 puppeteer/playwright：仓库里已有多个脚本用「系统 Chrome + --headless=new
// + CDP over WebSocket」的裸协议模式（verify-plan-restore / repro-expand …），
// 这里沿用同一套，零新增依赖，也避免为了几张图下载一份 170MB 的 Chromium。
//
// Chrome 缺失不是错误：findChromePath 返回 null，调用方据此不提供 mermaid/puml
// 渲染器，富输出回到「诚实降级为文本」的老路（见 richOutput.ts 的降级矩阵）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HeadlessChromeOptions {
  /** 显式指定可执行文件；缺省按平台候选列表 + 环境变量探测。 */
  chromePath?: string;
  log?: (message: string) => void;
  startupTimeoutMs?: number;
}

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const WIN_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** 探测可用的 Chrome；找不到返回 null（调用方据此降级，而不是抛错）。 */
export function findChromePath(explicit?: string): string | null {
  const platform = process.platform === 'darwin'
    ? MAC_CANDIDATES
    : process.platform === 'win32' ? WIN_CANDIDATES : LINUX_CANDIDATES;
  const candidates = [explicit, process.env.PURE_CHROME_PATH, process.env.CHROME_PATH, ...platform];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) return;
      const resolve = this.pending.get(message.id);
      if (!resolve) return;
      this.pending.delete(message.id);
      resolve(message);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // 页面在渲染中途崩掉时不能让调用方永远等下去。
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 120_000).unref?.();
    });
  }
}

/** 一个 headless Chrome 进程 + 一个空白页的 CDP 会话。 */
export class HeadlessChrome {
  private closed = false;

  private constructor(
    private readonly proc: import('bun').Subprocess,
    private readonly session: CdpSession,
    private readonly profileDir: string,
    private readonly chromePath: string,
  ) {}

  static async launch(options: HeadlessChromeOptions = {}): Promise<HeadlessChrome> {
    const chromePath = findChromePath(options.chromePath);
    if (!chromePath) throw new Error('no usable Chrome executable found');
    const log = options.log;
    const profileDir = mkdtempSync(join(tmpdir(), 'pure-chrome-'));
    const proc = Bun.spawn([
      chromePath,
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1400,900',
      'about:blank',
    ], { stdout: 'ignore', stderr: 'pipe' });

    const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    const port = await readDevToolsPort(proc, startupTimeoutMs);
    if (!port) {
      try { proc.kill(); } catch { /* already gone */ }
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error('headless Chrome never reported a DevTools port');
    }

    const tab = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>);
    if (!tab.webSocketDebuggerUrl) {
      try { proc.kill(); } catch { /* already gone */ }
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error('headless Chrome did not hand out a page websocket');
    }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('CDP websocket failed to open'));
    });
    const session = new CdpSession(ws);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    log?.(`headless Chrome ready (${chromePath}, port ${port})`);
    return new HeadlessChrome(proc, session, profileDir, chromePath);
  }

  /** 直接发一条 CDP 命令（截图、视口覆盖等）。 */
  async cdp(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const message = await this.session.send(method, params);
    if (message.error) throw new Error(message.error.message ?? `CDP ${method} failed`);
    return (message.result ?? {}) as Record<string, unknown>;
  }

  /** 在页面里跑一段表达式并取回值；页面抛错时把页面侧的说明原样带出来。 */
  async evaluate<T>(expression: string): Promise<T> {
    const message = await this.session.send('Runtime.evaluate', {
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.session.send('Browser.close'); } catch { /* best effort */ }
    try { this.proc.kill(); } catch { /* already gone */ }
    try { rmSync(this.profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** 从 Chrome 的 stderr 里读 `DevTools listening on ws://127.0.0.1:<port>/…`。 */
async function readDevToolsPort(proc: import('bun').Subprocess, timeoutMs: number): Promise<number | null> {
  const stderr = proc.stderr;
  if (!(stderr instanceof ReadableStream)) return null;
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        // 后台继续排空，避免 Chrome 写满管道后卡住。
        void (async () => {
          try { for (;;) { const next = await reader.read(); if (next.done) break; } } catch { /* stream closed */ }
        })();
        return Number(match[1]);
      }
    }
  } catch {
    return null;
  }
  return null;
}
