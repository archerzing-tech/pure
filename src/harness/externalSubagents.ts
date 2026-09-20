// src/harness/externalSubagents.ts
// 阶段 13.2 (loading half) — external subagent roles as declarative JSON.
//
// 北极星原则一 (multi-agent-self-evolving-architecture.md): evolution
// artifacts are versioned manifest FILES that enter through exactly ONE
// existing register seam. This module is that seam's compiler: it turns
// `~/.pure/subagents/*.json` manifests into SubagentDefinitions the hosts
// (GUI CodingAgent / CLI harness) merge alongside BUILT_IN_SUBAGENTS before
// registration. It knows nothing about filesystems — hosts gather the
// `{ file, text }` sources with whatever IO they already have (Tauri invoke
// vs node:fs), so Bun tests cover the whole pipeline without mocking IO.

import { Tags } from '../coding-agent/ToolRegistry';
import type { SubagentDefinition } from '../coding-agent/types';
import type { ToolDefinition } from '../shared/types';

/** The on-disk manifest. `version` exists so a future format change can be
 * detected instead of silently misparsed (原则一: versioned manifest). */
export interface ExternalSubagentManifest {
  /** Manifest format. 1 is the only understood value today. */
  version?: number;
  /** Tool/delegation name. Must match the built-ins' kebab/underscore style —
   * it becomes a function-call name the LLM emits. */
  name: string;
  description: string;
  /** System prompt TEMPLATE. `{identifier}` tokens are replaced with the
   * String() of the same-named tool-call input property, when provided.
   * Anything that isn't an input property — including JSON examples' braces —
   * passes through untouched. */
  systemPrompt: string;
  /** JSON-schema for the delegation tool call. Defaults to a single required
   * `prompt` string, which matches how the built-ins are actually invoked. */
  input_schema?: ToolDefinition['input_schema'];
  /** Registry tags. Only known Tags values are honored; 'agent' is always
   * forced (these ARE subagents). Declaring 'write' is meaningful: it routes
   * the delegation into the serialized writes pool. */
  tags?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  /** Delegation wall-clock ceiling → SubagentDefinition.defaultTimeoutMs. */
  timeoutMs?: number;
}

const MANIFEST_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 1_800_000; // matches the built-ins (30 min)
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;

const KNOWN_TAGS = new Set<string>(Object.values(Tags));

const DEFAULT_INPUT_SCHEMA: ToolDefinition['input_schema'] = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The task for this agent' },
  },
  required: ['prompt'],
};

export interface ExternalSubagentSource {
  /** File name (not full path) — used to attribute errors. */
  file: string;
  text: string;
}

export interface ExternalSubagentsResult {
  defs: SubagentDefinition[];
  /** One human-readable line per rejected file (bad JSON, bad fields, name
   * conflicts). Hosts surface these (console/stderr) instead of failing the
   * whole directory: one broken file must not take down the others. */
  errors: string[];
}

/** Compile manifest JSON texts into registrable SubagentDefinitions.
 * `reservedNames` are the built-ins' names: an external file claiming one is
 * skipped with an error, never overriding core roles. Two external files with
 * the same name: the first (sorted by source order) wins, the duplicate is
 * reported. */
export function compileExternalSubagents(
  sources: ExternalSubagentSource[],
  reservedNames: Iterable<string>,
): ExternalSubagentsResult {
  const reserved = new Set(reservedNames);
  const defs: SubagentDefinition[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    let manifest: ExternalSubagentManifest;
    try {
      manifest = JSON.parse(source.text) as ExternalSubagentManifest;
    } catch (error) {
      errors.push(`${source.file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const problem = validateManifest(manifest);
    if (problem) {
      errors.push(`${source.file}: ${problem}`);
      continue;
    }
    if (reserved.has(manifest.name)) {
      errors.push(`${source.file}: name "${manifest.name}" collides with a built-in role — skipped (built-ins cannot be overridden)`);
      continue;
    }
    if (defs.some((d) => d.name === manifest.name)) {
      errors.push(`${source.file}: duplicate external role "${manifest.name}" — the earlier file wins`);
      continue;
    }
    defs.push(compileManifest(manifest));
  }
  return { defs, errors };
}

function validateManifest(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) return 'manifest must be a JSON object';
  const m = manifest as ExternalSubagentManifest;
  if (m.version !== undefined && m.version !== MANIFEST_VERSION) {
    return `unsupported manifest version ${String(m.version)} (this build understands version ${MANIFEST_VERSION})`;
  }
  if (typeof m.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(m.name)) {
    return `name must match [a-z][a-z0-9_]{1,63} (got ${JSON.stringify(m.name)})`;
  }
  if (typeof m.description !== 'string' || m.description.trim().length < 8) {
    return 'description is required (≥8 chars) — the parent LLM delegates based on it';
  }
  if (typeof m.systemPrompt !== 'string' || m.systemPrompt.trim().length < 8) {
    return 'systemPrompt is required (≥8 chars)';
  }
  if (m.input_schema !== undefined && (typeof m.input_schema !== 'object' || m.input_schema === null)) {
    return 'input_schema must be a JSON schema object';
  }
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((tag) => typeof tag !== 'string'))) {
    return 'tags must be an array of strings';
  }
  if (m.riskLevel !== undefined && m.riskLevel !== 'low' && m.riskLevel !== 'medium' && m.riskLevel !== 'high') {
    return "riskLevel must be 'low' | 'medium' | 'high'";
  }
  if (m.timeoutMs !== undefined && (typeof m.timeoutMs !== 'number' || !Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0)) {
    return 'timeoutMs must be a positive number (milliseconds)';
  }
  return null;
}

function compileManifest(manifest: ExternalSubagentManifest): SubagentDefinition {
  return {
    name: manifest.name,
    description: manifest.description,
    input_schema: manifest.input_schema ?? DEFAULT_INPUT_SCHEMA,
    tags: normalizeTags(manifest.tags),
    riskLevel: manifest.riskLevel ?? 'low',
    defaultTimeoutMs: clampTimeout(manifest.timeoutMs),
    createSystemPrompt: (input: Record<string, unknown>) => substituteTemplate(manifest.systemPrompt, input),
  };
}

/** `{identifier}` tokens whose identifier was actually provided in the tool
 * call input are replaced with String(value). Unprovided keys and braces that
 * aren't identifier-shaped (JSON examples, code snippets) pass through. */
function substituteTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (token, key: string) => {
    if (!(key in input)) return token;
    const value = input[key];
    if (value === undefined || value === null) return token;
    // Structured values (arrays/objects) render as JSON so the model can read
    // them back.
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function normalizeTags(tags: string[] | undefined): string[] {
  // Default = read-only (parallel-safe, the common research/design case);
  // a manifest that declares 'write' opts into the serialized writes pool.
  if (!tags) return [Tags.AGENT, Tags.READ];
  const clean = tags.filter((tag) => KNOWN_TAGS.has(tag) && tag !== Tags.AGENT);
  return [Tags.AGENT, ...clean];
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
}
