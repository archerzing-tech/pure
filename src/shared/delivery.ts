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
  /** Actual manifest paths found in the listing (may be nested, e.g.
   * `my-app/package.json`) — used to locate the project directory the
   * delivery gate should audit and verify inside. */
  manifestPaths?: string[];
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
  const local = new AbortController();
  let onOuterAbort: (() => void) | undefined;
  try {
    return await new Promise<ToolResult | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        local.abort();
        if (onOuterAbort) signal?.removeEventListener('abort', onOuterAbort);
      };
      const finish = (value: ToolResult | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      onOuterAbort = (): void => finish(null);
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      timer = setTimeout(() => finish(null), DISCOVERY_TOOL_TIMEOUT_MS);
      tools.execute(call(toolName, args), local.signal).then(finish, () => finish(null));
    });
  } catch {
    return null;
  } finally {
    if (onOuterAbort) signal?.removeEventListener('abort', onOuterAbort);
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
  const manifestNames = ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt', 'go.mod'];
  const listingLines = listing.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const manifestPaths = listingLines.filter((entry) => manifestNames.includes(entry.split('/').pop() ?? ''));
  const manifests = manifestNames.filter((name) => manifestPaths.some((entry) => entry === name || entry.endsWith(`/${name}`)));
  // The manifest may live at the workspace root OR inside a generated project
  // subdirectory (e.g. `my-app/package.json`). Read scripts from wherever the
  // manifest actually is so a nested project gets a real verification plan.
  const hasManifest = (name: string): boolean => manifests.some((entry) => entry === name || entry.endsWith(`/${name}`));
  const packageJsonPath = manifestPaths.find((entry) => entry === 'package.json' || entry.endsWith('/package.json'));
  const packageJson = packageJsonPath ? resultString(await execute(tools, 'read_file', { path: packageJsonPath }, signal)) : '';
  const scripts = parseScripts(packageJson);
  const projectType: WorkspaceProjectType = hasManifest('Cargo.toml')
    ? 'rust'
    : hasManifest('pyproject.toml') || hasManifest('requirements.txt')
      ? 'python'
      : hasManifest('go.mod')
        ? 'go'
        : hasManifest('bun.lock') || hasManifest('bun.lockb')
          ? 'bun'
          : hasManifest('package.json')
            ? 'node'
            : 'unknown';
  const packageManager: PackageManager = projectType === 'rust'
    ? 'cargo'
    : projectType === 'python'
      ? 'pip'
      : hasManifest('bun.lock') || hasManifest('bun.lockb')
        ? 'bun'
        : hasManifest('pnpm-lock.yaml')
          ? 'pnpm'
          : hasManifest('yarn.lock')
            ? 'yarn'
            : hasManifest('package.json')
              ? 'npm'
              : 'unknown';
  const profile: Omit<WorkspaceProfile, 'verification'> = {
    projectType,
    packageManager,
    manifests,
    manifestPaths,
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
  const missingTestInfrastructure = profile.projectType !== 'unknown'
    && (!profile.scripts.test || !profile.testFilesFound);
  if (missingTestInfrastructure) {
    acceptanceCriteria.unshift({
      id: 'test-infrastructure',
      description: '必须先补齐项目测试基础设施：选择合适的测试 runner，加入可执行的 test script，并创建至少一个覆盖主流程的 smoke/focused 测试文件；完成后实际运行测试。',
      required: true,
    });
  }
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
    .join('\n');
  const scope = contract.scope.map((item) => `- ${item}`).join('\n');
  const constraints = contract.constraints.map((item) => `- ${item}`).join('\n');
  const outOfScope = contract.outOfScope.map((item) => `- ${item}`).join('\n');
  return `<delivery_contract>\n目标：${contract.goal}\n范围：\n${scope}\n验收标准：\n${criteria}\n约束：\n${constraints}\n不包含：\n${outOfScope}\n</delivery_contract>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Delivery verification pipeline (agent-driven loop + deterministic backstop)
// ═══════════════════════════════════════════════════════════════════════════════
// Replaces the old post-hoc "交付前测试与审计" gate (LLM VERDICT parsing +
// separate audit runner), which was brittle and slow. The model now runs the
// pipeline ITSELF as the final plan stage (Claude-Code-style verification
// loop), and the GUI re-runs only the mechanical checks at turn end as a
// deterministic stop-gate with a bounded auto-fix loop.

/** Design-phase marker the model emits when a UI design mockup is ready for
 * user review. The GUI scans assistant output for this line, renders the
 * mockup in a preview card, and pauses implementation until the user
 * confirms. */
export const DESIGN_READY_MARKER = '## 设计稿已就绪：';

/** Extract the design mockup file name from a DESIGN_READY_MARKER line in the
 * assistant output (e.g. `## 设计稿已就绪：design.html` → `design.html`).
 * Returns null when the marker is absent or names no file. */
export function parseDesignReadyMarker(text: string): string | null {
  const match = text.match(/##\s*设计稿已就绪：[^\S\n]*([^\s\n]+)/);
  return match ? match[1] : null;
}

/** True when the request looks like a UI-building task that should go through
 * the design-first phase (design mockup → user confirmation → implement). */
export function detectUiDesignRequest(prompt: string): boolean {
  return /(?:网页|网站|站点|页面|界面|前端|落地页|官网|首页|后台|管理端|控制台|仪表盘|大屏|可视化|dashboard|landing|web\s*app|web\s*site|website|网页应用|html|css|ui|ux|界面设计|交互设计|视觉|样式|海报|海报页|小程序|h5)/i.test(prompt)
    && !/(?:修复|修一下|bug|报错|重构(?!.*界面)|重构成|优化性能|性能优化)/i.test(prompt);
}

/**
 * Build the delivery-pipeline prompt injected into the user turn for project
 * build tasks. The pipeline IS the final plan stage: the model reviews its own
 * code, then runs typecheck → unit tests → e2e/build checks with the exact
 * commands discovered from the workspace, fixing root causes and re-running
 * until everything passes. Evidence (command + real result) is mandatory.
 */
export function formatDeliveryPipeline(profile: WorkspaceProfile | undefined, needsDesignPhase = false): string {
  const commands = profile && profile.verification.length > 0
    ? profile.verification.map((spec) => `- ${spec.label}：\`${spec.command}\`${spec.required ? '' : '（可选）'}`).join('\n')
    : '- 先探明项目的验证入口（package.json scripts / Cargo.toml / pyproject.toml），没有标准入口时先补齐测试基础设施再验证。';
  const designSection = needsDesignPhase
    ? `\n设计先行（必须遵守）：这是有界面的工程，写任何实现代码之前，先创建一个自包含的静态设计稿 design.html（内联 CSS，不依赖构建工具，展示布局、配色、字体和关键界面/组件的实际视觉效果），然后单独输出一行控制标记「${DESIGN_READY_MARKER}design.html」并立即停止，等待用户在预览卡中确认。用户确认前禁止开始实现；用户提出调整意见时先修改设计稿再重新等确认。确认后严格按照 design.html 的设计实现。`
    : '';
  return `<delivery_pipeline>
交付验证管线（项目交付的唯一完成标准，按顺序执行）：
1. 代码检视：实现完成后，用 git_diff / 重读改动文件的方式审查自己的代码——正确性、边界条件、与需求的一致性；发现的问题当场修复。
2. Typecheck：运行项目声明的类型/编译检查。
3. 单元测试：运行项目的自动化测试；没有测试基础设施时先补齐再运行。
4. 端到端验证：运行构建/启动/端到端检查，确认产物真实可用。

本工作区发现的验证命令（必须真实执行，不得跳过或虚构结果）：
${commands}

规则：
- 任何一步失败：定位根因并修复，然后从失败的那一步重新执行——循环直到全部通过，禁止带着失败的检查宣布完成。
- 每一步在回复中给出真实证据（执行的命令 + 关键结果摘要），禁止只说"已通过"。
- 把交付验证管线作为计划的最后一个阶段执行（阶段名：交付验证），四个步骤用子步骤标记逐步推进。
- 工具、权限或网络原因导致某步无法执行时，如实标记为受阻并说明原因，不得伪造通过。${designSection}
</delivery_pipeline>`;
}

// ── Deterministic delivery verification (end-of-turn backstop) ──

/** Heuristic: does this shell command look like a verification step
 * (typecheck / test / build / lint)? Used to recognize the model's own
 * verification commands in the live tool stream. */
export function isVerificationCommand(command: string): boolean {
  return /(?:npm run (?:typecheck|test|build|lint|check|verify)|npm test|bun (?:test|run (?:typecheck|test|build|lint|check))|pnpm (?:test|run (?:typecheck|test|build|lint|check))|tsc(?: --noEmit)?|cargo (?:test|build|check|clippy)|pytest|python -m pytest|vitest|jest|go test|make (?:test|check)|flutter test|flutter analyze)/i.test(command);
}

export interface DeliveryStepResult {
  id: string;
  label: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  durationMs: number;
  output: string;
  failureKind?: DeliveryFailureKind;
}

export interface DeliveryVerificationResult {
  passed: boolean;
  steps: DeliveryStepResult[];
}

const DELIVERY_STEP_TIMEOUT_MS = 180_000;
const DELIVERY_OUTPUT_MAX_CHARS = 6_000;

function deliveryCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `delivery_${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    index: 0,
    function: { name: toolName, arguments: JSON.stringify(args) },
  };
}

/**
 * Run the workspace's mechanical verification specs (typecheck → lint → test →
 * build) one by one and collect real evidence for each. This is the
 * deterministic stop-gate behind the agent-driven pipeline: it never parses
 * model claims, only command results. A missing verification plan or a
 * bare/static workspace counts as not_applicable → passed (nothing mechanical
 * to verify), matching the honest "no standard entry" reporting upstream.
 */
/** Run one verification spec exactly once, resolving null on timeout/abort. */
async function runDeliveryStepOnce(
  tools: ToolAdapter,
  spec: VerificationSpec,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  try {
    return await new Promise<ToolResult | null>((resolve) => {
      let settled = false;
      const local = new AbortController();
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), spec.timeoutMs ?? DELIVERY_STEP_TIMEOUT_MS);
      const finish = (value: ToolResult | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        local.abort();
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      tools.execute(deliveryCall('execute_command', { command: spec.command }), local.signal).then(finish, () => finish(null));
    });
  } catch {
    return null;
  }
}

/** Retry a transiently-failed verification step once so a command that died on
 * a network/registry/tool-channel blip is re-run instead of killing the whole
 * delivery pipeline. Deterministic failures (real compile/test errors) are
 * never retried — the exit code and output are the evidence. */
async function runDeliveryStep(
  tools: ToolAdapter,
  spec: VerificationSpec,
  signal?: AbortSignal,
): Promise<{ result: ToolResult | null; retried: boolean }> {
  const first = await runDeliveryStepOnce(tools, spec, signal);
  if (signal?.aborted || first === null || first.success === true) return { result: first, retried: false };
  const output = String(first.error ?? first.result ?? '');
  const kind = classifyDeliveryFailure(output, 1);
  const transient = kind === 'timeout' || kind === 'network_failure' || kind === 'tool_unavailable';
  if (!transient) return { result: first, retried: false };
  const again = await runDeliveryStepOnce(tools, spec, signal);
  return { result: again, retried: true };
}

export async function runDeliveryVerification(
  tools: ToolAdapter,
  profile: WorkspaceProfile | undefined,
  signal?: AbortSignal,
  onStep?: (step: DeliveryStepResult) => void,
): Promise<DeliveryVerificationResult> {
  if (!profile || profile.verification.length === 0) {
    return { passed: true, steps: [] };
  }
  const steps: DeliveryStepResult[] = [];
  for (const spec of profile.verification) {
    if (signal?.aborted) break;
    const start = Date.now();
    const { result, retried } = await runDeliveryStep(tools, spec, signal);
    const durationMs = Date.now() - start;
    const output = (typeof result?.result === 'string' ? result.result : result?.error ?? '').slice(0, DELIVERY_OUTPUT_MAX_CHARS);
    const timedOut = result === null && !signal?.aborted;
    const environmentBlocked = !timedOut && result !== null
      && classifyDeliveryFailure(output, result.success ? 0 : 1) === 'tool_unavailable';
    const step: DeliveryStepResult = result === null || result.success !== true
      ? {
        id: spec.id,
        label: spec.label,
        command: spec.command,
        status: (signal?.aborted || (environmentBlocked && !spec.required)) ? 'skipped' : 'failed',
        exitCode: result ? -1 : undefined,
        durationMs,
        output: timedOut
          ? `命令超时（>${Math.round((spec.timeoutMs ?? DELIVERY_STEP_TIMEOUT_MS) / 1000)}s）${retried ? '，已自动重试一次' : ''}`
          : output,
        failureKind: timedOut ? 'timeout' : result ? classifyDeliveryFailure(output, 1) : 'tool_unavailable',
      }
      : {
        id: spec.id,
        label: spec.label,
        command: spec.command,
        status: 'passed',
        exitCode: 0,
        durationMs,
        output,
      };
    steps.push(step);
    onStep?.(step);
    if (step.status === 'failed' && spec.required) break;
  }
  return { passed: steps.every((s) => s.status !== 'failed'), steps };
}

/** Compact human-readable summary of a backstop run for status bubbles. */
export function deliveryVerificationSummary(result: DeliveryVerificationResult): string {
  if (result.steps.length === 0) return '本工作区没有标准机械验证入口（静态页面或空工作区）';
  return result.steps
    .map((s) => `${s.status === 'passed' ? '✅' : s.status === 'skipped' ? '⏭️' : '❌'} ${s.label}（${s.command}）`)
    .join('；');
}

/** Build the fix-round prompt sent back to the model when the deterministic
 * backstop fails. Carries the REAL failing output so the model fixes root
 * causes instead of guessing. */
export function formatDeliveryFixPrompt(result: DeliveryVerificationResult): string {
  const failures = result.steps.filter((s) => s.status === 'failed');
  const lines = failures.map((s) => `### ${s.label} 失败（${s.command}）\n\`\`\`\n${s.output || '(无输出)'}\n\`\`\``).join('\n\n');
  return `交付验证未通过，以下是真实失败输出：\n\n${lines}\n\n请修复根因（不要掩盖或跳过失败），然后重新运行失败的检查以及它之后的所有检查，直到交付验证管线全部通过。`;
}
