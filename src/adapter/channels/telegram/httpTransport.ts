// src/adapter/channels/telegram/httpTransport.ts
// Telegram Bot API 的纯 REST 传输：getUpdates 长轮询收、sendMessage 发。
// 全部出站连接，无需公网回调地址；token 走 URL 路径段（telegram 官方鉴权
// 方式），因此 fetchImpl 可注入（单测不发真网）。
import type { TelegramRawMessage, TelegramTransport, TelegramTransportHandlers } from './types';

export interface TelegramHttpTransportOptions {
  botToken: string;
  /** 默认 https://api.telegram.org；测试注入本地 mock 服务。 */
  apiBase?: string;
  /** getUpdates 的长轮询挂起秒数（官方建议 0~50），默认 25。 */
  pollTimeoutSec?: number;
  fetchImpl?: typeof fetch;
  /** 重试退避基线毫秒，默认 2000（测试调小加速退避用例）。 */
  retryBaseDelayMs?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  /** 429 限流时平台给的重试等待秒数。 */
  parameters?: { retry_after?: number };
}

interface TelegramApiUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string; title?: string; username?: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
  };
}

const MAX_RETRY_DELAY_MS = 60_000;

export function createTelegramHttpTransport(options: TelegramHttpTransportOptions): TelegramTransport {
  const apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollTimeoutSec = options.pollTimeoutSec ?? 25;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 2_000;
  const base = `${apiBase}/bot${options.botToken}`;

  let stopped = false;
  let abort: AbortController | null = null;
  let botUsername: string | undefined;

  async function callApi<T>(method: string, init?: { timeoutMs?: number; body?: unknown }): Promise<TelegramApiResponse<T>> {
    abort = new AbortController();
    const timer = init?.timeoutMs ? setTimeout(() => abort?.abort(), init.timeoutMs) : undefined;
    try {
      const res = await fetchImpl(`${base}/${method}`, {
        method: init?.body ? 'POST' : 'GET',
        ...(init?.body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
          : {}),
        signal: abort.signal,
      });
      const text = await res.text();
      try {
        return JSON.parse(text) as TelegramApiResponse<T>;
      } catch {
        return { ok: false, description: `HTTP ${res.status} ${text.slice(0, 120)}` };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function toRaw(update: TelegramApiUpdate): TelegramRawMessage | null {
    const m = update.message;
    if (!m) return null; // edited_message / callback_query 等先不消费
    return {
      messageId: m.message_id,
      chat: {
        id: m.chat.id,
        type: m.chat.type as TelegramRawMessage['chat']['type'],
        title: m.chat.title,
        username: m.chat.username,
      },
      from: m.from
        ? { id: m.from.id, username: m.from.username, firstName: m.from.first_name, lastName: m.from.last_name }
        : undefined,
      date: m.date,
      text: m.text,
      botUsername,
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    async start(handlers: TelegramTransportHandlers): Promise<void> {
      stopped = false;
      // 清 webhook：一旦设过 webhook，getUpdates 会拒绝（409 冲突）；
      // drop_pending_updates 丢掉停机期间的积压，防老消息重灌回合。
      const unhook = await callApi<unknown>('deleteWebhook', { body: { drop_pending_updates: true } });
      if (!unhook.ok) handlers.log(`telegram deleteWebhook failed (continuing): ${unhook.description ?? 'unknown'}`);
      // getMe：token 无效在这里就地失败（启动失败=凭据问题，网关会如实报），
      // 顺便捕获 bot username 供群聊 @ 判定。
      const me = await callApi<{ username?: string }>('getMe');
      if (!me.ok || !me.result) throw new Error(`telegram getMe rejected token: ${me.description ?? 'unknown'}`);
      botUsername = me.result.username;
      handlers.log(`telegram bot @${botUsername ?? 'unknown'} ready (long polling)`);

      // 长轮询主循环：网络类失败按指数退避（2s×2^n 封顶 60s），成功清账。
      let retryDelayMs = retryBaseDelayMs;
      let offset = 0;
      while (!stopped) {
        try {
          const res = await callApi<TelegramApiUpdate[]>('getUpdates', {
            timeoutMs: pollTimeoutSec * 1000 + 5_000,
            body: { timeout: pollTimeoutSec, offset: offset || undefined, allowed_updates: ['message'] },
          });
          if (stopped) break;
          if (!res.ok) {
            handlers.log(`telegram getUpdates error: ${res.description ?? 'unknown'}`);
            await sleep(retryDelayMs);
            retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
            continue;
          }
          retryDelayMs = retryBaseDelayMs;
          for (const update of res.result ?? []) {
            offset = update.update_id + 1; // 确认消费：下轮只取更新的
            const raw = toRaw(update);
            if (raw) handlers.onMessage(raw);
          }
        } catch (err) {
          if (stopped) break;
          const detail = err instanceof Error ? err.message : String(err);
          handlers.log(`telegram poll failed (${detail}); retrying in ${Math.round(retryDelayMs / 1000)}s`);
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        }
        // 每轮让出一帧 macrotask：真网请求自带 I/O 延迟不空转，但 mock 回包
        // （同步 resolve）会让 await 链退化成纯 microtask 循环，把 event loop
        // 饿死——timer/测试轮询全部排不上队，进程假死。
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      abort?.abort(); // 打断挂起中的长轮询 fetch，让 start 循环尽快退出
    },

    async sendText(chatId: string, text: string): Promise<string> {
      const res = await callApi<{ message_id: number }>('sendMessage', {
        body: { chat_id: chatId, text },
      });
      if (!res.ok || !res.result) throw new Error(`telegram sendMessage failed: ${res.description ?? 'unknown'}`);
      return String(res.result.message_id);
    },
  };
}
