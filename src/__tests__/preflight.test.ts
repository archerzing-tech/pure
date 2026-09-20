// src/__tests__/preflight.test.ts
// Submit-time error-prediction gate: destructive intents must trip the
// confirmation gate before send; ordinary and medium-risk drafts pass through.

import { describe, expect, it } from 'bun:test';
import { normalizeDraft } from '../ui/inputRepair';
import { checkPreflight } from '../ui/preflight';

describe('checkPreflight (submit-time high-risk gate)', () => {
  it('gates destructive Chinese delete requests', () => {
    const gate = checkPreflight('删除整个项目');
    expect(gate).not.toBeNull();
    expect(gate!.risk).toBe('high');
    expect(gate!.assessment.riskLevel).toBe('high');
    expect(gate!.assessment.intent).toBe('delete');
  });

  it('gates irreversible English database drops', () => {
    const gate = checkPreflight('drop table users');
    expect(gate).not.toBeNull();
    expect(gate!.assessment.intent).toBe('delete');
  });

  it('gates hard-reset phrasing', () => {
    const gate = checkPreflight('git reset --hard origin/main and delete all local commits');
    expect(gate).not.toBeNull();
    expect(gate!.assessment.intent).toBe('delete');
  });

  it('passes ordinary questions straight through', () => {
    expect(checkPreflight('解释这个文件的作用')).toBeNull();
    expect(checkPreflight('What does this function do?')).toBeNull();
  });

  it('does not gate medium-risk refactors — those use the in-turn probe instead', () => {
    expect(checkPreflight('把认证模块重构成新的实现')).toBeNull();
    expect(checkPreflight('refactor the auth module')).toBeNull();
  });

  it('passes empty or whitespace drafts (handled earlier by the composer)', () => {
    expect(checkPreflight('')).toBeNull();
    expect(checkPreflight('   ')).toBeNull();
  });

  it('gates a homophone slip that would otherwise read as low risk', () => {
    const gate = checkPreflight('帮我把缓存目录闪除了');
    expect(gate).not.toBeNull();
    expect(gate!.assessment.riskLevel).toBe('high');
    expect(gate!.assessment.intent).toBe('delete');
    expect(gate!.repairs).toEqual([{ from: '闪除', to: '删除' }]);
  });

  it('explains a repair only when the slip is what raised the tier', () => {
    // Literal words are already high-risk — the dialog must not lecture about a
    // typo the user did not make.
    expect(checkPreflight('删除整个项目')!.repairs).toBeUndefined();
    expect(checkPreflight('帮我把缓存目录闪除了')!.repairs).toBeDefined();
  });

  it('keeps the higher of the two readings — a typo can never lower the gate', () => {
    expect(checkPreflight('山除所有日志')).not.toBeNull();
    // ...and expansion never inflates a lower tier either.
    expect(checkPreflight('把认证模块重构成新的实现')).toBeNull();
  });

  it('gates the spoken / overwrite forms the floor learned on 2026-09-20', () => {
    expect(checkPreflight('帮我把 build 目录清空')).not.toBeNull();
    expect(checkPreflight('把缓存删了')).not.toBeNull();
    // The widened floor must not drag test coverage into the gate.
    expect(checkPreflight('把测试覆盖率提到 90%')).toBeNull();
  });

  it('gates fullwidth destructive drafts once the composer normalizes them', () => {
    expect(checkPreflight('ｒｍ －ｒｆ ／ｔｍｐ')).toBeNull();
    expect(checkPreflight(normalizeDraft('ｒｍ －ｒｆ ／ｔｍｐ'))).not.toBeNull();
  });
});
