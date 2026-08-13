import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TokenUsage } from '../shared/types';
import { estimateCostUsd } from '../shared/usage';

export interface CodingTaskFixture {
  id: string;
  category: 'bugfix' | 'feature' | 'refactor';
  difficulty: 'easy' | 'medium';
  prompt: string;
  files: Record<string, string>;
  verification: VerificationCommand[];
}

export interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface VerificationResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  output: { chars: number; hash: string };
}

export interface CodingTaskAgentResult {
  usage?: TokenUsage;
  toolCalls?: number;
  traceId?: string;
}

export type CodingTaskStatus = 'passed' | 'failed' | 'agent_error' | 'fixture_error' | 'control';

export interface CodingTaskResult {
  taskId: string;
  category: CodingTaskFixture['category'];
  difficulty: CodingTaskFixture['difficulty'];
  status: CodingTaskStatus;
  success: boolean;
  passAt1: boolean;
  /** Whether the agent callback was invoked and returned without throwing. */
  agentCompleted?: boolean;
  /** Verification is reported independently from agent success. */
  verificationPassed: boolean;
  score: number;
  durationMs: number;
  verification: VerificationResult[];
  agent?: CodingTaskAgentResult;
  agentError?: { kind: string; chars: number; hash: string };
  workspace?: string;
}

export interface CodingTaskEvaluationMetadata {
  provider?: string;
  model?: string;
  promptVersion?: string;
  gitRevision?: string;
  seed?: string;
  runtime: string;
  platform: string;
}

export interface CodingTaskSuiteReport {
  suiteVersion: string;
  generatedAt: string;
  fixtureHash: string;
  metadata: CodingTaskEvaluationMetadata;
  taskCount: number;
  passAt1: number;
  successRate: number;
  meanScore: number;
  meanDurationMs: number;
  totalUsage?: TokenUsage;
  estimatedCostUsd: number;
  tasks: CodingTaskResult[];
}

export interface CodingTaskEvaluationOptions {
  workspace?: string;
  keepWorkspace?: boolean;
  metadata?: Partial<Omit<CodingTaskEvaluationMetadata, 'runtime' | 'platform'>>;
  agent?: (input: { task: CodingTaskFixture; workspace: string }) => Promise<CodingTaskAgentResult | void>;
}

export const CODING_TASK_SUITE_VERSION = 'pure-coding-baseline-v1';

export const CODING_TASK_FIXTURES: readonly CodingTaskFixture[] = [
  {
    id: 'fix-take-top-off-by-one',
    category: 'bugfix',
    difficulty: 'easy',
    prompt: '修复 src/score.ts 中 takeTop 的边界错误：count=3 必须返回 3 项，count<=0 返回空数组，并确保现有测试通过。',
    files: {
      'src/score.ts': `export function takeTop<T>(items: T[], count: number): T[] {
  return items.slice(0, count - 1);
}
`,
      'src/score.test.ts': `import { describe, expect, it } from 'bun:test';
import { takeTop } from './score';

describe('takeTop', () => {
  it('returns exactly count items', () => {
    expect(takeTop(['a', 'b', 'c', 'd'], 3)).toEqual(['a', 'b', 'c']);
  });
  it('handles zero and negative counts', () => {
    expect(takeTop(['a'], 0)).toEqual([]);
    expect(takeTop(['a'], -1)).toEqual([]);
  });
});
`,
    },
    verification: [{ name: 'bun test', command: 'bun', args: ['test', 'src/score.test.ts'] }],
  },
  {
    id: 'add-normalize-slug',
    category: 'feature',
    difficulty: 'easy',
    prompt: '为 src/slug.ts 实现 normalizeSlug：去除首尾空白，转小写，把连续非字母数字字符压成一个连字符，并去除首尾连字符；补充测试并确保通过。',
    files: {
      'src/slug.ts': `export function normalizeSlug(input: string): string {
  return input;
}
`,
      'src/slug.test.ts': `import { describe, expect, it } from 'bun:test';
import { normalizeSlug } from './slug';

describe('normalizeSlug', () => {
  it('normalizes words and punctuation', () => {
    expect(normalizeSlug('  Hello,   Agent World!  ')).toBe('hello-agent-world');
  });
  it('does not leave separators at the edges', () => {
    expect(normalizeSlug('---A__B---')).toBe('a-b');
    expect(normalizeSlug('  ')).toBe('');
  });
});
`,
    },
    verification: [{ name: 'bun test', command: 'bun', args: ['test', 'src/slug.test.ts'] }],
  },
  {
    id: 'refactor-parse-port',
    category: 'refactor',
    difficulty: 'medium',
    prompt: '重构 src/port.ts 的 parsePort：只接受 1 到 65535 的十进制整数；非法输入返回 undefined；不要让小数、空字符串、十六进制或越界值通过，并确保测试通过。',
    files: {
      'src/port.ts': `export function parsePort(input: string): number | undefined {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
`,
      'src/port.test.ts': `import { describe, expect, it } from 'bun:test';
import { parsePort } from './port';

describe('parsePort', () => {
  it('accepts only decimal integer ports in range', () => {
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });
  it('rejects malformed and out-of-range values', () => {
    for (const value of ['', '  ', '3.14', '0x10', '65536', '-1', 'abc']) {
      expect(parsePort(value)).toBeUndefined();
    }
  });
});
`,
    },
    verification: [{ name: 'bun test', command: 'bun', args: ['test', 'src/port.test.ts'] }],
  },
];

async function runVerification(command: VerificationCommand, workspace: string): Promise<VerificationResult> {
  const started = Date.now();
  try {
    const proc = Bun.spawn([command.command, ...command.args], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = command.timeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    const output = `${stdout}${stderr ? `\n${stderr}` : ''}`;
    return {
      name: command.name,
      passed: !timedOut && proc.exitCode === 0,
      exitCode: timedOut ? null : proc.exitCode,
      durationMs: Date.now() - started,
      output: { chars: output.length, hash: hashText(output) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: command.name,
      passed: false,
      exitCode: null,
      durationMs: Date.now() - started,
      output: { chars: message.length, hash: hashText(message) },
    };
  }
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function prepareWorkspace(task: CodingTaskFixture, requested?: string): Promise<{ workspace: string; temporary: boolean }> {
  const base = requested ? resolve(requested) : '/tmp';
  await mkdir(base, { recursive: true });  const workspace = await mkdtemp(join(base, 'pure-eval-'));
  try {
    for (const [relativePath, content] of Object.entries(task.files)) {
      if (relativePath.startsWith('/') || relativePath.split(/[\\\\/]/).includes('..')) {
        throw new Error(`Fixture path escapes evaluation workspace: ${relativePath}`);
      }
      const target = join(workspace, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { workspace, temporary: true };
}

function observationHash(text: string): string {
  return hashText(text);
}

function observeAgentError(error: unknown): { kind: string; chars: number; hash: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const kind = /timeout|abort/.test(lower)
    ? 'timeout'
    : /permission|denied|unauthorized/.test(lower)
      ? 'permission'
      : 'agent_error';
  return { kind, chars: message.length, hash: observationHash(message) };
}

export async function evaluateCodingTask(
  task: CodingTaskFixture,
  options: CodingTaskEvaluationOptions = {},
): Promise<CodingTaskResult> {
  const started = Date.now();
  let prepared: { workspace: string; temporary: boolean };
  try {
    prepared = await prepareWorkspace(task, options.workspace);
  } catch (error) {
    const agentError = observeAgentError(error);
    return {
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      status: 'fixture_error',
      success: false,
      passAt1: false,
      verificationPassed: false,
      score: 0,
      durationMs: Date.now() - started,
      verification: [],
      agentError,
    };
  }
  let agent: CodingTaskAgentResult | undefined;
  let agentError: CodingTaskResult['agentError'];
  const agentInvoked = options.agent !== undefined;
  try {
    if (options.agent) {
      try {
        const agentResult = await options.agent({ task, workspace: prepared.workspace });
        if (agentResult !== undefined) agent = agentResult;
      } catch (error) {
        agentError = observeAgentError(error);
      }
    }
    const verification: VerificationResult[] = [];
    for (const command of task.verification) {
      verification.push(await runVerification(command, prepared.workspace));
      if (!verification.at(-1)?.passed) break;
    }
    const verificationPassed = verification.length === task.verification.length && verification.every((item) => item.passed);
    const agentCompleted = agentInvoked && !agentError;
    const success = agentCompleted && verificationPassed;
    const status: CodingTaskStatus = !agentInvoked
      ? 'control'
      : agentError
        ? 'agent_error'
        : verificationPassed
          ? 'passed'
          : 'failed';
    return {
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      status,
      success,
      passAt1: success,
      agentCompleted: agentInvoked ? agentCompleted : undefined,
      verificationPassed,
      score: success ? 1 : 0,
      durationMs: Date.now() - started,
      verification,
      agent,
      agentError,
      workspace: options.keepWorkspace ? prepared.workspace : undefined,
    };
  } finally {
    if (prepared.temporary && !options.keepWorkspace) {
      await rm(prepared.workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function evaluateCodingTaskSuite(
  tasks: readonly CodingTaskFixture[] = CODING_TASK_FIXTURES,
  options: CodingTaskEvaluationOptions = {},
): Promise<CodingTaskSuiteReport> {
  const results: CodingTaskResult[] = [];
  for (const task of tasks) results.push(await evaluateCodingTask(task, options));
  const totalUsage = results.reduce<TokenUsage | undefined>((sum, result) => mergeUsage(sum, result.agent?.usage), undefined);
  const passAt1 = results.filter((result) => result.passAt1).length;
  const fixtureHash = hashText(JSON.stringify(tasks));
  return {
    suiteVersion: CODING_TASK_SUITE_VERSION,
    generatedAt: new Date().toISOString(),
    fixtureHash,
    metadata: {
      ...options.metadata,
      runtime: `bun/${Bun.version}`,
      platform: process.platform,
    },
    taskCount: results.length,
    passAt1,
    successRate: results.length > 0 ? passAt1 / results.length : 0,
    meanScore: results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0,
    meanDurationMs: results.length > 0 ? results.reduce((sum, result) => sum + result.durationMs, 0) / results.length : 0,
    totalUsage,
    estimatedCostUsd: estimateCostUsd(totalUsage, options.metadata?.provider ?? 'deepseek-openai'),
    tasks: results,
  };
}

function mergeUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
    cacheHitTokens: (a.cacheHitTokens ?? 0) + (b.cacheHitTokens ?? 0),
    cacheMissTokens: (a.cacheMissTokens ?? 0) + (b.cacheMissTokens ?? 0),
  };
}

export async function writeEvaluationReport(path: string, report: CodingTaskSuiteReport): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporaryPath = `${resolve(path)}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, resolve(path));
}
