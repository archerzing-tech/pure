// scripts/check-conventions.ts
// Zero-dependency ratchet for the code-convention patterns this project has no
// linter to enforce. The review that introduced this script found the same
// classes of drift accumulating project-wide (untyped catch bindings, non-null
// assertions on DOM lookups, a literal `null!`), so instead of adding a full
// ESLint/Biome dependency and a wall of new errors, the counts are frozen at
// today's numbers: the check fails only when a count GROWS.
//
// Raise a baseline deliberately (--write-baseline) or, better, lower it by
// fixing the offending lines. Rules already at zero (TODO markers, type-check
// suppressions, stray `debugger`) must stay at zero.
//
// Usage: bun run scripts/check-conventions.ts [--write-baseline]

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

interface Rule {
  id: string;
  why: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'untyped-catch-binding',
    why: '`catch (err: any)` discards type safety under strict mode; bind `unknown` and narrow.',
    pattern: /\bcatch\s*\(\s*[A-Za-z_$][\w$]*\s*:\s*any\s*\)/,
  },
  {
    id: 'dom-non-null-assertion',
    why: 'Asserting a DOM lookup is non-null turns an HTML rename into a runtime TypeError; guard it.',
    pattern: /getElementById\([^)]*\)!|querySelector(?:All)?<[^>]*>\([^)]*\)!(?!=)|querySelector\([^)]*\)!\./,
  },
  {
    id: 'literal-non-null-assertion',
    why: '`null!` / `undefined!` asserts away a literal no-op; of no informative value.',
    pattern: /\b(?:null|undefined)!(?!=)/,
  },
  {
    id: 'unfinished-marker',
    why: 'Unfinished markers must not ship; file an issue or finish the work.',
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/,
  },
  {
    id: 'typecheck-suppression',
    why: 'Suppressing the type checker hides the defect instead of fixing it.',
    pattern: /@ts-(?:ignore|expect-error|nocheck)|eslint-disable/,
  },
  {
    id: 'stray-debugger',
    why: 'A leftover `debugger` statement halts execution for users with devtools open.',
    pattern: /^\s*debugger\b/,
  },
];

const ROOT = join(import.meta.dirname, '..');
const SOURCE_ROOT = join(ROOT, 'src');
const BASELINE_PATH = join(import.meta.dirname, 'conventions-baseline.json');

/** Production sources only: tests legitimately need `any` for DOM doubles. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

const hitsByRule = new Map<string, Hit[]>();
for (const rule of RULES) hitsByRule.set(rule.id, []);

for (const file of sourceFiles(SOURCE_ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        hitsByRule.get(rule.id)!.push({ file: relative(ROOT, file).split(sep).join('/'), line: index + 1, text: line.trim() });
      }
    }
  }
}

const counts: Record<string, number> = {};
for (const rule of RULES) counts[rule.id] = hitsByRule.get(rule.id)!.length;

if (process.argv.includes('--write-baseline')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`Wrote ${relative(ROOT, BASELINE_PATH)}:`, counts);
  process.exit(0);
}

let baseline: Record<string, number> = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
} catch {
  console.error(`Missing/unreadable ${relative(ROOT, BASELINE_PATH)} — run: bun run scripts/check-conventions.ts --write-baseline`);
  process.exit(2);
}

let failures = 0;
let improvements = 0;
for (const rule of RULES) {
  const allowed = baseline[rule.id] ?? 0;
  const count = counts[rule.id]!;
  if (count > allowed) {
    failures++;
    console.error(`\n✗ ${rule.id}: ${count} (baseline ${allowed}) — ${rule.why}`);
    for (const hit of hitsByRule.get(rule.id)!) console.error(`    ${hit.file}:${hit.line}  ${hit.text}`);
  } else if (count < allowed) {
    improvements++;
    console.log(`↓ ${rule.id}: ${count} (baseline ${allowed}) — lower the baseline to lock the win in`);
  } else {
    console.log(`✓ ${rule.id}: ${count}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} convention rule(s) regressed. Fix the lines above (adding a new one to the baseline is a deliberate act: --write-baseline).`);
  process.exit(1);
}
console.log(improvements > 0 ? `\nConventions OK (${improvements} rule(s) improved).` : '\nConventions OK.');
