import type { ToolAdapter, ToolCall, ToolResult } from '../shared/types';

export type QualityGatePhase = 'review' | 'audit' | 'verify';
export type QualityGateStatus = 'passed' | 'failed' | 'unavailable';

export interface QualityGateCheck {
  phase: QualityGatePhase;
  status: QualityGateStatus;
  summary: string;
  output?: string;
}

export interface ProjectQualityGateResult {
  passed: boolean;
  checks: QualityGateCheck[];
}

export interface QualityGateRunnerOptions {
  onPhase?: (phase: QualityGatePhase, status: 'active' | QualityGateStatus, summary?: string) => void;
  signal?: AbortSignal;
}

let qualityCallNumber = 0;

function nextCallId(phase: string): string {
  qualityCallNumber += 1;
  return `quality_${phase}_${Date.now()}_${qualityCallNumber}`;
}

function call(toolName: string, args: Record<string, unknown>, phase: string): ToolCall {
  return {
    id: nextCallId(phase),
    index: 0,
    function: { name: toolName, arguments: JSON.stringify(args) },
  };
}

function resultText(result: ToolResult): string {
  if (typeof result.result === 'string') return result.result;
  if (result.result === undefined) return result.error ?? '';
  try { return JSON.stringify(result.result); } catch { return String(result.result); }
}

function reviewStatus(output: string): QualityGateStatus {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const verdict = lines.at(-1)?.match(/^VERDICT:\s*(PASS|FAIL)$/i)?.[1]?.toUpperCase();
  if (verdict === 'PASS') return 'passed';
  if (verdict === 'FAIL') return 'failed';
  return 'unavailable';
}

export function parseCodeReviewVerdict(output: string): { status: QualityGateStatus; summary: string } {
  const status = reviewStatus(output);
  if (status === 'passed') return { status, summary: '代码审查通过' };
  if (status === 'failed') return { status, summary: '代码审查发现需要修复的问题' };
  return { status, summary: '代码审查未返回可验证的 PASS/FAIL 结论' };
}

async function executeCommand(
  tools: ToolAdapter,
  command: string,
  phase: QualityGatePhase,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return tools.execute(call('execute_command', { command }, phase), signal);
}

async function runReview(
  tools: ToolAdapter,
  signal?: AbortSignal,
): Promise<QualityGateCheck> {
  const reviewerAvailable = tools.getTools().some((tool) => tool.name === 'code_reviewer');
  if (!reviewerAvailable) {
    return { phase: 'review', status: 'unavailable', summary: 'code_reviewer 工具不可用' };
  }
  const result = await tools.execute(call('code_reviewer', {
    prompt: '这是项目交付前的正式代码审查。请检查当前工作区中本次生成或修改的全部代码，重点检查正确性、明显运行时错误、输入边界、凭据/命令注入风险、危险依赖和与项目目标不一致之处。请给出简洁的阻断问题与建议。只有确认没有阻断交付的问题时，最后一行严格输出 VERDICT: PASS；存在必须修复的问题时输出 VERDICT: FAIL。不要因为轻微风格偏好判 FAIL。',
    files: '当前工作区全部生成文件、package.json/Cargo.toml、配置和测试文件',
  }, 'review'), signal);
  const output = resultText(result);
  if (!result.success) {
    return { phase: 'review', status: 'failed', summary: `代码审查工具失败：${result.error ?? '未知错误'}`, output };
  }
  const verdict = parseCodeReviewVerdict(output);
  return { phase: 'review', status: verdict.status, summary: verdict.summary, output };
}

async function runAudit(
  tools: ToolAdapter,
  signal?: AbortSignal,
): Promise<QualityGateCheck> {
  const command = `if [ -f package.json ]; then if command -v npm >/dev/null 2>&1; then npm audit --audit-level=moderate --no-package-lock; else echo '[audit-unavailable] npm is not installed'; fi; elif [ -f Cargo.toml ]; then if command -v cargo-audit >/dev/null 2>&1; then cargo audit; elif cargo --list 2>/dev/null | grep -qE '(^|[[:space:]])audit([[:space:]]|$)'; then cargo audit; else echo '[audit-unavailable] cargo-audit is not installed'; fi; else echo '[audit-not-applicable] no supported dependency manifest'; fi`;
  const result = await executeCommand(tools, command, 'audit', signal);
  const output = resultText(result);
  if (!result.success) {
    return { phase: 'audit', status: 'failed', summary: `依赖/安全审计发现问题：${result.error ?? '命令失败'}`, output };
  }
  if (output.includes('[audit-unavailable]')) {
    return { phase: 'audit', status: 'unavailable', summary: '依赖/安全审计工具不可用，不能宣称审计通过', output };
  }
  return {
    phase: 'audit',
    status: output.includes('[audit-not-applicable]') ? 'unavailable' : 'passed',
    summary: output.includes('[audit-not-applicable]') ? '未发现可审计的标准依赖清单，无法形成审计证据' : '依赖/安全审计通过',
    output,
  };
}

/** Detect the standard verification command for the workspace's stack:
 * package.json → typecheck + tests, Cargo.toml → cargo test, Python → pytest.
 * Shared by the final quality gate and the per-phase verification backstop
 * (chat.ts runs it when a build phase ends without the model's own checks). */
export function buildVerifyCommand(): string {
  return `if [ -f package.json ]; then npm run typecheck --if-present && npm test --if-present; elif [ -f Cargo.toml ]; then cargo test; elif [ -f pyproject.toml ] || [ -f pytest.ini ]; then if command -v pytest >/dev/null 2>&1; then pytest; else echo '[verify-unavailable] pytest is not installed'; exit 127; fi; else echo '[verify-not-applicable] no standard test manifest'; fi`;
}

/** True when a shell command is a verification/check invocation (typecheck,
 * tests, build, lint, audit…). Used to credit a build phase with the model's
 * own verification evidence before the automatic backstop kicks in. */
export function isVerificationCommand(command: string): boolean {
  return /(?:npm run (?:typecheck|test|build|lint|check|verify)|npm test|bun (?:test|run (?:typecheck|test|build|lint|check))|pnpm (?:test|run (?:typecheck|test|build|lint|check))|tsc(?: --noEmit)?|cargo (?:test|build|check|clippy)|pytest|python -m pytest|vitest|jest|go test|make (?:test|check)|flutter test|flutter analyze)/i.test(command);
}

async function runVerification(
  tools: ToolAdapter,
  signal?: AbortSignal,
): Promise<QualityGateCheck> {
  const command = buildVerifyCommand();
  const result = await executeCommand(tools, command, 'verify', signal);
  const output = resultText(result);
  if (!result.success) {
    return { phase: 'verify', status: 'failed', summary: `自动化验证失败：${result.error ?? '命令失败'}`, output };
  }
  if (output.includes('[verify-unavailable]')) {
    return { phase: 'verify', status: 'unavailable', summary: '自动化验证工具不可用，不能宣称验证通过', output };
  }
  return {
    phase: 'verify',
    status: output.includes('[verify-not-applicable]') ? 'unavailable' : 'passed',
    summary: output.includes('[verify-not-applicable]') ? '未发现标准自动化验证入口，无法形成验证证据' : '自动化验证通过',
    output,
  };
}

export async function runProjectQualityGate(
  tools: ToolAdapter,
  options: QualityGateRunnerOptions = {},
): Promise<ProjectQualityGateResult> {
  const checks: QualityGateCheck[] = [];
  for (const phase of ['review', 'audit', 'verify'] as const) {
    if (options.signal?.aborted) {
      const check: QualityGateCheck = { phase, status: 'failed', summary: '质量门禁已取消，项目禁止交付' };
      checks.push(check);
      options.onPhase?.(phase, check.status, check.summary);
      return { passed: false, checks };
    }
    options.onPhase?.(phase, 'active');
    const check = phase === 'review'
      ? await runReview(tools, options.signal)
      : phase === 'audit'
        ? await runAudit(tools, options.signal)
        : await runVerification(tools, options.signal);
    checks.push(check);
    options.onPhase?.(phase, check.status, check.summary);
    if (options.signal?.aborted) {
      return { passed: false, checks };
    }
    if (check.status !== 'passed') {
      return { passed: false, checks };
    }
  }
  return { passed: true, checks };
}

export function buildRepairPrompt(result: ProjectQualityGateResult): string {
  const failures = result.checks
    .filter((check) => check.status !== 'passed')
    .map((check) => `${check.phase}: ${check.summary}\n${(check.output ?? '').slice(-5000)}`)
    .join('\n\n');
  return `项目交付前质量门禁未通过。请进入修复阶段，只修复下面真实检查发现的问题，不要跳过检查或声称已完成。修复后重新运行相关测试/审计，并在最后简要汇报实际结果。\n\n${failures}`;
}

export function qualityGateSummary(result: ProjectQualityGateResult): string {
  return result.passed
    ? '代码审查、依赖/安全审计、自动化验证全部通过'
    : result.checks.map((check) => `${check.phase}: ${check.summary}`).join('；');
}

export function qualityGateEvidence(result: ProjectQualityGateResult, repaired: boolean): string {
  const labels: Record<QualityGatePhase, string> = {
    review: '代码审查',
    audit: '依赖/安全审计',
    verify: '自动化验证',
  };
  const lines = result.checks.map((check) => `${labels[check.phase]}：${check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '不可用'}`);
  return `交付质量记录（${repaired ? '已执行修复/复查' : '首次检查'}）：${lines.join('；')}。${result.passed ? '项目允许交付。' : '项目未通过质量门禁，禁止宣称完成。'}`;
}
