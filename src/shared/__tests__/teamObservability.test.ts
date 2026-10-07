// src/shared/__tests__/teamObservability.test.ts
// T4 成本聚合的三条铁律：有 usage + 有价目表才算钱；provider 无价目表显示
// 「未定价」；没有 usage 的派发显示「无数据」——后两者都不冒充 0，也不进占比
// 的分母（与评测基线卡同一把尺子）。
import { describe, expect, it } from 'bun:test';
import { summarizeTeamCosts, summarizeTeamRoster } from '../teamObservability';
import type { AgentRunObservation, DelegationObservation, PromptObservation } from '../promptObservability';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function delegation(overrides: Partial<DelegationObservation> = {}): DelegationObservation {
  return {
    agentId: 'ag-aaaa1111',
    role: 'researcher',
    startedAt: NOW - 1000,
    durationMs: 1000,
    success: true,
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunObservation> = {}): PromptObservation {
  return {
    type: 'agent_run',
    traceId: 'run-cost',
    startedAt: NOW - 500,
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...overrides,
  } as PromptObservation;
}

describe('summarizeTeamCosts (T4)', () => {
  it('prices a delegation from the provider rate card and gives it the whole share', () => {
    const view = summarizeTeamCosts([
      run({
        provider: 'deepseek-openai',
        model: 'deepseek-flash',
        delegations: [delegation({
          usage: { promptTokens: 1_000_000, completionTokens: 100_000, cacheHitTokens: 400_000, cacheMissTokens: 600_000 },
        })],
      }),
    ], { now: NOW });

    expect(view.hasMetered).toBe(true);
    expect(view.rows).toHaveLength(1);
    expect(view.unpricedDelegations).toBe(0);
    expect(view.unmeteredDelegations).toBe(0);
    // 0.6M miss × $0.14 + 0.4M hit × $0.0028 + 0.1M out × $0.28
    expect(view.totalUsd).toBeCloseTo(0.11312, 6);
    expect(view.rows[0]).toMatchObject({
      role: 'researcher',
      provider: 'deepseek-openai',
      model: 'deepseek-flash',
      delegations: 1,
      metered: 1,
      priced: true,
      totalTokens: 1_100_000,
    });
    expect(view.rows[0].sharePercent).toBe(100);
  });

  it('splits the share across buckets and ranks the pricier one first', () => {
    const usage = { promptTokens: 1_000_000, cacheMissTokens: 1_000_000, completionTokens: 0 };
    const view = summarizeTeamCosts([
      run({
        provider: 'deepseek-openai',
        delegations: [delegation({ usage })],
      }),
      run({
        traceId: 'run-glm',
        provider: 'glm',
        model: 'glm-5.3',
        delegations: [delegation({ agentId: 'ag-bbbb2222', role: 'code_reviewer', usage })],
      }),
    ], { now: NOW });

    // GLM 输入 $1.00/M 对 DeepSeek $0.14/M —— 贵的那桶排前面。
    expect(view.rows.map((row) => row.provider)).toEqual(['glm', 'deepseek-openai']);
    expect(view.totalUsd).toBeCloseTo(1.14, 6);
    expect(view.rows[0].sharePercent).toBeCloseTo(87.7, 1);
    expect(view.rows[1].sharePercent).toBeCloseTo(12.3, 1);
  });

  it('keeps an unpriced provider out of the total instead of pricing it at $0', () => {
    const view = summarizeTeamCosts([
      run({
        provider: 'mystery-llm',
        delegations: [delegation({ usage: { promptTokens: 500, completionTokens: 500 } })],
      }),
    ], { now: NOW });

    expect(view.hasMetered).toBe(true);
    expect(view.unpricedDelegations).toBe(1);
    expect(view.totalUsd).toBe(0);
    expect(view.rows[0].priced).toBe(false);
    expect(view.rows[0].costUsd).toBeUndefined();
    expect(view.rows[0].sharePercent).toBeNull();
    // token 数照记——算不出钱不等于没有用量。
    expect(view.rows[0].totalTokens).toBe(1000);
  });

  it('counts a delegation without usage as unmetered and keeps the bucket listed', () => {
    const view = summarizeTeamCosts([
      run({
        provider: 'deepseek-openai',
        delegations: [delegation({ agentId: 'ag-cccc3333' })],
      }),
    ], { now: NOW });

    expect(view.hasMetered).toBe(false);
    expect(view.unmeteredDelegations).toBe(1);
    expect(view.rows[0]).toMatchObject({ delegations: 1, metered: 0, priced: false });
    expect(view.rows[0].totalTokens).toBeUndefined();
  });

  it('counts pre-T1 records (anonymous toolCalls, no delegations) as unmetered', () => {
    const legacy = {
      type: 'agent_run',
      traceId: 'legacy',
      startedAt: NOW - 500,
      eventCounts: {},
      toolCalls: [
        { toolName: 'researcher', success: true, durationMs: 5000 },
        { toolName: 'read_file', success: true, durationMs: 100 },
      ],
      reasoningChars: 0,
      outputChars: 0,
    } as PromptObservation;

    const view = summarizeTeamCosts([legacy], { now: NOW });
    // 只有角色委派算缺口；普通工具调用不是委派。
    expect(view.unmeteredDelegations).toBe(1);
    expect(view.rows).toHaveLength(0);
    expect(view.totalUsd).toBe(0);
  });

  it('leaves a provider-less record as an unnamed bucket rather than inventing one', () => {
    const view = summarizeTeamCosts([
      run({ delegations: [delegation({ usage: { promptTokens: 10, completionTokens: 1 } })] }),
    ], { now: NOW });

    expect(view.rows[0].provider).toBe('');
    // provider 未知 ⇒ 无价目表 ⇒ 未定价，而不是「$0」。
    expect(view.rows[0].priced).toBe(false);
    expect(view.unpricedDelegations).toBe(1);
  });

  it('ignores delegations that fall outside the window', () => {
    const view = summarizeTeamCosts([
      run({
        startedAt: NOW - 40 * DAY,
        provider: 'deepseek-openai',
        delegations: [delegation({ usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } })],
      }),
    ], { now: NOW });

    expect(view.rows).toHaveLength(0);
    expect(view.hasMetered).toBe(false);
    expect(view.windowStart).toBe(NOW - 30 * DAY);
  });
});

describe('summarizeTeamRoster：每角色的窗口下界（13.2 试用期）', () => {
  function delegating(role: string, startedAt: number): PromptObservation {
    return run({ startedAt, delegations: [delegation({ role, startedAt })] });
  }

  it('早于下界的委派不计入该角色，别的角色照旧', () => {
    const roster = summarizeTeamRoster([
      delegating('researcher', NOW - 10 * DAY),
      delegating('researcher_focused', NOW - 10 * DAY),
      delegating('researcher_focused', NOW - 1 * DAY),
    ], {
      now: NOW,
      roles: ['researcher', 'researcher_focused'],
      // 「重新启用」= 一段新的试用期：当年把它送进归档的那次委派不该再算数。
      roleSince: { researcher_focused: NOW - 2 * DAY },
    });
    expect(roster.rows.find((row) => row.role === 'researcher_focused')?.delegations).toBe(1);
    // 下界是**按角色**的：父角色自己的读数不该被变体的重启来回改写。
    expect(roster.rows.find((row) => row.role === 'researcher')?.delegations).toBe(1);
  });

  it('下界表里没有的角色照旧读满窗口（手写角色没有注册时刻）', () => {
    const roster = summarizeTeamRoster([
      delegating('researcher', NOW - 10 * DAY),
    ], { now: NOW, roles: ['researcher'], roleSince: {} });
    expect(roster.rows.find((row) => row.role === 'researcher')?.delegations).toBe(1);
  });
});
