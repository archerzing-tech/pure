import { describe, it, expect } from 'bun:test';
import { stripAtPrefix, toInboundEvent, parseQQApprovalReply, approvalHint } from '../normalize';

describe('qq normalize', () => {
  it('strips the @ bot prefix before the text reaches the model', () => {
    expect(stripAtPrefix('@pure 你好')).toBe('你好');
    expect(stripAtPrefix('  @pure-bot   看下进度 ')).toBe('看下进度');
    expect(stripAtPrefix('没有艾特前缀')).toBe('没有艾特前缀');
  });

  it('maps a group message to a group peer with the conversation routing key', () => {
    const event = toInboundEvent(
      { messageId: 'g1', conversationId: 'group_openid_1', conversationType: 'group', text: '@pure 停掉调研那支',
        authorId: 'u2', authorName: '旅行中', replyMsgId: 'g1', createTime: 1_700_000_000_000 },
      'main',
    );
    expect(event.channelId).toBe('qq');
    expect(event.peer.kind).toBe('group');
    expect(event.peer.id).toBe('group_openid_1');
    expect(event.text).toBe('停掉调研那支');
    expect(event.addressed).toBe(true);
  });

  it('parses approval short replies in both EN and ZH vocabularies', () => {
    expect(parseQQApprovalReply('y')).toBe('allow');
    expect(parseQQApprovalReply('批准')).toBe('allow');
    expect(parseQQApprovalReply('A')).toBe('always');
    expect(parseQQApprovalReply('n')).toBe('deny');
    expect(parseQQApprovalReply('不同意')).toBe('deny');
    expect(parseQQApprovalReply('请继续调研第二个主题')).toBeNull();
  });

  it('renders the approval hint with configured buttons when present', () => {
    expect(approvalHint([{ id: 'allow', label: '批准' }, { id: 'deny', label: '拒绝' }])).toContain('[批准]  [拒绝]');
    expect(approvalHint()).toContain('回复 y 批准');
  });
});
