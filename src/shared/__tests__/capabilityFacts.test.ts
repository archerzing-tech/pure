// src/shared/__tests__/capabilityFacts.test.ts
// W1b-4 能力事实送达：两个事件源的三态口径与零注入边界。

import { describe, expect, it } from 'bun:test';
import { capabilityTurnFacts } from '../capabilityFacts';

describe('capabilityTurnFacts · 带图 × 视觉能力', () => {
  it('无图零注入（即使视觉未知）', () => {
    const { facts } = capabilityTurnFacts({ imageCount: 0, provider: 'openrouter', model: 'mystery-1' });
    expect(facts).toBe('');
  });

  it('确认支持视觉的模型带图不注入（预期行为无需说）', () => {
    const { facts } = capabilityTurnFacts({ imageCount: 2, provider: 'openrouter', model: 'gpt-5.2' });
    expect(facts).toBe('');
  });

  it('未命中视觉清单：unknown 措辞提醒读不到就直说（manifest 纪律：未命中≠不支持）', () => {
    const { facts } = capabilityTurnFacts({ imageCount: 3, provider: 'deepseek', model: 'deepseek-v4' });
    expect(facts).toContain('vision support');
    expect(facts).toContain('unknown');
    expect(facts).toContain('3 image');
    expect(facts).toContain('do not pretend');
  });
});

describe('capabilityTurnFacts · 模型切换后首回合', () => {
  it('首回合（无前值）不注入——可查通道已有，不搞变相常驻', () => {
    const { facts } = capabilityTurnFacts({ imageCount: 0, provider: 'openrouter', model: 'kimi-k2.6' });
    expect(facts).toBe('');
  });

  it('同模型（key 相同）不注入', () => {
    const { facts } = capabilityTurnFacts({
      imageCount: 0,
      provider: 'openrouter',
      model: 'kimi-k2.6',
      lastSentModelKey: 'openrouter::kimi-k2.6',
    });
    expect(facts).toBe('');
  });

  it('换模型注入一行：新 key + 一行能力摘要 + 假设失效声明', () => {
    const { facts, currentKey } = capabilityTurnFacts({
      imageCount: 0,
      provider: 'openrouter',
      model: 'kimi-k2.6',
      lastSentModelKey: 'deepseek::deepseek-v4',
    });
    expect(currentKey).toBe('openrouter::kimi-k2.6');
    expect(facts).toContain('the model just changed to openrouter::kimi-k2.6');
    expect(facts).toMatch(/capabilities: rule=\S+ reasoning=\S+ vision=\S+/);
    expect(facts).toContain('no longer apply');
  });
});

describe('capabilityTurnFacts · 组合', () => {
  it('带图 + 换模型两个事件都出现（视觉已知不支持时）', () => {
    const { facts } = capabilityTurnFacts({
      imageCount: 1,
      provider: 'deepseek',
      model: 'deepseek-v4',
      lastSentModelKey: 'openrouter::kimi-k2.6',
    });
    expect(facts).toContain('vision support');
    expect(facts).toContain('the model just changed to deepseek::deepseek-v4');
  });
});
