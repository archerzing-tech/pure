// src/channels/agentSession.ts
// 一个 AgentSession = 一个 Harness 生命周期（设计文档 §5.2）。
// 同一会话的入站事件串行入队（一个 in-flight turn）；首轮 run()，续轮
// continueTurn()；空闲 TTL 由 router 负责驱逐并落 checkpoint。
import type { EngineEvent, Message, TokenUsage } from '../shared/types';
import type { PermissionMode, PermissionRequestHandler } from '../coding-agent/types';
import type {
  ChannelCapabilities,
  ChannelTarget,
  ChannelToolProfile,
  InboundEvent,
  OutboundMessage,
} from './types';
import { TurnRenderer } from './renderer';
import type { RichRenderResult } from './richOutput';
import type { ProjectionResult } from './projection/projection';

/** Harness 的结构化子集 —— 让 gateway 的工厂可以注入测试替身。 */
export interface ChannelHarness {
  run(systemPrompt: string, userPrompt: string, signal?: AbortSignal): AsyncGenerator<EngineEvent, void, void>;
  continueTurn(systemPrompt: string, messages: Message[], newUserPrompt: string, signal?: AbortSignal): AsyncGenerator<EngineEvent, void, void>;
  settleReflections?(): Promise<void>;
}

export interface HarnessBundle {
  harness: ChannelHarness;
  /** 会话系统提示词，创建时组装一次并冻结。 */
  systemPrompt: string;
  sessionId: string;
  projectPath: string;
  dispose?(): Promise<void>;
}

export interface BuildSessionSpec {
  sessionKey: string;
  /** 已存在的会话 id（恢复）或空串（新会话）。 */
  sessionId: string;
  workspace: string | null;
  permissionMode: PermissionMode;
  toolProfile: ChannelToolProfile;
  evolutionEnabled: boolean;
  capabilities: ChannelCapabilities;
  approvalHandler: PermissionRequestHandler;
  firstUserText: string;
}

export type HarnessFactory = (spec: BuildSessionSpec) => Promise<HarnessBundle>;

export interface AgentSessionDeps {
  factory: HarnessFactory;
  /** 投递一帧；返回平台消息 id（用于后续流式编辑）。 */
  deliver: (target: ChannelTarget, message: OutboundMessage) => Promise<string | undefined>;
  capabilities: ChannelCapabilities;
  throttleMs?: number;
  ackPlaceholder?: boolean;
  log?: (message: string) => void;
  /** 回合 token 用量（每日预算记账）。 */
  onUsage?: (usage: TokenUsage | undefined) => void;
  /** 富输出光栅化：最终帧的 ```chart/```svg 等块转 PNG 附件。 */
  richOutput?: (text: string, capabilities: ChannelCapabilities) => Promise<RichRenderResult>;
  /**
   * 通道投影（优先于 richOutput）：把最终回答拆成「原生文本 + 桌面端同款富块截图」
   * 的一串消息。返回 null 表示这次不该投影（无富块 / 发不了图 / 渲染页不可用）。
   */
  projection?: (text: string, capabilities: ChannelCapabilities) => Promise<ProjectionResult | null>;
}

export class AgentSession {
  private bundle?: HarnessBundle;
  private messages: Message[] = [];
  private hasRun = false;
  private queue: Promise<void> = Promise.resolve();
  private busy = false;
  private streamMessageId?: string;
  private disposed = false;
  lastActivityAt: number;

  constructor(
    readonly sessionKey: string,
    readonly target: ChannelTarget,
    private readonly spec: BuildSessionSpec,
    private readonly deps: AgentSessionDeps,
  ) {
    this.lastActivityAt = Date.now();
  }

  get started(): boolean {
    return this.bundle !== undefined;
  }

  get inflight(): boolean {
    return this.busy;
  }

  get sessionId(): string | undefined {
    return this.bundle?.sessionId;
  }

  /** 同一会话串行：上一个 turn 结束后才开始下一个。 */
  runTurn(inbound: InboundEvent): Promise<void> {
    const task = this.queue.then(() => this.execute(inbound));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async execute(inbound: InboundEvent): Promise<void> {
    this.busy = true;
    this.lastActivityAt = Date.now();
    this.streamMessageId = undefined;
    try {
      const bundle = await this.ensureBundle();
      let delivery = Promise.resolve();
      const enqueueFrame = (message: OutboundMessage) => {
        delivery = delivery.then(() => this.deliverFrame(message)).catch(() => undefined);
      };
      const renderer = new TurnRenderer({
        capabilities: this.deps.capabilities,
        emit: enqueueFrame,
        throttleMs: this.deps.throttleMs,
        ackPlaceholder: this.deps.ackPlaceholder,
      });
      renderer.acknowledge();

      const stream = this.hasRun
        ? bundle.harness.continueTurn(bundle.systemPrompt, this.messages, inbound.text)
        : bundle.harness.run(bundle.systemPrompt, inbound.text);
      this.hasRun = true;

      for await (const event of stream) {
        renderer.push(event);
        if (event.type === 'Completed') {
          if (event.payload.messages) this.messages = event.payload.messages;
          this.deps.onUsage?.(event.payload.usage);
        }
      }
      await delivery;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`session ${this.sessionKey} turn failed: ${message}`);
      await this.deps.deliver(this.target, { kind: 'error', text: `出错了：${message}`, final: true }).catch(() => undefined);
    } finally {
      this.busy = false;
      this.lastActivityAt = Date.now();
    }
  }

  private async ensureBundle(): Promise<HarnessBundle> {
    if (this.bundle) return this.bundle;
    this.bundle = await this.deps.factory(this.spec);
    return this.bundle;
  }

  private async deliverFrame(message: OutboundMessage): Promise<void> {
    if (message.kind === 'final' && this.deps.projection) {
      const projected = await this.deps.projection(message.text, this.deps.capabilities).catch(() => null);
      if (projected && projected.messages.length > 0) {
        // 投影把一条回答拆成了「文本帧 + 图片帧」；按原顺序逐条投递。
        await this.deliverProjected(projected.messages);
        return;
      }
    }
    const out: OutboundMessage = { ...message };
    if (out.kind === 'final' && this.deps.richOutput) {
      try {
        const rich = await this.deps.richOutput(out.text, this.deps.capabilities);
        if (rich.attachments.length > 0) out.attachments = [...(out.attachments ?? []), ...rich.attachments];
        if (rich.notes.length > 0) out.text = `${out.text}\n\n${rich.notes.join('\n')}`;
      } catch {
        // 附件生成失败不能影响回复本身。
      }
    }
    // 最终帧是流式气泡的收尾帧（OutboundMessage.final 语义），必须写回同一条消息；
    // 否则「流式卡片已经显示了完整回答」+「最终帧又新发一条」= 同一段回答发两遍。
    if ((out.kind === 'progress' || out.kind === 'final') && this.streamMessageId) out.messageId = this.streamMessageId;
    const id = await this.deps.deliver(this.target, out);
    if (id && !this.streamMessageId) this.streamMessageId = id;
    if (out.messageId && !this.streamMessageId) this.streamMessageId = out.messageId;
  }

  /**
   * 投递投影拆出的消息串。第一条带正文的消息接管流式气泡：流式阶段已经把原文
   * 显示在那条消息上，收尾时让它变成投影的第一段正文，而不是再新发一条重复文本。
   */
  private async deliverProjected(messages: OutboundMessage[]): Promise<void> {
    let claimedStream = false;
    for (const message of messages) {
      const out = { ...message };
      if (!claimedStream && this.streamMessageId && out.text.trim() !== '') {
        out.messageId = this.streamMessageId;
        claimedStream = true;
      }
      const id = await this.deps.deliver(this.target, out);
      if (id && !this.streamMessageId) this.streamMessageId = id;
    }
  }

  /** 空闲驱逐：落 checkpoint、排空反思、释放 Harness。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.bundle?.harness.settleReflections?.();
      await this.bundle?.dispose?.();
    } catch (err) {
      this.deps.log?.(`session ${this.sessionKey} dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
