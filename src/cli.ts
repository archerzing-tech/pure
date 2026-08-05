// src/cli.ts
// v0.9.7 — one-shot + interactive REPL with self-evolving memory.
// Usage: pure "question"              → one-shot
//        pure --resume abc123          → resume session
//        pure --workspace .            → REPL
//        pure config                   → set up provider + API key (persisted to ~/.pure/config.json)

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { Harness } from './harness/Harness';
import { MockLLMAdapter } from './adapter/mock/MockLLMAdapter';
import { createDeepSeekAdapter, createQwenAdapter, createGLMAdapter } from './adapter/openai/OpenAICompatibleAdapter';
import { DeepSeekAnthropicAdapter } from './adapter/deepseek/DeepSeekAnthropicAdapter';
import { NodeToolAdapter } from './adapter/node/NodeToolAdapter';
import { StreamManager } from './harness/StreamManager';
import { FSStore } from './adapter/storage/FSStore';
import { SQLiteStore } from './adapter/storage/SQLiteStore';
import { ContextEngine } from './harness/ContextEngine';
import { createLLMVerifier } from './coding-agent/Verifier';
import { Planner, formatTrapPrompt, detectArtifactRequest, formatArtifactPrompt } from './coding-agent/Planner';
import { DefaultHookRouter } from './engine/HookRouter';
import { DefaultFailurePolicy } from './engine/FailurePolicy';
import { ToolRegistry } from './coding-agent/ToolRegistry';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler } from './cli_permission';
import { dim, bold, red, green, yellow, cyan, purple, frameGray } from './termcolors';
import { FSMemoryStore } from './adapter/memory/FSMemoryStore';
import { harvestUserPreferences } from './shared/memory';
import type { BudgetConfig, EngineEvent, IStateStore, LLMAdapter, Message, ToolAdapter, ToolDefinition } from './shared/types';

// ── CLI persistence paths (file-based, since Bun doesn't have localStorage) ──

const HOME = process.env.HOME || '/tmp';
const PURE_DIR = `${HOME}/.pure`;
const CONFIG_PATH = `${PURE_DIR}/config.json`;

// Persisted provider credentials. Mirror of the GUI's PureConfig (src/ui/settings.ts),
// but stored on disk so the Node/Bun CLI can read them. The GUI's localStorage
// config is browser-only and cannot be reached from the CLI.
interface PureConfig {
  provider: CliArgs['provider'];
  apiKey: string;
  model: string;
  workspace?: string;
}

function loadConfig(): PureConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    if (!raw) return null;
    const cfg = JSON.parse(raw) as Partial<PureConfig>;
    if (cfg && cfg.apiKey && cfg.provider) return cfg as PureConfig;
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

// ── CLI cross-session memory (IMemoryStore) ──
// File-backed store under ~/.pure/memories/{projectHash}/memories.jsonl,
// replacing the old single ~/.pure/memory.json UserProfile. The Harness
// searches it at session start (PromptComposer injects the top memories into
// the system prompt) and writes a successful_pattern when a session completes.
const memoryStore = new FSMemoryStore(`${PURE_DIR}/memories`);

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

  // Shrink-to-fit so the box never wraps on narrow terminals (CI, ssh, narrow tmux panes).
  // Default inner (76) yields exactly 80 cols including the leading 2-space indent.
  const INDENT = 2;
  const WANT_INNER = 76;
  const cols = process.stdout.columns ?? 80;
  const inner = Math.min(WANT_INNER, Math.max(40, cols - INDENT - 2));
  const border = '═'.repeat(inner);
  const blank = ' '.repeat(inner);

  // Each wordmark row: 4 letters (10 each) + 3 single-space gaps + 2 cols tail.
  // Row 5 substitutes the trailing whitespace slot with a purple · flush against E,
  // keeping every row uniform at 45 visible cols.
  const W = 10 * 4 + 3 + 2;
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
  const ver = 'v0.9.7';

  console.log('');
  console.log(`  ${F('╔' + border + '╗')}`);
  console.log(`  ${F('║')}${blank}${F('║')}`);
  for (const row of lines) {
    console.log(`  ${F('║')}${center(W, row)}${F('║')}`);
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
// human who has already read the prompt — they own the consequences of any
// tool call the agent makes, so we auto-approve by default. `--prompt-on-tool`
// (handled in parseArgs) inverts this for users who want the original
// interactive y/n/a flow. The `createCliPermissionHandler` function-level
// default of `false` is unrelated — see its JSDoc for why the two are
// intentionally flipped.
const DEFAULT_CLI_AUTO_APPROVE = true;

const BASE_SYSTEM_PROMPT = `You are pure, a coding agent with file, search, web, and command tools.

File tools:
- read_file(path, startLine?, endLine?) — read file content
- write_file(path, content) — create or overwrite a file
- edit_file(path, oldString, newString, allowMultiple?) — string replacement in a file
- list_files(path?, recursive?) — list directory contents
- search_files(pattern, path?, filePattern?, maxResults?) — grep for text in files
- glob_files(pattern, path?, maxResults?) — find files matching a glob pattern (e.g. "**/*.ts")
- create_directory(path) — create a directory (and parents)
- diff_files(pathA, pathB) — unified diff between two files
- replace_files(files[], oldString, newString, allowMultiple?) — batch string replacement across multiple files

Shell & Git:
- execute_command(command) — run a shell command
- git_diff(staged?, path?) — show git diff
- git_log(maxCount?, oneline?) — recent commit history
- git_status — working tree status

System:
- sys_info() — timezone, language, current time, OS version. When the user asks for the current time, date, timezone, language, or OS version, call sys_info() FIRST — never guess from your training data.

Web tools:
- web_search(query, maxResults?) — DuckDuckGo web search (no API key needed)
- web_fetch(url, maxChars?) — fetch and extract readable text from a text/HTML/JSON page. If web_fetch reports an unsupported content type, do NOT retry the same URL — use web_search instead or pick a different page.

Work step by step. Read before you write. Verify after you change. Be concise.

Output style:
- Default to inline replies for questions, explanations, and SHORT code snippets: render them directly in your response (use fenced markdown code blocks for code). Call write_file / edit_file / replace_files ONLY when the user explicitly asks to save or persist to disk, names a target path, or the task requires on-disk artifacts (e.g. "scaffold a project at /tmp/foo", "create README.md", "fix this file").
- A bare "generate X", "show me X", "give me X", "what does X look like", or any "write me code for…" without a path means inline output — never reach for write_file.
- COMPLETE runnable artifacts go to disk by default: when the user asks you to BUILD a full game, mini-game, web page/site, app, tool, script, or small project ("写一个小游戏", "做一个网页", "开发一个工具" — even without naming a path), WRITE it to a file instead of printing the whole source inline. Single-file artifact → a new file like index.html / game.html / app.py in the workspace; multi-file project → a new directory with the files. After writing, state the path(s) and how to run/open it.
- When you do write a file, briefly state where it landed and confirm the user actually wanted persistence; the EXISTENCE of a workspace does NOT imply "save everything to disk".

Tool-calling rules:
- NEVER emit tool calls as XML or text (no <tool_calls>, <invoke name="...">, or JSON inside your reply). Tool calls are made ONLY through the function-calling interface, never as visible text.
- Mirror the GUI's rule (chat.ts BASE_SYSTEM_PROMPT) so piped / non-interactive CLI runs don't regress to the old leak pattern if a model picks it up. The "no workspace → ask the user to set one" bullet is GUI-specific and omitted here — the CLI defaults workspace to '.' already.

Smart typo tolerance: when the user's message contains obvious typos, pinyin / IME errors ('ji' mapped to the wrong hanzi, homophone slips, repeated/reordered/full-width-punctuation typos), infer their intended meaning, answer that, and briefly note your assumption at the top of the reply (e.g., "Assuming you meant …").

Logical traps & approach switching:
- Before acting, scan the user's request for logical traps: self-contradictory requirements ("不要X但又要X"), impossible constraints, mutually exclusive goals, or a trick premise. If the request as stated is logically impossible or self-contradictory, do NOT blindly follow it into a failure loop — state the trap briefly and solve the most reasonable interpretation (or explain why it is impossible and propose the closest achievable alternative).
- If your FIRST attempt fails (verification failure, repeated tool errors, or the result keeps getting rejected), do NOT retry the same approach a second time. Re-read the ORIGINAL user request and question whether the premise itself is the problem. If it is, escape the trap by switching to a fundamentally different interpretation or method.`;

function buildSystemPrompt(): string {
  // Memory is composed by the Harness at session start (PromptComposer + the
  // IMemoryStore), so the base prompt stays clean here.
  return BASE_SYSTEM_PROMPT;
}

// ── Types ──

interface CliArgs {
  prompt: string;
  provider: 'deepseek-openai' | 'deepseek-anthropic' | 'qwen' | 'glm' | 'mock';
  model: string;
  apiKey: string;
  workspace: string;
  resume: string;
  stateDb: string;
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
    ? flags.provider as CliArgs['provider']
    : (hasAnyApiKeyEnv() ? envProvider : (fileCfg?.provider ?? envProvider));

  const apiKey =
    flags['api-key'] ??
    envKeyForProvider(provider) ??
    fileCfg?.apiKey ??
    '';

  const model = flags.model ?? fileCfg?.model ?? resolveDefaultModel(provider);
  const workspace =
    (flags.workspace && flags.workspace !== 'true') ? flags.workspace : (fileCfg?.workspace || '.');
  const resume = flags.resume && flags.resume !== 'true' ? flags.resume : '';
  const stateDb = flags['state-db'] ?? '';
  // CLI default: trust the operator — approve every tool call. The flag is
  // a one-way opt-out (`--prompt-on-tool`) so users who want the original
  // interactive confirmation flow can still get it. No positive opt-in
  // flag is needed because the default already matches the common case.
  const autoApprove = DEFAULT_CLI_AUTO_APPROVE && flags['prompt-on-tool'] === undefined;

  return {
    args: { prompt: promptParts.join(' '), provider, model, apiKey, workspace, resume, stateDb, autoApprove },
    command,
  };
}

/** Pick the right env var for a provider so we honor per-provider keys, not just any key. */
function envKeyForProvider(provider: CliArgs['provider']): string | undefined {
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

function resolveDefaultModel(provider: string): string {
  switch (provider) {
    case 'deepseek-openai': return 'deepseek-v4-flash';
    case 'deepseek-anthropic': return 'deepseek-v4-flash';
    case 'qwen': return 'qwen3-coder-next';
    case 'glm': return 'glm-5.2';
    case 'mock': return 'mock';
    default: return 'deepseek-v4-flash';
  }
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

  if (!args.apiKey) {
    console.error(`${red('❌')} No API key configured for ${cyan(args.provider)}.`);
    console.error(`    ${dim('Run')} ${bold('pure config')} ${dim('to set up your provider and API key once for all sessions.')}`);
    console.error(`    ${dim('Or pass it inline:')} ${bold('pure --api-key <key>')}`);
    console.error(`    ${dim('Or set an env var:')}  DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / ZHIPU_API_KEY`);
    process.exit(1);
  }

  switch (args.provider) {
    case 'deepseek-anthropic':
      return { adapter: new DeepSeekAnthropicAdapter({ apiKey: args.apiKey, model: args.model }), label: `DeepSeek Anthropic (${args.model})` };
    case 'qwen': {
      const wsId = process.env.DASHSCOPE_WORKSPACE_ID ?? '';
      if (!wsId) { console.error('❌ Qwen requires DASHSCOPE_WORKSPACE_ID env var'); process.exit(1); }
      return { adapter: createQwenAdapter(args.apiKey, wsId, args.model), label: `Qwen (${args.model})` };
    }
    case 'glm':
      return { adapter: createGLMAdapter(args.apiKey, args.model), label: `GLM (${args.model})` };
    case 'deepseek-openai':
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model), label: `DeepSeek OpenAI (${args.model})` };
    default:
      return { adapter: createDeepSeekAdapter(args.apiKey, args.model), label: `${args.provider} (${args.model})` };
  }
}

function createTools(workspace: string, autoApprove = false): { tools?: ToolAdapter; toolsDefs: ToolDefinition[] } {
  if (!workspace) return { toolsDefs: [] };

  const resolved = workspace.startsWith('/') ? workspace : `${process.cwd()}/${workspace}`;
  const adapter = new NodeToolAdapter({ workspace: resolved });

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

  return { tools: registry, toolsDefs: adapter.getTools() };
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
  let thinkingText = '';
  // Once the visible answer has begun streaming, never open another thinking
  // line — a stray ReasoningDelta after the answer would otherwise wipe the
  // mid-stream answer line with its \r\x1b[2K redraw (engine emits reasoning
  // strictly before content per iteration, so this is purely defensive).
  let answered = false;
  const startThinking = () => {
    if (!tty || thinking || answered) return;
    thinking = true;
    thinkingText = '';
    process.stdout.write(`  ${purple('💭')} ${dim('thinking…')}`);
  };
  const updateThinking = (delta: string) => {
    if (!tty || !thinking) return;
    thinkingText += delta;
    const cols = process.stdout.columns || 80;
    const max = Math.max(20, cols - 14);
    const preview = thinkingText.replace(/\s+/g, ' ').trim();
    const shown = preview.length > max ? '…' + preview.slice(-(max - 1)) : preview;
    process.stdout.write(`\r\x1b[2K  ${purple('💭')} ${dim(shown || 'thinking…')}`);
  };
  const endThinking = () => {
    if (!tty || !thinking) return;
    thinking = false;
    thinkingText = '';
    process.stdout.write('\n');
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
          streamMgr.feed(event);
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
          const status = event.payload.result.success ? green('✓') : red('✗');
          process.stdout.write(`  ${purple(`🔧 ${event.payload.toolName}`)}: ${status} ${dim(`(${event.payload.duration}ms)`)}\n`);
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
    endThinking();
    streamMgr.stop();
  }
  return { output: finalOutput, messages, turnCount, ok };
}

// ── Storage factory ──

function createStore(args: CliArgs): IStateStore | undefined {
  if (args.stateDb) return new SQLiteStore(args.stateDb);
  return new FSStore();
}

// ── Harness factory ──

function createHarness(args: CliArgs) {
  const { adapter } = createAdapter(args);
  const { tools, toolsDefs } = createTools(args.workspace, args.autoApprove);
  const sessionId = args.resume || `session_${Date.now()}`;
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
    // G-3 fix: wire the ContextEngine (with LLM summarization fallback) into
    // the CLI too — long REPL sessions previously grew without bound because
    // the CLI's Harness never had a contextEngine configured.
    contextEngine: new ContextEngine({ maxMessages: 20, llm: adapter }),
    // LLM-based verification in the VERIFY phase: the model checks the final
    // output against the task (with a non-empty-output fast-fail pre-check).
    verifier: createLLMVerifier(adapter),
    // Lifecycle hooks + escalating failure recovery policy.
    hooks: new DefaultHookRouter(),
    failurePolicy: new DefaultFailurePolicy(),
  });

  return { harness, toolsDefs, store, sessionId, projectPath };
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
    // Provider
    const providerKeys = Object.keys(PROVIDER_LABELS) as Array<Exclude<CliArgs['provider'], 'mock'>>;
    process.stdout.write(`  ${dim('Available providers:')}\n`);
    providerKeys.forEach((k, i) => {
      const marker = existing?.provider === k ? green(' ← current') : '';
      process.stdout.write(`    ${cyan(String(i + 1))}) ${PROVIDER_LABELS[k]}${marker}\n`);
    });
    const currentIdx = existing && existing.provider !== 'mock' ? providerKeys.indexOf(existing.provider) : -1;
    const defaultHint = currentIdx >= 0 ? String(currentIdx + 1) : '1';
    const providerIdxRaw = await ask(`\n  ${bold('Choose provider')} ${dim(`[1-${providerKeys.length}]`)} ${dim(`(default ${defaultHint})`)}: `);
    let providerIdx = providerIdxRaw ? parseInt(providerIdxRaw, 10) - 1 : (currentIdx >= 0 ? currentIdx : 0);
    if (Number.isNaN(providerIdx) || providerIdx < 0 || providerIdx >= providerKeys.length) providerIdx = 0;
    const provider = providerKeys[providerIdx];

    // API key — raw-mode masked read so the user sees `*` per character and
    // gets a post-paste confirmation like `✓ Captured 51 chars (sk-…XX)`.
    // The key itself never appears in scrollback.
    process.stdout.write(`\n  ${dim(`Get your key from the provider, then paste it below. Env var: ${PROVIDER_ENV_HINT[provider]}`)}\n`);
    const apiKeyRaw = await askMasked(`  ${bold('API key')}${existing?.apiKey ? dim(' (Enter to keep current)') : ''}: `);
    const apiKey = apiKeyRaw.trim();
    if (apiKey && process.stdin.isTTY) {
      // First 3 + last 2 chars (e.g. `sk-…XX`) so the user can verify they
      // pasted the right key without seeing the whole secret.
      const preview = apiKey.length > 5 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}` : '***';
      process.stdout.write(`  ${green('✓')} Captured ${apiKey.length} chars (${preview})\n`);
    }
    const finalKey = apiKey || existing?.apiKey || '';
    if (!finalKey) {
      process.stdout.write(`\n  ${red('❌ An API key is required. Aborting.')}\n`);
      process.exit(1);
    }

    // Model
    const defaultModel = resolveDefaultModel(provider);
    const modelRaw = await ask(`\n  ${bold('Model')} ${dim(`(Enter for default: ${defaultModel})`)}: `);
    const model = modelRaw || existing?.model || defaultModel;

    // Workspace (optional)
    const workspaceRaw = await ask(`  ${bold('Workspace')} ${dim('(Enter for current dir ".")')}: `);
    const workspace = workspaceRaw || existing?.workspace || '.';

    const cfg: PureConfig = { provider, apiKey: finalKey, model, workspace };
    saveConfig(cfg);

    console.log('');
    process.stdout.write(`  ${green('✅ Saved.')} ${dim('Config written to')} ${CONFIG_PATH}\n`);
    process.stdout.write(`     ${dim('Provider:')} ${cyan(PROVIDER_LABELS[provider])}\n`);
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
  const { toolsDefs } = createTools(args.workspace, args.autoApprove);
  const hasTools = toolsDefs.length > 0;

  const { harness, sessionId, projectPath } = createHarness(args);
  await learnFromInput(args.prompt, sessionId, projectPath);

  renderLogo();
  console.log(`  ${bold('pure')} ${dim('v0.9.7')} ${dim('—')} ${cyan(label)}`);
  if (hasTools) console.log(`  📁 ${dim('Workspace:')} ${process.cwd()} ${dim('(' + toolsDefs.length + ' tools)')}`);
  if (args.resume) console.log(`  💾 ${dim('Session:')} ${sessionId.slice(0, 12)}…`);
  console.log(`  📝 ${args.prompt}`);
  console.log(dim('─'.repeat(50)));

  // Logical-trap pre-scan: if the request itself is contradictory/impossible,
  // warn the user and inject the trap notice into the system prompt so the
  // model verifies the premise instead of following it into a failure loop.
  const traps = new Planner().analyzeTask(args.prompt).traps;
  if (traps.length > 0) {
    console.log(`  ${yellow('⚠')} ${yellow('potential logical trap')} ${dim('— verifying premise')}`);
  }
  const systemPrompt = buildSystemPrompt() + formatTrapPrompt(traps) + (detectArtifactRequest(args.prompt) ? formatArtifactPrompt() : '');

  const streamMgr = new StreamManager(chunk => process.stdout.write(chunk), { flushIntervalMs: 16 });
  streamMgr.start();

  const startTime = Date.now();
  const { turnCount, ok } = await consumeTurn(harness.run(systemPrompt, args.prompt), streamMgr);

  process.stdout.write('\n');
  console.log(dim('─'.repeat(50)));
  const emoji = ok ? green('✅') : red('❌');
  const time = dim(`${Date.now() - startTime}ms`);
  const turn = dim(`| turn ${turnCount}`);
  process.stdout.write(`  ${emoji} ${time} ${turn}\n`);
}

// ── REPL mode ──

async function runRepl(args: CliArgs) {
  const { adapter, label } = createAdapter(args);
  const { toolsDefs } = createTools(args.workspace, args.autoApprove);
  const hasTools = toolsDefs.length > 0;

  const { harness, sessionId, projectPath } = createHarness(args);

  renderLogo();
  process.stdout.write(`  ${bold('pure')} ${dim('v0.9.7')} ${dim('—')} ${cyan(label)}\n`);
  if (hasTools) process.stdout.write(`  📁 ${dim(process.cwd())} ${dim(`| ${toolsDefs.length} tools`)}\n`);
  process.stdout.write(`  💾 ${dim(sessionId.slice(0, 12))}…\n`);
  process.stdout.write(`  ${dim('/exit /quit — leave   /clear — reset context   Ctrl+C — cancel')}\n`);
  console.log('');

  let messages: Message[] = [];
  let turnNum = 1;
  let firstTurn = true;
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
        process.exit(0);
      }
      currentAbort.abort();
      process.stdout.write('\n  ⏹️  Cancelling... (press Ctrl+C again to force quit)\n');
      return;
    }
    process.stdout.write('\n  👋 Goodbye.\n');
    rl.close();
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

    if (input === '/exit' || input === '/quit') { process.stdout.write(`  ${dim('👋 Goodbye.')}\n`); break; }
    if (input === '/clear') {
      messages = []; firstTurn = true; turnNum = 1;
      process.stdout.write(`  ${dim('🧹 Context cleared.')}\n`);
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
    const traps = new Planner().analyzeTask(input).traps;
    if (traps.length > 0) {
      process.stdout.write(`  ${yellow('⚠')} ${yellow('potential logical trap')} ${dim('— verifying premise')}\n`);
    }
    const systemPrompt = buildSystemPrompt() + formatTrapPrompt(traps) + (detectArtifactRequest(input) ? formatArtifactPrompt() : '');

    const events = firstTurn
      ? harness.run(systemPrompt, input, currentAbort.signal)
      : harness.continueTurn(systemPrompt, messages, input, currentAbort.signal);

    const result = await consumeTurn(events, streamMgr);
    const wasAborted = currentAbort.signal.aborted;
    generating = false;
    currentAbort = null;

    if (result.ok) {
      process.stdout.write('\n');
      const time = dim(`${Date.now() - startTime}ms`);
      const turn = dim(`| turn ${turnNum}`);
      process.stdout.write(`  ${green('✅')} ${time} ${turn}\n`);
      messages = result.messages.length > 0 ? result.messages : messages;
      firstTurn = false;
      turnNum++;
    } else if (wasAborted) {
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
