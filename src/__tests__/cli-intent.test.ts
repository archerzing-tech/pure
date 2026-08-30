// src/__tests__/cli-intent.test.ts
// Regression coverage for the CLI's proactive high-risk request path.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assessIntent } from '../coding-agent/Planner';
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

  it('forces interactive confirmation for high-risk turns even without --prompt-on-tool', () => {
    expect(resolveCliAutoApprove(false, true, highRisk)).toBe(false);
    expect(resolveCliAutoApprove(false, true, mediumRisk)).toBe(true);
    expect(resolveCliAutoApprove(false, true, lowRisk)).toBe(true);
  });

  it('keeps both CLI execution paths applying the request-scoped permission policy', () => {
    // Both run loops live in cliRepl.ts since the cli.ts split (audit ①).
    const source = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((source.match(/applyCliIntentPermission\(tools, args, analysis\.intent\)/g) ?? []).length).toBe(2);
    expect(source).toContain('assessment);');
  });

  it('keeps both CLI execution paths wired to the shared assembler', () => {
    // Run loops (one-shot + REPL) call assembleCliPrompt in cliRepl.ts; the
    // parseArgs permission defaulting stays in cli.ts.
    const repl = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((repl.match(/const assembly = await? assembleCliPrompt\(/g) ?? []).length).toBe(2);
    expect(repl).toContain('toolDefinitions: toolsDefs');
    const entry = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8');
    expect(entry).toContain("resolveCliAutoApprove(flags['prompt-on-tool'] !== undefined, DEFAULT_CLI_AUTO_APPROVE)");
  });

  it('uses the shared workflow compiler and exposes unavailable-probe degradation', () => {
    const source = readFileSync(new URL('../cliRepl.ts', import.meta.url), 'utf8');
    expect((source.match(/compileRequestWorkflow\(/g) ?? []).length).toBe(2);
    expect(source).toContain('printWorkflowStage(workflow.stage)');
    expect(source).toContain('workflow.probeRequired && !workflow.probeAvailable');
  });
});
