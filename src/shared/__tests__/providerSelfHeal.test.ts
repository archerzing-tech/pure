// src/shared/__tests__/providerSelfHeal.test.ts
// 判例（2026-11-02）：用户把 OpenRouter / NVIDIA 的模型库配好，其中一批模型
// 在服务端早已不存在（下架 / 区域限制 / 账号未开通 / embedding 模型误入 chat
// 清单 / 测试期结束）。pure 只能停，用户看到「已中断」而看不到「这个模型调不
// 通」。契约：认出这一类拒绝 → 剔除死模型 → 切到清单里下一个，并保留 provider
// 原文作为归因证据。

import { describe, it, expect } from 'bun:test';
import { modelsWithout, planProviderSelfHeal } from '../providerSelfHeal';

const base = { provider: 'openrouter', model: 'poolside/laguna-xs-2.1:free', models: [] as string[] };

describe('planProviderSelfHeal（模型失效的判定与切换方案）', () => {
  it('认出 OpenRouter 的下架/区域/embedding 三种真实拒绝', () => {
    const cases = [
      'Repeated request failures (1 consecutive failures): ... Last: "poolside/laguna-xs-2.1:free is no longer available on OpenRouter: no provider serves this model anymore."',
      'Repeated request failures (1 consecutive failures): ... Last: "HTTP 403 — This model is not available in your region."',
      'Repeated request failures (1 consecutive failures): ... Last: "liquid/lfm-2.5-embedding-350m:free is an embedding model and cannot be used with the chat/completions endpoint."',
    ];
    for (const message of cases) {
      const plan = planProviderSelfHeal({ ...base, message, models: [base.model, 'z-ai/glm-5.3-flash'] });
      expect(plan).not.toBeNull();
      expect(plan!.deadModel).toBe(base.model);
      expect(plan!.nextModel).toBe('z-ai/glm-5.3-flash');
      expect(plan!.detail.length).toBeGreaterThan(10);
    }
  });

  it('认出 NVIDIA 的「账号未开通该 function」与测试期结束', () => {
    for (const message of [
      'Last: "HTTP 404 — Function nvidia/nemotron-3-super-120b-a12b Not found for account abc"',
      'Last: "Thank you for participating in the Stealth Ox Alpha testing period. This model was ZAI\'s GLM-5.3 Flash."',
    ]) {
      expect(planProviderSelfHeal({ ...base, message, models: [base.model] })).not.toBeNull();
    }
  });

  it('key 类拒绝（401/403 认证）不换模型：那是 key 槽的事，换模型只换一种死法', () => {
    for (const message of [
      'Last: "HTTP 401 Missing Authentication header"',
      'Last: "invalid api key"',
      'Last: "API key rejected"',
    ]) {
      expect(planProviderSelfHeal({ ...base, message, models: [base.model, 'x'] })).toBeNull();
    }
  });

  it('时间/网络类中断与上下文超窗不碰模型库', () => {
    for (const message of [
      '模型的流式连接连续 2 次在传输中无响应（每次等满超时上限后放弃）',
      'Context window exhausted: the conversation no longer fits the model\'s input window',
      'HTTP 429 rate limited',
    ]) {
      expect(planProviderSelfHeal({ ...base, message, models: [base.model, 'x'] })).toBeNull();
    }
  });

  it('清单里没有别的模型时 nextModel 为 null（剔除仍是正确动作）', () => {
    const plan = planProviderSelfHeal({
      ...base,
      message: 'Last: "HTTP 404 — model not found"',
      models: [base.model],
    });
    expect(plan).not.toBeNull();
    expect(plan!.nextModel).toBeNull();
  });

  it('detail 压掉换行与围栏，长度有界', () => {
    const plan = planProviderSelfHeal({
      ...base,
      message: 'Repeated failures\n```\nstack\n```\nLast: "HTTP 404 — model does not exist"'.repeat(3),
      models: [base.model, 'b'],
    });
    expect(plan!.detail).not.toContain('\n');
    expect(plan!.detail.includes('```')).toBe(false);
    expect(plan!.detail.length).toBeLessThanOrEqual(161);
  });
});

describe('modelsWithout（剔除死模型的清单运算）', () => {
  it('剔除目标模型、去重、保序、丢掉空白项', () => {
    expect(modelsWithout(['a', 'b ', 'a', 'dead', '', '  ', 'c'], 'dead')).toEqual(['a', 'b', 'c']);
  });

  it('剔完为空时返回空数组（调用方据此提示用户添加模型）', () => {
    expect(modelsWithout(['dead'], 'dead')).toEqual([]);
  });
});
