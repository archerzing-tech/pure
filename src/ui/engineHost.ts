// src/ui/engineHost.ts
// P2-a（engine-worker-migration 落地计划）— 引擎驱动面的宿主抽象。
//
// 这里只抽「谁驱动回合」：run / continueTurn / 子代理执行 / ContextEngine 取用。
// 工具注册、可见性、MCP 发现、命令守卫、交付核验**不进这个接口**——它们今天
// 就住在主线程（chat.ts 直接持有 codingAgent.toolRegistry），搬进 Worker 之前
// 先把驱动面收口，P2-c 只需换一个实现（MainThreadEngineHost → WorkerEngineHost），
// 消费侧（那个 ~1250 行的 for await switch）不动。
//
// 零行为约束：MainThreadEngineHost 只做转发，不包装、不缓存、不改参数顺序；
// 返回的 AsyncGenerator 必须是同一个对象（测试会钉住）。

import type { ContextEngine } from '../harness/ContextEngine';
import type { CodingAgent } from '../coding-agent/CodingAgent';
import type {
  EngineEvent,
  LLMAdapter,
  Message,
  MessageImage,
  ToolCall,
  ToolResult,
} from '../shared/types';

export interface EngineHost {
  run(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    hardStopSignal?: AbortSignal,
  ): AsyncGenerator<EngineEvent, void, void>;

  continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    hardStopSignal?: AbortSignal,
    userInternal?: boolean,
    llmOverride?: LLMAdapter,
  ): AsyncGenerator<EngineEvent, void, void>;

  /** 宿主的「课后优化建议」入口：委派一支角色跑一次性审查。 */
  executeSubagent(toolCall: ToolCall, parentSignal?: AbortSignal): Promise<ToolResult>;

  /** 后台预压缩与恢复路径共用的上下文引擎；Harness 没配时返回 undefined。 */
  getContextEngine(): ContextEngine | undefined;
}

/** 现役实现：引擎与 UI 同在主线程（P2-a 之前的行为，逐字节保留）。 */
export class MainThreadEngineHost implements EngineHost {
  private readonly agent: CodingAgent;

  constructor(agent: CodingAgent) {
    this.agent = agent;
  }

  run(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    hardStopSignal?: AbortSignal,
  ): AsyncGenerator<EngineEvent, void, void> {
    return this.agent.run(systemPrompt, userPrompt, signal, images, hardStopSignal);
  }

  continueTurn(
    systemPrompt: string,
    messages: Message[],
    newUserPrompt: string,
    signal?: AbortSignal,
    images?: MessageImage[],
    hardStopSignal?: AbortSignal,
    userInternal?: boolean,
    llmOverride?: LLMAdapter,
  ): AsyncGenerator<EngineEvent, void, void> {
    return this.agent.continueTurn(
      systemPrompt,
      messages,
      newUserPrompt,
      signal,
      images,
      hardStopSignal,
      userInternal,
      llmOverride,
    );
  }

  executeSubagent(toolCall: ToolCall, parentSignal?: AbortSignal): Promise<ToolResult> {
    return this.agent.subagentOrchestrator.execute(toolCall, parentSignal);
  }

  getContextEngine(): ContextEngine | undefined {
    return this.agent.getHarness().getContextEngine();
  }
}
