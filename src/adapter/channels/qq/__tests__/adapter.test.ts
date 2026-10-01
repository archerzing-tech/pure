import { describe, it, expect } from 'bun:test';
import { createQQAdapter, qqCapabilities } from '../index';
import type { QQRawMessage, QQTransport, QQTransportHandlers } from '../types';
import type { ChannelRuntimeContext, InboundEvent } from '../../../../channels/types';

interface MockTransport extends QQTransport {
  handlers?: QQTransportHandlers;
  texts: Array<{ conversationId: string; text: string }>;
  images: Array<{ conversationId: string; image: Uint8Array; name: string }>;
}

function mockTransport(withImages = false): MockTransport {
  const transport: MockTransport = {
    texts: [], images: [],
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendText(conversationId, text) { transport.texts.push({ conversationId, text }); return `qq_t${transport.texts.length}`; },
  };
  if (withImages) {
    transport.sendImage = async (conversationId, image, name) => {
      transport.images.push({ conversationId, image, name });
      return `qq_i${transport.images.length}`;
    };
  }
  return transport;
}

function setup(withImages = false) {
  const transport = mockTransport(withImages);
  const inbound: InboundEvent[] = [];
  const logs: string[] = [];
  const ctx: ChannelRuntimeContext = { accountId: 'main', onInbound: (e) => inbound.push(e), log: (m) => logs.push(m) };
  const adapter = createQQAdapter({ accountId: 'main', transport });
  return { transport, adapter, inbound, logs, ctx };
}

const RAW: QQRawMessage = {
  messageId: 'm1', conversationId: 'openid1', conversationType: 'dm', text: '@pure 你好',
  authorId: 'u1', replyMsgId: 'm1',
};

describe('qq capabilities', () => {
  it('declares text-only delivery honestly (no streaming, no markdown)', () => {
    const caps = qqCapabilities();
    expect(caps.streaming).toBe('none');
    expect(caps.markdown).toBe('none');
    expect(caps.editMessages).toBe(false);
    expect(caps.buttons).toBe(true); // 文字双轨
    expect(caps.requiresMentionInGroup).toBe(true);
    expect(caps.canDeliverImages).toBe(false);
  });

  it('declares image delivery only when the transport implements sendImage', () => {
    expect(qqCapabilities(true).canDeliverImages).toBe(true);
  });
});

describe('qq adapter', () => {
  it('normalizes inbound messages (strips the @ prefix, marks addressed)', async () => {
    const { adapter, transport, inbound, ctx } = setup();
    await adapter.start(ctx);
    transport.handlers!.onMessage(RAW);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].channelId).toBe('qq');
    expect(inbound[0].peer.kind).toBe('dm');
    expect(inbound[0].text).toBe('你好');
    expect(inbound[0].addressed).toBe(true);
  });

  it('sends final messages chunked as plain text', async () => {
    const { adapter } = setup();
    const result = await adapter.send(
      { accountId: 'main', peerId: 'openid1', peerKind: 'dm' },
      { kind: 'final', text: '调研结论：……' },
    );
    expect(result.messageId).toBe('qq_t1');
  });

  it('appends the text-dual-track hint on approval frames', async () => {
    const { transport, adapter } = setup();
    await adapter.send(
      { accountId: 'main', peerId: 'openid1', peerKind: 'dm' },
      { kind: 'approval', text: '要执行 rm -rf 吗', approvalId: 'ap1' },
    );
    expect(transport.texts).toHaveLength(1);
    expect(transport.texts[0].text).toContain('要执行 rm -rf 吗');
    expect(transport.texts[0].text).toContain('回复 y 批准 / n 拒绝 / a 本次会话总是允许');
  });

  it('sends attachment-only frames without an empty text message', async () => {
    const { transport, adapter } = setup(true);
    const result = await adapter.send(
      { accountId: 'main', peerId: 'openid1', peerKind: 'dm' },
      { kind: 'final', text: '', attachments: [{ name: 'a.png', mimeType: 'image/png', data: new Uint8Array([1]) }] },
    );
    expect(transport.texts).toHaveLength(0);
    expect(transport.images).toHaveLength(1);
    expect(result.messageId).toBe('qq_i1');
  });
});
