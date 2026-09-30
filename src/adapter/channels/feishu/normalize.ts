// src/adapter/channels/feishu/normalize.ts
// 飞书的纯归一化逻辑（无 IO、无 SDK）：mention 清洗、入站事件映射、分片、卡片
// 构造、按钮回调解析。全部可单测 —— 适配器里只剩「调 transport」。
import { decisionToReplyText, type ApprovalAnswer } from '../../../channels/approvals';
import type { InboundEvent, OutboundButton } from '../../../channels/types';
import { chunkText } from '../../../channels/chunk';
import type { FeishuCardAction, FeishuRawMessage } from './types';

export { chunkText, decisionToReplyText };

/** 飞书 @ 占位符形如 `@_user_1`，出现在 text 里，需要剥掉再进模型。 */
const MENTION_TOKEN = /@_user_\d+/g;

export function stripMentions(text: string): string {
  return text.replace(MENTION_TOKEN, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').trim();
}

export function toInboundEvent(raw: FeishuRawMessage, accountId: string): InboundEvent {
  return {
    kind: 'message',
    channelId: 'feishu',
    accountId,
    peer: { id: raw.chatId, kind: raw.chatType === 'p2p' ? 'dm' : 'group', name: raw.senderName },
    threadId: raw.threadId,
    messageId: raw.messageId,
    text: stripMentions(raw.text),
    attachments: [],
    receivedAt: raw.createTime ?? Date.now(),
    // 群聊触发判定用平台事实（是否 @ 了我），而不是对清洗后的文本做正则猜测。
    addressed: raw.mentionsBot,
  };
}


export function buildMarkdownCard(text: string): unknown {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [{ tag: 'markdown', content: text }],
  };
}

export const APPROVAL_BUTTONS: OutboundButton[] = [
  { id: 'allow', label: '批准' },
  { id: 'always', label: '本次会话总是允许' },
  { id: 'deny', label: '拒绝' },
];

export function buildApprovalCard(text: string, approvalId: string): unknown {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      { tag: 'markdown', content: text },
      {
        tag: 'action',
        actions: APPROVAL_BUTTONS.map((button) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: button.label },
          type: button.id === 'deny' ? 'danger' : button.id === 'allow' ? 'primary' : 'default',
          value: { approvalId, decision: button.id },
        })),
      },
    ],
  };
}

const DECISIONS: ApprovalAnswer[] = ['allow', 'always', 'deny'];

/** 从卡片按钮回调里取出决定；不认识的 value 返回 null（当普通消息处理）。 */
export function approvalDecisionFromAction(value: Record<string, unknown>): ApprovalAnswer | null {
  const decision = value.decision;
  if (typeof decision === 'string' && (DECISIONS as string[]).includes(decision)) return decision as ApprovalAnswer;
  return null;
}

/** 卡片回调 → 与文字回复同形的入站事件（同 chatId，sessionKey 才一致）。 */
export function actionToInboundEvent(action: FeishuCardAction, decision: ApprovalAnswer, accountId: string): InboundEvent {
  return {
    kind: 'message',
    channelId: 'feishu',
    accountId,
    peer: { id: action.chatId, kind: action.chatType === 'p2p' ? 'dm' : 'group', name: undefined },
    messageId: `feishu_card_${action.messageId}_${decision}`,
    text: decisionToReplyText(decision),
    attachments: [],
    receivedAt: action.createTime ?? Date.now(),
    addressed: true,
  };
}
