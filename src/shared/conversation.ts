import type { Message } from './types';
import { stripUserTurnContext } from './promptLayers';

export function mergeTranscriptWithTurn(
  transcript: Message[],
  modelMessages: Message[],
  userText?: string,
  /** 规划叙述（2026-09-27 时序修正）：模型当着用户想出来的那段思考，发生在
   * 用户请求之后。它由 preflight 押在控制器上，等本回合的用户消息落进转录时
   * 在这里插到请求后面——canonical 时序从此是「先请求，后思考，再执行」。
   * 此前直接 push 进转录会让它排在请求前面，回放就成了“先思考后提问”。 */
  preflightNarration?: Message,
): Message[] {
  const normalizedUserText = userText?.trim();
  const transcriptUsers = new Set(
    transcript
      .filter(message => message.role === 'user')
      .map(message => stripUserTurnContext(message.content ?? '').trim()),
  );
  let turnStart = -1;
  for (let index = modelMessages.length - 1; index >= 0; index--) {
    const message = modelMessages[index];
    if (message.role !== 'user') continue;
    const normalized = stripUserTurnContext(message.content ?? '').trim();
    if ((normalizedUserText !== undefined && normalized === normalizedUserText)
      || (normalizedUserText === undefined && !transcriptUsers.has(normalized))) {
      turnStart = index;
      break;
    }
  }
  if (turnStart < 0) return transcript;

  const transcriptSystem = transcript.filter(message => message.role === 'system');
  const modelSystem = modelMessages.filter(message => message.role === 'system');
  const system = transcriptSystem.length > 0 ? transcriptSystem : modelSystem;
  const priorConversation = transcript.filter(message => message.role !== 'system');
  const turnMessages = modelMessages.slice(turnStart).filter(message => message.role !== 'system');
  // 叙述紧跟本回合用户消息（turnStart 那条就是它），先于回合内其余消息。
  const newTurn = preflightNarration && turnMessages.length > 0
    ? [turnMessages[0], preflightNarration, ...turnMessages.slice(1)]
    : turnMessages;
  return [...system, ...priorConversation, ...newTurn];
}

/**
 * 2a7c950 的旧账修复（2026-09-27）：规划叙述曾被直接 push 进转录，排在用户
 * 请求之前，持久化成 [system, 思考, 用户请求, …]。真实时序是先请求后思考，
 * 回放与后续模型上下文都应按真实时序走。这里把「首个用户消息之前的
 * assistant 连段」搬回用户消息之后；只在命中这个已知倒置形状时动数据，
 * 正常会话（首条即用户）原样返回。含 tool 的头部不是叙述形状，不动。
 *
 * 已知边界：只治会话开头的倒置（用户报的正是“第一句话就反了”）。后续回合
 * 的同类倒置无形状判据（回合以 assistant 收尾是常态），交给源头修复——
 * 新回合的叙述已改为押账待插，不再先进 canonical。
 */
export function relocatePreflightNarration(messages: Message[]): Message[] {
  const firstUser = messages.findIndex(message => message.role === 'user');
  if (firstUser <= 0) return messages;
  const head = messages.slice(0, firstUser);
  if (!head.some(message => message.role === 'assistant')) return messages;
  if (head.some(message => message.role === 'tool')) return messages;
  const system = head.filter(message => message.role === 'system');
  const narrators = head.filter(message => message.role !== 'system');
  return [...system, messages[firstUser], ...narrators, ...messages.slice(firstUser + 1)];
}
