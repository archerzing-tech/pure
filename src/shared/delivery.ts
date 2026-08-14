import type { ToolAdapter, ToolCall, ToolResult } from './types';

export type WorkspaceProjectType = 'node' | 'bun' | 'rust' | 'python' | 'go' | 'unknown';
export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn' | 'cargo' | 'pip' | 'unknown';
export type DeliveryStatus = 'pending' | 'running' | 'passed' | 'degraded' | 'failed' | 'blocked' | 'skipped' | 'not_applicable';
export type DeliveryFailureKind =
  | 'code_error'
  | 'test_failure'
  | 'typecheck_failure'
  | 'build_failure'
  | 'lint_failure'
  | 'audit_finding'
  | 'tool_unavailable'
  | 'network_failure'
  | 'permission_blocked'
  | 'timeout'
  | 'no_evidence'
  | 'scope_drift';

export interface VerificationSpec {
  id: string;
  label: string;
  command: string;
  required: boolean;
  reason: string;
  timeoutMs?: number;
}

export interface WorkspaceProfile {
  projectType: WorkspaceProjectType;
  packageManager: PackageManager;
  manifests: string[];
  scripts: Record<string, string>;
  testFilesFound: boolean;
  gitRepository: boolean;
  relevantFiles: string[];
  verification: VerificationSpec[];
  explorationComplete?: boolean;
}

export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
  verification?: string;
  required: boolean;
}

export interface TaskContract {
  goal: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  acceptanceCriteria: TaskAcceptanceCriterion[];
  verification: VerificationSpec[];
}

export interface DeliveryEvidence {
  id: string;
  phase: 'explore' | 'execute' | 'verify' | 'review' | 'audit' | 'delivery';
  label: string;
  status: DeliveryStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary: string;
  output?: string;
  failureKind?: DeliveryFailureKind;
  repairable?: boolean;
  timestamp: number;
}

function call(toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `discovery_${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    index: 0,
    function: { name: toolName, arguments: JSON.stringify(args) },
  };
}

const DISCOVERY_TOOL_TIMEOUT_MS = 8_000;

async function execute(
  tools: ToolAdapter,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  if (signal?.aborted) return null;
  try {
    return await new Promise<ToolResult | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => finish(null);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (value: ToolResult | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      timer = setTimeout(() => finish(null), DISCOVERY_TOOL_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      tools.execute(call(toolName, args), signal).then(finish, () => finish(null));
    });
  } catch {
    return null;
  }
}

function resultString(result: ToolResult | null): string {
  if (!result?.success) return '';
  if (typeof result.result === 'string') return result.result;
  try { return JSON.stringify(result.result ?? ''); } catch { return ''; }
}

function parseScripts(packageJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

function isIgnoredWorkspacePath(value: string): boolean {
  const normalized = value.trim().replaceAll('\\\\', '/').replace(/^\.\//, '');
  return /^(?:node_modules|dist|build|target|coverage|vendor|\.next|\.git)(?:\/|$)/i.test(normalized);
}

function projectListing(listing: string): string {
  return listing.split(/\r?\n/).filter((entry) => entry.trim() && !isIgnoredWorkspacePath(entry)).join('\n');
}

function hasTestFile(listing: string): boolean {
  return listing.split(/\r?\n/).some((entry) => /(?:__tests__|(?:^|[./_-])[^/\n]+\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[./_-])test_[^/\n]+)/i.test(entry.trim()));
}

function hasAny(listing: string, names: string[]): boolean {
  return names.some((name) => listing.includes(name));
}

function commandForScript(manager: PackageManager, script: string): string {
  if (manager === 'bun') return `bun run ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  if (manager === 'yarn') return `yarn ${script}`;
  return `npm run ${script}`;
}

export function buildVerificationPlan(profile: Omit<WorkspaceProfile, 'verification'>): VerificationSpec[] {
  const specs: VerificationSpec[] = [];
  const addScript = (id: string, label: string, script: string, reason: string, required: boolean): void => {
    if (!profile.scripts[script]) return;
    specs.push({ id, label, command: commandForScript(profile.packageManager, script), required, reason });
  };

  if (profile.projectType === 'rust') {
    specs.push({ id: 'typecheck', label: '类型/编译检查', command: 'cargo check', required: true, reason: 'Rust 项目必须先通过编译检查。' });
    specs.push({ id: 'test', label: '自动化测试', command: 'cargo test', required: true, reason: 'Rust 项目必须有真实测试结果。' });
    specs.push({ id: 'build', label: '项目构建', command: 'cargo build', required: true, reason: 'Rust 项目必须能构建。' });
    return specs;
  }

  if (profile.projectType === 'python') {
    specs.push({ id: 'test', label: '自动化测试', command: 'pytest', required: profile.testFilesFound, reason: 'Python 项目使用 pytest 验证行为。' });
    addScript('typecheck', '类型检查', 'typecheck', '项目声明了类型检查脚本。', true);
    addScript('lint', '代码规范检查', 'lint', '项目声明了 lint 脚本。', true);
    addScript('build', '项目构建', 'build', '项目声明了构建脚本。', true);
    return specs;
  }

  addScript('typecheck', '类型检查', 'typecheck', '项目声明了类型检查脚本。', true);
  addScript('lint', '代码规范检查', 'lint', '项目声明了 lint 脚本。', true);
  if (profile.scripts.test) {
    specs.push({
      id: 'test',
      label: '自动化测试',
      command: commandForScript(profile.packageManager, 'test'),
      required: profile.testFilesFound,
      reason: profile.testFilesFound ? '项目存在测试入口和测试文件。' : '项目声明了测试脚本，但没有发现可识别的测试文件。',
    });
  }
  addScript('build', '项目构建', 'build', '项目声明了生产构建脚本。', true);
  return specs;
}

export async function discoverWorkspace(tools: ToolAdapter, signal?: AbortSignal): Promise<WorkspaceProfile> {
  const listingResult = await execute(tools, 'list_files', { path: '.', recursive: true }, signal);
  const rawListing = resultString(listingResult).slice(0, 40_000);
  const listing = projectListing(rawListing);
  const manifests = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt', 'go.mod']
    .filter((name) => listing.split(/\r?\n/).some((entry) => entry.trim() === name || entry.trim().endsWith(`/${name}`)));
  const packageJson = manifests.includes('package.json') ? resultString(await execute(tools, 'read_file', { path: 'package.json' }, signal)) : '';
  const scripts = parseScripts(packageJson);
  const projectType: WorkspaceProjectType = manifests.includes('Cargo.toml')
    ? 'rust'
    : manifests.includes('pyproject.toml') || manifests.includes('requirements.txt')
      ? 'python'
      : manifests.includes('go.mod')
        ? 'go'
        : manifests.includes('bun.lock') || manifests.includes('bun.lockb')
          ? 'bun'
          : manifests.includes('package.json')
            ? 'node'
            : 'unknown';
  const packageManager: PackageManager = projectType === 'rust'
    ? 'cargo'
    : projectType === 'python'
      ? 'pip'
      : manifests.includes('bun.lock') || manifests.includes('bun.lockb')
        ? 'bun'
        : manifests.includes('pnpm-lock.yaml')
          ? 'pnpm'
          : manifests.includes('yarn.lock')
            ? 'yarn'
            : manifests.includes('package.json')
              ? 'npm'
              : 'unknown';
  const profile: Omit<WorkspaceProfile, 'verification'> = {
    projectType,
    packageManager,
    manifests,
    scripts,
    testFilesFound: hasTestFile(listing),
    gitRepository: hasAny(rawListing, ['.git']),
    relevantFiles: manifests.filter((name) => !name.endsWith('.lock') && !name.endsWith('.lockb')),
    explorationComplete: listingResult?.success === true,
  };
  return { ...profile, verification: buildVerificationPlan(profile) };
}

export function classifyDeliveryFailure(output: string, exitCode?: number): DeliveryFailureKind {
  const text = `${output} ${exitCode ?? ''}`;
  if (/(?:command not found|not installed|no such file|missing.*lock|lockfile.*missing)/i.test(text)) return 'tool_unavailable';
  if (/(?:permission denied|operation not permitted|权限不足)/i.test(text)) return 'permission_blocked';
  if (/(?:timeout|timed out|ETIMEDOUT|ECONNRESET|ENETUNREACH|ENOTFOUND|network|registry)/i.test(text)) return 'network_failure';
  if (/(?:type error|ts\d{3,4}|typecheck)/i.test(text)) return 'typecheck_failure';
  if (/(?:lint|eslint|ruff|clippy)/i.test(text)) return 'lint_failure';
  if (/(?:build failed|compile error|compilation failed|编译失败)/i.test(text)) return 'build_failure';
  if (/(?:assert|test failed|tests failed|expected .* received|FAIL)/i.test(text)) return 'test_failure';
  return 'code_error';
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
  switch (status) {
    case 'passed': return '通过';
    case 'failed': return '失败';
    case 'degraded': return '降级完成';
    case 'blocked': return '环境阻断';
    case 'running': return '进行中';
    case 'skipped': return '已跳过';
    case 'not_applicable': return '不适用';
    default: return '待执行';
  }
}

/** True when the workspace has no recognizable project structure — callers use
 * this to present the probe result honestly ("从零搭建") instead of printing
 * unknown/unknown noise for a from-scratch build. */
export function isBareWorkspace(profile: Pick<WorkspaceProfile, 'projectType' | 'manifests' | 'verification'>): boolean {
  return profile.projectType === 'unknown' && profile.manifests.length === 0 && profile.verification.length === 0;
}

export function workspaceProfileSummary(profile: WorkspaceProfile): string {
  const commands = profile.verification.filter((spec) => spec.command).map((spec) => `${spec.label}: ${spec.command}`).join('；');
  const exploration = profile.explorationComplete === false ? '探索不完整' : '探索完成';
  return `项目类型：${profile.projectType}；包管理器：${profile.packageManager}；${exploration}；验证入口：${commands || '未发现标准验证入口'}`;
}

export function buildTaskContract(request: string, profile: WorkspaceProfile): TaskContract {
  const verification = profile.verification;
  const acceptanceCriteria: TaskAcceptanceCriterion[] = verification.map((spec) => ({
    id: spec.id,
    description: `${spec.label}必须有真实结果：${spec.command}`,
    verification: spec.command,
    required: spec.required,
  }));
  if (profile.explorationComplete === false) {
    acceptanceCriteria.unshift({
      id: 'explore',
      description: '项目探索必须完成；当前目录结构或清单不完整时禁止宣称交付。',
      required: true,
    });
  }
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push({
      id: 'evidence',
      description: '必须形成可复现的交付验证证据，不能只依据模型口头确认。',
      required: true,
    });
  }
  return {
    goal: request.trim(),
    scope: profile.relevantFiles.length > 0 ? profile.relevantFiles : ['由探索阶段确认的相关源文件'],
    outOfScope: ['不改变 Git 历史、暂存区或提交状态', '不因验证失败而隐瞒结果或跳过质量门禁'],
    constraints: ['先读取再修改', '每个阶段完成后保留实际验证结果', '工具、权限或网络阻断时标记为阻断，不伪造通过'],
    acceptanceCriteria,
    verification,
  };
}

export function formatTaskContract(contract: TaskContract): string {
  const criteria = contract.acceptanceCriteria
    .map((criterion) => `- ${criterion.id}：${criterion.description}${criterion.verification ? `（验证：${criterion.verification}）` : ''}`)
    .join('\\n');
  const scope = contract.scope.map((item) => `- ${item}`).join('\\n');
  const constraints = contract.constraints.map((item) => `- ${item}`).join('\\n');
  const outOfScope = contract.outOfScope.map((item) => `- ${item}`).join('\\n');
  return `<delivery_contract>\n目标：${contract.goal}\n范围：\n${scope}\n验收标准：\n${criteria}\n约束：\n${constraints}\n不包含：\n${outOfScope}\n</delivery_contract>`;
}
