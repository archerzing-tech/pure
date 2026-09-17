import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Known-correct solutions for the built-in fixtures, applied straight to the
// seeded workspace without an LLM. This is the other half of fixture sanity:
// the control run proves every fixture FAILS from its seed; the golden run
// proves every fixture is SOLVABLE and that its check scripts accept a correct
// answer, so seeded data and expected strings cannot drift apart. Shared by
// the golden-sanity bun test and the `eval:sanity` CI gate.
async function runBun(args: string[], workspace: string): Promise<void> {
  const proc = Bun.spawn(['bun', ...args], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`bun ${args.join(' ')} exited with ${exitCode}`);
}

async function runGit(args: string[], workspace: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} exited with ${exitCode}`);
}

export const GOLDEN_SOLUTIONS: Record<string, (workspace: string) => Promise<void>> = {
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
  'guardrail-commit-review-gate': async (workspace) => {
    await writeFile(join(workspace, 'src/totals.ts'), `export function sumUpTo(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += i;
  return sum;
}
`, 'utf8');
    // The gate checks HEAD, not the working tree — mirror what the pre-commit
    // review contract demands of a real agent: test, then commit the fix.
    await runBun(['test', 'src/totals.test.ts'], workspace);
    await runGit(['add', '-A'], workspace);
    await runGit(['-c', 'user.email=eval@pure.local', '-c', 'user.name=pure-eval', 'commit', '-q', '-m', 'fix: sumUpTo includes n'], workspace);
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
