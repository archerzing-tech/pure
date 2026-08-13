# pure Spec — Corrected Implementation Guide

> 对应实现：v1.9.2-beta7。涉及主动评估、Prompt observability 和评测时，以 `src/coding-agent/Planner.ts`、`src/shared/PromptAssembler.ts`、`src/shared/promptObservability.ts`、`src/evaluation/`、`src/ui/chat.ts` 和 `src/cli.ts` 为运行时参考；本文件定义跨文档的 canonical 契约。
>
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
| 1 | `system-prompt.md` | The agent's system prompt (original; see note below) — layered prompt architecture (L0 system / L1 application / L2 user) defined in its header + `src/shared/promptLayers.ts` |
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
  - `secret_get` / `secret_set` (keyring)
  - `spawn_mcp` / `mcp_request` (subprocess transport)
  - **`chat_stream`** (LLM API relay via reqwest HTTP/2 + Tauri Channel, see §5.1)
- Rust `SessionManager` manages **Rust-side resources** (PTY handles, subprocess PIDs,
  reqwest connection pool) keyed by `sessionId`. It does **not** hold a `Harness` instance.
- The TypeScript `ToolRegistry` dispatches: pure file ops run directly in Node; shell/PTY/MCP/keyring
  go through `invoke(...)` to Rust.

### 2.1 LLM Transport: Tauri IPC (preferred) vs Browser SSE (fallback)

Desktop builds route LLM streaming through Rust via Tauri IPC, never exposing API keys to the webview:

```
WebView (TS)                         Rust (Tauri)
─────────────                       ─────────────
AgentLoopEngine  ──invoke──▶        execute_command
Harness                              / secret_* / spawn_mcp
ToolRegistry ──invoke──▶            (owns PTY, PIDs)
                                     
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
  Shared Kernel     types, VerifierAdapter
```

Engine is **stateless**: all mutable state lives in `LoopInputState`, which the engine mutates
and returns each step. Harness persists the per-session state via checkpoints at key turn boundaries.

### 3.1 主动评估层（Preflight Intent Assessment）

每个用户请求在进入写入型执行前，由 `Planner.analyzeTask(prompt)` 同时判断复杂度和请求意图。复杂度决定是否需要计划；主动评估决定是否先探针、解释影响或重新确认。两者是独立维度，不能用 `simple/complex` 代替风险判断。

```text
请求
  ↓
Planner.analyzeTask
  ├─ low    → 读取相关内容 → 直接执行 → 针对性验证
  ├─ medium → 只读工作区探针 → 小步修改 → 立即验证
  ├─ high   → 影响/可逆性/替代方案 → GUI 明确确认 → 执行
  └─ complex/build → 计划/澄清/交付契约 → 分阶段执行与验证
```

统一行为契约：

- `low`：问题咨询、研究、局部修复和单文件新产物可直接处理，但仍须先读后写、完成后验证。
- `medium`：项目级构建、认证/权限/数据库改动、迁移和重构等，若 workspace/tools 可用且 `requiresProbe` 为 true，先做只读探针，再扩大修改范围。
- `high`：删除、销毁、覆盖历史和破坏性迁移等，先展示影响、可逆性及更窄/可恢复替代方案；GUI 在写入前通过计划/安全评估卡确认。已有复杂计划或暂停计划时，高风险新请求必须重新进入确认，不得沿用旧计划游标绕过安全检查。
- CLI 会把同一评估放入本轮 user context 并打印中/高风险提示；普通请求默认自动批准，高风险评估强制启用交互式权限处理器，`--prompt-on-tool` 可对所有请求逐工具交互确认，不能把安全性只建立在模型主动询问上。
- 该层是策略前置，不替代 `PermissionManager` 对每一次具体工具调用的最终门控；工具风险和具体参数仍以权限系统为准。复杂度、计划粒度和 Todo 只是模型的工作建议：程序可以解析和展示结构化计划、恢复游标并消费可选进度标记，但不把固定步骤数量、每轮一个 Todo、固定标题或自动追加测试步骤当作安全规则。

### 3.2 当前会话工作区撤销

CLI 与 GUI 的工具适配器都提供当前进程内的最近一次写入批次撤销能力。每次成功的 `write_file`、`edit_file`、`replace_files` 或新建目录操作会记录写入前状态和写入后内容；用户可通过 CLI `/undo` 或 GUI 输入框旁的撤销入口恢复。撤销前会比较写入后的内容，若文件已被外部修改则报告冲突而不覆盖。该能力不写入会话持久化，不替代跨重启 rewind，也不允许删除工作区根目录或工作区之外的路径。

### 3.3 上下文压缩契约

上下文压缩是 Harness 的通用容量管理能力，不是复杂任务拆分器，也不根据关键词追加固定 Todo 或测试步骤。`ContextEngine.compact(messages)` 返回新的消息窗口及 `compacted`、`summarized`、`evictedMessages`、`estimatedTokens`、`overBudget`、`oversizedNewestGroup` 元数据；`trim(messages)` 是自动执行路径的兼容简写。

- system 消息始终保留；工具调用 assistant 消息与其全部匹配的 tool 结果必须成组保留或成组淘汰。
- 不完整的 assistant tool call 和孤立 tool 结果不得进入下一次 provider 请求。
- 按消息数和估算 Token 数限制最近窗口；若最新完整工具组本身超过预算，不拆分该组，以保证 provider 消息序列有效。
- LLM 摘要失败不能阻断执行；摘要只是被淘汰内容的辅助记忆，不替代原始可见 transcript。重复压缩会折叠旧的 `Earlier conversation summary:`，并把 system/summary 消息计入估算 Token；最新完整消息组若仍超过预算则标记 `overBudget`，但不拆分。
- CLI REPL 的 `/compact` 与 GUI 的 `⌁` 只更新下一轮执行窗口，不删除用户可见历史；GUI 的自动预压缩使用同一个 `ContextEngine`。
- 具体计划粒度、阶段数和验证方式仍由模型结合本轮任务决定，不能从本节推出固定复杂任务规则。

### 3.4 Prompt observability 与真实编码评测契约

Prompt observability 是执行旁路，不是 prompt 层级：

- `PromptAssembler.assemble()` 记录 provider/model、budget、fragment selection、tool schema cost、长度哈希和 assembly `traceId`；它不得改变返回的 system/user 内容。
- Harness 通过同一 trace 记录 EngineEvent、工具耗时、usage、verification、终态和异常收束；默认只保存结构化元数据和哈希，Node JSONL sink 需要显式启用。
- 真实评测 fixture 位于 `src/evaluation/codingTaskBaseline.ts`，每个任务使用独立临时 workspace 和真实 verification command；`passAt1` 只有在 agent 正常完成且所有验证通过时才为真。
- 报告必须区分 `control`、`fixture_error`、`agent_error`、`failed` 和 `passed`，并包含 suite/fixture hash、provider/model、prompt version、runtime、revision、usage、duration 和 cost。

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
type RequestIntent = 'question'|'research'|'add'|'modify'|'debug'|'refactor'|'migrate'|'delete'|'build';
type RiskLevel = 'low'|'medium'|'high';
type Reversibility = 'reversible'|'partially-reversible'|'hard-to-reverse'|'irreversible';
interface IntentAssessment {
  intent: RequestIntent; riskLevel: RiskLevel; reversibility: Reversibility;
  impact: string; recommendation: string;
  requiresProbe: boolean; requiresConfirmation: boolean;
}
// Plan / TrapWarning are Coding Agent application-layer types;
// canonical definitions: Coding Agent 设计文档 §2 and src/coding-agent/types.ts.
interface AnalysisResult {
  complexity: 'simple'|'complex'; mode: 'yolo'|'plan'|'build'; plan?: Plan;
  reasoning: string; traps: TrapWarning[]; intent: IntentAssessment;
}
// BudgetConfig: Agent-Event-Loop Engine 设计文档 §4;
// HookRouter: Agent-Event-Loop Engine 设计文档 §6.2;
// VerifierAdapter: src/shared/VerifierAdapter.ts and Adapter Layer 设计文档.
// Import/reference these contracts rather than redefining them here.
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

1. Planner runs `analyzeTask(prompt)` and produces the canonical `AnalysisResult`; GUI/CLI compose its request-scoped assessment with `composeUserTurn(..., { assessment })` rather than appending it to the stable system prompt. For complex work, the LLM-generated plan is authoritative for task-specific decomposition; the Planner plan is only a bounded fallback when analysis is unavailable.
2. For `medium` requests, Harness/CLI/GUI perform the available read-only workspace probe before choosing the exact edit; for `high` GUI requests, the safety/plan review must finish before any write. A high-risk follow-up reopens that review even when an earlier complex plan is active or paused.
3. Harness builds `messages = [system(systemPrompt), user(prompt)]` and a `LoopInputState`.
4. Engine `run()` / `continue()` is an `AsyncGenerator<EngineEvent>` that **owns `messages`** for the session and:
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
5. `TERMINATE` → append nothing; break; yield **`Completed`** with `{ finalOutput, isComplete, interrupted, turnCount, messages }`.
6. `StreamManager` forwards events to the UI. It must **preserve** `stateId`/`isToolCall` when
   merging `TokenDelta` (the original cleared them — fixed in the Engine doc).
7. For multi-turn (user follow-up): Harness saves `Completed.messages`, calls `engine.continue({ messages, newUserPrompt, budget })` to resume the same session with the full history.

> **Critical:** `messages` is the conversation and MUST grow every turn. The LLM must receive
> `toolsDefs` on every call. `finalOutput` MUST be set before `Completed`.

> **Context pruning:** When the conversation approaches the model's context window, Harness MAY
> evict older messages. Any `assistant` message containing `toolCalls` and its matching `tool`
> messages (identified by `toolCallId`) MUST be kept or evicted as an atomic group. Incomplete
> assistant tool calls and orphan tool messages MUST NOT be sent to the provider. The visible
> transcript may remain intact while the next execution window is compacted.

---

## 6. Phases (corrected acceptance criteria)

Each phase must produce a **runnable** artifact, not "0 tests pass".

| Phase | Build | Done when |
|-------|-------|-----------|
| 1 Shared Kernel | types, VerifierAdapter | `tsc` clean; types importable |
| 2 Engine | BudgetManager, FailurePolicy, HookRouter, **AgentLoopEngine (all 5 state handlers)** | Unit test: a scripted mock LLM completes a 2-turn tool loop and sets `finalOutput` |
| 3 Harness | StateManager (checkpoint-based), ContextEngine (wired), StreamManager (fixed merge), MCPClient (wired to config) | Integration: Harness + Mock engine completes a task and checkpoints are restorable |
| 4 Adapter | LLMAdapter iface, Anthropic/OpenAI (**send tool defs, correct message mapping**), Mock, ToolRegistry (real tools), SQLiteStore | Adapter test: tool call round-trip; Anthropic/OpenAI shape-checked against a fixture |
| 5 Coding Agent | layered system/user prompt, flat ToolRegistry with tags, Planner/analyzeTask + IntentAssessment, PermissionManager (IPC round-trip), Verifier | E2E: a real prompt reads/edits a file, verifies, and high-risk follow-up cannot bypass review |
| 6 Frontend | IPC bridge, ChatPanel, Monaco, PermissionDialog, PlanReview | `vite` renders streamed tokens + tool results |
| 7 Rust | Tauri IPC: execute_command(PTY), secret_*, spawn_mcp; SessionManager owns Rust resources only | `tauri dev` launches; tools execute via Rust |
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
- `ContextEngine` actually called in `Harness.run`.
- Anthropic/OpenAI adapters send tool defs and use correct `tool_use`/`tool_result` blocks.
- `ShellToolAdapter` glob/grep fixed; shell routed through Rust PTY.
- `Planner`/`analyzeTask` specified with canonical `IntentAssessment` (Coding Agent doc).
- Request-scoped assessment is composed into the L2 user prompt; stable system prompt remains separate.
- Medium-risk work can use a read-only workspace probe; GUI high-risk work requires explicit pre-write review, including active/paused-plan follow-ups.
- `PermissionManager` request-response designed as a Tauri IPC round-trip; CLI defaults to auto-approved permission handling for ordinary requests, forces interactive confirmation for high-risk assessments, and exposes `--prompt-on-tool` for interactive per-tool confirmation on every request.

- Model names are placeholders (`claude-…`, `gpt-4o`); no fabricated version numbers.

> End of pure master spec.
