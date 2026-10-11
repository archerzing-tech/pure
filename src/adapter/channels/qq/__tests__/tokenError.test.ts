// src/adapter/channels/qq/__tests__/tokenError.test.ts
// QQ 用 HTTP 200 包错误（{"code":..,"message":..}）：失败信息必须带上响应体，
// 否则「HTTP 200 失败」无法诊断（2026-10-11 真机教训）。
import { describe, it, expect } from 'bun:test';
import { createQQWsTransport } from '../wsTransport';

describe('QQTokenKeeper error surfacing', () => {
  it('includes the QQ response body when the token endpoint rejects inside HTTP 200', async () => {
    const transport = await createQQWsTransport({
      appId: '1000',
      appSecret: 'secret',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 112, message: 'invalid appid' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await transport.start({ onMessage: () => {}, log: () => {} });
    } catch (err) {
      caught = err;
    }
    await transport.stop();
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('200');
    expect(message).toContain('invalid appid');
  });
});
