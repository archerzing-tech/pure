// src/channels/eventBus.ts
// gateway 内部唯一的跨组件通信通道（设计文档 D5）：入站、出站、审批、状态
// 全部走这一条总线，Phase 3 的 WS 控制平面只是「再加一个订阅者」而非重构。
import type { InboundEvent, OutboundMessage, ChannelTarget } from './types';

export interface OutboundEnvelope {
  channelId: string;
  target: ChannelTarget;
  message: OutboundMessage;
}

export type InboundListener = (event: InboundEvent) => void;
export type OutboundListener = (envelope: OutboundEnvelope) => void;

/** 极简同步 pub/sub。订阅回调抛错只 warn，不打断其它订阅者。 */
export class ChannelEventBus {
  private inboundListeners = new Set<InboundListener>();
  private outboundListeners = new Set<OutboundListener>();

  onInbound(listener: InboundListener): () => void {
    this.inboundListeners.add(listener);
    return () => this.inboundListeners.delete(listener);
  }

  onOutbound(listener: OutboundListener): () => void {
    this.outboundListeners.add(listener);
    return () => this.outboundListeners.delete(listener);
  }

  emitInbound(event: InboundEvent): void {
    for (const listener of this.inboundListeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn(`[channels] inbound listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  emitOutbound(envelope: OutboundEnvelope): void {
    for (const listener of this.outboundListeners) {
      try {
        listener(envelope);
      } catch (err) {
        console.warn(`[channels] outbound listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listenerCount(): { inbound: number; outbound: number } {
    return { inbound: this.inboundListeners.size, outbound: this.outboundListeners.size };
  }
}
