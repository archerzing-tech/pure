// src/adapter/channels/telegram/__tests__/httpTransport.test.ts
// 长轮询 transport 的编排纪律：start 序列（deleteWebhook → getMe → getUpdates）、
// offset 确认消费、getMe 失败就地抛（token 无效不该被静默吞掉）、stop 打断挂起。
// 全部走注入 fetchImpl，不发真网。
import { describe, it, expect } from 'bun:test';
import { createTelegramHttpTransport } from '../httpTransport';
import type { TelegramRawMessage } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function makeFetch(routes: {
  deleteWebhook?: () => Response;
  getMe: () => Response;
  getUpdates: (body: { offset?: number }) => Response;
  sendMessage?: (body: unknown) => Response;
}, calls: Array<{ method: string; path: string; body?: unknown }>) {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const path = String(url).replace(/^.*\/bot[^/]+\//, '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined });
    switch (path) {
      case 'deleteWebhook': return routes.deleteWebhook?.() ?? json({ ok: true, result: true });
      case 'getMe': return routes.getMe();
      case 'getUpdates': return routes.getUpdates((init?.body ? JSON.parse(init.body) : {}) as { offset?: number });
      case 'sendMessage': return routes.sendMessage?.(init?.body ? JSON.parse(init.body) : undefined) ?? json({ ok: true, result: { message_id: 9 } });
      default: throw new Error(`fetchStub: no route for ${path}`);
    }
  }) as typeof fetch;
}

const TOKEN = '111222333:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK';
const ME_OK = { ok: true, result: { id: 111222333, username: 'pure_bot' } };

describe('telegram httpTransport', () => {
  it('start 序列：先 deleteWebhook 再 getMe 再长轮询，getMe 捕获 botUsername', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = makeFetch({
      getMe: () => json(ME_OK),
      getUpdates: () => json({ ok: true, result: [] }),
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl });
    const logs: string[] = [];
    const running = transport.start({ onMessage: () => {}, log: (m) => logs.push(m) });
    for (let i = 0; i < 100 && calls.filter((c) => c.path === 'getUpdates').length === 0; i++) await sleep(10);
    await transport.stop();
    await running;
    expect(calls[0].path).toBe('deleteWebhook');
    expect(calls[1].path).toBe('getMe');
    expect(calls.filter((c) => c.path === 'getUpdates').length).toBeGreaterThan(0);
    expect(logs.some((m) => m.includes('@pure_bot'))).toBe(true);
  });

  it('getUpdates 消息投递 onMessage，offset 递增确认消费', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let round = 0;
    const got: TelegramRawMessage[] = [];
    const fetchImpl = makeFetch({
      getMe: () => json(ME_OK),
      getUpdates: () => {
        round++;
        if (round === 1) {
          return json({ ok: true, result: [{ update_id: 100, message: { message_id: 5, date: 1_700_000_000, text: 'hi', chat: { id: 42, type: 'private' }, from: { id: 7 } } }] });
        }
        return json({ ok: true, result: [] });
      },
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl });
    const running = transport.start({ onMessage: (m) => got.push(m), log: () => {} });
    for (let i = 0; i < 100 && round < 2; i++) await sleep(10);
    await transport.stop();
    await running;
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('hi');
    expect(got[0].botUsername).toBe('pure_bot');
    const second = calls.filter((c) => c.path === 'getUpdates')[1];
    expect(second.body).toMatchObject({ offset: 101 });
  });

  it('getMe 被拒（token 无效）就地抛，不进轮询循环', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = makeFetch({
      getMe: () => json({ ok: false, description: 'Unauthorized' }),
      getUpdates: () => json({ ok: true, result: [] }),
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl });
    await expect(transport.start({ onMessage: () => {}, log: () => {} })).rejects.toThrow(/getMe/);
    await transport.stop();
    expect(calls.filter((c) => c.path === 'getUpdates')).toHaveLength(0);
  });

  it('网络错误指数退避后自愈（成功重置，log 记录重试）', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let round = 0;
    const logs: string[] = [];
    const fetchImpl = makeFetch({
      getMe: () => json(ME_OK),
      getUpdates: () => {
        round++;
        if (round === 1) throw new Error('connect ECONNRESET');
        return json({ ok: true, result: [] });
      },
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl, retryBaseDelayMs: 5 });
    const running = transport.start({ onMessage: () => {}, log: (m) => logs.push(m) });
    for (let i = 0; i < 200 && round < 2; i++) await sleep(10);
    await transport.stop();
    await running;
    expect(logs.some((m) => m.includes('retrying'))).toBe(true);
    expect(calls.filter((c) => c.path === 'getUpdates').length).toBeGreaterThanOrEqual(2);
  });

  it('sendText 走 POST sendMessage，返回平台 message_id 字符串', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = makeFetch({
      getMe: () => json(ME_OK),
      getUpdates: () => json({ ok: true, result: [] }),
      sendMessage: () => json({ ok: true, result: { message_id: 77 } }),
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl });
    const id = await transport.sendText('42', '你好');
    expect(id).toBe('77');
    const send = calls.find((c) => c.path === 'sendMessage');
    expect(send?.method).toBe('POST');
    expect(send?.body).toEqual({ chat_id: '42', text: '你好' });
  });

  it('sendMessage 失败抛错（带平台原话）', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = makeFetch({
      getMe: () => json(ME_OK),
      getUpdates: () => json({ ok: true, result: [] }),
      sendMessage: () => json({ ok: false, description: 'chat not found' }),
    }, calls);
    const transport = createTelegramHttpTransport({ botToken: TOKEN, apiBase: 'http://mock', fetchImpl });
    await expect(transport.sendText('42', 'x')).rejects.toThrow(/chat not found/);
  });
});
