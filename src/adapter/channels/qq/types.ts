// src/adapter/channels/qq/types.ts
// QQ 官方机器人（QQ 开放平台）传输层接缝。适配器只依赖这个接口；真实运行用
// wsTransport（原生 WebSocket + REST，无 SDK 依赖——QQ 侧没有可维护的官方
// npm SDK，裸协议反而更可控），单测用 mock transport。
//
// 协议要点（2026-10 快照，实测项见 cn-im-channels.md §7）：
//   - 鉴权：POST bots.qq.com/app/getAppAccessToken {appId, clientSecret} →
//     access_token（约 7200s，提前刷新）；REST 带 `Authorization: QQBot <token>`。
//   - 入站：wss://api.sgroup.qq.com/websocket（出站连接，无需公网回调地址，
//     与钉钉 Stream 同型）；op 2 Identify（intents 含群/单聊 + 频道位）→
//     op 10 READY；op 1 心跳按 Hello 给的间隔发。
//   - 事件：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群 @，
//     天然 requiresMentionInGroup）/ AT_MESSAGE_CREATE（频道）。
//   - 出站：REST v2 被动回复（引用入站 msg_id + 递增 msg_seq）：
//     /v2/users/{openid}/messages 与 /v2/groups/{group_openid}/messages，
//     msg_type 0 纯文本（markdown 需模板报备，不用）。

export interface QQRawMessage {
  /** WS 推送的消息 id（幂等键来源）。 */
  messageId: string;
  /** 会话路由键：单聊=对方 openid，群=group_openid。 */
  conversationId: string;
  conversationType: 'dm' | 'group';
  text: string;
  /** 发送者 openid（审计/单聊回复路由用，不进模型上下文）。 */
  authorId: string;
  authorName?: string;
  /** 被动回复锚：回复必须引用这条的 msg_id。 */
  replyMsgId: string;
  createTime?: number;
}

export interface QQTransportHandlers {
  onMessage(message: QQRawMessage): void;
  log(message: string): void;
}

export interface QQTransport {
  start(handlers: QQTransportHandlers): Promise<void>;
  stop(): Promise<void>;
  /**
   * 发一条文本（被动回复：引用最近一条入站消息的 msg_id，msg_seq 递增）。
   * 返回适配器侧消息 id（QQ v2 不稳定回传 id，用本地合成 id）。
   */
  sendText(conversationId: string, text: string): Promise<string>;
  /** 发一张图片（/files 上传 + rich media 消息）。未实现时富输出降级为文本。 */
  sendImage?(conversationId: string, image: Uint8Array, name: string): Promise<string>;
}

export interface QQAdapterOptions {
  accountId?: string;
  transport: QQTransport;
}
