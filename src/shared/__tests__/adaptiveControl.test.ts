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

  it('does not route a non-code travel plan to code roles (planning ≠ code)', () => {
    const strategy = plane.select({
      prompt: '帮我安排一个从西安到广西柳州的旅游计划',
      environment: environment(),
    });

    // 回归：这条请求因含「计划」触发了 planning，但它是行程安排，不是代码任务。
    // 绝不能出现 code_editor / code_reviewer，否则会乱搞。
    expect(strategy.recommendedRoles).not.toEqual(expect.arrayContaining(['code_editor', 'code_reviewer']));
    expect(strategy.recommendedRoles).toHaveLength(0);
  });

  it('keeps a long non-code plan off the code pipeline (fallback is code-gated too)', () => {
    // 长输入让复杂度上到 moderate，旧逻辑会走兜底推荐 code_reviewer——非代码
    // 计划即使再复杂也不该出现代码角色。
    const prompt = '帮我调研并整理一份详细的西安到广西柳州旅行规划，覆盖沿途城市景点、美食、住宿、交通与预算对比。'
      + '再补充每天的行程安排、签证与保险建议、天气与季节注意事项，以及适合带孩子的路线。'.repeat(10);
    expect(prompt.length).toBeGreaterThan(400);
    const strategy = plane.select({ prompt, environment: environment() });

    expect(strategy.complexity).toBe('moderate');
    expect(strategy.recommendedRoles).not.toEqual(expect.arrayContaining(['code_editor', 'code_reviewer']));
    // 调研意图仍应得到通用研究角色，只是不碰代码角色。
    expect(strategy.recommendedRoles).toEqual(expect.arrayContaining(['researcher']));
  });

  it('still recommends the code pipeline when "计划" is about code', () => {
    const strategy = plane.select({
      prompt: '帮我计划一下重构这个项目的认证模块，把 JWT 换成 OAuth，涉及多文件改动',
      environment: environment(),
    });

    expect(strategy.recommendedRoles).toEqual(expect.arrayContaining(['task_planner', 'code_editor', 'code_reviewer']));
  });

  // ═══ 语义（理解）驱动的角色分配 ═══

  it('semantic roles win over keywords for a non-code travel plan', () => {
    const strategy = plane.select({
      prompt: '帮我安排一个从西安到广西柳州的旅游计划',
      environment: environment(),
      semantic: { tags: ['planning'], complexity: 'moderate', roles: ['researcher', 'deep_thinker'] },
    });

    // 语义路由已按任务属性选好研究员 + 深度思考，关键词（“计划”）不得把代码管线塞回来。
    expect(strategy.recommendedRoles).toEqual(expect.arrayContaining(['researcher', 'deep_thinker']));
    expect(strategy.recommendedRoles).not.toEqual(expect.arrayContaining(['task_planner', 'code_editor', 'code_reviewer', 'bash_executor']));
  });

  it('drops code/exec roles that slip through the semantic path (non-code guard)', () => {
    const strategy = plane.select({
      prompt: '帮我安排一个从西安到广西柳州的旅游计划',
      environment: environment(),
      semantic: { tags: ['planning'], roles: ['researcher', 'code_editor', 'bash_executor'] },
    });

    expect(strategy.recommendedRoles).toEqual(['researcher']);
  });

  it('respects an explicit empty semantic role list (no keyword fallback)', () => {
    const strategy = plane.select({
      prompt: '帮我搭建一个全栈项目，包含前后端和数据库',
      environment: environment({ toolCount: 6 }),
      semantic: { tags: ['build'], complexity: 'complex', roles: [] },
    });

    // 路由判断无需委派：即使关键词兜底会推代码管线，也一律尊重空清单，不再抬委托级别。
    expect(strategy.recommendedRoles).toEqual([]);
    expect(strategy.delegation).toBe('none');
  });

  it('falls back to keyword roles only when the semantic path omits roles', () => {
    const strategy = plane.select({
      prompt: '帮我搭建一个全栈项目，包含前后端和数据库',
      environment: environment({ toolCount: 6 }),
      semantic: { tags: ['build'], complexity: 'complex' },
    });

    expect(strategy.recommendedRoles).toEqual(expect.arrayContaining(['task_planner', 'code_editor', 'code_reviewer']));
  });

  it('keeps semantic questions out of delegation', () => {
    const strategy = plane.select({
      prompt: '帮我看一下这个文件的作用',
      environment: environment(),
      semantic: { tags: ['question'], complexity: 'simple' },
    });

    expect(strategy.delegation).toBe('none');
  });

  it('does not delegate a trivial one-liner, and keeps its directive honest', () => {
    const strategy = plane.select({ prompt: '2 + 2 = ?', environment: environment() });

    expect(strategy.delegation).toBe('none');
    expect(strategy.directive).toContain('trivial/simple task — keep the loop local');
  });
});
