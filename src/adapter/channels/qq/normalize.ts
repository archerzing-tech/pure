// src/adapter/channels/qq/normalize.ts
// QQ 的纯归一化逻辑：@ 前缀清洗、入站映射、审批文字双轨的指令解析。
import { decisionToReplyText, type ApprovalAnswer } from '../../../channels/approvals';
import type { InboundEvent } from '../../../channels/types';
import type { QQRawMessage } from './types';

export { decisionToReplyText };

/** 群聊消息天然带 @（GROUP_AT_MESSAGE_CREATE 才会推），剥掉前缀再进模型。 */
export function stripAtPrefix(text: string): string {
  return text.replace(/^\s*@\S+\s*/, '').trim();
}

export function toInboundEvent(raw: QQRawMessage, accountId: string): InboundEvent {
  return {
    kind: 'message',
    channelId: 'qq',
    accountId,
    peer: { id: raw.conversationId, kind: raw.conversationType, name: raw.authorName },
    messageId: raw.messageId,
    text: stripAtPrefix(raw.text),
    attachments: [],
    receivedAt: raw.createTime ?? Date.now(),
    // QQ 群消息只有 @ 了机器人才会推（GROUP_AT_MESSAGE_CREATE），永远 addressed。
    addressed: true,
  };
}

// 审批文字双轨（QQ 无卡片按钮）：与钉钉降级话术同一套词表。
const ALLOW_WORDS = new Set(['allow', 'approve', 'approved', 'accept', 'agree', 'y', 'yes', '批准', '同意', '允许']);
const ALWAYS_WORDS = new Set(['always', 'always_allow', 'alwaysallow', 'a', '总是允许', '本次总是允许']);
const DENY_WORDS = new Set(['deny', 'denied', 'reject', 'n', 'no', '拒绝', '不同意']);

/** 短指令 → 审批决定；非审批回复返回 null（按普通消息走）。 */
export function parseQQApprovalReply(raw: string): ApprovalAnswer | null {
  const action = raw.trim().toLowerCase();
  if (ALWAYS_WORDS.has(action)) return 'always';
  if (DENY_WORDS.has(action)) return 'deny';
  if (ALLOW_WORDS.has(action)) return 'allow';
  return null;
}

/** 审批卡降级为纯文本时的操作提示（QQ 无按钮，教用户回短指令）。 */
export function approvalHint(buttons?: Array<{ id: string; label: string }>): string {
  const labels = buttons?.length ? buttons.map((b) => `[${b.label}]`).join('  ') : '[批准]  [拒绝]  [总是允许]';
  return `\n\n${labels}\n（回复 y 批准 / n 拒绝 / a 本次会话总是允许）`;
}
