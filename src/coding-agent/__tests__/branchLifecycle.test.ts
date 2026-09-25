// src/coding-agent/__tests__/branchLifecycle.test.ts
// 分支生命周期状态机的转移表全测：合法路径、幂等、迟到的动作、结算对齐、
// describe 映射。设计口径见 branchLifecycle.ts 头注（2026-09-25 用户设想）。

import { describe, expect, it } from 'bun:test';
import { BranchLifecycle, applyBranchAction } from '../branchLifecycle';

describe('branchLifecycle 转移表', () => {
  it('正常一生：委派中 → 运行中 → 暂停收尾 → 暂停中 →（重派另起账本）', () => {
    const m = new BranchLifecycle('call_1', 'test_researcher');
    expect(m.state()).toBe('delegating');
    expect(m.apply('spawned')).toMatchObject({ ok: true, transition: { from: 'delegating', to: 'running' } });
    expect(m.apply('pause')).toMatchObject({ ok: true, transition: { from: 'running', to: 'pausing' } });
    expect(m.apply('pauseSettled')).toMatchObject({ ok: true, transition: { from: 'pausing', to: 'paused' } });
    expect(m.isTerminal()).toBe(false);
  });

  it('完成与失败两条终点线，失败挂原因', () => {
    const done = new BranchLifecycle('c1', 'a');
    done.apply('spawned');
    expect(done.apply('complete')).toMatchObject({ ok: true, transition: { to: 'completed' } });
    expect(done.isTerminal()).toBe(true);

    const failed = new BranchLifecycle('c2', 'a');
    failed.apply('spawned');
    expect(failed.apply('fail', { failCause: 'timeout' })).toMatchObject({ ok: true, transition: { to: 'failed' } });
    expect(failed.cause()).toBe('timeout');
  });

  it('暂停幂等：收尾期再暂停不动状态；已暂停再暂停明确拒绝', () => {
    const m = new BranchLifecycle('c', 'a');
    m.apply('spawned');
    m.apply('pause');
    expect(m.apply('pause')).toMatchObject({ ok: false });
    expect(m.state()).toBe('pausing');
    m.apply('pauseSettled');
    const late = m.apply('pause');
    expect(late).toMatchObject({ ok: false });
    expect(String((late as { reason: string }).reason)).toContain('already paused');
  });

  it('宽限内自然收尾：pausing → completed 合法（暂停输给了它自己跑完）', () => {
    const m = new BranchLifecycle('c', 'a');
    m.apply('spawned');
    m.apply('pause');
    expect(m.apply('complete')).toMatchObject({ ok: true, transition: { from: 'pausing', to: 'completed' } });
  });

  it('中止压过一切：任何非终态可中止；终态再中止拒绝', () => {
    for (const prep of [
      [] as const,
      ['spawned'] as const,
      ['spawned', 'pause'] as const,
      ['pause'] as const,
    ]) {
      const m = new BranchLifecycle('c', 'a');
      for (const step of prep) m.apply(step);
      expect(m.apply('abort', { abortCause: 'user-branch' })).toMatchObject({ ok: true, transition: { to: 'aborted' } });
      expect(m.cause()).toBe('user-branch');
      expect(m.apply('abort')).toMatchObject({ ok: false });
    }
  });

  it('结算对齐地面真相：漏看 pause 时 pauseSettled 仍能落到 paused', () => {
    // 编排器若没捕到暂停信号瞬间（竞态），子代理以暂停存档落定——运行结果
    // 是地面真相，状态机对齐到 paused，不跟丢。
    const m = new BranchLifecycle('c', 'a');
    expect(m.apply('pauseSettled')).toMatchObject({ ok: true, transition: { from: 'delegating', to: 'paused' } });
  });

  it('终态之后的迟到结算被忽略（旧事件不翻账）', () => {
    const m = new BranchLifecycle('c', 'a');
    m.apply('spawned');
    m.apply('complete');
    for (const action of ['spawned', 'pauseSettled', 'complete', 'fail'] as const) {
      const r = m.apply(action);
      expect(r).toMatchObject({ ok: false });
      expect(String((r as { reason: string }).reason)).toContain('late');
    }
    expect(m.state()).toBe('completed');
  });

  it('describe 映射：中间态都是 running，终态各归各位，超时挂 timed_out', () => {
    expect(new BranchLifecycle('c', 'a').describe()).toEqual({ status: 'running', lifecycle: 'started' });
    const paused = new BranchLifecycle('c', 'a');
    paused.apply('pauseSettled');
    expect(paused.describe()).toEqual({ status: 'paused', lifecycle: 'paused' });
    const aborted = new BranchLifecycle('c', 'a');
    aborted.apply('abort');
    expect(aborted.describe()).toEqual({ status: 'cancelled', lifecycle: 'cancelled' });
    const timedOut = new BranchLifecycle('c', 'a');
    timedOut.apply('fail', { failCause: 'stalled' });
    expect(timedOut.describe()).toEqual({ status: 'timed_out', lifecycle: 'timed_out' });
    const failed = new BranchLifecycle('c', 'a');
    failed.apply('fail', { failCause: 'error' });
    expect(failed.describe()).toEqual({ status: 'failed', lifecycle: 'failed' });
  });
});

describe('branchLifecycle 纯转移口径', () => {
  it('纯函数与类内行为一致（防两处漂移）', () => {
    expect(applyBranchAction('running', 'pause')).toEqual({ to: 'pausing' });
    const r = applyBranchAction('completed', 'complete');
    expect('rejected' in r && r.rejected).toContain('settled');
    expect(applyBranchAction('paused', 'pause')).toMatchObject({ rejected: expect.stringContaining('already') });
  });
});
