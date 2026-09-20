import type { LLMAdapter, LLMChunk, Message, ToolDefinition } from '../shared/types';

const FIRST_TOKEN_TIMEOUT_MS = 300_000;

function makeLifecycleError(name: 'AbortError' | 'TimeoutError', message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export { FIRST_TOKEN_TIMEOUT_MS };

export function runWithDeadline<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(makeLifecycleError('AbortError', `${label} aborted`)));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      onTimeout?.();
      // Human units: "180000ms" read like a malfunction ("180000 SECONDS?!")
      // when it means "3 minutes" — which for generative work is often just
      // "was still working".
      const human = timeoutMs >= 60_000
        ? `${Math.round((timeoutMs / 60_000) * 10) / 10}m`
        : `${Math.round(timeoutMs / 1000)}s`;
      finish(() => reject(makeLifecycleError('TimeoutError', `${label} timed out after ${human}`)));
    }, Math.max(1, timeoutMs));
    Promise.resolve().then(operation).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

export async function* streamWithDeadline(
  llm: LLMAdapter,
  messages: Message[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  firstTokenTimeoutMs: number = FIRST_TOKEN_TIMEOUT_MS,
): AsyncGenerator<LLMChunk, void, void> {
  const linkedController = new AbortController();
  const forwardAbort = (): void => linkedController.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const iterator = llm.stream(messages, tools, linkedController.signal)[Symbol.asyncIterator]();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let firstChunk = true;
  try {
    while (true) {
      const idleCap = firstChunk ? firstTokenTimeoutMs : 120_000;
      const remaining = Math.min(deadline - Date.now(), idleCap);
      if (remaining <= 0) {
        linkedController.abort();
        throw makeLifecycleError('TimeoutError', firstChunk
          ? 'LLM stream exceeded its first-token deadline'
          : 'LLM stream exceeded its deadline');
      }
      const next = await runWithDeadline(
        () => iterator.next(),
        signal,
        remaining,
        // The label rides into the TimeoutError text: a stall BEFORE the first
        // chunk is a provider problem (queue/dead endpoint) and must read as
        // one — "stream read timed out after 0s" sent users hunting for a
        // network bug that isn't theirs.
        firstChunk ? 'LLM stream first token' : 'LLM stream read',
        () => linkedController.abort(),
      );
      if (next.done) return;
      firstChunk = false;
      yield next.value;
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
    linkedController.abort();
    void iterator.return?.();
  }
}
