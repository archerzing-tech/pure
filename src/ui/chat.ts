// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, type PureConfig } from './config';
import { defaultModelFor, baseURLFor, isDeepSeekFamily } from '../shared/providers';
import { saveSession, loadLastSession, type StoredMessage, type ToolExecMeta } from './store';
import { LocalStorageMemoryStore } from '../adapter/memory/LocalStorageMemoryStore';
import { WASMEmbeddingStore } from '../adapter/memory/WASMEmbeddingStore';
import { harvestUserPreferences } from '../shared/memory';
import { PROACTIVE_WORKFLOW_PROMPT, COMPLETION_LESSON_PROMPT } from '../shared/agentBehavior';
import { CodingAgent } from '../coding-agent/CodingAgent';
import { formatTrapPrompt, detectArtifactRequest, formatArtifactPrompt, parsePlanJson } from '../coding-agent/Planner';
import { PermissionManager } from '../coding-agent/PermissionManager';
import { createLLMOnlyVerifier, createDefaultVerifier } from '../coding-agent/Verifier';
import { BUILT_IN_SUBAGENTS } from '../coding-agent/SubagentOrchestrator';
import { requestPermission } from './permission';
import {
  requestPlanReview,
  formatPlanForPrompt,
  createPlanCard,
  updatePlanCardPhase,
  finalizePlanCard,
  matchPlanPhaseMarker,
  type PlanCardHandle,
} from './plan';
import { TauriToolAdapter, getWebToolDefs, getSysInfoToolDefs, setToolOutputListener } from './TauriToolAdapter';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { getApplicationTmpWorkspace, isTauriRuntime } from '../shared/tauri';
import { renderMarkdown, scheduleStreamingRender, cancelStreamingRender, stripToolCallXml } from './markdown';
import { linkifyPaths, setPathLinkWorkspace } from './pathLink';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned } from './scrollPin';
import { createToolRow, updateToolRowArgs, finalizeToolRow, markToolRowStopped, appendToolStreamLine, truncateResultLines, type ToolRowHandle } from './toolRow';
import { createThinkingCard, appendThinkingText, finalizeThinkingCard, type ThinkingCardHandle } from './thinkingCard';
import { copyTextToClipboard } from '../shared/clipboard';
import { showToast } from '../shared/toast';
import { t } from '../shared/i18n';
import type { MCPClient } from '../harness/mcp/MCPClient';
import type { FileWatcher } from '../harness/FileWatcher';
import type {
  LLMAdapter,
  EngineEvent,
  ToolAdapter,
  ToolCall,
  ToolResult,
  ToolDefinition,
  Message,
  BudgetConfig,
} from '../shared/types';
import type { PermissionMode, PermissionRequestHandler, PermissionRequestInfo, PermissionDecision, TrapWarning, Plan, TaskMode } from '../coding-agent/types';

// Friendly labels for the logical-trap status bubble (raw type ids like
// 'self-contradiction' are cryptic to users).
const TRAP_TYPE_LABELS: Record<TrapWarning['type'], string> = {
  'self-contradiction': '自相矛盾',
  'impossible-constraint': '不可能满足的约束',
  'mutually-exclusive': '互斥要求',
  'trap-keyword': '悖论/陷阱题',
};

// Tool-call JSON re-parse throttle: streaming a giant argument (write_file
// `content`, a whole HTML file) grows the buffer to tens of KB; re-parsing it
// and rebuilding the Input panel on every token is O(n²) and freezes the UI.
// Mirrors the 100ms streaming-render throttle (markdown.ts).
const TOOL_CALL_REFRESH_MS = 120;

// Transcript DOM cap: bounds #chat's row count so a long session can't grow
// the WebView DOM without limit (every bubble, tool row and thinking card stays
// in memory once appended). Sessions persist to disk, so pruning the oldest
// rows never loses data — reloading the session restores the full history.
// A childList observer funnels every append path (live streaming, restore,
// status bubbles) through one place. Idempotent like wireScrollPin.
const MAX_TRANSCRIPT_ROWS = 300;
const transcriptPruneState = new WeakMap<HTMLElement, MutationObserver>();

export function wireTranscriptPrune(el: HTMLElement): void {
  if (transcriptPruneState.has(el)) return;
  const observer = new MutationObserver(() => {
    const excess = el.childElementCount - MAX_TRANSCRIPT_ROWS;
    if (excess <= 0) return;
    let removed = 0;
    for (const child of Array.from(el.children)) {
      if (removed >= excess) break;
      child.remove();
      removed++;
    }
  });
  transcriptPruneState.set(el, observer);
  observer.observe(el, { childList: true });
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 50,
  maxTotalTokens: 1_000_000,
  maxExecutionTime: 3_600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

// Web tools (web_search / web_fetch) and sys_info work without a workspace —
// the Rust backend's implementations ignore the workspace field (see
// `_workspace: String` in src-tauri/src/lib.rs), so they really are
// filesystem-independent. The remaining tools all read, write, or exec on
// disk and therefore need a workspace.
//
// We split the tool list so web tools + sys_info can be advertised in plain
// chat mode without dragging the rest of the agent-mode prompt along. This
// also keeps the original XML-tool-call leak defense: when a workspace is
// missing, models are only told about the tools they can actually invoke.
const WEB_TOOLS_PROMPT = `Web tools:
- web_search(query, maxResults?) — web search. With a Serper or Tavily API key in Settings → Tools it uses the API backends first (Serper = real Google index, best for Chinese AND English); otherwise free backends are probed in parallel — Sogou + cn.bing.com + DuckDuckGo + Bing for Chinese queries. If a search returns no results or fails, do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.
- web_fetch(url, maxChars?) — fetch and extract readable text from a text/HTML/JSON page. If web_fetch reports an unsupported content type, do NOT retry the same URL — use web_search instead or pick a different page.`;

const FS_TOOLS_PROMPT = `File tools:
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

Path rule: pass file and directory paths relative to the selected workspace root (for example src/app.ts, not the workspace absolute path). The backend also accepts an absolute path only when it is inside the selected workspace; never invent or prepend the workspace twice.`;

// sys_info works without a workspace (the Rust backend ignores the workspace
// field), so it is advertised in BOTH plain-chat and workspace mode.
const SYS_INFO_PROMPT = `System:
- sys_info() — timezone, language, current time, OS version, and the user's configured location. When the user asks for the current time, date, timezone, language, OS version, OR anything that depends on where the user is (trip planning "from my city", weather, delivery, local services, events), call sys_info() FIRST — never guess from your training data. The user can set/override their location in Settings → General → Environment.`;

const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

function isWebTool(name: string): boolean {
  return WEB_TOOL_NAMES.has(name);
}

// File-system tool family — gated by the `toolFS` settings toggle so users can
// disable read/write/edit/search as a group from Settings → Tools.
const FS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'search_files', 'list_files',
  'glob_files', 'create_directory', 'diff_files', 'replace_files',
]);

function isFsTool(name: string): boolean {
  return FS_TOOL_NAMES.has(name);
}

// ── Tool row helpers ──────────────────────────────────────────────────────
// Tool calls render as Claude-Code-style inline rows in the chat transcript
// (`.tool-row`), NOT floating toasts. Each row shows a friendly name, args
// summary, and status (spinner → ✓/✗ + duration); click to expand Input/Output.
// Shared DOM building lives in toolRow.ts so live chat and session replay
// render identically.

type ToolRowEntry = {
  row: ToolRowHandle;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
};

// Parse a tool-call buffer into { name?, args? }. Two formats occur in practice:
// 1. The { name, arguments } wrapper some adapters emit (arguments either a
//    pre-parsed object or a JSON string).
// 2. RAW function-arguments JSON ({"query": "..."}) — the engine forwards
//    tc.function.arguments / chunk.arguments verbatim, which is exactly this
//    format. Without the fallback every tool row rendered with empty args: two
//    parallel web_search calls then looked like ONE duplicated search instead
//    of two queries (see the "两个 web Search 同时出现" report).
export function assistantBubbleTextForCopy(bubble: HTMLElement): string {
  const clone = bubble.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, .svg-slot, .chart-slot, .mermaid-slot, .puml-diagram').forEach((el) => el.remove());
  return (clone.innerText || clone.textContent || '').trim();
}

export function shouldCopyAssistantBubbleTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return true;
  return !(target as Element).closest('button, a, [role="button"], .svg-target, .chart-target, .mermaid-target');
}

export async function copyAssistantBubbleText(
  text: string,
  copy: (value: string) => Promise<boolean> = copyTextToClipboard,
  toast: (message: string) => void = showToast,
): Promise<boolean> {
  if (!text) return false;
  const copied = await copy(text);
  toast(copied ? t('assistant.copied') : t('assistant.copyFailed'));
  return copied;
}

export function bindAssistantBubbleCopy(bubble: HTMLElement): void {
  if (bubble.dataset.assistantCopyBound === '1') return;
  bubble.dataset.assistantCopyBound = '1';
  bubble.addEventListener('dblclick', async (event) => {
    if (!shouldCopyAssistantBubbleTarget(event.target)) return;
    const text = assistantBubbleTextForCopy(bubble);
    if (!text) return;
    void copyAssistantBubbleText(text);
  });
}

export function parseToolCallBuffer(buf: string | undefined): { name?: string; args?: Record<string, unknown> } {
  const trimmed = (buf ?? '').trim();
  if (!trimmed) return {};
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  let args: Record<string, unknown> | undefined;
  if (parsed.arguments && typeof parsed.arguments === 'object') {
    args = parsed.arguments as Record<string, unknown>;
  } else if (typeof parsed.arguments === 'string') {
    try { args = JSON.parse(parsed.arguments) as Record<string, unknown>; } catch { args = undefined; }
  } else if (!('arguments' in parsed) && !name) {
    // Raw arguments object (no wrapper keys): treat the whole parsed object as
    // the args. The `!name` guard keeps a name-only payload from being misread
    // as args.
    args = parsed as Record<string, unknown>;
  }
  return { name, args };
}

// Parse the DuckDuckGo-format result string from src-tauri/src/lib.rs.
// Each result is 3 lines ("N. Title" / snippet / URL), separated by blank
// lines. Returns structured items for clickable-link rendering.
function parseWebSearchResult(resultText: string): Array<{ title: string; snippet: string; url: string }> {
  const out: Array<{ title: string; snippet: string; url: string }> = [];
  if (!resultText) return out;
  const blocks = resultText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const m = lines[0].match(/^\d+\.\s*(.+)$/);
    const title = m ? m[1] : lines[0];
    const snippet = lines[1];
    const url = lines[2];
    if (/^https?:\/\//.test(url)) out.push({ title, snippet, url });
  }
  return out;
}

/**
 * Map a tool name to its settings-toggle gate. Unknown tools (subagents,
 * MCP-discovered, future additions) default to enabled so the gate never
 * silently hides a tool the user didn't explicitly disable.
 */
function isToolEnabled(name: string, config: PureConfig): boolean {
  if (isWebTool(name)) return config.toolBrowser;
  if (name === 'execute_command') return config.toolCmd;
  if (name.startsWith('git_')) return config.toolGit;
  if (isFsTool(name)) return config.toolFS;
  return true;
}

// ── Scroll & status-bubble helpers ──
//
// Pinned-to-bottom tracking and rAF-coalesced auto-scroll live in scrollPin.ts
// (shared with main.ts session restore). The reason it is coalesced: tokens /
// streamed command lines / reasoning deltas can arrive many times per frame,
// and each direct scrollTop write reads scrollHeight (a forced layout on the
// WHOLE transcript — all bubbles, code blocks, SVGs), so per-event scrolling
// is the classic long-transcript stutter. One rAF-scheduled scroll per frame
// caps the cost at the display refresh rate.
//
// Why not a px threshold for pinning? The old approach (scroll only when
// scrollHeight - scrollTop - clientHeight < 120) broke the moment a single
// markdown render grew the transcript by more than the threshold in one step
// — e.g. diffStreaming landing a complete fenced code block in one throttled
// pass, or renderMarkdown replacing the bubble on Completed. The distance
// from bottom then exceeded the threshold and auto-scroll silently stopped
// even though the user never scrolled up, leaving the scrollbar stuck above
// the newest content.

// Resolve every still-pending tool row (stream ended without a ToolResult —
// aborted mid-call, error, or budget stop) so none remains in `pending` state.
// Rows stay in the transcript, marked stopped (⏹) instead of dismissed.
// The per-call parse-throttle map is cleared alongside so stale keys never
// accumulate across turns.
function resolvePendingToolRows(refresh: Map<string, number>, ...maps: Map<string, ToolRowEntry>[]): void {
  refresh.clear();
  for (const map of maps) {
    for (const [, entry] of map) {
      markToolRowStopped(entry.row);
    }
    map.clear();
  }
}

// Plain-chat-mode tool lists: web tools (gated by the toolBrowser toggle) +
// sys_info (always callable without a workspace — the Rust backend ignores
// the workspace field), so the LLM can't generate a function call the hybrid
// adapter will then reject. Schemas come from TauriToolAdapter — single
// source of truth, no drift on field changes.
const WEB_TOOL_DEFS: ToolDefinition[] = getWebToolDefs();
const SYS_INFO_DEFS: ToolDefinition[] = getSysInfoToolDefs();

const BASE_SYSTEM_PROMPT = (hasWorkspace: boolean, temporaryWorkspace = false): string => {
  const persona = hasWorkspace
    ? temporaryWorkspace
      ? 'You are pure, a coding agent with file, search, web, and command tools. No user workspace is selected, so file changes go to an isolated application temporary workspace for this session.'
      : 'You are pure, a coding agent with file, search, web, and command tools.'
    : 'You are pure, a coding assistant with web search, fetch, and system info. No local filesystem or shell access — open Settings → Tools to add a workspace.';
  const toolsBlock = hasWorkspace
    ? `${WEB_TOOLS_PROMPT}\n\n${FS_TOOLS_PROMPT}\n\n${SYS_INFO_PROMPT}`
    : `${WEB_TOOLS_PROMPT}\n\n${SYS_INFO_PROMPT}`;
  return `${persona}\n\n${toolsBlock}

${PROACTIVE_WORKFLOW_PROMPT}

${COMPLETION_LESSON_PROMPT}

Work step by step. Read before you write. Verify after you change. Be concise.

Output style:
- Default to inline replies for questions, explanations, and SHORT code snippets: render them directly in your response (use fenced markdown code blocks for code). Call write_file / edit_file / replace_files ONLY when the user explicitly asks to save or persist to disk, names a target path, or the task requires on-disk artifacts (e.g. "scaffold a project at /tmp/foo", "create README.md", "fix this file").
- Structure longer replies into clear sections — use Markdown headings (##) for each category, short paragraphs for each point, and lists where items fit. Wrap the KEY phrase(s) of each section in ==double equals== (e.g. ==西安到重庆==, ==3 小时 40 分==) so they render HIGHLIGHTED; keep the surrounding prose plain so the highlighted-vs-plain contrast is visible.
- To SHOW a picture/diagram, emit it as a fenced code block tagged svg containing complete standalone SVG — the app renders it inline as an image (diagrams render too: mermaid for flowchart/gantt/sequence, puml for PlantUML).
- To SHOW data as a chart, emit a fenced code block tagged chart: put type: bar|line|pie on its own line (default bar), optional title: and unit: lines, then one label value row per line (e.g. 一月 120, 二月 180). The app renders bar/line/pie charts inline. For weather trends, use one numeric value per day (prefer average temperature; use "周一：25℃" or "周一 | 25"), not a prose-only table.
- For a weather forecast or other time-sensitive data, call web_search FIRST and use the returned forecast data; never invent future weather. If the user did not provide a location, ask for it or state the location assumption clearly. Then include both a concise explanation and a fenced chart block so the GUI renders the image.
- A bare "generate X", "show me X", "give me X", "what does X look like", or any "write me code for…" without a path means inline output — never reach for write_file.
- COMPLETE runnable artifacts go to disk by default: when the user asks you to BUILD a full game, mini-game, web page/site, app, tool, script, or small project ("写一个小游戏", "做一个网页", "开发一个工具" — even without naming a path), WRITE it to a file instead of printing the whole source inline. Single-file artifact → a new file like index.html / game.html / app.py in the workspace; multi-file project → a new directory with the files. After writing, state the path(s) and how to run/open it.
- When you do write a file, briefly state where it landed and confirm the user actually wanted persistence; the EXISTENCE of a workspace does NOT imply "save everything to disk".

Tool-calling rules:
- NEVER emit tool calls as XML or text (no <tool_calls>, <invoke name="...">, or JSON inside your reply).
- Tool calls are made ONLY through the function-calling interface, never as visible text.
- If no user workspace is configured, use the isolated application temporary workspace provided for this session. Do not imply that those files were written into a user-selected project.

Smart typo tolerance: when the user's message contains obvious typos, pinyin / IME errors ('ji' mapped to the wrong hanzi, homophone slips, repeated/reordered/full-width-punctuation typos), infer their intended meaning, answer that, and briefly note your assumption at the top of the reply (e.g., "Assuming you meant …").

Logical traps & approach switching:
- Before acting, scan the user's request for logical traps: self-contradictory requirements ("不要X但又要X"), impossible constraints, mutually exclusive goals, or a trick premise. If the request as stated is logically impossible or self-contradictory, do NOT blindly follow it into a failure loop — state the trap briefly and solve the most reasonable interpretation (or explain why it is impossible and propose the closest achievable alternative).
- If your FIRST attempt fails (verification failure, repeated tool errors, or the result keeps getting rejected), do NOT retry the same approach a second time. Re-read the ORIGINAL user request and question whether the premise itself is the problem. If it is, escape the trap by switching to a fundamentally different interpretation or method.`;
};

// Cross-session memory store (IMemoryStore, localStorage-backed persistence
// wrapped in WASMEmbeddingStore for local vector search per Adapter Layer
// 设计文档 §12.7). The Harness searches it at session start — memories are
// injected into the system prompt via PromptComposer — and writes a
// successful_pattern when a session completes. The Memory skill toggle gates
// both learning and injection (no store passed to CodingAgent = no memory).
// Semantic search is lazy (transformers.js model loads on first search and
// falls back to keyword matching when unavailable), so plain-chat users pay
// no cost until memory is actually retrieved.
const memoryStore = new WASMEmbeddingStore({
  store: new LocalStorageMemoryStore(),
});

// Lightweight environment context injected into every turn's system prompt.
// Time/timezone intentionally stay OUT (they go stale immediately — the model
// calls sys_info() for those); only the location + answer language are stable
// enough to pre-seed. This is what lets "帮我安排一个去上海的旅游计划" resolve
// its departure point to the user's configured city without a lookup.
function buildEnvironmentContext(config: PureConfig | null): string {
  const lang = config?.language === 'en' ? 'English' : 'Chinese (zh-CN)';
  const city = config?.city?.trim();
  if (!city) {
    return `Environment: reply in ${lang}. The user has NOT configured a location — when a task depends on where they are (trip planning, weather, local services), ask for it or state the assumption clearly.`;
  }
  return `Environment: reply in ${lang}; user location is ${city} (configured in Settings → General → Environment). Use ${city} as the user's home base — e.g. the departure point for trip planning, the reference for weather / local services. Call sys_info() for the exact current time, timezone, or OS.`;
}

function buildSystemPrompt(hasWorkspace: boolean, temporaryWorkspace = false, config: PureConfig | null = null): string {
  return `${BASE_SYSTEM_PROMPT(hasWorkspace, temporaryWorkspace)}

${buildEnvironmentContext(config)}`;
}

// ── Permission policy mapping ──
// The settings panel exposes a global permission mode plus fine-grained
// auto-approve toggles per tool category (read / write / cmd / git). Map them
// onto the PermissionManager modes and wrap the dialog handler.

function mapPermissionMode(mode: PureConfig['permissionMode'] | undefined): PermissionMode {
  switch (mode) {
    case 'auto': return 'YOLO';
    case 'restricted': return 'DONT_ASK';
    case 'confirm': return 'NORMAL';
    default: return 'NORMAL';
  }
}

function toolCategory(tool: string): 'read' | 'write' | 'cmd' | 'git' | 'other' {
  if (tool.startsWith('git_')) return 'git';
  if (tool === 'execute_command') return 'cmd';
  if (tool === 'write_file' || tool === 'edit_file' || tool === 'create_directory' || tool === 'replace_files') return 'write';
  // Web tools (DuckDuckGo search + plain HTTP fetch) are pure reads: they
  // never mutate state, never execute code, and the Rust backend restricts
  // web_fetch to text/html + text/plain content types and strips
  // <script>/<style> before returning. Grouping them under 'read' lets the
  // same autoPermRead toggle (default true in settings.ts) silently approve
  // web calls just like local file reads — plain-chat users aren't prompted
  // before every web_search / web_fetch.
  //
  // NB: by short-circuiting here, this branch never reaches PermissionManager,
  // so the "Allow always for this session" option (remember:true) is moot for
  // web reads — auto-approve already covers them per session.
  if (isWebTool(tool) || tool === 'sys_info' || tool === 'read_file' || tool === 'list_files' || tool === 'search_files' || tool === 'glob_files' || tool === 'diff_files') return 'read';
  return 'other';
}

function createPermissionHandler(config: PureConfig): PermissionRequestHandler {
  return async (info: PermissionRequestInfo): Promise<PermissionDecision> => {
    const cat = toolCategory(info.tool);
    const auto = cat === 'read' ? config.autoPermRead
      : cat === 'git' ? config.autoPermGit
      : cat === 'write' ? config.autoPermWrite
      : cat === 'cmd' ? config.autoPermCmd
      : false;
    if (auto) return { allowed: true, autoApproved: true };
    return requestPermission(info);
  };
}

// ── Adapter factory ──

function providerBaseURL(provider: PureConfig['provider']): string {
  return baseURLFor(provider);
}


function createLLMAdapter(config: ReturnType<typeof loadConfig>): LLMAdapter {
  if (!config) {
    throw new Error('No configuration');
  }
  // DeepSeek reasoning models spend reasoning_content tokens from the SAME
  // output budget as content — at the shared 8192 default, complex tasks (e.g.
  // generating a full HTML animation) exhaust the budget on thinking and the
  // visible answer comes back EMPTY → verify failure → retry loop. Give
  // DeepSeek a larger budget; Qwen/GLM keep the shared default.
  const maxTokens = isDeepSeekFamily(config.provider)
    ? 32768
    : undefined;
  if (isTauriRuntime()) {
    // Desktop: the key lives in Rust secrets (~/.pure/secrets.json, 0600) and
    // is resolved inside `chat_stream` — it never passes through the WebView.
    return new RustLLMAdapter({
      provider: config.provider,
      model: config.model || defaultModelFor(config.provider),
      baseURL: config.baseURL || providerBaseURL(config.provider),
      extraBody: config.provider === 'glm' ? { tool_stream: true } : undefined,
      maxTokens,
    });
  }
  if (!config.apiKey) {
    throw new Error('No API key configured');
  }
  const baseURL = config.baseURL || providerBaseURL(config.provider);
  const model = config.model || defaultModelFor(config.provider);
  return new OpenAICompatibleAdapter({
    baseURL,
    apiKey: config.apiKey,
    model,
    extraBody: config.provider === 'glm' ? { tool_stream: true } : undefined,
    maxTokens,
  });
}

// TauriToolAdapter passes the effective workspace through to the Rust backend
// for every call. When the user has not selected a workspace, send() supplies
// an application-owned temporary directory for this session; web tools remain
// filesystem-independent.
// ── Task-specific plan generation (P1-6 enhancement) ──
// Complex multi-step tasks get a CONCRETE plan from the LLM before the review
// card shows — the heuristic generic template (Understand/Plan/Implement/Verify)
// is replaced by real per-task steps, which is what makes the live checkoff
// card meaningful ("把步骤和 todo list 列出来，完成一个消减一个"). One
// non-streaming call raced against a timeout; on failure/timeout the heuristic
// plan from analyzeTask() stays as the fallback.
const PLAN_GENERATION_TIMEOUT_MS = 8000;
const PLAN_GENERATION_PROMPT = `You are a meticulous planner for an AI coding agent. Break the user's request into 4-8 concrete, ordered, independently verifiable steps that the agent will execute ONE BY ONE. Do NOT invent file contents; steps describe what to do and how success is checked. Respond with ONLY a JSON array — no prose, no code fences — in exactly this shape:
[{"action": "short verb phrase", "description": "what this step does and why", "expectedOutcome": "how success is verified"}]
Use the same language as the user's request.`;

export async function generateTaskPlan(
  llm: LLMAdapter,
  userText: string,
  timeoutMs: number = PLAN_GENERATION_TIMEOUT_MS,
): Promise<Plan | null> {
  try {
    const res = await Promise.race([
      llm.complete(
        [
          { role: 'system', content: PLAN_GENERATION_PROMPT },
          { role: 'user', content: userText },
        ],
        [],
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('plan generation timed out')), timeoutMs),
      ),
    ]);
    return parsePlanJson(res.content);
  } catch (err) {
    console.warn('[pure] plan generation failed, falling back to heuristic plan:', (err as Error)?.message ?? err);
    return null;
  }
}

// Short display label for the auto-selected task mode (used in status bubbles
// and the plan-card chip).
function modeLabel(mode: TaskMode): string {
  switch (mode) {
    case 'build': return t('plan.mode.build');
    case 'plan': return t('plan.mode.plan');
    default: return t('plan.mode.yolo');
  }
}

function createToolAdapter(workspace: string, config: PureConfig): ToolAdapter {
  const inner = new TauriToolAdapter(workspace, config.tavilyApiKey, config.serperApiKey, config.city);
  // A tool is available only when the settings toggle allows it. The caller
  // supplies either the selected user workspace or the session's application
  // temporary workspace, so filesystem tools have a valid root in both modes.
  const available = (name: string): boolean =>
    isToolEnabled(name, config) && (!!workspace || isWebTool(name) || name === 'sys_info');
  return {
    getTools: () => inner.getTools().filter((t) => available(t.name)),
    getMetadata: (name) => (available(name) ? inner.getMetadata(name) : undefined),
    execute: async (toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> => {
      const name = toolCall.function.name;
      if (!available(name)) {
        const why = `'${name}' is disabled in Settings → Tools.`;
        return { id: toolCall.id, toolName: name, error: why, success: false, duration: 0 };
      }
      return inner.execute(toolCall, signal);
    },
  };
}

// ── ChatController ──

export class ChatController {
  private streaming = false;
  private abortController: AbortController | null = null;
  private onStreamingChange?: (streaming: boolean) => void;
  private workspace: string = '';
  private sessionId: string = '';
  private messages: Message[] = [];
  private hasHistory = false;
  private mcpClient?: MCPClient;
  private fileWatcher?: FileWatcher;
  private deferredInitDone = false;
  private watcherWorkspace = '';
  // Session identity + MCP config the current mcpClient was built with. MCP
  // stdio transports are session-bound (the Rust registry keys subprocesses by
  // sessionId), so a client must be torn down and rebuilt when either changes.
  private mcpSessionId = '';
  private mcpConfigSnapshot = '';
  // Generation counter: bumped on every session switch / new chat so an
  // in-flight send() loop notices it has been superseded (see send()).
  private generation = 0;
  // Session-scoped permission manager: CodingAgent creates its own per send,
  // which would reset the "始终允许(本次会话)" cache after every turn. Hoisted
  // here so approvals last the whole chat session; cleared on new chat.
  private permissionManager: PermissionManager;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.permissionManager = new PermissionManager();
  }

  onStreamingStateChange(fn: (streaming: boolean) => void) {
    this.onStreamingChange = fn;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(id: string) {
    this.sessionId = id;
    // Session switch: invalidate any in-flight send loop so it stops writing
    // into the new transcript and never persists into the wrong session.
    this.generation++;
    // Loading a different session (sidebar click) is a new "本次会话": drop
    // approvals granted under the previous session so they don't leak across.
    this.permissionManager.clearCache();
  }

  /** Load stored messages into the agent's internal state so subsequent turns use history. */
  loadFromStorage(stored: StoredMessage[]) {
    this.messages = stored.map(m => ({
      role: m.role as Message['role'],
      content: m.content ?? '',
      toolCalls: m.tool_calls as Message['toolCalls'],
      toolCallId: m.tool_call_id,
      toolName: m.name,
    }));
    this.hasHistory = this.messages.length > 0;
  }

  /** Restore last session for view-only display. Messages are NOT loaded into CodingAgent. */
  async restoreLastSession(): Promise<StoredMessage[] | null> {
    const saved = await loadLastSession();
    if (!saved) return null;
    this.sessionId = saved.sessionId;
    this.generation++;
    // Route through setWorkspace so the clickable-path resolver stays in sync,
    // then resolve the application tmp path when this session has no user
    // workspace selected.
    this.setWorkspace(saved.workspace ?? '');
    await this.syncEffectiveWorkspace();
    return saved.messages;
  }

  setWorkspace(path: string) {
    this.workspace = path;
    // Keep the transcript's clickable-path resolver in sync with the session's
    // workspace so relative paths in bubbles/tool rows resolve correctly.
    setPathLinkWorkspace(path);
  }

  getWorkspace(): string {
    return this.workspace;
  }

  /** Sync path-link resolution with the effective session workspace without
   * changing the user-visible workspace selection. */
  async syncEffectiveWorkspace(): Promise<void> {
    const effective = this.workspace || await getApplicationTmpWorkspace(this.sessionId);
    if (effective) setPathLinkWorkspace(effective);
  }

  async send(userText: string) {
    const chatEl = document.getElementById('chat')!;
    wireScrollPin(chatEl);
    wireTranscriptPrune(chatEl);
    const config = loadConfig();
    if (!hasConfiguredKey(config)) return;

    // Snapshot the user-selected workspace separately from the effective tool
    // workspace. An empty user workspace uses an application-owned tmp folder,
    // but the session must continue to persist an empty user workspace so the
    // UI still means "no user workspace selected" after reload.
    const sendSessionId = this.sessionId;
    const sendWorkspace = this.workspace;

    this.cancel();
    const gen = ++this.generation;
    const effectiveWorkspace = sendWorkspace || await getApplicationTmpWorkspace(sendSessionId);
    if (gen !== this.generation) return;
    if (effectiveWorkspace) setPathLinkWorkspace(effectiveWorkspace);

    this.setStreaming(true);
    this.abortController = new AbortController();

    // Generation guard: if the user navigates to another session / starts a
    // new chat while this turn streams, the switch bumps `generation` and this
    // loop must stop appending to the (now different) transcript and must not
    // persist into the wrong session. Also snapshot the session identity: even
    // if a switch races the final persist, we write back to the session the
    // turn STARTED in — never the one the user just opened.

    // Hoist the streamingRender flag once — toggle defaults to true, but
    // users on low-end hardware can disable it from Settings → Chat to skip
    // the 100ms throttled markdown re-render entirely. Reading loadConfig()
    // on every TokenDelta would parse JSON hundreds of times per turn,
    // undermining the perf benefit the toggle is supposed to provide.
    const streamingRenderEnabled = (loadConfig()?.streamingRender ?? true);

    let finalMessages: Message[] = [];
    let interruptedMessages: Message[] | undefined;
    const thinkingAssistantOffset = this.messages.filter(message => message.role === 'assistant').length;
    let assistantIteration = -1;
    const thinkingPhases: Array<{ text: string; assistantIndex: number }> = [];
    // Assistant output renders as ONE OR MORE bubbles in transcript order.
    // When text arrives AFTER tool rows have been appended, a new bubble is
    // started so the model's post-tool answer appears BELOW the tools the user
    // already watched execute — not glued into the pre-tool bubble that now
    // sits above them (the ordering bug this fixes). Each segment keeps its
    // own raw text for the final markdown pass on Completed.
    const assistantSegments: Array<{ el: HTMLDivElement; text: string }> = [];
    let currentSegment: { el: HTMLDivElement; text: string } | null = null;
    let toolRowSinceSegment = false;
    const createSegment = (): { el: HTMLDivElement; text: string } => {
      const el = this.addBubble('assistant', '');
      el.classList.add('streaming');
      const seg = { el, text: '' };
      assistantSegments.push(seg);
      currentSegment = seg;
      return seg;
    };
    // Reuse the current bubble while no tool row has been inserted after it;
    // otherwise (or on the first text) start a fresh bubble at the end of the
    // transcript — i.e. below any tool rows that were just appended.
    const ensureSegment = (): { el: HTMLDivElement; text: string } => {
      if (currentSegment && !toolRowSinceSegment) return currentSegment;
      toolRowSinceSegment = false;
      return createSegment();
    };
    // Track pending tool-call rows so we can show "calling… (args)" before
    // execution and "✓/✗ duration" + parsed result preview on ToolResult. The
    // row element itself lives in the chat transcript; this map stores the
    // entry references + parsed args so we can update the summary line on each
    // subsequent TokenDelta (args grow as the JSON streams in).
    // pendingRows is keyed by toolCallId (BUG-6 fix): each tool call gets its
    // own row so parallel same-name calls can't overwrite each other.
    // pendingByName stages mid-stream argument deltas whose toolCallId hasn't
    // arrived yet; the engine's id-bearing TokenDelta (from the `tool_call` /
    // `done` chunks) migrates the staged row onto the id-keyed map.
    const pendingRows = new Map<string, ToolRowEntry>();
    const pendingByName = new Map<string, ToolRowEntry>();
    // Per-call throttle for tool-call JSON re-parses (keyed by toolCallId or
    // staged tool name). Streaming a giant argument (write_file `content`, a
    // whole HTML file) grows the buffer to tens of KB; re-parsing it AND
    // re-rendering the Input panel on every token freezes the UI mid-stream
    // ("stuck with only the blinking cursor"). See the TokenDelta handler.
    const toolCallRefresh = new Map<string, number>();
    // Live bash output: lines the Rust backend streams while a command runs
    // (execute_command_stream) are appended to the matching pending tool row's
    // Output panel in real time — a long-running command shows progress rather
    // than a silent wait. Keyed by the LLM tool call id, the same id the
    // engine uses for the id-bearing TokenDelta and the ToolResult event; rows
    // staged by name migrate onto the id key before execution, so the row
    // always exists by the time the first line streams.
    setToolOutputListener((toolCallId, kind, line) => {
      if (gen !== this.generation) return;
      const entry = pendingRows.get(toolCallId);
      if (!entry || !entry.row.details.classList.contains('pending')) return;
      appendToolStreamLine(entry.row, kind, line);
      scrollChatToBottomIfPinned(chatEl);
    });
    // toolCallId → outcome, replayed as status rows (StoredMessage.toolExec)
    // when the session is restored from storage.
    const toolResults = new Map<string, ToolExecMeta>();
    // Tool-round grid: tool calls issued in the SAME LLM iteration (e.g. two
    // parallel web_search calls, or a web_search + list_files batch) render
    // side by side in one horizontal grid, so the transcript reads "running
    // simultaneously" instead of a vertical stack of identical-looking rows.
    // A single-call round renders as one full-width item (the grid collapses
    // to one column). Closed by the next StateChange → THINK.
    let toolGrid: HTMLElement | null = null;
    const appendToolRow = (toolName: string, args: Record<string, unknown>): ToolRowHandle => {
      // Tool calls interrupt text streaming — the bubble above the new row
      // stops blinking now, not at turn completion (see above).
      finalizeStreamingSegments();
      if (!toolGrid) {
        toolGrid = document.createElement('div');
        toolGrid.className = 'bubble-row tool-grid';
        chatEl.appendChild(toolGrid);
      }
      return this.addToolRow(toolName, args, toolGrid);
    };
    // Live thinking card: created once the user bubble lands, finalized on the
    // first content/tool delta, and nulled so a later reasoning phase (after
    // tool results) opens a fresh card below whatever it followed.
    let thinkingCard: ThinkingCardHandle | null = null;
    // Reasoning deltas are batched into 50ms flushes before touching the DOM:
    // reasoning streams (DeepSeek/Qwen/GLM) can deliver hundreds of deltas per
    // second, and a per-delta append + scroll forces a layout read every time
    // (the classic streaming stutter). thinkingPhases still accumulates EVERY
    // delta for persistence — only the DOM append is throttled.
    let thinkingPending = '';
    let thinkingFlushTimer: number | undefined;
    const THINKING_FLUSH_MS = 50;
    const flushThinking = (): void => {
      thinkingFlushTimer = undefined;
      if (!thinkingCard || !thinkingPending) return;
      appendThinkingText(thinkingCard, thinkingPending);
      thinkingPending = '';
    };
    const endThinking = () => {
      if (thinkingFlushTimer !== undefined) {
        clearTimeout(thinkingFlushTimer);
        thinkingFlushTimer = undefined;
      }
      // Flush any buffered reasoning before finalizing so the card never loses
      // the last (un-flushed) slice of the stream.
      if (thinkingPending) {
        if (thinkingCard) appendThinkingText(thinkingCard, thinkingPending);
        thinkingPending = '';
      }
      if (!thinkingCard) return;
      finalizeThinkingCard(thinkingCard);
      thinkingCard = null;
    };
    // Stop the streaming caret on every text bubble the moment a tool row is
    // appended: the pre-tool text is complete once the agent hands off to a
    // tool, and write_file / edit_file / execute_command can run for seconds
    // or minutes — the `|` cursor (.bubble.streaming::after) must not blink
    // above the row for the whole execution. Finalized segments keep their
    // rendered text; if the model streams again after the tool, ensureSegment
    // opens a fresh bubble below the tool rows (with its own caret).
    const finalizeStreamingSegments = (): void => {
      for (const seg of assistantSegments) {
        cancelStreamingRender(seg.el);
        seg.el.classList.remove('streaming');
      }
    };
    // createThinkingCard() builds the element tree but does NOT attach it —
    // append to the transcript here, right below whatever was last added.
    const openThinkingCard = (): ThinkingCardHandle => {
      const card = createThinkingCard();
      chatEl.appendChild(card.el);
      return card;
    };

    try {
      // All setup that could throw synchronously (adapter creation, agent construction)
      // Memory skill toggle: when disabled, skip learning + memory injection.
      const memoryEnabled = config.skills?.memory ?? true;
      if (memoryEnabled) {
        const entries = harvestUserPreferences(userText, {
          sessionId: this.sessionId,
          projectPath: effectiveWorkspace,
        });
        await Promise.all(entries.map(e => memoryStore.add(e).catch(() => '')));
      }
      // Persona + tool list are split by the effective workspace: an
      // application temporary workspace is a real filesystem root for this
      // session, while web tools remain available independently.
      const usingTemporaryWorkspace = !sendWorkspace && !!effectiveWorkspace;
      let systemPrompt = buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace, config);

      const llm = createLLMAdapter(config);
      const toolAdapter = createToolAdapter(effectiveWorkspace, config);

      // Skill toggles: when a skill is disabled, drop its matching subagent so
      // the LLM can't delegate work it would expect to succeed (web_researcher
      // ↔ web-research, code_reviewer ↔ code-review, planner ↔ planning).
      // `undefined` keeps the full built-in set (CodingAgent defaults to
      // BUILT_IN_SUBAGENTS).
      const subagents = (() => {
        const keep = BUILT_IN_SUBAGENTS.filter((def) => {
          if (def.name === 'web_researcher') return config.skills?.['web-research'] ?? true;
          if (def.name === 'code_reviewer') return config.skills?.['code-review'] ?? true;
          if (def.name === 'planner') return config.skills?.planning ?? true;
          return true;
        });
        return keep.length === BUILT_IN_SUBAGENTS.length ? undefined : keep;
      })();

      // Refresh mode + handler for this turn so a settings change (e.g.
      // toggling "自动放行命令") takes effect immediately on the next send
      // while keeping the session's approval cache alive.
      this.permissionManager.setMode(mapPermissionMode(config.permissionMode));
      this.permissionManager.setRequestHandler(createPermissionHandler(config));

      // Rebuild MCP + FileWatcher when the session identity, MCP config, or
      // the filesystem-watching workspace changed since the last init.
      // MCP transports are session-bound (the Rust subprocess registry keys
      // them by sessionId), so reusing a client across sessions would leave
      // subprocesses under a stale session AND ignore config edits made in
      // Settings. disconnectAll() closes every transport, killing the spawned
      // servers, before the next deferred init reconnects under the new
      // sessionId/config. Only the filesystem watcher is workspace-bound.
      if (this.deferredInitDone && (
        this.watcherWorkspace !== effectiveWorkspace ||
        this.mcpSessionId !== sendSessionId ||
        this.mcpConfigSnapshot !== JSON.stringify(config.mcpServers ?? [])
      )) {
        this.mcpClient?.disconnectAll();
        this.mcpClient = undefined;
        await this.fileWatcher?.stop();
        this.fileWatcher = undefined;
        this.deferredInitDone = false;
      }

      const codingAgent = new CodingAgent({
        sessionId: this.sessionId,
        llm,
        toolAdapter,
        subagents,
        // With either a user workspace or an application temporary workspace,
        // defer to the live ToolRegistry so filesystem tools, subagents, and
        // MCP tools registered after construction are visible to the LLM.
        toolsDefs: effectiveWorkspace ? undefined : [
          ...(config.toolBrowser ? WEB_TOOL_DEFS : []),
          ...SYS_INFO_DEFS,
        ],
        budget: DEFAULT_BUDGET,
        // Cross-session memory: passed only when the Memory skill is enabled;
        // the Harness composes it into the system prompt at session start.
        memory: memoryEnabled ? memoryStore : undefined,
        projectPath: effectiveWorkspace || undefined,
        mcpClient: this.mcpClient,
        fileWatcherInstance: this.fileWatcher,
        mcpServers: this.deferredInitDone ? undefined : (config.mcpServers ?? []),
        fileWatcher: this.deferredInitDone ? undefined : (effectiveWorkspace ? { cwd: effectiveWorkspace } : undefined),
        permissionManager: this.permissionManager,
        // P1-1 (async verification): the engine's `verifier` stays PURELY
        // rule-based (non-empty-output check — a hard failure there must still
        // trigger an in-engine rewrite). The LLM re-check of the final output
        // no longer blocks the turn: it runs fire-and-forget after Completed
        // (see the Completed handler) and a failed verdict only appends a
        // suggestion bubble instead of rewriting the displayed answer.
        verifier: createDefaultVerifier(),
      });

      // LLM-only verifier for the post-Completed async check (P1-1). Created
      // once per send when the Code Review skill is enabled; invoked
      // fire-and-forget so it can never delay the turn-complete UI.
      const llmVerifyVerifier = (config.skills?.['code-review'] ?? true)
        ? createLLMOnlyVerifier(llm)
        : undefined;

      // ── Logical-trap pre-scan (runs in plain-chat AND workspace mode):
      // contradictory / impossible / trick premises are flagged before the
      // run and injected into the system prompt so the model verifies the
      // premise instead of following it into a failure loop. The same analysis
      // also drives the plan review below.
      const analysis = codingAgent.analyzeTask(userText);
      // Manual mode override from the composer's mode selector (config.taskMode,
      // persisted — Settings-independent). 'auto' keeps the Planner's per-task
      // detection; a forced yolo/plan/build wins for this turn: it drives the
      // plan-review gate below AND the label on the mode bubble / plan card.
      const forcedMode: TaskMode | undefined =
        config.taskMode && config.taskMode !== 'auto' ? config.taskMode : undefined;
      if (forcedMode) analysis.mode = forcedMode;
      if (analysis.traps.length > 0) {
        systemPrompt += formatTrapPrompt(analysis.traps);
      }
      // "写一个小游戏 / 做一个网页 / 开发一个工具" → build the artifact on disk
      // instead of printing the full source inline (see formatArtifactPrompt).
      if (detectArtifactRequest(userText)) {
        systemPrompt += formatArtifactPrompt();
      }

      // ── Plan review pre-flight (P1-6): complex tasks get a user-approved
      // plan before execution. It also applies in the application temporary
      // workspace when the user has not selected a project directory. An
      // approved plan becomes a live phase-progress card in the transcript
      // (approvedPlan below) and the model is told to emit `## 阶段 n/m`
      // markers so the card can track which phase is running.
      //
      // Smarter behavior: complex multi-step requests first get a CONCRETE
      // plan from the LLM (generateTaskPlan) — real per-task steps replace the
      // generic heuristic template, so the review card and the live checkoff
      // card show the actual work ahead. The mode switch (yolo → plan/build)
      // is surfaced to the user as a status bubble.
      let approvedPlan: Plan | null = null;
      if (effectiveWorkspace && (config.skills?.planning ?? true)) {
        // Plan review runs when: auto-detected complex task (has a heuristic
        // plan), OR the user forced plan/build mode from the composer. A forced
        // YOLO suppresses review even for complex tasks.
        const wantsPlan = forcedMode
          ? forcedMode === 'plan' || forcedMode === 'build'
          : analysis.complexity === 'complex' && !!analysis.plan;
        if (wantsPlan) {
          const modeBubble = this.addStatusBubble(
            forcedMode
              ? t('plan.modeForced', '🧭 已按你的选择进入 {mode} 模式，正在生成执行计划…').replace('{mode}', modeLabel(analysis.mode))
              : t('plan.modeSwitch', '🧭 检测到复杂任务，切换为 {mode} 模式，正在生成执行计划…').replace('{mode}', modeLabel(analysis.mode)),
          );
          // Upgrade the heuristic plan with an LLM-generated task-specific one;
          // keep the heuristic result when the generation call fails/times out.
          // A forced plan/build on a simple task has no heuristic plan yet —
          // fall back to the generic scaffold (same shape as Planner's) so the
          // review card always has steps to show.
          let planForReview: Plan = analysis.plan ?? {
            steps: [
              { id: '1', action: 'Understand', description: 'Read relevant files and understand what needs to change.', expectedOutcome: 'Clear understanding of the task.' },
              { id: '2', action: 'Plan', description: 'Design the solution approach and identify files to modify.', expectedOutcome: 'An executable step list.' },
              { id: '3', action: 'Implement', description: 'Make the changes step by step and verify each one.', expectedOutcome: 'The core work is done.' },
              { id: '4', action: 'Verify', description: 'Check the result and summarize what changed.', expectedOutcome: 'A verified, usable result.' },
            ],
            reasoning: 'Plan mode was selected manually — working through generic steps.',
          };
          const llmPlan = await generateTaskPlan(llm, userText);
          // The user may have switched sessions / started a new chat during the
          // (up-to-8s) generation — abandon this turn before showing anything.
          if (gen !== this.generation) return;
          if (llmPlan) planForReview = llmPlan;
          const decision = await requestPlanReview({ ...analysis, plan: planForReview, reasoning: planForReview.reasoning });
          if (decision === 'cancel') {
            // Cancelled pre-flight leaves no ghost bubbles (see the "bubbles
            // are added after the interactive pre-flight" invariant).
            modeBubble.remove();
            return; // finally resets streaming
          }
          if (decision === 'skip') {
            modeBubble.remove();
          } else {
            approvedPlan = planForReview;
            systemPrompt += formatPlanForPrompt(planForReview);
            // Plan is ready + approved: the bubble no longer promises generation.
            modeBubble.textContent = t('plan.modeActive', '🧭 已切换为 {mode} 模式，按计划分步执行').replace('{mode}', modeLabel(analysis.mode));
          }
        }
      } else if (forcedMode === 'plan' || forcedMode === 'build') {
        // The plan gate needs a real filesystem root (and the Planning skill);
        // without it a forced plan/build would silently do nothing. Surface the
        // mismatch instead of ignoring the user's mode choice.
        this.addStatusBubble(
          effectiveWorkspace
            ? t('plan.modeDisabled', '🧭 计划/构建模式已被禁用（设置 → Skills → Planning），本次按普通对话继续')
            : t('plan.modeNoWorkspace', '🧭 计划/构建模式需要先选择工作区，本次按普通对话继续'),
        );
      }

      // Add bubbles after the (possibly interactive) pre-flight so a cancelled
      // plan review leaves no ghost messages in the chat. User text stays raw
      // escaped text, but path-shaped substrings become clickable.
      const userBubble = this.addBubble('user', userText);
      linkifyPaths(userBubble);
      // Approved execution plan → a compact phase tracker in the transcript:
      // total phase count + which phase is currently running, updated live
      // from the model's `## 阶段 n/m` markers (see formatPlanForPrompt).
      let planCard: PlanCardHandle | null = null;
      const planTrack = { seg: null as { el: HTMLDivElement; text: string } | null, scanLen: 0 };
      if (approvedPlan) {
        planCard = createPlanCard(approvedPlan, analysis.mode);
        chatEl.appendChild(planCard.el);
      }
      const trackPlanPhase = (seg: { el: HTMLDivElement; text: string }) => {
        if (!planCard) return;
        if (planTrack.seg !== seg) { planTrack.seg = seg; planTrack.scanLen = 0; }
        if (planTrack.scanLen >= seg.text.length) return;
        // Overlap window keeps the previous 24 chars in the slice so a marker
        // split across token boundaries ("## 阶段 " + "2/4") is still seen whole.
        const tail = seg.text.slice(Math.max(0, planTrack.scanLen - 24));
        planTrack.scanLen = seg.text.length;
        const phase = matchPlanPhaseMarker(tail);
        if (phase) updatePlanCardPhase(planCard, phase);
      };
      // Surface detected logical traps as a neutral notice (not an error): the
      // agent will verify the premise before executing.
      if (analysis.traps.length > 0) {
        const labels = [...new Set(analysis.traps.map(t => TRAP_TYPE_LABELS[t.type] ?? t.type))].join('、');
        this.addStatusBubble(`⚠️ 检测到请求中可能包含逻辑陷阱（${labels}）— 将先验证前提，若前提有误会换思路处理`);
      }
      // Eager thinking indicator: the user sees the animation while waiting
      // for the first token; reasoning deltas upgrade it with live text.
      thinkingCard = openThinkingCard();
      // Route through the rAF-coalesced scroll helper so this first content
      // growth joins the same frame budget as every streamed token (a direct
      // scrollTop write here forced a synchronous full-transcript layout).
      scrollChatToBottomIfPinned(chatEl);

      // ── Deferred init: boot MCP + FileWatcher on first use ──
      if (!this.deferredInitDone) {
        this.deferredInitDone = true;
        this.mcpSessionId = sendSessionId;
        this.mcpConfigSnapshot = JSON.stringify(config.mcpServers ?? []);
        this.mcpClient = codingAgent.mcpClient;
        this.fileWatcher = codingAgent.fileWatcher;
        this.watcherWorkspace = effectiveWorkspace;

        if (this.mcpClient) {
          // Await MCP connect so tools are registered before the first run builds
          // its toolsDefs (toolsDefsProvider reads them live) — but never block
          // the first send: race against a short timeout, then proceed without
          // MCP tools if a server is slow. They'll appear on the next turn.
          await Promise.race([
            this.mcpClient.connectAll().catch((err: Error) => {
              console.warn('[pure] MCP connection failed:', err.message);
            }),
            new Promise(resolve => setTimeout(resolve, 1500)),
          ]);
        }
        if (this.fileWatcher) {
          this.fileWatcher.start().catch((err: Error) => {
            console.warn('[pure] FileWatcher start failed:', err.message);
          });
        }
      }

      const events = this.hasHistory
        ? codingAgent.continueTurn(systemPrompt, this.messages, userText, this.abortController.signal)
        : codingAgent.run(systemPrompt, userText, this.abortController.signal);

      for await (const event of events) {
        // Session switched mid-stream (sidebar click / new chat): stop writing
        // into the new transcript immediately. The engine is aborted via
        // cancel() (main.ts loadAndDisplaySession), so no events remain — this
        // guard also covers slow-abort cases where a straggler still yields.
        if (gen !== this.generation) break;
        switch (event.type) {
          case 'StateChange': {
            if (event.payload.to === 'THINK') {
              assistantIteration++;
              // A new LLM iteration = a new tool round: close the previous
              // round's parallel grid so the next batch of tool rows starts
              // its own horizontal group.
              toolGrid = null;
            }
            break;
          }

          case 'TokenDelta': {
            if (!event.payload.isToolCall) {
              const delta = event.payload.content;
              if (delta) {
                // First visible answer token closes the thinking phase.
                endThinking();
                const seg = ensureSegment();
                seg.text += delta;
                // Scan newly-appended text for `阶段 n/m` plan markers so the
                // approved-plan phase card advances as the run progresses.
                trackPlanPhase(seg);
                // Strip leaked <tool_calls> XML before it ever reaches the DOM.
                const text = stripToolCallXml(seg.text);
                if (streamingRenderEnabled) {
                  // diffStreaming owns the DOM: setting textContent here would
                  // wipe the rendered blocks on every token and defeat the
                  // data-md-raw diff (flicker + full re-highlight each tick).
                  // The throttled renderer keeps blocks intact and only updates
                  // changed ones; the callback re-syncs scroll since the DOM
                  // mutates up to 100ms after the token that triggered it.
                  scheduleStreamingRender(text, seg.el, () => {
                    scrollChatToBottomIfPinned(chatEl);
                  });
                } else {
                  // streamingRender disabled: plain-text fallback, full render
                  // happens once on Completed.
                  seg.el.textContent = text;
                }
              }
              scrollChatToBottomIfPinned(chatEl);
            } else {
              // ── Tool call delta → append/update inline tool row ──
              const toolName = event.payload.toolCallName ||
                (event.payload.toolCallBuffer || '').match(/"name"\s*:\s*"([^"]+)"/)?.[1];
              const toolCallId = event.payload.toolCallId;
              if (toolName) {
                const now = Date.now();
                if (toolCallId) {
                  // Id-bearing chunk (`tool_call` / `done`): the call's FINAL
                  // args — parse once (fires once per call) and fill the full
                  // Input section. Also key the row by toolCallId so parallel
                  // same-name calls get distinct rows, migrating a name-staged
                  // streaming row if one exists.
                  const args = parseToolCallBuffer(event.payload.toolCallBuffer).args || {};
                  let entry = pendingRows.get(toolCallId);
                  if (!entry) {
                    const staged = pendingByName.get(toolName);
                    if (staged) {
                      pendingByName.delete(toolName);
                      entry = { ...staged, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else {
                      endThinking();
                      const row = appendToolRow(toolName, args);
                      toolRowSinceSegment = true;
                      entry = { row, toolName, args, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    }
                  }
                  entry.args = args;
                  updateToolRowArgs(entry.row, toolName, args);
                } else {
                  // Mid-stream argument delta: id unknown, stage by name. The
                  // final id-bearing chunk migrates this entry. Streaming a
                  // giant argument (write_file `content`, a whole HTML file)
                  // grows the buffer to tens of KB, so parsing it AND
                  // re-rendering the Input section on every token is O(n²) and
                  // freezes the UI. Throttle the parse to ~120ms and only
                  // refresh the compact one-line summary while streaming; the
                  // Input body is filled on row creation and the id chunk.
                  const key = toolName;
                  const lastRefresh = toolCallRefresh.get(key) ?? 0;
                  const due = now - lastRefresh >= TOOL_CALL_REFRESH_MS;
                  if (due) toolCallRefresh.set(key, now);
                  const args = due
                    ? (parseToolCallBuffer(event.payload.toolCallBuffer).args || {})
                    : undefined;
                  const existing = pendingByName.get(toolName);
                  if (!existing) {
                    endThinking();
                    const row = appendToolRow(toolName, args ?? {});
                    toolRowSinceSegment = true;
                    pendingByName.set(toolName, { row, toolName, args: args ?? {} });
                  } else if (args) {
                    existing.args = args;
                    updateToolRowArgs(existing.row, toolName, args, false);
                  }
                }
              }
            }
            break;
          }

          case 'ReasoningDelta': {
            const content = event.payload.content;
            if (!content) break;
            // Reasoning can resume after tool rows (each LLM iteration), so a
            // fresh card opens below whatever was appended since the last one.
            if (!thinkingCard) thinkingCard = openThinkingCard();
            // Phase tracking runs per-delta (persistence); the DOM append is
            // throttled, so "card empty" must also consider the pending buffer
            // to avoid opening a duplicate phase while text is only buffered.
            if (thinkingPhases.length === 0 || (thinkingCard.textEl.textContent === '' && !thinkingPending)) {
              thinkingPhases.push({ text: '', assistantIndex: thinkingAssistantOffset + Math.max(assistantIteration, 0) });
            }
            thinkingPhases[thinkingPhases.length - 1].text += content;
            thinkingPending += content;
            if (thinkingFlushTimer === undefined) {
              thinkingFlushTimer = window.setTimeout(flushThinking, THINKING_FLUSH_MS);
            }
            scrollChatToBottomIfPinned(chatEl);
            break;
          }

          case 'ToolResult': {
            const status = event.payload.result.success ? '✓' : '✗';
            const toolName = event.payload.toolName;
            const duration = event.payload.duration;
            const resultText = String(event.payload.result.result ?? '');
            // Special-parse web_search / web_fetch results for rich body
            // rendering. Other tools fall back to a raw preview in <pre>.
            let resultKind: 'search' | 'fetch' | undefined;
            let resultItems: Array<{ title: string; snippet: string; url: string }> | undefined;
            let resultPreview = '';
            if (event.payload.result.success) {
              if (toolName === 'web_search') {
                resultKind = 'search';
                resultItems = parseWebSearchResult(resultText);
                resultPreview = resultText.slice(0, 800);
              } else if (toolName === 'web_fetch') {
                resultKind = 'fetch';
                resultPreview = resultText.slice(0, 800);
              } else if (toolName === 'execute_command') {
                // Bash output was already streamed into the row live; keep the
                // trace on finalize (streaming was about progress, not
                // truncation) so the panel never visibly shrinks — but cap it
                // at MAX_LIVE_STREAM_LINES: a 5000-line build log must not
                // balloon the DOM (nor the persisted session preview). The
                // LLM still received the FULL output in the tool result.
                resultPreview = truncateResultLines(resultText);
              } else {
                resultPreview = resultText.slice(0, 800);
              }
            } else {
              resultPreview = String(event.payload.result.error ?? '');
            }
            // Record the outcome so a session reload (main.ts flushToolExecs)
            // can replay the same tool row with full args + result preview.
            toolResults.set(event.payload.toolCallId, {
              toolName,
              success: event.payload.result.success,
              duration,
              args: (pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName))?.args,
              resultKind,
              resultItems,
              resultText: resultPreview,
            });
            // Finalize the matching pending row — keyed by toolCallId (the
            // engine's id-bearing TokenDelta ensures one row per call).
            const pending = pendingRows.get(event.payload.toolCallId) ?? pendingByName.get(toolName);
            if (pending) {
              finalizeToolRow(pending.row, {
                success: event.payload.result.success,
                duration,
                resultKind,
                resultItems,
                resultText: resultPreview,
              });
              pendingRows.delete(event.payload.toolCallId);
              pendingByName.delete(toolName);
            } else {
              this.addToolStatusBubble(toolName, status, duration);
            }
            scrollChatToBottomIfPinned(chatEl);
            break;
          }

          case 'Error':
            // Error events (VERIFY_FAILED, LLM_STREAM_ERROR, …). Recoverable
            // ones (e.g. VERIFY_FAILED → the engine loops back to THINK with a
            // reflection hint) are an INTERNAL retry, not a user-facing failure
            // — render them as a neutral pulsing "correcting output" notice so
            // the transcript doesn't scream ERROR while the agent is simply
            // iterating. Unrecoverable errors (LLM_STREAM_ERROR, policy stop)
            // keep the full-width danger styling. Either way the engine may
            // not yield Completed/Interrupted, so close the thinking card here.
            endThinking();
            const recoverable = event.payload.recoverable === true;
            this.addStatusBubble(
              recoverable
                ? `↻ ${event.payload.code}: ${event.payload.message}`
                : `⚠️ ${event.payload.code}: ${event.payload.message}`,
              recoverable,   // pending: accent-pulse neutral notice
              !recoverable,  // isError: danger-styled bubble
            );
            scrollChatToBottomIfPinned(chatEl);
            break;

          case 'Completed': {
            endThinking();
            if (planCard) finalizePlanCard(planCard);
            // Cancel any throttled streaming render on every segment so a
            // late-firing tick from before completion cannot race with the
            // final pipeline below.
            for (const seg of assistantSegments) cancelStreamingRender(seg.el);
            resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
            for (const seg of assistantSegments) seg.el.classList.remove('streaming');
            // Render the text the user actually watched stream in. Each segment
            // carries its own accumulated deltas; the engine's finalOutput only
            // holds the LAST turn's content and is used as the fallback for the
            // final segment (e.g. text produced without TokenDelta events).
            if (assistantSegments.length === 0 && event.payload.finalOutput) {
              const seg = createSegment();
              seg.el.classList.remove('streaming');
              seg.text = event.payload.finalOutput;
            }
            for (let i = 0; i < assistantSegments.length; i++) {
              const seg = assistantSegments[i];
              const isLast = i === assistantSegments.length - 1;
              const finalText = seg.text || (isLast ? (event.payload.finalOutput || '') : '');
              if (!finalText) continue;
              // Render markdown + code highlights + mermaid + plantuml. Fire-and-forget so
              // the for-await loop doesn't block on the async mermaid render; the bubble is
              // visibly replaced as soon as innerHTML is set synchronously inside renderMarkdown.
              // Same XML filter as streaming, then re-scroll once the async diagram pass
              // has changed the bubble height.
              void renderMarkdown(stripToolCallXml(finalText), seg.el).then(() => {
                scrollChatToBottomIfPinned(chatEl);
              });
            }
            if (event.payload.messages) {
              finalMessages = event.payload.messages;
              this.messages = event.payload.messages;
              this.hasHistory = true;
            }

            // P1-1 (async verification): the LLM re-check of the answer runs
            // AFTER the stream — fire-and-forget so the UI flips back to Send
            // immediately (setStreaming(false) below is not delayed by an LLM
            // round-trip). A failed verdict does NOT rewrite the answer the
            // user just read; it only appends a neutral suggestion bubble.
            // Skipped on interrupted turns (user Stop) and stale generations.
            const verifyOutput = event.payload.finalOutput ||
              assistantSegments.map(s => s.text).filter(Boolean).join('\n\n');
            if (llmVerifyVerifier && verifyOutput && !event.payload.interrupted && gen === this.generation) {
              const verifyCtx = event.payload.messages ?? this.messages;
              // Only append the suggestion while the transcript is still at the
              // completed answer: if the user has already sent a follow-up, a
              // late-arriving bubble would land out of chronological order.
              const msgCountAtComplete = this.messages.length;
              void (async () => {
                try {
                  const verdict = await llmVerifyVerifier.evaluate({ output: verifyOutput, context: verifyCtx });
                  if (!verdict.passed && gen === this.generation && this.messages.length <= msgCountAtComplete) {
                    this.addStatusBubble(`🔎 验证建议: ${verdict.feedback ?? ''}`, true);
                    scrollChatToBottomIfPinned(chatEl);
                  }
                } catch {
                  // A broken verifier call must never break the session.
                }
              })();
            }
            break;
          }

          case 'Interrupted': {
            endThinking();
            if (event.payload.messages) {
              interruptedMessages = event.payload.messages;
              finalMessages = event.payload.messages;
              this.messages = event.payload.messages;
              this.hasHistory = true;
            }
            // Stop any in-flight throttled render so a late tick can't race
            // the finalization below, and resolve any "calling…" pending tool
            // cards whose ToolResult will never arrive.
            for (const seg of assistantSegments) cancelStreamingRender(seg.el);
            resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
            for (const seg of assistantSegments) seg.el.classList.remove('streaming');
            const hasContent = assistantSegments.some(s => s.el.textContent || s.el.children.length > 0);
            const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
            if (event.payload.reason !== 'aborted') {
              // Keep the already-rendered content; surface the reason as a
              // separate status row instead of flattening a bubble to text.
              if (hasContent) {
                this.addStatusBubble(`⏹ Interrupted: ${event.payload.reason}`);
              } else if (lastSeg) {
                lastSeg.el.textContent = `⏹ Interrupted: ${event.payload.reason}`;
              } else {
                const seg = createSegment();
                seg.el.classList.remove('streaming');
                seg.el.textContent = `⏹ Interrupted: ${event.payload.reason}`;
              }
            } else if (!hasContent) {
              if (lastSeg) {
                lastSeg.el.textContent = '(cancelled)';
              } else {
                const seg = createSegment();
                seg.el.classList.remove('streaming');
                seg.el.textContent = '(cancelled)';
              }
            }
            scrollChatToBottomIfPinned(chatEl);
            break;
          }
        }
      }

      // Persist session (memory is persisted inside the store on every add).
      // Only write when this send is still the current generation, and always
      // to the session/workspace snapshot captured at send() start.
      if (finalMessages.length > 0 && gen === this.generation) {
        // The turn's output is complete and on screen — release the streaming
        // UI (send button back to Send, input live) BEFORE the disk write so a
        // large session doesn't hold the UI in the "generating" state while
        // the JSON is serialized + written. chat.send() still awaits the write
        // below, so doSend's finally (sidebar refresh / queued send) keeps its
        // ordering — only the visual streaming state flips early.
        this.setStreaming(false);
        await this.persistSession(finalMessages, toolResults, thinkingPhases, sendSessionId, sendWorkspace);
      }
    } catch (err: any) {
      endThinking();
      for (const seg of assistantSegments) {
        seg.el.classList.remove('streaming');
        cancelStreamingRender(seg.el);
      }
      resolvePendingToolRows(toolCallRefresh, pendingRows, pendingByName);
      if (interruptedMessages && gen === this.generation) {
        await this.persistSession(interruptedMessages, toolResults, thinkingPhases, sendSessionId, sendWorkspace);
      } else if (thinkingPhases.length > 0 && gen === this.generation) {
        const partialOutput = assistantSegments.map(segment => segment.text).filter(Boolean).join('\n\n');
        const interruptedSnapshot: Message[] = [
          ...this.messages,
          { role: 'user', content: userText },
          { role: 'assistant', content: partialOutput },
        ];
        await this.persistSession(interruptedSnapshot, toolResults, thinkingPhases, sendSessionId, sendWorkspace);
      }
      const lastSeg = assistantSegments.length ? assistantSegments[assistantSegments.length - 1] : null;
      if (err.name === 'AbortError') {
        if (lastSeg && !lastSeg.el.textContent && lastSeg.el.children.length === 0) {
          lastSeg.el.textContent = '(cancelled)';
        }
      } else if (lastSeg) {
        lastSeg.el.textContent = `Error: ${err.message || err}`;
        lastSeg.el.classList.add('error');
      } else {
        // Failure before bubbles were created (e.g. plan review threw) — toast it.
        const toast = document.getElementById('toast');
        if (toast) {
          toast.textContent = `Error: ${err?.message || err}`;
          toast.classList.remove('hidden');
          setTimeout(() => toast.classList.add('hidden'), 2500);
        }
      }
    } finally {
      // Release the turn-scoped closure (pendingRows, toolResults, chatEl,
      // assistantSegments DOM nodes …) held by the module-level tool output
      // listener; otherwise it keeps the whole last turn alive until the next
      // send (and, after a chat.clear(), detached bubbles stay in memory).
      setToolOutputListener(null);
      this.setStreaming(false);
      this.abortController = null;
    }
  }

  clear() {
    this.cancel();
    // New chat supersedes any in-flight send loop.
    this.generation++;
    this.messages = [];
    this.hasHistory = false;
    this.sessionId = `session_${Date.now()}`;
    // New chat = a fresh session: drop any session-scoped tool approvals.
    this.permissionManager.clearCache();
    // New chat = a fresh session (new sessionId): mcpClient/fileWatcher are
    // left for GC here, and the next send() tears down + rebuilds MCP under the
    // new sessionId (see the session-identity check in send()).
    const chatEl = document.getElementById('chat')!;
    chatEl.innerHTML = '';
  }

  cancel() {
    this.abortController?.abort();
  }

  private async persistSession(
    messages: Message[],
    toolResults: Map<string, ToolExecMeta>,
    thinkingPhases: Array<{ text: string; assistantIndex: number }>,
    sessionId = this.sessionId,
    workspace = this.workspace,
  ) {
    if (messages.length <= 1) return;
    let assistantIndex = 0;
    const storedMsgs: StoredMessage[] = messages.map((m) => {
      const phase = m.role === 'assistant'
        ? thinkingPhases.find(candidate => candidate.assistantIndex === assistantIndex++)
        : undefined;
      return {
        role: m.role,
        content: m.content ?? null,
        tool_call_id: m.toolCallId,
        name: m.toolName,
        tool_calls: m.toolCalls as unknown[] | undefined,
        thinkingPhases: phase?.text ? [phase] : undefined,
        toolExec: (m.role === 'tool' && m.toolCallId) ? toolResults.get(m.toolCallId) : undefined,
      };
    });
    await saveSession(sessionId, storedMsgs, workspace);
  }

  private addBubble(role: 'user' | 'assistant', content: string): HTMLDivElement {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = `bubble-row ${role}`;
    const label = document.createElement('span');
    label.className = 'bubble-label';
    label.textContent = role === 'user' ? 'You' : 'pure';
    wrapper.appendChild(label);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // Assistant bubbles start empty: they get markdown-rendered at the
    // `Completed` event (see send()); user bubbles stay as raw escaped text.
    if (role === 'user') bubble.textContent = content;
    else bindAssistantBubbleCopy(bubble);
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  private addStatusBubble(text: string, pending = false, isError = false): HTMLElement {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    if (pending) wrapper.classList.add('pending');
    if (isError) wrapper.classList.add('error');
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    if (isError) bubble.classList.add('error');
    bubble.textContent = text;
    linkifyPaths(bubble);
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  // Fallback tool-result status bubble (no live tool row existed for this
  // call): render the tool name highlighted, matching .tool-row-name.
  private addToolStatusBubble(toolName: string, status: string, duration: number) {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    bubble.appendChild(document.createTextNode('🔧 '));
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolName;
    bubble.appendChild(name);
    bubble.appendChild(document.createTextNode(`: ${status} (${duration}ms)`));
    // Same path-linkification as addStatusBubble (tool names are identifiers,
    // but path-shaped text must stay clickable for parity).
    linkifyPaths(bubble);
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
  }

  private addToolRow(toolName: string, args: Record<string, unknown>, parent: HTMLElement): ToolRowHandle {
    const chatEl = document.getElementById('chat')!;
    const row = createToolRow(toolName, args);
    parent.appendChild(row.el);
    scrollChatToBottomIfPinned(chatEl);
    return row;
  }

  private setStreaming(v: boolean) {
    this.streaming = v;
    this.onStreamingChange?.(v);
  }
}
