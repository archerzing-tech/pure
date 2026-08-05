// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, type PureConfig } from './settings';
import { saveSession, loadLastSession, type StoredMessage, type ToolExecMeta } from './store';
import { LocalStorageMemoryStore } from '../adapter/memory/LocalStorageMemoryStore';
import { WASMEmbeddingStore } from '../adapter/memory/WASMEmbeddingStore';
import { harvestUserPreferences } from '../shared/memory';
import { CodingAgent } from '../coding-agent/CodingAgent';
import { formatTrapPrompt, detectArtifactRequest, formatArtifactPrompt } from '../coding-agent/Planner';
import { PermissionManager } from '../coding-agent/PermissionManager';
import { createLLMVerifier, createDefaultVerifier } from '../coding-agent/Verifier';
import { BUILT_IN_SUBAGENTS } from '../coding-agent/SubagentOrchestrator';
import { requestPermission } from './permission';
import { requestPlanReview, formatPlanForPrompt } from './plan';
import { TauriToolAdapter, getWebToolDefs, getSysInfoToolDefs } from './TauriToolAdapter';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { getApplicationTmpWorkspace, isTauriRuntime } from '../shared/tauri';
import { renderMarkdown, scheduleStreamingRender, cancelStreamingRender, stripToolCallXml } from './markdown';
import { linkifyPaths, setPathLinkWorkspace } from './pathLink';
import { createToolRow, updateToolRowArgs, finalizeToolRow, markToolRowStopped, type ToolRowHandle } from './toolRow';
import { createThinkingCard, appendThinkingText, finalizeThinkingCard, type ThinkingCardHandle } from './thinkingCard';
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
import type { PermissionMode, PermissionRequestHandler, PermissionRequestInfo, PermissionDecision, TrapWarning } from '../coding-agent/types';

// Friendly labels for the logical-trap status bubble (raw type ids like
// 'self-contradiction' are cryptic to users).
const TRAP_TYPE_LABELS: Record<TrapWarning['type'], string> = {
  'self-contradiction': '自相矛盾',
  'impossible-constraint': '不可能满足的约束',
  'mutually-exclusive': '互斥要求',
  'trap-keyword': '悖论/陷阱题',
};

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
- web_search(query, maxResults?) — DuckDuckGo web search (no API key needed)
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
- git_status — working tree status`;

// sys_info works without a workspace (the Rust backend ignores the workspace
// field), so it is advertised in BOTH plain-chat and workspace mode.
const SYS_INFO_PROMPT = `System:
- sys_info() — timezone, language, current time, OS version. When the user asks for the current time, date, timezone, language, or OS version, call sys_info() FIRST — never guess from your training data.`;

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

function parseToolCallBuffer(buf: string | undefined): { name?: string; args?: Record<string, unknown> } {
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

// Track whether the user is "pinned" to the bottom of the chat view.
// Pinned = the user hasn't manually scrolled away from the bottom. While
// pinned, every content change scrolls to the absolute bottom; once the user
// scrolls up, auto-scroll stops until they return to the bottom.
//
// Why not a px threshold? The old approach (scroll only when
// scrollHeight - scrollTop - clientHeight < 120) broke the moment a single
// markdown render grew the transcript by more than the threshold in one step
// — e.g. diffStreaming landing a complete fenced code block in one throttled
// pass, or renderMarkdown replacing the bubble on Completed. The distance
// from bottom then exceeded the threshold and auto-scroll silently stopped
// even though the user never scrolled up, leaving the scrollbar stuck above
// the newest content.
const pinnedStates = new WeakMap<HTMLElement, boolean>();

function isPinnedToBottom(el: HTMLElement): boolean {
  return pinnedStates.get(el) ?? true;
}

function setPinnedToBottom(el: HTMLElement, v: boolean): void {
  pinnedStates.set(el, v);
}

// Wire once per element: a user scroll away from the bottom unpins; a return
// to the bottom (or a programmatic scroll-to-bottom while pinned) re-pins.
function wireScrollPin(el: HTMLElement): void {
  if (el.dataset.scrollPinWired === '1') return;
  el.dataset.scrollPinWired = '1';
  const NEAR_BOTTOM_PX = 40;
  el.addEventListener('scroll', () => {
    setPinnedToBottom(el, el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
  }, { passive: true });
}

function scrollChatToBottomIfPinned(el: HTMLElement): void {
  if (!isPinnedToBottom(el)) return;
  el.scrollTop = el.scrollHeight;
}

// Resolve every still-pending tool row (stream ended without a ToolResult —
// aborted mid-call, error, or budget stop) so none remains in `pending` state.
// Rows stay in the transcript, marked stopped (⏹) instead of dismissed.
function resolvePendingToolRows(...maps: Map<string, ToolRowEntry>[]): void {
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

Work step by step. Read before you write. Verify after you change. Be concise.

Output style:
- Default to inline replies for questions, explanations, and SHORT code snippets: render them directly in your response (use fenced markdown code blocks for code). Call write_file / edit_file / replace_files ONLY when the user explicitly asks to save or persist to disk, names a target path, or the task requires on-disk artifacts (e.g. "scaffold a project at /tmp/foo", "create README.md", "fix this file").
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

function buildSystemPrompt(hasWorkspace: boolean, temporaryWorkspace = false): string {
  return BASE_SYSTEM_PROMPT(hasWorkspace, temporaryWorkspace);
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
  switch (provider) {
    case 'qwen': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'glm': return 'https://open.bigmodel.cn/api/paas/v4';
    default: return 'https://api.deepseek.com';
  }
}

function defaultModelForProvider(provider: PureConfig['provider']): string {
  switch (provider) {
    case 'qwen': return 'qwen3-coder-next';
    case 'glm': return 'glm-5.2';
    default: return 'deepseek-v4-flash';
  }
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
  const maxTokens = (config.provider === 'deepseek-openai' || config.provider === 'deepseek-anthropic')
    ? 32768
    : undefined;
  if (isTauriRuntime()) {
    // Desktop: the key lives in Rust secrets (~/.pure/secrets.json, 0600) and
    // is resolved inside `chat_stream` — it never passes through the WebView.
    return new RustLLMAdapter({
      provider: config.provider,
      model: config.model || defaultModelForProvider(config.provider),
      baseURL: config.baseURL || providerBaseURL(config.provider),
      extraBody: config.provider === 'glm' ? { tool_stream: true } : undefined,
      maxTokens,
    });
  }
  if (!config.apiKey) {
    throw new Error('No API key configured');
  }
  const baseURL = config.baseURL || providerBaseURL(config.provider);
  const model = config.model || defaultModelForProvider(config.provider);
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
function createToolAdapter(workspace: string, config: PureConfig): ToolAdapter {
  const inner = new TauriToolAdapter(workspace);
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
    // toolCallId → outcome, replayed as status rows (StoredMessage.toolExec)
    // when the session is restored from storage.
    const toolResults = new Map<string, ToolExecMeta>();
    // Live thinking card: created once the user bubble lands, finalized on the
    // first content/tool delta, and nulled so a later reasoning phase (after
    // tool results) opens a fresh card below whatever it followed.
    let thinkingCard: ThinkingCardHandle | null = null;
    const endThinking = () => {
      if (!thinkingCard) return;
      finalizeThinkingCard(thinkingCard);
      thinkingCard = null;
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
      let systemPrompt = buildSystemPrompt(!!effectiveWorkspace, usingTemporaryWorkspace);

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

      // Rebind the watcher when a session switches between its application
      // tmp directory and an explicit user workspace (or vice versa). The
      // MCP client is reused; only the filesystem watcher is workspace-bound.
      if (this.deferredInitDone && this.watcherWorkspace !== effectiveWorkspace) {
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
        // Code-review skill toggle: when disabled, fall back to the pure
        // rule-based verifier (non-empty-output check) instead of the
        // LLM re-check of the final output against the task.
        verifier: (config.skills?.['code-review'] ?? true) ? createLLMVerifier(llm) : createDefaultVerifier(),
      });

      // ── Logical-trap pre-scan (runs in plain-chat AND workspace mode):
      // contradictory / impossible / trick premises are flagged before the
      // run and injected into the system prompt so the model verifies the
      // premise instead of following it into a failure loop. The same analysis
      // also drives the plan review below.
      const analysis = codingAgent.analyzeTask(userText);
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
      // workspace when the user has not selected a project directory.
      if (effectiveWorkspace && (config.skills?.planning ?? true)) {
        if (analysis.complexity === 'complex' && analysis.plan) {
          const decision = await requestPlanReview(analysis);
          if (decision === 'cancel') return; // finally resets streaming, no bubbles left behind
          if (decision === 'approve') {
            systemPrompt += formatPlanForPrompt(analysis.plan);
          }
        }
      }

      // Add bubbles after the (possibly interactive) pre-flight so a cancelled
      // plan review leaves no ghost messages in the chat. User text stays raw
      // escaped text, but path-shaped substrings become clickable.
      const userBubble = this.addBubble('user', userText);
      linkifyPaths(userBubble);
      // Surface detected logical traps as a neutral notice (not an error): the
      // agent will verify the premise before executing.
      if (analysis.traps.length > 0) {
        const labels = [...new Set(analysis.traps.map(t => TRAP_TYPE_LABELS[t.type] ?? t.type))].join('、');
        this.addStatusBubble(`⚠️ 检测到请求中可能包含逻辑陷阱（${labels}）— 将先验证前提，若前提有误会换思路处理`);
      }
      // Eager thinking indicator: the user sees the animation while waiting
      // for the first token; reasoning deltas upgrade it with live text.
      thinkingCard = openThinkingCard();
      chatEl.scrollTop = chatEl.scrollHeight;

      // ── Deferred init: boot MCP + FileWatcher on first use ──
      if (!this.deferredInitDone) {
        this.deferredInitDone = true;
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
            if (event.payload.to === 'THINK') assistantIteration++;
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
                const parsed = parseToolCallBuffer(event.payload.toolCallBuffer);
                const args = parsed.args || {};
                if (toolCallId) {
                  // Id-bearing chunk (`tool_call` / `done`): key the row by
                  // toolCallId so parallel same-name calls get distinct rows.
                  // Migrate a name-staged streaming row if one exists.
                  let entry = pendingRows.get(toolCallId);
                  if (!entry) {
                    const staged = pendingByName.get(toolName);
                    if (staged) {
                      pendingByName.delete(toolName);
                      entry = { ...staged, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    } else {
                      endThinking();
                      const row = this.addToolRow(toolName, args);
                      toolRowSinceSegment = true;
                      entry = { row, toolName, args, toolCallId };
                      pendingRows.set(toolCallId, entry);
                    }
                  }
                  entry.args = args;
                  updateToolRowArgs(entry.row, toolName, args);
                } else {
                  // Mid-stream argument delta: id unknown, stage by name. The
                  // final id-bearing chunk migrates this entry.
                  const existing = pendingByName.get(toolName);
                  if (!existing) {
                    endThinking();
                    const row = this.addToolRow(toolName, args);
                    toolRowSinceSegment = true;
                    pendingByName.set(toolName, { row, toolName, args });
                  } else {
                    existing.args = args;
                    updateToolRowArgs(existing.row, toolName, args);
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
            if (thinkingPhases.length === 0 || thinkingCard.textEl.textContent === '') {
              thinkingPhases.push({ text: '', assistantIndex: thinkingAssistantOffset + Math.max(assistantIteration, 0) });
            }
            thinkingPhases[thinkingPhases.length - 1].text += content;
            appendThinkingText(thinkingCard, content);
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
            // Cancel any throttled streaming render on every segment so a
            // late-firing tick from before completion cannot race with the
            // final pipeline below.
            for (const seg of assistantSegments) cancelStreamingRender(seg.el);
            resolvePendingToolRows(pendingRows, pendingByName);
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
            resolvePendingToolRows(pendingRows, pendingByName);
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
        await this.persistSession(finalMessages, toolResults, thinkingPhases, sendSessionId, sendWorkspace);
      }
    } catch (err: any) {
      endThinking();
      for (const seg of assistantSegments) {
        seg.el.classList.remove('streaming');
        cancelStreamingRender(seg.el);
      }
      resolvePendingToolRows(pendingRows, pendingByName);
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
    // Keep mcpClient and fileWatcher alive across clear
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
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  private addStatusBubble(text: string, pending = false, isError = false) {
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

  private addToolRow(toolName: string, args: Record<string, unknown>): ToolRowHandle {
    const chatEl = document.getElementById('chat')!;
    const row = createToolRow(toolName, args);
    chatEl.appendChild(row.el);
    scrollChatToBottomIfPinned(chatEl);
    return row;
  }

  private setStreaming(v: boolean) {
    this.streaming = v;
    this.onStreamingChange?.(v);
  }
}
