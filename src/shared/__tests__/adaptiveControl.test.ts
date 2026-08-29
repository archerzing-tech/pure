import { describe, expect, it } from 'bun:test';
import { AdaptiveControlPlane } from '../adaptiveControl';

const plane = new AdaptiveControlPlane();

function environment(overrides: Partial<Parameters<AdaptiveControlPlane['select']>[0]['environment']> = {}) {
  return {
    now: new Date('2026-08-13T14:00:00Z').getTime(),
    timezone: 'UTC',
    projectPath: '/workspace/app',
    hasWorkspace: true,
    toolCount: 4,
    verifierAvailable: true,
    memoryAvailable: true,
    ...overrides,
  };
}

describe('AdaptiveControlPlane', () => {
  it('selects a light local strategy when the environment has capability and no failure evidence', () => {
    const strategy = plane.select({ prompt: 'fix the small issue', environment: environment() });

    expect(strategy.exploration).toBe('targeted');
    expect(strategy.verification).toBe('focused');
    expect(strategy.recovery).toBe('continue-with-evidence');
    expect(strategy.autonomy).toBe('unattended-local');
    expect(strategy.directive).toContain('<adaptive_strategy>');
    expect(strategy.directive).toContain('Revise this strategy');
  });

  it('widens exploration and verification after observed failures', () => {
    const strategy = plane.select({
      prompt: 'fix the failing build',
      environment: environment({ now: new Date('2026-08-13T23:30:00Z').getTime() }),
      recentFailures: ['typecheck failed', 'the first repair did not work'],
    });

    expect(strategy.exploration).toBe('broad');
    expect(strategy.verification).toBe('thorough');
    expect(strategy.delegation).toBe('parallel');
    expect(strategy.recovery).toBe('switch-approach');
    expect(strategy.timePhase).toBe('night');
  });

  it('does not pretend to be autonomous when local capability is unavailable', () => {
    const strategy = plane.select({
      prompt: 'change the project',
      environment: environment({ hasWorkspace: false, projectPath: '', toolCount: 0, verifierAvailable: false }),
    });

    expect(strategy.autonomy).toBe('blocked');
    expect(strategy.delegation).toBe('none');
    expect(strategy.directive).toContain('Do not claim autonomous progress');
  });

  it('changes with runtime context instead of returning one fixed path', () => {
    const morning = plane.select({ prompt: 'same request', environment: environment({ now: new Date('2026-08-13T09:00:00Z').getTime() }) });
    const night = plane.select({ prompt: 'same request', environment: environment({ now: new Date('2026-08-13T23:00:00Z').getTime() }) });

    expect(morning.id).not.toBe(night.id);
    expect(morning.timePhase).not.toBe(night.timePhase);
    expect(morning.directive).not.toBe(night.directive);
  });

  it('biases delegation to parallel for a complex build / replicate request', () => {
    const strategy = plane.select({
      prompt: '帮我把这个项目复刻成一个新的多文件网页应用，包含首页、详情页和管理后台',
      environment: environment({ toolCount: 6 }),
    });

    expect(strategy.complexity).toBe('complex');
    expect(strategy.delegation).toBe('parallel');
    expect(strategy.recommendedRoles).toEqual(expect.arrayContaining(['task_planner', 'code_editor', 'code_reviewer']));
    // The directive must not steer the model AWAY from delegation on a build.
    expect(strategy.directive).not.toContain('do not delegate by default');
  });

  it('does not delegate a trivial one-liner, and keeps its directive honest', () => {
    const strategy = plane.select({ prompt: '2 + 2 = ?', environment: environment() });

    expect(strategy.delegation).toBe('none');
    expect(strategy.directive).toContain('trivial/simple task — keep the loop local');
  });
});
