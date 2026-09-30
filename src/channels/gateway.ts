// src/channels/gateway.ts
// 常驻守护进程（设计文档 D1）：挂载多个通道，持有事件总线、路由、渲染与投递。
// agent 核心仍是同一份 createHarness 装配，这里只做宿主与转发。
import type { ChannelsConfig } from './config';
import { ChannelEventBus } from './eventBus';
import { acquireGatewayLock, type GatewayLockHandle } from './lock';
import { MemoryOutbox } from './outbox';
import { ChannelRegistry } from './registry';
import { SessionRouter, buildSessionKey, targetFor } from './router';
import { pairingNotice, type PairingGate } from './pairing';
import type { ChannelAuditLog } from './audit';
import { hashId } from './audit';
import { budgetExhaustedNotice, rateLimitedNotice, type DailyTokenBudget, type PeerRateLimiter } from './limits';
import { renderRichOutput } from './richOutput';
import { createDefaultRichRenderers, type GatewayRichRenderers } from './rasterize/headlessRenderer';
import { createProjectionPage, type ProjectionPage } from './projection/browserProjection';
import { createAnswerProjection, type AnswerProjection } from './projection/projection';
import type { HarnessFactory } from './agentSession';
import { ChannelApprovalBroker } from './approvals';
import { ChannelSessionIndex } from './sessionIndex';
import type { ChannelAdapter, ChannelRuntimeContext, ChannelTarget, InboundEvent, OutboundMessage } from './types';

export interface GatewayOptions {
  config: ChannelsConfig;
  registry: ChannelRegistry;
  factory: HarnessFactory;
  lockPath: string;
  index: ChannelSessionIndex;
  /** 出站队列落盘路径；省略则纯内存（重启会丢未投递的可靠帧）。 */
  outboxPath?: string;
  /** 入口信任门（dmPolicy: pairing）。省略则不配对（dm 全部放行）。 */
  pairing?: PairingGate;
  /** 审计（默认不落原文）。 */
  audit?: ChannelAuditLog;
  /** 每 peer 速率限制（§6.5）。 */
  limiter?: PeerRateLimiter;
  /** 每日 token 预算（§6.5）。 */
  budget?: DailyTokenBudget;
  /** 富输出光栅化渲染器（默认：chart/svg 走 resvg；mermaid/puml 走 headless Chrome，无 Chrome 则降级为文本）。 */
  richRenderers?: GatewayRichRenderers;
  /**
   * 通道投影（默认：把富块用桌面端同一渲染管线截图）。传 null 关闭投影，
   * 只走 richOutput 的图表降级路径。
   */
  projection?: AnswerProjection | null;
  /** 空闲驱逐周期（默认 60s），测试可注入小值或关闭。 */
  evictionIntervalMs?: number;
  sessionTtlMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX = 5000;

export class Gateway {
  readonly bus = new ChannelEventBus();
  private readonly outbox: MemoryOutbox;
  private readonly router: SessionRouter;
  private readonly broker: ChannelApprovalBroker;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly richRenderers: GatewayRichRenderers;
  private readonly projection?: AnswerProjection;
  private readonly projectionPage?: ProjectionPage;
  private lock?: GatewayLockHandle;
  private started: ChannelAdapter[] = [];
  private seen = new Map<string, number>();
  private evictTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: GatewayOptions) {
    this.log = options.log ?? ((m) => console.log(`[channels] ${m}`));
    this.now = options.now ?? (() => Date.now());
    this.richRenderers = options.richRenderers ?? createDefaultRichRenderers({ log: this.log });
    if (options.projection === null) {
      this.projection = undefined;
    } else if (options.projection) {
      this.projection = options.projection;
    } else {
      // 投影页是懒启动的：没 Chrome 就返回 null，此时完全退回 richOutput。
      const page = createProjectionPage({ log: this.log });
      this.projectionPage = page ?? undefined;
      this.projection = page ? createAnswerProjection({ renderRichBlock: (markdown) => page.render(markdown) }) : undefined;
    }
    this.outbox = new MemoryOutbox((id) => options.registry.get(id), { log: this.log, path: options.outboxPath });
    this.broker = new ChannelApprovalBroker(
      async (target, message) => {
        await this.deliverEnvelope('', target, message, true);
      },
      {
        log: this.log,
        onDecision: (target, info, decision) => {
          this.options.audit?.record({
            channelId: this.options.registry.list().find((a) => a.listAccountIds().includes(target.accountId))?.id ?? 'unknown',
            peerId: target.peerId,
            decision: decision.allowed ? 'approved' : 'denied',
            tool: info.tool,
            argsHash: hashId(info.command ?? info.path ?? ''),
          });
        },
      },
    );
    this.router = new SessionRouter({
      config: options.config,
      factory: options.factory,
      capabilitiesFor: (id) => options.registry.get(id)?.capabilities,
      broker: this.broker,
      deliver: (channelId, target, message) => this.deliverEnvelope(channelId, target, message),
      index: options.index,
      log: this.log,
      now: this.now,
      onUsage: (sessionKey, usage) => this.options.budget?.record(sessionKey, usage),
      richOutput: (text, capabilities) => renderRichOutput(text, capabilities, this.richRenderers),
      projection: this.projection,
    });
  }

  get sessionCount(): number {
    return this.router.sessionCount;
  }

  async start(): Promise<void> {
    // 先抢锁再绑端口：两个实例同时起时，第二个必须在产生任何平台连接前退出。
    this.lock = acquireGatewayLock(this.options.lockPath, { channels: this.enabledAdapters().map((a) => a.id) });
    this.bus.onInbound((event) => {
      void this.routeInbound(event).catch((err) => {
        this.log(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    for (const adapter of this.enabledAdapters()) {
      const accountId = this.firstAccountId(adapter.id);
      const ctx: ChannelRuntimeContext = {
        accountId,
        onInbound: (event) => this.acceptInbound(event),
        log: (m) => this.log(`[${adapter.id}] ${m}`),
      };
      try {
        await adapter.start(ctx);
        this.started.push(adapter);
      } catch (err) {
        // 单个通道起不来不影响其它通道（Adapter Layer 原则第五条）。
        this.log(`adapter ${adapter.id} failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const interval = this.options.evictionIntervalMs ?? 60_000;
    if (interval > 0) {
      this.evictTimer = setInterval(() => {
        void this.router.evictIdle(this.now(), this.options.sessionTtlMs ?? 30 * 60_000);
      }, interval);
      if (typeof this.evictTimer.unref === 'function') this.evictTimer.unref();
    }
    this.log(`gateway started: ${this.started.map((a) => a.id).join(', ') || '(no channels)'}`);
    // 适配器就绪后重放上次进程遗留的可靠帧（审批/最终结果）。
    if (this.outbox.pendingCount > 0) void this.outbox.drain();
  }

  async stop(): Promise<void> {
    if (this.evictTimer) clearInterval(this.evictTimer);
    this.evictTimer = undefined;
    await Promise.all(this.started.map((a) => a.stop().catch((err) => this.log(`adapter ${a.id} stop failed: ${String(err)}`))));
    this.started = [];
    await this.router.stopAll();
    await this.outbox.drain();
    // headless Chrome / 投影页都是懒启动的：没渲过图时这里是空操作。
    this.richRenderers.dispose?.();
    this.projectionPage?.dispose();
    this.lock?.release();
    this.lock = undefined;
  }

  /** 入口层：配对 → 限流 → 预算 → 路由；每一步都过审计。 */
  private async routeInbound(event: InboundEvent): Promise<void> {
    const key = buildSessionKey(event);
    const audit = this.options.audit;

    const pairing = this.options.pairing;
    if (pairing && event.peer.kind === 'dm') {
      const policy = this.options.config.channels[event.channelId]?.dmPolicy ?? 'pairing';
      const check = pairing.check(event.channelId, event.peer.id, policy, event.peer.name);
      if (!check.allowed) {
        if (check.isNew && check.code) {
          await this.deliverEnvelope(event.channelId, targetFor(event), { kind: 'notice', text: pairingNotice(check.code), final: true });
        }
        audit?.record({ channelId: event.channelId, peerId: event.peer.id, sessionKey: key, decision: 'unpaired' });
        this.log(`unpaired dm from ${event.channelId}:${event.peer.id} — not routed to the agent`);
        return;
      }
    }

    const rate = this.options.limiter?.check(key);
    if (rate && !rate.allowed) {
      audit?.record({ channelId: event.channelId, peerId: event.peer.id, sessionKey: key, decision: 'rate-limited' });
      await this.deliverEnvelope(event.channelId, targetFor(event), { kind: 'notice', text: rateLimitedNotice(rate.retryAfterMs), final: true });
      return;
    }

    if (this.options.budget && !this.options.budget.canSpend(key)) {
      audit?.record({ channelId: event.channelId, peerId: event.peer.id, sessionKey: key, decision: 'budget-exceeded' });
      await this.deliverEnvelope(event.channelId, targetFor(event), { kind: 'notice', text: budgetExhaustedNotice(), final: true });
      return;
    }

    audit?.record({ channelId: event.channelId, peerId: event.peer.id, sessionKey: key, decision: 'routed', textLength: event.text.length, text: event.text });
    await this.router.handle(event);
  }

  private enabledAdapters(): ChannelAdapter[] {
    const entries = Object.entries(this.options.config.channels);
    // 无 channels 配置时启动所有已注册适配器（P0 引导路径）。
    if (entries.length === 0) return this.options.registry.list();
    const enabledIds = new Set(entries.filter(([, cfg]) => cfg.enabled !== false).map(([id]) => id));
    return this.options.registry.list().filter((a) => enabledIds.has(a.id));
  }

  private firstAccountId(channelId: string): string {
    const accounts = this.options.config.channels[channelId]?.accounts;
    const first = accounts ? Object.keys(accounts)[0] : undefined;
    return first ?? 'default';
  }

  /** 入站去重：平台重推（飞书超时会重推）不得重复进 agent。 */
  private acceptInbound(event: InboundEvent): void {
    const key = `${event.channelId}:${event.messageId}`;
    const now = this.now();
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < DEDUPE_TTL_MS) {
      this.log(`deduped inbound ${key}`);
      return;
    }
    this.seen.set(key, now);
    if (this.seen.size > DEDUPE_MAX) {
      for (const [k, ts] of this.seen) {
        if (now - ts >= DEDUPE_TTL_MS || this.seen.size > DEDUPE_MAX) this.seen.delete(k);
        if (this.seen.size <= DEDUPE_MAX) break;
      }
    }
    this.bus.emitInbound(event);
  }

  /**
   * 投递一帧。progress 是可丢的（直接发，失败就算了）；其余走可重试路径。
   * 返回平台消息 id，供上层做流式编辑。
   */
  private async deliverEnvelope(channelId: string, target: ChannelTarget, message: OutboundMessage, noRetryQueue = false): Promise<string | undefined> {
    const adapter = channelId
      ? this.options.registry.get(channelId)
      : [...this.options.registry.list()].find((a) => a.listAccountIds().includes(target.accountId)) ?? this.options.registry.list()[0];
    if (!adapter) {
      this.log('no adapter available for outbound message');
      return undefined;
    }
    this.bus.emitOutbound({ channelId: adapter.id, target, message });

    const opts = message.messageId ? { edit: true } : undefined;
    if (message.kind === 'progress') {
      try {
        const result = await adapter.send(target, message, opts);
        return result.messageId;
      } catch (err) {
        this.log(`progress frame dropped: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }
    try {
      if (message.messageId && adapter.editMessage) {
        await adapter.editMessage(target, message.messageId, message);
        return message.messageId;
      }
      const result = await adapter.send(target, message, opts);
      return result.messageId;
    } catch (err) {
      if (noRetryQueue) throw err;
      this.log(`reliable frame failed, queued for retry: ${err instanceof Error ? err.message : String(err)}`);
      this.outbox.enqueue(adapter.id, target, message);
      void this.outbox.drain();
      return undefined;
    }
  }
}
