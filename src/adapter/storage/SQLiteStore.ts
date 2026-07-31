// src/adapter/storage/SQLiteStore.ts
// v0.4 — SQLite session persistence using bun:sqlite

import { Database } from 'bun:sqlite';
import type { IStateStore, Checkpoint, AgentLoopState } from '../../shared/types';

export class SQLiteStore implements IStateStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        current_index INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        label TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, version),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
    `);
  }

  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null {
    try {
      const rows = this.db.prepare(
        `SELECT data FROM checkpoints WHERE session_id = ? ORDER BY version ASC`
      ).all(sessionId) as Array<{ data: string }>;

      if (rows.length === 0) return null;

      const checkpoints: Checkpoint[] = rows.map(r => JSON.parse(r.data));
      const latest = checkpoints[checkpoints.length - 1];
      return { state: latest.state, checkpoints };
    } catch {
      return null;
    }
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT OR REPLACE INTO sessions (session_id, current_index, created_at, updated_at)
         VALUES (?, ?, COALESCE((SELECT created_at FROM sessions WHERE session_id = ?), ?), ?)`,
        [sessionId, checkpoint.version, sessionId, now, now]
      );
      this.db.run(
        `INSERT OR REPLACE INTO checkpoints (session_id, version, label, data, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [sessionId, checkpoint.version, checkpoint.label, JSON.stringify(checkpoint), now]
      );
    })();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run('DELETE FROM checkpoints WHERE session_id = ?', [sessionId]);
      this.db.run('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
    })();
  }
}
