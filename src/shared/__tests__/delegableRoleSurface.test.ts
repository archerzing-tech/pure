// src/shared/__tests__/delegableRoleSurface.test.ts
// 13.2 试用制的前置：观测切片必须看得见 `~/.pure/subagents/` 里的生成角色。
//
// 这条测试是照着一个**已经存在的错误**写的：生成角色被 register 了、能被委派，
// 但 `scanSubagentAdvice` / `summarizeTeamRoster` / `summarizeByRole` 三处都用
// 硬编码的 8 个内建角色过滤，于是一条委派都没落进它的画像。账上曾把这一条写成
// 「无需额外接线」——那句话是错的，本测试就是它的反面。

import { describe, expect, it } from 'bun:test';
import { scanSubagentAdvice } from '../subagentAdvisory';
import { summarizeTeamRoster, summarizeTeamCosts, roleSurface, TEAM_ROLES } from '../teamObservability';
import { summarizeByRole } from '../strategyEffect';
import { buildEvolutionDashboard } from '../evolutionDashboard';
import type { AgentRunObservation } from '../promptObservability';

const NOW = 1_700_000_000_000;
const GENERATED = 'researcher_focused';

const BUILTINS = ['task_planner', 'code_editor', 'deep_thinker', 'ui_designer', 'bash_executor', 'researcher', 'code_reviewer', 'project_auditor'];

/** A run that delegated only to `role`, `times` times — the shape the
 *  trial-period verdict is supposed to judge. Carries BOTH record shapes: the
 *  named `delegations` array (T1 and later) and the anonymous `toolCalls`
 *  (pre-T1), because each slice reads a different one. */
function runDelegating(role: string, times: number, ok = false): AgentRunObservation {
  return {
    type: 'agent_run',
    sessionId: 's1',
    startedAt: NOW - 60_000,
    endedAt: NOW,
    provider: 'deepseek-openai',
    model: 'deepseek-chat',
    delegations: Array.from({ length: times }, (_, i) => ({
      role, success: ok, durationMs: 1000 + i,
      usage: { promptTokens: 100, completionTokens: 50 },
    })),
    toolCalls: Array.from({ length: times }, () => ({ toolName: role, success: ok, durationMs: 1000 })),
  } as unknown as AgentRunObservation;
}

const SURFACE = [...BUILTINS, GENERATED];

describe('缺省仍是内建八角色', () => {
  it('不传 roles 时生成角色依然不可见——这是 shared 层的物理边界，不是待办', () => {
    // src/shared/ 是纯函数层，物理上拿不到 ~/.pure/subagents/ 的扫描结果，
    // 所以「缺省 = 真实角色面」在这一层不可能实现。漏传参数退化成旧行为，
    // 是一个真实且必要的不变量；想改它得改分层，不是改这个缺省值。
    const records = [runDelegating(GENERATED, 6)];
    expect(scanSubagentAdvice(records, { now: NOW })).toEqual([]);
    expect(Object.keys(summarizeByRole(records))).toEqual([]);
    // 阵容表仍然列得出内建角色（空行），这是既有口径。
    const roster = summarizeTeamRoster(records, { now: NOW });
    expect(roster.rows.every((row) => row.delegations === null)).toBe(true);
  });

  it('roleSurface 忽略 bash_executor（它是穿了 agent 外壳的 shell 命令，不是角色）', () => {
    expect(roleSurface([...BUILTINS, GENERATED]).has('bash_executor')).toBe(false);
    expect(roleSurface([...BUILTINS, GENERATED]).has(GENERATED)).toBe(true);
    expect([...roleSurface()]).toEqual([...TEAM_ROLES]);
  });
});

describe('传入真实可委派面后：生成角色的委派真的进画像', () => {
  it('建议卡看得见它——试用制裁决的数据前提', () => {
    const advice = scanSubagentAdvice([runDelegating(GENERATED, 6)], { now: NOW, roles: SURFACE });
    expect(advice).toHaveLength(1);
    expect(advice[0].role).toBe(GENERATED);
    expect(advice[0].delegations).toBe(6);
    expect(advice[0].failures).toBe(6);
  });

  it('团队阵容给出行，且样本存量列可读', () => {
    const roster = summarizeTeamRoster([runDelegating(GENERATED, 6)], {
      now: NOW,
      roles: SURFACE,
      caseCounts: { [GENERATED]: 3 },
    });
    const row = roster.rows.find((r) => r.role === GENERATED);
    expect(row).toBeDefined();
    expect(row!.delegations).toBe(6);
    expect(row!.successes).toBe(0);
    expect(row!.caseCount).toBe(3);
  });

  it('成本视图认它（命名 delegations 与匿名 toolCalls 两种记录形态都认）', () => {
    const metered = summarizeTeamCosts([runDelegating(GENERATED, 3)], { now: NOW, roles: SURFACE });
    expect(metered.hasMetered).toBe(true);
    expect(metered.rows.some((row) => row.role === GENERATED)).toBe(true);
    // T1 之前的记录没有 usage：对不出金额，但派发数必须数得出。
    const anonymous = {
      type: 'agent_run', sessionId: 's1', startedAt: NOW - 1000, endedAt: NOW,
      toolCalls: [{ toolName: GENERATED, success: false, durationMs: 10 }],
    } as unknown as AgentRunObservation;
    expect(summarizeTeamCosts([anonymous], { now: NOW, roles: SURFACE }).unmeteredDelegations).toBe(1);
  });

  it('策略切片认它', () => {
    const slices = summarizeByRole([runDelegating(GENERATED, 4)], new Set(SURFACE));
    expect(slices[GENERATED].delegations).toBe(4);
    expect(slices[GENERATED].successes).toBe(0);
  });
});

describe('越界行为：注入的面不该放宽成「什么都算角色」', () => {
  it('未在可委派面里的工具名照旧不算委派', () => {
    const rogue = {
      type: 'agent_run', sessionId: 's1', startedAt: NOW - 1000, endedAt: NOW,
      toolCalls: [{ toolName: 'execute_command', success: false, durationMs: 5 }],
    } as unknown as AgentRunObservation;
    expect(Object.keys(summarizeByRole([rogue], new Set(SURFACE)))).toEqual([]);
  });

  it('空数组在阵容表上等同缺省（不会让阵容表变成空白）', () => {
    const records = [runDelegating('researcher', 3)];
    const withEmpty = summarizeTeamRoster(records, { now: NOW, roles: [] });
    const withDefault = summarizeTeamRoster(records, { now: NOW });
    expect(withEmpty.rows.map((r) => r.role)).toEqual(withDefault.rows.map((r) => r.role));
  });
});
describe('变异存活点补测：上一版这几处没有任何测试走到', () => {
  /** A pre-T1 record: no `delegations`, only anonymous toolCalls. The roster and
   *  cost views each have a fallback branch for it, and both were uncovered. */
  function anonymousRun(toolName: string, times = 3): AgentRunObservation {
    return {
      type: 'agent_run', sessionId: 's1', startedAt: NOW - 1000, endedAt: NOW,
      toolCalls: Array.from({ length: times }, () => ({ toolName, success: false, durationMs: 10 })),
    } as unknown as AgentRunObservation;
  }

  it('阵容表的 pre-T1 回退分支认注入面（此前 `.filter(roles.has)` 一行是死代码）', () => {
    const rows = summarizeTeamRoster([anonymousRun(GENERATED, 3)], { now: NOW, roles: SURFACE }).rows;
    expect(rows.find((r) => r.role === GENERATED)?.delegations).toBe(3);
  });

  it('建议侧滤掉 bash_executor——它是唯一拦住 shell 的那道门，而注入面**含**它', () => {
    // builtinRoleNames() 把 bash_executor 算在内，所以这道门是唯一的拦截点；
    // 删掉它，shell 命令就会出建议卡。
    const advice = scanSubagentAdvice([runDelegating('bash_executor', 6)], { now: NOW, roles: SURFACE });
    expect(advice.map((a) => a.role)).not.toContain('bash_executor');
  });

  it('成本视图的反向过滤：面外的角色不进成本行', () => {
    const view = summarizeTeamCosts([runDelegating('some_other_role', 3)], { now: NOW, roles: SURFACE });
    expect(view.rows.some((row) => row.role === 'some_other_role')).toBe(false);
  });

  it('仪表盘透传链未断：buildEvolutionDashboard 把 roles 送到策略切片', () => {
    const withRoles = buildEvolutionDashboard([runDelegating(GENERATED, 4)], { range: 'week', now: NOW, roles: SURFACE });
    expect(Object.keys(withRoles.strategy.byRole)).toContain(GENERATED);
    const without = buildEvolutionDashboard([runDelegating(GENERATED, 4)], { range: 'week', now: NOW });
    expect(Object.keys(without.strategy.byRole)).not.toContain(GENERATED);
  });

  it('「空数组等同缺省」只在阵容表成立——其余三个切片相反，名字别骗人', () => {
    // 保留这条是因为它锁住了 roleSurface([]) → TEAM_ROLES 这条回落路径；
    // 但它**不**是一般规律，所以名字与注释都写明了范围。
    const records = [runDelegating('researcher', 3)];
    expect(summarizeTeamRoster(records, { now: NOW, roles: [] }).rows.map((r) => r.role))
      .toEqual(summarizeTeamRoster(records, { now: NOW }).rows.map((r) => r.role));
    // 反例钉住：建议卡与策略切片把 [] 当「空集」，不是「用缺省」。
    expect(scanSubagentAdvice(records, { now: NOW, roles: [] })).toEqual([]);
    expect(Object.keys(summarizeByRole(records, new Set([])))).toEqual([]);
  });
});
