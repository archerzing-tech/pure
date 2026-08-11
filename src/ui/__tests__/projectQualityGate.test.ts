import { describe, expect, it } from 'bun:test';
import { buildRepairPrompt, buildVerifyCommand, isVerificationCommand, parseCodeReviewVerdict, qualityGateEvidence, qualityGateSummary, runProjectQualityGate } from '../projectQualityGate';
import type { ToolAdapter, ToolCall, ToolDefinition, ToolResult } from '../../shared/types';

const REVIEW_TOOL: ToolDefinition = {
  name: 'code_reviewer',
  description: 'Review code',
  input_schema: { type: 'object' },
};
const COMMAND_TOOL: ToolDefinition = {
  name: 'execute_command',
  description: 'Run a command',
  input_schema: { type: 'object' },
};

function adapter(review: string, commandResults: Array<{ success: boolean; result?: string; error?: string }>): ToolAdapter {
  let commandIndex = 0;
  return {
    getTools: () => [REVIEW_TOOL, COMMAND_TOOL],
    getMetadata: () => ({ sideEffects: true }),
    execute: async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') {
        return { id: call.id, toolName: call.function.name, result: review, success: true, duration: 1 };
      }
      const next = commandResults[Math.min(commandIndex++, commandResults.length - 1)] ?? { success: true, result: 'ok' };
      return { id: call.id, toolName: call.function.name, result: next.result, error: next.error, success: next.success, duration: 1 };
    },
  };
}

describe('project quality gate', () => {
  it('requires an explicit code-review verdict', () => {
    expect(parseCodeReviewVerdict('looks good\nVERDICT: PASS')).toEqual({ status: 'passed', summary: '代码审查通过' });
    expect(parseCodeReviewVerdict('security issue\nVERDICT: FAIL')).toEqual({ status: 'failed', summary: '代码审查发现需要修复的问题' });
    expect(parseCodeReviewVerdict('VERDICT: PASS\nactually, there is a problem')).toEqual({ status: 'unavailable', summary: '代码审查未返回可验证的 PASS/FAIL 结论' });
    expect(parseCodeReviewVerdict('looks good')).toEqual({ status: 'unavailable', summary: '代码审查未返回可验证的 PASS/FAIL 结论' });
  });

  it('runs review, audit, and verification in order before passing', async () => {
    const phases: string[] = [];
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: 'audit clean' },
      { success: true, result: 'tests passed' },
    ]), { onPhase: (phase, status) => phases.push(`${phase}:${status}`) });
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.phase)).toEqual(['review', 'audit', 'verify']);
    expect(phases).toEqual(['review:active', 'review:passed', 'audit:active', 'audit:passed', 'verify:active', 'verify:passed']);
    expect(qualityGateSummary(result)).toContain('全部通过');
    expect(qualityGateEvidence(result, false)).toContain('项目允许交付');
  });

  it('stops at the first failed gate and creates a repair prompt', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: false, error: 'high severity vulnerability' },
      { success: true, result: 'should not run' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks.map((check) => check.phase)).toEqual(['review', 'audit']);
    expect(buildRepairPrompt(result)).toContain('high severity vulnerability');
    expect(buildRepairPrompt(result)).toContain('修复阶段');
  });

  it('blocks projects without a standard verification manifest', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-not-applicable]' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[1].status).toBe('unavailable');
  });

  it('stops when the quality gate is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', []), { signal: controller.signal });
    expect(result.passed).toBe(false);
    expect(result.checks[0].summary).toContain('已取消');
  });

  it('blocks a review tool that does not provide a machine-checkable verdict', async () => {
    const result = await runProjectQualityGate(adapter('I think it is fine', []));
    expect(result.passed).toBe(false);
    expect(result.checks[0].status).toBe('unavailable');
  });
});

describe('verification command helpers', () => {
  it('buildVerifyCommand covers npm, cargo, and Python stacks', () => {
    expect(buildVerifyCommand()).toContain('npm run typecheck');
    expect(buildVerifyCommand()).toContain('cargo test');
    expect(buildVerifyCommand()).toContain('pytest');
  });

  it('isVerificationCommand recognizes check commands', () => {
    expect(isVerificationCommand('npm run typecheck')).toBe(true);
    expect(isVerificationCommand('npm test')).toBe(true);
    expect(isVerificationCommand('npm run build && npm test')).toBe(true);
    expect(isVerificationCommand('bun test')).toBe(true);
    expect(isVerificationCommand('tsc --noEmit')).toBe(true);
    expect(isVerificationCommand('cargo test --lib')).toBe(true);
    expect(isVerificationCommand('pytest tests/')).toBe(true);
  });

  it('rejects non-verification commands', () => {
    expect(isVerificationCommand('npm install')).toBe(false);
    expect(isVerificationCommand('ls -la')).toBe(false);
    expect(isVerificationCommand('git add .')).toBe(false);
  });
});
