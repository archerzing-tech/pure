# Agent-Event-Loop Engine 设计文档（修订版）

> 对应实现：v1.9.2；观测由 `src/harness/Harness.ts` 与 `src/shared/promptObservability.ts` 收口，评测入口位于 `src/evaluation/`。

> PHASE 2. 依赖 Shared Kernel 与 `pure Spec.md`。原始草稿的 `run`/`step` 参考实现
> **缺失 7/9 个状态处理器、不累积对话消息、不向 LLM 发送工具定义、永不设置 finalOutput**——
> 本修订版给出可运行的核心循环。带 `[SPEC]` 的必须实现；带 `[REF]` 的是参考实现。

## 1. 设计概要

无状态、基于 `AsyncGenerator` 流式产出的调度引擎。所有可变状态放在 `LoopInputState`，
由引擎在 `run()` 内持有并随事件返回。引擎 = 事件生产器，不是执行控制器。

核心修正：
- **对话消息在 `run()` 内累积**：每轮把 assistant / tool 消息 push 进 `messages`，下轮 LLM 才能看到历史。
- **工具定义随每次 LLM 调用传入**（修复"模型永不调用工具"）。
- **`finalOutput` 在 TERMINATE 前设置**，`Completed` 事件携带它。
- **`AbortSignal` 中途取消时 yield `Interrupted`**（原版从不发）。

## 1.1 本文件用到但未在此展开的类型

> **⚠️ 类型引用规则**：`Message`、`ToolCall`、`ToolResult`、`ToolDefinition` 等核心类型的
> canonical 定义在 `pure Spec.md` §4 (Canonical types)。本文件及其他文档 **不得** 重复定义，
> 必须通过 import 或注释引用 Spec §4。

```typescript
// RunInput / RunContinueInput / EngineContext 是引擎入口；EngineContext 完整定义在 pure Spec §4。
// Message / ToolCall / ToolResult / ToolDefinition 的完整定义见 pure Spec §4 (Canonical types)。
export interface RunInput {
  sessionId: string;
  systemPrompt: string;
  userPrompt: string;
  budget: BudgetConfig;
}
export interface RunContinueInput {
  sessionId: string;
  messages: Message[];        // 已有对话（system + 所有轮次），类型见 Spec §4
  newUserPrompt: string;
  budget: BudgetConfig;
  systemPrompt?: string;       // 可选：重新注入 system prompt（防止压缩丢失）
}
interface ThinkResult { content: string; toolCalls: ToolCall[]; assistantMessage: Message; error?: string; }
// BudgetConfig / BudgetManager / HookEventType 见本文件 §4；
// ToolCall / Message / ToolResult 见 pure Spec §4 (Canonical types)。
```

## 2. 事件类型（修正）

```typescript
type AgentStateType = 'THINK'|'ACT'|'OBSERVE'|'VERIFY'|'TERMINATE';

interface StateChangeEvent { type:'StateChange'; payload:{ from:AgentStateType; to:AgentStateType; stateId:string; reason?:string }; timestamp:number; }
interface TokenDeltaEvent { type:'TokenDelta'; payload:{ content:string; stateId:string; isToolCall:boolean; toolCallBuffer?:string }; timestamp:number; }
interface ToolResultEvent { type:'ToolResult'; payload:{ toolName:string; result:ToolResult; duration:number; toolCallId:string }; timestamp:number; }
// 注意：action 必须包含 'retry'，与 HookResult.action 一致
interface HookTriggeredEvent { type:'HookTriggered'; payload:{ hookType:HookEventType; action:'continue'|'abort'|'modify'|'retry'; result:HookResult[] }; timestamp:number; }
interface YieldControlEvent { type:'YieldControl'; payload:{ turnNumber:number; budget:BudgetSnapshot }; timestamp:number; }
interface ErrorEvent { type:'Error'; payload:{ code:string; message:string; stateType:AgentStateType; recoverable:boolean; recoveryAction?:'retry'|'reflect'|'skip'|'terminate' }; timestamp:number; }
interface BudgetWarningEvent { type:'BudgetWarning'; payload:{ exhausted:boolean; reason:string; remaining:{turns:number;tokens:number;time:number}; gracePeriodEnds:number }; timestamp:number; }
interface CompletedEvent { type:'Completed'; payload:{ finalOutput?:string; isComplete:boolean; interrupted:boolean; turnCount:number; messages?:Message[] }; timestamp:number; }
interface InterruptedEvent { type:'Interrupted'; payload:{ reason:string; lastState?:AgentStateType; completedSteps:string[] }; timestamp:number; }
interface NoOpEvent { type:'NoOp'; payload:{ reason:string }; timestamp:number; }
type EngineEvent = TokenDeltaEvent|StateChangeEvent|ToolResultEvent|HookTriggeredEvent|YieldControlEvent|ErrorEvent|BudgetWarningEvent|CompletedEvent|InterruptedEvent|NoOpEvent;
```

## 3. 核心循环（参考实现，按此实现即可跑通）

```typescript
// [REF] src/engine/AgentLoopEngine.ts
export class AgentLoopEngine {
  // ─── 新会话：system + user prompt ───
  async *run(input: RunInput, ctx: EngineContext): AsyncGenerator<EngineEvent, void, void> {
    const messages: Message[] = [
      { role:'system', content: input.systemPrompt },
      { role:'user',   content: input.userPrompt },
    ];
    yield* this.runLoop(input.sessionId, messages, ctx);
  }

  // ─── 续写对话：在已有历史后追加一条 user 消息 ───
  async *continue(input: RunContinueInput, ctx: EngineContext): AsyncGenerator<EngineEvent, void, void> {
    const messages = [...input.messages, { role:'user', content: input.newUserPrompt }];
    // 如果提供了 systemPrompt，确保第一条是 system 消息
    // 这修复了多轮对话中 system prompt 可能被 ContextEngine 压缩丢失的问题
    if (input.systemPrompt) {
      const firstSystemIdx = messages.findIndex(m => m.role === 'system');
      if (firstSystemIdx < 0) {
        messages.unshift({ role:'system', content: input.systemPrompt });
      } else if (messages[firstSystemIdx].content !== input.systemPrompt) {
        messages[firstSystemIdx] = { role:'system', content: input.systemPrompt };
      }
    }
    yield* this.runLoop(input.sessionId, messages, ctx);
  }

  // ─── 共享循环体（run / continue 共用） ───
  private async *runLoop(sessionId: string, messages: Message[], ctx: EngineContext): AsyncGenerator<EngineEvent, void, void> {
    const budget = new BudgetManager(ctx.budget);
    let turnCount = 0, finalOutput: string | undefined, interrupted = false;
    let phase: AgentStateType = 'THINK';
    let note: string | undefined;
    let lastToolCalls: ToolCall[] = [];
    const completedSteps: string[] = [];
    const sid = () => `st_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

    // 循环直接从 THINK 开始（GATHER 阶段由 Harness 在调用 Engine.run() 前完成）

    while (true) {
      if (ctx.signal?.aborted) {
        yield { type:'Interrupted', payload:{ reason:'aborted', completedSteps }, timestamp: Date.now() };
        interrupted = true; break;
      }
      const bs = budget.check();
      if (bs.exhausted && !budget.inGracePeriod()) {
        yield { type:'BudgetWarning', payload:{ exhausted:true, reason:bs.reason!, remaining:budget.remaining(), gracePeriodEnds:budget.gracePeriodEnd }, timestamp: Date.now() };
        yield { type:'Interrupted', payload:{ reason:bs.reason!, completedSteps }, timestamp: Date.now() };
        interrupted = true; break;
      } else if (bs.warning) {
        yield { type:'BudgetWarning', payload:{ exhausted:false, reason:bs.reason!, remaining:budget.remaining(), gracePeriodEnds:budget.gracePeriodEnd }, timestamp: Date.now() };
      }

      if (note) { messages.push({ role:'user', content: note }); note = undefined; }

      if (phase === 'TERMINATE') {
        yield { type:'StateChange', payload:{ from:'VERIFY', to:'TERMINATE', stateId: sid() }, timestamp: Date.now() };
        break;
      }

      if (phase === 'ACT') {
        yield { type:'StateChange', payload:{ from:'THINK', to:'ACT', stateId: sid() }, timestamp: Date.now() };
        for (const { toolCall, result } of (yield* this.handleAct(lastToolCalls, ctx, budget, sid))) {
          messages.push({ role:'tool', toolCallId: toolCall.id, toolName: toolCall.function.name,
                          content: JSON.stringify(result.success ? result.result : { error: result.error }) });
        }
        yield { type:'StateChange', payload:{ from:'ACT', to:'OBSERVE', stateId: sid() }, timestamp: Date.now() };
        yield { type:'StateChange', payload:{ from:'OBSERVE', to:'THINK', stateId: sid() }, timestamp: Date.now() };
        phase = 'THINK';
      } else {
        yield { type:'StateChange', payload:{ from: phase, to:'THINK', stateId: sid() }, timestamp: Date.now() };
        const r = yield* this.handleThink(messages, ctx, budget, sid);
        if (r.error) {
          yield { type:'Error', payload:{ code:'INTERNAL_ERROR', message:r.error, stateType:'THINK', recoverable:true, recoveryAction:'reflect' }, timestamp: Date.now() };
          note = `Previous step failed: ${r.error}. Reflect and retry with a different approach.`;
        } else {
          messages.push(r.assistantMessage);
          if (r.toolCalls.length > 0) { lastToolCalls = r.toolCalls; phase = 'ACT'; }
          else {
            finalOutput = r.content;
            yield { type:'StateChange', payload:{ from:'THINK', to:'VERIFY', stateId: sid() }, timestamp: Date.now() };
            const passed = ctx.verifier ? (await ctx.verifier.evaluate({ output: finalOutput, context: messages })).passed : true;
            phase = passed ? 'TERMINATE' : 'THINK';
            if (!passed) note = 'Verification failed. Refine and try again.';
          }
        }
      }

      turnCount++; budget.recordTurn();
      yield { type:'YieldControl', payload:{ turnNumber: turnCount, budget: budget.snapshot() }, timestamp: Date.now() };
      if (turnCount >= ctx.budget.maxTurns) {
        if (!finalOutput) finalOutput = messages[messages.length-1]?.content ?? '';
        yield { type:'Interrupted', payload:{ reason:'max_turns', completedSteps }, timestamp: Date.now() };
        interrupted = true; break;
      }
    }

    yield { type:'Completed', payload:{ finalOutput, isComplete:!interrupted, interrupted, turnCount, messages }, timestamp: Date.now() };
  }

  private async *handleThink(messages, ctx, budget, sid): AsyncGenerator<EngineEvent, ThinkResult, void> {
    let content = ''; const buffer = new Map<number, ToolCall>();
    for await (const chunk of ctx.llm.stream(messages, ctx.toolsDefs, ctx.signal)) {
      if (chunk.type === 'content' && chunk.content) {
        content += chunk.content;
        yield { type:'TokenDelta', payload:{ content: chunk.content, stateId: sid(), isToolCall:false }, timestamp: Date.now() };
      } else if (chunk.type === 'tool_call_delta') {
        const e = buffer.get(chunk.index) ?? { id:'', index:chunk.index, function:{ name:'', arguments:'' } };
        if (chunk.name) e.function.name += chunk.name;
        if (chunk.arguments) e.function.arguments += chunk.arguments;
        buffer.set(chunk.index, e);
        yield { type:'TokenDelta', payload:{ content:'', stateId: sid(), isToolCall:true, toolCallBuffer: JSON.stringify([...buffer.values()]) }, timestamp: Date.now() };
      } else if (chunk.type === 'tool_call') {
        buffer.set(chunk.index, { id: chunk.id, index: chunk.index, function:{ name: chunk.name, arguments: chunk.arguments } });
      }
    }
    const toolCalls = [...buffer.values()].filter(t => t.function.name);
    const assistantMessage: Message = { role:'assistant', content };
    if (toolCalls.length) assistantMessage.toolCalls = toolCalls;
    // 只记录 token，不递增 turns（主循环 bookkeeping 段统一处理 turn 计数）
    budget.recordTurnTokens(Math.ceil(content.length / 4));
    return { content, toolCalls, assistantMessage };
  }

  private async *handleAct(toolCalls, ctx, budget, sid): AsyncGenerator<EngineEvent, Array<{toolCall:ToolCall; result:ToolResult}>, void> {
    const lockMgr = ctx.lockManager ?? new FileLockManager();
    const produced: Array<{ toolCall: ToolCall; result: ToolResult }> = [];

    // 1. 分组：按受影响文件路径决定锁需求
    const groups = groupToolCallsByPath(toolCalls, ctx.tools);

    // 2. 不同路径组之间并行，同一路径的写操作串行排队
    const results = await Promise.all(
      groups.map(async group => {
        const locks = await lockMgr.acquireMany(group.lockKeys, { write: group.hasWrite });
        try {
          if (group.hasWrite) {
            const out: Array<{ toolCall: ToolCall; result: ToolResult }> = [];
            for (const tc of group.calls) {
              out.push({ toolCall: tc, result: await ctx.tools.execute(tc, ctx.signal) });
            }
            return out;
          } else {
            return await Promise.all(group.calls.map(async tc => ({ toolCall: tc, result: await ctx.tools.execute(tc, ctx.signal) })));
          }
        } finally {
          await lockMgr.releaseMany(locks);
        }
      })
    );

    produced.push(...results.flat());
    for (const r of produced) {
      budget.recordToolCall();
      yield { type:'ToolResult', payload:{ toolName: r.toolCall.function.name, result: r.result, duration: r.result.duration, toolCallId: r.toolCall.id }, timestamp: Date.now() };
    }
    return produced;
  }
}

// [SPEC] 文件级并发锁接口
export interface LockManager {
  acquire(keys: string[], opts?: { write?: boolean }): Promise<string[]>;
  acquireMany(keys: string[], opts?: { write?: boolean }): Promise<string[]>;
  releaseMany(handles: string[]): Promise<void>;
}

// [REF] 基于读写锁的简单实现
export class FileLockManager implements LockManager {
  // 路径级读写锁实现：写互斥，读可并发但阻塞写
  // 工具 Adapter 需在 metadata 中声明 affectedPaths（如 write_file 的 path）
  async acquire(keys: string[], opts?: { write?: boolean }): Promise<string[]> { /* ... */ return []; }
  async acquireMany(keys: string[], opts?: { write?: boolean }): Promise<string[]> { return this.acquire(keys, opts); }
  async releaseMany(handles: string[]): Promise<void> { /* ... */ }
}

// [REF] 按文件路径对工具调用分组，冲突路径的写操作排队
function groupToolCallsByPath(toolCalls: ToolCall[], tools: ToolAdapter): Array<{ lockKeys: string[]; hasWrite: boolean; calls: ToolCall[] }> {
  // 实现：解析每个 toolCall 的 affected path（来自 metadata 或参数），按路径 hash 分组
  return [];
}
```

> **实现提示**：`handleAct` 的并行/顺序差异只在"是否等待前一个完成"。上面的参考把两种分支都写出更清晰；
> 实际实现可简化为：写类工具顺序执行、只读工具 `Promise.all`，逐个 yield `ToolResult`。

## 4. BudgetConfig & BudgetManager（内联定义，修正版）

`FailurePolicy`、`HookRouter` 与原始草稿一致（`HookRouter` 的 `action` 类型需含 `'retry'`，
`FailurePolicy` 无变动）。

`BudgetConfig` 在此直接定义。与原始草稿的差异：
- 移除了 `maxIterations` / `maxToolCalls`（从未作为独立停止条件使用；`BudgetManager` 内部仍计数用于 metrics 检查点）。
- 清晰的硬停止条件：`maxTurns` / `maxTotalTokens` / `maxExecutionTime`。
- `inGracePeriod()` 只在硬超限后、且 `graceUsed < graceTurns` 时为真；
  `gracePeriodEnd` 仅作 UI 展示。

```typescript
// [SPEC] BudgetConfig — 必须精确实现
export interface BudgetConfig {
  maxTurns: number;           // 最大轮次 (默认 30)
  maxTotalTokens: number;     // 最大 Token (默认 200k)
  maxExecutionTime: number;   // 最大 ms (默认 600000 = 10min)
  warningThreshold: number;   // 警告触发比例 0.8
  graceTurns: number;         // 超限后额外宽限轮次 (默认 3)
}

export class BudgetManager {
  private counters = { turns: 0, tokens: 0, iterations: 0, toolCalls: 0 };
  private startTime: number;
  public gracePeriodEnd: number;
  private graceUsed = 0;

  constructor(private config: BudgetConfig, initial?: BudgetSnapshot) {
    this.startTime = initial ? Date.now() - initial.elapsed : Date.now();
    this.gracePeriodEnd = this.startTime + config.maxExecutionTime + 60000;
    if (initial) {
      this.counters = { turns: initial.turns.used, tokens: initial.tokens.used, iterations: initial.iterations.used, toolCalls: initial.toolCalls.used };
    }
  }

  check(): { warning: boolean; exhausted: boolean; reason?: string } {
    if (this.inGracePeriod()) return { warning: true, exhausted: false, reason: 'grace_period' };
    for (const [k, r] of Object.entries(this.ratios())) {
      if (r >= 1.0) return { warning: true, exhausted: true, reason: `${k}_exhausted` };
      if (r >= this.config.warningThreshold) return { warning: true, exhausted: false, reason: `${k}_warning` };
    }
    return { warning: false, exhausted: false };
  }

  inGracePeriod(): boolean {
    return this.isHardExhausted() && this.graceUsed < this.config.graceTurns;
  }

  private isHardExhausted(): boolean {
    return Object.values(this.ratios()).some(r => r >= 1.0);
  }

  recordTurn(tokens = 0): void {
    this.counters.turns++; this.counters.tokens += tokens; this.counters.iterations++;
    if (this.isHardExhausted()) this.graceUsed++;
  }

  /**
   * 仅记录 token 消耗，不递增 turns / iterations 计数器。
   * 由 handleThink 在 THINK 阶段调用（主循环的 bookkeeping 段单独记录 turns）。
   * 这修复了原版参考实现中 budget.recordTurn() 双倍计数 turns 的 bug。
   */
  recordTurnTokens(tokens: number): void {
    this.counters.tokens += tokens;
  }

  recordToolCall(): void { this.counters.toolCalls++; }

  snapshot(): BudgetSnapshot {
    return {
      turns: { used: this.counters.turns, max: this.config.maxTurns },
      tokens: { used: this.counters.tokens, max: this.config.maxTotalTokens },
      iterations: { used: this.counters.iterations, max: this.config.maxTurns * 3 }, // 安全网
      toolCalls: { used: this.counters.toolCalls, max: this.config.maxTurns * 10 },
      elapsed: Date.now() - this.startTime,
    };
  }

  remaining(): { turns: number; tokens: number; time: number } {
    return {
      turns: Math.max(0, this.config.maxTurns - this.counters.turns),
      tokens: Math.max(0, this.config.maxTotalTokens - this.counters.tokens),
      time: Math.max(0, this.config.maxExecutionTime - (Date.now() - this.startTime)),
    };
  }

  private ratios(): Record<string, number> {
    return {
      turns: this.counters.turns / this.config.maxTurns,
      tokens: this.counters.tokens / this.config.maxTotalTokens,
      time: (Date.now() - this.startTime) / this.config.maxExecutionTime,
    };
  }
}
```

## 5. StreamManager 修正（保留 stateId / isToolCall）

```typescript
// [REF] 合并连续的 TokenDelta 时，不得清空 stateId / isToolCall
private mergeTokenDeltas(events: EngineEvent[]): EngineEvent[] {
  const result: EngineEvent[] = [];
  let buf = ''; let lastStateId = ''; let lastIsTool = false; let lastBuffer?: string;
  const flush = () => { if (buf) { result.push({ type:'TokenDelta', payload:{ content:buf, stateId:lastStateId, isToolCall:lastIsTool, toolCallBuffer:lastBuffer }, timestamp:Date.now() }); buf=''; lastBuffer=undefined; } };
  for (const e of events) {
    if (e.type === 'TokenDelta') {
      buf += e.payload.content; lastStateId = e.payload.stateId; lastIsTool = e.payload.isToolCall; lastBuffer = e.payload.toolCallBuffer;
    } else { flush(); result.push(e); }
  }
  flush();
  return result;
}
```

## 6. 状态机与 Hook/Strategy 触发时机

Engine 公开 5 个状态，但核心循环只负责驱动；具体行为由状态处理器 + HookRouter + FailurePolicy 共同决定。

### 6.1 状态定义与进入/退出条件

| 状态 | 进入条件 | 主要动作 | 退出条件 |
|:-----|:---------|:---------|:---------|
| **THINK** | 会话启动；或 ACT/OBSERVE 后 | 调用 LLM，流式产出 `TokenDelta` / `tool_call` | LLM 返回文本 → VERIFY；返回 tool_calls → ACT |
| **ACT** | THINK 产生 tool_calls 后 | 通过 `handleAct` 并发/串行执行工具，按路径加锁 | 所有工具执行完毕 → OBSERVE |
| **OBSERVE** | ACT 完成后 | 汇总 tool results，更新 messages | 无条件进入 THINK |
| **VERIFY** | THINK 返回纯文本后 | 调用 `verifier.evaluate` 评估结果 | 通过 → TERMINATE；不通过 → 注入修正/反思提示 → THINK |
| **TERMINATE** | VERIFY 通过或 Budget/Abort 触发时 | 设置 `finalOutput`，yield `Completed` / `Interrupted` | 会话结束 |

### 6.2 HookRouter 触发点

| Hook 事件 | 触发时机 | 返回值语义 |
|:----------|:---------|:-----------|
| `before_think` | THINK 调用 LLM 前 | `continue` / `modify(messages)` / `abort` |
| `after_think` | THINK 返回 assistant 消息后 | `continue` / `retry` / `abort` |
| `before_act` | ACT 执行工具前 | `continue` / `abort` |
| `after_act` | ACT 所有 tool results 产出后 | `continue` / `retry` / `abort` |
| `before_verify` | VERIFY 调用 Verifier 前 | `continue` / `skip` / `abort` |
| `after_verify` | VERIFY 返回后 | `continue` / `retry` / `refine` / `abort` |
| `on_budget_warning` | BudgetManager 返回 warning 时 | `continue` / `abort` |

### 6.3 FailurePolicy（失败处理策略）

`FailurePolicy` 在以下场景介入，负责决定失败后的行为：

1. **VERIFY 失败后**：决定注入轻量修正提示（refine）还是深度反思提示（reflect）。
2. **工具执行报错后**：决定重试、切换工具还是终止。
3. **连续失败 ≥ 3 次时**：决定降级模型、简化任务还是请求用户介入。

接口（完整定义见 `pure Spec.md` §4）：

```typescript
// FailureRecord / FailureAction / FailurePolicy 见 pure Spec §4 (Canonical types)
interface FailureRecord {
  type: 'verify_failure' | 'tool_error' | 'llm_error';
  message: string;
  turnNumber: number;
  toolName?: string;
}

type FailureAction =
  | { kind: 'retry'; hint: string }     // 注入轻量修正提示，回到 THINK
  | { kind: 'reflect'; hint: string }   // 注入深度反思提示，回到 THINK
  | { kind: 'degrade'; reason: string } // 降级模型或简化任务
  | { kind: 'stop'; reason: string };   // 停止，请求用户介入

interface FailurePolicy {
  decide(failures: FailureRecord[]): FailureAction;
}
```

Engine 在失败时调用 `ctx.failurePolicy?.decide(recentFailures)`：
- `retry` / `reflect` → 将 hint 作为 `note` 注入 messages，回到 THINK
- `degrade` → 切换到备选模型或降低任务复杂度
- `stop` → yield `Interrupted` 并终止会话

## 6.4 Observability 事件边界

Engine 不保存原始 Prompt，也不直接写观测文件；它只通过既有 `EngineEvent` 向 Harness 暴露可观测事实。Harness 负责把事件映射到 run trace：

- `StateChange`、`BudgetWarning`、`FailurePolicyDecision`、`Error`、`Interrupted`、`Completed` 计入事件统计。
- `ToolResult` 记录工具名、成功状态、耗时和结果长度哈希；不得把完整工具参数或结果写入默认 trace。
- `Completed` 携带 provider usage、verification summary 和终态；`Interrupted`、不可恢复 `Error`、预算终止和 generator 异常也必须结束 trace。
- 观测是旁路能力，不能改变 Engine 的状态转移、失败策略、预算、权限或消息序列。

真实编码任务评测在 Engine 之上运行：评测器只信任隔离 workspace 中 verification command 的退出状态，不信任模型自述；control、agent error、fixture error 和 verification failure 要分别报告。

## 7. 单元测试（必须能跑通，而非 0 测试）

- 用 `MockAdapter`（脚本化：第 1 轮返回 `read_file` 工具调用，第 2 轮返回最终文本）。
- 断言：产生 `ToolResult` 事件、`messages` 在 2 轮后含 tool 消息、`Completed.finalOutput` 非空。
- 断言：`AbortSignal` 触发后产生 `Interrupted`，不产生死循环。
- 断言：同一路径的写工具按锁排队，不同路径的工具可并发执行。
