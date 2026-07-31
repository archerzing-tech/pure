// src/ui/chat.ts
// v0.6 — Uses CodingAgent/Harness instead of self-built ReAct loop.
// Iterates over EngineEvents stream to update the UI reactively.

import { loadConfig, hasConfiguredKey, type PureConfig } from './settings';
import { saveSession, loadLastSession, type StoredMessage } from './store';
import { MemoryEngine, loadMemoryProfile, saveMemoryProfile } from '../shared/memory';
import { CodingAgent } from '../coding-agent/CodingAgent';
import { createLLMVerifier } from '../coding-agent/Verifier';
import { requestPermission } from './permission';
import { requestPlanReview, formatPlanForPrompt } from './plan';
import { TauriToolAdapter } from './TauriToolAdapter';
import { OpenAICompatibleAdapter } from '../adapter/openai/OpenAICompatibleAdapter';
import { RustLLMAdapter } from '../adapter/rust/RustLLMAdapter';
import { isTauriRuntime } from '../shared/tauri';
import { renderMarkdown, scheduleStreamingRender, cancelStreamingRender } from './markdown';
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
import type { PermissionMode, PermissionRequestHandler, PermissionRequestInfo, PermissionDecision } from '../coding-agent/types';

const DEFAULT_BUDGET: BudgetConfig = {
  maxTurns: 30,
  maxTotalTokens: 200_000,
  maxExecutionTime: 600_000,
  warningThreshold: 0.8,
  graceTurns: 3,
};

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

Web tools:
- web_search(query, maxResults?) — DuckDuckGo web search (no API key needed)
- web_fetch(url, maxChars?) — fetch and extract readable text from a URL

Work step by step. Read before you write. Verify after you change. Be concise.

Smart typo tolerance: when the user's message contains obvious typos, pinyin / IME errors ('ji' mapped to the wrong hanzi, homophone slips, repeated/reordered/full-width-punctuation typos), infer their intended meaning, answer that, and briefly note your assumption at the top of the reply (e.g., "Assuming you meant …").`;

const NOOP_TOOL_ADAPTER: ToolAdapter = {
  execute: async (tc: ToolCall): Promise<ToolResult> => ({
    id: tc.id,
    toolName: tc.function.name,
    error: 'Workspace not configured — tools disabled',
    success: false,
    duration: 0,
  }),
  getMetadata: () => undefined,
  getTools: () => [],
};

const memory = new MemoryEngine(loadMemoryProfile() ?? undefined);

function buildSystemPrompt(): string {
  const mem = memory.buildMemoryPrompt();
  return mem ? `${BASE_SYSTEM_PROMPT}${mem}` : BASE_SYSTEM_PROMPT;
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
  if (tool === 'read_file' || tool === 'list_files' || tool === 'search_files' || tool === 'glob_files' || tool === 'diff_files') return 'read';
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
  if (isTauriRuntime()) {
    // Desktop: the key lives in Rust secrets (~/.pure/secrets.json, 0600) and
    // is resolved inside `chat_stream` — it never passes through the WebView.
    return new RustLLMAdapter({
      provider: config.provider,
      model: config.model || defaultModelForProvider(config.provider),
      baseURL: config.baseURL || providerBaseURL(config.provider),
      extraBody: config.provider === 'glm' ? { tool_stream: true } : undefined,
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
  });
}

function createToolAdapter(workspace: string): ToolAdapter {
  if (!workspace) return NOOP_TOOL_ADAPTER;
  return new TauriToolAdapter(workspace);
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

  constructor() {
    this.sessionId = `session_${Date.now()}`;
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
    return saved.messages;
  }

  setWorkspace(path: string) {
    this.workspace = path;
  }

  async send(userText: string) {
    const chatEl = document.getElementById('chat')!;
    const config = loadConfig();
    if (!hasConfiguredKey(config)) return;

    this.cancel();
    this.setStreaming(true);
    this.abortController = new AbortController();

    // Hoist the streamingRender flag once — toggle defaults to true, but
    // users on low-end hardware can disable it from Settings → Chat to skip
    // the 100ms throttled markdown re-render entirely. Reading loadConfig()
    // on every TokenDelta would parse JSON hundreds of times per turn,
    // undermining the perf benefit the toggle is supposed to provide.
    const streamingRenderEnabled = (loadConfig()?.streamingRender ?? true);

    let assistantBubble: HTMLDivElement | null = null;
    let finalMessages: Message[] = [];

    try {
      // All setup that could throw synchronously (adapter creation, agent construction)
      memory.learnFromMessage(userText);
      let systemPrompt = buildSystemPrompt();

      const llm = createLLMAdapter(config);
      const toolAdapter = createToolAdapter(this.workspace);

      const codingAgent = new CodingAgent({
        sessionId: this.sessionId,
        llm,
        toolAdapter,
        // Let CodingAgent use its full ToolRegistry (built-ins + subagents + MCP).
        // With no workspace, advertise no tools at all (plain chat mode).
        toolsDefs: this.workspace ? undefined : [],
        budget: DEFAULT_BUDGET,
        mcpClient: this.mcpClient,
        fileWatcherInstance: this.fileWatcher,
        mcpServers: this.deferredInitDone ? undefined : (config.mcpServers ?? []),
        fileWatcher: this.deferredInitDone ? undefined : (this.workspace ? { cwd: this.workspace } : undefined),
        permissionMode: mapPermissionMode(config.permissionMode),
        permissionHandler: createPermissionHandler(config),
        // LLM-based verification: the model checks the final output against the
        // task in the VERIFY phase (replaces the pure rule-based default).
        verifier: createLLMVerifier(llm),
      });

      // ── Plan review pre-flight (P1-6): complex tasks get a user-approved
      // plan before execution. Skipped in plain-chat mode (no workspace) and
      // when the user disabled the planning skill in Settings → Skills.
      if (this.workspace && (config.skills?.planning ?? true)) {
        const analysis = codingAgent.analyzeTask(userText);
        if (analysis.complexity === 'complex' && analysis.plan) {
          const decision = await requestPlanReview(analysis);
          if (decision === 'cancel') return; // finally resets streaming, no bubbles left behind
          if (decision === 'approve') {
            systemPrompt += formatPlanForPrompt(analysis.plan);
          }
        }
      }

      // Add bubbles after the (possibly interactive) pre-flight so a cancelled
      // plan review leaves no ghost messages in the chat.
      this.addBubble('user', userText);
      chatEl.scrollTop = chatEl.scrollHeight;
      assistantBubble = this.addBubble('assistant', '');
      assistantBubble.classList.add('streaming');

      // ── Deferred init: boot MCP + FileWatcher on first use ──
      if (!this.deferredInitDone) {
        this.deferredInitDone = true;
        this.mcpClient = codingAgent.mcpClient;
        this.fileWatcher = codingAgent.fileWatcher;

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

      // Track pending tool-call status bubbles so we can show "calling…"
      // before execution and "✓/✗" on ToolResult.
      const pendingToolBubbles = new Map<string, HTMLDivElement>();

      for await (const event of events) {
        switch (event.type) {
          case 'TokenDelta': {
            if (!event.payload.isToolCall) {
              const delta = event.payload.content;
              if (delta) {
                const text = (assistantBubble.textContent || '') + delta;
                assistantBubble.textContent = text;
                if (streamingRenderEnabled) {
                  scheduleStreamingRender(text, assistantBubble);
                }
              }
              chatEl.scrollTop = chatEl.scrollHeight;
            } else {
              // LLM is emitting a tool call — extract the tool name from the
              // accumulated buffer and show a "calling" status bubble so the
              // user can see what the agent is about to do before it happens.
              const buf = event.payload.toolCallBuffer || '';
              const nameMatch = buf.match(/"name"\s*:\s*"([^"]+)"/);
              if (nameMatch) {
                const toolName = nameMatch[1];
                // Only one pending bubble per tool name at a time — cleanly
                // handles multi-delta tool calls without duplicates.
                if (!pendingToolBubbles.has(toolName)) {
                  const bubble = this.addStatusBubble(`🔧 ${toolName} …`, true);
                  pendingToolBubbles.set(toolName, bubble);
                  chatEl.scrollTop = chatEl.scrollHeight;
                }
              }
            }
            break;
          }

          case 'ToolResult': {
            const status = event.payload.result.success ? '✓' : '✗';
            const toolName = event.payload.toolName;
            const duration = event.payload.duration;
            // Resolve the pending bubble (if any), otherwise append new.
            const pending = pendingToolBubbles.get(toolName);
            if (pending) {
              pending.textContent = `🔧 ${toolName}: ${status} (${duration}ms)`;
              pending.parentElement?.classList.remove('pending');
              pendingToolBubbles.delete(toolName);
            } else {
              this.addStatusBubble(`🔧 ${toolName}: ${status} (${duration}ms)`);
            }
            chatEl.scrollTop = chatEl.scrollHeight;
            break;
          }

          case 'Error':
            this.addStatusBubble(`⚠️ ${event.payload.code}: ${event.payload.message}`);
            chatEl.scrollTop = chatEl.scrollHeight;
            break;

          case 'Completed':
            // Cancel any throttled streaming render so a late-firing tick from before
            // completion cannot race with the final pipeline below.
            cancelStreamingRender(assistantBubble);
            assistantBubble.classList.remove('streaming');
            if (event.payload.finalOutput) {
              // Render markdown + code highlights + mermaid + plantuml. Fire-and-forget so
              // the for-await loop doesn't block on the async mermaid render; the bubble is
              // visibly replaced as soon as innerHTML is set synchronously inside renderMarkdown.
              void renderMarkdown(event.payload.finalOutput, assistantBubble);
            }
            if (event.payload.messages) {
              finalMessages = event.payload.messages;
              this.messages = event.payload.messages;
              this.hasHistory = true;
            }
            break;

          case 'Interrupted':
            assistantBubble.classList.remove('streaming');
            if (event.payload.reason !== 'aborted') {
              assistantBubble.textContent = (assistantBubble.textContent || '') + `\n\n⏹ Interrupted: ${event.payload.reason}`;
            } else {
              assistantBubble.textContent = assistantBubble.textContent || '(cancelled)';
            }
            chatEl.scrollTop = chatEl.scrollHeight;
            break;
        }
      }

      // Persist session and memory
      if (finalMessages.length > 0) {
        await this.persistSession(finalMessages);
      }
      saveMemoryProfile(memory.getProfile());
    } catch (err: any) {
      assistantBubble?.classList.remove('streaming');
      if (err.name === 'AbortError') {
        if (assistantBubble) assistantBubble.textContent = assistantBubble.textContent || '(cancelled)';
      } else if (assistantBubble) {
        assistantBubble.textContent = `Error: ${err.message || err}`;
        assistantBubble.classList.add('error');
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
    this.messages = [];
    this.hasHistory = false;
    this.sessionId = `session_${Date.now()}`;
    // Keep mcpClient and fileWatcher alive across clear
    const chatEl = document.getElementById('chat')!;
    chatEl.innerHTML = '';
  }

  cancel() {
    this.abortController?.abort();
  }

  private async persistSession(messages: Message[]) {
    if (messages.length <= 1) return;
    const storedMsgs: StoredMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content ?? null,
      tool_call_id: m.toolCallId,
      name: m.toolName,
      tool_calls: m.toolCalls as unknown[] | undefined,
    }));
    await saveSession(this.sessionId, storedMsgs);
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

  private addStatusBubble(text: string, pending = false) {
    const chatEl = document.getElementById('chat')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'bubble-row status';
    if (pending) wrapper.classList.add('pending');
    const bubble = document.createElement('div');
    bubble.className = 'bubble status';
    bubble.textContent = text;
    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    return bubble;
  }

  private setStreaming(v: boolean) {
    this.streaming = v;
    this.onStreamingChange?.(v);
  }
}
