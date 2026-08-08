// src/adapter/storage/FSStore.ts
// v0.4 — file-based JSON session persistence under ~/.pure/sessions/

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { IStateStore, Checkpoint, AgentLoopState } from '../../shared/types';

// Session ids flow into filesystem paths, so anything that could escape the
// sessions base dir — path separators, `..`, null bytes — is rejected before
// any read/write/delete. Legit ids are `session_<ts>` (CLI/GUI), subagent
// ids (`subagent_<name>_<ts>`), or user-supplied `--resume` handles, all of
// which match [A-Za-z0-9._-].
const VALID_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function assertValidSessionId(sessionId: string): void {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid sessionId '${sessionId}' — path traversal is not allowed`);
  }
}

export class FSStore implements IStateStore {
  private basePath: string;

  constructor(basePath = `${process.env.HOME || homedir()}/.pure/sessions`) {
    this.basePath = basePath;
  }

  private sessionDir(sessionId: string): string {
    assertValidSessionId(sessionId);
    return `${this.basePath}/${sessionId}`;
  }

  private checkpointsDir(sessionId: string): string {
    return `${this.sessionDir(sessionId)}/checkpoints`;
  }

  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null {
    try {
      const metaPath = `${this.sessionDir(sessionId)}/meta.json`;
      if (!existsSync(metaPath)) return null;

      const cpDir = this.checkpointsDir(sessionId);
      if (!existsSync(cpDir)) return null;

      const files = readdirSync(cpDir).filter(f => f.endsWith('.json'));
      const checkpoints: Checkpoint[] = files.map(f =>
        JSON.parse(readFileSync(`${cpDir}/${f}`, 'utf-8'))
      );

      checkpoints.sort((a, b) => a.version - b.version);

      const latestCp = checkpoints[checkpoints.length - 1];
      if (!latestCp) return null;

      return { state: latestCp.state, checkpoints };
    } catch {
      return null;
    }
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const dir = this.checkpointsDir(sessionId);
    const v = String(checkpoint.version).padStart(3, '0');

    mkdirSync(dir, { recursive: true });

    writeFileSync(`${dir}/v${v}.json`, JSON.stringify(checkpoint, null, 2));

    const metaPath = `${this.sessionDir(sessionId)}/meta.json`;
    let meta: any = { currentIndex: 0, createdAt: Date.now() };
    if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    }
    meta.currentIndex = Math.max(meta.currentIndex, checkpoint.version);
    meta.updatedAt = Date.now();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
