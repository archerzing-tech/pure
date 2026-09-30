import { describe, it, expect } from 'bun:test';
import {
  actionToInboundEvent,
  approvalDecisionFromAction,
  buildApprovalCard,
  chunkText,
  decisionToReplyText,
  stripMentions,
  toInboundEvent,
} from '../normalize';
import type { FeishuCardAction, FeishuRawMessage } from '../types';

function raw(overrides: Partial<FeishuRawMessage> = {}): FeishuRawMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    messageType: 'text',
    text: '@_user_1 帮我看下这个文件',
    mentionsBot: true,
    senderId: 'ou_1',
    ...overrides,
  };
}

describe('feishu stripMentions', () => {
  it('removes mention placeholders and collapses the gap', () => {
    expect(stripMentions('@_user_1 hello @_user_2 world')).toBe('hello world');
    expect(stripMentions('@_user_1')).toBe('');
  });
});

describe('feishu inbound normalization', () => {
  it('maps a group message to a group InboundEvent with the mention fact', () => {
    const event = toInboundEvent(raw(), 'main');
    expect(event.channelId).toBe('feishu');
    expect(event.peer).toMatchObject({ id: 'oc_1', kind: 'group' });
    expect(event.text).toBe('帮我看下这个文件');
    expect(event.addressed).toBe(true);
    expect(event.messageId).toBe('om_1');
  });

  it('maps p2p to a dm peer', () => {
    expect(toInboundEvent(raw({ chatType: 'p2p' }), 'main').peer.kind).toBe('dm');
  });

  it('records addressed=false when the bot was not mentioned', () => {
    expect(toInboundEvent(raw({ mentionsBot: false }), 'main').addressed).toBe(false);
  });
});

describe('feishu chunking', () => {
  it('leaves short text untouched', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('splits long text with an (i/n) suffix and respects the cap', () => {
    const text = Array.from({ length: 12 }, (_, i) => `段落${i} ${'x'.repeat(30)}`).join('\n\n');
    const chunks = chunkText(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks[0]).toContain('(1/');
    expect(chunks[chunks.length - 1]).toContain(`${chunks.length}/`);
  });
});

describe('feishu cards', () => {
  it('builds an approval card whose buttons carry the decision', () => {
    const card = buildApprovalCard('需要批准', 'ap7') as { elements: Array<{ tag: string; actions?: Array<{ value: Record<string, unknown> }> }> };
    const action = card.elements.find((e) => e.tag === 'action');
    expect(action?.actions?.map((a) => a.value)).toEqual([
      { approvalId: 'ap7', decision: 'allow' },
      { approvalId: 'ap7', decision: 'always' },
      { approvalId: 'ap7', decision: 'deny' },
    ]);
  });

  it('parses only known decisions', () => {
    expect(approvalDecisionFromAction({ decision: 'allow' })).toBe('allow');
    expect(approvalDecisionFromAction({ decision: 'always' })).toBe('always');
    expect(approvalDecisionFromAction({ decision: 'deny' })).toBe('deny');
    expect(approvalDecisionFromAction({ decision: 'maybe' })).toBeNull();
    expect(approvalDecisionFromAction({})).toBeNull();
  });

  it('translates a button decision into the shared y/a/n reply text', () => {
    expect(decisionToReplyText('allow')).toBe('y');
    expect(decisionToReplyText('always')).toBe('a');
    expect(decisionToReplyText('deny')).toBe('n');
  });

  it('turns a card action into an inbound reply on the same session key', () => {
    const action: FeishuCardAction = { openId: 'ou_1', chatId: 'oc_9', chatType: 'group', messageId: 'om_9', actionValue: { decision: 'allow' } };
    const event = actionToInboundEvent(action, 'allow', 'main');
    expect(event.text).toBe('y');
    expect(event.peer).toMatchObject({ id: 'oc_9', kind: 'group' });
  });
});
