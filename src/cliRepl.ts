// src/cliRepl.ts
// CLI run-loop layer — split out of src/cli.ts (audit ①). Owns the interactive
// and one-shot loops (runRepl / runOneShot), the shared engine-event consumer
// (consumeTurn), the delivery gate (+ quality-repair rounds), and the banner /
// prompt-assembly / print helpers those loops need. Depends on cliConfig +
// cliAdapter + cliHarness — never on cli.ts itself (acyclic graph).
import * as readline from 'node:readline';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import { StreamManager } from './harness/StreamManager';
import { CliWireframeStream } from './shared/cliDiagram';
import { compileRequestWorkflow, type RequestWorkflowStage } from './shared/requestWorkflow';
import { inferSemanticRoute, isPlainConversational, shouldBypassSemanticRoute } from './coding-agent/Planner';
import type { IntentAssessment, TaskMode } from './coding-agent/types';
import { ToolRegistry } from './coding-agent/ToolRegistry';
import { PermissionManager } from './coding-agent/PermissionManager';
import { createCliPermissionHandler } from './cli_permission';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES } from './coding-agent/SubagentOrchestrator';
import { dim, bold, red, green, yellow, cyan, purple, frameGray } from './termcolors';
import { sanitizeForTerminal } from './termwidth';
import { ThinkingCard } from './cli-thinking';
import { formatToolErrorLine, logoRowPlan, LOGO_WORDMARK_W } from './cli_toolrow';
import { buildCliCapabilities, formatPromptBudgetDiagnostic, promptAssembler, type PromptSkill } from './shared/PromptAssembler';
import { loadMergedConventions, getAppSpaceRoot, readAgentsMdAt, ensureAgentsMdAt } from './shared/conventions';
import { DEFAULT_AGENTS_MD } from './shared/defaultAgentsMd';
import { buildShellContext } from './shared/shellEnv';
import { parseSkillMarkdown } from './shared/skillFiles';
import { mergeTranscriptWithTurn } from './shared/conversation';
import { formatCliIntentAssessment, resolveCliAutoApprove } from './cliIntent';
import { promptBudgetForProvider } from './shared/providers';
import { detectNetworkSummary, detectRuntimeVersions } from './adapter/node/NodeToolAdapter';
import { buildTaskContract, discoverWorkspace, formatTaskContract, workspaceProfileSummary, type TaskContract, type WorkspaceProfile } from './shared/delivery';
import { buildRepairPrompt, hasRepairableQualityFindings, qualityGateSummary, runProjectQualityGate, type ProjectQualityGateResult } from './ui/projectQualityGate';
import type { Harness } from './harness/Harness';
import type { EngineEvent, Message, ToolAdapter, ToolDefinition } from './shared/types';
import type { UserTurnContext } from './shared/promptLayers';
import { loadConfig, DEFAULT_CLI_AUTO_APPROVE, PURE_DIR } from './cliConfig';
import type { CliArgs } from './cliConfig';
import { createAdapter } from './cliAdapter';
import { createHarness, learnFromInput } from './cliHarness';

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
  return 'v1.9.7';
}

const CLI_VERSION = resolveCliVersion();

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

// Network environment pre-seed, mirroring the GUI: sync detection (system
// proxy / env proxy / VPN) at prompt build, cached per process — live
// reachability stays in sys_info(), which the NodeToolAdapter reports on
// demand.
let cachedNetwork: string | null = null;
function buildNetworkContext(): string {
  if (cachedNetwork === null) cachedNetwork = detectNetworkSummary();
  return `\nEnvironment network (this machine): ${cachedNetwork}. Use it to choose what will actually work: if international is blocked, prefer domestic search engines (cn.bing.com / sogou / baidu / 360) and domestic sources, and expect Google/DuckDuckGo to fail; if a system/env proxy is listed, requests route through it when proxy is enabled.`;
}

// OS/shell pre-seed mirroring the GUI: the CLI backend (NodeToolAdapter)
// executes through PowerShell on Windows and `sh -c` elsewhere, so the model
// gets the matching command syntax instead of guessing `mkdir -p` on Windows.
function buildShellContextLine(): string {
  return buildShellContext(`${process.platform} ${process.arch}`);
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

async function assembleCliPrompt(
  mode: TaskMode,
  args: CliArgs,
  toolsDefs: ToolDefinition[],
  userText: string,
  context: UserTurnContext,
) {
  const userWorkspace = args.workspace && args.workspace !== 'true'
    ? args.workspace
    : (loadConfig()?.workspace || process.cwd());
  const appAgentsRoot = getAppSpaceRoot();
  const appAgents = (await readAgentsMdAt(appAgentsRoot)) || DEFAULT_AGENTS_MD;
  await ensureAgentsMdAt(PURE_DIR, appAgents);
  const conventions = await loadMergedConventions({
    appSpaceRoot: appAgentsRoot,
    globalUserRoot: PURE_DIR,
    userSpaceRoot: userWorkspace,
  });
  // Only enable the multi_agent protocol when subagent tools are actually in
  // the model-visible list (workspace mode). Plain-chat mode returns an empty
  // toolsDefs and must not be told to delegate.
  const subagentNames = new Set([...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => d.name));
  const hasSubagents = toolsDefs.some((t) => subagentNames.has(t.name));
  return promptAssembler.assemble({
    surface: 'cli',
    capabilities: buildCliCapabilities(),
    toolDefinitions: toolsDefs,
    modelIdentity: args.model ? { provider: args.provider, model: args.model } : undefined,
    environment: buildEnvironmentContext(),
    runtimes: buildRuntimesContext(),
    network: buildNetworkContext(),
    shell: buildShellContextLine(),
    skills: [...(loadConfig()?.hubSkills ?? []), ...loadAppSkills()],
    mode,
    budget: promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides),
    conventions,
    // The CLI merges subagent tools into toolsDefs when it has a workspace, so
    // delegation is possible — enable the multi_agent protocol fragment. Gated
    // on actual subagent tool presence (see hasSubagents above).
    hasSubagents,
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
      const icon = status === 'active' ? '●' : status === 'passed' ? '✓' : status === 'failed' ? '✗' : status === 'not_applicable' ? '–' : '!';
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
  const semanticRoute = (shouldBypassSemanticRoute(args.prompt) || isPlainConversational(args.prompt))
    ? null
    : await inferSemanticRoute(adapter, args.prompt);
  const workflow = compileRequestWorkflow(args.prompt, { hasTools, semanticRoute });
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
  const assembly = await assembleCliPrompt(analysis.mode, args, toolsDefs, args.prompt, {
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
  const result = await consumeTurn(harness.run(systemPrompt, userTurn, undefined, undefined, semanticRoute), streamMgr);
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
    const semanticRoute = (shouldBypassSemanticRoute(input) || isPlainConversational(input))
      ? null
      : await inferSemanticRoute(adapter, input, currentAbort.signal);
    const workflow = compileRequestWorkflow(input, { hasTools: toolsDefs.length > 0, semanticRoute });
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
    const assembly = await assembleCliPrompt(analysis.mode, args, toolsDefs, input, {
      ...workflow.userContext,
      contract: taskContract ? formatTaskContract(taskContract) : undefined,
    });
    const systemPrompt = assembly.systemPrompt;
    const userTurn = assembly.userPrompt ?? input;

    const historyMessages = compactedHistory && compactedTranscriptLength === messages.length
      ? compactedHistory
      : messages;
    const events = firstTurn
      ? harness.run(systemPrompt, userTurn, currentAbort.signal, undefined, semanticRoute)
      : harness.continueTurn(systemPrompt, historyMessages, userTurn, currentAbort.signal, undefined, semanticRoute);

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

export { renderLogo, runOneShot, runRepl };
