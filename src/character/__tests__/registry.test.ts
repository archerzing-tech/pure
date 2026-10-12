import { afterEach, describe, expect, it } from 'bun:test';
import {
  activeCharacterCore,
  activeCharacterExpression,
  activeCharacterProfile,
  activeCharacterProfileId,
  CHARACTER_PROFILES,
  CRAFTSMAN_SLOW_CORE_PROMPT,
  DEFAULT_CHARACTER_PROFILE,
  DEFAULT_CHARACTER_PROFILE_ID,
  isCharacterProfileId,
  listCharacterProfiles,
  resetActiveCharacterProfile,
  resolveCharacterProfile,
  setActiveCharacterProfile,
} from '../index';
import { inputDefaultConfidence } from '../../coding-agent/inputDecision';
import { parsePlanJson } from '../../coding-agent/Planner';
import { AdaptiveControlPlane } from '../../shared/adaptiveControl';
import { promptAssembler } from '../../shared/PromptAssembler';
import { defaults } from '../../ui/config';

// 人格轨道 刀 5 的选择器与「决策面真从活跃内核读」的行为面。
//
// 活跃内核是**模块级状态**，而 bun 的测试文件共享同一份模块注册表，所以每个用例
// 之后必须复位——否则本文件会把别的测试文件（PromptAssembler / chat / Planner）
// 拉到「工匠慢线」上，红得莫名其妙（这是本刀最容易埋的坑，故显式写在文件头）。
afterEach(() => {
  resetActiveCharacterProfile();
});

const CRAFTSMAN = 'craftsman-slow';

/** 一份 12 步 × 10 子步骤 × 12 条验证的计划 JSON：三个上限都能被它顶到。 */
function stepsOverflowJson(): string {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    action: `step ${i + 1}`,
    description: `do ${i + 1}`,
    substeps: Array.from({ length: 10 }, (_, j) => ({ action: `sub ${j + 1}`, description: `sub ${j + 1}` })),
  }));
  const verification = Array.from({ length: 12 }, (_, i) => ({ command: `cmd ${i + 1}`, reason: 'r' }));
  return JSON.stringify({ steps, verification });
}

describe('性格内核选择器（刀 5）', () => {
  it('名册顺序：默认内核第一；解析未知 id 返回 undefined（不抛）', () => {
    expect(listCharacterProfiles()[0].id).toBe(DEFAULT_CHARACTER_PROFILE_ID);
    expect(resolveCharacterProfile(CRAFTSMAN)?.id).toBe(CRAFTSMAN);
    expect(resolveCharacterProfile('nope')).toBeUndefined();
    expect(resolveCharacterProfile(undefined)).toBeUndefined();
    expect(isCharacterProfileId(CRAFTSMAN)).toBe(true);
    expect(isCharacterProfileId('toString')).toBe(false);
  });

  it('没人注入时三个读取点都回退默认内核（刀 1–4 行为不变）', () => {
    expect(activeCharacterProfile()).toBe(DEFAULT_CHARACTER_PROFILE);
    expect(activeCharacterProfileId()).toBe(DEFAULT_CHARACTER_PROFILE_ID);
    expect(activeCharacterCore()).toBe(DEFAULT_CHARACTER_PROFILE.core);
  });

  it('注入第二个内核：内核与表达面两张投影同源切换', () => {
    expect(setActiveCharacterProfile(CRAFTSMAN)).toBe(true);
    expect(activeCharacterProfile()).toBe(CHARACTER_PROFILES[CRAFTSMAN]);
    expect(activeCharacterProfileId()).toBe(CRAFTSMAN);
    expect(activeCharacterCore()).toBe(CRAFTSMAN_SLOW_CORE_PROMPT);
    expect(activeCharacterCore()).not.toBe(DEFAULT_CHARACTER_PROFILE.core);
    // 表达面必须跟着同一个内核走（蓝图 §0：两张投影同一出典，各自为政就会一眼假）。
    expect(activeCharacterExpression()).toContain(
      CHARACTER_PROFILES[CRAFTSMAN].expression.scenarios['failure-report'].obligation,
    );
    expect(activeCharacterExpression()).not.toContain(
      DEFAULT_CHARACTER_PROFILE.expression.scenarios['failure-report'].obligation,
    );
  });

  it('不认识的 id 不生效、也不炸：保持现状并返回 false', () => {
    setActiveCharacterProfile(CRAFTSMAN);
    expect(setActiveCharacterProfile('veteran_slow')).toBe(false);
    expect(activeCharacterProfileId()).toBe(CRAFTSMAN);
    // 空值 = 显式拆回默认内核（那是合法状态，返回 true）。
    expect(setActiveCharacterProfile('')).toBe(true);
    expect(activeCharacterProfileId()).toBe(DEFAULT_CHARACTER_PROFILE_ID);
  });

  it('刀 5 起默认内核的选择器行为不变：默认内核的幂等注入', () => {
    expect(setActiveCharacterProfile(DEFAULT_CHARACTER_PROFILE_ID)).toBe(true);
    expect(activeCharacterProfile()).toBe(DEFAULT_CHARACTER_PROFILE);
  });
});

describe('决策面真从活跃内核读（懒读，不是模块加载时取一次）', () => {
  it('插话置信门：0.7 → 0.85', () => {
    expect(inputDefaultConfidence()).toBe(0.7);
    setActiveCharacterProfile(CRAFTSMAN);
    expect(inputDefaultConfidence()).toBe(0.85);
  });

  it('Planner 的三个上限：步子 / 子步骤 / 验证条数都随内核变', () => {
    const json = stepsOverflowJson();
    const fast = parsePlanJson(json)!;
    expect(fast.steps.length).toBe(10);
    expect(fast.steps[0].substeps?.length).toBe(8);
    expect(fast.verification?.length).toBe(8);

    setActiveCharacterProfile(CRAFTSMAN);
    const slow = parsePlanJson(json)!;
    expect(slow.steps.length).toBe(6);
    expect(slow.steps[0].substeps?.length).toBe(5);
    expect(slow.verification?.length).toBe(12);
  });

  it('并行角色上限：4 → 2', () => {
    const plane = new AdaptiveControlPlane();
    // 非代码任务 + 四个非代码/执行角色：代码角色会被 involvesCode 门剔掉，用它测
    // 上限会把「门槛」误读成「内核算准」。
    const input = {
      prompt: '帮我调研这几个方案的可行性，并评审一下',
      environment: { hasWorkspace: true, toolCount: 5, verifierAvailable: true, memoryAvailable: true },
      semantic: { roles: ['researcher', 'deep_thinker', 'ui_designer', 'project_auditor'] },
    };
    expect(plane.select(input).recommendedRoles.length).toBe(4);
    setActiveCharacterProfile(CRAFTSMAN);
    const slowed = plane.select(input).recommendedRoles;
    expect(slowed.length).toBe(2);
    // 砍的是尾部，不是重排：保留的仍是路由给的前两个。
    expect(slowed).toEqual(['researcher', 'deep_thinker']);
  });

  it('确认倾向：默认配置的权限模式与自动批准跟着活跃内核走', () => {
    const fast = defaults();
    expect(fast.characterProfileId).toBe(DEFAULT_CHARACTER_PROFILE_ID);
    expect(fast.permissionMode).toBe('auto');
    expect(fast.autoPermWrite).toBe(true);

    setActiveCharacterProfile(CRAFTSMAN);
    const slow = defaults();
    expect(slow.characterProfileId).toBe(CRAFTSMAN);
    expect(slow.permissionMode).toBe('confirm');
    expect(slow.autoPermRead).toBe(false);
    expect(slow.autoPermWrite).toBe(false);
    expect(slow.autoPermCmd).toBe(false);
    expect(slow.autoPermGit).toBe(false);
  });

  it('真实装配路径：system prompt 里的两张投影就是活跃内核的那一份', () => {
    const assemble = () => promptAssembler.buildSystemPrompt({ surface: 'gui', capabilities: 'general assistant capabilities' });
    const fast = assemble();
    expect(fast).toContain(DEFAULT_CHARACTER_PROFILE.core);
    expect(fast).not.toContain(CRAFTSMAN_SLOW_CORE_PROMPT);

    setActiveCharacterProfile(CRAFTSMAN);
    const slow = assemble();
    expect(slow).toContain(CRAFTSMAN_SLOW_CORE_PROMPT);
    expect(slow).not.toContain(DEFAULT_CHARACTER_PROFILE.core);
    // 只换内容不换位置：两张 fragment 各仍恰好一份（priority 契约没被切内核打乱）。
    expect(slow.split('<character_core>').length - 1).toBe(1);
    expect(slow.split('<character_expression>').length - 1).toBe(1);
  });
});
