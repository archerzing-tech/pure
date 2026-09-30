// src/channels/types.ts
// Channel Gateway 的规范类型（Shared Kernel，纯 TS，无外部依赖）。
// 核心不变式：核心逻辑只读 capabilities，从不 if (channelId === 'telegram')。
// 适配器只做「平台协议 ↔ 规范类型」，渲染 / 分片 / 权限判断一律不在这里。
import type { PermissionMode } from '../coding-agent/types';

export type ChannelId = string;

export type PeerKind = 'dm' | 'group';

/** 通道能力声明 —— 核心逻辑的唯一分支依据（设计文档 §4.2）。 */
export interface ChannelCapabilities {
  chatTypes: PeerKind[];
  media: { images?: boolean; audio?: boolean; video?: boolean; files?: boolean };
  /** none=整段发；edit=编辑已发消息；card=平台卡片；stream=全量替换式流式消息。 */
  streaming: 'none' | 'edit' | 'card' | 'stream';
  maxTextLength: number;
  markdown: 'none' | 'basic' | 'full';
  /**
   * 出站是否能投递图片附件（默认由 media.images 推定）。与 media.images 分开：
   * 平台能收图片不代表适配器已实现图片上传，富输出降级矩阵用这个字段决定
   * 是「转 PNG 附件」还是「诚实降级为文本」，避免生成后被静默丢弃。
   */
  canDeliverImages?: boolean;
  threads?: boolean;
  reactions?: boolean;
  typing?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  buttons?: boolean;
  /** 群聊必须 @ 才响应（国内三家的群聊语义，默认 true）。 */
  requiresMentionInGroup?: boolean;
}

/** 出站目标：一次回复落在哪个会话的哪个人/群。 */
export interface ChannelTarget {
  accountId: string;
  peerId: string;
  peerKind: PeerKind;
  threadId?: string;
}

/** 出站帧的种类决定投递语义：progress 可丢，其余必须送达（§7 双队列）。 */
export type OutboundKind = 'progress' | 'final' | 'notice' | 'error' | 'approval';

export interface OutboundAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface OutboundButton {
  id: string;
  label: string;
}

export interface OutboundMessage {
  kind: OutboundKind;
  text: string;
  /** 流式快照替换：有 messageId 时适配器编辑该消息而不是新发一条。 */
  messageId?: string;
  /** 该气泡的最后一帧（适配器据此收尾，如企微 stream 的 finish）。 */
  final?: boolean;
  attachments?: OutboundAttachment[];
  buttons?: OutboundButton[];
  /** 审批请求 id（kind === 'approval' 时必填），回复用它定位待决请求。 */
  approvalId?: string;
}

export interface SendOptions {
  /** 该帧是某条流式气泡的续帧（平台侧按 messageId 更新）。 */
  edit?: boolean;
}

export interface SendResult {
  messageId: string;
}

export interface InboundAttachment {
  name: string;
  mimeType: string;
  /** 适配器已把媒体落到本地临时文件，这里给绝对路径。 */
  localPath: string;
}

export interface MediaRef {
  id: string;
  mimeType?: string;
}

export interface LocalMedia {
  name: string;
  mimeType: string;
  localPath: string;
}

/** 入站归一化事件（适配器 → gateway）。raw 永不进模型上下文（§6.4）。 */
export interface InboundEvent {
  kind: 'message' | 'reaction' | 'command' | 'status';
  channelId: ChannelId;
  accountId: string;
  peer: { id: string; kind: PeerKind; name?: string };
  threadId?: string;
  /** 入站幂等键来源（平台消息 id）。 */
  messageId: string;
  text: string;
  attachments: InboundAttachment[];
  receivedAt: number;
  /** 平台已判定这条消息是否 @ 了本机器人（群聊触发判定用）。 */
  addressed?: boolean;
  /** 仅供审计，不进模型上下文。 */
  raw?: unknown;
}

/** 适配器运行时上下文：适配器自己负责长连接/webhook，入站经 onInbound 推入。 */
export interface ChannelRuntimeContext {
  accountId: string;
  onInbound(event: InboundEvent): void;
  log(message: string): void;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** 出站（唯一必需能力）。 */
  send(target: ChannelTarget, msg: OutboundMessage, opts?: SendOptions): Promise<SendResult>;
  /** 声明式可选能力：capabilities 里为 true 才会被调用。 */
  editMessage?(target: ChannelTarget, messageId: string, msg: OutboundMessage): Promise<void>;
  setTyping?(target: ChannelTarget, on: boolean): Promise<void>;
  downloadMedia?(ref: MediaRef): Promise<LocalMedia>;
  /** 生命周期：适配器自管理连接；直接抛错即可，gateway 统一处理。 */
  start(ctx: ChannelRuntimeContext): Promise<void>;
  stop(): Promise<void>;
  listAccountIds(): string[];
}

/** 适配器出站的最小接口（供 outbox / renderer 依赖，便于 mock）。 */
export interface ChannelSender {
  readonly id: ChannelId;
  send(target: ChannelTarget, msg: OutboundMessage, opts?: SendOptions): Promise<SendResult>;
}

export type ChannelToolProfile = 'coding' | 'readonly';

/** binding 链解析结果（§5.1）。 */
export interface ResolvedBinding {
  workspace: string | null;
  permissionMode: PermissionMode;
  toolProfile: ChannelToolProfile;
  /** R5：渠道闲聊默认不写长期记忆（只记 session 级）。 */
  evolutionEnabled: boolean;
  matched: boolean;
}
