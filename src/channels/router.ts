// src/channels/router.ts
// 会话路由（设计文档 D3 / §5）：(workspace, per-channel-peer) → AgentSession。
// 默认 per-channel-peer 隔离：A 在 WhatsApp 的问话绝不进 B 在 Telegram 的上下文。
import type { ChannelCapabilities, ChannelTarget, InboundEvent, OutboundMessage } from './types';
import type { ChannelsConfig } from './config';
import { resolveBinding } from './config';
import { AgentSession, type HarnessFactory } from './agentSession';
import { ChannelApprovalBroker, createChannelApprovalHandler } from './approvals';
import type { ChannelSessionIndex } from './sessionIndex';

export interface SessionRouterDeps {
  config: ChannelsConfig;
  factory: HarnessFactory;
  capabilitiesFor: (channelId: string) => ChannelCapabilities | undefined;
  broker: ChannelApprovalBroker;
  deliver: (channelId: string, target: ChannelTarget, message: OutboundMessage) => Promise<string | undefined>;
  index: ChannelSessionIndex;
  log?: (message: string) => void;
  now?: () => number;
  /** 回合 token 用量上报（每日预算记账，按 sessionKey）。 */
  onUsage?: (sessionKey: string, usage: import('../shared/types').TokenUsage | undefined) => void;
  /** 富输出光栅化（透传给 AgentSession 的最终帧）。 */
  richOutput?: (text: string, capabilities: ChannelCapabilities) => Promise<import('./richOutput').RichRenderResult>;
  /** 通道投影（优先于 richOutput，透传给 AgentSession 的最终帧）。 */
  projection?: import('./projection/projection').AnswerProjection;
}

export function buildSessionKey(inbound: InboundEvent): string {
  const base = `${inbound.channelId}:${inbound.accountId}:${inbound.peer.kind}:${inbound.peer.id}`;
  return inbound.threadId ? `${base}:${inbound.threadId}` : base;
}

/** 群聊触发判定。适配器负责把平台 @ 语法归一化，这里是最保守的兜底。 */
export function isAddressed(text: string): boolean {
  return /(^|\s)@/.test(text) || text.trimStart().startsWith('/');
}

/** 适配器未注册（不该发生）时的最小能力集：纯文本、非流式。 */
function fallbackCapabilities(): ChannelCapabilities {
  return { chatTypes: ['dm'], media: {}, streaming: 'none', maxTextLength: 4096, markdown: 'none' };
}

export function targetFor(inbound: InboundEvent): ChannelTarget {
  return { accountId: inbound.accountId, peerId: inbound.peer.id, peerKind: inbound.peer.kind, threadId: inbound.threadId };
}

export class SessionRouter {
  private sessions = new Map<string, AgentSession>();
  private readonly now: () => number;

  constructor(private readonly deps: SessionRouterDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /** 处理一条入站事件。返回在该会话上跑的 turn promise（便于测试 await）。 */
  async handle(inbound: InboundEvent): Promise<void> {
    if (inbound.kind !== 'message') return;
    const sessionKey = buildSessionKey(inbound);

    // 审批回复优先：兼容文字双轨（y/a/n）。
    if (this.deps.broker.handleReply(sessionKey, inbound.text)) return;

    const caps = this.deps.capabilitiesFor(inbound.channelId);
    if (inbound.peer.kind === 'group') {
      const mentionRequired = this.deps.config.groupPolicy.mentionRequired && caps?.requiresMentionInGroup !== false;
      // 平台给出的 @ 事实优先（飞书 mention token 清洗后正则看不出）；否则退回文本兜底。
      if (mentionRequired && !(inbound.addressed ?? isAddressed(inbound.text))) return;
    }

    const target = targetFor(inbound);
    const session = this.sessions.get(sessionKey) ?? this.createSession(inbound, sessionKey, target);
    this.deps.index.touch(sessionKey, this.now());

    // 并发上限：超限时驱逐最久空闲的会话（不驱逐正在跑的）。
    if (this.sessions.size > this.deps.config.limits.maxConcurrentSessions) {
      await this.evictLeastIdle(sessionKey);
    }

    await session.runTurn(inbound);
    this.deps.index.touch(sessionKey, this.now());
  }

  private createSession(inbound: InboundEvent, sessionKey: string, target: ChannelTarget): AgentSession {
    const binding = resolveBinding(this.deps.config, {
      channelId: inbound.channelId,
      peerId: inbound.peer.id,
      peerKind: inbound.peer.kind,
      threadId: inbound.threadId,
    });
    const caps = this.deps.capabilitiesFor(inbound.channelId);
    const existing = this.deps.index.get(sessionKey);
    const sessionId = existing?.sessionId ?? `chan_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.deps.index.set(sessionKey, {
      sessionId,
      lastActivityAt: this.now(),
      workspace: binding.workspace,
    });

    const approvalHandler = createChannelApprovalHandler(this.deps.broker, target, sessionKey);
    const effectiveCaps = caps ?? fallbackCapabilities();
    const session = new AgentSession(
      sessionKey,
      target,
      {
        sessionKey,
        sessionId,
        workspace: binding.workspace,
        permissionMode: binding.permissionMode,
        toolProfile: binding.toolProfile,
        evolutionEnabled: binding.evolutionEnabled,
        capabilities: effectiveCaps,
        approvalHandler,
        firstUserText: '',
      },
      {
        factory: this.deps.factory,
        capabilities: effectiveCaps,
        throttleMs: this.deps.config.streaming.throttleMs,
        ackPlaceholder: this.deps.config.streaming.ackPlaceholder,
        deliver: (t, message) => this.deps.deliver(inbound.channelId, t, message),
        log: this.deps.log,
        onUsage: (usage) => this.deps.onUsage?.(sessionKey, usage),
        richOutput: this.deps.richOutput,
        projection: this.deps.projection,
      },
    );
    this.deps.log?.(`new session ${sessionKey} → workspace ${binding.workspace ?? '(none)'} [${binding.permissionMode}]`);
    this.sessions.set(sessionKey, session);
    return session;
  }

  private async evictLeastIdle(keepKey: string): Promise<void> {
    const idle = [...this.sessions.entries()]
      .filter(([key, session]) => key !== keepKey && !session.inflight)
      .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);
    if (idle.length === 0) return;
    const [key, session] = idle[0];
    this.sessions.delete(key);
    this.deps.broker.cancelSession(key);
    this.deps.log?.(`evicting idle session ${key} (LRU)`);
    await session.dispose();
  }

  /** 空闲 TTL 驱逐（默认 30 min），由 gateway 定时调用。 */
  async evictIdle(now = this.now(), ttlMs = 30 * 60_000): Promise<string[]> {
    const evicted: string[] = [];
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.inflight || now - session.lastActivityAt < ttlMs) continue;
      this.sessions.delete(key);
      this.deps.broker.cancelSession(key);
      await session.dispose();
      evicted.push(key);
    }
    return evicted;
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.dispose()));
  }
}
