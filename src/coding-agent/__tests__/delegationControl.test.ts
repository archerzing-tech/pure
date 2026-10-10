// S2 第二刀 — DelegationControlPlane：起飞闸消费、挂号簿纪律、参数捕获、
// 点名停支匹配。语义锁从 chat.ts 闭包原样迁移（不发明第二种语义）。
import { describe, expect, it } from 'bun:test';
import { DelegationControlPlane } from '../delegationControl';
import { RESUME_INVARIANTS as RESUME_INV } from '../../shared/insertionMessaging';
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
    plane.gate([call('c1', 'researcher', { prompt: '查' })], ROLES);
    plane.settleRound();
    expect(plane.pendingCancelCount()).toBe(0);
    expect(plane.gate([call('c2', 'researcher', { prompt: '查那支' })], ROLES)).toEqual([]);
    expect(plane.delegationArgs.size).toBe(2); // c1 + c2 都捕获（续跑凭据跨回合）
  });
});

// 停支目标指认（2026-10-10 模型判断、宿主执行）：旧 stopNamed（区分词匹配
// + 单支兜底）整刀拆除——「停哪支」是理解，归裁决器从花名册里指认确切
// callId，plane 不再做任何停支匹配。指认编排（裁决器点名 → 校验在飞 →
// 确切 id 执行真停）住在 interjectOrchestrator.resolveStopTarget，行为覆盖
// 在 UI 侧 conversationSamples 与 DynamicInsertionCoordinator 测试；plane
// 只剩出生前取消的挂号簿。

describe('DelegationControlPlane resume ledger', () => {
  // checkpoint 凭据随记录走（第 2 期第三刀）：命中/未命中二分是收执诚实性
  // 的地基——记录里没有它，收执就只能无脑许愿「从断点续」。
  const record = { callId: 'call_a', name: 'researcher', args: '{"prompt":"调研竞品定价策略"}', label: 'researcher', text: '把竞品那支接着跑完', images: [], checkpoint: { hit: true, turns: 7 } };
  const missedRecord = { ...record, checkpoint: { hit: false, turns: 0 } };

  it('queues a named paused branch and shows it in the view', () => {
    const plane = new DelegationControlPlane();
    expect(plane.queueResume(record)).toBe(true);
    expect(plane.pendingResumesView()).toHaveLength(1);
    expect(plane.pendingResumesView()[0].callId).toBe('call_a');
    expect(plane.pendingResumesView()[0].checkpoint).toEqual({ hit: true, turns: 7 }); // 凭据随记录走
  });

  it('declines a duplicate queue for the same branch (never double-dispatch)', () => {
    const plane = new DelegationControlPlane();
    plane.queueResume(record);
    expect(plane.queueResume(record)).toBe(false);
    expect(plane.pendingResumesView()).toHaveLength(1);
  });

  it('hands all queued resumes over exactly once via takeResumes', () => {
    const plane = new DelegationControlPlane();
    plane.queueResume(record);
    expect(plane.takeResumes()).toHaveLength(1);
    expect(plane.takeResumes()).toHaveLength(0);
  });

  it('builds the explicit re-dispatch fallback task with original phrasing kept in displayText', () => {
    const plane = new DelegationControlPlane();
    expect(plane.settleResumesFallback()).toBeNull();
    plane.queueResume(record);
    const task = plane.settleResumesFallback();
    expect(task).not.toBeNull();
    expect(task!.text).toContain('【分支级继续】');
    expect(task!.text).toContain('相同参数');
    expect(task!.text).toContain('researcher'); // 凭据里的支名进兜底指令
    expect(task!.displayText).toBe('把竞品那支接着跑完'); // 渲染一致性：原话重入
    expect(plane.pendingResumesView()).toHaveLength(0); // 兜底即清账
  });

  it('fallback instruction splits on the checkpoint verdict (hit says from-round, miss admits re-run)', () => {
    const hit = new DelegationControlPlane();
    hit.queueResume(record);
    const hitTask = hit.settleResumesFallback()!;
    expect(hitTask.text).toContain('从存档断点（第 7 轮）续跑');
    expect(hitTask.text).toContain('不要从头做');
    expect(hitTask.text).not.toContain('没找到存档');
    // 兜底文案与收执同锚（RESUME_INVARIANTS）：miss 语必须含「没找到存档」
    // 子串、hit 语必须咬「从存档断点（第 N 轮）」——锚的覆盖面不含兜底就是
    // 游离在一致性测试外，靠自身字面断言自锁（独立检验观察点，2026-10-09）。
    expect(hitTask.text).toMatch(RESUME_INV.hitSaysFromCheckpoint);
    const miss = new DelegationControlPlane();
    miss.queueResume(missedRecord);
    const missTask = miss.settleResumesFallback()!;
    expect(missTask.text).toContain('没找到存档');
    expect(missTask.text).toMatch(RESUME_INV.missAdmitsNoArchive);
    expect(missTask.text).toContain('会重新跑一遍');
    expect(missTask.text).not.toContain('断点'); // 没命中绝不预支断点承诺
  });

  it('keeps resumes across settleRound (a resume names history, not this round)', () => {
    const plane = new DelegationControlPlane();
    plane.queueResume(record);
    plane.settleRound();
    expect(plane.pendingResumesView()).toHaveLength(1); // 与 delegationArgs 同命
  });
});
