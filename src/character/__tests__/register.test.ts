import { describe, expect, it } from 'bun:test';
import {
  CHARACTER_PROFILES,
  detectWorkOrderRegister,
  listCharacterProfiles,
  registerScaledDecision,
  resetActiveCharacterProfile,
  resetActiveWorkOrderRegister,
  setActiveCharacterProfile,
  setActiveWorkOrderRegister,
  activeCharacterProfile,
  activeWorkOrderNote,
} from '../index';
import { parsePlanJsonWithMeta } from '../../coding-agent/Planner';

// 分量判读（刀 6）的两半：判定器（措辞 → 档位）与缩放（档位 → 结构上限）。
// 蓝图刀 6 节的纪律在此落成断言：production = 现行为（安全底）、档位只可能比
// 现行为轻、判定可解释（verdict 带命中词）、两个内核各有各的档位表。

describe('detectWorkOrderRegister：措辞 → 档位', () => {
  it('投诉三案例判对（蓝图验收的种子判例）', () => {
    expect(detectWorkOrderRegister('快速出几个版本的设计稿，我挑一下').register).toBe('draft');
    expect(detectWorkOrderRegister('帮我出一个原型项目，验证一下这个交互流程走得通').register).toBe('spike');
    expect(detectWorkOrderRegister('做一个正式的项目，要上生产环境的').register).toBe('production');
  });

  it('draft 信号词矩阵（中英）', () => {
    for (const text of [
      '画个草稿就行',
      '先来一版看看效果',
      '随便弄个页面',
      '给我几个方案选选',
      '不求精细，快一点',
      'give me a quick draft',
      'a few variants would do',
      'mock up of the dashboard',
    ]) {
      const verdict = detectWorkOrderRegister(text);
      expect(verdict.register).toBe('draft');
      expect(verdict.matched.length).toBeGreaterThan(0);
    }
  });

  it('spike 信号词矩阵（中英）', () => {
    for (const text of [
      '做个原型验证一下',
      'dry-run 一下这个流程',
      '出个 demo 给客户看',
      '先走通主路径再说',
      'build a prototype to spike the idea',
      'proof of concept 即可',
    ]) {
      expect(detectWorkOrderRegister(text).register).toBe('spike');
    }
  });

  it('同句混合时重者赢：「快速出个原型」是 spike，不是 draft', () => {
    expect(detectWorkOrderRegister('快速出个原型看看').register).toBe('spike');
    expect(detectWorkOrderRegister('先随便画几个正式版本的方案').register).toBe('production');
  });

  it('判不出明显信号 → production + 空信号（不问不猜）', () => {
    const verdict = detectWorkOrderRegister('修复登录页在 Safari 下白屏的问题');
    expect(verdict.register).toBe('production');
    expect(verdict.matched).toBe('');
  });

  it('裸「上线」「发布」不判 production（它们常是任务内容，不是档位声明）', () => {
    expect(detectWorkOrderRegister('修完这个 bug 就能上线了').register).toBe('production');
    // 上例落 production 是因为**没有** draft/spike 词命中（默认档），不是「上线」命中。
    // 「上线」若配成 production 词，「快速出一版上线要用的 banner」会被误判成正式。
    expect(detectWorkOrderRegister('快速出一版上线要用的 banner').register).toBe('draft');
  });

  it('空输入不炸', () => {
    expect(detectWorkOrderRegister('').register).toBe('production');
    expect(detectWorkOrderRegister(undefined as unknown as string).register).toBe('production');
  });
});

describe('registerScaledDecision：档位 → 结构上限', () => {
  it('production 恒等现值（刀 1 安全底：两内核都逐字段相等）', () => {
    for (const profile of listCharacterProfiles()) {
      const caps = registerScaledDecision(profile, 'production');
      expect(caps.maxVerificationItems).toBe(profile.decision.verifyDensity.maxVerificationItems);
      expect(caps.maxPlanSteps).toBe(profile.decision.stepSize.maxPlanSteps);
      expect(caps.maxPlanSubsteps).toBe(profile.decision.stepSize.maxPlanSubsteps);
    }
  });

  it('快线档位表锁值：draft 1/3/2、spike 2/5/4，全部轻于现值 8/10/8', () => {
    const veteran = CHARACTER_PROFILES['veteran-fast'];
    expect(registerScaledDecision(veteran, 'draft')).toEqual({
      maxVerificationItems: 1,
      maxPlanSteps: 3,
      maxPlanSubsteps: 2,
    });
    expect(registerScaledDecision(veteran, 'spike')).toEqual({
      maxVerificationItems: 2,
      maxPlanSteps: 5,
      maxPlanSubsteps: 4,
    });
  });

  it('慢线档位表锁值：draft 1/4/3（比快线重一档，验证底线同为 1）、spike 2/5/4', () => {
    const craftsman = CHARACTER_PROFILES['craftsman-slow'];
    expect(registerScaledDecision(craftsman, 'draft')).toEqual({
      maxVerificationItems: 1,
      maxPlanSteps: 4,
      maxPlanSubsteps: 3,
    });
    expect(registerScaledDecision(craftsman, 'spike')).toEqual({
      maxVerificationItems: 2,
      maxPlanSteps: 5,
      maxPlanSubsteps: 4,
    });
  });

  it('档位永不放大：就算表配错（比现值重），min() 也压回现值以内', () => {
    for (const profile of listCharacterProfiles()) {
      for (const register of ['draft', 'spike'] as const) {
        const caps = registerScaledDecision(profile, register);
        expect(caps.maxVerificationItems).toBeLessThanOrEqual(profile.decision.verifyDensity.maxVerificationItems);
        expect(caps.maxPlanSteps).toBeLessThanOrEqual(profile.decision.stepSize.maxPlanSteps);
        expect(caps.maxPlanSubsteps).toBeLessThanOrEqual(profile.decision.stepSize.maxPlanSubsteps);
      }
    }
  });

  it('确认倾向不在缩放面里：档位不碰内核的确认取向（红线 4 地盘）', () => {
    // 缩放函数只返回三个 cap；内核的 confirmTendency 原样。
    const craftsman = CHARACTER_PROFILES['craftsman-slow'];
    registerScaledDecision(craftsman, 'draft');
    expect(craftsman.decision.confirmTendency.permissionMode).toBe('confirm');
  });

  it('档位随活跃内核走：切内核后同档位读出各自的表', () => {
    try {
      resetActiveCharacterProfile();
      expect(registerScaledDecision(activeCharacterProfile(), 'draft').maxPlanSteps).toBe(3);
      setActiveCharacterProfile('craftsman-slow');
      expect(registerScaledDecision(activeCharacterProfile(), 'draft').maxPlanSteps).toBe(4);
    } finally {
      resetActiveCharacterProfile();
    }
  });
});

// 解析面贯通（刀 6 宿主接线）：判定档位穿参进 parsePlanJsonWithMeta 后，
// 计划的步数 / 子步 / 验证三个 slice 真的收进档位表——production 逐字节不变。
describe('parsePlanJsonWithMeta × 档位穿参', () => {
  const FAT_PLAN = JSON.stringify({
    reasoning: 'test',
    steps: Array.from({ length: 8 }, (_, i) => ({
      action: `step ${i + 1}`,
      description: `do part ${i + 1}`,
      substeps: Array.from({ length: 6 }, (_, j) => ({ action: `sub ${j + 1}` })),
    })),
    verification: [
      { command: 'bun run typecheck', reason: 'types' },
      { command: 'bun test src/a', reason: 'a' },
      { command: 'bun test src/b', reason: 'b' },
    ],
  });

  it('production 穿参与不穿参解析结果一致（安全底）', () => {
    const plain = parsePlanJsonWithMeta(FAT_PLAN);
    const explicit = parsePlanJsonWithMeta(FAT_PLAN, 'production');
    expect(explicit.plan?.steps.length).toBe(plain.plan?.steps.length);
    expect(explicit.plan?.steps[0]?.substeps?.length).toBe(plain.plan?.steps[0]?.substeps?.length);
    expect(explicit.plan?.verification?.length).toBe(plain.plan?.verification?.length);
  });

  it('draft：8 步收 3、子步收 2、验证收 1（快线档位表全链路生效）', () => {
    const { plan } = parsePlanJsonWithMeta(FAT_PLAN, 'draft');
    expect(plan?.steps.length).toBe(3);
    expect(plan?.steps[0]?.substeps?.length).toBe(2);
    expect(plan?.verification?.length).toBe(1);
  });

  it('spike：8 步收 5、子步收 4、验证收 2', () => {
    const { plan } = parsePlanJsonWithMeta(FAT_PLAN, 'spike');
    expect(plan?.steps.length).toBe(5);
    expect(plan?.steps[0]?.substeps?.length).toBe(4);
    expect(plan?.verification?.length).toBe(2);
  });
});

// 子代理继承（铁律 4 的刀 6 面）：档位注是全局回合级状态，production 时注为
// 空——漏注入的行为与刀 6 之前逐字节一致（安全底）。
describe('activeWorkOrderNote：子代理档位注', () => {
  it('默认 / 显式 production 都是空注（现行为原样）', () => {
    resetActiveWorkOrderRegister();
    expect(activeWorkOrderNote()).toBe('');
    setActiveWorkOrderRegister('production');
    expect(activeWorkOrderNote()).toBe('');
  });

  it('draft/spike 各带明说跳过什么的义务句', () => {
    try {
      setActiveWorkOrderRegister('draft');
      expect(activeWorkOrderNote()).toContain('DRAFT');
      expect(activeWorkOrderNote()).toContain('name what you skipped');
      setActiveWorkOrderRegister('spike');
      expect(activeWorkOrderNote()).toContain('SPIKE');
      expect(activeWorkOrderNote()).toContain('name what you skipped');
    } finally {
      resetActiveWorkOrderRegister();
    }
  });
});
