import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeToolAdapter } from '../../adapter/node/NodeToolAdapter';
import { buildAuditCommand, buildLocalReviewCommand, buildRepairPrompt, buildVerifyCommand, hasRepairableQualityFindings, isVerificationCommand, parseCodeReviewVerdict, parseProjectAuditResult, projectCdPrefix, projectDirectoryFor, qualityGateEvidence, qualityGateSummary, runProjectQualityGate } from '../projectQualityGate';
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

  it('reports the concrete backend action while each phase is waiting', async () => {
    const activities: string[] = [];
    await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: 'tests passed' },
    ]), { onActivity: (_phase, message) => activities.push(message) });
    expect(activities).toEqual([
      '正在调用代码审查工具，等待审查结论…',
      '正在执行只读依赖/安全审计（不修改依赖），等待审计输出…',
      '正在执行类型检查与自动化测试，等待验证结果…',
    ]);
  });

  it('parses audit evidence without confusing vulnerabilities with unavailable infrastructure', () => {
    expect(parseProjectAuditResult('[audit-tool] bun audit --json\n{}\n[audit-exit] 0')).toEqual({ status: 'passed', summary: '依赖/安全审计通过，未发现达到门禁阈值的问题' });
    expect(parseProjectAuditResult('[audit-tool] npm audit --json\n{"vulnerabilities":{"x":{"severity":"high"}},"metadata":{"vulnerabilities":{"high":1}}}\n[audit-exit] 1')).toEqual({ status: 'failed', summary: '依赖/安全审计发现漏洞或安全策略问题' });
    expect(parseProjectAuditResult('npm ERR! code EAI_AGAIN\n[audit-exit] 1')).toEqual({ status: 'unavailable', summary: '依赖/安全审计未完成（退出码 1，疑似网络或环境问题）' });
    expect(parseProjectAuditResult('[audit-unavailable] package.json has no lockfile for a reproducible audit').status).toBe('unavailable');
    expect(parseProjectAuditResult('[audit-not-applicable] package.json has no third-party dependencies to audit').status).toBe('passed');
    expect(parseProjectAuditResult('[audit-not-applicable] no supported dependency manifest').status).toBe('passed');
    expect(parseProjectAuditResult('[audit-exit] 1').status).toBe('unavailable');
  });

  it('builds platform-compatible local review commands', () => {
    const posix = buildLocalReviewCommand('posix');
    const windows = buildLocalReviewCommand('windows');
    expect(posix).toContain('if [');
    expect(posix).toContain('find . -type f');
    expect(windows).toContain('$workspaceRoot');
    expect(windows).toContain('Get-ChildItem -Recurse -File');
    expect(windows).toContain('[local-review] no credential pattern found');
    expect(windows).not.toContain('if [');
    expect(windows).not.toContain('&&');
    expect(windows).not.toContain('find . -type f');
  });
  it('builds a local review command that works inside and outside Git', () => {
    const command = buildLocalReviewCommand('posix');
    expect(command).toContain('git rev-parse --show-toplevel');
    expect(command).toContain('not a standalone git repository; skipping Git diff/status checks');
    expect(command).toContain('find . -type f');
    expect(command).not.toContain('git init');
  });


  it.skipIf(process.platform !== 'win32')('actually completes the PowerShell local review in a non-Git workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pure-quality-windows-'));
    try {
      writeFileSync(join(workspace, 'index.html'), '<!doctype html>');
      const tools = new NodeToolAdapter({ workspace, commandTimeout: 10_000 });
      const result = await tools.execute({
        id: 'local-review-windows',
        index: 0,
        function: { name: 'execute_command', arguments: JSON.stringify({ command: buildLocalReviewCommand('windows') }) },
      });
      expect(result).toMatchObject({ success: true });
      const output = String((result.result as { stdout?: string; stderr?: string })?.stdout ?? result.result);
      expect(output).toContain('[local-review] not a standalone git repository');
      expect(output).toContain('[local-review] no credential pattern found');
      expect(String((result.result as { stderr?: string })?.stderr ?? '')).not.toContain('CLIXML');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('builds read-only lockfile-aware audit commands', () => {
    const command = buildAuditCommand();
    expect(command).toContain('bun audit --json');
    expect(command).toContain('npm audit --json --audit-level=moderate --ignore-scripts');
    expect(command).toContain('cargo audit --json');
    expect(command).not.toContain('audit fix');
    expect(command).not.toContain('cargo update');
  });

  it('runs review, audit, and verification in order before passing', async () => {
    const phases: string[] = [];
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: 'tests passed' },
    ]), { onPhase: (phase, status) => phases.push(`${phase}:${status}`) });
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.phase)).toEqual(['review', 'audit', 'verify']);
    expect(result.evidence.map((entry) => entry.status)).toEqual(['passed', 'passed', 'passed']);
    expect(result.evidence.map((entry) => entry.phase)).toEqual(['review', 'audit', 'verify']);
    expect(phases).toEqual(['review:active', 'review:passed', 'audit:active', 'audit:passed', 'verify:active', 'verify:passed']);
    expect(qualityGateSummary(result)).toContain('全部通过');
    expect(qualityGateEvidence(result, false)).toContain('项目允许交付');
  });

  it('does not send audit infrastructure failures into the code repair loop', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: false, error: 'audit tool unavailable' },
      { success: true, result: 'should not run' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks.map((check) => check.phase)).toEqual(['review', 'audit']);
    expect(result.checks[1].status).toBe('unavailable');
    expect(hasRepairableQualityFindings(result)).toBe(false);
  });

  it('creates a constrained repair prompt only for actual audit findings', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] npm audit --json\n{"vulnerabilities":{"x":{"severity":"high"}}}\n[audit-exit] 1' },
    ]));
    expect(result.passed).toBe(false);
    expect(hasRepairableQualityFindings(result)).toBe(true);
    expect(buildRepairPrompt(result)).toContain('修复阶段');
    expect(buildRepairPrompt(result)).toContain('禁止执行 git init');
    expect(buildRepairPrompt(result)).toContain('测试、类型检查或审计命令');
    expect(buildRepairPrompt(result)).not.toContain('git add .');
  });

  it('does not make a vague auditor FAIL repairable without finding evidence', async () => {
    const tools = adapter('VERDICT: PASS', []);
    tools.execute = async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') return { id: call.id, toolName: call.function.name, result: 'VERDICT: PASS', success: true, duration: 1 };
      if (call.function.name === 'project_auditor') return { id: call.id, toolName: call.function.name, result: '检查未完成\nAUDIT: FAIL', success: true, duration: 1 };
      return { id: call.id, toolName: call.function.name, result: '[audit-unavailable] tool unavailable', success: true, duration: 1 };
    };
    const result = await runProjectQualityGate(tools);
    expect(result.passed).toBe(false);
    expect(result.checks[1].status).toBe('unavailable');
    expect(hasRepairableQualityFindings(result)).toBe(false);
  });

  it('does not trust an auditor PASS when the report contains an actionable finding', async () => {
    const tools = adapter('VERDICT: PASS', []);
    tools.getTools = () => [REVIEW_TOOL, COMMAND_TOOL, { name: 'project_auditor', description: 'Audit project', input_schema: { type: 'object' } }];
    tools.execute = async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') return { id: call.id, toolName: call.function.name, result: 'VERDICT: PASS', success: true, duration: 1 };
      if (call.function.name === 'project_auditor') return { id: call.id, toolName: call.function.name, result: 'critical vulnerability remains\nAUDIT: PASS', success: true, duration: 1 };
      return { id: call.id, toolName: call.function.name, result: '[audit-unavailable] tool unavailable', success: true, duration: 1 };
    };
    const result = await runProjectQualityGate(tools);
    expect(result.passed).toBe(false);
    expect(result.checks[1]).toMatchObject({ status: 'failed', repairable: true });
  });

  it('accepts an audit-not-applicable workspace as a vacuous pass', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-not-applicable]' },
    ]));
    expect(result.passed).toBe(true);
    expect(result.checks[1].status).toBe('passed');
  });

  it('treats a no-manifest workspace as verify-not-applicable instead of blocking delivery', async () => {
    // The user's reported dead rule: "生成 4 个网页大屏" (static HTML pages, no
    // package.json/Cargo.toml) — the audit vacuously passes but the old verify
    // path hard-blocked with "无法形成验证证据 → 禁止宣称完成".
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-not-applicable]' },
      { success: true, result: '[verify-not-applicable] no standard test manifest' },
    ]));
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(['passed', 'passed', 'not_applicable']);
    expect(qualityGateSummary(result)).toContain('自动化验证不适用');
    const evidence = qualityGateEvidence(result, false);
    expect(evidence).toContain('自动化验证：不适用（无标准测试入口）');
    expect(evidence).toContain('交付带有限制');
    expect(evidence).not.toContain('禁止宣称完成');
  });

  it('accepts clean local review plus verify-not-applicable (static web page task)', async () => {
    const result = await runProjectQualityGate(adapter('I think it is fine', [
      { success: true, result: '[local-review] git diff --check\n[local-review] no credential pattern found' },
      { success: true, result: '[audit-not-applicable]' },
      { success: true, result: '[verify-not-applicable] no standard test manifest' },
    ]));
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual(['degraded', 'passed', 'not_applicable']);
    expect(qualityGateSummary(result)).toContain('交付带有限制');
  });

  it('records repair rounds and concrete issue history in delivery evidence', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] npm audit --json\\n{"vulnerabilities":{"x":{"severity":"high"}}}\\n[audit-exit] 1' },
    ]));
    const evidence = qualityGateEvidence(result, true, 3, ['第 1 轮发现：依赖问题', '第 2 轮发现：测试失败', '第 3 轮后仍未通过：审查失败']);
    expect(evidence).toContain('自动修复与复查 3 轮');
    expect(evidence).toContain('第 3 轮后仍未通过');
  });

  it('does not mark an auditor environment failure as code-repairable', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', []));
    expect(result.passed).toBe(false);
    expect(result.checks[1]?.repairable).not.toBe(true);
  });

  it('does not send verification environment failures into the code repair loop', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: false, error: 'Command failed with exit code 127: npm: command not found' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[2].status).toBe('unavailable');
    expect(result.checks[2].failureKind).toBe('tool_unavailable');
    expect(result.checks[2].repairable).not.toBe(true);
  });

  it('records permission blocks as environment evidence instead of code failures', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: false, error: 'Permission denied by the active permission policy' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[2]).toMatchObject({ status: 'unavailable', failureKind: 'permission_blocked', repairable: false });
  });

  it('stops when the quality gate is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', []), { signal: controller.signal });
    expect(result.passed).toBe(false);
    expect(result.checks[0].summary).toContain('已取消');
  });

  it('passes a clean local static review with limitation messaging instead of hard-failing', async () => {
    const result = await runProjectQualityGate(adapter('I think it is fine', [
      { success: true, result: '[local-review] git diff --check\n[local-review] no credential pattern found' },
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: 'tests passed' },
    ]));
    // A clean local scan (the only review available in this app without the
    // LLM reviewer) counts as a passing review-with-limitations, never as a
    // full PASS — the summary still says so.
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0].status).toBe('degraded');
    expect(result.checks[0].reviewMode).toBe('local');
    expect(result.checks[0].summary).toContain('不能替代完整代码审查');
    expect(result.checks[0].output).toContain('no credential pattern found');
    expect(qualityGateSummary(result)).toContain('交付带有限制');
    expect(qualityGateEvidence(result, false)).toContain('仍有审查限制');
  });

  it('passes the gate when only the local review is available (no code_reviewer tool)', async () => {
    const tools = adapter('unused', [
      { success: true, result: '[local-review] not a standalone git repository; skipping Git diff/status checks\n[local-review] no credential pattern found' },
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: 'tests passed' },
    ]);
    tools.getTools = () => [COMMAND_TOOL];
    const result = await runProjectQualityGate(tools);
    expect(result.passed).toBe(true);
    expect(result.checks[0].status).toBe('degraded');
  });

  it('treats whitespace findings in the local review as non-blocking notes', () => {
    const command = buildLocalReviewCommand('posix');
    // git diff --check failures must not exit 1 — the scan continues to the
    // credential check and the review still completes as a degraded pass.
    expect(command).toContain("else echo '[local-review] diff check found whitespace issues (non-blocking)'");
    expect(command).not.toMatch(/diff check failed'; exit 1/);
  });

  it('classifies an empty-output local review failure as an environment limitation', async () => {
    const result = await runProjectQualityGate(adapter('unused', [
      { success: false, error: 'Command failed with exit code 1' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[0].status).toBe('unavailable');
    expect(result.checks[0].summary).toContain('环境限制');
    expect(result.checks[0].summary).not.toContain('本地静态审查也失败');
    expect(hasRepairableQualityFindings(result)).toBe(false);
  });

  it('still reports a real credential finding as a review failure', async () => {
    const result = await runProjectQualityGate(adapter('unused', [
      { success: false, error: 'Command failed with exit code 1:\n[local-review] possible credential pattern found' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[0].status).toBe('failed');
    expect(result.checks[0].summary).toContain('本地静态审查也失败');
  });

  it('audits and verifies inside the discovered project directory', async () => {
    expect(projectDirectoryFor({ projectType: 'node', packageManager: 'npm', manifests: ['my-app/package.json'], scripts: {}, testFilesFound: false, gitRepository: false, relevantFiles: ['my-app/package.json'], verification: [] })).toBe('my-app');
    expect(projectDirectoryFor({ projectType: 'node', packageManager: 'npm', manifests: ['package.json'], scripts: {}, testFilesFound: false, gitRepository: false, relevantFiles: ['package.json'], verification: [] })).toBe('.');
    expect(projectCdPrefix('my-app', 'posix')).toContain("cd 'my-app'");
    expect(projectCdPrefix('.')).toBe('');
    const commands: string[] = [];
    const tools = adapter('VERDICT: PASS', []);
    tools.execute = async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') return { id: call.id, toolName: call.function.name, result: 'VERDICT: PASS', success: true, duration: 1 };
      const command = String(JSON.parse(call.function.arguments).command ?? '');
      commands.push(command);
      if (call.function.name === 'execute_command' && command.includes('audit-tool')) return { id: call.id, toolName: call.function.name, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0', success: true, duration: 1 };
      return { id: call.id, toolName: call.function.name, result: 'tests passed', success: true, duration: 1 };
    };
    const profile = { projectType: 'node' as const, packageManager: 'npm' as const, manifests: ['my-app/package.json'], scripts: { test: 'node --test' } as Record<string, string>, testFilesFound: true, gitRepository: false, relevantFiles: ['my-app/package.json'], verification: [] };
    const result = await runProjectQualityGate(tools, { profile });
    const projectPrefix = projectCdPrefix('my-app');
    expect(result.passed).toBe(true);
    expect(commands.some((c) => c.includes(projectPrefix) && c.includes('audit-tool'))).toBe(true);
    expect(commands.some((c) => c.includes(projectPrefix) && c.includes('verify-step'))).toBe(true);
  });

  it('stops and blocks delivery when the audit command ignores cancellation and times out', async () => {
    const tools = adapter('VERDICT: PASS', []);
    tools.execute = async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') return { id: call.id, toolName: call.function.name, result: 'VERDICT: PASS', success: true, duration: 1 };
      return await new Promise(() => {});
    };
    const result = await runProjectQualityGate(tools, { commandTimeoutMs: 5 });
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1].status).toBe('unavailable');
    expect(result.checks[1].summary).toContain('超时');
  });

  it('does not hang when the reviewer ignores cancellation and times out', async () => {
    let commandRan = false;
    const tools = adapter('never returned', [
      { success: true, result: '[local-review] diff check passed\n[local-review] no credential pattern found' },
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: 'tests passed' },
    ]);
    const originalExecute = tools.execute;
    tools.execute = async (call: ToolCall, signal?: AbortSignal): Promise<ToolResult> => {
      if (call.function.name === 'code_reviewer') return await new Promise(() => {});
      commandRan = true;
      return originalExecute(call, signal);
    };
    const result = await runProjectQualityGate(tools, { reviewTimeoutMs: 5 });
    // The hung reviewer times out into the local scan; a clean local scan is a
    // passing review-with-limitations (see the degraded acceptance rule).
    expect(result.passed).toBe(true);
    expect(result.checks[0].summary).toContain('完整代码审查');
    expect(result.checks[0].status).toBe('degraded');
    expect(result.checks[0].reviewMode).toBe('local');
    expect(commandRan).toBe(true);
  });
});

describe('verification command helpers', () => {
  it('builds platform-compatible audit, verify, and directory commands', () => {
    const audit = buildAuditCommand('windows');
    const verify = buildVerifyCommand(undefined, 'windows');
    const nested = projectCdPrefix('my-app', 'windows');
    expect(audit).toContain('Test-Path -LiteralPath');
    expect(audit).toContain('[audit-exit]');
    expect(verify).toContain('verify-complete');
    expect(verify).toContain('ConvertFrom-Json');
    expect(nested).toContain('Set-Location -LiteralPath');
    for (const command of [audit, verify, nested]) {
      expect(command).not.toContain('if [');
      expect(command).not.toContain('&&');
      expect(command).not.toContain('||');
      expect(command).not.toContain('/dev/null');
    }
    expect(buildAuditCommand('posix')).toContain('if [ -f package.json ]');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('if [ -f package.json ]');
    expect(projectCdPrefix('my-app', 'posix')).toContain('2>/dev/null || exit 127');
  });
  it('buildVerifyCommand covers npm, cargo, Go, and Python stacks', () => {
    expect(buildVerifyCommand(undefined, 'posix')).toContain('npm run typecheck');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('verify-missing-tests');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('hasTestFile');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('node_modules');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('cargo test');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('go test ./...');
    expect(buildVerifyCommand(undefined, 'posix')).toContain('pytest');
  });

  it.skipIf(process.platform !== 'win32')('runs Windows audit and verification without CLIXML', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pure-quality-windows-gate-'));
    try {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' }, dependencies: {} }));
      writeFileSync(join(workspace, 'smoke.test.js'), 'test');
      const profile = {
        projectType: 'node' as const,
        packageManager: 'npm' as const,
        manifests: ['package.json'],
        scripts: { test: 'node -e "process.exit(0)"' },
        testFilesFound: true,
        gitRepository: false,
        relevantFiles: ['package.json'],
        verification: [],
      };
      const tools = new NodeToolAdapter({ workspace, commandTimeout: 10_000 });
      const audit = await tools.execute({ id: 'windows-audit', index: 0, function: { name: 'execute_command', arguments: JSON.stringify({ command: buildAuditCommand('windows') }) } });
      const verify = await tools.execute({ id: 'windows-verify', index: 0, function: { name: 'execute_command', arguments: JSON.stringify({ command: buildVerifyCommand(profile, 'windows') }) } });
      const nested = await tools.execute({ id: 'windows-nested', index: 0, function: { name: 'execute_command', arguments: JSON.stringify({ command: `${projectCdPrefix('.', 'windows')}Write-Output ok` }) } });
      for (const result of [audit, verify, nested]) {
        expect(result.success).toBe(true);
        expect(String((result.result as { stderr?: string })?.stderr ?? '')).not.toContain('CLIXML');
      }
      expect(String((audit.result as { stdout?: string })?.stdout)).toContain('[audit-unavailable] package.json has no lockfile');
      expect(String((verify.result as { stdout?: string })?.stdout)).toContain('[verify-complete]');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('preserves a profile verification failure instead of echoing completion', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pure-quality-verify-'));
    try {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(2)"' } }));
      writeFileSync(join(workspace, 'smoke.test.js'), 'test');
      const profile = {
        projectType: 'node' as const,
        packageManager: 'bun' as const,
        manifests: ['package.json', 'bun.lock'],
        scripts: { test: 'node -e "process.exit(2)"' },
        testFilesFound: true,
        gitRepository: false,
        relevantFiles: ['package.json'],
        verification: [],
      };
      const tools = new NodeToolAdapter({ workspace, commandTimeout: 10_000 });
      const result = await tools.execute({
        id: 'profile-verify-failure',
        index: 0,
        function: { name: 'execute_command', arguments: JSON.stringify({ command: buildVerifyCommand(profile) }) },
      });
      expect(result.success).toBe(false);
      expect(String((result.result as { stdout?: string; stderr?: string })?.stdout ?? result.result)).not.toContain('[verify-complete]');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('treats a missing package test script as a repairable verification failure', async () => {
    const result = await runProjectQualityGate(adapter('VERDICT: PASS', [
      { success: true, result: '[audit-tool] bun audit --json\n{}\n[audit-exit] 0' },
      { success: true, result: '[verify-missing-tests] package.json has no executable test script' },
    ]));
    expect(result.passed).toBe(false);
    expect(result.checks[2]).toMatchObject({ status: 'failed', repairable: true });
    expect(result.checks[2].summary).toContain('没有可执行的自动化测试入口');
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
