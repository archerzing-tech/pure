// src/channels/renderer.ts
// EngineEvent → OutboundMessage 的能力驱动降级（设计文档 §7）。
// 所有通道共享这一份渲染器；差异只在 capabilities 声明里。
//
// 两条硬约束：
// 1) 流式帧在规范层是「累积快照的全量替换」，不是 delta —— 适配器只负责把
//    快照写到平台，累积与节流由这里统一处理；
// 2) 进度帧可丢（按节流只会发最新快照），最终结果 / 错误不可丢（由 outbox 投递）。
import type { ChannelCapabilities, OutboundMessage } from './types';
import type { EngineEvent } from '../shared/types';

export interface TurnRendererOptions {
  capabilities: ChannelCapabilities;
  emit: (message: OutboundMessage) => void;
  throttleMs?: number;
  /** 注入时钟（测试用）。 */
  now?: () => number;
  /** 收到入站后立刻发占位（国内三家 3–5 秒首响时限的 ack 策略）。 */
  ackPlaceholder?: boolean;
  placeholderText?: string;
}

export class TurnRenderer {
  private answerText = '';
  private toolLine = '';
  private lastEmitAt = 0;
  private started = false;
  private emittedAnyProgress = false;
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TurnRendererOptions) {
    this.throttleMs = options.throttleMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 查询到的快照文本（供测试与审批卡片复用）。 */
  get snapshot(): string {
    return this.answerText;
  }

  /** 入站 ack：在关键路径之外先给用户一个可见的气泡。 */
  acknowledge(): void {
    if (this.started) return;
    this.started = true;
    if (!this.options.ackPlaceholder || this.options.capabilities.streaming === 'none') return;
    this.options.emit({
      kind: 'progress',
      text: this.options.placeholderText ?? '正在处理…',
      final: false,
    });
  }

  push(event: EngineEvent): void {
    if (!this.started) this.started = true;
    switch (event.type) {
      case 'TokenDelta': {
        if (event.payload.isToolCall) return;
        if (!event.payload.content) return;
        this.answerText += event.payload.content;
        this.maybeEmitProgress(false);
        return;
      }
      case 'ToolStarted': {
        this.toolLine = `正在调用 ${event.payload.toolName}…`;
        this.maybeEmitProgress(false);
        return;
      }
      case 'ToolResult': {
        this.toolLine = '';
        return;
      }
      case 'Completed': {
        const finalText = (event.payload.finalOutput ?? '').trim() || this.answerText.trim() || '（无输出）';
        this.options.emit({ kind: 'final', text: finalText, final: true });
        return;
      }
      case 'Interrupted': {
        const text = this.answerText.trim();
        this.options.emit({ kind: 'final', text: (text ? `${text}\n\n` : '') + `（已中断：${event.payload.reason}）`, final: true });
        return;
      }
      case 'Error': {
        this.options.emit({ kind: 'error', text: `出错了：${event.payload.message}`, final: true });
        return;
      }
      default:
        return;
    }
  }

  private maybeEmitProgress(force: boolean): void {
    if (this.options.capabilities.streaming === 'none') return;
    const now = this.now();
    if (!force && this.emittedAnyProgress && now - this.lastEmitAt < this.throttleMs) return;
    const text = this.answerText.trim() || this.toolLine || this.options.placeholderText || '正在处理…';
    this.lastEmitAt = now;
    this.emittedAnyProgress = true;
    this.options.emit({ kind: 'progress', text, final: false });
  }
}
