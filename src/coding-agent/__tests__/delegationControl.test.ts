// S2 第二刀 — DelegationControlPlane：起飞闸消费、挂号簿纪律、参数捕获、
// 点名停支匹配。语义锁从 chat.ts 闭包原样迁移（不发明第二种语义）。
import { describe, expect, it } from 'bun:test';
import { DelegationControlPlane, type LiveBranchView } from '../delegationControl';
import type { TakeoffBlock } from '../../shared/steerTargeting';
import type { ToolCall } from '../../shared/types';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

const ROLES = new Set(['researcher', 'code_reviewer']);

describe('DelegationControlPlane gate', () => {
  it('captures delegation args regardless of pending registrations (resume evidence)', () => {
    const plane = new DelegationControlPlane();
    plane.gate([call('c1', 'researcher', { prompt: '查爆发点' })], ROLES);
    expect(plane.delegationArgs.get('c1')).toEqual({ name: 'researcher', args: '{"prompt":"查爆发点"}' });
  });

  it('blocks a taking-off delegation whose task snippet matches a registered cancel', () => {
    const plane = new DelegationControlPlane();
    plane.registerCancel('不用调研爆发点了');
    const blocked = plane.gate([
      call('c_ok', 'researcher', { prompt: '查定价' }),
      call('c_hit', 'researcher', { prompt: '调研爆发点的来龙去脉' }),
    ], ROLES);
    expect(blocked.map((b) => b.callId)).toEqual(['c_hit']);
    expect(blocked[0].kind).toBe('cancelled-before-dispatch');
    // 一次性消费：下一批同目标不再拦。
    expect(plane.gate([call('c_hit2', 'researcher', { prompt: '再调研爆发点' })], ROLES)).toEqual([]);
  });

  it('exempts synthetic re-dispatch ids (resume_/foldin_ carry the user’s latest words)', () => {
    const plane = new DelegationControlPlane();
    plane.registerCancel('停掉爆发点调研');
    expect(plane.gate([call('resume_c1', 'researcher', { prompt: '接着调研爆发点' })], ROLES)).toEqual([]);
    expect(plane.gate([call('foldin_c1', 'researcher', { prompt: '爆发点追加' })], ROLES)).toEqual([]);
  });

  it('settleRound clears registrations but keeps delegation args (resume points at history)', () => {
    const plane = new DelegationControlPlane();
    plane.registerCancel('x');
    plane.registerBranchStop('停掉那支', 'researcher·1号');
    plane.gate([call('c1', 'researcher', { prompt: '查' })], ROLES);
    plane.settleRound();
    expect(plane.pendingCancelCount()).toBe(0);
    expect(plane.gate([call('c2', 'researcher', { prompt: '查那支' })], ROLES)).toEqual([]);
    expect(plane.delegationArgs.size).toBe(2); // c1 + c2 都捕获（续跑凭据跨回合）
  });
});

describe('DelegationControlPlane stopNamed', () => {
  const live: LiveBranchView[] = [
    { callId: 'call_a', name: 'researcher', snippet: '调研竞品定价策略' },
    { callId: 'call_b', name: 'code_reviewer', snippet: '审查安全模块' },
  ];

  it('routes a distinctive-word stop to the named branch via the act seam', () => {
    const plane = new DelegationControlPlane();
    const acted: Array<{ callId: string; mode: string }> = [];
    const stopped = plane.stopNamed(
      '停掉竞品那支',
      live,
      (callId, mode) => { acted.push({ callId, mode }); return true; },
      (name) => name,
      'abort',
    );
    expect(stopped).toEqual({ callId: 'call_a', label: 'researcher' });
    expect(acted).toEqual([{ callId: 'call_a', mode: 'abort' }]);
    // 停成功即挂起飞闸：同回合重派的同目标在出生点拦下。
    expect(plane.gate([call('c_redo', 'researcher', { prompt: '再调研竞品定价' })], ROLES).map((b: TakeoffBlock) => b.callId)).toEqual(['c_redo']);
  });

  it('passes the pause mode through when the host asks for a gentler stop', () => {
    const plane = new DelegationControlPlane();
    const acted: string[] = [];
    plane.stopNamed('停掉竞品那支', live, (callId, mode) => { acted.push(mode); return true; }, (n) => n, 'pause');
    expect(acted).toEqual(['pause']);
  });

  it('returns null when no distinctive word resolves (fold back, never misfire)', () => {
    const plane = new DelegationControlPlane();
    expect(plane.stopNamed('停掉那支', live, () => true, (n) => n, 'abort')).toBeNull();
    // 真正的打平用例：两支的任务书都含「调研」（改 matching 面）。
    const both: LiveBranchView[] = [
      { callId: 'x1', name: 'researcher', snippet: '调研甲主题' },
      { callId: 'x2', name: 'researcher', snippet: '调研乙主题' },
    ];
    expect(plane.stopNamed('停掉调研', both, () => true, (n) => n, 'abort')).toBeNull(); // 区分词打平 ⇒ 宁可不停
  });

  it('returns null when the act seam declines (branch just settled)', () => {
    const plane = new DelegationControlPlane();
    expect(plane.stopNamed('停掉竞品那支', live, () => false, (n) => n, 'abort')).toBeNull();
  });
});
