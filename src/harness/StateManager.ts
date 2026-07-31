// src/harness/StateManager.ts
// v0.4 — checkpoint-based session persistence at key state transitions.

import type { IStateStore, Message, Checkpoint } from '../shared/types';

export class StateManager {
  private store: IStateStore;
  private sessionId: string;
  private checkpoints: Checkpoint[] = [];

  constructor(store: IStateStore, sessionId: string) {
    this.store = store;
    this.sessionId = sessionId;
  }

  loadLatest(): { messages: Message[]; turnCount: number } | null {
    const saved = this.store.loadSession(this.sessionId);
    if (saved) {
      this.checkpoints = saved.checkpoints;
      return this.getLatestState();
    }
    return null;
  }

  async saveCheckpoint(label: string, messages: Message[], turnCount = 1): Promise<void> {
    const cp: Checkpoint = {
      version: this.checkpoints.length,
      label,
      state: { messages, turnCount },
      createdAt: Date.now(),
    };
    this.checkpoints.push(cp);
    await this.store.saveCheckpoint(this.sessionId, cp);
  }

  getLatestState(): { messages: Message[]; turnCount: number } | null {
    const latest = this.checkpoints[this.checkpoints.length - 1];
    if (!latest) return null;
    return { messages: latest.state.messages, turnCount: latest.state.turnCount };
  }

  getCheckpointCount(): number {
    return this.checkpoints.length;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
