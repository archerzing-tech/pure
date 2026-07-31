// src/harness/ContextEngine.ts
// v0.5 — sliding window context compression with tool_call atomic pair constraint.
// Fixes: atomic pair pullback no longer causes trimmed messages to exceed maxMessages.

import type { Message, LLMAdapter } from '../shared/types';

export interface ContextEngineConfig {
  maxMessages: number;
  summaryThreshold?: number;
  llm?: LLMAdapter;
}

export class ContextEngine {
  private config: ContextEngineConfig;

  constructor(config: ContextEngineConfig) {
    this.config = {
      maxMessages: config.maxMessages,
      summaryThreshold: config.summaryThreshold ?? 40,
      llm: config.llm,
    };
  }

  async trim(messages: Message[]): Promise<Message[]> {
    if (messages.length <= this.config.maxMessages) return messages;

    const systemMsg = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Start with the absolute latest message, then add older messages
    // while respecting atomic tool pairs, up to maxMessages
    const trimmed: Message[] = [];
    const targetCount = this.config.maxMessages;

    // Walk backwards from the newest message
    const pairs = this.groupAtomicPairs(nonSystem);

    // Take from the end (newest) up to targetCount, respecting atomic pairs
    let taken = 0;
    for (let i = pairs.length - 1; i >= 0 && taken < targetCount; i--) {
      const pair = pairs[i];
      trimmed.unshift(...pair);
      taken += pair.length;
    }

    // Enforce hard limit: if we still exceed targetCount (unlikely but defensive), trim from front
    while (trimmed.length > targetCount) {
      const first = trimmed[0];
      // If first item is an assistant with toolCalls, remove the pair
      if (first.role === 'assistant' && first.toolCalls?.length) {
        const ids = new Set(first.toolCalls.map(tc => tc.id));
        // Remove the assistant and all following tool messages that belong to it
        let removed = 0;
        for (const m of [...trimmed]) {
          if (removed === 0 && m === first) {
            trimmed.shift();
            removed++;
          } else if (m.role === 'tool' && m.toolCallId && ids.has(m.toolCallId)) {
            trimmed.splice(trimmed.indexOf(m), 1);
          } else {
            break;
          }
        }
      } else {
        trimmed.shift();
      }
    }

    // Safety guard: keep at least the latest atomic pair if everything was evicted
    if (trimmed.length === 0 && pairs.length > 0) {
      trimmed.push(...pairs[pairs.length - 1]);
    }

    // Build the evicted list (everything we didn't keep)
    const evicted = nonSystem.slice(0, nonSystem.length - trimmed.length);

    // Optional LLM summarization of evicted content
    const threshold = this.config.summaryThreshold;
    if (this.config.llm && threshold !== undefined && evicted.length > threshold) {
      try {
        const summaryPrompt = `Summarize the key information from this conversation. Include any decisions made, code patterns discussed, file paths mentioned, and user preferences:\n\n${evicted.map(m => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')}`;
        const summary = await this.config.llm!.complete(
          [{ role: 'user', content: summaryPrompt }],
          []
        );
        const summaryMsg: Message = {
          role: 'user',
          content: `[Conversation summary] ${String(summary.content)}`,
        };
        return [...systemMsg, summaryMsg, ...trimmed];
      } catch {
        // summarization failed, continue without summary
      }
    }

    return [...systemMsg, ...trimmed];
  }

  /**
   * Group messages into atomic pairs: assistant (with toolCalls) + following tool messages.
   * Messages without toolCalls are their own single-element group.
   */
  private groupAtomicPairs(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const toolCallIds = new Set(msg.toolCalls.map(tc => tc.id));
        const pair: Message[] = [msg];
        i++;
        // Collect all tool messages that belong to this assistant
        while (i < messages.length && messages[i].role === 'tool' && messages[i].toolCallId && toolCallIds.has(messages[i].toolCallId!)) {
          pair.push(messages[i]);
          i++;
        }
        groups.push(pair);
      } else {
        groups.push([msg]);
        i++;
      }
    }

    return groups;
  }
}
