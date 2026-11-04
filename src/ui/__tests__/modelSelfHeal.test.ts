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

  it('renders the prescription with dead model, evidence, and the switch target', () => {
    recordProviderHealEvent(plan);
    const facts = takeProviderHealFacts();
    expect(facts).toContain('openrouter rejected "poolside/laguna-xs-2.1:free"');
    expect(facts).toContain('no longer available');
    expect(facts).toContain('switch to "z-ai/glm-5.3-flash"');
    expect(facts).toContain('has NOT changed any config');
  });

  it('read-and-clear: a second take returns empty', () => {
    recordProviderHealEvent(plan);
    expect(takeProviderHealFacts()).not.toBe('');
    expect(takeProviderHealFacts()).toBe('');
  });

  it('merges repeats of the same dead model on the same provider', () => {
    recordProviderHealEvent(plan);
    recordProviderHealEvent(plan);
    const facts = takeProviderHealFacts();
    expect(facts.split('rejected').length - 1).toBe(1);
  });

  it('no-next plan tells the model a working model must be added', () => {
    const lonely = planProviderSelfHeal({
      message: 'unknown model',
      provider: 'my-local',
      model: 'a',
      models: ['a'],
    })!;
    recordProviderHealEvent(lonely);
    expect(takeProviderHealFacts()).toContain('no models left');
  });
});

describe('modelsWithout（剔除后清单）', () => {
  it('drops the dead model and keeps order/dedupe', () => {
    expect(modelsWithout(['b', 'a', 'b', 'c'], 'a')).toEqual(['b', 'c']);
    expect(modelsWithout(['a'], 'a')).toEqual([]);
  });
});
