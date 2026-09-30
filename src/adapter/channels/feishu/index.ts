// src/adapter/channels/feishu/index.ts
// 飞书适配器（设计文档 cn-im-channels.md §2）。能力声明按 §2.3：卡片流式、
// markdown 仅卡片内、无 typing、群聊需 @。适配器只做「平台协议 ↔ 规范类型」，
// 渲染/分片策略来自 host，这里仅做文本消息的分片安全网。
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntimeContext,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '../../../channels/types';
import type { FeishuAdapterOptions, FeishuTransport } from './types';
import {
  actionToInboundEvent,
  approvalDecisionFromAction,
  buildApprovalCard,
  buildMarkdownCard,
  chunkText,
  toInboundEvent,
} from './normalize';

/** 能力声明（cn-im-channels.md §2.3）。 */
export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  chatTypes: ['dm', 'group'],
  media: { images: true, audio: true, video: true, files: true },
  streaming: 'card',
  maxTextLength: 4000,
  markdown: 'full',
  threads: false,
  reactions: false,
  typing: false,
  editMessages: true,
  buttons: true,
  requiresMentionInGroup: true,
};

export interface FeishuAdapterDeps extends FeishuAdapterOptions {
  transport: FeishuTransport;
}

export function createFeishuAdapter(deps: FeishuAdapterDeps): ChannelAdapter {
  const accountId = deps.accountId ?? 'default';
  const transport = deps.transport;
  // 出站图片能力由 transport 决定：实现了 sendImage 才宣称能投递附件，
  // 否则富输出降级为文本（不生成后静默丢弃）。
  const capabilities: ChannelCapabilities = { ...FEISHU_CAPABILITIES, canDeliverImages: typeof transport.sendImage === 'function' };

  async function sendChunked(chatId: string, text: string): Promise<string> {
    const chunks = chunkText(text, capabilities.maxTextLength);
    let last = '';
    for (const chunk of chunks) last = await transport.sendText(chatId, chunk);
    return last;
  }

  /** 投附件，返回最后一条图片消息的 id（投影只发图不发文本时用它当 messageId）。 */
  async function deliverAttachments(chatId: string, msg: OutboundMessage): Promise<string | undefined> {
    if (!msg.attachments?.length || !transport.sendImage) return undefined;
    let last: string | undefined;
    for (const attachment of msg.attachments) {
      last = await transport.sendImage(chatId, attachment.data, attachment.name);
    }
    return last;
  }

  return {
    id: 'feishu',
    capabilities,

    async start(context: ChannelRuntimeContext): Promise<void> {
      await transport.start({
        onMessage: (raw) => context.onInbound(toInboundEvent(raw, accountId)),
        onCardAction: (action) => {
          const decision = approvalDecisionFromAction(action.actionValue);
          if (!decision) {
            context.log(`ignoring card action without a known decision (${JSON.stringify(action.actionValue)})`);
            return;
          }
          context.onInbound(actionToInboundEvent(action, decision, accountId));
        },
        log: context.log,
      });
      context.log('feishu long connection established');
    },

    async stop(): Promise<void> {
      await transport.stop();
    },

    async send(target: ChannelTarget, msg: OutboundMessage): Promise<SendResult> {
      // 只有附件的帧（通道投影里富块单独发的图）不该再发一张空卡片。
      const hasText = msg.text.trim() !== '';
      let result: SendResult = { messageId: '' };
      if (hasText) {
        if (msg.kind === 'approval') {
          result = { messageId: await transport.sendCard(target.peerId, buildApprovalCard(msg.text, msg.approvalId ?? 'ap')) };
        } else if (msg.kind === 'progress' || msg.kind === 'final') {
          // 进度/最终答案走卡片：飞书纯文本不渲染 markdown，且卡片可整块替换（流式）。
          result = { messageId: await transport.sendCard(target.peerId, buildMarkdownCard(msg.text)) };
        } else {
          result = { messageId: await sendChunked(target.peerId, msg.text) };
        }
      }
      const attachmentId = await deliverAttachments(target.peerId, msg);
      return hasText ? result : { messageId: attachmentId ?? '' };
    },

    async editMessage(target: ChannelTarget, messageId: string, msg: OutboundMessage): Promise<void> {
      await transport.patchCard(messageId, buildMarkdownCard(msg.text));
      await deliverAttachments(target.peerId, msg);
    },

    listAccountIds(): string[] {
      return [accountId];
    },
  };
}
