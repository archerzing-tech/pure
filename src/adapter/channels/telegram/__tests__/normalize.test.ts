import { describe, it, expect } from 'bun:test';
import { isRoutableChatType, stripBotMention, toInboundEvent, parseTelegramApprovalReply, approvalHint } from '../normalize';
import type { TelegramRawMessage } from '../types';

const RAW_DM: TelegramRawMessage = {
  messageId: 5,
  chat: { id: 42, type: 'private' },
  from: { id: 7, username: 'alice', firstName: 'Alice' },
  date: 1_700_000_000,
  text: '你好',
  botUsername: 'pure_bot',
};

const RAW_GROUP_MENTION: TelegramRawMessage = {
  messageId: 6,
  chat: { id: -100123, type: 'supergroup', title: '调研群' },
  from: { id: 8 },
  date: 1_700_000_001,
  text: '@pure_bot 停掉调研那支',
  botUsername: 'pure_bot',
};

describe('telegram normalize', () => {
  it('private → dm 且天然 addressed', () => {
    const event = toInboundEvent(RAW_DM, 'main');
    expect(event.channelId).toBe('telegram');
    expect(event.peer.kind).toBe('dm');
    expect(event.peer.id).toBe('42');
    expect(event.addressed).toBe(true);
    expect(event.text).toBe('你好');
    expect(event.receivedAt).toBe(1_700_000_000_000);
  });

  it('group：@bot 提及才 addressed，且剥掉提及前缀', () => {
    const event = toInboundEvent(RAW_GROUP_MENTION, 'main');
    expect(event.peer.kind).toBe('group');
    expect(event.peer.id).toBe('-100123');
    expect(event.addressed).toBe(true);
    expect(event.text).toBe('停掉调研那支');
  });

  it('group：无 @bot 提及 = 未点名（不触发回合）', () => {
    const event = toInboundEvent({ ...RAW_GROUP_MENTION, text: '大家早上好' }, 'main');
    expect(event.addressed).toBe(false);
  });

  it('messageId 全局幂等键 = chat.id:message_id', () => {
    expect(toInboundEvent(RAW_DM, 'main').messageId).toBe('42:5');
    expect(toInboundEvent(RAW_GROUP_MENTION, 'main').messageId).toBe('-100123:6');
  });

  it('channel 型广播频道不可路由（adapter 层跳过）', () => {
    expect(isRoutableChatType('channel')).toBe(false);
    expect(isRoutableChatType('private')).toBe(true);
    expect(isRoutableChatType('group')).toBe(true);
    expect(isRoutableChatType('supergroup')).toBe(true);
  });

  it('stripBotMention：无 botUsername 时只 trim 不剥', () => {
    expect(stripBotMention('  hi  ', '@pure_bot')).toBe('hi');
    expect(stripBotMention('@pure_bot hi')).toBe('@pure_bot hi');
    expect(stripBotMention('@pure_bot hi', undefined)).toBe('@pure_bot hi');
    // 正则元字符不炸（bot 用户名理论不含，防御性）
    expect(stripBotMention('@a.b hi', 'a.b')).toBe('hi');
  });

  it('审批短指令双语词表（与钉钉/QQ 同一套）', () => {
    expect(parseTelegramApprovalReply('y')).toBe('allow');
    expect(parseTelegramApprovalReply('批准')).toBe('allow');
    expect(parseTelegramApprovalReply('a')).toBe('always');
    expect(parseTelegramApprovalReply('n')).toBe('deny');
    expect(parseTelegramApprovalReply('拒绝')).toBe('deny');
    expect(parseTelegramApprovalReply('请继续调研第二个主题')).toBeNull();
  });

  it('审批提示带按钮标签', () => {
    expect(approvalHint([{ id: 'allow', label: '批准' }, { id: 'deny', label: '拒绝' }])).toContain('[批准]  [拒绝]');
    expect(approvalHint()).toContain('回复 y 批准');
  });
});
