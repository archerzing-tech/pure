// src/ui/delegableRoles.ts
// The delegable role surface, in one place.
//
// Why this module exists: `~/.pure/subagents/` roles are registered and
// delegable, but every observation slice used to read a hardcoded set of eight
// built-ins (`KNOWN_SUBAGENT_ROLES`). A generated role's delegations therefore
// landed nowhere — not in the advice cards, not in the team roster, not in the
// cost view — and 13.2's trial-period verdict ("delegate it 5–10 times, then
// judge it on outcomes") had nothing to read. The fix is to let the host say
// what it actually registered; the single scan that knows that lives here, so
// the chat session and the settings dashboard cannot drift into two truths.
//
// Deleting a manifest makes the role disappear on the next scan, exactly like
// the rest of the 13.2 half — this module adds no lifecycle of its own.

import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { loadConfig } from './config';
import { compileExternalSubagents } from '../harness/externalSubagents';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES } from '../coding-agent/SubagentOrchestrator';
import { BUILT_IN_TOOLS } from '../coding-agent/ToolRegistry';
import type { SubagentDefinition } from '../coding-agent/types';

/** The eight built-ins, in registration order. */
export function builtinRoleNames(): string[] {
  return [...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((def) => def.name);
}

/**
 * Built-in tool names, which a generated ROLE must never be allowed to take.
 *
 * The manifest name rule (`/^[a-z][a-z0-9_]{1,63}$/`) happily accepts
 * `execute_command`, and the compiler's `reserved` list only covers the eight
 * role names — so a manifest called `execute_command.json` is accepted, and
 * once this module's surface reached the observation slices, every shell call in
 * the session would show up as a "role delegation": a roster row, an advice
 * card, a cost line. Dropped here as well as at compile time, because the
 * dashboard has to survive a role directory that predates either guard.
 */
const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILT_IN_TOOLS.map((tool) => tool.name.toLowerCase()));

let subagentsPromise: Promise<SubagentDefinition[]> | null = null;

/**
 * Scan `~/.pure/subagents/` once per app run and return the full definitions
 * (the chat session registers these; the dashboard needs only the names).
 *
 * Cached deliberately: the set of delegable roles is fixed for the run, and a
 * fresh scan per call would mean the dashboard could disagree with the session
 * it is describing. A role added mid-session shows up at the next app start —
 * the same rule the tool loader already follows.
 */
export function loadExternalSubagents(): Promise<SubagentDefinition[]> {
  subagentsPromise ??= (async () => {
    // 总开关关着 = 生成物一律不加载（设计 §13 边界表原文：「所有生成物不加载、
    // 建议卡不再出」）。这一 guard 不是可选项：观测记录在总开关关闭时照写
    // （PromptObservability 的 enabled 与 skills.evolution 无关），所以一旦这里
    // 放行，一个 100% 失败的生成角色就会在开关关着时照样出建议卡。
    if (!isTauriRuntime()) return [];
    try {
      if (loadConfig()?.skills?.evolution === false) return [];
    } catch {
      // 配置读不出来时按开启处理（与 loadGuiExternalTools 同口径）。
    }
    try {
      const sources = await tauriInvoke<Array<{ file: string; text: string }>>('list_external_subagents');
      // Reserved covers the built-in ROLES **and** the built-in TOOLS: a role
      // named `execute_command` is accepted by the manifest name rule, and once
      // this surface reached the observation slices every shell call in the
      // session would render as a "role delegation". Rejecting at compile time
      // means the user is told, rather than silently measured wrong.
      const reserved = [...builtinRoleNames(), ...BUILT_IN_TOOL_NAMES];
      const { defs, errors } = compileExternalSubagents(sources ?? [], reserved);
      for (const line of errors) console.warn(`[external-subagents] ${line}`);
      // Belt and braces for a manifest directory that predates this guard.
      return defs.filter((def) => !BUILT_IN_TOOL_NAMES.has(def.name.toLowerCase()));
    } catch (error) {
      console.warn('[external-subagents] scan failed:', error);
      return [];
    }
  })();
  return subagentsPromise;
}

/**
 * Every role name the host can delegate to, generated ones included. Pass this
 * to the observation slices; omitting it falls back to the built-in eight.
 */
export async function loadDelegableRoleNames(): Promise<string[]> {
  const external = await loadExternalSubagents();
  return [...builtinRoleNames(), ...external.map((def) => def.name)];
}