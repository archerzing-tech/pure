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
  // 1.5 hard tier — both defects fixed (limit and slot release), not just the
  // one the prompt leads with.
  'hard-bugfix-task-queue-leak': async (workspace) => {
    await writeFile(join(workspace, 'src/task-queue.ts'), `// A tiny concurrency-limited queue used by the ingest pipeline.
export class TaskQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: number) {
    if (concurrency < 1) throw new Error('concurrency must be at least 1');
  }

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }
}
`, 'utf8');
  },
  // Break the order <-> pricing cycle by moving the shared pieces (the Line
  // type and the tax table) into their own modules.
  'hard-refactor-break-cycle': async (workspace) => {
    await writeFile(join(workspace, 'src/orders/types.ts'), `export interface Line {
  sku: string;
  qty: number;
}
`, 'utf8');
    await writeFile(join(workspace, 'src/orders/tax.ts'), `export const REGION_TAX: Record<string, number> = { eu: 0.2, us: 0.07 };

export function taxRateFor(region: string): number {
  return REGION_TAX[region] ?? 0;
}
`, 'utf8');
    await writeFile(join(workspace, 'src/orders/pricing.ts'), `import type { Line } from './types';

const UNIT_PRICE: Record<string, number> = { apple: 2, pear: 3 };

export function priceOf(line: Line): number {
  const unit = UNIT_PRICE[line.sku];
  if (unit === undefined) throw new Error('unknown sku: ' + line.sku);
  return unit * line.qty;
}

export { taxRateFor } from './tax';
`, 'utf8');
    await writeFile(join(workspace, 'src/orders/order.ts'), `import { priceOf } from './pricing';
import { REGION_TAX, taxRateFor } from './tax';
import type { Line } from './types';

export type { Line } from './types';
export { REGION_TAX };

export function orderTotal(lines: Line[], region: string): number {
  const tax = taxRateFor(region);
  if (REGION_TAX[region] === undefined) throw new Error('unknown region: ' + region);
  const net = lines.reduce((sum, line) => sum + priceOf(line), 0);
  return net * (1 + tax);
}
`, 'utf8');
  },
  // Read the real input instead of serving the previous run from disk.
  'hard-recovery-stale-cache': async (workspace) => {
    await writeFile(join(workspace, 'scripts/build.ts'), `import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { totalsOf } from '../src/derive';

const snapshot = JSON.parse(await readFile('data/input.json', 'utf8'));
const totals = totalsOf(snapshot);
await mkdir('dist', { recursive: true });
await writeFile('dist/out.json', JSON.stringify(totals, null, 2) + '\\n', 'utf8');
console.log('wrote dist/out.json');
`, 'utf8');
  },
  // Implement the documented options-object API, migrate every call site, and
  // retire the legacy export the checker scans for.
  'hard-multi-step-api-migration': async (workspace) => {
    await writeFile(join(workspace, 'src/api.ts'), `import { deliver } from './transport';

export interface SendOptions {
  payload: string;
  retries?: number;
}

export interface SendResult {
  ok: boolean;
  attempts: number;
}

export async function sendMessage(options: SendOptions): Promise<SendResult> {
  if (!options.payload) throw new Error('payload is required');
  const maxAttempts = Math.max(1, options.retries ?? 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deliver(options.payload);
      return { ok: true, attempts: attempt };
    } catch {
      if (attempt === maxAttempts) return { ok: false, attempts: attempt };
    }
  }
  return { ok: false, attempts: maxAttempts };
}
`, 'utf8');
    await writeFile(join(workspace, 'src/notify.ts'), `import { sendMessage, type SendResult } from './api';

export async function notifyUser(text: string): Promise<SendResult> {
  return sendMessage({ payload: text, retries: 2 });
}
`, 'utf8');
    await writeFile(join(workspace, 'src/report.ts'), `import { sendMessage, type SendResult } from './api';

export async function emailReport(body: string): Promise<SendResult> {
  return sendMessage({ payload: body, retries: 1 });
}
`, 'utf8');
    await writeFile(join(workspace, 'src/digest.ts'), `import { sendMessage, type SendResult } from './api';

export const pushDigest = (body: string): Promise<SendResult> => sendMessage({ payload: body, retries: 3 });
`, 'utf8');
  },
  // 1.6 repo-scale — the one wrong file out of 45: nearest-rank instead of
  // truncation (equal only when n*p lands exactly on a rank, which is exactly
  // the case the 20-sample series hits).
  'extreme-repo-scale-metrics-report': async (workspace) => {
    await writeFile(join(workspace, 'src/aggregate/percentile.ts'), `import { assertNonEmpty } from '../util/guard';
import { sortAscending } from '../util/sort';

/** nearest-rank 百分位（口径见 docs/metrics.md）。 */
export function percentile(values: readonly number[], p: number): number {
  assertNonEmpty(values, 'percentile');
  if (!(p > 0 && p <= 1)) throw new Error('percentile: p must be in (0, 1]');
  const sorted = sortAscending(values);
  const rank = Math.ceil(sorted.length * p);
  return sorted[rank - 1]!;
}
`, 'utf8');
  },
  // 1.6 resource ceiling — bucket by normalized message, then a single sorted
  // sweep per bucket turns the pairwise window test into an adjacent check.
  // Same output, near-linear cost.
  'extreme-perf-dedupe-scaling': async (workspace) => {
    await writeFile(join(workspace, 'src/dedupe.ts'), `import { normalizeMessage } from './normalize';
import type { DuplicateGroup, LogRecord } from './types';

/** 两条记录时间戳相差不超过这个值就算同一时段。 */
export const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 把每一批记录里互为重复的记录聚成组（规则见 docs/dedupe.md）。
 *
 * 先按规范化消息分桶，再把每个桶按时间排序做一次相邻扫描：同一个桶里的重复
 * 关系是窗口上的链，链上传递等价于相邻两点在窗口内，于是两两判定就可以去掉。
 */
export function findDuplicateGroups(records: readonly LogRecord[]): DuplicateGroup[] {
  const parent = records.map((_, index) => index);

  function find(index: number): number {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // 始终让较小的下标当代表，组的代表就是批里最早的那条记录。
    if (rootA < rootB) parent[rootB] = rootA;
    else parent[rootA] = rootB;
  }

  const buckets = new Map<string, number[]>();
  for (let index = 0; index < records.length; index += 1) {
    const key = normalizeMessage(records[index]!.message);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }

  for (const indexes of buckets.values()) {
    if (indexes.length < 2) continue;
    indexes.sort((a, b) => records[a]!.at - records[b]!.at);
    for (let k = 1; k < indexes.length; k += 1) {
      const current = indexes[k]!;
      const previous = indexes[k - 1]!;
      if (records[current]!.at - records[previous]!.at <= DUPLICATE_WINDOW_MS) union(current, previous);
    }
  }

  const members = new Map<number, number[]>();
  for (let index = 0; index < records.length; index += 1) {
    const root = find(index);
    const bucket = members.get(root);
    if (bucket) bucket.push(index);
    else members.set(root, [index]);
  }

  return [...members.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([root, indexes]) => ({
      key: normalizeMessage(records[root]!.message),
      ids: indexes.map((index) => records[index]!.id),
    }));
}
`, 'utf8');
  },
};
