// src/shared/memory.ts
// v0.10 — preference harvester for the cross-session memory system.
// Replaces the old regex MemoryEngine (single global UserProfile persisted to
// localStorage / ~/.pure/memory.json). The regex patterns still learn, but the
// output is now typed `user_preference` MemoryEntry[] that the CLI/GUI write
// into their IMemoryStore (FSMemoryStore / LocalStorageMemoryStore), which the
// Harness retrieves at session start via PromptComposer.

// Shared Kernel is the bottom layer — import the canonical type from
// shared/types.ts directly, never from an adapter module (which only re-exports
// it). See 三层依赖关系总结.md for the dependency direction.
import type { MemoryEntry } from './types';

// ── Pattern matchers ──

const LANGUAGE_PATTERNS: Array<[RegExp, string]> = [
  [/\btypescript\b/i, 'TypeScript'],
  [/\bjavascript\b/i, 'JavaScript'],
  [/\bpython\b(?!\s*(script|\.js))/i, 'Python'],
  [/\brust\b/i, 'Rust'],
  [/\bgolang\b|\bgo\s*lang\b/i, 'Go'],
  [/\bjava\b(?!\s*script)/i, 'Java'],
  [/\bc\#|csharp\b/i, 'C#'],
  [/\bc\+\+\b/i, 'C++'],
  [/\bswift\b/i, 'Swift'],
  [/\bkotlin\b/i, 'Kotlin'],
  [/\bzig\b/i, 'Zig'],
  [/\belixir\b/i, 'Elixir'],
];

const FRAMEWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\breact\b(?!\s*native)/i, 'React'],
  [/\bvue\b/i, 'Vue'],
  [/\bnext\.?js\b/i, 'Next.js'],
  [/\bnuxt\b/i, 'Nuxt'],
  [/\bsvelte\b/i, 'Svelte'],
  [/\bangular\b/i, 'Angular'],
  [/\bexpress\b/i, 'Express'],
  [/\bfastapi\b/i, 'FastAPI'],
  [/\bdjango\b/i, 'Django'],
  [/\bflask\b/i, 'Flask'],
  [/\bspring\b/i, 'Spring'],
  [/\btauri\b/i, 'Tauri'],
  [/\belectron\b/i, 'Electron'],
  [/\btailwind\b/i, 'Tailwind'],
];

const TOOL_PATTERNS: Array<[RegExp, string]> = [
  [/\bpnpm\b/i, 'pnpm'],
  [/\bnpm\b/i, 'npm'],
  [/\byarn\b/i, 'yarn'],
  [/\bbun\b/i, 'Bun'],
  [/\bgit\b/i, 'git'],
  [/\bdocker\b/i, 'Docker'],
  [/\bkubernetes\b|\bk8s\b/i, 'Kubernetes'],
  [/\bvite\b/i, 'Vite'],
  [/\bwebpack\b/i, 'Webpack'],
  [/\besbuild\b/i, 'esbuild'],
  [/\bprisma\b/i, 'Prisma'],
  [/\bdrizzle\b/i, 'Drizzle'],
  [/\bpostgres\b|\bpsql\b/i, 'PostgreSQL'],
  [/\bsqlite\b/i, 'SQLite'],
  [/\bredis\b/i, 'Redis'],
  [/\bwasm\b/i, 'WASM'],
];

// ── Harvester ──

export interface HarvestContext {
  sessionId: string;
  projectPath: string;
}

/**
 * Scan a user message for language / framework / tool / style preferences and
 * return them as `user_preference` MemoryEntry fragments (no `id` — the store
 * assigns it). Empty when nothing was learned.
 */
export function harvestUserPreferences(
  text: string,
  ctx: HarvestContext,
): Array<Omit<MemoryEntry, 'id'>> {
  if (!text || text.length < 3) return [];

  const entries: Array<Omit<MemoryEntry, 'id'>> = [];
  const seen = new Set<string>();
  const push = (content: string) => {
    if (seen.has(content)) return;
    seen.add(content);
    entries.push({
      type: 'user_preference',
      content,
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
    });
  };

  for (const [regex, label] of LANGUAGE_PATTERNS) {
    if (regex.test(text)) push(`User prefers the ${label} language`);
  }
  for (const [regex, label] of FRAMEWORK_PATTERNS) {
    if (regex.test(text)) push(`User frequently uses the ${label} framework`);
  }
  for (const [regex, label] of TOOL_PATTERNS) {
    if (regex.test(text)) push(`User prefers the ${label} tool`);
  }
  pushStyle(text, push);

  return entries;
}

function pushStyle(text: string, push: (content: string) => void): void {
  if (/\bno\s*semicolons?\b/i.test(text) || /\bwithout\s*semicolons?\b/i.test(text)) {
    push('User prefers code without semicolons');
  } else if (/\bwith\s*semicolons?\b/i.test(text) || /\buse\s*semicolons?\b/i.test(text)) {
    push('User prefers semicolons in code');
  }
  if (/\bsingle\s*quotes?\b/i.test(text)) push('User prefers single quotes');
  if (/\bdouble\s*quotes?\b/i.test(text)) push('User prefers double quotes');
  if (/\btabs\b(?!\s*and\s*spaces)/i.test(text)) push('User prefers tabs for indentation');
  if (/\bspaces\b(?!\s*and\s*tabs)/i.test(text)) push('User prefers spaces for indentation');
  if (/\bfunctional\b(?!\s*component)/i.test(text)) push('User prefers functional programming style');
  if (/\boop\b|object\s*oriented/i.test(text)) push('User prefers object-oriented programming style');
}
