// P0-2 — sleep-time 反思/overlay 起草的 REFLECT 相位解析（CLI 装配缝）。
// 与 Harness 的 llmFor('REFLECT') ?? llm 同一语义：配了 reflect 相位路由就为
// 那个模型建同 provider adapter；没配/等于主模型时复用调用方手里的主 adapter，
// 不重建。用 keyless 自定义 provider 走 OpenAICompatibleAdapter，不碰任何
// 需要 API key 的分支。
import { describe, expect, test } from 'bun:test';
import { resolveReflectAdapter } from '../cliAdapter';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import type { LLMAdapter } from '../shared/types';
import type { CliArgs } from '../cliConfig';

function argsWith(phaseModels?: CliArgs['phaseModels']): CliArgs {
  return {
    prompt: 'p',
    provider: 'local',
    model: 'main-m',
    apiKey: '',
    workspace: '/ws',
    resume: '',
    stateDb: '',
    autoApprove: true,
    customProviders: [{
      id: 'local',
      name: 'Local',
      baseURL: 'http://127.0.0.1:9/v1',
      defaultModel: 'main-m',
      apiKey: '',
      hasApiKey: false,
      models: ['main-m', 'cheap-m'],
    }],
    phaseModels,
  };
}

describe('resolveReflectAdapter (P0-2)', () => {
  test('routes to the REFLECT-phase model when one is configured', () => {
    const main = {} as LLMAdapter; // 只当身份锚点——路由开着绝不能返回它
    const out = resolveReflectAdapter(argsWith({ reflect: 'cheap-m' }), main);
    expect(out).not.toBe(main);
    expect(out).toBeInstanceOf(OpenAICompatibleAdapter);
    // model 是 private 字段 —— 测试侧结构断言（不为此放宽生产可见性）。
    expect((out as unknown as { model: string }).model).toBe('cheap-m');
  });

  test('reuses the caller main adapter when unset, blank, or equal to the main model', () => {
    const main = {} as LLMAdapter;
    expect(resolveReflectAdapter(argsWith(undefined), main)).toBe(main);
    expect(resolveReflectAdapter(argsWith({ reflect: '  ' }), main)).toBe(main);
    // 覆盖等于主模型 → 无影子 adapter（phaseModelOverrides 的同一条过滤纪律）。
    expect(resolveReflectAdapter(argsWith({ reflect: 'main-m' }), main)).toBe(main);
  });

  test('other phases never reroute the reflect slot', () => {
    const main = {} as LLMAdapter;
    expect(resolveReflectAdapter(argsWith({ think: 'strong-m' }), main)).toBe(main);
  });
});
