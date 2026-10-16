import { describe, it, expect } from 'bun:test';
import {
  normalizeTokenUsage,
  mergeTokenUsage,
  estimateCostUsd,
  formatCostUsd,
  formatTokens,
  formatTokensCompact,
  readDelegationUsage,
} from '../usage';

describe('normalizeTokenUsage', () => {
  it('maps OpenAI-style usage (cached_tokens in prompt_tokens_details)', () => {
    expect(normalizeTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 70 },
    })).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      cacheHitTokens: 70,
      cacheMissTokens: 30,
    });
  });

  it('maps DeepSeek cache split (top-level prompt_cache_hit_tokens)', () => {
    expect(normalizeTokenUsage({
      prompt_tokens: 200,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 120,
      prompt_cache_miss_tokens: 80,
    })).toEqual({
      promptTokens: 200,
      completionTokens: 40,
      cacheHitTokens: 120,
      cacheMissTokens: 80,
    });
  });

  it('keeps cache fields absent when the provider reports none', () => {
    expect(normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cacheHitTokens: undefined,
      cacheMissTokens: undefined,
    });
  });

  it('returns undefined for garbage input', () => {
    expect(normalizeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeTokenUsage(null)).toBeUndefined();
    expect(normalizeTokenUsage('nope')).toBeUndefined();
    expect(normalizeTokenUsage({})).toBeUndefined();
  });
});

describe('mergeTokenUsage', () => {
  it('sums fields across turns', () => {
    const a = { promptTokens: 100, completionTokens: 20, cacheHitTokens: 30 };
    const b = { promptTokens: 50, completionTokens: 10, cacheMissTokens: 40 };
    expect(mergeTokenUsage(a, b)).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      cacheHitTokens: 30,
      cacheMissTokens: 40,
    });
  });

  it('is identity-safe', () => {
    const a = { promptTokens: 1, completionTokens: 2 };
    expect(mergeTokenUsage(undefined, a)).toEqual(a);
    expect(mergeTokenUsage(a, undefined)).toEqual(a);
    expect(mergeTokenUsage(undefined, undefined)).toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  it('prices DeepSeek cache-miss input, cache-hit input, and output', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000, cacheHitTokens: 300_000, cacheMissTokens: 700_000 };
    // DeepSeek: $0.14/M miss, $0.0028/M hit, $0.28/M output
    const cost = estimateCostUsd(usage, 'deepseek-openai');
    expect(cost).toBeCloseTo(0.7 * 0.14 + 0.3 * 0.0028 + 0.5 * 0.28, 6);
  });

  it('returns 0 without usage or for unknown providers', () => {
    expect(estimateCostUsd(undefined, 'deepseek-openai')).toBe(0);
    expect(estimateCostUsd({ promptTokens: 100 }, 'mystery-provider')).toBe(0);
  });
});

describe('formatting', () => {
  it('formats cost compactly', () => {
    expect(formatCostUsd(0)).toBe('—');
    expect(formatCostUsd(0.0037)).toBe('$0.0037');
    expect(formatCostUsd(0.123)).toBe('$0.123');
    expect(formatCostUsd(1.24)).toBe('$1.24');
  });

  it('formats tokens with separators', () => {
    expect(formatTokens(undefined)).toBe('0');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1234567)).toBe('1,234,567');
  });

  it('formats tokens compactly for sidebar rows', () => {
    expect(formatTokensCompact(undefined)).toBe('0');
    expect(formatTokensCompact(0)).toBe('0');
    expect(formatTokensCompact(999)).toBe('999');
    expect(formatTokensCompact(1_200)).toBe('1.2k');
    expect(formatTokensCompact(123_456)).toBe('123.5k');
    expect(formatTokensCompact(3_400_000)).toBe('3.4M');
  });
});

describe('readDelegationUsage（B4 委派结账）', () => {
  it('从子代理结果体里取出 TokenUsage 四字段', () => {
    expect(readDelegationUsage({ agentId: 'a', output: 'ok', usage: { promptTokens: 100, completionTokens: 40, cacheHitTokens: 60, cacheMissTokens: 40 } }))
      .toEqual({ promptTokens: 100, completionTokens: 40, cacheHitTokens: 60, cacheMissTokens: 40 });
  });

  it('缺 usage 键（旧记录 / 非委派结果）→ undefined，不编造零', () => {
    expect(readDelegationUsage({ output: 'ok' })).toBeUndefined();
    expect(readDelegationUsage(null)).toBeUndefined();
    expect(readDelegationUsage('a string')).toBeUndefined();
    expect(readDelegationUsage(undefined)).toBeUndefined();
  });

  it('usage 形状坏了（非对象 / 全非数值）→ undefined，不把杂物并进总账', () => {
    expect(readDelegationUsage({ usage: 42 })).toBeUndefined();
    expect(readDelegationUsage({ usage: { promptTokens: 'nope' } })).toBeUndefined();
  });

  it('部分字段缺失时保留有的、其余当缺（不把缺失当 0 写死）', () => {
    expect(readDelegationUsage({ usage: { completionTokens: 12 } }))
      .toEqual({ promptTokens: undefined, completionTokens: 12, cacheHitTokens: undefined, cacheMissTokens: undefined });
  });

  it('并进总账后逐项相加——这就是「扇出不再少算一份」的机制', () => {
    const parent = { promptTokens: 1000, completionTokens: 200, cacheHitTokens: 500, cacheMissTokens: 500 };
    const delegation = readDelegationUsage({ usage: { promptTokens: 300, completionTokens: 90, cacheHitTokens: 100, cacheMissTokens: 200 } });
    expect(mergeTokenUsage(parent, delegation)).toEqual({ promptTokens: 1300, completionTokens: 290, cacheHitTokens: 600, cacheMissTokens: 700 });
  });
});
