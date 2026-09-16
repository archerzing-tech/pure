import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CODING_TASK_FIXTURES,
  evaluateCodingTask,
  evaluateCodingTaskSuite,
  writeEvaluationReport,
  type CodingTaskFixture,
} from './codingTaskBaseline';

const fixture: CodingTaskFixture = {
  id: 'writes-answer',
  category: 'feature',
  difficulty: 'easy',
  prompt: 'Create answer.txt.',
  files: { 'README.txt': 'seed' },
  verification: [{
    name: 'answer exists',
    command: 'bun',
    args: ['-e', "if (!(await Bun.file('answer.txt').exists())) process.exit(1)"],
    timeoutMs: 10_000,
  }],
};

// Known-correct solutions for the built-in fixtures, applied straight to the
// seeded workspace without an LLM. This is the other half of fixture sanity:
// the control run proves every fixture FAILS from its seed; the golden run
// proves every fixture is SOLVABLE and that its check scripts accept a correct
// answer, so seeded data and expected strings cannot drift apart.
async function runBun(args: string[], workspace: string): Promise<void> {
  const proc = Bun.spawn(['bun', ...args], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`bun ${args.join(' ')} exited with ${exitCode}`);
}

const GOLDEN_SOLUTIONS: Record<string, (workspace: string) => Promise<void>> = {
  'fix-take-top-off-by-one': async (workspace) => {
    await writeFile(join(workspace, 'src/score.ts'), `export function takeTop<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  return items.slice(0, count);
}
`, 'utf8');
  },
  'add-normalize-slug': async (workspace) => {
    await writeFile(join(workspace, 'src/slug.ts'), `export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
`, 'utf8');
  },
  'refactor-parse-port': async (workspace) => {
    await writeFile(join(workspace, 'src/port.ts'), `export function parsePort(input: string): number | undefined {
  if (!/^\\d+$/.test(input)) return undefined;
  const value = Number(input);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}
`, 'utf8');
  },
  'multi-step-stats-report': async (workspace) => {
    await writeFile(join(workspace, 'src/stats.ts'), `export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
`, 'utf8');
    await writeFile(join(workspace, 'src/report.ts'), `import { mean, median } from './stats';

export interface Sample {
  name: string;
  score: number;
}

export function buildReport(samples: Sample[]): string[] {
  const lines = [...samples]
    .sort((a, b) => b.score - a.score)
    .map((sample) => sample.name + '=' + sample.score);
  const scores = samples.map((sample) => sample.score);
  lines.push('mean=' + mean(scores) + ',median=' + median(scores));
  return lines;
}
`, 'utf8');
    await runBun(['scripts/generate.ts'], workspace);
  },
  'multi-step-consolidate-duration': async (workspace) => {
    await writeFile(join(workspace, 'src/legacy-format.ts'), `// The canonical implementation lives in duration.ts; this module now
// re-exports it so existing call sites keep working with one behavior.
export { formatDuration } from './duration';
`, 'utf8');
    await writeFile(join(workspace, 'docs/format.md'), `# Duration format

formatDuration(seconds) renders human-readable durations.

Example: 125 seconds -> "2m 5s"
`, 'utf8');
  },
  'recovery-broken-build-script': async (workspace) => {
    await writeFile(join(workspace, 'scripts/build.ts'), `import { pack } from '../src/pack';
import { mkdir, writeFile } from 'node:fs/promises';
import rows from '../data/rows.json';

const output = pack(rows);
await mkdir('dist', { recursive: true });
await writeFile('dist/out.csv', output, 'utf8');
console.log('wrote ' + rows.length + ' rows to dist/out.csv');
`, 'utf8');
    await runBun(['scripts/build.ts'], workspace);
  },
  'guardrail-protected-config': async (workspace) => {
    await writeFile(join(workspace, 'src/config.ts'), `export const DEFAULT_TIMEOUT_MS = 5000;
`, 'utf8');
  },
  'long-context-q3-report': async (workspace) => {
    const regions = ['north', 'south', 'east', 'west'];
    const lines = ['# Q3 汇总（基线 v7）'];
    let total = 0;
    for (const region of regions) {
      const relativePath = `data/q3-${region}.csv`;
      const text = await readFile(join(workspace, relativePath), 'utf8');
      const sum = text
        .trim()
        .split('\n')
        .slice(1)
        .reduce((sum, line) => sum + Number(line.split(',')[2]), 0);
      total += sum;
      lines.push(`${relativePath}=${sum}`);
    }
    lines.splice(1, 0, `total=${total}`);
    await mkdir(join(workspace, 'dist'), { recursive: true });
    await writeFile(join(workspace, 'dist/q3-report.md'), lines.join('\n') + '\n', 'utf8');
  },
};

describe('coding task baseline', () => {
  it('keeps control verification separate from agent success', async () => {
    const result = await evaluateCodingTask(fixture);
    expect(result.status).toBe('control');
    expect(result.success).toBe(false);
    expect(result.passAt1).toBe(false);
    expect(result.verificationPassed).toBe(false);
  });

  // Fixture sanity: every built-in task must FAIL its verification from the
  // seeded state alone. A fixture whose control run passes cannot measure
  // anything — it would report 1/1 for a no-op agent.
  it('control run fails every built-in fixture', async () => {
    const report = await evaluateCodingTaskSuite();
    expect(report.taskCount).toBe(CODING_TASK_FIXTURES.length);
    for (const task of report.tasks) {
      expect(task.status).toBe('control');
      expect(task.verificationPassed).toBe(false);
      expect(task.verification[0]?.passed).toBe(false);
    }
  });

  // Fixture sanity, the solvable half: a known-correct solution applied
  // without an LLM must pass every verification command. When this fails the
  // fixture is broken, not the agent — fix the fixture or do not ship it.
  describe('golden solutions pass every built-in fixture', () => {
    for (const task of CODING_TASK_FIXTURES) {
      it(task.id, async () => {
        const solve = GOLDEN_SOLUTIONS[task.id];
        if (!solve) throw new Error('missing golden solution for ' + task.id);
        const result = await evaluateCodingTask(task, {
          agent: async ({ workspace }) => {
            await solve(workspace);
            return undefined;
          },
        });
        expect(result.status).toBe('passed');
        expect(result.agentCompleted).toBe(true);
        expect(result.verificationPassed).toBe(true);
      });
    }
  });

  it('passes only when the agent completes and verification passes', async () => {
    const result = await evaluateCodingTask(fixture, {
      agent: async ({ workspace }) => {
        await writeFile(join(workspace, 'answer.txt'), 'ok', 'utf8');
        return undefined;
      },
    });
    expect(result.status).toBe('passed');
    expect(result.agentCompleted).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.passAt1).toBe(true);
  });

  it('records agent errors without exposing their message', async () => {
    const result = await evaluateCodingTask(fixture, {
      agent: async () => {
        throw new Error('Authorization: Bearer secret-token');
      },
    });
    expect(result.status).toBe('agent_error');
    expect(result.success).toBe(false);
    expect(result.agentError?.kind).toBe('agent_error');
    expect(result.agentError?.hash).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('includes fixture and runtime metadata in suite reports', async () => {
    const report = await evaluateCodingTaskSuite([fixture], {
      metadata: { provider: 'mock', model: 'fixture-agent', promptVersion: 'prompt_test', seed: '1' },
    });
    expect(report.taskCount).toBe(1);
    expect(report.fixtureHash).toMatch(/^[0-9a-f]{8}$/);
    expect(report.metadata.provider).toBe('mock');
    expect(report.metadata.model).toBe('fixture-agent');
    expect(report.metadata.runtime).toContain('bun/');
    expect(report.metadata.platform).toBe(process.platform);
    expect(report.tasks[0].status).toBe('control');
  });

  it('writes a complete report atomically', async () => {
    const directory = await mkdtemp('/tmp/pure-eval-test-');
    try {
      const path = join(directory, 'report.json');
      const report = await evaluateCodingTaskSuite([fixture]);
      await writeEvaluationReport(path, report);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.suiteVersion).toBe(report.suiteVersion);
      expect(parsed.fixtureHash).toBe(report.fixtureHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
