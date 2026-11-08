// src/adapter/channels/telegram/index.ts
// Telegram 适配器（通道族新成员）。能力声明按降级矩阵诚实表达：纯 REST 长
// 轮询接入（无需公网 IP 与 TLS 回调，与钉钉 Stream / QQ websocket 同型），
// 无卡片流式（streaming 'none'——只发最终结果）、sendMessage 不设 parse_mode
// 即纯文本（markdown 'none'）、群聊依赖 privacy mode 默认只推 @ 消息。
// 审批按钮降级为文字双轨（教用户回短指令，词表与钉钉/QQ 降级话术同一套）。
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntimeContext,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '../../../channels/types';
import { chunkText } from '../../../channels/chunk';
import type { TelegramAdapterOptions, TelegramTransport } from './types';
import { approvalHint, isRoutableChatType, toInboundEvent } from './normalize';

export function telegramCapabilities(): ChannelCapabilities {
  return {
    chatTypes: ['dm', 'group'],
    media: { images: false, audio: false, video: false, files: false },
    streaming: 'none',
    // sendMessage 纯文本上限 4096，保守 4000，超长由 chunkText 分帧。
    maxTextLength: 4000,
    markdown: 'none',
    canDeliverImages: false,
    threads: false,
    reactions: false,
    typing: false,
    editMessages: false,
    buttons: false,
    requiresMentionInGroup: true,
  };
}

export function createTelegramAdapter(deps: TelegramAdapterOptions): ChannelAdapter {
  const accountId = deps.accountId ?? 'default';
  const transport: TelegramTransport = deps.transport;
  const capabilities = telegramCapabilities();

  async function sendChunked(chatId: string, text: string): Promise<string> {
    const chunks = chunkText(text, capabilities.maxTextLength);
    let last = '';
    for (const chunk of chunks) last = await transport.sendText(chatId, chunk);
    return last;
  }

  return {
    id: 'telegram',
    capabilities,

    async start(context: ChannelRuntimeContext): Promise<void> {
      await transport.start({
        onMessage: (raw) => {
          // channel 型广播频道纯单向（bot 无发言资格），收到不触发回合。
          if (!isRoutableChatType(raw.chat.type)) return;
          context.onInbound(toInboundEvent(raw, accountId));
        },
        log: context.log,
      });
    },

    async stop(): Promise<void> {
      await transport.stop();
    },

    async send(target: ChannelTarget, msg: OutboundMessage): Promise<SendResult> {
      const text = msg.kind === 'approval' ? `${msg.text}${approvalHint(msg.buttons)}` : msg.text;
      return { messageId: await sendChunked(target.peerId, text) };
    },

    listAccountIds(): string[] {
      return [accountId];
    },
  };
}
