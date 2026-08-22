// src/harness/ContextEngine.ts
// v0.6 — context compaction with tool-call atomicity and explicit results.

import { estimateToolDefinitionTokens } from '../shared/providers';
import type { Message, LLMAdapter, ToolDefinition } from '../shared/types';

export interface ContextEngineConfig {
  maxMessages: number;
  summaryThreshold?: number;
  /** Token budget for messages plus the provider's output reserve. */
  maxTokens?: number;
  /** Tool schemas are sent outside messages and must count toward the same window. */
  tools?: ToolDefinition[];
  toolsProvider?: () => ToolDefinition[];
  llm?: LLMAdapter;
}

export interface ContextCompactionOptions {
  /** Re-run compaction even when the current window is already within limits. */
  force?: boolean;
}

export interface ContextCompactionResult {
  messages: Message[];
  compacted: boolean;
  summarized: boolean;
  summaryUnavailable: boolean;
  evictedMessages: number;
  estimatedTokens: number;
  overBudget: boolean;
  oversizedNewestGroup: boolean;
}

interface MessageGroup {
  messages: Message[];
  retainable: boolean;
}

const SUMMARY_TIMEOUT_MS = 60_000;

function estimateTokens(messages: Message[]): number {
  let sum = 0;
  for (const message of messages) sum += Math.ceil((message.content?.length ?? 0) / 4);
  return sum;
}

export class ContextEngine {
  private config: ContextEngineConfig;
  private lastCompactionResult?: ContextCompactionResult;

  constructor(config: ContextEngineConfig) {
    this.config = {
      maxMessages: Math.max(1, config.maxMessages),
      summaryThreshold: config.summaryThreshold ?? 40,
      maxTokens: config.maxTokens,
      tools: config.tools,
      toolsProvider: config.toolsProvider,
      llm: config.llm,
    };
  }

  async trim(messages: Message[]): Promise<Message[]> {
    return (await this.compact(messages)).messages;
  }

  getLastCompactionResult(): ContextCompactionResult | undefined {
    return this.lastCompactionResult;
  }

  async compact(
    messages: Message[],
    options: ContextCompactionOptions = {},
  ): Promise<ContextCompactionResult> {
    const allSystemMessages = messages.filter(message => message.role === 'system');
    const baseSystemMessages = allSystemMessages.filter(message => !this.isCompactionSummary(message));
    const priorSummaries = allSystemMessages.filter(message => this.isCompactionSummary(message));
    const priorSummary = priorSummaries.at(-1);
    const systemMessages = priorSummary ? [...baseSystemMessages, priorSummary] : baseSystemMessages;
    const nonSystem = messages.filter(message => message.role !== 'system');
    const toolTokens = estimateToolDefinitionTokens(this.config.toolsProvider?.() ?? this.config.tools);
    const currentTokens = estimateTokens([...systemMessages, ...nonSystem]) + toolTokens;
    const overMessageBudget = nonSystem.length > this.config.maxMessages;
    const overTokenBudget = this.config.maxTokens !== undefined && currentTokens > this.config.maxTokens;

    const groups = this.groupAtomicPairs(nonSystem);
    const hasInvalidFragments = groups.some(group => !group.retainable);
    const hasCollapsedSummaries = priorSummaries.length > 1;
    if (!options.force && !overMessageBudget && !overTokenBudget && !hasInvalidFragments && !hasCollapsedSummaries) {
      return this.remember({
        messages,
        compacted: false,
        summarized: false,
        summaryUnavailable: false,
        evictedMessages: 0,
        estimatedTokens: currentTokens,
        overBudget: false,
        oversizedNewestGroup: false,
      });
    }

    const kept = new Set<MessageGroup>();
    let keptCount = 0;
    let remainingTokens = this.config.maxTokens === undefined
      ? undefined
      : this.config.maxTokens - estimateTokens(systemMessages) - toolTokens;

    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (!group.retainable) continue;

      const groupTokens = estimateTokens(group.messages);
      const exceedsCount = keptCount > 0 && keptCount + group.messages.length > this.config.maxMessages;
      const exceedsTokens = remainingTokens !== undefined && keptCount > 0 && remainingTokens - groupTokens < 0;
      if (exceedsCount || exceedsTokens) break;

      kept.add(group);
      keptCount += group.messages.length;
      if (remainingTokens !== undefined) remainingTokens -= groupTokens;

      // A complete newest tool pair stays intact even if that pair itself is
      // larger than the configured window; splitting it would make the next
      // provider request invalid. The same rule applies to a newest user
      // message, whose content is never silently truncated by the compactor.
    }

    const retained: Message[] = [];
    const evicted: Message[] = [];
    for (const group of groups) {
      if (kept.has(group)) retained.push(...group.messages);
      else evicted.push(...group.messages);
    }

    // An interrupted checkpoint may contain an incomplete tool call. Never
    // feed that dangling assistant/tool fragment back to a provider.
    const ordered = [...systemMessages, ...retained];
    const newestRetained = [...groups].reverse().find(group => kept.has(group));
    const systemTokens = estimateTokens(systemMessages) + toolTokens;
    const oversizedNewestGroup = this.config.maxTokens !== undefined &&
      systemTokens <= this.config.maxTokens &&
      newestRetained !== undefined &&
      estimateTokens(newestRetained.messages) > this.config.maxTokens - systemTokens;
    let summarized = false;
    if (this.config.llm && this.config.summaryThreshold !== undefined && evicted.length > this.config.summaryThreshold) {
      try {
        const summaryInput = priorSummary ? [priorSummary, ...evicted] : evicted;
        const summaryPrompt = `Summarize the key information from this conversation. Include decisions made, code patterns discussed, file paths mentioned, user preferences, and unresolved work. Do not invent facts.\n\n${summaryInput.map(message => `${message.role}: ${(message.content ?? '').slice(0, 500)}`).join('\n')}`;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const summaryPromise = this.config.llm.complete([{ role: 'user', content: summaryPrompt }], [], controller.signal);
        const summary = await Promise.race([
          summaryPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`conversation summary timed out after ${SUMMARY_TIMEOUT_MS}ms`));
            }, SUMMARY_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (priorSummary) ordered.splice(baseSystemMessages.length, 1);
        ordered.splice(baseSystemMessages.length, 0, {
          role: 'system',
          content: `Earlier conversation summary: ${String(summary.content)}`,
        });
        summarized = true;
      } catch {
        // A failed summary must never prevent the bounded recent window.
      }
    }

    const summaryUnavailable = evicted.length > 0 && !summarized;
    const estimatedTokens = estimateTokens(ordered) + toolTokens;

    return this.remember({
      messages: ordered,
      compacted: overMessageBudget || overTokenBudget || evicted.length > 0 || ordered.length !== messages.length,
      summarized,
      summaryUnavailable,
      evictedMessages: evicted.length,
      estimatedTokens,
      overBudget: this.config.maxTokens !== undefined && estimatedTokens > this.config.maxTokens,
      oversizedNewestGroup,
    });
  }

  /** Keep a caller-provided ContextEngine aligned with the resolved provider budget. */
  configureBudget(maxTokens: number, toolsProvider?: () => ToolDefinition[]): void {
    this.config.maxTokens = Math.max(1, maxTokens);
    if (toolsProvider) this.config.toolsProvider = toolsProvider;
  }

  private remember(result: ContextCompactionResult): ContextCompactionResult {
    this.lastCompactionResult = result;
    return result;
  }

  private isCompactionSummary(message: Message): boolean {
    return message.role === 'system' && message.content.startsWith('Earlier conversation summary:');
  }

  private groupAtomicPairs(messages: Message[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let index = 0;

    while (index < messages.length) {
      const message = messages[index];
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const expectedIds = new Set(message.toolCalls.map(toolCall => toolCall.id));
        const pair: Message[] = [message];
        index++;
        while (
          index < messages.length &&
          messages[index].role === 'tool' &&
          messages[index].toolCallId &&
          expectedIds.has(messages[index].toolCallId!)
        ) {
          pair.push(messages[index]);
          index++;
        }
        const receivedIds = new Set(pair.slice(1).map(tool => tool.toolCallId));
        groups.push({ messages: pair, retainable: receivedIds.size === expectedIds.size });
        continue;
      }

      // An orphan tool result has no valid provider context without its
      // assistant tool call, so it is evicted together with other invalid
      // fragments instead of being retained as a standalone tail message.
      groups.push({ messages: [message], retainable: message.role !== 'tool' });
      index++;
    }

    return groups;
  }
}
