import { describe, it, expect } from 'bun:test';
import { actionToInboundEvent, buildDingTalkCard, parseDingTalkAction, stripAtPrefix, toInboundEvent } from '../normalize';
import type { DingTalkRawMessage } from '../types';

function raw(overrides: Partial<DingTalkRawMessage> = {}): DingTalkRawMessage {
  return {
    messageId: 'msg_1',
    conversationId: 'cid_1',
    conversationType: '2',
    text: '@pure 帮我看下',
    atBot: true,
    senderStaffId: 'staff_1',
    senderNick: 'Ann',
    ...overrides,
  };
}

describe('dingtalk stripAtPrefix', () => {
  it('removes the bot nickname prefix only when the bot was addressed', () => {
    expect(stripAtPrefix('@pure 帮我看下', true)).toBe('帮我看下');
    expect(stripAtPrefix('@同事 帮我看下', false)).toBe('@同事 帮我看下');
  });
});

describe('dingtalk inbound normalization', () => {
  it('maps a group message to a group event with the at fact', () => {
    const event = toInboundEvent(raw(), 'main');
    expect(event.channelId).toBe('dingtalk');
    expect(event.peer).toMatchObject({ id: 'cid_1', kind: 'group', name: 'Ann' });
    expect(event.text).toBe('帮我看下');
    expect(event.addressed).toBe(true);
  });

  it('maps conversationType 1 to a dm peer', () => {
    expect(toInboundEvent(raw({ conversationType: '1' }), 'main').peer.kind).toBe('dm');
  });
});

describe('dingtalk action parsing', () => {
  it('follows the platform action vocabulary', () => {
    for (const action of ['allow', 'approve', 'approved', 'accept', 'agree', 'ALLOW']) {
      expect(parseDingTalkAction(action)).toBe('allow');
    }
    expect(parseDingTalkAction('always')).toBe('always');
    for (const action of ['deny', 'denied', 'reject']) {
      expect(parseDingTalkAction(action)).toBe('deny');
    }
    expect(parseDingTalkAction('maybe')).toBeNull();
  });
});

describe('dingtalk cards', () => {
  it('carries the outTrackId and buttons', () => {
    const card = buildDingTalkCard('需要批准', 'ap3', [{ id: 'allow', label: '批准' }]);
    expect(card.outTrackId).toBe('ap3');
    expect(card.buttons?.[0]).toEqual({ id: 'allow', label: '批准' });
  });

  it('turns a card action into a y/a/n reply on the same conversation', () => {
    const event = actionToInboundEvent({ outTrackId: 'ap3', action: 'agree', conversationId: 'cid_9', conversationType: '2' }, 'allow', 'main');
    expect(event.text).toBe('y');
    expect(event.peer).toMatchObject({ id: 'cid_9', kind: 'group' });
  });
});
