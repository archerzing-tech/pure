// src/adapter/channels/feishu/types.ts
// 飞书长连接的传输层接缝（设计文档 cn-im-channels.md §2）。适配器只依赖这个
// 接口，不直接依赖 SDK —— 单测用 mock transport，真实运行用 sdkTransport
// （动态 import @larksuiteoapi/node-sdk）。SDK 不进 CL I/GUI 的其它路径。
export interface FeishuRawMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  /** 平台消息类型：text / post / image / file / audio / media / ... */
  messageType: string;
  /** 已从 content JSON 抽出的纯文本（transport 负责解析）。 */
  text: string;
  /** 这条消息是否 @ 了本机器人（群聊触发判定用）。 */
  mentionsBot: boolean;
  senderId: string;
  senderName?: string;
  threadId?: string;
  createTime?: number;
}

export interface FeishuCardAction {
  openId: string;
  /** 触发卡片所在会话。 */
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId: string;
  /** 按钮 value（适配器写入 { approvalId, decision }）。 */
  actionValue: Record<string, unknown>;
  createTime?: number;
}

export interface FeishuTransportHandlers {
  onMessage(message: FeishuRawMessage): void;
  onCardAction(action: FeishuCardAction): void;
  log(message: string): void;
}

export interface FeishuTransport {
  start(handlers: FeishuTransportHandlers): Promise<void>;
  stop(): Promise<void>;
  /** 发纯文本，返回 message_id。 */
  sendText(chatId: string, text: string): Promise<string>;
  /** 发交互卡片（结构化 JSON），返回 message_id。 */
  sendCard(chatId: string, card: unknown): Promise<string>;
  /** 更新已发卡片（流式快照替换）。 */
  patchCard(messageId: string, card: unknown): Promise<void>;
  /** 发一张图片（富输出附件）。未实现时富输出降级为文本。 */
  sendImage?(chatId: string, image: Uint8Array, name: string): Promise<string>;
}

export interface FeishuAdapterOptions {
  accountId?: string;
  transport: FeishuTransport;
}
