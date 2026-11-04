// src/channels/rasterize/cdpSession.ts
// Bare CDP-over-WebSocket session: JSON-RPC-ish send + event waiting. Zero
// node imports — this module is imported by the browser tool (tools/impl/
// browser.ts) and therefore lands in the WebView bundle, where vite replaces
// any bare `node:*` import with __vite-browser-external and the production
// build dies. The same code runs in Bun for the channel rasterizer.

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

export class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly eventWaiters = new Map<string, ((message: CdpMessage) => void)[]>();

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) {
        // CDP 事件（无 id）：唤醒等在这个方法名上的 waitForEvent。
        if (message.method) {
          const waiters = this.eventWaiters.get(message.method);
          if (waiters?.length) {
            this.eventWaiters.delete(message.method);
            for (const resolve of waiters) resolve(message);
          }
        }
        return;
      }
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

  /** 等下一个指定名字的 CDP 事件，与截止时间竞速——页面迟迟不发事件时
   * 不能把调用方吊死（navigate 等 load 的唯一通道）。 */
  waitForEvent(method: string, timeoutMs: number): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const onEvent = (message: CdpMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        const list = this.eventWaiters.get(method);
        if (list) {
          const idx = list.indexOf(onEvent);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.eventWaiters.delete(method);
        }
        reject(new Error(`CDP event ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      const existing = this.eventWaiters.get(method) ?? [];
      existing.push(onEvent);
      this.eventWaiters.set(method, existing);
    });
  }
}
