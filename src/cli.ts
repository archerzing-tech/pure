// src/cli.ts
// v1.1.0 — one-shot + interactive REPL with self-evolving memory.
// Usage: pure "question"              → one-shot
//        pure --resume abc123          → resume session
//        pure --workspace .            → REPL
//        pure config                   → set up provider + API key (persisted to ~/.pure/config.json)

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { Harness } from './harness/Harness';
import { MockLLMAdapter } from './adapter/mock/MockLLMAdapter';
import { createDeepSeekAdapter, createQwenAdapter, createGLMAdapter, OpenAICompatibleAdapter } from './adapter/openai/OpenAICompatibleAdapter';
import { DeepSeekAnthropicAdapter } from './adapter/deepseek/DeepSeekAnthropicAdapter';
import { NodeToolAdapter, detectRuntimeVersions } from './adapter/node/NodeToolAdapter';
import { StreamManager } from './harness/StreamManager';
import { CliWireframeStream } from './shared/cliDiagram';
import { FSStore } from './adapter/storage/FSStore';
import { SQLiteStore } from './adapter/storage/SQLiteStore';
import { ContextEngine } from './harness/ContextEngine';
import { createDefaultVerifier } from './coding-agent/Verifier';
import { compileRequestWorkflow, type RequestWorkflowStage } from './shared/requestWorkflow';
import type { IntentAssessment, TaskMode } from './coding-agent/types';
import { DefaultHookRouter } from './engine/HookRouter';
import { DefaultFailurePolicy } from './engine/FailurePolicy';
import { ToolRegistry } from './coding-agent/ToolRegistry';
import { MCPClient } from './harness/mcp/MCPClient';
import type { MCPServerConfig } from './adapter/mcp/MCPTransport';
import { SubagentOrchestrator, BUILT_IN_SUBAGENTS } from './coding-agent/SubagentOrchestrator';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler } from './cli_permission';
import { dim, bold, red, green, yellow, cyan, purple, frameGray } from './termcolors';
import { sanitizeForTerminal } from './termwidth';
import { ThinkingCard } from './cli-thinking';
import { formatToolErrorLine, logoRowPlan, LOGO_WORDMARK_W } from './cli_toolrow';
import { FSMemoryStore } from './adapter/memory/FSMemoryStore';
import { WASMEmbeddingStore } from './adapter/memory/WASMEmbeddingStore';
import type { EvolutionConfig } from './adapter/memory/evolution';
import { harvestUserPreferences } from './shared/memory';
import { buildCliCapabilities, formatPromptBudgetDiagnostic, promptAssembler, resolvePromptBudget, type PromptSkill } from './shared/PromptAssembler';
import { parseSkillMarkdown } from './shared/skillFiles';
import { mergeTranscriptWithTurn } from './shared/conversation';
import { formatCliIntentAssessment, resolveCliAutoApprove } from './cliIntent';
import { customProviderFor, customProviderLabel, defaultModelFor, isCustomProviderId, promptBudgetForProvider, providerOverrideFor, CUSTOM_PRESETS, OLLAMA_PRESET, type CustomProvider, type ProviderOverride } from './shared/providers';
import type { BudgetConfig, EngineEvent, IStateStore, LLMAdapter, Message, ToolAdapter, ToolDefinition } from './shared/types';
import type { UserTurnContext } from './shared/promptLayers';
import { buildTaskContract, discoverWorkspace, formatTaskContract, workspaceProfileSummary, type TaskContract, type WorkspaceProfile } from './shared/delivery';
import { buildRepairPrompt, hasRepairableQualityFindings, qualityGateSummary, runProjectQualityGate, type ProjectQualityGateResult } from './ui/projectQualityGate';

// CLI version for the banner + startup line. The standalone binary bakes the
// released version in at compile time via scripts/build-cli.ts (--define
// process.env.PURE_CLI_VERSION, read from package.json), so it can never drift
// from the release. Dev runs (`bun run cli`) read package.json directly; the
// final literal is only a last-resort fallback so the banner never prints empty.
function resolveCliVersion(): string {
  const injected = process.env.PURE_CLI_VERSION;
  if (injected && injected !== 'undefined') {
    return /^v/i.test(injected) ? injected : `v${injected}`;
  }
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
    if (pkg?.version) return `v${pkg.version}`;
  } catch {
    // Compiled binary has no package.json beside it — use the fallback.
  }
  return 'v1.9.6-test2';
}

const CLI_VERSION = resolveCliVersion();

// ── CLI persistence paths (file-based, since Bun doesn't have localStorage) ──

// Windows has no HOME env var (USERPROFILE instead) and no /tmp; os.homedir()
// resolves the platform home directory on every OS.
const HOME = process.env.HOME || os.homedir();
const PURE_DIR = `${HOME}/.pure`;
const CONFIG_PATH = `${PURE_DIR}/config.json`;

// Persisted provider credentials. Mirror of the GUI's PureConfig (src/ui/config.ts),
// but stored on disk so the Node/Bun CLI can read them. The GUI's localStorage
// config is browser-only and cannot be reached from the CLI.
interface PureConfig {
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

function loadConfig(): PureConfig | null {
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

function saveConfig(cfg: PureConfig): void {
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
function resolveOverrideSecretKey(provider: string): string {
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

// ── CLI cross-session memory (IMemoryStore) ──
// File-backed store under ~/.pure/memories/{projectHash}/memories.jsonl,
// replacing the old single ~/.pure/memory.json UserProfile. The Harness
// searches it at session start (PromptComposer injects the top memories into
// the system prompt) and writes a successful_pattern when a session completes.
//
// WASM (v2.1): the store is wrapped in WASMEmbeddingStore — the same
// transformers.js-WASM semantic retrieval the GUI uses — so recall is
// vector-similarity based instead of literal keyword matching. The WASM model
// is lazy: it only downloads (~80MB, cached after first use) on the first
// search over a NON-EMPTY corpus, and any embedder failure (offline / no
// model / WASM unavailable) falls back to keyword search, so the CLI keeps
// working exactly as before in every environment. Scripts/CI that don't want
// the first-search download can force keyword mode with PURE_MEMORY_KEYWORD=1.
// Note: standalone released binaries ship with @huggingface/transformers
// external (package.json cli:build — onnxruntime-node can't be bundled), so
// their runtime import always fails and they use keyword search; WASM recall
// is active for repo/dev runs (`bun run cli`).

// 进化阈值（对应 GUI 设置面板的"遗忘速度"）：CLI 无 UI，用环境变量配置。
// 与引擎单位一致 —— 天数转毫秒、百分比转 0..1 小数，未设置的项用引擎默认。
function cliEvolutionConfig(): Partial<EvolutionConfig> | undefined {
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

const evolutionCfg = cliEvolutionConfig();
const memoryStore = process.env.PURE_MEMORY_KEYWORD
  ? new FSMemoryStore(`${PURE_DIR}/memories`, '', evolutionCfg)
  : new WASMEmbeddingStore({
      store: new FSMemoryStore(`${PURE_DIR}/memories`, '', evolutionCfg),
      // 包装层与内层 store 用同一份配置：WASM 检索路径的 dormant 过滤
      // 必须跟随 PURE_MEMORY_DORMANT_MAX，否则语义检索时阈值静默失效。
      getEvolution: () => evolutionCfg,
    });

function learnFromInput(text: string, sessionId: string, projectPath: string): Promise<unknown> {
  const entries = harvestUserPreferences(text, { sessionId, projectPath });
  return Promise.all(entries.map(e => memoryStore.add(e).catch(() => '')));
}

// ── Logo ──

function renderLogo() {
  const F = frameGray;
  const RST = '\x1b[0m';
  const BOLD = '\x1b[0;1m';
  const DIM = '\x1b[0;2m';
  const PPR = '\x1b[0;1;38;5;141m';
  const PPD = '\x1b[0;38;5;141m';

  // Big block-art wordmark. Each letterform is exactly 10 cols × 6 rows.
  // Per-letter SGR mirrors the GUI wordmark weights:
  //   P/U = bold white  ·  R = dim white  ·  E = bold purple  ·  · = purple dot
  // Explicit RESET-then-apply (\x1b[0;*-m) prevents attribute state bleed across letters.
  const P = [
    ' ██████╗  ',
    ' ██╔══██╗ ',
    ' ██████╔╝ ',
    ' ██╔═══╝  ',
    ' ██║      ',
    ' ╚═╝      ',
  ];
  const U = [
    ' ██╗   ██╗',
    ' ██║   ██║',
    ' ██║   ██║',
    ' ██║   ██║',
    ' ╚██████╔╝',
    '  ╚═════╝ ',
  ];
  const Rg = [
    ' ██████╗  ',
    ' ██╔══██╗ ',
    ' ██████╔╝ ',
    ' ██╔══██╗ ',
    ' ██║  ██║ ',
    ' ╚═╝  ╚═╝ ',
  ];
  const E = [
    ' ███████╗ ',
    ' ██╔════╝ ',
    ' ██████╗  ',
    ' ██╔══╝   ',
    ' ███████╗ ',
    ' ╚══════╝ ',
  ];

  // Shrink-to-fit keeps the box within the terminal down to 44 cols (CI, ssh,
  // narrow tmux panes). Default inner (76) yields exactly 80 cols including
  // the leading 2-space indent. The wordmark below is W=45 cols wide — when
  // the box can't fit it (cols < 49) the wordmark rows are dropped for a
  // compact fallback, so no line ever overflows the border (see logoRowPlan).
  const INDENT = 2;
  const WANT_INNER = 76;
  const cols = process.stdout.columns ?? 80;
  const inner = Math.min(WANT_INNER, Math.max(40, cols - INDENT - 2));
  const border = '═'.repeat(inner);
  const blank = ' '.repeat(inner);

  // Each wordmark row: 4 letters (10 each) + 3 single-space gaps + 2 cols tail.
  // Row 5 substitutes the trailing whitespace slot with a purple · flush against E,
  // keeping every row uniform at LOGO_WORDMARK_W visible cols.
  const W = LOGO_WORDMARK_W;
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    const isLast = i === 5;
    lines.push(
      `${BOLD}${P[i]}${RST}`
      + ` `
      + `${BOLD}${U[i]}${RST}`
      + ` `
      + `${DIM}${Rg[i]}${RST}`
      + ` `
      + `${PPR}${E[i]}${RST}`
      + (isLast ? ` ${PPD}·${RST}` : '  '),
    );
  }

  const center = (visibleLen: number, text: string): string => {
    const left = Math.max(0, Math.floor((inner - visibleLen) / 2));
    const right = Math.max(0, inner - left - visibleLen);
    return ' '.repeat(left) + text + ' '.repeat(right);
  };

  // Plain ASCII so .length === visible column count and centering is exact.
  const tagline = '---- terminal coding agent ----';
  const ver = CLI_VERSION;

  console.log('');
  console.log(`  ${F('╔' + border + '╗')}`);
  console.log(`  ${F('║')}${blank}${F('║')}`);
  // Narrow terminals (inner < W, i.e. cols < 49): the 45-col wordmark would
  // overflow the box border (center() clamps the negative padding, leaving the
  // row wider than the frame — see logoRowPlan). Render a compact one-line
  // PURE mark instead so every row stays within the box.
  const rowPlan = logoRowPlan(inner);
  for (let i = 0; i < rowPlan.length; i++) {
    const plan = rowPlan[i];
    if (plan === true) {
      console.log(`  ${F('║')}${center(W, lines[i])}${F('║')}`);
    } else if (plan === 'mark') {
      console.log(`  ${F('║')}${center(4, `${PPR}PURE${RST}`)}${F('║')}`);
    } else {
      console.log(`  ${F('║')}${blank}${F('║')}`);
    }
  }
  console.log(`  ${F('║')}${blank}${F('║')}`);
  console.log(`  ${F('║')}${center(tagline.length, dim(tagline))}${F('║')}`);
  console.log(`  ${F('║')}${center(ver.length, dim(ver))}${F('║')}`);
  console.log(`  ${F('║')}${blank}${F('║')}`);
  console.log(`  ${F('╚' + border + '╝')}`);
  console.log('');
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 50,
  maxTotalTokens: 1_000_000,
  maxExecutionTime: 3_600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

// Single source of truth for the CLI's permission stance. CLI is invoked by a
// human who has already read the prompt — they own the consequences of ordinary
// tool calls, so we auto-approve by default. `--prompt-on-tool` (handled in
// parseArgs) inverts this for users who want the original interactive y/n/a flow.
// High-risk assessments are always applied as an interactive override after
// Planner runs; a model instruction must never be the only safeguard for a
// destructive operation.
const DEFAULT_CLI_AUTO_APPROVE = true;

// Lightweight environment context for the CLI, mirroring the GUI's
// buildEnvironmentContext (chat.ts): a stable location/language pre-seed, with
// time/timezone left to sys_info() so they never go stale. The location comes
// from the PURE_LOCATION env var (PURE_CITY as a fallback) and is also what
// NodeToolAdapter reports inside sys_info() output.
function buildEnvironmentContext(): string {
  const city = (process.env.PURE_LOCATION ?? process.env.PURE_CITY ?? '').trim();
  if (!city) {
    return `Environment: the user has NOT configured a location — when a task depends on where they are (trip planning, weather, local services), ask for it or state the assumption clearly.`;
  }
  return `Environment: user location is ${city} (PURE_LOCATION). Use ${city} as the user's home base — e.g. the departure point for trip planning, the reference for weather / local services. Call sys_info() for the exact current time, timezone, or OS.`;
}   // Probe installed runtime versions (node / bun / python3 / rustc / git) once per process
// and inject them into the system prompt, reusing the NodeToolAdapter probe so
// sys_info() and the prompt always report identical versions. CLI runs inside
// Bun, so the spawn is synchronous — cheap, one-time, at first prompt build.
let cachedRuntimes: string | null = null;
function buildRuntimesContext(): string {
  if (cachedRuntimes === null) cachedRuntimes = detectRuntimeVersions().join('  ');
  return `\nEnvironment runtimes (installed on this machine): ${cachedRuntimes}. Use the actual versions above when the task depends on a runtime or tool version (e.g. writing a package.json engines field, a requirements.txt, or a CI/git workflow), and assume a tool is NOT installed when it is absent from this list.`;
}

/** Scan the app skills directory (~/.pure/skills/<name>/SKILL.md) and the
 * project's .agents/skills/<name>/SKILL.md, parse each SKILL.md frontmatter,
 * and return the bodies for system-prompt injection — the same directory the
 * capability-gap protocol tells the agent to install community skills into.
 * Unreadable entries are skipped; a missing directory is an empty list. */
function loadAppSkills(): PromptSkill[] {
  const home = process.env.HOME || os.homedir();
  const base = process.env.PURE_SKILLS_DIR?.trim() || `${home}/.pure`;
  const dirs = [`${base}/skills`, `${process.cwd()}/.agents/skills`];
  const out: PromptSkill[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = `${dir}/${entry.name}/SKILL.md`;
      if (!existsSync(file)) continue;
      try {
        const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'));
        if (parsed) out.push({ name: parsed.name, body: parsed.body, enabled: true });
      } catch {
        // unreadable skill — skip, never crash the CLI
      }
    }
  }
  return out;
}

function assembleCliPrompt(
  mode: TaskMode,
  args: CliArgs,
  toolsDefs: ToolDefinition[],
  userText: string,
  context: UserTurnContext,
) {
  return promptAssembler.assemble({
    surface: 'cli',
    capabilities: buildCliCapabilities(),
    toolDefinitions: toolsDefs,
    environment: buildEnvironmentContext(),
    runtimes: buildRuntimesContext(),
    skills: [...(loadConfig()?.hubSkills ?? []), ...loadAppSkills()],
    mode,
    budget: promptBudgetForProvider(args.customProviders, args.provider, args.model),
  }, userText, context);
}

// ── Task-mode integration (mirrors the GUI's yolo → plan/build switching) ──
// The Planner auto-classifies every request. Complex multi-step tasks run in an
// explicit BUILD/PLAN mode: a mode line is printed to the terminal (so the user
// sees the switch) AND a directive is injected into the system prompt so the
// model structures its work into visible, step-by-step phases.
/** Print the yolo → plan/build switch for the current request (complex only). */
function printModeSwitch(mode: TaskMode): void {
  if (mode === 'yolo') return;
  const label = mode === 'build' ? 'Build mode' : 'Plan mode';
  process.stdout.write(`  ${cyan('🧭')} ${cyan(label)} ${dim('— complex multi-step task, will execute in phases')}\n`);
}

function printWorkflowStage(stage: RequestWorkflowStage): void {
  if (stage === 'direct') return;
  const message = stage === 'probe'
    ? '先做只读工作区探针，再决定具体修改范围'
    : stage === 'plan'
      ? '先形成任务专属执行计划，再按证据推进'
      : '先完成安全确认，再允许写入或破坏性操作';
  process.stdout.write(`  ${cyan('↳')} ${dim(message)}\n`);
}

function printIntentAssessment(assessment: IntentAssessment): void {
  process.stdout.write(formatCliIntentAssessment(assessment));
}

/** Apply request-scoped CLI permissions after Planner has classified the turn. */
function applyCliIntentPermission(
  tools: ToolAdapter | undefined,
  args: CliArgs,
  assessment: IntentAssessment,
): void {
  if (!(tools instanceof ToolRegistry)) return;
  const autoApprove = resolveCliAutoApprove(!args.autoApprove, DEFAULT_CLI_AUTO_APPROVE, assessment);
  tools.setPermissionManager(new PermissionManager('NORMAL', createCliPermissionHandler(autoApprove)));
}

// ── Types ──

interface CliArgs {
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

type SubCommand = 'config' | '';

// ── Arg parsing ──
// Precedence for provider/apiKey/model: --flag > env var > ~/.pure/config.json > defaults.
// This lets you `pure config` once and never worry about env vars again, while still
// allowing one-off overrides per invocation.

/** Collect repeatable `--flag <value>` occurrences (generic flags overwrite;
 * repeatable ones accumulate — e.g. multiple --mcp-server entries). */
function repeatableFlag(raw: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === `--${name}` && raw[i + 1] && !raw[i + 1].startsWith('--')) {
      out.push(raw[i + 1]);
      i += 1;
    }
  }
  return out;
}

/** Parse one `--mcp-server "<name>:<command-or-url>"` value: values containing
 * `://` are http (SSE) endpoints, everything else is a stdio command. */
function parseMcpServerFlag(value: string): MCPServerConfig {
  const sep = value.indexOf(':');
  const name = sep === -1 ? value : value.slice(0, sep).trim();
  const rest = sep === -1 ? '' : value.slice(sep + 1).trim();
  if (rest.includes('://')) {
    return { name: name || 'mcp', transport: 'http', url: rest };
  }
  return { name: name || 'mcp', transport: 'stdio', command: rest.split(/\s+/).filter(Boolean) };
}

function parseArgs(): { args: CliArgs; command: SubCommand } {
  const raw = Bun.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].slice(2);
      const val = raw[i + 1] && !raw[i + 1].startsWith('--') ? raw[++i] : 'true';
      flags[key] = val;
    } else {
      positional.push(raw[i]);
    }
  }

  // Subcommand: `pure config` opens interactive setup. Only treat it as a
  // command when `config` is the SOLE positional (so `pure config my app` is
  // still treated as a prompt, not the wizard).
  let command: SubCommand = '';
  let promptParts = positional;
  if (positional.length === 1 && positional[0] === 'config') {
    command = 'config';
    promptParts = [];
  }

  const fileCfg = loadConfig();

  // Precedence for provider: --flag > env (auto-detect) > config > default.
  const envProvider = autoDetectProvider();
  const provider = (flags.provider && flags.provider !== 'auto')
    ? flags.provider
    : (hasAnyApiKeyEnv() ? envProvider : (fileCfg?.provider ?? envProvider));

  // Custom providers own their key inside the custom entry (or none at all for
  // keyless locals) — cloud-key env vars must never leak into their requests.
  const isCustom = isCustomProviderId(fileCfg?.customProviders, provider);
  // Built-ins may carry a per-provider key override: plain `apiKey` in the
  // config (browser mode) or the Rust secrets slot (desktop). It wins over
  // the legacy global file key but loses to --api-key and provider env vars.
  const override = isCustom ? undefined : providerOverrideFor(fileCfg?.providerOverrides, provider);
  const overrideKey = override?.apiKey || (override?.hasApiKey ? resolveOverrideSecretKey(provider) : '');
  const apiKey = flags['api-key'] ??
    (isCustom ? '' : (envKeyForProvider(provider) ?? (overrideKey || fileCfg?.apiKey || '')));

  const model = flags.model ?? fileCfg?.model ?? resolveDefaultModel(provider, fileCfg?.customProviders);
  const workspace =
    (flags.workspace && flags.workspace !== 'true') ? flags.workspace : (fileCfg?.workspace || '.');
  const resume = flags.resume && flags.resume !== 'true' ? flags.resume : '';
  const stateDb = flags['state-db'] ?? '';
  // CLI default: trust the operator — approve every tool call. The flag is
  // a one-way opt-out (`--prompt-on-tool`) so users who want the original
  // interactive confirmation flow can still get it. No positive opt-in
  // flag is needed because the default already matches the common case.
  const autoApprove = resolveCliAutoApprove(flags['prompt-on-tool'] !== undefined, DEFAULT_CLI_AUTO_APPROVE);

  // MCP servers: GUI-written ~/.pure/config.json entries first, then any
  // repeatable --mcp-server flags (a flag with the same name replaces the
  // config entry so one-off overrides work). Prefix exclusions merge.
  const mcpServers: MCPServerConfig[] = [...(fileCfg?.mcpServers ?? [])];
  for (const entry of repeatableFlag(raw, 'mcp-server')) {
    const server = parseMcpServerFlag(entry);
    const idx = mcpServers.findIndex((s) => s.name === server.name);
    if (idx >= 0) mcpServers[idx] = server;
    else mcpServers.push(server);
  }
  const mcpExcludedPrefixes = [
    ...(fileCfg?.mcpExcludedPrefixes ?? []),
    ...repeatableFlag(raw, 'mcp-exclude-prefix'),
  ];

  return {
    args: {
      prompt: promptParts.join(' '),
      provider, model, apiKey, workspace, resume, stateDb, autoApprove,
      customProviders: fileCfg?.customProviders,
      providerOverrides: fileCfg?.providerOverrides,
      mcpServers,
      mcpExcludedPrefixes,
    },
    command,
  };
}

/** Pick the right env var for a provider so we honor per-provider keys, not just any key. */
function envKeyForProvider(provider: string): string | undefined {
  switch (provider) {
    case 'deepseek-openai':
    case 'deepseek-anthropic':
      return process.env.DEEPSEEK_API_KEY;
    case 'qwen':
      return process.env.DASHSCOPE_API_KEY;
    case 'glm':
      return process.env.ZHIPU_API_KEY;
    default:
      return process.env.DEEPSEEK_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.ZHIPU_API_KEY;
  }
}

function resolveDefaultModel(provider: string, customs?: CustomProvider[]): string {
  // Shared provider registry (src/shared/providers.ts) is the single source
  // of truth for the GUI + CLI default models; only the CLI-only 'mock'
  // provider keeps its special case here. Custom providers resolve their own.
  if (provider === 'mock') return 'mock';
  return customProviderFor(customs, provider)?.defaultModel ?? defaultModelFor(provider);
}

function autoDetectProvider(): CliArgs['provider'] {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek-openai';
  if (process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.ZHIPU_API_KEY) return 'glm';
  return 'deepseek-openai';
}

/** True if any of the three provider API-key env vars is set. */
function hasAnyApiKeyEnv(): boolean {
  return !!(process.env.DEEPSEEK_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.ZHIPU_API_KEY);
}

// ── Adapter & tools factory ──

function createAdapter(args: CliArgs): { adapter: LLMAdapter; label: string } {
  if (args.provider === 'mock') {
    return { adapter: new MockLLMAdapter(), label: 'Mock (v0.1)' };
  }

  // User-defined OpenAI-compatible provider (Ollama / LM Studio / any
  // /v1/chat/completions endpoint). Keyless entries send no Authorization
  // header; keyed ones use their own key from the custom entry.
  const custom = customProviderFor(args.customProviders, args.provider);
  if (custom) {
    if (!custom.baseURL) {
      console.error(`${red('❌')} Custom provider ${cyan(custom.name)} is missing a base URL. Run ${bold('pure config')} to fix it.`);
      process.exit(1);
    }
    const model = args.model || custom.defaultModel;
    const apiKey = custom.apiKey || args.apiKey;
    return {
      adapter: new OpenAICompatibleAdapter({ baseURL: custom.baseURL, apiKey, model }),
      label: `${custom.name} (${model})`,
    };
  }

  if (!args.apiKey) {
    console.error(`${red('❌')} No API key configured for ${cyan(args.provider)}.`);
    console.error(`    ${dim('Run')} ${bold('pure config')} ${dim('to set up your provider and API key once for all sessions.')}`);
    console.error(`    ${dim('Or pass it inline:')} ${bold('pure --api-key <key>')}`);
    console.error(`    ${dim('Or set an env var:')}  DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / ZHIPU_API_KEY`);
    process.exit(1);
  }

  // Built-in providers honor a per-provider endpoint override (proxy / mirror)
  // from ~/.pure/config.json providerOverrides, mirroring the GUI settings.
  const builtinOverride = providerOverrideFor(args.providerOverrides, args.provider);
  const endpoint = builtinOverride?.baseURL || undefined;
  const displayName = customProviderLabel(args.customProviders, args.provider, args.providerOverrides);

  switch (args.provider) {
    case 'deepseek-anthropic':
      return { adapter: new DeepSeekAnthropicAdapter({ apiKey: args.apiKey, model: args.model, baseURL: endpoint }), label: `${displayName} (${args.model})` };
    case 'qwen': {
      // A configured override (e.g. a DashScope compatible-mode endpoint or a
      // gateway) replaces the dedicated workspace deployment, so the
      // workspace requirement only applies to the default path.
      if (!endpoint) {
        const wsId = process.env.DASHSCOPE_WORKSPACE_ID ?? '';
        if (!wsId) { console.error('❌ Qwen requires DASHSCOPE_WORKSPACE_ID env var'); process.exit(1); }
        return { adapter: createQwenAdapter(args.apiKey, wsId, args.model), label: `${displayName} (${args.model})` };
      }
      return { adapter: createQwenAdapter(args.apiKey, '', args.model, endpoint), label: `${displayName} (${args.model})` };
    }
    case 'glm':
      return { adapter: createGLMAdapter(args.apiKey, args.model, endpoint), label: `${displayName} (${args.model})` };
    case 'deepseek-openai':
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model, endpoint), label: `${displayName} (${args.model})` };
    default:
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model, endpoint), label: `${displayName} (${args.model})` };
  }
}

async function createTools(
  workspace: string,
  autoApprove = false,
  sessionId = '',
  mcpServers?: MCPServerConfig[],
  mcpExcludedPrefixes?: string[],
): Promise<{ tools?: ToolAdapter; toolsDefs: ToolDefinition[]; mcpClient?: MCPClient }> {
  if (!workspace) return { toolsDefs: [] };

  const resolved = workspace.startsWith('/') ? workspace : `${process.cwd()}/${workspace}`;
  // Pass the user-configured location (PURE_LOCATION / PURE_CITY env var) so
  // sys_info() reports it as the location baseline, mirroring the GUI.
  const adapter = new NodeToolAdapter({
    workspace: resolved,
    sessionId,
    location: process.env.PURE_LOCATION ?? process.env.PURE_CITY,
  });

  // P1-8: wire PermissionManager + write confirmation into the CLI direct
  // path. The engine executes tools through ctx.tools; wrapping the adapter
  // in a ToolRegistry puts every call behind the same permission gate the GUI
  // uses (read auto-approve / write + command confirm / session cache).
  // toolsDefs stay the adapter's own (the 6 CLI-available tools) so the LLM
  // never sees registry-only git_* tools it cannot actually call.
  //
  // `autoApprove` (driven by --auto-approve) flips that gate to fully open:
  // every tool call is allowed without prompting. Useful for piped / scripted
  // invocations where no human is at the keyboard to answer y/n/a.
  const registry = new ToolRegistry(adapter);
  registry.setPermissionManager(new PermissionManager('NORMAL', createCliPermissionHandler(autoApprove)));

  // MCP servers: GUI-written ~/.pure/config.json `mcpServers` plus repeatable
  // --mcp-server flags. Tools are registered into the same registry as the
  // built-ins (permission-gated like the GUI) and routed to the MCPClient.
  // Prefix exclusions (mcpExcludedPrefixes) keep third-party tool lists from
  // crowding out the built-in selection.
  const mcpDefs: ToolDefinition[] = [];
  let mcpClient: MCPClient | undefined;
  if (mcpServers && mcpServers.length > 0) {
    mcpClient = new MCPClient({
      servers: mcpServers,
      sessionId,
      excludedPrefixes: mcpExcludedPrefixes,
      onToolDiscovered: (tool) => registry.register(tool),
    });
    registry.setMCPExecutor(mcpClient);
    await mcpClient.connectAll();
    // Register tools from any server that connected (allSettled tolerates
    // individual failures, e.g. a missing uvx for the Scrapling preset).
    for (const tool of mcpClient.getTaggedTools()) registry.register(tool);
    mcpDefs.push(...mcpClient.getTools());
  }

  return { tools: registry, toolsDefs: [...adapter.getTools(), ...mcpDefs], mcpClient };
}

// ── Shared event consumer ──

async function consumeTurn(
  events: AsyncGenerator<EngineEvent, void, void>,
  streamMgr: StreamManager,
): Promise<{ output: string; messages: Message[]; turnCount: number; ok: boolean }> {
  let finalOutput = '';
  let messages: Message[] = [];
  let turnCount = 1;
  let ok = true;

  // Diagram wireframe conversion: mermaid/puml fenced blocks from the model
  // stream as raw source; the converter holds open diagram fences until they
  // complete and then emits a box-drawing wireframe instead. Everything else
  // streams through unchanged (streamMgr keeps the 16ms token batching).
  const wireframe = new CliWireframeStream(chunk => streamMgr.feed({ type: 'TokenDelta', timestamp: Date.now(), payload: { content: chunk, stateId: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isToolCall: false } }));

  // ── Thinking indicator ──
  // The CLI never waits silently: a `💭 thinking…` line is printed the moment
  // the turn starts (so the user isn't staring at a frozen cursor while the
  // model reasons / the API round-trips), and reasoning deltas (DeepSeek/Qwen/
  // GLM `reasoning_content`) live-update that line in place — a dim purple
  // tail-preview that keeps scrolling as the model thinks. The first visible
  // answer token or tool call commits the line; a later reasoning phase (after
  // tool results) opens a fresh line, mirroring the GUI's per-iteration
  // thinking card. On non-TTY stdout the indicator is skipped entirely so
  // piped/scripted output stays clean.
  const tty = !!process.stdout.isTTY;
  let thinking = false;
  let thinkingCard: ThinkingCard | null = null;
  // Once the visible answer has begun streaming, never open another thinking
  // card — a stray ReasoningDelta after the answer would otherwise redraw the
  // box over the streamed answer (engine emits reasoning strictly before
  // content per iteration, so this is purely defensive).
  let answered = false;
  // Thinking renders as a FLAT CARD (see cli-thinking.ts): height-capped,
  // tail-following scroll window into the reasoning stream, content in PLAIN
  // non-highlighted text. On end it collapses to a one-line summary so the
  // transcript stays clean.
  const startThinking = () => {
    if (!tty || thinking || answered) return;
    thinking = true;
    thinkingCard = new ThinkingCard({
      write: s => process.stdout.write(s),
      columns: () => process.stdout.columns || 80,
    });
    thinkingCard.redraw();
  };
  const updateThinking = (delta: string) => {
    if (!tty || !thinking || !thinkingCard) return;
    // Sanitize on ACCUMULATION: a leaked ANSI escape / control byte from the
    // reasoning stream must never survive into later redraws.
    thinkingCard.append(sanitizeForTerminal(delta));
    thinkingCard.redraw();
  };
  const endThinking = () => {
    if (!tty || !thinking) return;
    thinking = false;
    if (thinkingCard) {
      process.stdout.write(`${dim(thinkingCard.collapse())}\n`);
      thinkingCard = null;
    }
  };

  // StateChange (e.g. [THINK → VERIFY]) is intentionally not rendered:
  // the CLI's user-facing surface is the thinking indicator + streamed output
  // + tool results, and per-phase state banners just add noise on every turn.
  startThinking();

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'TokenDelta':
          // First visible answer token (or a tool call) marks the end of the
          // thinking phase — commit the indicator line, then stream normally.
          // Only a real content token (not a tool call) counts as "the answer
          // started" — tool calls are followed by more reasoning iterations.
          if (event.payload.isToolCall || event.payload.content) {
            endThinking();
            if (!event.payload.isToolCall) answered = true;
          }
          if (event.payload.content) wireframe.feed(event.payload.content);
          else streamMgr.feed(event);
          break;
        case 'ReasoningDelta':
          if (event.payload.content) {
            // Reasoning can resume after tool results (each LLM iteration), so
            // a fresh indicator line opens whenever a new reasoning phase begins.
            startThinking();
            updateThinking(event.payload.content);
          }
          break;
        case 'ToolResult':
          endThinking();
          streamMgr.stop();
          const toolResult = event.payload.result;
          const status = toolResult.success ? green('✓') : red('✗');
          process.stdout.write(`  ${purple(`🔧 ${event.payload.toolName}`)}: ${status} ${dim(`(${event.payload.duration}ms)`)}\n`);
          // A failed tool used to be an opaque `✗` — the reason (missing path,
          // command stderr, …) was only visible to the model. Print it for the
          // terminal user too: sanitized, collapsed to one line, truncated.
          if (!toolResult.success && toolResult.error) {
            const reason = formatToolErrorLine(toolResult.error);
            if (reason) process.stdout.write(`  ${dim('  ↳')} ${red(reason)}\n`);
          }
          streamMgr.start();
          break;
        case 'Completed':
          endThinking();
          streamMgr.stop();
          finalOutput = event.payload.finalOutput ?? '';
          messages = event.payload.messages ?? [];
          turnCount = event.payload.turnCount;
          // A turn that truly completed (interrupted=false) succeeded even if
          // it passed through recoverable VERIFY_FAILED retries earlier — don't
          // let the sticky `ok=false` from an intermediate recoverable error
          // mislabel the final summary as ❌. The engine ALWAYS emits a trailing
          // Completed (also after Interrupted, with interrupted=true), so gate
          // on the payload: aborted/budget-exhausted runs must stay ❌.
          if (!event.payload.interrupted) ok = true;
          break;
        case 'Error':
          endThinking();
          streamMgr.stop();
          // Recoverable errors (VERIFY_FAILED → retry loop) are an internal
          // iteration, not a user-facing failure — show them in yellow like
          // an Interrupted notice. Only unrecoverable errors get the red ⚠.
          const recoverableErr = event.payload.recoverable === true;
          process.stdout.write(`\n  ${recoverableErr ? yellow('↻') : red('⚠')}  ${recoverableErr ? yellow(event.payload.code) : red(event.payload.code)}: ${dim(event.payload.message)}\n`);
          ok = false;
          break;
        case 'Interrupted':
          endThinking();
          streamMgr.stop();
          process.stdout.write(`\n  ${yellow('⏹')}  ${dim(event.payload.reason)}\n`);
          ok = false;
          break;
      }
    }
  } finally {
    // Every path — normal completion, engine Error/Interrupted, or an adapter
    // throwing — commits the thinking line so the shell prompt never prints
    // onto a dangling `💭 thinking…` cursor. Idempotent (guarded by `thinking`).
    // Also flush the wireframe converter so a trailing open diagram fence
    // degrades to its raw source instead of being dropped.
    endThinking();
    wireframe.flush();
    streamMgr.stop();
  }
  return { output: finalOutput, messages, turnCount, ok };
}

async function runCliDeliveryGate(
  tools: ToolAdapter,
  profile: WorkspaceProfile,
): Promise<ProjectQualityGateResult> {
  process.stdout.write(`\n  ${cyan('🧪')} ${cyan('Delivery gate')} ${dim('— review, audit, typecheck, test, lint, build')}\n`);
  const result = await runProjectQualityGate(tools, {
    profile,
    onPhase: (phase, status, summary) => {
      const icon = status === 'active' ? '●' : status === 'passed' ? '✓' : status === 'failed' ? '✗' : '!';
      process.stdout.write(`  ${status === 'passed' ? green(icon) : status === 'failed' ? red(icon) : yellow(icon)} ${phase}: ${summary ?? status}\n`);
    },
    onCheck: (check) => {
      if (check.output && check.status !== 'passed') {
        const line = check.output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
        if (line) process.stdout.write(`    ${dim('↳')} ${dim(line.slice(0, 240))}\n`);
      }
    },
  });
  process.stdout.write(result.passed
    ? `  ${green('✅')} ${green('项目允许交付')}\n`
    : `  ${red('⛔')} ${red('项目暂不交付')}: ${qualityGateSummary(result)}\n`);
  return result;
}

const MAX_CLI_QUALITY_REPAIR_ROUNDS = 3;

async function runCliDeliveryGateWithRepair(
  tools: ToolAdapter,
  profile: WorkspaceProfile,
  harness: Harness,
  systemPrompt: string,
  messages: Message[],
  streamMgr: StreamManager,
  signal?: AbortSignal,
): Promise<{ result: ProjectQualityGateResult; messages: Message[] }> {
  let currentProfile = profile;
  let currentMessages = messages;
  let result = await runCliDeliveryGate(tools, currentProfile);
  let rounds = 0;
  while (!result.passed && rounds < MAX_CLI_QUALITY_REPAIR_ROUNDS && hasRepairableQualityFindings(result) && !signal?.aborted) {
    rounds += 1;
    process.stdout.write(`  ${yellow('↻')} ${yellow(`开始第 ${rounds}/${MAX_CLI_QUALITY_REPAIR_ROUNDS} 轮质量修复`)}\\n`);
    const repairResult = await consumeTurn(
      harness.continueTurn(systemPrompt, currentMessages, buildRepairPrompt(result), signal),
      streamMgr,
    );
    if (repairResult.messages.length > 0) currentMessages = repairResult.messages;
    if (!repairResult.ok) break;
    currentProfile = await discoverWorkspace(tools);
    result = await runCliDeliveryGate(tools, currentProfile);
  }
  if (!result.passed && rounds >= MAX_CLI_QUALITY_REPAIR_ROUNDS && hasRepairableQualityFindings(result)) {
    process.stdout.write(`  ${red('⛔')} ${red(`质量修复达到 ${MAX_CLI_QUALITY_REPAIR_ROUNDS} 轮上限，项目暂不交付`)}\\n`);
  }
  return { result, messages: currentMessages };
}

// ── Storage factory ──

function createStore(args: CliArgs): IStateStore | undefined {
  if (args.stateDb) return new SQLiteStore(args.stateDb);
  return new FSStore();
}

// ── Harness factory ──

async function createHarness(args: CliArgs) {
  const { adapter } = createAdapter(args);
  const sessionId = args.resume || `session_${Date.now()}`;
  const createdTools = await createTools(args.workspace, args.autoApprove, sessionId, args.mcpServers, args.mcpExcludedPrefixes);
  const tools = createdTools.tools;
  let toolsDefs = createdTools.toolsDefs;
  if (tools && tools instanceof ToolRegistry) {
    const orchestrator = new SubagentOrchestrator({
      llm: adapter,
      parentTools: tools,
      parentToolsDefsProvider: () => tools.getTools(),
      defaultBudget: DEFAULT_BUDGET,
    });
    for (const def of BUILT_IN_SUBAGENTS) {
      orchestrator.register(def);
      tools.register(def);
    }
    tools.setSubagentExecutor(orchestrator);
    toolsDefs = tools.getTools();
  }
  const store = args.resume ? createStore(args) : undefined;
  // Project-scoped memory: resolved workspace (same as createTools uses).
  const projectPath = args.workspace
    ? (args.workspace.startsWith('/') ? args.workspace : `${process.cwd()}/${args.workspace}`)
    : process.cwd();

  const harness = new Harness({
    sessionId,
    llm: adapter,
    tools,
    toolsDefs,
    budget: DEFAULT_BUDGET,
    stateStore: store,
    memory: memoryStore,
    projectPath,
    workspaceAvailable: true,
    promptAssembler,      promptBudget: promptBudgetForProvider(args.customProviders, args.provider, args.model),
    // G-3 fix: wire the ContextEngine (with LLM summarization fallback) into
    // the CLI too — long REPL sessions previously grew without bound because
    // the CLI's Harness never had a contextEngine configured.
    contextEngine: new ContextEngine({
      maxMessages: 20,
      maxTokens: resolvePromptBudget(promptBudgetForProvider(args.customProviders, args.provider, args.model)).availableInputTokens,
      toolsProvider: () => tools?.getTools() ?? toolsDefs,
      llm: adapter,
    }),
    // P1-1 (async verification): the CLI uses the pure rule-based verifier
    // (non-empty-output check — a hard failure still triggers an in-engine
    // rewrite). The LLM re-check of the final answer is NOT run synchronously
    // here: the round-trip it added after the answer stream kept the CLI stuck
    // in "verifying…" and a failed verdict rewrote the answer just printed.
    verifier: createDefaultVerifier(),
    // Lifecycle hooks + escalating failure recovery policy.
    hooks: new DefaultHookRouter(),
    failurePolicy: new DefaultFailurePolicy(),
  });

  return { harness, tools, toolsDefs, store, sessionId, projectPath, mcpClient: createdTools.mcpClient };
}

// ── `pure config` — interactive one-time setup ──
// Writes ~/.pure/config.json so future `pure` invocations work without env vars.

const PROVIDER_LABELS: Record<Exclude<CliArgs['provider'], 'mock'>, string> = {
  'deepseek-openai': 'DeepSeek (OpenAI-compatible API)',
  'deepseek-anthropic': 'DeepSeek (Anthropic-style API)',
  'qwen': 'Qwen / DashScope',
  'glm': 'GLM / Zhipu',
};

const PROVIDER_ENV_HINT: Record<Exclude<CliArgs['provider'], 'mock'>, string> = {
  'deepseek-openai': 'DEEPSEEK_API_KEY',
  'deepseek-anthropic': 'DEEPSEEK_API_KEY',
  'qwen': 'DASHSCOPE_API_KEY',
  'glm': 'ZHIPU_API_KEY',
};

async function runConfig(): Promise<void> {
  renderLogo();
  process.stdout.write(`  ${bold('pure config')} ${dim('— set up your provider and API key')}\n`);
  process.stdout.write(`  ${dim('Saved to')} ${CONFIG_PATH}${dim('. You only need to do this once.')}\n`);
  console.log('');

  const existing = loadConfig();

  // Each non-secret question gets its own short-lived readline handle so the
  // raw-mode `askMasked` below can take over stdin without contention.
  const ask = (q: string): Promise<string> => {
    const rlQ = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rlQ.question(q, a => { rlQ.close(); resolve((a ?? '').trim()); });
    });
  };

  // Raw-mode TTY mask for secrets. Each typed OR pasted character writes one `*`
  // so the user has visible confirmation that their paste landed. Falls back to
  // the unmasked `ask` when stdin is not a TTY (CI scripts, `pure config <
  // keys.txt`). Resolves on Enter, exits on Ctrl+C / Ctrl+D, handles Backspace
  // + Ctrl+U. Strips bracketed-paste boundary escapes so they neither reach
  // the secret buffer nor render as `*` junk.
  const askMasked = (q: string): Promise<string> => {
    if (!process.stdin.isTTY) return ask(q);
    return new Promise(resolve => {
      process.stdout.write(q);
      const wasRaw = !!process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let buf = '';
      const cleanup = () => {
        try { process.stdin.setRawMode(wasRaw); } catch {}
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
      };
      const onData = (chunk: string) => {
        // Bracketed-paste wrap: \x1b[200~ … \x1b[201~ — strip the boundary
        // markers so they don't reach the key buffer or get echoed as `*`.
        chunk = chunk.replace(/\x1b\[200~|\x1b\[201~/g, '');
        for (const c of chunk) {
          const code = c.charCodeAt(0);
          if (code === 0x03 || code === 0x04) {           // Ctrl+C / Ctrl+D
            cleanup();
            process.stdout.write('\n');
            process.exit(code === 0x03 ? 130 : 1);
            return;
          }
          if (code === 0x0d || code === 0x0a) {           // Enter / LF
            cleanup();
            process.stdout.write('\n');
            resolve(buf);
            return;
          }
          if (code === 0x08 || code === 0x7f) {           // Backspace
            if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
            continue;
          }
          if (code === 0x15) {                            // Ctrl+U (clear line)
            if (buf.length > 0) { process.stdout.write('\b \b'.repeat(buf.length)); buf = ''; }
            continue;
          }
          if (code < 0x20) continue;                      // ignore other ctrl codes
          buf += c;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    });
  };

  try {
    // Provider list: built-ins + user-defined customs + an "add new" option.
    const existingCustoms = existing?.customProviders ?? [];
    const builtInKeys = Object.keys(PROVIDER_LABELS) as Array<Exclude<CliArgs['provider'], 'mock'>>;
    const providerKeys: string[] = [...builtInKeys, ...existingCustoms.map(c => c.id), 'add-custom'];
    process.stdout.write(`  ${dim('Available providers:')}\n`);
    providerKeys.forEach((k, i) => {
      const custom = customProviderFor(existingCustoms, k);
      const label = k === 'add-custom'
        ? 'Add custom provider (OpenAI-compatible, e.g. Ollama)'
        : custom
          ? `${custom.name}${custom.apiKey ? '' : ' (no key)'}`
          : customProviderLabel(existingCustoms, k, existing?.providerOverrides);
      const marker = existing?.provider === k ? green(' ← current') : '';
      process.stdout.write(`    ${cyan(String(i + 1))}) ${label}${marker}\n`);
    });
    const currentIdx = existing && existing.provider !== 'mock' ? providerKeys.indexOf(existing.provider) : -1;
    const defaultHint = currentIdx >= 0 ? String(currentIdx + 1) : '1';
    const providerIdxRaw = await ask(`\n  ${bold('Choose provider')} ${dim(`[1-${providerKeys.length}]`)} ${dim(`(default ${defaultHint})`)}: `);
    let providerIdx = providerIdxRaw ? parseInt(providerIdxRaw, 10) - 1 : (currentIdx >= 0 ? currentIdx : 0);
    if (Number.isNaN(providerIdx) || providerIdx < 0 || providerIdx >= providerKeys.length) providerIdx = 0;

    // Custom-provider add flow: Ollama one-click preset or manual entry.
    let finalCustoms = existingCustoms;
    let provider: string;
    if (providerKeys[providerIdx] === 'add-custom') {
      // Quick presets: 1-Ollama 2-OpenAI 3-OpenRouter 4-NVIDIA, then Manual.
      const presetChoices = CUSTOM_PRESETS.map((p, i) => `[${i + 1}] ${p.name}${p.local ? ' (local)' : ''}`).join('  ');
      const presetRaw = await ask(`\n  ${bold('Preset')} ${dim(`${presetChoices}  [${CUSTOM_PRESETS.length + 1}] Manual`)} ${dim('(default 1)')}: `);
      const presetIdx = parseInt(presetRaw, 10) - 1;
      const preset = presetRaw.trim() === '' || Number.isNaN(presetIdx) ? 0 : presetIdx;
      if (preset >= 0 && preset < CUSTOM_PRESETS.length) {
        const chosen = CUSTOM_PRESETS[preset];
        if (!finalCustoms.some(p => p.id === chosen.id)) {
          finalCustoms = [...finalCustoms, { ...chosen }];
        }
        provider = chosen.id;
        process.stdout.write(`  ${green('✓')} ${chosen.name} preset: ${dim(chosen.baseURL)} ${dim(`(default model ${chosen.defaultModel})`)}\n`);
        if (!chosen.local) process.stdout.write(`  ${dim('API key: paste it when prompted below, or set later with')} ${bold('pure config')}${dim('.')}\n`);
      } else {
        const name = (await ask(`\n  ${bold('Provider name')}: `)).trim();
        if (!name) { process.stdout.write(`\n  ${red('❌ Name is required. Aborting.')}\n`); process.exit(1); }
        const baseURL = (await ask(`  ${bold('Base URL')} ${dim('(OpenAI-compatible, e.g. http://localhost:11434/v1)')}: `)).trim();
        if (!baseURL) { process.stdout.write(`\n  ${red('❌ Base URL is required. Aborting.')}\n`); process.exit(1); }
        const modelsRaw = (await ask(`  ${bold('Models')} ${dim('(comma-separated, e.g. qwen2.5-coder:7b, llama3.1:8b)')}: `)).trim();
        const models = modelsRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (models.length === 0) { process.stdout.write(`\n  ${red('❌ At least one model is required. Aborting.')}\n`); process.exit(1); }
        process.stdout.write(`  ${dim('API key is optional — press Enter to skip for local endpoints.')}\n`);
        const apiKeyRaw = await askMasked(`  ${bold('API key')} ${dim('(optional)')}: `);
        const apiKey = apiKeyRaw.trim();
        const id = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
        let uniqueId = id;
        let n = 2;
        while (finalCustoms.some(p => p.id === uniqueId)) uniqueId = `${id}-${n++}`;
        finalCustoms = [...finalCustoms, { id: uniqueId, name, baseURL, models, defaultModel: models[0], apiKey, hasApiKey: false }];
        provider = uniqueId;
      }
    } else {
      provider = providerKeys[providerIdx];
    }

    const chosenCustom = customProviderFor(finalCustoms, provider);
    let finalKey = chosenCustom?.apiKey ?? '';
    if (!chosenCustom) {
      // Built-in providers require a key — raw-mode masked read so the user
      // sees `*` per character and gets a post-paste confirmation like
      // `✓ Captured 51 chars (sk-…XX)`. The key never appears in scrollback.
      process.stdout.write(`\n  ${dim(`Get your key from the provider, then paste it below. Env var: ${PROVIDER_ENV_HINT[provider as keyof typeof PROVIDER_ENV_HINT]}`)}\n`);
      const apiKeyRaw = await askMasked(`  ${bold('API key')}${existing?.apiKey ? dim(' (Enter to keep current)') : ''}: `);
      const apiKey = apiKeyRaw.trim();
      if (apiKey && process.stdin.isTTY) {
        // First 3 + last 2 chars (e.g. `sk-…XX`) so the user can verify they
        // pasted the right key without seeing the whole secret.
        const preview = apiKey.length > 5 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}` : '***';
        process.stdout.write(`  ${green('✓')} Captured ${apiKey.length} chars (${preview})\n`);
      }
      finalKey = apiKey || existing?.apiKey || '';
      if (!finalKey) {
        process.stdout.write(`\n  ${red('❌ An API key is required for this provider. Aborting.')}\n`);
        process.exit(1);
      }
    } else if (!finalKey) {
      if (chosenCustom && !chosenCustom.local) {
        // Cloud presets (OpenAI / OpenRouter / NVIDIA) still need a key.
        const apiKeyRaw = await askMasked(`  ${bold('API key')} ${dim('(required for this provider)')}: `);
        const apiKey = apiKeyRaw.trim();
        if (apiKey && process.stdin.isTTY) {
          const preview = apiKey.length > 5 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}` : '***';
          process.stdout.write(`  ${green('✓')} Captured ${apiKey.length} chars (${preview})\n`);
        }
        finalKey = apiKey;
        if (!finalKey) {
          process.stdout.write(`\n  ${red('❌ An API key is required for this provider. Aborting.')}\n`);
          process.exit(1);
        }
        const entryIdx = finalCustoms.findIndex(p => p.id === chosenCustom.id);
        if (entryIdx >= 0) finalCustoms[entryIdx] = { ...finalCustoms[entryIdx], apiKey: finalKey };
      } else {
        process.stdout.write(`\n  ${dim('No API key — sending without Authorization (local endpoint).')}\n`);
      }
    }

    // Model
    const defaultModel = resolveDefaultModel(provider, finalCustoms);
    const modelRaw = await ask(`\n  ${bold('Model')} ${dim(`(Enter for default: ${defaultModel})`)}: `);
    const model = modelRaw || existing?.model || defaultModel;

    // Workspace (optional)
    const workspaceRaw = await ask(`  ${bold('Workspace')} ${dim('(Enter for current dir ".")')}: `);
    const workspace = workspaceRaw || existing?.workspace || '.';

    const cfg: PureConfig = {
      provider,
      apiKey: finalKey,
      model,
      workspace,
      customProviders: finalCustoms,
      // Carry existing built-in overrides (name / Base URL / key) through a
      // re-run so `pure config` never silently drops them.
      providerOverrides: existing?.providerOverrides,
    };
    saveConfig(cfg);

    const providerLabelOut = customProviderLabel(finalCustoms, provider, existing?.providerOverrides)
      ?? PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS];
    console.log('');
    process.stdout.write(`  ${green('✅ Saved.')} ${dim('Config written to')} ${CONFIG_PATH}\n`);
    process.stdout.write(`     ${dim('Provider:')} ${cyan(providerLabelOut)}\n`);
    process.stdout.write(`     ${dim('Model:')}    ${cyan(model)}\n`);
    process.stdout.write(`     ${dim('Workspace:')}${cyan(workspace)}\n`);
    process.stdout.write(`\n  ${dim('You can now run')} ${bold('pure')} ${dim('or')} ${bold('pure "your question"')} ${dim('.')}\n`);
    process.stdout.write(`  ${dim('Re-run')} ${bold('pure config')} ${dim('to change anything later.')}\n`);
  } finally {
    // ask() and askMasked() each manage their own stdin handles; nothing to close here.
  }
}

// ── One-shot mode ──

async function runOneShot(args: CliArgs) {
  const { adapter, label } = createAdapter(args);
  const { harness, tools, sessionId, projectPath, toolsDefs, mcpClient } = await createHarness(args);
  const hasTools = toolsDefs.length > 0;
  await learnFromInput(args.prompt, sessionId, projectPath);

  renderLogo();
  console.log(`  ${bold('pure')}  ${dim(CLI_VERSION)} ${dim('—')} ${cyan(label)}`);
  if (hasTools) console.log(`  📁 ${dim('Workspace:')} ${process.cwd()} ${dim('(' + toolsDefs.length + ' tools)')}`);
  if (args.resume) console.log(`  💾 ${dim('Session:')} ${sessionId.slice(0, 12)}…`);
  console.log(`  📝 ${args.prompt}`);
  console.log(dim('─'.repeat(50)));

  // Logical-trap pre-scan: if the request itself is contradictory/impossible,
  // warn the user and inject the trap notice into the system prompt so the
  // model verifies the premise instead of following it into a failure loop.
  const workflow = compileRequestWorkflow(args.prompt, { hasTools });
  const analysis = workflow.analysis;
  const traps = analysis.traps;
  if (traps.length > 0) {
    console.log(`  ${yellow('⚠')} ${yellow('potential logical trap')} ${dim('— verifying premise')}`);
  }
  printIntentAssessment(analysis.intent);
  printWorkflowStage(workflow.stage);
  if (workflow.probeRequired && !workflow.probeAvailable) {
    process.stdout.write(`  ${yellow('⚠')} ${yellow('需要只读探针，但当前没有可用工作区工具，已诚实降级')}\n`);
  }
  applyCliIntentPermission(tools, args, analysis.intent);
  printModeSwitch(analysis.mode);
  const needsDeliveryGate = !!tools && workflow.needsDeliveryGate;
  const needsIntentProbe = workflow.needsProbe;
  let workspaceProfile: WorkspaceProfile | undefined;
  let taskContract: TaskContract | undefined;
  if ((needsDeliveryGate || needsIntentProbe) && tools) {
    workspaceProfile = await discoverWorkspace(tools);
    taskContract = buildTaskContract(args.prompt, workspaceProfile);
    process.stdout.write(`  ${dim('🔎 Explore:')} ${dim(workspaceProfileSummary(workspaceProfile))}\\n`);
    if (needsDeliveryGate) process.stdout.write(`  ${dim('📋 Contract:')} ${dim(`${taskContract.acceptanceCriteria.length} 项验收标准，验证证据将决定是否交付`)}\\n`);
  }
  // Assemble system + user context together so tool schemas, priorities, and
  // the final budget report are computed against the same provider window.
  const assembly = assembleCliPrompt(analysis.mode, args, toolsDefs, args.prompt, {
    ...workflow.userContext,
    contract: taskContract ? formatTaskContract(taskContract) : undefined,
  });
  const systemPrompt = assembly.systemPrompt;
  const userTurn = assembly.userPrompt ?? args.prompt;
  const budgetDiagnostic = formatPromptBudgetDiagnostic(assembly.budget);
  if (budgetDiagnostic) process.stderr.write(`  ${yellow('⚠')} ${dim(budgetDiagnostic)}\\n`);

  const streamMgr = new StreamManager(chunk => process.stdout.write(chunk), { flushIntervalMs: 16 });
  streamMgr.start();

  const startTime = Date.now();
  const result = await consumeTurn(harness.run(systemPrompt, userTurn), streamMgr);
  let ok = result.ok;
  if (needsDeliveryGate && tools) {
    const profile = workspaceProfile ?? await discoverWorkspace(tools);
    if (!workspaceProfile) process.stdout.write(`  ${dim('🔎 Explore:')} ${dim(workspaceProfileSummary(profile))}\\n`);
    const delivery = await runCliDeliveryGateWithRepair(tools, profile, harness, systemPrompt, result.messages, streamMgr);
    ok = ok && delivery.result.passed;
  }

  process.stdout.write('\n');
  console.log(dim('─'.repeat(50)));
  const emoji = ok ? green('✅') : red('❌');
  const time = dim(`${Date.now() - startTime}ms`);
  const turn = dim(`| turn ${result.turnCount}`);
  process.stdout.write(`  ${emoji} ${time} ${turn}\n`);

  // MCP subprocesses keep stdio pipes open — without an explicit disconnect the
  // event loop never drains and the one-shot CLI would hang after finishing.
  mcpClient?.disconnectAll();
}

// ── REPL mode ──

async function runRepl(args: CliArgs) {
  const { adapter, label } = createAdapter(args);
  const { harness, tools, sessionId, projectPath, toolsDefs, mcpClient } = await createHarness(args);
  const hasTools = toolsDefs.length > 0;

  renderLogo();
  process.stdout.write(`  ${bold('pure')}  ${dim(CLI_VERSION)} ${dim('—')} ${cyan(label)}\n`);
  if (hasTools) process.stdout.write(`  📁 ${dim(process.cwd())} ${dim(`| ${toolsDefs.length} tools`)}\n`);
  process.stdout.write(`  💾 ${dim(sessionId.slice(0, 12))}…\n`);
  process.stdout.write(`  ${dim('/exit /quit — leave   /clear — reset context   /compact — compact context   /undo — restore last write   Ctrl+C — cancel')}\n`);
  console.log('');

  let messages: Message[] = [];
  let compactedHistory: Message[] | null = null;
  let compactedTranscriptLength = 0;
  let turnNum = 1;
  let firstTurn = true;
  let lastMode: TaskMode = 'yolo';
  let generating = false;
  let currentAbort: AbortController | null = null;
  // First prompt prints tight against the header banner; from turn 2 onward
  // we prepend a blank line so the new `>` sits clearly below the prior
  // `✅ time | turn N` status row instead of hugging it.
  let isFirstPrompt = true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('SIGINT', () => {
    if (generating && currentAbort) {
      if (currentAbort.signal.aborted) {
        process.stdout.write('\n  👋 Goodbye.\n');
        rl.close();
        mcpClient?.disconnectAll();
        process.exit(0);
      }
      currentAbort.abort();
      process.stdout.write('\n  ⏹️  Cancelling... (press Ctrl+C again to force quit)\n');
      return;
    }
    process.stdout.write('\n  👋 Goodbye.\n');
    rl.close();
    mcpClient?.disconnectAll();
    process.exit(0);
  });

  const askQuestion = (): Promise<string> => {
    const prompt = isFirstPrompt ? '> ' : '\n> ';
    isFirstPrompt = false;
    return new Promise(resolve => { rl.question(prompt, answer => resolve(answer.trim())); });
  };

  while (true) {
    const input = await askQuestion();
    if (!input) continue;

    if (input === '/exit' || input === '/quit') {
      process.stdout.write(`  ${dim('👋 Goodbye.')}\n`);
      mcpClient?.disconnectAll();
      break;
    }
    if (input === '/undo') {
      if (generating) {
        process.stdout.write(`  ${yellow('⏳')} ${dim('请先等待当前执行结束。')}\n`);
        continue;
      }
      const snapshot = tools?.getSnapshotPort?.();
      try {
      const result = snapshot
        ? await snapshot.undoLastWriteBatch()
        : { restored: false, restoredPaths: [], removedPaths: [], conflicts: [], message: '当前会话没有可撤销的写入。' };
      process.stdout.write(`  ${result.restored ? green('↶') : yellow('!')} ${result.message}\n`);
      } catch (error) {
        process.stdout.write(`  ${red('!')} 撤销失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
      continue;
    }

    if (input === '/clear') {
      messages = [];
      compactedHistory = null;
      compactedTranscriptLength = 0;
      firstTurn = true; turnNum = 1;
      process.stdout.write(`  ${dim('🧹 Context cleared.')}\n`);
      continue;
    }

    if (input === '/compact') {
      if (generating) {
        process.stdout.write(`  ${yellow('⏳')} ${dim('请先等待当前执行结束。')}\n`);
        continue;
      }
      const contextEngine = harness.getContextEngine();
      if (!contextEngine || messages.length === 0) {
        process.stdout.write(`  ${yellow('!')} ${dim('当前会话没有可压缩的上下文。')}\n`);
        continue;
      }
      try {
        const compacted = await contextEngine.compact(messages, { force: true });
        if (compacted.compacted) {
          compactedHistory = compacted.messages;
          compactedTranscriptLength = messages.length;
        }
        if (compacted.overBudget) {
          const warning = compacted.oversizedNewestGroup
            ? '最新消息过大，已保持完整；当前上下文仍超过 Token 预算。'
            : '系统提示词或摘要本身已超过 Token 预算；已保持 provider 可接受的完整消息结构。';
          process.stdout.write(`  ${yellow('!')} ${yellow(warning)}\n`);
        } else if (!compacted.compacted) {
          process.stdout.write(`  ${dim('✓ 当前上下文已在压缩范围内，无需改变。')}\n`);
        } else {
          const summary = compacted.summarized
            ? '，已生成摘要'
            : compacted.summaryUnavailable ? '，未调用摘要模型' : '';
          process.stdout.write(`  ${green('✓')} ${dim(`上下文已压缩：淘汰 ${compacted.evictedMessages} 条消息${summary}，约 ${compacted.estimatedTokens} tokens`)}\n`);
        }
      } catch (error) {
        process.stdout.write(`  ${red('!')} 上下文压缩失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
      continue;
    }

    currentAbort = new AbortController();
    generating = true;

    const streamMgr = new StreamManager(chunk => process.stdout.write(chunk), { flushIntervalMs: 16 });
    streamMgr.start();

    const startTime = Date.now();
    await learnFromInput(input, sessionId, projectPath);

    // Trap pre-scan per REPL turn (same as one-shot): surface the warning and
    // inject it into the system prompt so the model verifies the premise.
    const workflow = compileRequestWorkflow(input, { hasTools: toolsDefs.length > 0 });
    const analysis = workflow.analysis;
    const traps = analysis.traps;
    if (traps.length > 0) {
      process.stdout.write(`  ${yellow('⚠')} ${yellow('potential logical trap')} ${dim('— verifying premise')}\n`);
    }
    printIntentAssessment(analysis.intent);
    printWorkflowStage(workflow.stage);
    if (workflow.probeRequired && !workflow.probeAvailable) {
      process.stdout.write(`  ${yellow('⚠')} ${yellow('需要只读探针，但当前没有可用工作区工具，已诚实降级')}\n`);
    }
    applyCliIntentPermission(tools, args, analysis.intent);
    // Announce mode changes only (not every turn) so long complex sessions
    // stay quiet; the first complex turn switches from yolo and is announced.
    if (analysis.mode !== lastMode) {
      printModeSwitch(analysis.mode);
      lastMode = analysis.mode;
    }
    const needsDeliveryGate = !!tools && workflow.needsDeliveryGate;
    let workspaceProfile: WorkspaceProfile | undefined;
    const needsIntentProbe = workflow.needsProbe;
    let taskContract: TaskContract | undefined;
    if ((needsDeliveryGate || needsIntentProbe) && tools) {
      workspaceProfile = await discoverWorkspace(tools);
      taskContract = buildTaskContract(input, workspaceProfile);
      process.stdout.write(`  ${dim('🔎 Explore:')} ${dim(workspaceProfileSummary(workspaceProfile))}\\n`);
      if (needsDeliveryGate) process.stdout.write(`  ${dim('📋 Contract:')} ${dim(`${taskContract.acceptanceCriteria.length} 项验收标准，验证证据将决定是否交付`)}\\n`);
    }
    const assembly = assembleCliPrompt(analysis.mode, args, toolsDefs, input, {
      ...workflow.userContext,
      contract: taskContract ? formatTaskContract(taskContract) : undefined,
    });
    const systemPrompt = assembly.systemPrompt;
    const userTurn = assembly.userPrompt ?? input;

    const historyMessages = compactedHistory && compactedTranscriptLength === messages.length
      ? compactedHistory
      : messages;
    const events = firstTurn
      ? harness.run(systemPrompt, userTurn, currentAbort.signal)
      : harness.continueTurn(systemPrompt, historyMessages, userTurn, currentAbort.signal);

    const result = await consumeTurn(events, streamMgr);
    let turnOk = result.ok;
    let turnMessages = result.messages;
    if (needsDeliveryGate && tools && !currentAbort.signal.aborted) {
      const profile = workspaceProfile ?? await discoverWorkspace(tools);
      if (!workspaceProfile) process.stdout.write(`  ${dim('🔎 Explore:')} ${dim(workspaceProfileSummary(profile))}\\n`);
      const delivery = await runCliDeliveryGateWithRepair(tools, profile, harness, systemPrompt, result.messages, streamMgr, currentAbort.signal);
      turnOk = turnOk && delivery.result.passed;
      turnMessages = delivery.messages;
    }
    const automaticCompaction = harness.getLastContextCompactionResult();
    if (automaticCompaction?.overBudget) {
      const warning = automaticCompaction.oversizedNewestGroup
        ? '自动上下文压缩保留了不可拆分的最新消息，但当前窗口仍超过 Token 预算。'
        : '自动上下文压缩发现系统提示词或摘要基线已超过 Token 预算。';
      process.stdout.write(`  ${yellow('!')} ${yellow(warning)}\n`);
    }
    const wasAborted = currentAbort.signal.aborted;
    generating = false;
    currentAbort = null;

    if (turnOk) {
      process.stdout.write('\n');
      const time = dim(`${Date.now() - startTime}ms`);
      const turn = dim(`| turn ${turnNum}`);
      process.stdout.write(`  ${green('✅')} ${time} ${turn}\n`);
      if (turnMessages.length > 0) {
        messages = firstTurn
          ? turnMessages
          : mergeTranscriptWithTurn(messages, turnMessages, input);
      }
      compactedHistory = null;
      compactedTranscriptLength = 0;
      await harness.saveTranscriptCheckpoint(messages, result.turnCount);
      firstTurn = false;
      turnNum++;
    } else if (wasAborted) {
      if (turnMessages.length > 0) {
        messages = firstTurn
          ? turnMessages
          : mergeTranscriptWithTurn(messages, turnMessages, input);
        await harness.saveTranscriptCheckpoint(messages, result.turnCount);
      }
      process.stdout.write('\n');
      process.stdout.write(`  ${yellow('⏹')}  ${dim(`Cancelled (${Date.now() - startTime}ms)`)}\n`);
    } else {
      process.stdout.write('\n');
      process.stdout.write(`  ${red('❌')} ${dim(`${Date.now() - startTime}ms`)}\n`);
    }
  }

  rl.close();
}

// ── Entry ──

async function main() {
  const { args, command } = parseArgs();

  if (command === 'config') {
    await runConfig();
    return;
  }

  if (args.prompt) {
    await runOneShot(args);
  } else {
    await runRepl(args);
  }
}

main().catch(console.error);
