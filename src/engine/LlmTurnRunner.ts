import type { LLMAdapter, LLMChunk, Message, ToolCall, ToolDefinition, TokenUsage } from '../shared/types';
import { mergeTokenUsage } from '../shared/usage';
import { streamWithDeadline } from './streamDeadline';

export const MAX_STREAM_RESUMES = 2;
export const STREAM_RESUME_HINT = '[system] The previous response generation was cut off by a stream timeout. Continue EXACTLY from where the last assistant message ended — do NOT repeat any already-generated content, just complete the remainder (and close any open code block).';

export interface LlmTurnResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  sawToolCall: boolean;
  sawDone: boolean;
  truncated: boolean;
  usage?: TokenUsage;
}

export interface LlmTurnRunnerOptions {
  llm: LLMAdapter;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  onChunk?: (chunk: LLMChunk) => void;
}

function contentLooksTruncated(text: string): boolean {
  return (text.match(/```/g) ?? []).length % 2 === 1;
}

export async function* streamLlmTurn(options: LlmTurnRunnerOptions): AsyncGenerator<LLMChunk, void, void> {
  yield* streamWithDeadline(options.llm, options.messages, options.tools, options.signal, options.timeoutMs);
}

export async function runLlmTurn(options: LlmTurnRunnerOptions): Promise<LlmTurnResult> {
  let content = '';
  let reasoning = '';
  let toolCalls: ToolCall[] = [];
  let sawToolCall = false;
  let sawDone = false;
  let usage: TokenUsage | undefined;

  for await (const chunk of streamLlmTurn(options)) {
    options.onChunk?.(chunk);
    switch (chunk.type) {
      case 'content':
        content += chunk.content;
        break;
      case 'reasoning':
        reasoning += chunk.content;
        break;
      case 'tool_call_delta':
      case 'tool_call':
        sawToolCall = true;
        break;
      case 'usage':
        usage = mergeTokenUsage(usage, chunk.usage);
        break;
      case 'done':
        content = chunk.content || content;
        toolCalls = chunk.toolCalls;
        sawDone = true;
        if (toolCalls.length > 0) sawToolCall = true;
        break;
    }
  }

  return {
    content,
    reasoning,
    toolCalls,
    sawToolCall,
    sawDone,
    truncated: (sawDone && !sawToolCall && content.length > 0 && contentLooksTruncated(content))
      || (!sawDone && !sawToolCall && content.length > 0),
    usage,
  };
}

export { runWithDeadline, streamWithDeadline } from './streamDeadline';
