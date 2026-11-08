// src/adapter/channels/telegram/types.ts
// Telegram Bot API 传输层接缝。适配器只依赖这个接口；真实运行用 httpTransport
// （纯 REST：getUpdates 长轮询收、sendMessage 发——出站连接、无需公网回调，
// 与钉钉 Stream / QQ websocket 同型的「零公网依赖」接入方式），单测用 mock。
//
// 协议要点（2026-11 快照，https://core.telegram.org/bots/api）：
//   - 鉴权：单一 bot token（@BotFather 发放），所有端点形如
//     /bot<token>/<method>；token 即全部凭据。
//   - 入站：getUpdates 长轮询（timeout 参数挂服务器，秒级回包）；启动先
//     deleteWebhook(drop_pending_updates) 清积压防老消息重灌；offset =
//     上条 update_id + 1 确认消费。
//   - 出站：POST /bot<token>/sendMessage {chat_id, text}（不设 parse_mode，
//     纯文本投递）。

/** getMe 捕获的 bot 身份；群聊 addressed 判定（text 含 @botUsername）用。 */
export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramFrom {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

/** 归一前的入站消息：transport 从 getUpdates 的 message 载荷裁出。 */
export interface TelegramRawMessage {
  /** telegram message_id（会话内递增）；与 chat.id 组成全局幂等键。 */
  messageId: number;
  chat: TelegramChat;
  from?: TelegramFrom;
  /** unix 秒（telegram 的 date 字段），归一化时 ×1000。 */
  date: number;
  text?: string;
  /** start 时 getMe 捕获的 bot 用户名（不带 @）；群聊 addressed 判定用。 */
  botUsername?: string;
}

export interface TelegramTransportHandlers {
  onMessage(message: TelegramRawMessage): void;
  log(message: string): void;
}

export interface TelegramTransport {
  start(handlers: TelegramTransportHandlers): Promise<void>;
  stop(): Promise<void>;
  /** 发一条文本到 chat.id。返回平台 message_id（十进制字符串）。 */
  sendText(chatId: string, text: string): Promise<string>;
}

export interface TelegramAdapterOptions {
  accountId?: string;
  transport: TelegramTransport;
}
