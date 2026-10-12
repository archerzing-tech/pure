// src/__tests__/cli-intent.test.ts
// Regression coverage for the CLI's proactive high-risk request path.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assessIntent } from '../coding-agent/Planner';
import { activeCharacterProfileId, setActiveCharacterProfile } from '../character';
import { defaultCliAutoApprove, resolveCharacterProfileId } from '../cliConfig';
import {
  composeCliIntentUserTurn,
  formatCliIntentAssessment,
  resolveCliAutoApprove,
  shouldProbeCliWorkspace,
} from '../cliIntent';

const highRisk = assessIntent('删除整个项目');
const mediumRisk = assessIntent('把认证模块重构成新的实现');
const lowRisk = assessIntent('解释这个文件的作用');

describe('CLI proactive intent assessment', () => {
  it('prints a visible high-risk summary instead of silently treating deletion as ordinary work', () => {
    const output = formatCliIntentAssessment(highRisk);
    expect(output).toContain('high risk');
    expect(output).toContain('irreversible');
    expect(output).toContain(highRisk.impact);
    expect(output).toContain(highRisk.recommendation);
  });

  it('does not print a risk banner for a low-risk question', () => {
    expect(formatCliIntentAssessment(lowRisk)).toBe('');
  });

  it('keeps the high-risk approval instruction beside the CLI request in L2', () => {
    const turn = composeCliIntentUserTurn('删除整个项目', highRisk, {
      contract: '<delivery_contract>inspect before changing</delivery_contract>',
    });
    expect((turn.match(/<intent_assessment>/g) ?? []).length).toBe(1);
    expect(turn).toContain('Risk: high');
    expect(turn).toContain('wait for explicit user approval');
    expect(turn).toContain('<delivery_contract>inspect before changing</delivery_contract>');
    expect(turn.endsWith('删除整个项目')).toBe(true);
  });

  it('only probes when tools are available and the assessment requires it', () => {
    expect(shouldProbeCliWorkspace(true, highRisk)).toBe(true);
    expect(shouldProbeCliWorkspace(true, mediumRisk)).toBe(true);
    expect(shouldProbeCliWorkspace(true, lowRisk)).toBe(false);
    expect(shouldProbeCliWorkspace(false, highRisk)).toBe(false);
  });

  it('defaults to CLI auto-approval but switches to interactive tool confirmation', () => {
    expect(resolveCliAutoApprove(false)).toBe(true);
    expect(resolveCliAutoApprove(true)).toBe(false);
    expect(resolveCliAutoApprove(false, false)).toBe(false);
  });

  it('keeps auto-approve on risky turns: risk is surfaced as a prompt line, the gate moved to danger-level ops (2026-10-10)', () => {
    // 修「做着做着突然没权限」：风险评估不再翻转立场——高风险轮与普通轮
    // 同一立场；dangerLevel==='danger' 的操作在 createCliPermissionHandler
    // 里单独落交互门（见 cli-permission.test.ts）。
    expect(resolveCliAutoApprove(false, true)).toBe(true);
    expect(resolveCliAutoApprove(true, true)).toBe(false);
    expect(resolveCliAutoApprove(false, false)).toBe(false);
  });

  it('刀 5 — 终端默认立场来自活跃性格内核：工匠慢线在台上时默认逐步确认', () => {
    // 默认内核（老手快线）的确认倾向是 auto：上面的「默认自动放行」逐字不变。
    // 换上「工匠慢线」后它的确认倾向是 confirm，终端默认就该逐步问——那是那个
    // 内核的定义，不是全局默认被改（蓝图 §4 红线 4）。
    const original = activeCharacterProfileId();
    try {
      expect(defaultCliAutoApprove()).toBe(true);
      setActiveCharacterProfile('craftsman-slow');
      expect(defaultCliAutoApprove()).toBe(false);
    } finally {
      setActiveCharacterProfile(original);
    }
  });

  it('刀 5 — 入口真的把性格内核注入运行时（--character > config.json）', () => {
    const entry = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    expect(entry).toContain('setActiveCharacterProfile(resolveCharacterProfileId(flags.character, fileCfg?.characterProfileId))');
  });

  it('刀 5 — --character 单次覆盖赢过 config.json；不带值时当没给', () => {
    expect(resolveCharacterProfileId('craftsman-slow', 'veteran-fast')).toBe('craftsman-slow');
    expect(resolveCharacterProfileId(undefined, 'craftsman-slow')).toBe('craftsman-slow');
    // parseArgs 给不带值的 flag 补的是字面 'true'，那不是合法 id。
    expect(resolveCharacterProfileId('true', 'craftsman-slow')).toBe('craftsman-slow');
    expect(resolveCharacterProfileId(undefined, undefined)).toBeUndefined();
  });

  it('keeps both CLI execution paths applying the permission stance', () => {
    // Both run loops live in cliRepl.ts since the cli.ts split (audit ①).
    const source = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((source.match(/applyCliIntentPermission\(tools, args\)/g) ?? []).length).toBe(2);
  });

  it('keeps both CLI execution paths wired to the shared assembler', () => {
    // Run loops (one-shot + REPL) call assembleCliPrompt in cliRepl.ts; the
    // parseArgs permission defaulting stays in cli.ts.
    const repl = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((repl.match(/const assembly = await? assembleCliPrompt\(/g) ?? []).length).toBe(2);
    expect(repl).toContain('toolDefinitions: toolsDefs');
    const entry = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    // 刀 5 起默认立场由活跃性格内核给出（defaultCliAutoApprove()），不再是常量。
    expect(entry).toContain("resolveCliAutoApprove(flags['prompt-on-tool'] !== undefined, defaultCliAutoApprove())");
  });

  it('routes both CLI paths through the one shared turn-route producer', () => {
    // The CLI used to re-derive the route inline (bypass / conversational /
    // inferSemanticRoute / compileRequestWorkflow), which is exactly how the
    // two surfaces drifted apart. Both loops now call the shared producer, and
    // neither reaches for the individual layers any more.
    const source = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((source.match(/decideTurnRoute\(/g) ?? []).length).toBe(2);
    expect(source).not.toContain('inferSemanticRoute');
    expect(source).not.toContain('compileRequestWorkflow');
    expect(source).toContain('printWorkflowStage(workflow.stage)');
    expect(source).toContain('workflow.probeRequired && !workflow.probeAvailable');
  });
});
