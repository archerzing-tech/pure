import { describe, it, expect } from 'bun:test';
import { createFeishuAdapter, FEISHU_CAPABILITIES } from '../index';
import type { FeishuCardAction, FeishuRawMessage, FeishuTransport, FeishuTransportHandlers } from '../types';
import type { ChannelRuntimeContext, InboundEvent } from '../../../../channels/types';

interface MockTransport extends FeishuTransport {
  handlers?: FeishuTransportHandlers;
  texts: Array<{ chatId: string; text: string }>;
  cards: Array<{ chatId: string; card: unknown }>;
  patches: Array<{ messageId: string; card: unknown }>;
  images: Array<{ chatId: string; image: Uint8Array; name: string }>;
  started: number;
  stopped: number;
}

function mockTransport(withImages = false): MockTransport {
  const transport: MockTransport = {
    texts: [], cards: [], patches: [], images: [], started: 0, stopped: 0,
    async start(handlers) { transport.handlers = handlers; transport.started += 1; },
    async stop() { transport.stopped += 1; },
    async sendText(chatId, text) { transport.texts.push({ chatId, text }); return `om_t${transport.texts.length}`; },
    async sendCard(chatId, card) { transport.cards.push({ chatId, card }); return `om_c${transport.cards.length}`; },
    async patchCard(messageId, card) { transport.patches.push({ messageId, card }); },
  };
  if (withImages) {
    transport.sendImage = async (chatId, image, name) => {
      transport.images.push({ chatId, image, name });
      return `om_i${transport.images.length}`;
    };
  }
  return transport;
}

function setup(withImages = false) {
  const transport = mockTransport(withImages);
  const inbound: InboundEvent[] = [];
  const logs: string[] = [];
  const ctx: ChannelRuntimeContext = { accountId: 'main', onInbound: (e) => inbound.push(e), log: (m) => logs.push(m) };
  const adapter = createFeishuAdapter({ accountId: 'main', transport });
  return { transport, adapter, inbound, logs, ctx };
}

const RAW: FeishuRawMessage = {
  messageId: 'om_1', chatId: 'oc_1', chatType: 'group', messageType: 'text',
  text: '@_user_1 你好', mentionsBot: true, senderId: 'ou_1',
};

describe('feishu adapter capabilities', () => {
  it('declares card streaming, markdown, buttons and group mention gating', () => {
    expect(FEISHU_CAPABILITIES.streaming).toBe('card');
    expect(FEISHU_CAPABILITIES.markdown).toBe('full');
    expect(FEISHU_CAPABILITIES.typing).toBe(false);
    expect(FEISHU_CAPABILITIES.buttons).toBe(true);
    expect(FEISHU_CAPABILITIES.requiresMentionInGroup).toBe(true);
    // 基础声明不写死 canDeliverImages：能否投图片由 transport 是否实现 sendImage 决定。
    expect(FEISHU_CAPABILITIES.canDeliverImages).toBeUndefined();
  });

  it('enables image delivery only when the transport implements sendImage', () => {
    expect(setup(false).adapter.capabilities.canDeliverImages).toBe(false);
    expect(setup(true).adapter.capabilities.canDeliverImages).toBe(true);
  });
});

describe('feishu adapter lifecycle', () => {
  it('wires transport events to inbound events and stops the transport', async () => {
    const { adapter, transport, inbound, ctx } = setup();
    await adapter.start(ctx);
    expect(transport.started).toBe(1);
    transport.handlers!.onMessage(RAW);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe('你好');
    await adapter.stop();
    expect(transport.stopped).toBe(1);
  });

  it('turns a card button callback into a y/a/n inbound reply', async () => {
    const { adapter, transport, inbound, ctx } = setup();
    await adapter.start(ctx);
    const action: FeishuCardAction = { openId: 'ou_1', chatId: 'oc_1', chatType: 'group', messageId: 'om_1', actionValue: { approvalId: 'ap1', decision: 'always' } };
    transport.handlers!.onCardAction(action);
    expect(inbound[0].text).toBe('a');
  });

  it('ignores card actions without a known decision', async () => {
    const { adapter, transport, inbound, logs, ctx } = setup();
    await adapter.start(ctx);
    transport.handlers!.onCardAction({ openId: 'o', chatId: 'c', chatType: 'p2p', messageId: 'm', actionValue: { foo: 'bar' } });
    expect(inbound).toHaveLength(0);
    expect(logs.join('\n')).toContain('without a known decision');
  });
});

describe('feishu adapter outbound', () => {
  it('sends agent answers as an interactive card', async () => {
    const { adapter, transport } = setup();
    const result = await adapter.send({ accountId: 'main', peerId: 'oc_1', peerKind: 'group' }, { kind: 'progress', text: '正在处理', final: false });
    expect(transport.cards[0].chatId).toBe('oc_1');
    expect(result.messageId).toBe('om_c1');
  });

  it('patches the card on edit (full-snapshot streaming)', async () => {
    const { adapter, transport } = setup();
    await adapter.editMessage!({ accountId: 'main', peerId: 'oc_1', peerKind: 'group' }, 'om_c1', { kind: 'final', text: '答案', final: true });
    expect(transport.patches[0].messageId).toBe('om_c1');
    expect(JSON.stringify(transport.patches[0].card)).toContain('答案');
  });

  it('updates the same card for throttled progress frames instead of posting duplicates', async () => {
    const { adapter, transport } = setup();
    const target = { accountId: 'main', peerId: 'oc_1', peerKind: 'group' as const };
    const first = await adapter.send(target, { kind: 'progress', text: '第一段', final: false });
    expect(transport.cards).toHaveLength(1);
    await adapter.send(target, { kind: 'progress', text: '第一段第二段', final: false, messageId: first.messageId }, { edit: true });
    // 续帧是「全量快照替换」：只能更新同一条卡片，不能新发 —— 否则手机端会反复收到同一段回答。
    expect(transport.cards).toHaveLength(1);
    expect(transport.patches).toHaveLength(1);
    expect(transport.patches[0].messageId).toBe(first.messageId);
    expect(JSON.stringify(transport.patches[0].card)).toContain('第一段第二段');
  });

  it('sends an approval card carrying the approval id', async () => {
    const { adapter, transport } = setup();
    await adapter.send({ accountId: 'main', peerId: 'oc_1', peerKind: 'dm' }, { kind: 'approval', text: '需要批准 y/n/a', approvalId: 'ap9' });
    expect(JSON.stringify(transport.cards[0].card)).toContain('ap9');
  });

  it('uploads image attachments as separate image messages when supported', async () => {
    const { adapter, transport } = setup(true);
    const png = new Uint8Array([137, 80, 78, 71]);
    const result = await adapter.send(
      { accountId: 'main', peerId: 'oc_1', peerKind: 'dm' },
      { kind: 'final', text: '图见附件', final: true, attachments: [{ name: 'diagram-1.png', mimeType: 'image/png', data: png }] },
    );
    expect(result.messageId).toBe('om_c1');
    expect(transport.images).toHaveLength(1);
    expect(transport.images[0].chatId).toBe('oc_1');
    expect(transport.images[0].name).toBe('diagram-1.png');
    expect(transport.images[0].image).toEqual(png);
  });

  it('drops image attachments when the transport cannot upload them', async () => {
    const { adapter, transport } = setup(false);
    await adapter.send(
      { accountId: 'main', peerId: 'oc_1', peerKind: 'dm' },
      { kind: 'final', text: '图见附件', final: true, attachments: [{ name: 'diagram-1.png', mimeType: 'image/png', data: new Uint8Array([1]) }] },
    );
    expect(transport.images).toHaveLength(0);
  });

  it('chunks long text notices', async () => {
    const { adapter, transport } = setup();
    const long = Array.from({ length: 200 }, (_, i) => `行${i} ${'y'.repeat(60)}`).join('\n');
    await adapter.send({ accountId: 'main', peerId: 'oc_1', peerKind: 'dm' }, { kind: 'notice', text: long, final: true });
    expect(transport.texts.length).toBeGreaterThan(1);
    for (const entry of transport.texts) expect(entry.text.length).toBeLessThanOrEqual(FEISHU_CAPABILITIES.maxTextLength);
  });

  it('lists its account id', () => {
    const { adapter } = setup();
    expect(adapter.listAccountIds()).toEqual(['main']);
  });
});
