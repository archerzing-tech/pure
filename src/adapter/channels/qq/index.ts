// src/adapter/channels/qq/index.ts
// QQ 适配器（设计文档 cn-im-channels.md 的通道族新增成员）。能力声明按降级矩阵
// 诚实表达：无卡片流式（streaming 'none'——只发最终结果）、无 markdown（v2
// 被动回复用纯文本 msg_type 0，markdown 需平台模板报备）、群聊天然仅 @ 触达
// （GROUP_AT_MESSAGE_CREATE 才会推送）。审批按钮降级为文字双轨（教用户回短
// 指令，词表与钉钉降级话术同一套）。
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntimeContext,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '../../../channels/types';
import { chunkText } from '../../../channels/chunk';
import type { QQAdapterOptions, QQTransport } from './types';
import { approvalHint, toInboundEvent } from './normalize';

export function qqCapabilities(canSendImages = false): ChannelCapabilities {
  return {
    chatTypes: ['dm', 'group'],
    media: { images: true, audio: false, video: false, files: false },
    streaming: 'none',
    // 纯文本回复（msg_type 0）的内容上限：保守 2000，超长由 chunkText 分帧。
    maxTextLength: 2000,
    markdown: 'none',
    canDeliverImages: canSendImages,
    threads: false,
    reactions: false,
    typing: false,
    editMessages: false,
    buttons: true,
    requiresMentionInGroup: true,
  };
}

export function createQQAdapter(deps: QQAdapterOptions): ChannelAdapter {
  const accountId = deps.accountId ?? 'default';
  const transport: QQTransport = deps.transport;
  const capabilities = qqCapabilities(typeof transport.sendImage === 'function');

  async function sendChunked(conversationId: string, text: string): Promise<string> {
    const chunks = chunkText(text, capabilities.maxTextLength);
    let last = '';
    for (const chunk of chunks) last = await transport.sendText(conversationId, chunk);
    return last;
  }

  async function deliverAttachments(conversationId: string, msg: OutboundMessage): Promise<string | undefined> {
    if (!msg.attachments?.length || !transport.sendImage) return undefined;
    let last: string | undefined;
    for (const attachment of msg.attachments) {
      last = await transport.sendImage(conversationId, attachment.data, attachment.name);
    }
    return last;
  }

  return {
    id: 'qq',
    capabilities,

    async start(context: ChannelRuntimeContext): Promise<void> {
      await transport.start({
        onMessage: (raw) => context.onInbound(toInboundEvent(raw, accountId)),
        log: context.log,
      });
      context.log(`qq websocket connected (images ${capabilities.canDeliverImages ? 'on' : 'text-only'})`);
    },

    async stop(): Promise<void> {
      await transport.stop();
    },

    async send(target: ChannelTarget, msg: OutboundMessage): Promise<SendResult> {
      // 只有附件的帧（通道投影富块单独发图）不该再发一条空消息。
      const hasText = msg.text.trim() !== '';
      let result: SendResult = { messageId: '' };
      if (hasText) {
        const text = msg.kind === 'approval' ? `${msg.text}${approvalHint(msg.buttons)}` : msg.text;
        result = { messageId: await sendChunked(target.peerId, text) };
      }
      const attachmentId = await deliverAttachments(target.peerId, msg);
      return hasText ? result : { messageId: attachmentId ?? '' };
    },

    listAccountIds(): string[] {
      return [accountId];
    },
  };
}
