// src/adapter/channels/dingtalk/types.ts
// 钉钉 Stream 模式的传输层接缝（设计文档 cn-im-channels.md §4）。
// 适配器只依赖这个接口；真实运行用 sdkTransport（动态 import dingtalk-stream），
// 单测用 mock transport。
export interface DingTalkRawMessage {
  /** Stream 推送的消息 id（headers.messageId）。 */
  messageId: string;
  conversationId: string;
  /** 钉钉会话类型：'1' 单聊，'2' 群聊。 */
  conversationType: '1' | '2';
  text: string;
  /** 平台事实：这条消息是否 @ 了本机器人（isInAtList / atUsers 命中）。 */
  atBot: boolean;
  senderStaffId: string;
  senderNick?: string;
  robotCode?: string;
  /** 本条消息携带的回话地址（transport 内部用来回复，不进模型上下文）。 */
  sessionWebhook?: string;
  createTime?: number;
}

export interface DingTalkCardAction {
  /** 建卡时的业务标识，用来定位是哪一次工具调用在等审批。 */
  outTrackId: string;
  /** 卡片按钮回传的原始 action 值。 */
  action: string;
  conversationId: string;
  conversationType: '1' | '2';
  userId?: string;
  createTime?: number;
}

export interface DingTalkCard {
  markdown: string;
  outTrackId: string;
  buttons?: Array<{ id: string; label: string }>;
}

export interface DingTalkTransportHandlers {
  onMessage(message: DingTalkRawMessage): void;
  onCardAction(action: DingTalkCardAction): void;
  log(message: string): void;
}

export interface DingTalkTransport {
  /**
   * 该 transport 是否支持卡片流式更新（AI 卡片实例）。
   * false 时适配器把能力里 streaming 降为 'none'：不推进度帧，只发最终结果。
   */
  readonly canStreamCards: boolean;
  start(handlers: DingTalkTransportHandlers): Promise<void>;
  stop(): Promise<void>;
  sendMarkdown(conversationId: string, text: string): Promise<string>;
  sendCard(conversationId: string, card: DingTalkCard): Promise<string>;
  updateCard(outTrackId: string, card: DingTalkCard): Promise<void>;
  /** 发一张图片（富输出附件）。未实现时富输出降级为文本。 */
  sendImage?(conversationId: string, image: Uint8Array, name: string): Promise<string>;
}

export interface DingTalkAdapterOptions {
  accountId?: string;
  transport: DingTalkTransport;
}
