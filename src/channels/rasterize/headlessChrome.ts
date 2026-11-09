// src/channels/rasterize/headlessChrome.ts
// 给通道富输出用的一次性 headless Chrome：只做「把图源码渲成 SVG」这件事，
// 渲染能力来自真实 Chromium —— mermaid 依赖真实的 SVG 测量 API（happy-dom 下
// render() 只会返回空字符串），PlantUML 的 TeaVM 引擎在 happy-dom 下直接挂死。
// 不引入 puppeteer/playwright：仓库里已有多个脚本用「系统 Chrome + --headless=new
// + CDP over WebSocket」的裸协议模式（verify-plan-restore / repro-expand …），
// 这里沿用同一套，零新增依赖，也避免为了几张图下载一份 170MB 的 Chromium。
// Chrome 缺失不是错误：findChromePath 返回 null，调用方据此不提供 mermaid/puml
// 渲染器，富输出回到「诚实降级为文本」的老路（见 richOutput.ts 的降级矩阵）。
// 本文件带着 node:fs/os import，只能活在宿主端（Bun/CLI）；browser 工具
// （tools/impl/browser.ts）会进 WebView bundle，它需要的零依赖部分拆在
// cdpSession.ts（CDP 会话）与 chromeCandidates.ts（平台候选表），这里
// re-export 保住既有 import 面。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpSession } from './cdpSession';
import { allChromeCandidates } from './chromeCandidates';

export { CdpSession, type CdpMessage } from './cdpSession';
export { allChromeCandidates } from './chromeCandidates';

export interface HeadlessChromeOptions {
  /** 显式指定可执行文件；缺省按平台候选列表 + 环境变量探测。 */
  chromePath?: string;
  log?: (message: string) => void;
  startupTimeoutMs?: number;
}

/** 探测可用的 Chrome；找不到返回 null（调用方据此降级，而不是抛错）。 */
export function findChromePath(explicit?: string): string | null {
  const { paths, whichNames } = allChromeCandidates();
  // 全量候选（含其他平台的路径）过一遍也无妨——exists 直接 miss；显式参数
  // 仍排最前。
  const candidates = [explicit, ...paths];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of whichNames) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
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

/** 从 Chrome 的 stderr 里读 `DevTools listening on ws://127.0.0.1:<port>/…`。
 *  导出仅为测试（launch 用假进程不可行，deadline 行为必须真测）。 */
export async function readDevToolsPort(proc: import('bun').Subprocess, timeoutMs: number): Promise<number | null> {
  const stderr = proc.stderr;
  if (!(stderr instanceof ReadableStream)) return null;
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      // 截止时间必须约束到 read 本身（审计批 6①）：Chrome 启动挂死时
      // stderr 一个字节都不来，旧的「读间隙查表」让 await 永远悬着，
      // startupTimeoutMs 形同虚设，launch 永不返回。竞速一把钟，输了
      // 就按超时收场（悬着的 read 由 Promise.race 挂着 handler，后续
      // 进程死亡导致的 rejection 不会变成 unhandled）。
      const remainingMs = deadline - Date.now();
      const tick = new Promise<'deadline'>((resolve) => {
        setTimeout(() => resolve('deadline'), Math.max(remainingMs, 0)).unref?.();
      });
      const raced = await Promise.race([reader.read(), tick]);
      if (raced === 'deadline') return null;
      const { value, done } = raced;
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
