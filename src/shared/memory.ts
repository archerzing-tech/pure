// src/shared/memory.ts
// v0.11 — explicit-instruction channel for the cross-session memory system.
// Superseded the old regex MemoryEngine and then its own mention-inference
// phase: pattern tables that turned a bare mention ("I want a React app using
// pnpm") into a permanent "User frequently uses the pnpm framework" entry were
// retired (decision-boundary 2026-11 A6 — mentioning is not preferring; that
// semantic call belongs to the model, and a one-off task description must not
// harden into a cross-project prompt line). What remains honors ONLY an
// explicit user instruction, as typed `tool_preference` MemoryEntry[] that the
// CLI/GUI write into their IMemoryStore (FSMemoryStore / LocalStorageMemoryStore),
// which the Harness retrieves at session start via PromptComposer.

// Shared Kernel is the bottom layer — import the canonical type from
// shared/types.ts directly, never from an adapter module (which only re-exports
// it). See 三层依赖关系总结.md for the dependency direction.
import type { MemoryEntry } from './types';
import { GLOBAL_MEMORY_SCOPE } from './types';

// ── Explicit "remember this tool" patterns ──
// "记住用 pnpm" / "remember uv" / "pnpm 比 npm 快" — the user explicitly asks
// to persist a tool preference, which the cross-session memory should honor
// regardless of the fixed pattern lists above (the user may name any tool,
// not just the ones in TOOL_PATTERNS). These become `tool_preference` entries
// WITHOUT a platform (a user-stated preference holds on any platform; only
// agent-verified tool usage is platform-bound) and in the MACHINE-GLOBAL
// scope (GLOBAL_MEMORY_SCOPE): "在这台机器上用 uv" holds in every project.
const REMEMBER_TOOL_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string | undefined]> = [
  [/记住\s*(?:用|使用)?\s*([a-z][a-z0-9._-]{1,40})/i, (m) => m[1]],
  [/\bremember\s+(?:using\s+)?([a-z][a-z0-9._-]{1,40})/i, (m) => m[1]],
  [/\b([a-z][a-z0-9._-]{1,40})\s+比\s+([a-z][a-z0-9._-]{1,40})\s+(?:快|好|强|省时)/i, (m) => m[1]],
  [/用\s+([a-z][a-z0-9._-]{1,40})\s+(?:更好|更快|更合适|更省)/i, (m) => m[1]],
];

// ── Harvester ──

export interface HarvestContext {
  sessionId: string;
  projectPath: string;
}

/**
 * Scan a user message for an EXPLICIT tool-preference instruction ("记住用
 * pnpm" / "remember uv" / "pnpm 比 npm 快") and return it as a
 * `tool_preference` MemoryEntry fragment (no `id` — the store assigns it).
 * Empty when nothing was learned. Bare mentions are deliberately ignored:
 * inferring a preference from a mention was the model's judgment call to make.
 */
export function harvestUserPreferences(
  text: string,
  ctx: HarvestContext,
): Array<Omit<MemoryEntry, 'id'>> {
  if (!text || text.length < 3) return [];

  const entries: Array<Omit<MemoryEntry, 'id'>> = [];
  const seen = new Set<string>();
  const pushTool = (tool: string) => {
    const content = `User wants to use the ${tool} tool`;
    if (seen.has(content)) return;
    seen.add(content);
    entries.push({
      type: 'tool_preference',
      content,
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      // 工具偏好是机器级知识（"这台机器上用 uv"在任何项目都成立）—— 存到
      // 全局作用域，常驻注入时跨项目可见（agent 验证的工具偏好同样如此，
      // 见 Harness.writeSessionMemory）。
      projectPath: GLOBAL_MEMORY_SCOPE,
    });
  };
  for (const [regex, extract] of REMEMBER_TOOL_PATTERNS) {
    const m = text.match(regex);
    const tool = m ? extract(m) : undefined;
    if (tool) pushTool(tool);
  }

  return entries;
}
