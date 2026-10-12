import { describe, expect, it } from 'bun:test';
import { activeCharacterProfile, DEFAULT_CHARACTER_PROFILE } from '../index';
import { inputDefaultConfidence } from '../../coding-agent/inputDecision';
import { defaults } from '../../ui/config';

// 人格轨道 刀 1 的安全底：默认内核「老手快线」的每个值 = 现行为原样。
// 这些断言把默认值逐值锁死——改动内核值必须同步改这里，等于一次显式行为变更。
describe('CharacterProfile 默认内核「老手快线」（刀 1 零行为变更）', () => {
  const profile = DEFAULT_CHARACTER_PROFILE;

  it('decision 每个值 = 现行为原样（逐值锁定）', () => {
    expect(profile.id).toBe('veteran-fast');
    expect(profile.version).toBe('v0');
    expect(profile.decision.modeThreshold).toEqual({ planAtComplexity: 'complex', complexFileThreshold: 3 });
    expect(profile.decision.verifyDensity).toEqual({ maxVerificationItems: 8 });
    expect(profile.decision.stepSize).toEqual({ maxPlanSteps: 10, maxPlanSubsteps: 8 });
    expect(profile.decision.confirmTendency).toEqual({
      permissionMode: 'auto',
      autoApprove: { read: true, write: true, cmd: true, git: true },
    });
    expect(profile.decision.reportRhythm).toBe('meaningful-nodes-only');
    expect(profile.decision.parallelTendency).toEqual({ maxSubagentRoles: 4 });
    expect(profile.decision.insertionThreshold).toEqual({ confidenceGate: 0.7 });
  });

  it('没人注入活跃内核时回退默认内核（刀 1–4 的行为逐字节不变）', () => {
    expect(activeCharacterProfile()).toBe(DEFAULT_CHARACTER_PROFILE);
  });

  it('插话置信门从内核读（不再是散落字面量）', () => {
    expect(inputDefaultConfidence()).toBe(profile.decision.insertionThreshold.confidenceGate);
    expect(inputDefaultConfidence()).toBe(0.7);
  });

  it('确认默认从内核读：默认配置 = 现行为原样', () => {
    const cfg = defaults();
    expect(cfg.characterProfileId).toBe(profile.id);
    expect(cfg.permissionMode).toBe(profile.decision.confirmTendency.permissionMode);
    expect(cfg.autoPermRead).toBe(profile.decision.confirmTendency.autoApprove.read);
    expect(cfg.autoPermWrite).toBe(profile.decision.confirmTendency.autoApprove.write);
    expect(cfg.autoPermCmd).toBe(profile.decision.confirmTendency.autoApprove.cmd);
    expect(cfg.autoPermGit).toBe(profile.decision.confirmTendency.autoApprove.git);
  });
});
