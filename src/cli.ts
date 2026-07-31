// src/cli.ts
// v0.6.0 — one-shot + interactive REPL with self-evolving memory.
// Usage: pure "question"              → one-shot
//        pure --resume abc123          → resume session
//        pure --workspace .            → REPL
//        pure config                   → set up provider + API key (persisted to ~/.pure/config.json)

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { DefaultHookRouter } from './engine/HookRouter';
import { DefaultFailurePolicy } from './engine/FailurePolicy';
import { ToolRegistry } from './coding-agent/ToolRegistry';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler } from './cli_permission';
import { dim, bold, red, green, yellow, blue, cyan, magenta, frameGray } from './termcolors';
import { MemoryEngine } from './shared/memory';
import type { UserProfile } from './shared/memory';
import type { BudgetConfig, EngineEvent, IStateStore, LLMAdapter, Message, ToolAdapter, ToolDefinition } from './shared/types';

// ── CLI persistence paths (file-based, since Bun doesn't have localStorage) ──

const HOME = process.env.HOME || '/tmp';
const PURE_DIR = `${HOME}/.pure`;
const MEMORY_PATH = `${PURE_DIR}/memory.json`;
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

// ── CLI memory persistence ──

function loadCliMemory(): UserProfile | null {
  try {
    if (!existsSync(MEMORY_PATH)) return null;
    const raw = readFileSync(MEMORY_PATH, 'utf-8');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCliMemory(profile: UserProfile): void {
  try {
    mkdirSync(dirname(MEMORY_PATH), { recursive: true });
    writeFileSync(MEMORY_PATH, JSON.stringify(profile), 'utf-8');
  } catch {}
}

const memory = new MemoryEngine(loadCliMemory() ?? undefined);

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
  const ver = 'v0.6.0';

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
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

const BASE_SYSTEM_PROMPT = `You are pure, a coding agent. You have access to file and command tools.
When using tools:
- read_file: read file content, supports line ranges
- write_file: create or overwrite files
- edit_file: find and replace text in files
- search_files: search for patterns in files
- list_files: list directory contents
- execute_command: run shell commands

Work step by step. Read before you write. Verify after you change. Be concise.

Smart typo tolerance: when the user's message contains obvious typos, pinyin / IME errors ('ji' mapped to the wrong hanzi, homophone slips, repeated/reordered/full-width-punctuation typos), infer their intended meaning, answer that, and briefly note your assumption at the top of the reply (e.g., "Assuming you meant …").`;

function buildSystemPrompt(): string {
  const mem = memory.buildMemoryPrompt();
  return mem ? `${BASE_SYSTEM_PROMPT}${mem}` : BASE_SYSTEM_PROMPT;
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

  return {
    args: { prompt: promptParts.join(' '), provider, model, apiKey, workspace, resume, stateDb },
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

function createTools(workspace: string): { tools?: ToolAdapter; toolsDefs: ToolDefinition[] } {
  if (!workspace) return { toolsDefs: [] };

  const resolved = workspace.startsWith('/') ? workspace : `${process.cwd()}/${workspace}`;
  const adapter = new NodeToolAdapter({ workspace: resolved });

  // P1-8: wire PermissionManager + write confirmation into the CLI direct
  // path. The engine executes tools through ctx.tools; wrapping the adapter
  // in a ToolRegistry puts every call behind the same permission gate the GUI
  // uses (read auto-approve / write + command confirm / session cache).
  // toolsDefs stay the adapter's own (the 6 CLI-available tools) so the LLM
  // never sees registry-only git_* tools it cannot actually call.
  const registry = new ToolRegistry(adapter);
  registry.setPermissionManager(new PermissionManager('NORMAL', createCliPermissionHandler()));

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

  for await (const event of events) {
    switch (event.type) {
      case 'StateChange':
        streamMgr.stop();
        process.stdout.write('\n');
        process.stdout.write(`  ${dim('[')}${blue(event.payload.from)}${dim(' → ')}${cyan(event.payload.to)}${dim(']')}\n`);
        streamMgr.start();
        break;
      case 'TokenDelta':
        streamMgr.feed(event);
        break;
      case 'ToolResult':
        streamMgr.stop();
        const status = event.payload.result.success ? green('✓') : red('✗');
        process.stdout.write(`  ${magenta('🔧')} ${cyan(event.payload.toolName)}: ${status} ${dim(`(${event.payload.duration}ms)`)}\n`);
        streamMgr.start();
        break;
      case 'Completed':
        streamMgr.stop();
        finalOutput = event.payload.finalOutput ?? '';
        messages = event.payload.messages ?? [];
        turnCount = event.payload.turnCount;
        break;
      case 'Error':
        streamMgr.stop();
        process.stdout.write(`\n  ${red('⚠')}  ${red(event.payload.code)}: ${dim(event.payload.message)}\n`);
        ok = false;
        break;
      case 'Interrupted':
        streamMgr.stop();
        process.stdout.write(`\n  ${yellow('⏹')}  ${dim(event.payload.reason)}\n`);
        ok = false;
        break;
    }
  }

  streamMgr.stop();
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
  const { tools, toolsDefs } = createTools(args.workspace);
  const sessionId = args.resume || `session_${Date.now()}`;
  const store = args.resume ? createStore(args) : undefined;

  const harness = new Harness({
    sessionId,
    llm: adapter,
    tools,
    toolsDefs,
    budget: DEFAULT_BUDGET,
    stateStore: store,
    // LLM-based verification in the VERIFY phase: the model checks the final
    // output against the task (with a non-empty-output fast-fail pre-check).
    verifier: createLLMVerifier(adapter),
    // Lifecycle hooks + escalating failure recovery policy.
    hooks: new DefaultHookRouter(),
    failurePolicy: new DefaultFailurePolicy(),
  });

  return { harness, toolsDefs, store, sessionId };
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
  const { toolsDefs } = createTools(args.workspace);
  const hasTools = toolsDefs.length > 0;

  const { harness, sessionId } = createHarness(args);

  memory.learnFromMessage(args.prompt);

  renderLogo();
  console.log(`  ${bold('pure')} ${dim('v0.6.0')} ${dim('—')} ${cyan(label)}`);
  if (hasTools) console.log(`  📁 ${dim('Workspace:')} ${process.cwd()} ${dim('(' + toolsDefs.length + ' tools)')}`);
  if (args.resume) console.log(`  💾 ${dim('Session:')} ${sessionId.slice(0, 12)}…`);
  console.log(`  📝 ${args.prompt}`);
  console.log(dim('─'.repeat(50)));

  const streamMgr = new StreamManager(chunk => process.stdout.write(chunk), { flushIntervalMs: 16 });
  streamMgr.start();

  const startTime = Date.now();
  const { output, turnCount, ok } = await consumeTurn(harness.run(buildSystemPrompt(), args.prompt), streamMgr);

  saveCliMemory(memory.getProfile());

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
  const { toolsDefs } = createTools(args.workspace);
  const hasTools = toolsDefs.length > 0;

  const { harness, sessionId } = createHarness(args);

  renderLogo();
  process.stdout.write(`  ${bold('pure')} ${dim('v0.6.0')} ${dim('—')} ${cyan(label)}\n`);
  if (hasTools) process.stdout.write(`  📁 ${dim(process.cwd())} ${dim(`| ${toolsDefs.length} tools`)}\n`);
  process.stdout.write(`  💾 ${dim(sessionId.slice(0, 12))}…\n`);
  process.stdout.write(`  ${dim('/exit /quit — leave   /clear — reset context   Ctrl+C — cancel')}\n`);
  console.log('');

  let messages: Message[] = [];
  let turnNum = 1;
  let firstTurn = true;
  let generating = false;
  let currentAbort: AbortController | null = null;

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
    return new Promise(resolve => { rl.question('> ', answer => resolve(answer.trim())); });
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
    memory.learnFromMessage(input);

    const events = firstTurn
      ? harness.run(buildSystemPrompt(), input, currentAbort.signal)
      : harness.continueTurn(buildSystemPrompt(), messages, input, currentAbort.signal);

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
