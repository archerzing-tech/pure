// src/__tests__/preflight.test.ts
// Submit-time error-prediction gate: destructive intents must trip the
// confirmation gate before send; ordinary and medium-risk drafts pass through.

import { describe, expect, it } from 'bun:test';
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
});
