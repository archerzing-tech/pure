// src/shared/__tests__/roleTrial.test.ts
// 阶段 13.2 试用制准入的判据测试。
//
// 这套判据的危险不在「写错了」，在**读错了结论**：把「没测到」读成「通过」会给
// 一个从未被比较过的角色发永久通行证。所以多数用例钉的是「不该裁决」的那一侧。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  judgeRoleTrial,
  renderTrialMarker,
  trialBadge,
  trialPromotionReason,
  trialStateFromMarker,
  TRIAL_MIN_DELEGATIONS,
  TRIAL_MARKER_SUFFIX,
  trialMarkerFileName,
  type RoleOutcome,
  type RoleTrialState,
} from '../roleTrial';

const NOW = 1_700_000_000_000;
const PARENT = 'researcher';
const CHILD = 'researcher_focused';

const ok = (delegations: number, successes: number): RoleOutcome => ({ delegations, successes });

/** A child that matches its parent's success rate exactly — the "does not lose"
 *  line, matching how the overlay A/B gate reads. */
const matching: RoleOutcome = ok(6, 5);

describe('试用态从旁挂账读出，缺省即「在试用中」', () => {
  it('没有旁挂账 → 试用中（手写的 manifest 未被证明过，就不该发通行证）', () => {
    expect(trialStateFromMarker(undefined)).toEqual({ status: 'trial' });
    expect(trialStateFromMarker(null)).toEqual({ status: 'trial' });
    expect(trialStateFromMarker('not json')).toEqual({ status: 'trial' });
    expect(trialStateFromMarker('[]')).toEqual({ status: 'trial' });
  });

  it('坏账不该把角色藏起来：解析失败仍读成试用中，而不是 undefined', () => {
    expect(trialStateFromMarker('{ broken').status).toBe('trial');
  });

  it('往返：渲染后再解析得到同一个状态', () => {
    const state: RoleTrialState = { status: 'promoted', parentRole: PARENT, registeredAt: NOW, decidedAt: NOW + 1, reason: 'ok' };
    expect(trialStateFromMarker(renderTrialMarker(state))).toEqual(state);
  });

  it('未知 status 读成试用中（宁可保守，不可误发永久状态）', () => {
    expect(trialStateFromMarker({ status: 'archived' }).status).toBe('trial');
    // Array guard: the OBJECT form of '[]' never reaches it in the string test.
    expect(trialStateFromMarker([] as unknown as object)).toEqual({ status: 'trial' });
  });
});

describe('转正裁决：够格才转，不够与不测都不转', () => {
  const baseline = { [PARENT]: ok(12, 10) };

  it('样本不够 → 继续攒，并说清还差几次', () => {
    const verdict = judgeRoleTrial({ state: { status: 'trial', parentRole: PARENT }, outcome: ok(3, 2), baselineByRole: baseline });
    expect(verdict).toEqual({ kind: 'accumulating', delegations: 3, need: TRIAL_MIN_DELEGATIONS });
  });

  it('比父角色好或持平 → 够格转正，且证据里两侧数字都在', () => {
    const verdict = judgeRoleTrial({ state: { status: 'trial', parentRole: PARENT }, outcome: ok(6, 6), baselineByRole: baseline });
    expect(verdict.kind).toBe('promote');
    if (verdict.kind !== 'promote') return;
    expect(verdict.evidence).toContain('6 次委派');
    expect(verdict.evidence).toContain(PARENT);
    expect(verdict.evidence).toContain('83%');
  });

  it('持平也算过（门槛是「不输」，与 overlay A/B 同一口径）', () => {
    const equal = { [PARENT]: ok(10, 5) }; // 50%
    expect(judgeRoleTrial({ state: { status: 'trial', parentRole: PARENT }, outcome: ok(10, 5), baselineByRole: equal }).kind).toBe('promote');
  });

  it('比父角色差 → 不达标，留在试用里', () => {
    const verdict = judgeRoleTrial({ state: { status: 'trial', parentRole: PARENT }, outcome: ok(6, 1), baselineByRole: baseline });
    expect(verdict.kind).toBe('below-baseline');
  });

  it('没记父角色 → 不裁决（不知道该跟谁比）', () => {
    expect(judgeRoleTrial({ state: { status: 'trial' }, outcome: matching, baselineByRole: baseline })).toEqual({ kind: 'no-baseline' });
  });

  it('父角色自己样本不足 → 不裁决，且报出是谁', () => {
    expect(judgeRoleTrial({
      state: { status: 'trial', parentRole: PARENT },
      outcome: matching,
      baselineByRole: { [PARENT]: ok(2, 2) },
    })).toEqual({ kind: 'no-baseline', parentRole: PARENT });
  });

  it('父角色根本没有记录 → 不裁决', () => {
    expect(judgeRoleTrial({ state: { status: 'trial', parentRole: PARENT }, outcome: matching, baselineByRole: {} }).kind).toBe('no-baseline');
  });

  it('已转正的再裁决一次仍是 already-promoted（幂等）', () => {
    expect(judgeRoleTrial({ state: { status: 'promoted', parentRole: PARENT }, outcome: ok(2, 0), baselineByRole: baseline }).kind).toBe('already-promoted');
  });

  it('门槛可注入', () => {
    const state: RoleTrialState = { status: 'trial', parentRole: PARENT };
    expect(judgeRoleTrial({ state, outcome: ok(2, 2), baselineByRole: baseline, minDelegations: 5 }).kind).toBe('accumulating');
    expect(judgeRoleTrial({ state, outcome: ok(2, 2), baselineByRole: baseline, minDelegations: 2 }).kind).toBe('promote');
  });
});

describe('角标：五种读数各有各的话', () => {
  const baseline = { [PARENT]: ok(12, 10) };
  const judge = (state: RoleTrialState, outcome: RoleOutcome) =>
    judgeRoleTrial({ state, outcome, baselineByRole: baseline });

  it('badge.status 决定渲染层用哪个 CSS class，所以它必须跟着裁决走', () => {
    const promoted = trialBadge(CHILD, { status: 'promoted' }, { kind: 'already-promoted' });
    expect(promoted.status).toBe('promoted');
    const trial = trialBadge(CHILD, { status: 'trial' }, judge({ status: 'trial', parentRole: PARENT }, ok(6, 6)));
    expect(trial.status).toBe('trial');
  });

  it('旁挂账后缀在 TS 与 Rust 两侧逐字一致', () => {
    // 这两个字面量跨语言各存一份（Rust 没有理由为一个后缀去 import TS）。
    // 改一边就会静默炸：Rust 侧的排除失效 → 账被当成 manifest 扫进去；或者
    // 扫描排除的其实不是写入的那个名字 → 所有角色永远读成「未记父角色」。
    const rust = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const declared = /TRIAL_MARKER_SUFFIX: &str = "([^"]+)"/.exec(rust)?.[1];
    expect(declared).toBe(TRIAL_MARKER_SUFFIX);
    // 扫描侧必须真的用上了这个常量，而不是又一个内联字面量。
    expect(rust).toContain('!n.ends_with(&format!(".{}", TRIAL_MARKER_SUFFIX))');
    expect(trialMarkerFileName('researcher_focused')).toBe('researcher_focused.trial.json');
  });

  it('五种结局五种标签', () => {
    expect(trialBadge(CHILD, { status: 'trial' }, judge({ status: 'trial', parentRole: PARENT }, ok(1, 0))).label).toContain('试用中 · 1/5 次');
    expect(trialBadge(CHILD, { status: 'trial' }, judge({ status: 'trial' }, matching)).label).toContain('未记父角色');
    expect(trialBadge(CHILD, { status: 'trial' }, judge({ status: 'trial', parentRole: PARENT }, ok(6, 6))).label).toBe('够格转正');
    expect(trialBadge(CHILD, { status: 'trial' }, judge({ status: 'trial', parentRole: PARENT }, ok(6, 0))).label).toContain('不达标');
    expect(trialBadge(CHILD, { status: 'promoted' }, { kind: 'already-promoted' }).label).toBe('已转正');
  });

  it('转正理由带上角色名与两侧证据', () => {
    const verdict = judge({ status: 'trial', parentRole: PARENT }, ok(6, 6));
    if (verdict.kind !== 'promote') throw new Error('unreachable');
    const reason = trialPromotionReason(CHILD, verdict.evidence);
    // `toContain(PARENT)` alone would be satisfied by CHILD ('researcher_focused'
    // contains 'researcher'), so it proves nothing — assert on the shape instead.
    expect(reason).toContain(`"${CHILD}"`);
    expect(reason).toContain(`父角色 ${PARENT} `);
    // 落盘的必须是**数字**，不是结论。下次有人问凭什么转正，账上要有答案。
    expect(reason).toContain('100%');
  });
});