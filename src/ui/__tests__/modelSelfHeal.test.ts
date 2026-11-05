import { describe, expect, it } from 'bun:test';
import {
  modelsWithout,
  planProviderSelfHeal,
  recordProviderHealEvent,
  takeProviderHealFacts,
} from '../../shared/providerSelfHeal';

// 决策边界改革刀一（2026-11-04）：5856e63 反转定调——自愈裁决权归模型，
// 宿主只记处方不落盘。旧版本文件断言 persistConfig(applyModelSelfHeal(...))
// 的自动闭环，已随闭环一起退役；现在锁的是「处方事件 → envFacts 送达」链。

describe('provider heal prescription events（处方事件器）', () => {
  const dead = 'poolside/laguna-xs-2.1:free';
  const next = 'z-ai/glm-5.3-flash';
  const plan = planProviderSelfHeal({
    message: `${dead} is no longer available`,
    provider: 'openrouter',
    model: dead,
    models: [dead, next],
  })!;

  // 防顺序地雷（pure-test-flaky-quartet 判例：bun test 单进程 + 模块级单例）：
  // 全量跑时 chat.test 等先触发的处方会遗留在全局账上，每个用例先读即清场，
  // 再播种、再断言读回了什么。
  const drain = () => takeProviderHealFacts();

  it('renders the prescription with dead model, evidence, and the switch target', () => {
    drain();
    recordProviderHealEvent(plan);
    const facts = takeProviderHealFacts();
    expect(facts).toContain('openrouter rejected "poolside/laguna-xs-2.1:free"');
    expect(facts).toContain('no longer available');
    expect(facts).toContain('switch to "z-ai/glm-5.3-flash"');
    expect(facts).toContain('has NOT changed any config');
  });

  it('read-and-clear: a second take returns empty', () => {
    drain();
    recordProviderHealEvent(plan);
    expect(takeProviderHealFacts()).not.toBe('');
    expect(takeProviderHealFacts()).toBe('');
  });

  it('merges repeats of the same dead model on the same provider', () => {
    drain();
    recordProviderHealEvent(plan);
    recordProviderHealEvent(plan);
    const facts = takeProviderHealFacts();
    expect(facts.split('rejected').length - 1).toBe(1);
  });

  it('keeps distinct providers as separate rows (no cross-provider merge)', () => {
    drain();
    const other = planProviderSelfHeal({
      message: 'unknown model',
      provider: 'nvidia',
      model: dead,
      models: [dead, next],
    })!;
    recordProviderHealEvent(plan);
    recordProviderHealEvent(other);
    const facts = takeProviderHealFacts();
    expect(facts.split('rejected').length - 1).toBe(2);
    expect(facts).toContain('openrouter rejected');
    expect(facts).toContain('nvidia rejected');
  });

  it('caps at 8 prescriptions, dropping the oldest (latest evidence wins)', () => {
    drain();
    for (let i = 0; i < 9; i++) {
      recordProviderHealEvent(planProviderSelfHeal({
        message: `model m${i} was retired`,
        provider: 'openrouter',
        model: `m${i}`,
        models: [`m${i}`, next],
      })!);
    }
    const facts = takeProviderHealFacts();
    expect(facts.split('rejected').length - 1).toBe(8);
    expect(facts).toContain('"m8"'); // 最新在场
    expect(facts).not.toContain('"m0"'); // 最旧被弹掉
  });

  it('no-next plan tells the model a working model must be added', () => {
    drain();
    const lonely = planProviderSelfHeal({
      message: 'unknown model',
      provider: 'my-local',
      model: 'a',
      models: ['a'],
    })!;
    recordProviderHealEvent(lonely);
    const facts = takeProviderHealFacts();
    expect(facts).toContain('my-local rejected "a" as gone');
    expect(facts).toContain('no models left');
    expect(facts).toContain('a working one must be added');
  });
});

describe('modelsWithout（剔除后清单）', () => {
  it('drops the dead model and keeps order/dedupe', () => {
    expect(modelsWithout(['b', 'a', 'b', 'c'], 'a')).toEqual(['b', 'c']);
    expect(modelsWithout(['a'], 'a')).toEqual([]);
  });
});
