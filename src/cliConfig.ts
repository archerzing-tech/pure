// src/cliConfig.ts
// CLI configuration layer — split out of src/cli.ts (audit ①). Everything about
// the CLI's persisted config: file paths (~/.pure), PureConfig read/write, the
// CliArgs invocation shape, provider / API-key resolution, memory-evolution
// overrides, and the budget + permission defaults. Leaf module — the adapter /
// harness / run-loop modules all import from here, so nothing above it may be
// imported back (keeps the module graph acyclic).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { red } from './termcolors';
import { customProviderFor, defaultModelFor } from './shared/providers';
import type { CustomProvider, ProviderOverride } from './shared/providers';
import type { MCPServerConfig } from './adapter/mcp/MCPTransport';
import type { EvolutionConfig } from './adapter/memory/evolution';
import type { BudgetConfig } from './shared/types';

// ── CLI persistence paths (file-based, since Bun doesn't have localStorage) ──

// Windows has no HOME env var (USERPROFILE instead) and no /tmp; os.homedir()
// resolves the platform home directory on every OS.
export const HOME = process.env.HOME || os.homedir();
export const PURE_DIR = `${HOME}/.pure`;
export const CONFIG_PATH = `${PURE_DIR}/config.json`;

// Persisted provider credentials. Mirror of the GUI's PureConfig (src/ui/config.ts),
// but stored on disk so the Node/Bun CLI can read them. The GUI's localStorage
// config is browser-only and cannot be reached from the CLI.
export interface PureConfig {
  provider: string;
  apiKey: string;
  model: string;
  workspace?: string;
  /**
   * User-defined OpenAI-compatible providers (mirror of the GUI's
   * PureConfig.customProviders). Keyless local endpoints (Ollama / LM Studio)
   * send without an Authorization header.
   */
  customProviders?: CustomProvider[];
  /**
   * Per-provider overrides for the built-in providers (mirror of the GUI's
   * PureConfig.providerOverrides): a custom display name, endpoint (proxy /
   * mirror) and per-provider API key. Desktop keys live in the Rust secrets
   * file (~/.pure/secrets.json, slot 'llm.apiKey.<id>'); browser-mode keys
   * sit here as plain `apiKey` entries.
   */
  providerOverrides?: Record<string, ProviderOverride>;
  /**
   * Third-party skills installed via the GUI's Skill Hub (Settings → Skills →
   * Skill Hub). Enabled entries' SKILL.md bodies are injected into the CLI's
   * system prompt so terminal and GUI sessions behave identically.
   */
  hubSkills?: Array<{ name: string; description: string; source: string; body: string; enabled: boolean }>;
  /** MCP servers written by the GUI Settings → MCP page. */
  mcpServers?: MCPServerConfig[];
  /** MCP tool-name prefixes to hide (GUI Settings → MCP). */
  mcpExcludedPrefixes?: string[];
}

export function loadConfig(): PureConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    if (!raw) return null;
    const cfg = JSON.parse(raw) as Partial<PureConfig>;
    // Only the provider is required: keyless custom providers (Ollama / LM
    // Studio) legitimately save with an empty apiKey.
    if (cfg && cfg.provider) return cfg as PureConfig;
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: PureConfig): void {
  try {
    mkdirSync(PURE_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error(`${red('❌')} Failed to write ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

/**
 * Resolve a built-in provider's per-provider API key from the Rust secrets
 * file (~/.pure/secrets.json, slot `llm.apiKey.<id>`) — the same slot the GUI
 * desktop app writes when the user saves a per-provider key, so terminal and
 * GUI sessions share the same credential. Returns '' when absent/unreadable.
 */
export function resolveOverrideSecretKey(provider: string): string {
  try {
    const path = `${PURE_DIR}/secrets.json`;
    if (!existsSync(path)) return '';
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const value = raw[`llm.apiKey.${provider}`];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

// ── Parsed CLI invocation ──
// Lives here (not in cli.ts) because cliAdapter / cliHarness / cliRepl all
// consume the parsed shape and none of them may import cli.ts (acyclic graph).

export interface CliArgs {
  prompt: string;
  /** Built-in id, 'mock', or a user-defined custom provider id (see customProviders). */
  provider: string;
  model: string;
  apiKey: string;
  workspace: string;
  resume: string;
  stateDb: string;
  /** User-defined custom providers from ~/.pure/config.json. */
  customProviders?: CustomProvider[];
  /** Per-provider built-in overrides (name / Base URL / key) from ~/.pure/config.json. */
  providerOverrides?: Record<string, ProviderOverride>;
  /**
   * MCP servers: ~/.pure/config.json `mcpServers` (written by GUI Settings →
   * MCP) plus repeatable `--mcp-server "<name>:<command-or-url>"` flags — e.g.
   * `--mcp-server "scrapling:uvx --from scrapling[ai] scrapling mcp"`.
   * Values containing `://` are treated as http (SSE) URLs.
   */
  mcpServers?: MCPServerConfig[];
  /** MCP tool-name prefixes to hide (config.json + --mcp-exclude-prefix). */
  mcpExcludedPrefixes?: string[];
  /**
   * True when every tool call (read, write, execute_command, web_search, …)
   * should be approved without prompting. Defaults to true so a one-shot
   * `pure "do thing"` runs straight through — the operator has already
   * reviewed the prompt and is responsible for what happens. Pass
   * `--prompt-on-tool` to opt back into the interactive y/n/a flow
   * (useful when debugging or working in a supervised shell).
   */
  autoApprove: boolean;
}

// ── Provider / API-key resolution ──
// Precedence for provider/apiKey/model: --flag > env var > ~/.pure/config.json > defaults.
// This lets you `pure config` once and never worry about env vars again, while still
// allowing one-off overrides per invocation.

/** Pick the right env var for a provider so we honor per-provider keys, not just any key. */
export function envKeyForProvider(provider: string): string | undefined {
  switch (provider) {
    case 'deepseek-openai':
      return process.env.DEEPSEEK_API_KEY;
    case 'qwen':
      return process.env.DASHSCOPE_API_KEY;
    case 'glm':
      return process.env.ZHIPU_API_KEY;
    case 'moonshot':
      return process.env.MOONSHOT_API_KEY;
    case 'minimax':
      return process.env.MINIMAX_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'nvidia':
      return process.env.NVIDIA_API_KEY;
    default:
      return process.env.DEEPSEEK_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.ZHIPU_API_KEY
        ?? process.env.MOONSHOT_API_KEY ?? process.env.MINIMAX_API_KEY ?? process.env.OPENAI_API_KEY
        ?? process.env.OPENROUTER_API_KEY ?? process.env.NVIDIA_API_KEY;
  }
}

export function resolveDefaultModel(provider: string, customs?: CustomProvider[]): string {
  // Shared provider registry (src/shared/providers.ts) is the single source
  // of truth for the GUI + CLI default models; only the CLI-only 'mock'
  // provider keeps its special case here. Custom providers resolve their own.
  if (provider === 'mock') return 'mock';
  return customProviderFor(customs, provider)?.defaultModel ?? defaultModelFor(provider);
}

export function autoDetectProvider(): CliArgs['provider'] {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek-openai';
  if (process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.ZHIPU_API_KEY) return 'glm';
  if (process.env.MOONSHOT_API_KEY) return 'moonshot';
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.NVIDIA_API_KEY) return 'nvidia';
  return 'deepseek-openai';
}

/** True if any provider API-key env var is set. */
export function hasAnyApiKeyEnv(): boolean {
  return !!(envKeyForProvider('default'));
}

// ── Memory evolution overrides ──

// 进化阈值（对应 GUI 设置面板的"遗忘速度"）：CLI 无 UI，用环境变量配置。
// 与引擎单位一致 —— 天数转毫秒、百分比转 0..1 小数，未设置的项用引擎默认。
export function cliEvolutionConfig(): Partial<EvolutionConfig> | undefined {
  const cfg: Partial<EvolutionConfig> = {};
  // days()/pct() 对空串（Number('') === 0）返回 NaN 而非 0 —— 半衰期/宽限为 0
  // 会让 healthScore 除零、记忆整体静默失效，必须整体拒绝非法天数。
  // 百分比边界与 GUI 设置面板的输入框 min/max 对齐（10-90 / 5-40 / 1-15 /
  // 30-90），CLI 与 UI 的校验口径一致。
  const days = (v: string | undefined) => {
    if (v === undefined || v.trim() === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * 24 * 3600 * 1000 : NaN;
  };
  const pct = (v: string | undefined, min: number, max: number) => {
    if (v === undefined || v.trim() === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n / 100 : NaN;
  };
  const half = days(process.env.PURE_MEMORY_HALF_LIFE_DAYS);
  const grace = days(process.env.PURE_MEMORY_DORMANT_GRACE_DAYS);
  const active = pct(process.env.PURE_MEMORY_ACTIVE_MIN, 10, 90);
  const dormant = pct(process.env.PURE_MEMORY_DORMANT_MAX, 5, 40);
  const floor = pct(process.env.PURE_MEMORY_DELETE_FLOOR, 1, 15);
  const similarity = pct(process.env.PURE_MEMORY_SUPERSEDE_SIMILARITY, 30, 90);
  if (!Number.isNaN(half)) cfg.recencyHalfLifeMs = half;
  if (!Number.isNaN(grace)) cfg.dormantGraceMs = grace;
  if (!Number.isNaN(active)) cfg.activeMin = active;
  if (!Number.isNaN(dormant)) cfg.dormantMax = dormant;
  if (!Number.isNaN(floor)) cfg.deleteFloor = floor;
  if (!Number.isNaN(similarity)) cfg.supersedeSimilarity = similarity;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

export const evolutionCfg = cliEvolutionConfig();

// ── Defaults ──

// Elastic by default: no hard caps are set, so the agent is never hard-stopped
// mid-task by a step / token / time limit — it runs to completion. maxTurns is
// a soft "warn once" threshold only; raise it so very long tasks don't even warn.
export const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 1000,
  maxTotalTokens: 4_000_000,
  maxExecutionTime: 7_200_000,
  warningThreshold: 0.9,
  graceTurns: 3,
};

// Single source of truth for the CLI's permission stance. CLI is invoked by a
// human who has already read the prompt — they own the consequences of ordinary
// tool calls, so we auto-approve by default. `--prompt-on-tool` (handled in
// parseArgs) inverts this for users who want the original interactive y/n/a flow.
// High-risk assessments are always applied as an interactive override after
// Planner runs; a model instruction must never be the only safeguard for a
// destructive operation.
export const DEFAULT_CLI_AUTO_APPROVE = true;
