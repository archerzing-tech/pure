import { describe, it, expect } from 'bun:test';
import { ChannelApprovalBroker, formatApprovalText, parseApprovalAnswer } from '../approvals';
import type { ChannelTarget, OutboundMessage } from '../types';
import type { PermissionRequestInfo } from '../../coding-agent/types';

const target: ChannelTarget = { accountId: 'default', peerId: 'p1', peerKind: 'dm' };
const info: PermissionRequestInfo = { tool: 'write_file', description: 'write a file', dangerLevel: 'caution', riskLevel: 'medium', path: '/tmp/a.txt' };

describe('approval parsing', () => {
  it('maps y / a / n in both languages', () => {
    expect(parseApprovalAnswer('y')).toBe('allow');
    expect(parseApprovalAnswer('  是 ')).toBe('allow');
    expect(parseApprovalAnswer('A')).toBe('always');
    expect(parseApprovalAnswer('始终允许')).toBe('always');
    expect(parseApprovalAnswer('n')).toBe('deny');
    expect(parseApprovalAnswer('拒绝')).toBe('deny');
    expect(parseApprovalAnswer('hello')).toBeNull();
  });

  it('always includes the text-instruction fallback in the card body', () => {
    const text = formatApprovalText(info, 'ap1');
    expect(text).toContain('回复 y 批准');
    expect(text).toContain('#ap1');
    expect(text).toContain('write_file');
  });
});

describe('ChannelApprovalBroker', () => {
  it('resolves when the user replies y', async () => {
    const sent: OutboundMessage[] = [];
    const broker = new ChannelApprovalBroker(async (_t, m) => { sent.push(m); });
    const decision = broker.request(target, 's1', info);
    expect(sent[0].kind).toBe('approval');
    expect(broker.handleReply('s1', 'y')).toBe(true);
    expect(await decision).toEqual({ allowed: true });
  });

  it('remembers with a', async () => {
    const broker = new ChannelApprovalBroker(async () => {});
    const decision = broker.request(target, 's1', info);
    broker.handleReply('s1', 'a');
    expect(await decision).toEqual({ allowed: true, remember: true });
  });

  it('denies with n', async () => {
    const broker = new ChannelApprovalBroker(async () => {});
    const decision = broker.request(target, 's1', info);
    broker.handleReply('s1', 'n');
    const result = await decision;
    expect(result.allowed).toBe(false);
  });

  it('times out into a denial', async () => {
    const broker = new ChannelApprovalBroker(async () => {}, { timeoutMs: 20 });
    const decision = await broker.request(target, 's1', info);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('超时');
  });

  it('still accepts a text reply after the card delivery fails', async () => {
    const errors: string[] = [];
    const broker = new ChannelApprovalBroker(async () => { throw new Error('card unavailable'); }, { log: (m) => errors.push(m) });
    const decision = broker.request(target, 's1', info);
    expect(broker.handleReply('s1', 'y')).toBe(true);
    expect((await decision).allowed).toBe(true);
    expect(errors.join('\n')).toContain('approval card delivery failed');
  });

  it('ignores replies that are not approval answers', () => {
    const broker = new ChannelApprovalBroker(async () => {});
    expect(broker.handleReply('s1', 'what is the weather')).toBe(false);
  });

  it('cancels a session pending request as a denial', async () => {
    const broker = new ChannelApprovalBroker(async () => {});
    const decision = broker.request(target, 's1', info);
    broker.cancelSession('s1');
    expect((await decision).allowed).toBe(false);
    expect(broker.pendingCount).toBe(0);
  });
});
