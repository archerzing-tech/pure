// src/adapter/channels/dingtalk/normalize.ts
// 钉钉的纯归一化逻辑：@ 前缀清洗、入站映射、卡片构造、按钮回调解析。
import { decisionToReplyText, type ApprovalAnswer } from '../../../channels/approvals';
import type { InboundEvent } from '../../../channels/types';
import type { DingTalkCard, DingTalkCardAction, DingTalkRawMessage } from './types';

export { decisionToReplyText };

/** 钉钉文本里 @ 会带机器人昵称前缀，需要剥掉再进模型。 */
export function stripAtPrefix(text: string, atBot: boolean): string {
  if (!atBot) return text.trim();
  return text.replace(/^\s*@\S+\s*/, '').trim();
}

export function toInboundEvent(raw: DingTalkRawMessage, accountId: string): InboundEvent {
  return {
    kind: 'message',
    channelId: 'dingtalk',
    accountId,
    peer: { id: raw.conversationId, kind: raw.conversationType === '2' ? 'group' : 'dm', name: raw.senderNick },
    messageId: raw.messageId,
    text: stripAtPrefix(raw.text, raw.atBot),
    attachments: [],
    receivedAt: raw.createTime ?? Date.now(),
    addressed: raw.atBot,
  };
}

// 钉钉卡片按钮的 action 取值约定（cn-im-channels.md §4.2）：
// allow | approve | approved | accept | agree = 批准；deny | denied | reject = 拒绝。
const ALLOW_ACTIONS = new Set(['allow', 'approve', 'approved', 'accept', 'agree']);
const ALWAYS_ACTIONS = new Set(['always', 'always_allow', 'alwaysallow']);
const DENY_ACTIONS = new Set(['deny', 'denied', 'reject']);

export function parseDingTalkAction(raw: string): ApprovalAnswer | null {
  const action = raw.trim().toLowerCase();
  if (ALWAYS_ACTIONS.has(action)) return 'always';
  if (DENY_ACTIONS.has(action)) return 'deny';
  if (ALLOW_ACTIONS.has(action)) return 'allow';
  return null;
}

export function buildDingTalkCard(markdown: string, outTrackId: string, buttons?: DingTalkCard['buttons']): DingTalkCard {
  return { markdown, outTrackId, buttons };
}

/** 卡片回调 → 与文字回复同形的入站事件（同 conversationId，sessionKey 才一致）。 */
export function actionToInboundEvent(action: DingTalkCardAction, decision: ApprovalAnswer, accountId: string): InboundEvent {
  return {
    kind: 'message',
    channelId: 'dingtalk',
    accountId,
    peer: { id: action.conversationId, kind: action.conversationType === '2' ? 'group' : 'dm' },
    messageId: `dingtalk_card_${action.outTrackId}_${decision}`,
    text: decisionToReplyText(decision),
    attachments: [],
    receivedAt: action.createTime ?? Date.now(),
    addressed: true,
  };
}
