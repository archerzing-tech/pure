// src/harness/StreamManager.ts
// v0.2 — buffers rapid TokenDelta events into larger chunks for smoother terminal output.

import type { EngineEvent } from '../shared/types';
import { sanitizeForTerminal } from '../termwidth';

export interface StreamManagerConfig {
  flushIntervalMs?: number;
  maxBufferSize?: number;
}

export class StreamManager {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private onFlush: (chunk: string) => void;
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private active = false;

  constructor(onFlush: (chunk: string) => void, config?: StreamManagerConfig) {
    this.onFlush = onFlush;
    this.flushIntervalMs = config?.flushIntervalMs ?? 16;
    this.maxBufferSize = config?.maxBufferSize ?? 200;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  stop() {
    this.active = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  feed(event: EngineEvent) {
    if (event.type !== 'TokenDelta') return;
    if (event.payload.isToolCall) return;
    // Sanitize each delta BEFORE it enters the buffer (mirrors the thinking-
    // line sanitize in cli.ts): a model answer occasionally leaks ANSI escape
    // sequences / control bytes, and written raw they corrupt the terminal
    // (cursor moves, color bleed, line overwrites). Per-delta sanitizing also
    // stays safe when an escape is split across tokens — the lone ESC byte is
    // caught by the C0 strip immediately, so the following `[31m` can only
    // ever reach the terminal as literal text.
    this.buffer.push(sanitizeForTerminal(event.payload.content));
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  private flush() {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.onFlush(chunk);
  }
}
