// src/adapter/channels/dingtalk/index.ts
// 钉钉适配器（设计文档 cn-im-channels.md §4）。能力声明按 §4.3：卡片流式、markdown、
// 无 typing、群聊默认仅 @ 回复。接入成本最低（内置公共 AI 卡片模板，无需先建模板）。
//
// 如果 transport 不支持卡片实例更新，能力里的 streaming 自动降为 'none'：不推进度帧，
// 只把最终结果发一条 —— 这是降级矩阵在适配器层的诚实表达，而不是假装能流式。
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntimeContext,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '../../../channels/types';
import { chunkText } from '../../../channels/chunk';
import type { DingTalkAdapterOptions, DingTalkTransport } from './types';
import { actionToInboundEvent, buildDingTalkCard, parseDingTalkAction, toInboundEvent } from './normalize';

export function dingtalkCapabilities(canStreamCards: boolean, canDeliverImages = false): ChannelCapabilities {
  return {
    chatTypes: ['dm', 'group'],
    media: { images: true, audio: true, video: true, files: true },
    streaming: canStreamCards ? 'card' : 'none',
    maxTextLength: 4000,
    markdown: 'full',
    canDeliverImages,
    threads: false,
    reactions: false,
    typing: false,
    editMessages: canStreamCards,
    buttons: true,
    requiresMentionInGroup: true,
  };
}

export const DINGTALK_APPROVAL_BUTTONS = [
  { id: 'allow', label: '批准' },
  { id: 'always', label: '本次会话总是允许' },
  { id: 'deny', label: '拒绝' },
];

export interface DingTalkAdapterDeps extends DingTalkAdapterOptions {
  transport: DingTalkTransport;
}

export function createDingTalkAdapter(deps: DingTalkAdapterDeps): ChannelAdapter {
  const accountId = deps.accountId ?? 'default';
  const transport = deps.transport;
  // 出站图片能力由 transport 决定（实现 sendImage 才宣称能投递附件）。
  const capabilities = dingtalkCapabilities(transport.canStreamCards, typeof transport.sendImage === 'function');

  async function sendChunked(conversationId: string, text: string): Promise<string> {
    const chunks = chunkText(text, capabilities.maxTextLength);
    let last = '';
    for (const chunk of chunks) last = await transport.sendMarkdown(conversationId, chunk);
    return last;
  }

  /** 投附件，返回最后一条图片消息的 id（投影只发图不发文本时用它当 messageId）。 */
  async function deliverAttachments(conversationId: string, msg: OutboundMessage): Promise<string | undefined> {
    if (!msg.attachments?.length || !transport.sendImage) return undefined;
    let last: string | undefined;
    for (const attachment of msg.attachments) {
      last = await transport.sendImage(conversationId, attachment.data, attachment.name);
    }
    return last;
  }

  return {
    id: 'dingtalk',
    capabilities,

    async start(context: ChannelRuntimeContext): Promise<void> {
      await transport.start({
        onMessage: (raw) => context.onInbound(toInboundEvent(raw, accountId)),
        onCardAction: (action) => {
          const decision = parseDingTalkAction(action.action);
          if (!decision) {
            context.log(`ignoring dingtalk card action "${action.action}" (no known decision)`);
            return;
          }
          context.onInbound(actionToInboundEvent(action, decision, accountId));
        },
        log: context.log,
      });
      context.log(`dingtalk stream connected (cards ${transport.canStreamCards ? 'on' : 'off'})`);
    },

    async stop(): Promise<void> {
      await transport.stop();
    },

    async send(target: ChannelTarget, msg: OutboundMessage): Promise<SendResult> {
      // 只有附件的帧（通道投影里富块单独发的图）不该再发一条空消息。
      const hasText = msg.text.trim() !== '';
      let result: SendResult = { messageId: '' };
      if (hasText) {
        if (msg.kind === 'approval') {
          const card = buildDingTalkCard(msg.text, msg.approvalId ?? 'ap', DINGTALK_APPROVAL_BUTTONS);
          result = { messageId: await transport.sendCard(target.peerId, card) };
        } else if (msg.kind === 'progress' || msg.kind === 'final') {
          result = transport.canStreamCards
            ? { messageId: await transport.sendCard(target.peerId, buildDingTalkCard(msg.text, `stream_${Date.now()}`)) }
            : { messageId: await sendChunked(target.peerId, msg.text) };
        } else {
          result = { messageId: await sendChunked(target.peerId, msg.text) };
        }
      }
      const attachmentId = await deliverAttachments(target.peerId, msg);
      return hasText ? result : { messageId: attachmentId ?? '' };
    },

    async editMessage(target: ChannelTarget, messageId: string, msg: OutboundMessage): Promise<void> {
      await transport.updateCard(messageId, buildDingTalkCard(msg.text, messageId));
      await deliverAttachments(target.peerId, msg);
    },

    listAccountIds(): string[] {
      return [accountId];
    },
  };
}
