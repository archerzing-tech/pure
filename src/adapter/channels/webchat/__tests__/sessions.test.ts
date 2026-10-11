// src/adapter/channels/webchat/__tests__/sessions.test.ts
// webchat 端口上的只读会话端点：注入数据源则 200 + JSON，缺省 404（老宿主零感知）。
import { describe, it, expect, afterAll } from 'bun:test';
import { createWebChatAdapter } from '../index';
import type { ChannelRuntimeContext } from '../../../../channels/types';

const PORT = 18991;
const context: ChannelRuntimeContext = { accountId: 'default', onInbound: () => {}, log: () => {} };

const adapter = createWebChatAdapter({
  host: '127.0.0.1',
  port: PORT,
  sessions: {
    list: () => [
      { sessionId: 'chan_1', sessionKey: 'qq:main:dm:qq:1', surface: 'qq', peer: 'qq:1', lastActivityAt: 1, status: 'running', statusDetail: '回合进行中' },
    ],
    timeline: (id) => (id === 'chan_1' ? [{ ts: 1, kind: 'user_input', summary: '用户(qq)：hi' }] : []),
  },
});
const bare = createWebChatAdapter({ host: '127.0.0.1', port: PORT + 1 });

afterAll(async () => {
  await adapter.stop();
  await bare.stop();
});

describe('webchat sessions endpoints', () => {
  it('serves /sessions and /sessions/:id/timeline when the api is wired', async () => {
    await adapter.start(context);
    const list = await fetch(`http://127.0.0.1:${PORT}/sessions`);
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ sessionId: string; status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'chan_1', status: 'running' });

    const tl = await fetch(`http://127.0.0.1:${PORT}/sessions/chan_1/timeline`);
    expect(tl.status).toBe(200);
    expect(((await tl.json()) as Array<{ summary: string }>)[0].summary).toContain('hi');

    const miss = await fetch(`http://127.0.0.1:${PORT}/sessions/chan_missing/timeline`);
    expect(miss.status).toBe(200);
    expect(await miss.json()).toEqual([]);
  });

  it('answers 404 without the sessions api (old hosts)', async () => {
    await bare.start(context);
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/sessions`);
    expect(res.status).toBe(404);
    const root = await fetch(`http://127.0.0.1:${PORT + 1}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('tab-sess');
  });
});
