// 2026-10-14 — CLI 侧裁决/路由 adapter 的装配缝。
//
// 为什么需要它：路由（inferSemanticRoute）挂在每次发送前，产出只是一个小
// JSON。跑在主 adapter 上时它带着供应商的暗推理一起走——glm-5.3-flash 实测
// 首字 10.9–35.1s / 出全 12.2–38.3s，而路由的超时帽只有 12s：判定结果由供应
// 商延迟抽签决定，输的那次静默退回关键词地板（debug / 加功能 / 要方案的请求
// 全被读成 question）。关掉暗推理后同一段提示词：首字 2.4–3.9s / 出全
// 3.1–6.0s，判定回得来。
import { describe, expect, test } from 'bun:test';
import { createAdapter, resolveJudgeAdapter } from '../cliAdapter';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import type { LLMAdapter } from '../shared/types';
import type { CliArgs } from '../cliConfig';

function glmArgs(): CliArgs {
  return {
    prompt: 'p',
    provider: 'glm',
    model: 'glm-5.3-flash',
    apiKey: 'k',
    workspace: '/ws',
    resume: '',
    stateDb: '',
    autoApprove: true,
  };
}

function localArgs(): CliArgs {
  return {
    ...glmArgs(),
    provider: 'local',
    customProviders: [{
      id: 'local',
      name: 'Local',
      baseURL: 'http://127.0.0.1:9/v1',
      defaultModel: 'main-m',
      apiKey: '',
      hasApiKey: false,
      models: ['main-m'],
    }],
  };
}

const extraBodyOf = (adapter: LLMAdapter): unknown => (adapter as unknown as { extraBody?: unknown }).extraBody;
const modelOf = (adapter: LLMAdapter): string => (adapter as unknown as { model: string }).model;

describe('resolveJudgeAdapter', () => {
  test('turns hidden reasoning off for the provider that has a switch', () => {
    const main = createAdapter(glmArgs()).adapter;
    const judge = resolveJudgeAdapter(glmArgs(), main);
    expect(judge).not.toBe(main);
    expect(judge).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(extraBodyOf(judge)).toEqual({ thinking: { type: 'disabled' } });
    // Same provider / model / endpoint — only the reasoning switch differs.
    expect(modelOf(judge)).toBe(modelOf(main));
  });

  test('leaves the main adapter alone: the turn itself keeps its reasoning', () => {
    const main = createAdapter(glmArgs()).adapter;
    expect(extraBodyOf(main)).toBeUndefined();
  });

  test('reuses the caller adapter when the provider has no thinking switch', () => {
    const main = createAdapter(localArgs()).adapter;
    expect(resolveJudgeAdapter(localArgs(), main)).toBe(main);
    // Nothing was rebuilt with a bogus extra body either.
    expect(extraBodyOf(main)).toBeUndefined();
  });

  test('mock runs in-process: no adapter is reconstructed', () => {
    const main = {} as LLMAdapter;
    expect(resolveJudgeAdapter({ ...glmArgs(), provider: 'mock' }, main)).toBe(main);
  });
});
