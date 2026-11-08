// src/adapter/channels/telegram/normalize.ts
// Telegram 的纯归一化逻辑：chat.type → 会话形态、@bot 提及清洗、入站映射、
// 审批文字双轨的指令解析。
import { decisionToReplyText, type ApprovalAnswer } from '../../../channels/approvals';
import type { InboundEvent, PeerKind } from '../../../channels/types';
import type { TelegramRawMessage } from './types';

export { decisionToReplyText };

/** channel 型广播频道纯单向（bot 无发言资格），收到也不该触发回合。 */
export function isRoutableChatType(type: TelegramRawMessage['chat']['type']): boolean {
  return type === 'private' || type === 'group' || type === 'supergroup';
}

export function toPeerKind(type: TelegramRawMessage['chat']['type']): PeerKind {
  return type === 'private' ? 'dm' : 'group';
}

/** 群聊剥掉 @botusername 提及（私聊没有前缀，剥了也不伤）。 */
export function stripBotMention(text: string, botUsername?: string): string {
  if (!botUsername) return text.trim();
  const re = new RegExp(`^\\s*@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
  return text.replace(re, '').trim();
}

export function toInboundEvent(raw: TelegramRawMessage, accountId: string): InboundEvent {
  const text = raw.text ?? '';
  // 私聊天然直达；群聊只有文本里 @ 了机器人才算点名（privacy mode 下
  // BotFather 默认只推 @ 消息与命令，未 @ 的根本到不了这里）。
  const addressed = raw.chat.type === 'private' || (raw.botUsername ? text.includes(`@${raw.botUsername}`) : false);
  return {
    kind: 'message',
    channelId: 'telegram',
    accountId,
    peer: {
      id: String(raw.chat.id),
      kind: toPeerKind(raw.chat.type),
      name: raw.chat.title ?? raw.from?.username ?? raw.from?.firstName,
    },
    messageId: `${raw.chat.id}:${raw.messageId}`,
    text: stripBotMention(text, raw.botUsername),
    attachments: [],
    receivedAt: raw.date ? raw.date * 1000 : Date.now(),
    addressed,
  };
}

// 审批文字双轨（Telegram 无卡片按钮）：与钉钉/QQ 降级话术同一套词表。
const ALLOW_WORDS = new Set(['allow', 'approve', 'approved', 'accept', 'agree', 'y', 'yes', '批准', '同意', '允许']);
const ALWAYS_WORDS = new Set(['always', 'always_allow', 'alwaysallow', 'a', '总是允许', '本次总是允许']);
const DENY_WORDS = new Set(['deny', 'denied', 'reject', 'n', 'no', '拒绝', '不同意']);

/** 短指令 → 审批决定；非审批回复返回 null（按普通消息走）。 */
export function parseTelegramApprovalReply(raw: string): ApprovalAnswer | null {
  const action = raw.trim().toLowerCase();
  if (ALWAYS_WORDS.has(action)) return 'always';
  if (DENY_WORDS.has(action)) return 'deny';
  if (ALLOW_WORDS.has(action)) return 'allow';
  return null;
}

/** 审批卡降级为纯文本时的操作提示（Telegram 无按钮，教用户回短指令）。 */
export function approvalHint(buttons?: Array<{ id: string; label: string }>): string {
  const labels = buttons?.length ? buttons.map((b) => `[${b.label}]`).join('  ') : '[批准]  [拒绝]  [总是允许]';
  return `\n\n${labels}\n（回复 y 批准 / n 拒绝 / a 本次会话总是允许）`;
}
