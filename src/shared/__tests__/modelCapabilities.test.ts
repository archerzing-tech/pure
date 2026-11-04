import { describe, it, expect } from 'bun:test';
import {
  MODEL_BUDGET_RULES,
  modelCapabilitySummary,
  resolveModelCapability,
} from '../modelCapabilities';

describe('resolveModelCapability · 预算规则表', () => {
  it('keeps the published ceilings per family', () => {
    expect(resolveModelCapability('deepseek-openai', 'deepseek-v4-flash').budget)
      .toEqual({ contextWindowTokens: 1_000_000, outputReserveTokens: 131_072 });
    expect(resolveModelCapability('glm', 'glm-5.3-flash').budget)
      .toEqual({ contextWindowTokens: 1_000_000, outputReserveTokens: 128_000 });
    expect(resolveModelCapability('qwen', 'qwen3-coder-next').budget)
      .toEqual({ contextWindowTokens: 262_144, outputReserveTokens: 65_536 });
    expect(resolveModelCapability('moonshot', 'kimi-k3').budget)
      .toEqual({ contextWindowTokens: 1_000_000, outputReserveTokens: 65_536 });
    expect(resolveModelCapability('minimax', 'MiniMax-M2.7').budget)
      .toEqual({ contextWindowTokens: 204_800, outputReserveTokens: 131_072 });
    expect(resolveModelCapability('openai', 'gpt-5.2').budget)
      .toEqual({ contextWindowTokens: 400_000, outputReserveTokens: 128_000 });
  });

  it('splits generations inside a family by tier', () => {
    expect(resolveModelCapability('deepseek-openai', 'deepseek-chat').budget?.contextWindowTokens).toBe(128_000);
    expect(resolveModelCapability('anthropic', 'claude-sonnet-5').budget?.contextWindowTokens).toBe(1_000_000);
    expect(resolveModelCapability('anthropic', 'claude-sonnet-4-5').budget?.contextWindowTokens).toBe(200_000);
    expect(resolveModelCapability('qwen', 'qwen3-max').budget?.contextWindowTokens).toBe(1_000_000);
  });

  it('resolves a provider-only query (no model) to the family default', () => {
    // 设置页占位符与「只配了 provider」的回合都会这么问；这里不能掉到保守档。
    expect(resolveModelCapability('glm', '').budget?.contextWindowTokens).toBe(1_000_000);
    expect(resolveModelCapability('glm', undefined).budgetRuleId).toBe('glm');
  });

  it('does not let a custom provider id fabricate a family ceiling', () => {
    // provider 名里的自定义段是用户自由文本，子串只是命名习惯——旧 if 链对
    // 这三组都无档（回落保守），迁移必须保真这个口径。尤其 moonshot-v1-8k：
    // 真实 8k 窗口，曾被放宽匹配喂到 262k（超天花板 32 倍，每个请求都炸）。
    expect(resolveModelCapability('kimi-gateway', 'foo-1').budget).toBeUndefined();
    expect(resolveModelCapability('openrouter', 'moonshot-v1-8k').budget).toBeUndefined();
    expect(resolveModelCapability('my-glm-proxy', 'foo').budget).toBeUndefined();
  });

  it('still reaches family rules through the vendor model name or the built-in word', () => {
    // 收窄只砍 provider 名猜测；证据强的路（厂商模型名子串、显式厂商词根）原样可达。
    expect(resolveModelCapability('openrouter', 'deepseek/deepseek-r1').budgetRuleId).toBe('deepseek');
    expect(resolveModelCapability('openrouter', 'moonshotai/kimi-k2').budgetRuleId).toBe('moonshot-kimi');
    expect(resolveModelCapability('anthropic', 'claude-sonnet-5').budgetRuleId).toBe('claude');
  });

  it('names the rule that answered, so diagnostics are not a black box', () => {
    expect(resolveModelCapability('openai', 'gpt-5.2').budgetRuleId).toBe('gpt-5');
    expect(resolveModelCapability('openai', 'gpt-4o-mini').budgetRuleId).toBe('gpt-4o');
    expect(resolveModelCapability('nope', 'mystery-model').budgetRuleId).toBeUndefined();
    expect(resolveModelCapability('nope', 'mystery-model').budget).toBeUndefined();
  });

  it('keeps the local-runtime ceiling conservative', () => {
    expect(resolveModelCapability('ollama', 'qwen2.5-coder:7b').budget)
      .toEqual({ contextWindowTokens: 32_768, outputReserveTokens: 4_096 });
    expect(resolveModelCapability('lmstudio', 'llama3.1').budget).toBeDefined();
  });

  it('stays ordered: gpt-5 wins before the gpt-4o rule', () => {
    expect(resolveModelCapability('openai', 'gpt-5.2').budget?.outputReserveTokens).toBe(128_000);
    // Rule ids must be unique — a duplicated id hides which rule answered.
    const ids = MODEL_BUDGET_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveModelCapability · 特质', () => {
  it('reasoning is a whitelist: a miss means "do not send the parameter"', () => {
    expect(resolveModelCapability('openai', 'gpt-5.2').reasoning)
      .toMatchObject({ known: true, supported: true, ruleId: 'reasoning-2026' });
    expect(resolveModelCapability('qwen', 'qwen3-coder-next').reasoning)
      .toEqual({ known: true, supported: false });
  });

  it('vision is a known-supports list: a miss is unknown, never a false claim', () => {
    expect(resolveModelCapability('openai', 'gpt-4o').vision).toMatchObject({ known: true, supported: true });
    expect(resolveModelCapability('anthropic', 'claude-sonnet-5').vision.supported).toBe(true);
    // 没判定出来 ≠ 不支持：对未知模型断言 false 会让模型拒绝一张它其实能看的图。
    expect(resolveModelCapability('acme', 'mystery-1').vision)
      .toEqual({ known: false, supported: false });
    expect(resolveModelCapability('openai', 'o3-mini').vision.known).toBe(false);
  });
});

describe('modelCapabilitySummary', () => {
  it('is one ASCII line with the rule and both traits', () => {
    const line = modelCapabilitySummary(resolveModelCapability('deepseek-openai', 'deepseek-v4-pro'));
    expect(line).toBe('capabilities: rule=deepseek reasoning=yes vision=unknown');
    expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
  });

  it('says no for a reasoning-whitelist miss and unknown for an unpinned budget', () => {
    const line = modelCapabilitySummary(resolveModelCapability('acme', 'mystery-1'));
    expect(line).toBe('capabilities: rule=none reasoning=no vision=unknown');
  });
});
