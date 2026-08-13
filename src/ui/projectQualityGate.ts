import type { ToolAdapter, ToolCall, ToolResult } from '../shared/types';
import { buildVerificationPlan, classifyDeliveryFailure, type DeliveryEvidence, type DeliveryFailureKind, type WorkspaceProfile } from '../shared/delivery';

export type QualityGatePhase = 'review' | 'audit' | 'verify';
export type QualityGateStatus = 'passed' | 'degraded' | 'failed' | 'unavailable';

export interface QualityGateCheck {
  phase: QualityGatePhase;
  status: QualityGateStatus;
  summary: string;
  output?: string;
  /** Whether the result came from the LLM reviewer or the local fallback. */
  reviewMode?: 'agent' | 'local';
  /** Only true when an agent can plausibly fix the finding in the workspace. */
  repairable?: boolean;
  failureKind?: DeliveryFailureKind;
}

export interface ProjectQualityGateResult {
  passed: boolean;
  checks: QualityGateCheck[];
  evidence: DeliveryEvidence[];
}

export interface QualityGateRunnerOptions {
  onPhase?: (phase: QualityGatePhase, status: 'active' | QualityGateStatus, summary?: string) => void;
  onActivity?: (phase: QualityGatePhase, message: string) => void;
  onCheck?: (check: QualityGateCheck) => void;
  /** Override only for tests/embedded runtimes; production uses 45 seconds. */
  reviewTimeoutMs?: number;
  /** Hard wall-clock limit for local audit and verification commands. */
  commandTimeoutMs?: number;
  /** Workspace facts discovered before planning; avoids guessing the package manager and checks. */
  profile?: WorkspaceProfile;
  signal?: AbortSignal;
}

const REVIEW_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 60_000;

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

function auditOutputIsEnvironmentOnly(output: string): boolean {
  return /(?:command not found|no such file or directory|not installed|permission denied|权限不足|未安装|找不到命令|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|network|registry|certificate|lockfile|无法连接|网络|缺少.*锁文件|工具不可用)/i.test(output)
    && !/(?:RUSTSEC-\d{4}-\d{4}|vulnerabilit|security advisory|严重|高危|中危|secret|凭据|注入|危险配置)/i.test(output);
}

function auditOutputHasActionableFinding(output: string): boolean {
  const actionable = /(?:RUSTSEC-\d{4}-\d{4}|vulnerabilit|security advisory|严重|高危|中危|moderate|high|critical|secret|凭据|注入|危险配置|exposed key|private key|unsafe configuration|insecure)/i;
  const negated = /(?:\bno\b|\bnone\b|\bwithout\b|未发现|没有|无|不存在|未检测到|未发现任何)/i;
  return output.split(/\r?\n/).some((line) => actionable.test(line) && !negated.test(line));
}

function verificationOutputIsEnvironmentOnly(output: string): boolean {
  return /(?:command not found|no such file or directory|not installed|permission denied|权限不足|未安装|找不到命令|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|network|registry|certificate|无法连接|网络)/i.test(output)
    && !/(?:assert(?:ion)? failed|test failed|tests failed|failed test|expected .* received|type error|syntax error|compile error|编译失败|测试失败|断言失败)/i.test(output);
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
  signal: AbortSignal | undefined,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ result: ToolResult; timedOut: boolean }> {
  return executeWithTimeout(tools, call('execute_command', { command }, phase), signal, timeoutMs);
}

async function executeWithTimeout(
  tools: ToolAdapter,
  toolCall: ToolCall,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ result: ToolResult; timedOut: boolean }> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const startedAt = Date.now();
  const execution = tools.execute(toolCall, controller.signal)
    .then((result) => ({ result, timedOut: false }))
    .catch((error: unknown) => ({
      result: {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: error instanceof Error ? error.message : String(error),
        success: false,
        duration: Date.now() - startedAt,
      },
      timedOut: false,
    }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ result: ToolResult; timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        result: {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: `审查工具超过 ${Math.round(timeoutMs / 1000)} 秒未返回结果`,
          success: false,
          duration: Date.now() - startedAt,
        },
        timedOut: true,
      });
    }, timeoutMs);
  });
  let abortHandler: (() => void) | undefined;
  const aborted = parentSignal
    ? new Promise<{ result: ToolResult; timedOut: boolean }>((resolve) => {
      abortHandler = (): void => resolve({
        result: {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: '质量门禁已取消',
          success: false,
          duration: Date.now() - startedAt,
        },
        timedOut: false,
      });
      if (parentSignal.aborted) abortHandler();
      else parentSignal.addEventListener('abort', abortHandler, { once: true });
    })
    : null;
  try {
    return await Promise.race(aborted ? [execution, timeout, aborted] : [execution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardAbort);
    if (abortHandler) parentSignal?.removeEventListener('abort', abortHandler);
  }
}

export function buildLocalReviewCommand(): string {
  return `workspace_root=$(pwd -P); git_root=$(git rev-parse --show-toplevel 2>/dev/null || true); if [ -n \"$git_root\" ] && [ \"$git_root\" = \"$workspace_root\" ]; then printf '%s\\n' '[local-review] git diff --check'; if git diff --check; then echo '[local-review] diff check passed'; else echo '[local-review] diff check failed'; exit 1; fi; printf '%s\\n' '[local-review] changed files'; git status --short; printf '%s\\n' '[local-review] diff summary'; git diff --stat; else echo '[local-review] not a standalone git repository; skipping Git diff/status checks'; printf '%s\\n' '[local-review] files in workspace'; find . -type f ! -path './.git/*' ! -path './node_modules/*' ! -path './dist/*' ! -name '*.lock' -print | sort; fi; printf '%s\\n' '[local-review] suspicious credential scan'; matches=$(find . -type f ! -path './.git/*' ! -path './node_modules/*' ! -path './dist/*' ! -name '*.lock' -exec grep -nI -E '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' {} + 2>/dev/null); scan_status=$?; if [ $scan_status -gt 1 ]; then echo '[local-review] credential scan could not complete'; exit 2; elif [ -n \"$matches\" ]; then printf '%s\\n' \"$matches\"; echo '[local-review] possible credential pattern found'; exit 1; else echo '[local-review] no credential pattern found'; fi`;
}

async function runLocalReview(
  tools: ToolAdapter,
  signal?: AbortSignal,
  onActivity?: (message: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS,
  reason = '代码审查工具不可用',
): Promise<QualityGateCheck> {
  const command = buildLocalReviewCommand();
  onActivity?.(`${reason}，切换到本地静态审查：检查工作区差异（如有 Git）、文件和疑似凭据…`);
  const { result, timedOut } = await executeCommand(tools, command, 'review', signal, timeoutMs);
  const output = resultText(result);
  if (timedOut) {
    return { phase: 'review', status: 'failed', summary: `本地静态审查超时（${Math.round(timeoutMs / 1000)} 秒），无法形成审查证据`, output };
  }
  if (!result.success) {
    return { phase: 'review', status: 'failed', summary: `代码审查工具失败，本地静态审查也失败：${result.error ?? '命令失败'}`, output, repairable: false };
  }
  return {
    phase: 'review',
    status: 'degraded',
    reviewMode: 'local',
    summary: '完整代码审查工具未完成；本地静态审查已完成，但不能替代完整代码审查',
    output,
  };
}

async function runReview(
  tools: ToolAdapter,
  signal?: AbortSignal,
  onActivity?: (message: string) => void,
  timeoutMs = REVIEW_TIMEOUT_MS,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
): Promise<QualityGateCheck> {
  const reviewerAvailable = tools.getTools().some((tool) => tool.name === 'code_reviewer');
  onActivity?.('正在调用代码审查工具，等待审查结论…');
  if (!reviewerAvailable) {
    return runLocalReview(tools, signal, onActivity, commandTimeoutMs, 'code_reviewer 工具不可用');
  }
  if (signal?.aborted) {
    return { phase: 'review', status: 'failed', summary: '质量门禁已取消，未完成代码审查' };
  }
  const reviewCall = call('code_reviewer', {
    prompt: '这是项目交付前的正式代码审查。请检查当前工作区中本次生成或修改的全部代码，重点检查正确性、明显运行时错误、输入边界、凭据/命令注入风险、危险依赖和与项目目标不一致之处。对于编码项目，还必须确认本次业务改动有对应的自动化测试用例或测试文件，并检查测试是否覆盖主流程和关键边界；如果只有业务代码而没有相应测试，必须输出 VERDICT: FAIL 并列出缺口。请给出简洁的阻断问题与建议。只有确认没有阻断交付的问题时，最后一行严格输出 VERDICT: PASS；存在必须修复的问题时输出 VERDICT: FAIL。不要因为轻微风格偏好判 FAIL。',
    files: '当前工作区全部生成文件、package.json/Cargo.toml、配置和测试文件',
  }, 'review');
  const { result, timedOut } = await executeWithTimeout(tools, reviewCall, signal, timeoutMs);
  const output = resultText(result);
  if (!result.success || timedOut || signal?.aborted) {
    const reason = signal?.aborted ? '质量门禁已取消' : timedOut ? '代码审查工具超时' : '代码审查工具失败';
    const fallback = await runLocalReview(tools, signal, onActivity, commandTimeoutMs, reason);
    return signal?.aborted ? { ...fallback, status: 'failed', summary: '质量门禁已取消，未完成代码审查' } : fallback;
  }
  const verdict = parseCodeReviewVerdict(output);
  if (verdict.status === 'unavailable') {
    const fallback = await runLocalReview(tools, signal, onActivity, commandTimeoutMs, '代码审查工具未返回可验证结论');
    return signal?.aborted ? { ...fallback, status: 'failed', summary: '质量门禁已取消，未完成代码审查' } : fallback;
  }  return { phase: 'review', status: verdict.status, summary: verdict.summary, output, reviewMode: 'agent', repairable: verdict.status === 'failed' };
}

export function buildAuditCommand(): string {
  return `if [ -f package.json ]; then if [ -f bun.lock ] || [ -f bun.lockb ]; then if command -v bun >/dev/null 2>&1; then echo '[audit-tool] bun audit --json'; bun audit --json; status=$?; echo "[audit-exit] $status"; exit 0; else echo '[audit-unavailable] bun is not installed'; fi; elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then if command -v npm >/dev/null 2>&1; then echo '[audit-tool] npm audit --json --audit-level=moderate --ignore-scripts'; npm audit --json --audit-level=moderate --ignore-scripts; status=$?; echo "[audit-exit] $status"; exit 0; else echo '[audit-unavailable] npm is not installed'; fi; else echo '[audit-unavailable] package.json has no lockfile for a reproducible audit'; fi; elif [ -f Cargo.toml ]; then if [ ! -f Cargo.lock ]; then echo '[audit-unavailable] Cargo.lock is missing'; elif command -v cargo-audit >/dev/null 2>&1; then echo '[audit-tool] cargo audit --json'; cargo audit --json; status=$?; echo "[audit-exit] $status"; exit 0; elif cargo --list 2>/dev/null | grep -qE '(^|[[:space:]])audit([[:space:]]|$)'; then echo '[audit-tool] cargo audit --json'; cargo audit --json; status=$?; echo "[audit-exit] $status"; exit 0; else echo '[audit-unavailable] cargo-audit is not installed'; fi; else echo '[audit-not-applicable] no supported dependency manifest'; fi`;
}

export function parseProjectAuditResult(output: string): { status: QualityGateStatus; summary: string } {
  if (output.includes('[audit-not-applicable]')) {
    return { status: 'unavailable', summary: '未发现可审计的标准依赖清单，无法形成审计证据' };
  }
  if (output.includes('[audit-unavailable]')) {
    return { status: 'unavailable', summary: '依赖/安全审计工具或可复现锁文件不可用，不能宣称审计通过' };
  }
  const exit = output.match(/\[audit-exit\]\s*(\d+)/i);
  if (!exit) {
    return { status: 'unavailable', summary: '审计命令未返回结构化退出结果，不能确认项目是否安全' };
  }
  const exitCode = Number(exit[1]);
  const payload = output
    .replace(/\[audit-tool\][^\n]*\n?/gi, '')
    .replace(/\[audit-exit\]\s*\d+\s*/gi, '')
    .trim();
  if (!payload) return { status: 'unavailable', summary: '审计命令没有返回有效报告，不能确认项目是否安全' };
  if (exitCode === 0) return { status: 'passed', summary: '依赖/安全审计通过，未发现达到门禁阈值的问题' };
  if (/(?:command not found|no such file or directory|not installed|permission denied|权限不足|未安装|找不到命令)/i.test(output)) {
    return { status: 'unavailable', summary: '依赖/安全审计工具不可用或没有执行权限，不能宣称审计通过' };
  }
  if (/(?:ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|network|registry|certificate|lockfile|permission denied|无法连接|网络)/i.test(output)) {
    return { status: 'unavailable', summary: `依赖/安全审计未完成（退出码 ${exitCode}，疑似网络或环境问题）` };
  }
  if (/(?:RUSTSEC-\d{4}-\d{4}|vulnerabilit|security advisory|严重|高危|中危)/i.test(output)) {
    return { status: 'failed', summary: '依赖/安全审计发现漏洞或安全策略问题' };
  }
  return { status: 'failed', summary: `依赖/安全审计命令失败（退出码 ${exitCode}），未能确认项目安全` };
}

async function runAudit(
  tools: ToolAdapter,
  signal?: AbortSignal,
  onActivity?: (message: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<QualityGateCheck> {
  onActivity?.('正在执行只读依赖/安全审计（不修改依赖），等待审计输出…');
  const auditorAvailable = tools.getTools().some((tool) => tool.name === 'project_auditor');
  if (auditorAvailable) {
    const auditCall = call('project_auditor', {
      prompt: '这是项目交付前的正式项目审计。请审计当前工作区的依赖、锁文件、凭据暴露、危险配置和可复现验证证据。只读检查，不修改项目。必须在最后一行严格输出 AUDIT: PASS 或 AUDIT: FAIL。缺少工具、锁文件、网络或证据不完整时不要输出 PASS。',
      files: 'package.json、bun.lock/package-lock.json、Cargo.toml/Cargo.lock、配置、脚本和本次生成的源文件',
    }, 'audit');
    const audited = await executeWithTimeout(tools, auditCall, signal, timeoutMs);
    const auditorOutput = resultText(audited.result);
    const verdict = auditorOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.match(/^AUDIT:\s*(PASS|FAIL)$/i)?.[1]?.toUpperCase();
    if (!audited.timedOut && audited.result.success && verdict === 'PASS') {
      if (auditOutputHasActionableFinding(auditorOutput)) {
        return { phase: 'audit', status: 'failed', summary: '项目审计声明通过，但报告中仍包含未被否定的可操作安全问题', output: auditorOutput, repairable: true };
      }
      return { phase: 'audit', status: 'passed', summary: '项目审计通过：依赖、安全配置与交付证据均返回明确结论', output: auditorOutput, repairable: false };
    }
    if (!audited.timedOut && audited.result.success && verdict === 'FAIL') {
      const repairable = !auditOutputIsEnvironmentOnly(auditorOutput) && auditOutputHasActionableFinding(auditorOutput);
      return { phase: 'audit', status: repairable ? 'failed' : 'unavailable', summary: repairable ? '项目审计发现需要修复的问题' : '项目审计未形成可定位的安全问题证据', output: auditorOutput, repairable };
    }
    onActivity?.(audited.timedOut ? '项目审计工具超时，切换到本地只读审计…' : '项目审计工具未返回可验证结论，切换到本地只读审计…');
  }
  const command = buildAuditCommand();
  const { result, timedOut } = await executeCommand(tools, command, 'audit', signal, timeoutMs);
  const output = resultText(result);
  if (timedOut) {
    return { phase: 'audit', status: 'unavailable', summary: `依赖/安全审计超时（${Math.round(timeoutMs / 1000)} 秒），未形成审计证据`, output, failureKind: 'timeout' };
  }
  if (!result.success) {
    const combinedOutput = `${output}\n${result.error ?? ''}`;
    return { phase: 'audit', status: 'unavailable', summary: `依赖/安全审计工具执行失败，暂时无法形成审计证据：${result.error ?? '命令失败'}`, output: combinedOutput, failureKind: classifyDeliveryFailure(combinedOutput), repairable: false };
  }
  const parsed = parseProjectAuditResult(output);
  return { phase: 'audit', ...parsed, output, repairable: parsed.status === 'failed' && auditOutputHasActionableFinding(output) };
}

/** Detect the standard verification command for the workspace's stack.
 * The discovered profile is preferred so Bun projects use Bun, npm projects use
 * npm, and declared lint/build scripts are not silently skipped. */
export function buildVerifyCommand(profile?: WorkspaceProfile): string {
  if (profile) {
    const specs = buildVerificationPlan(profile);
    const commands = specs.filter((spec) => spec.command).map((spec) => `echo '[verify-step] ${spec.id}'; ${spec.command}`);
    const missingTests = profile.projectType !== 'unknown' && (!profile.scripts.test || !profile.testFilesFound);
    if (missingTests) commands.push("echo '[verify-missing-tests] project must expose a test script and discoverable test files'; exit 1");
    if (commands.length > 0) return `${commands.join(' && ')} && echo '[verify-complete]'`;
  }
  return `# npm run typecheck is the npm-equivalent command when no Bun lockfile is present\nif [ -f package.json ]; then if [ -f bun.lock ] || [ -f bun.lockb ]; then runner='bun run'; else runner='npm run'; fi; if node -e "const p=require('./package.json'); process.exit(p.scripts?.typecheck ? 0 : 1)" >/dev/null 2>&1; then $runner typecheck; fi; if node -e "const p=require('./package.json'); process.exit(p.scripts?.lint ? 0 : 1)" >/dev/null 2>&1; then $runner lint; fi; if node -e "const fs=require('fs'); const p=require('./package.json'); const skip=new Set(['node_modules','.git','dist','build','target','.next']); const hasTestFile=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).some(e=>{ if(skip.has(e.name)) return false; const full=dir+'/'+e.name; return e.isDirectory() ? hasTestFile(full) : /(?:^|[./])(?:__tests__[/\\]|[^/\\]+[.](?:test|spec)[.][cm]?[jt]sx?$)/.test(full); }); process.exit(p.scripts?.test && hasTestFile('.') ? 0 : 1)" >/dev/null 2>&1; then if [ "$runner" = 'bun run' ]; then bun run test; else npm test; fi; else echo '[verify-missing-tests] package.json must contain a test script and a discoverable test file/directory'; exit 1; fi; if node -e "const p=require('./package.json'); process.exit(p.scripts?.build ? 0 : 1)" >/dev/null 2>&1; then $runner build; fi; elif [ -f Cargo.toml ]; then cargo check && cargo test && cargo build; elif [ -f pyproject.toml ] || [ -f pytest.ini ]; then if command -v pytest >/dev/null 2>&1; then pytest; else echo '[verify-unavailable] pytest is not installed'; exit 127; fi; else echo '[verify-not-applicable] no standard test manifest'; fi`;
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
  onActivity?: (message: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS,
  profile?: WorkspaceProfile,
): Promise<QualityGateCheck> {
  const command = buildVerifyCommand(profile);
  onActivity?.('正在执行类型检查与自动化测试，等待验证结果…');
  const { result, timedOut } = await executeCommand(tools, command, 'verify', signal, timeoutMs);
  const output = resultText(result);
  if (timedOut) {
    return { phase: 'verify', status: 'unavailable', summary: `自动化验证超时（${Math.round(timeoutMs / 1000)} 秒），暂时无法形成验证证据`, output, failureKind: 'timeout', repairable: false };
  }
  if (!result.success) {
    const combinedOutput = `${output}\n${result.error ?? ''}`;
    const failureKind = classifyDeliveryFailure(combinedOutput);
    if (verificationOutputIsEnvironmentOnly(combinedOutput)) {
      return { phase: 'verify', status: 'unavailable', summary: '自动化验证因工具、网络或权限环境问题未完成，暂不启动代码修复', output: combinedOutput, failureKind, repairable: false };
    }
    return { phase: 'verify', status: 'failed', summary: `自动化验证失败：${result.error ?? '命令失败'}`, output: combinedOutput, failureKind: classifyDeliveryFailure(combinedOutput), repairable: true };
  }
  if (output.includes('[verify-unavailable]')) {
    return { phase: 'verify', status: 'unavailable', summary: '自动化验证工具不可用，不能宣称验证通过', output };
  }
  if (output.includes('[verify-missing-tests]')) {
    return { phase: 'verify', status: 'failed', summary: '编码项目没有可执行的自动化测试入口，不能交付', output, repairable: true };
  }
  return {
    phase: 'verify',
    status: output.includes('[verify-not-applicable]') ? 'unavailable' : 'passed',
    summary: output.includes('[verify-not-applicable]') ? '未发现标准自动化验证入口，无法形成验证证据' : '自动化验证通过',
    output,
  };
}

function buildDeliveryEvidence(checks: QualityGateCheck[]): DeliveryEvidence[] {
  const timestamp = Date.now();
  return checks.map((check, index) => ({
    id: `quality_${check.phase}_${index + 1}`,
    phase: check.phase,
    label: check.phase === 'review' ? '代码审查' : check.phase === 'audit' ? '依赖/安全审计' : '自动化验证',
    status: check.status === 'unavailable' ? 'blocked' : check.status,
    summary: check.summary,
    output: check.output,
    failureKind: check.failureKind,
    repairable: check.repairable,
    timestamp,
  }));
}

export async function runProjectQualityGate(
  tools: ToolAdapter,
  options: QualityGateRunnerOptions = {},
): Promise<ProjectQualityGateResult> {
  const checks: QualityGateCheck[] = [];
  const finish = (passed: boolean): ProjectQualityGateResult => ({ passed, checks, evidence: buildDeliveryEvidence(checks) });
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  for (const phase of ['review', 'audit', 'verify'] as const) {
    if (options.signal?.aborted) {
      const check: QualityGateCheck = { phase, status: 'failed', summary: '质量门禁已取消，项目禁止交付' };
      checks.push(check);
      options.onPhase?.(phase, check.status, check.summary);
      options.onCheck?.(check);
      return finish(false);
    }
    options.onPhase?.(phase, 'active');
    const check = phase === 'review'
      ? await runReview(tools, options.signal, (message) => options.onActivity?.(phase, message), options.reviewTimeoutMs, commandTimeoutMs)
      : phase === 'audit'
        ? await runAudit(tools, options.signal, (message) => options.onActivity?.(phase, message), commandTimeoutMs)
        : await runVerification(tools, options.signal, (message) => options.onActivity?.(phase, message), commandTimeoutMs, options.profile);
    checks.push(check);
    options.onPhase?.(phase, check.status, check.summary);
    options.onCheck?.(check);
    if (options.signal?.aborted) {
      return finish(false);
    }
    if (check.status === 'failed' || check.status === 'unavailable') {
      return finish(false);
    }
  }
  // A degraded review is useful evidence, but it is not equivalent to a
  // completed code review. Never present a degraded gate as fully passed.
  return finish(checks.length === 3 && checks.every((check) => check.status === 'passed'));
}

export function hasRepairableQualityFindings(result: ProjectQualityGateResult): boolean {
  return result.checks.some((check) => check.repairable === true);
}

export function buildRepairPrompt(result: ProjectQualityGateResult): string {
  const failures = result.checks
    .filter((check) => check.repairable === true)
    .map((check) => `${check.phase}: ${check.summary}\n${(check.output ?? '').slice(-5000)}`)
    .join('\n\n');
  return `项目交付前质量门禁发现了可在代码中修复的问题。现在进入修复阶段，请只修复下面列出的真实问题，不要跳过检查或声称已完成。禁止执行 git init、git add、git commit、git reset、git clean、git checkout 或任何会改变 Git 历史/暂存区/工作树状态的命令；本次修复不需要创建或初始化仓库，也不需要提交代码。不要安装依赖、更新锁文件或执行 audit fix；如果问题是工具不可用、网络、权限、缺少锁文件或其他环境原因，应停止修复并如实说明。对于 edit_file 返回“String not found in file”时，不要重复同一段 oldString：先对目标文件调用 read_file，确认当前内容和换行格式，再使用更短的精确上下文；如果改动已经存在，只做读取/验证，不要再次写入。修复后必须运行与问题直接相关的测试、类型检查或审计命令，并报告实际结果；不要只修改代码而跳过验证。若验证仍失败，继续根据新的真实错误修复，不要重复同一套补丁。\n\n${failures || '没有可由代码修复的问题；不要启动修复工具。'}`;
}

export function qualityGateSummary(result: ProjectQualityGateResult): string {
  if (!result.passed) return result.checks.map((check) => `${check.phase}: ${check.summary}`).join('；');
  const review = result.checks.find((check) => check.phase === 'review');
  return review?.reviewMode === 'local'
    ? '本地静态审查已完成；完整代码审查工具未完成，交付带有限制'
    : '代码审查、依赖/安全审计、自动化验证全部通过';
}

export function qualityGateEvidence(
  result: ProjectQualityGateResult,
  repaired: boolean,
  repairRounds = repaired ? 1 : 0,
  repairIssues: string[] = [],
): string {
  const labels: Record<QualityGatePhase, string> = {
    review: '代码审查',
    audit: '依赖/安全审计',
    verify: '自动化验证',
  };
  const lines = result.checks.map((check) => {
    const status = check.status === 'passed' ? '通过' : check.status === 'degraded' ? '降级完成' : check.status === 'failed' ? '失败' : '不可用';
    const mode = check.phase === 'review' && check.reviewMode === 'local' ? '（本地静态审查，非完整代码审查）' : '';
    return `${labels[check.phase]}：${status}${mode}`;
  });
  const rounds = repairRounds > 0 ? `自动修复与复查 ${repairRounds} 轮` : '首次检查';
  const issueLog = repairIssues.length > 0 ? ` 问题记录：${repairIssues.join('；')}` : '';
  return `交付质量记录（${rounds}）：${lines.join('；')}。${result.passed ? (result.checks.some((check) => check.status === 'degraded') ? '项目完成了可执行的降级检查，但仍有审查限制。' : '项目允许交付。') : '项目未通过质量门禁，禁止宣称完成。'}${issueLog}`;
}
