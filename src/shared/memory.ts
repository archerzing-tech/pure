// src/shared/memory.ts
// v0.6 — self-evolving memory engine.
// Learns user preferences from conversation patterns and injects them into the system prompt.

export interface UserProfile {
  languages: Record<string, number>;     // language → mention count
  frameworks: Record<string, number>;    // framework → mention count
  tools: Record<string, number>;         // tool → mention count
  style: Record<string, string>;         // style key → value (e.g. indent: tabs)
  updatedAt: number;
}

const EMPTY_PROFILE: UserProfile = {
  languages: {},
  frameworks: {},
  tools: {},
  style: {},
  updatedAt: 0,
};

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

// ── Engine ──

export class MemoryEngine {
  private profile: UserProfile;

  constructor(initial?: UserProfile) {
    this.profile = initial ? { ...EMPTY_PROFILE, ...initial } : { ...EMPTY_PROFILE };
  }

  /** Learn from a user message — scan for language/framework/tool mentions. */
  learnFromMessage(text: string): void {
    if (!text || text.length < 3) return;

    this.matchPatterns(text, LANGUAGE_PATTERNS, this.profile.languages);
    this.matchPatterns(text, FRAMEWORK_PATTERNS, this.profile.frameworks);
    this.matchPatterns(text, TOOL_PATTERNS, this.profile.tools);
    this.detectStyle(text);
  }

  /** Build the memory context string to inject into the system prompt. */
  buildMemoryPrompt(): string {
    const parts: string[] = [];

    const topLanguages = this.topEntries(this.profile.languages, 3);
    if (topLanguages.length > 0) {
      parts.push(`User's preferred languages: ${topLanguages.join(', ')}.`);
    }

    const topFrameworks = this.topEntries(this.profile.frameworks, 3);
    if (topFrameworks.length > 0) {
      parts.push(`Frequently used frameworks: ${topFrameworks.join(', ')}.`);
    }

    const topTools = this.topEntries(this.profile.tools, 3);
    if (topTools.length > 0) {
      parts.push(`Preferred tools: ${topTools.join(', ')}.`);
    }

    if (Object.keys(this.profile.style).length > 0) {
      const styleParts = Object.entries(this.profile.style).map(([k, v]) => `${k}: ${v}`);
      parts.push(`Code style preferences: ${styleParts.join(', ')}.`);
    }

    if (parts.length === 0) return '';
    return `\n## User Profile (learned from previous conversations)\n${parts.join('\n')}\n\nUse these preferences when writing code for the user.`;
  }

  /** Return the current profile for persistence. */
  getProfile(): UserProfile {
    return JSON.parse(JSON.stringify(this.profile));
  }

  /** Replace the entire profile (e.g. on load from storage). */
  setProfile(p: UserProfile): void {
    this.profile = { ...EMPTY_PROFILE, ...p };
    this.profile.updatedAt = Date.now();
  }

  // ── Helpers ──

  private matchPatterns(text: string, patterns: Array<[RegExp, string]>, target: Record<string, number>): void {
    for (const [regex, label] of patterns) {
      if (regex.test(text)) {
        target[label] = (target[label] || 0) + 1;
      }
    }
  }

  private detectStyle(text: string): void {
    if (/\bno\s*semicolons?\b/i.test(text) || /\bwithout\s*semicolons?\b/i.test(text)) {
      this.profile.style['semicolons'] = 'no';
    } else if (/\bwith\s*semicolons?\b/i.test(text) || /\buse\s*semicolons?\b/i.test(text)) {
      this.profile.style['semicolons'] = 'yes';
    }
    if (/\bsingle\s*quotes?\b/i.test(text)) this.profile.style['quotes'] = 'single';
    if (/\bdouble\s*quotes?\b/i.test(text)) this.profile.style['quotes'] = 'double';
    if (/\btabs\b(?!\s*and\s*spaces)/i.test(text)) this.profile.style['indent'] = 'tabs';
    if (/\bspaces\b(?!\s*and\s*tabs)/i.test(text)) this.profile.style['indent'] = 'spaces';
    if (/\bfunctional\b(?!\s*component)/i.test(text)) this.profile.style['paradigm'] = 'functional';
    if (/\boop\b|object\s*oriented/i.test(text)) this.profile.style['paradigm'] = 'OOP';
  }

  private topEntries(map: Record<string, number>, limit: number): string[] {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k);
  }
}

// ── Storage helpers ──

const MEMORY_KEY = 'pure_memory';

/** Load profile from localStorage (browser) or return null. */
export function loadMemoryProfile(): UserProfile | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(MEMORY_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return null;
}

/** Save profile to localStorage (browser). */
export function saveMemoryProfile(profile: UserProfile): void {
  try {
    if (typeof localStorage !== 'undefined') {
      profile.updatedAt = Date.now();
      localStorage.setItem(MEMORY_KEY, JSON.stringify(profile));
    }
  } catch {}
}
