// src/ui/__tests__/modelSelfHeal.test.ts
// 判例（2026-11-02）：模型库里的死模型（下架 / 区域限制 / 账号未开通 /
// embedding 误入 chat 清单）被 pure 自动剔除并切到下一个——用户看到的是
// provider 的原话 + 已经做过的修改，而不是「已中断」四个字。契约：内置
// provider 改 providerModels，自定义 provider 改它自己的条目，其余字段不动。

import { describe, it, expect } from 'bun:test';
import { applyModelSelfHeal, type PureConfig } from '../config';

const base = {
  provider: 'openrouter',
  model: 'poolside/laguna-xs-2.1:free',
  providerModels: {
    openrouter: ['poolside/laguna-xs-2.1:free', 'z-ai/glm-5.3-flash'],
    nvidia: ['poolside/laguna-xs-2.1'],
  },
  customProviders: [],
} as unknown as PureConfig;

describe('applyModelSelfHeal（内置 provider）', () => {
  it('剔除死模型并把当前模型切到下一个', () => {
    const healed = applyModelSelfHeal(base, 'openrouter', 'poolside/laguna-xs-2.1:free', 'z-ai/glm-5.3-flash');
    expect(healed.model).toBe('z-ai/glm-5.3-flash');
    expect(healed.providerModels.openrouter).toEqual(['z-ai/glm-5.3-flash']);
  });

  it('只动目标 provider，其他 provider 的模型库原样', () => {
    const healed = applyModelSelfHeal(base, 'openrouter', 'poolside/laguna-xs-2.1:free', 'z-ai/glm-5.3-flash');
    expect(healed.providerModels.nvidia).toEqual(['poolside/laguna-xs-2.1']);
  });

  it('没有可切换的模型时仍剔除，当前模型保持不变（不编造一个）', () => {
    const healed = applyModelSelfHeal(base, 'openrouter', 'poolside/laguna-xs-2.1:free', null);
    expect(healed.providerModels.openrouter).toEqual(['z-ai/glm-5.3-flash']);
    expect(healed.model).toBe('poolside/laguna-xs-2.1:free');
  });

  it('当前模型不在清单里（手输的）也照样切换，库里的其余模型不动', () => {
    const cfg = { ...base, model: 'ghost-model' } as unknown as PureConfig;
    const healed = applyModelSelfHeal(cfg, 'openrouter', 'ghost-model', 'z-ai/glm-5.3-flash');
    expect(healed.model).toBe('z-ai/glm-5.3-flash');
    // modelListForProvider 会把手输的当前模型并进清单再剔除——库里原有的
    // 两个模型本来就该留下，自愈只删「已确认调不通」的那一个。
    expect(healed.providerModels.openrouter).toEqual(['poolside/laguna-xs-2.1:free', 'z-ai/glm-5.3-flash']);
  });
});

describe('applyModelSelfHeal（自定义 provider）', () => {
  const withCustom = {
    ...base,
    customProviders: [
      { id: 'my-local', name: 'My Local', baseURL: 'http://127.0.0.1:1/v1', models: ['a', 'b'], defaultModel: 'a', apiKey: '', hasApiKey: false },
    ],
  } as unknown as PureConfig;

  it('模型库在自定义条目里，providerModels 不受影响', () => {
    const healed = applyModelSelfHeal(withCustom, 'my-local', 'a', 'b');
    expect(healed.model).toBe('b');
    expect(healed.customProviders[0].models).toEqual(['b']);
    expect(healed.providerModels.openrouter).toEqual(base.providerModels.openrouter);
  });

  it('其他自定义 provider 原样保留', () => {
    const two = {
      ...withCustom,
      customProviders: [
        ...withCustom.customProviders,
        { id: 'other', name: 'Other', baseURL: 'http://127.0.0.1:2/v1', models: ['x'], defaultModel: 'x', apiKey: '', hasApiKey: false },
      ],
    } as unknown as PureConfig;
    const healed = applyModelSelfHeal(two, 'my-local', 'a', 'b');
    expect(healed.customProviders.find((p) => p.id === 'other')!.models).toEqual(['x']);
  });
});
