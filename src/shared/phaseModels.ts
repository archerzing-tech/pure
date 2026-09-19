// src/shared/phaseModels.ts
// 9.2 — per-phase model routing (experimental). A declarative config that
// names a model per engine phase (THINK / HANDOVER / REFLECT); phases without
// a usable override fall back to the main model through the E0.3 `llmFor`
// contract (llmForPhase in CodingAgent / cliHarness). Pure logic, shared by
// the GUI (chat.ts builds same-provider adapters) and the CLI (cliHarness
// rebuilds through createAdapter) so both ends normalize identically.
import type { EngineLlmPhase } from './types';

/** Phase → model id on the SAME provider as the main config. Cross-provider
 * phase routing stays possible programmatically (llmFor takes any adapter)
 * but the settings surface deliberately keeps to one key/endpoint per turn. */
export interface PhaseModelConfig {
  think?: string;
  handover?: string;
  reflect?: string;
}

/** Normalized phase → model map, only entries that actually reroute. */
export type PhaseModelOverrides = Partial<Record<EngineLlmPhase, string>>;

const PHASE_FIELDS: ReadonlyArray<{ phase: EngineLlmPhase; field: keyof PhaseModelConfig }> = [
  { phase: 'THINK', field: 'think' },
  { phase: 'HANDOVER', field: 'handover' },
  { phase: 'REFLECT', field: 'reflect' },
];

/** Drop blank values and values equal to the main model — an override naming
 * the main model would build a second adapter with identical behavior, so it
 * must fall through to `llm` instead (fewer adapters, same wire behavior). */
export function phaseModelOverrides(
  cfg: PhaseModelConfig | undefined,
  mainModel: string,
): PhaseModelOverrides {
  const out: PhaseModelOverrides = {};
  if (!cfg) return out;
  for (const { phase, field } of PHASE_FIELDS) {
    const model = cfg[field]?.trim();
    if (model && model !== mainModel) out[phase] = model;
  }
  return out;
}

/** Merge persisted config with CLI flags — flags win per field (`--think-model`
 * over `~/.pure/config.json` phaseModels.think), matching the provider/model
 * precedence (`--flag > env > config > defaults`). Empty flag strings don't
 * erase persisted values: a flag is either a real model id or absent. */
export function mergePhaseModelConfig(
  base: PhaseModelConfig | undefined,
  flags: Partial<PhaseModelConfig>,
): PhaseModelConfig | undefined {
  const merged: PhaseModelConfig = { ...base };
  for (const key of ['think', 'handover', 'reflect'] as const) {
    const value = flags[key]?.trim();
    if (value) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Keep well-formed string fields of untrusted stored config; anything else
 * (wrong types, empty objects) disables routing instead of breaking load. */
export function sanitizePhaseModelConfig(raw: unknown): PhaseModelConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: PhaseModelConfig = {};
  for (const key of ['think', 'handover', 'reflect'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
