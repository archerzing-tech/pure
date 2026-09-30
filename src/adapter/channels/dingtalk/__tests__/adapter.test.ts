import { describe, it, expect } from 'bun:test';
import { createDingTalkAdapter, dingtalkCapabilities, DINGTALK_APPROVAL_BUTTONS } from '../index';
import type { DingTalkCard, DingTalkRawMessage, DingTalkTransport, DingTalkTransportHandlers } from '../types';
import type { ChannelRuntimeContext, InboundEvent } from '../../../../channels/types';

interface MockTransport extends DingTalkTransport {
  handlers?: DingTalkTransportHandlers;
  markdowns: Array<{ conversationId: string; text: string }>;
  cards: Array<{ conversationId: string; card: DingTalkCard }>;
  updates: Array<{ outTrackId: string; card: DingTalkCard }>;
  images: Array<{ conversationId: string; image: Uint8Array; name: string }>;
}

function mockTransport(canStreamCards: boolean, withImages = false): MockTransport {
  const transport: MockTransport = {
    canStreamCards,
    markdowns: [], cards: [], updates: [], images: [],
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendMarkdown(conversationId, text) { transport.markdowns.push({ conversationId, text }); return `dt_m${transport.markdowns.length}`; },
    async sendCard(conversationId, card) { transport.cards.push({ conversationId, card }); return `dt_c${transport.cards.length}`; },
    async updateCard(outTrackId, card) { transport.updates.push({ outTrackId, card }); },
  };
  if (withImages) {
    transport.sendImage = async (conversationId, image, name) => {
      transport.images.push({ conversationId, image, name });
      return `dt_i${transport.images.length}`;
    };
  }
  return transport;
}

function setup(canStreamCards: boolean, withImages = false) {
  const transport = mockTransport(canStreamCards, withImages);
  const inbound: InboundEvent[] = [];
  const logs: string[] = [];
  const ctx: ChannelRuntimeContext = { accountId: 'main', onInbound: (e) => inbound.push(e), log: (m) => logs.push(m) };
  const adapter = createDingTalkAdapter({ accountId: 'main', transport });
  return { transport, adapter, inbound, logs, ctx };
}

const RAW: DingTalkRawMessage = {
  messageId: 'm1', conversationId: 'cid1', conversationType: '2', text: '@pure 你好', atBot: true, senderStaffId: 's1',
};

describe('dingtalk capabilities', () => {
  it('is card-streaming when the transport supports card instances', () => {
    const caps = dingtalkCapabilities(true);
    expect(caps.streaming).toBe('card');
    expect(caps.editMessages).toBe(true);
    expect(caps.requiresMentionInGroup).toBe(true);
    expect(caps.typing).toBe(false);
    // 默认不宣称能投图片（富输出降级为文本），由 adapter 按 transport 覆写。
    expect(caps.canDeliverImages).toBe(false);
  });

  it('degrades to no streaming when card instances are unsupported', () => {
    const caps = dingtalkCapabilities(false);
    expect(caps.streaming).toBe('none');
    expect(caps.editMessages).toBe(false);
  });

  it('enables image delivery only when the transport implements sendImage', () => {
    expect(setup(true, false).adapter.capabilities.canDeliverImages).toBe(false);
    expect(setup(true, true).adapter.capabilities.canDeliverImages).toBe(true);
  });
});

describe('dingtalk adapter lifecycle', () => {
  it('wires messages and card actions to inbound events', async () => {
    const { adapter, transport, inbound, ctx } = setup(true);
    await adapter.start(ctx);
    transport.handlers!.onMessage(RAW);
    expect(inbound[0].text).toBe('你好');
    transport.handlers!.onCardAction({ outTrackId: 'ap1', action: 'reject', conversationId: 'cid1', conversationType: '2' });
    expect(inbound[1].text).toBe('n');
  });

  it('ignores unknown card actions', async () => {
    const { adapter, transport, inbound, logs, ctx } = setup(true);
    await adapter.start(ctx);
    transport.handlers!.onCardAction({ outTrackId: 'x', action: 'whatever', conversationId: 'cid1', conversationType: '2' });
    expect(inbound).toHaveLength(0);
    expect(logs.join('\n')).toContain('no known decision');
  });
});

describe('dingtalk adapter outbound', () => {
  it('sends answers as an updatable card when streaming is available', async () => {
    const { adapter, transport } = setup(true);
    const result = await adapter.send({ accountId: 'main', peerId: 'cid1', peerKind: 'group' }, { kind: 'progress', text: '处理中', final: false });
    expect(transport.cards).toHaveLength(1);
    await adapter.editMessage!({ accountId: 'main', peerId: 'cid1', peerKind: 'group' }, result.messageId, { kind: 'final', text: '完成', final: true });
    expect(transport.updates[0].card.markdown).toBe('完成');
  });

  it('falls back to markdown chunks when streaming is unavailable', async () => {
    const { adapter, transport } = setup(false);
    const long = Array.from({ length: 200 }, (_, i) => `行${i} ${'z'.repeat(60)}`).join('\n');
    await adapter.send({ accountId: 'main', peerId: 'cid1', peerKind: 'dm' }, { kind: 'final', text: long, final: true });
    expect(transport.cards).toHaveLength(0);
    expect(transport.markdowns.length).toBeGreaterThan(1);
    for (const entry of transport.markdowns) expect(entry.text.length).toBeLessThanOrEqual(adapter.capabilities.maxTextLength);
  });

  it('uploads image attachments as separate image messages when supported', async () => {
    const { adapter, transport } = setup(true, true);
    const png = new Uint8Array([137, 80, 78, 71]);
    await adapter.send(
      { accountId: 'main', peerId: 'cid1', peerKind: 'group' },
      { kind: 'final', text: '图见附件', final: true, attachments: [{ name: 'diagram-1.png', mimeType: 'image/png', data: png }] },
    );
    expect(transport.images).toHaveLength(1);
    expect(transport.images[0].conversationId).toBe('cid1');
    expect(transport.images[0].image).toEqual(png);
  });

  it('drops image attachments when the transport cannot upload them', async () => {
    const { adapter, transport } = setup(true, false);
    await adapter.send(
      { accountId: 'main', peerId: 'cid1', peerKind: 'group' },
      { kind: 'final', text: '图见附件', final: true, attachments: [{ name: 'diagram-1.png', mimeType: 'image/png', data: new Uint8Array([1]) }] },
    );
    expect(transport.images).toHaveLength(0);
  });

  it('sends an approval card carrying the approval id and buttons', async () => {
    const { adapter, transport } = setup(true);
    await adapter.send({ accountId: 'main', peerId: 'cid1', peerKind: 'dm' }, { kind: 'approval', text: '需要批准 y/n/a', approvalId: 'ap9' });
    expect(transport.cards[0].card.outTrackId).toBe('ap9');
    expect(transport.cards[0].card.buttons).toEqual(DINGTALK_APPROVAL_BUTTONS);
  });
});
