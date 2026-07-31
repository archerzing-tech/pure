# pure Spec — Corrected Implementation Guide

> **This is the master spec.** Feed it to an LLM together with the reference documents
> listed in §1. The original drafts contained contradictions and broken reference code;
> this version is the source of truth. Where a reference doc disagrees with this file,
> this file wins.

---

## 1. Document set & reading order

There are **five** design documents plus this spec and the system prompt. Read in this order:

| # | File | What it defines |
|---|------|-----------------|
| 0 | `pure Spec.md` (this file) | Master spec, architecture decision, data flow, canonical types |
| 1 | `system-prompt.md` | The agent's system prompt (original; see note below) |
| 2 | `Agent-Event-Loop Engine 设计文档.md` | Stateless scheduling engine |
| 3 | `Adapter Layer 设计文档.md` | LLM / tool / storage / MCP adapters |
| 4 | `Harness 设计文档.md` | Stateful session management |
| 5 | `Coding Agent 设计文档.md` | Application layer (tools, planner, permission, verifier) |
| 6 | `三层依赖关系总结.md` | Architecture summary + project config |

> **Note on the system prompt:** The system prompt in `system-prompt.md` is **original**.
> Do not use any leaked third-party source code; write to the public behavior contract only.

---

## 2. Architecture decision (resolves the TS/Rust contradiction)

The earlier drafts contradicted themselves: they said "core is pure TS, runtime-agnostic" but
also had Rust `SessionManager` owning a TypeScript `Harness`. That is impossible. The decision:

- **Agent core (Engine + Harness + Adapter + Coding Agent) runs in TypeScript inside the WebView (renderer).**
- **Rust (Tauri) provides OS capabilities AND LLM transport**, exposed as async IPC commands:
  - `execute_command` (shell via PTY, streaming)
  - `watch_files` (notify)
  - `secret_get` / `secret_set` (keyring)
  - `spawn_mcp` / `mcp_request` (subprocess transport)
  - **`chat_stream`** (LLM API relay via reqwest HTTP/2 + Tauri Channel, see §5.1)
- Rust `SessionManager` manages **Rust-side resources** (PTY handles, subprocess PIDs, file watchers,
  reqwest connection pool) keyed by `sessionId`. It does **not** hold a `Harness` instance.
- The TypeScript `ToolRegistry` dispatches: pure file ops run directly in Node; shell/PTY/MCP/keyring
  go through `invoke(...)` to Rust.

### 2.1 LLM Transport: Tauri IPC (preferred) vs Browser SSE (fallback)

Desktop builds route LLM streaming through Rust via Tauri IPC, never exposing API keys to the webview:

```
WebView (TS)                         Rust (Tauri)
─────────────                       ─────────────
AgentLoopEngine  ──invoke──▶        execute_command / watch_files
Harness                              / secret_* / spawn_mcp
ToolRegistry ──invoke──▶            (owns PTY, PIDs, watchers)
                                     
ChatController ──Channel──▶         chat_stream
  │ onChunk.onmessage                │ reqwest HTTP/2 SSE
  │ (token-by-token)                 │ emit delta → Channel
  ▼                                  ▼
  UI updates                         DeepSeek / Qwen / GLM API
```

**Why Tauri IPC for LLM:**
| | Browser fetch SSE | Tauri IPC (reqwest) |
|:------|:------|:------|
| API Key | ❌ 暴露在 JS, XSS 可窃取 | ✅ 仅 Rust 侧持有 |
| HTTP/2 | ❌ 浏览器不保证 H2 | ✅ reqwest 原生 H2 多路复用 |
| 连接池 | ❌ 6 连接/domain | ✅ 无限制连接池复用 |
| 取消 | ❌ AbortController | ✅ Tauri Channel drop |
| CORS | ❌ 需代理 | ✅ 无需 CORS |

Browser fetch SSE remains as fallback for `vite dev` (plain browser, no Tauri runtime).

---

## 3. Layers (unchanged intent, fixed ownership)

```
Desktop Shell (Tauri 2.x + React)   ← IPC (Channel / invoke)
  Coding Agent      depends on Harness + Engine + Adapter
  Harness           depends on Engine + Adapter        (stateful, per session; checkpoint-based)
  Agent-Event-Loop  pure TS, zero deps                 (stateless)
  Adapter Layer     LLM / tools / storage / MCP        (all I/O)
  Shared Kernel     EventBus, types, VerifierAdapter
```

Engine is **stateless**: all mutable state lives in `LoopInputState`, which the engine mutates
and returns each step. Harness persists the per-session state via checkpoints at key turn boundaries.

---

## 4. Canonical types (fixes from the original)

> **单点真相（Single Source of Truth）**：本节定义的类型是所有文档的唯一引用源。
> 其他文档 **不得** 重新定义 `Message`、`ToolCall`、`ToolResult`、`ToolDefinition`、
> `LLMAdapter`、`ToolAdapter`、`BudgetSnapshot`、`AgentStateType` 等类型，
> 而应通过 `import` 引用或在文档中标注 `见 pure Spec §4`。

Key corrections vs the original draft:
- `StateChangeEvent.from/to` are `AgentStateType` (`'THINK'|'ACT'|…`), **not** `AgentStatus`.
- `HookTriggeredEvent.action` allows `'retry'` (matches `HookResult.action`).
- `LLMAdapter` takes `tools: ToolDefinition[]` so the model actually knows about tools.
- `LoopResult` carries `messages`, `finalOutput`, `interrupted`.

```typescript
type Role = 'system' | 'user' | 'assistant' | 'tool';
interface Message {
  role: Role; content: string;
  toolCallId?: string; toolName?: string; name?: string;
  toolCalls?: ToolCall[];
}
interface ToolCall { id: string; index: number; function: { name: string; arguments: string }; }
interface ToolResult { id: string; toolName: string; result?: unknown; error?: string; success: boolean; duration: number; }

interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown>; }
interface LLMChunk
  | { type: 'content'; content: string }
  | { type: 'tool_call_delta'; index: number; name?: string; arguments?: string }
  | { type: 'tool_call'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; content: string; toolCalls: ToolCall[] };
interface LLMResponse { content: string; toolCalls?: ToolCall[]; }
interface LLMAdapter {
  stream(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LLMChunk, void, void>;
  complete(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}

interface ToolAdapter {
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined;
  getTools(): ToolDefinition[];
}

type AgentStateType = 'THINK'|'ACT'|'OBSERVE'|'VERIFY'|'TERMINATE';
// Message 类型已在上方定义（interface Message），此处不再重复。
// 所有文档必须引用此处的 canonical Message 定义，不得自行重新定义。
export interface RunInput { sessionId: string; systemPrompt: string; userPrompt: string; budget: BudgetConfig; }
export interface RunContinueInput { sessionId: string; messages: Message[]; newUserPrompt: string; budget: BudgetConfig; systemPrompt?: string; }
interface LoopInputState {
  sessionId: string; messages: Message[]; budget: BudgetSnapshot;
  turnCount: number; status: 'idle'|'running'|'completed'|'interrupted'|'error';
  finalOutput?: string; metadata: Record<string, unknown>;
}
interface FailureRecord {
  type: 'verify_failure' | 'tool_error' | 'llm_error';
  message: string; turnNumber: number; toolName?: string;
}
type FailureAction =
  | { kind: 'retry'; hint: string }
  | { kind: 'reflect'; hint: string }
  | { kind: 'degrade'; reason: string }
  | { kind: 'stop'; reason: string };
interface FailurePolicy {
  decide(failures: FailureRecord[]): FailureAction;
}

interface EngineContext {
  llm: LLMAdapter; tools: ToolAdapter; toolsDefs: ToolDefinition[];
  verifier?: VerifierAdapter; hooks?: HookRouter; failurePolicy?: FailurePolicy;
  budget: BudgetConfig; signal?: AbortSignal;
}
```

---

## 5. Data flow — the corrected ReAct loop (the original was broken)

The original engine **never accumulated messages** and **never sent tool schemas to the LLM**, so
the loop was dead. The corrected contract:

1. Harness builds `messages = [system(systemPrompt), user(prompt)]` and a `LoopInputState`.
2. Engine `run()` / `continue()` is an `AsyncGenerator<EngineEvent>` that **owns `messages`** for the session and:
   - `run(systemPrompt, userPrompt)` builds `[system, user]` and starts a session.
   - `continue(messages, newUserPrompt)` appends a new user message to existing dialogue.
   - Both delegate to the shared `runLoop()` which processes turns until completion/interrupt.
   - Loop body:...
     tool calls; append the assistant `Message` (with `toolCalls`) to `messages`.
   - If tool calls → **ACT**: execute each via `tools.execute`; append a `tool` `Message`
     (`toolCallId`, `toolName`, `content = JSON.stringify(result)`) to `messages`.
   - else → **VERIFY** (call `verifier.evaluate`); if pass set `finalOutput` and go **TERMINATE**.
   - On tool error or verification failure → inject a refinement/reflection hint note into `messages` and loop back to THINK.
   - Each turn: check `BudgetManager`; yield `YieldControl`; honor `AbortSignal`
     (yield `Interrupted` and stop).
3. `TERMINATE` → append nothing; break; yield **`Completed`** with `{ finalOutput, isComplete, interrupted, turnCount, messages }`.
4. `StreamManager` forwards events to the UI. It must **preserve** `stateId`/`isToolCall` when
   merging `TokenDelta` (the original cleared them — fixed in the Engine doc).
5. For multi-turn (user follow-up): Harness saves `Completed.messages`, calls `engine.continue({ messages, newUserPrompt, budget })` to resume the same session with the full history.

> **Critical:** `messages` is the conversation and MUST grow every turn. The LLM must receive
> `toolsDefs` on every call. `finalOutput` MUST be set before `Completed`.

> **Context pruning:** When the conversation approaches the model's context window, Harness MAY
> evict older messages. Any `assistant` message containing `toolCalls` and its matching `tool`
> messages (identified by `toolCallId`) MUST be evicted as an atomic pair. Splitting a tool-call
> pair causes the LLM API to reject the request.

---

## 6. Phases (corrected acceptance criteria)

Each phase must produce a **runnable** artifact, not "0 tests pass".

| Phase | Build | Done when |
|-------|-------|-----------|
| 1 Shared Kernel | types, EventBus, VerifierAdapter | `tsc` clean; types importable |
| 2 Engine | BudgetManager, FailurePolicy, HookRouter, **AgentLoopEngine (all 5 state handlers)** | Unit test: a scripted mock LLM completes a 2-turn tool loop and sets `finalOutput` |
| 3 Harness | StateManager (checkpoint-based), ContextEngine (wired), StreamManager (fixed merge), FileWatcher, MCPClient (wired to config) | Integration: Harness + Mock engine completes a task and checkpoints are restorable |
| 4 Adapter | LLMAdapter iface, Anthropic/OpenAI (**send tool defs, correct message mapping**), Mock, ToolRegistry (real tools), SQLiteStore | Adapter test: tool call round-trip; Anthropic/OpenAI shape-checked against a fixture |
| 5 Coding Agent | system prompt (§1), flat ToolRegistry with tags, Planner/analyzeTask, PermissionManager (IPC round-trip), Verifier | E2E: a real prompt reads/edits a file and verifies |
| 6 Frontend | IPC bridge, ChatPanel, Monaco, PermissionDialog, PlanReview | `vite` renders streamed tokens + tool results |
| 7 Rust | Tauri IPC: execute_command(PTY), watch_files, secret_*, spawn_mcp; SessionManager owns Rust resources only | `tauri dev` launches; tools execute via Rust |
| 8 E2E | Playwright across the desktop app | Full prompt→edit→verify flow works |

---

## 7. Known fixes applied vs the original drafts

- TS/Rust boundary resolved (§2).
- Engine accumulates `messages`; sends `toolsDefs`; sets `finalOutput`; emits `Interrupted` (§5).
- All 5 state handlers implemented (Engine doc).
- `StateChangeEvent` uses `AgentStateType`; `HookTriggeredEvent.action` includes `'retry'`.
- `StreamManager` preserves `stateId`/`isToolCall` on merge.
- `StateManager` persists full checkpoints at key turn boundaries instead of per-version patch chains.
- `MCPClient` connects servers from `HarnessConfig.mcpConfig` (was reading empty `discover({})`).
- `ContextEngine`/`FileWatcher` actually called in `Harness.run`.
- Anthropic/OpenAI adapters send tool defs and use correct `tool_use`/`tool_result` blocks.
- `ShellToolAdapter` glob/grep fixed; shell routed through Rust PTY.
- `Planner`/`analyzeTask` specified (Coding Agent doc).
- `PermissionManager` request-response designed as a Tauri IPC round-trip (not in-process EventBus).
- Model names are placeholders (`claude-…`, `gpt-4o`); no fabricated version numbers.

> End of pure master spec.
