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

  it('timeout denial fires with nothing else keeping the process alive (Windows/Bun 判例 2026-11-14)', async () => {
    // 判例：超时计时器一旦 unref，审批 pending 期网关进程再无其他 ref 句柄，
    // Bun（1.3.14 / Windows x64）的事件循环不再被唤醒——超时永不触发、await
    // 永不返回，bun test 整链卡死只能强杀。回归哨兵：若 unref 回归，本用例
    // 5s 后经 guard 报错，而不是无声挂死测试进程。
    const broker = new ChannelApprovalBroker(async () => {}, { timeoutMs: 20 });
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const decision = await Promise.race([
      broker.request(target, 's1', info),
      new Promise<never>((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error('审批超时 5s 未触发：approvals.ts 的超时计时器又被 unref 了吗？（Windows/Bun 判例 2026-11-14）')),
          5_000,
        );
      }),
    ]);
    clearTimeout(guardTimer);
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

  it('cancelSession drops the decision artifacts too, not just pending (审计批 4③)', async () => {
    // infos/targets 是永久 Map：清场若不同点删，超时之外的一切出口都会留
    // 下永不回收的旧条目。cancelSession 必须走同一个清理点。
    const broker = new ChannelApprovalBroker(async () => {});
    const decision = broker.request(target, 's1', info);
    broker.cancelSession('s1');
    await decision;
    const ledger = broker as unknown as { infos: Map<string, unknown>; targets: Map<string, unknown> };
    expect(ledger.infos.size).toBe(0);
    expect(ledger.targets.size).toBe(0);
  });
});
