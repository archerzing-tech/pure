import type { Message } from './types';
import { stripUserTurnContext } from './promptLayers';

export function mergeTranscriptWithTurn(
  transcript: Message[],
  modelMessages: Message[],
  userText?: string,
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
  const newTurn = modelMessages.slice(turnStart).filter(message => message.role !== 'system');
  return [...system, ...priorConversation, ...newTurn];
}
