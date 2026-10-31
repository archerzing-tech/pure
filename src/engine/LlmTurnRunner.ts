import type { LLMAdapter, LLMChunk, Message, ToolDefinition } from '../shared/types';
import { streamWithDeadline } from './streamDeadline';

export const MAX_STREAM_RESUMES = 5;
export const STREAM_RESUME_HINT = '[system] The previous response generation was cut off by a stream timeout. Continue EXACTLY from where the last assistant message ended — do NOT repeat any already-generated content, just complete the remainder (and close any open code block).';

export const MAX_TOOL_CALL_RESUMES = 2;
export const TOOL_CALL_RESUME_HINT = '[system] Your tool call in the previous response was cut off mid-stream and was NOT executed. Re-issue the COMPLETE tool call now (full name + full JSON arguments).';

export interface LlmTurnRunnerOptions {
  llm: LLMAdapter;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs: number;
  /** First-chunk ceiling (see BudgetConfig.firstTokenTimeoutMs); default keeps
   * the historical 5-minute tolerance for parent conversations. */
  firstTokenTimeoutMs?: number;
  onChunk?: (chunk: LLMChunk) => void;
}

export async function* streamLlmTurn(options: LlmTurnRunnerOptions): AsyncGenerator<LLMChunk, void, void> {
  yield* streamWithDeadline(options.llm, options.messages, options.tools, options.signal, options.timeoutMs, options.firstTokenTimeoutMs);
}

export { runWithDeadline, streamWithDeadline } from './streamDeadline';
