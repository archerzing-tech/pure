// src/adapter/storage/MemoryStateStore.ts
// In-memory IStateStore for environments without a durable session store
// (the browser GUI). Same interface as FSStore / SQLiteStore so a caller can
// pass it to a Harness or SubagentOrchestrator interchangeably. Sub-agent
// checkpoints survive within a ChatController lifetime (per open conversation)
// and are dropped on reload — good enough to resume a sub-task after a user
// stop + continue in the same session, with zero persistence side effects.

import type { AgentLoopState, Checkpoint, IStateStore } from '../../shared/types';

interface MemorySession {
  state: AgentLoopState;
  checkpoints: Checkpoint[];
}

export class MemoryStateStore implements IStateStore {
  private sessions = new Map<string, MemorySession>();

  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null {
    const s = this.sessions.get(sessionId);
    return s ? { state: s.state, checkpoints: s.checkpoints } : null;
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { state: { messages: [], turnCount: 0 }, checkpoints: [] };
      this.sessions.set(sessionId, s);
    }
    s.checkpoints.push(checkpoint);
    s.state = checkpoint.state;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** Drop everything (session switch / tests). */
  clear(): void {
    this.sessions.clear();
  }
}
