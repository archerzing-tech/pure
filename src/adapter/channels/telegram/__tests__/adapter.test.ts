import { describe, it, expect } from 'bun:test';
import { createTelegramAdapter, telegramCapabilities } from '../index';
import type { TelegramRawMessage, TelegramTransport, TelegramTransportHandlers } from '../types';
import type { ChannelRuntimeContext, InboundEvent } from '../../../../channels/types';

interface MockTransport extends TelegramTransport {
  handlers?: TelegramTransportHandlers;
  texts: Array<{ chatId: string; text: string }>;
}

function mockTransport(): MockTransport {
  const transport: MockTransport = {
    texts: [],
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendText(chatId, text) { transport.texts.push({ chatId, text }); return `tg_t${transport.texts.length}`; },
  };
  return transport;
}

function setup() {
  const transport = mockTransport();
  const inbound: InboundEvent[] = [];
  const logs: string[] = [];
  const ctx: ChannelRuntimeContext = { accountId: 'main', onInbound: (e) => inbound.push(e), log: (m) => logs.push(m) };
  const adapter = createTelegramAdapter({ accountId: 'main', transport });
  return { transport, adapter, inbound, logs, ctx };
}

describe('telegram capabilities', () => {
  it('declares text-only long-polling delivery honestly', () => {
    const caps = telegramCapabilities();
    expect(caps.chatTypes).toEqual(['dm', 'group']);
    expect(caps.streaming).toBe('none');
    expect(caps.markdown).toBe('none');
    expect(caps.buttons).toBe(false); // 文字双轨降级
    expect(caps.canDeliverImages).toBe(false);
    expect(caps.requiresMentionInGroup).toBe(true);
  });
});

describe('telegram adapter', () => {
  it('normalizes inbound and drops channel-broadcast updates', async () => {
    const { adapter, transport, inbound, ctx } = setup();
    await adapter.start(ctx);
    transport.handlers!.onMessage({
      messageId: 1, chat: { id: 42, type: 'private' }, date: 1_700_000_000, text: 'hi', botUsername: 'pure_bot',
    });
    transport.handlers!.onMessage({
      messageId: 2, chat: { id: -77, type: 'channel', title: '广播' }, date: 1_700_000_000, text: '公告',
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].channelId).toBe('telegram');
    expect(inbound[0].peer.kind).toBe('dm');
    expect(inbound[0].text).toBe('hi');
  });

  it('sends final messages chunked as plain text', async () => {
    const { adapter } = setup();
    const result = await adapter.send(
      { accountId: 'main', peerId: '42', peerKind: 'dm' },
      { kind: 'final', text: '调研结论：……' },
    );
    expect(result.messageId).toBe('tg_t1');
  });

  it('chunks texts beyond the platform limit into multiple frames', async () => {
    const { transport, adapter } = setup();
    await adapter.send(
      { accountId: 'main', peerId: '42', peerKind: 'dm' },
      { kind: 'final', text: 'a'.repeat(9000) },
    );
    expect(transport.texts.length).toBeGreaterThan(1);
    for (const frame of transport.texts) expect(frame.text.length).toBeLessThanOrEqual(4000);
  });

  it('appends the text-dual-track hint on approval frames', async () => {
    const { transport, adapter } = setup();
    await adapter.send(
      { accountId: 'main', peerId: '42', peerKind: 'dm' },
      { kind: 'approval', text: '要执行 rm -rf 吗', approvalId: 'ap1' },
    );
    expect(transport.texts).toHaveLength(1);
    expect(transport.texts[0].text).toContain('要执行 rm -rf 吗');
    expect(transport.texts[0].text).toContain('回复 y 批准 / n 拒绝 / a 本次会话总是允许');
  });

  it('listAccountIds reports the configured account', () => {
    const { adapter } = setup();
    expect(adapter.listAccountIds()).toEqual(['main']);
  });
});
