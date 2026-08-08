// src/adapter/storage/__tests__/FSStore.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const makeStore = async () => {
  const { FSStore } = await import('../FSStore');
  const dir = mkdtempSync(join(tmpdir(), 'pure-fsstore-'));
  return { store: new FSStore(dir), dir };
};

describe('FSStore', () => {
  let dir: string;
  let store: any;

  beforeEach(async () => {
    const s = await makeStore();
    store = s.store;
    dir = s.dir;
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('returns null for unknown session', () => {
    expect(store.loadSession('nonexistent')).toBeNull();
  });

  it('saves and loads a single checkpoint', async () => {
    const cp = {
      version: 0,
      label: 'session_start',
      state: { messages: [{ role: 'system', content: 'hello' }], turnCount: 0 },
      createdAt: Date.now(),
    };

    await store.saveCheckpoint('s1', cp);
    const loaded = store.loadSession('s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.state.messages[0].content).toBe('hello');
    expect(loaded!.state.turnCount).toBe(0);
  });

  it('saves multiple checkpoints and restores latest state', async () => {
    await store.saveCheckpoint('s2', {
      version: 0, label: 'start',
      state: { messages: [{ role: 'user', content: 'v0' }], turnCount: 1 },
      createdAt: Date.now(),
    });
    await store.saveCheckpoint('s2', {
      version: 1, label: 'turn_completed',
      state: { messages: [{ role: 'user', content: 'v1' }], turnCount: 2 },
      createdAt: Date.now() + 1,
    });
    await store.saveCheckpoint('s2', {
      version: 2, label: 'turn_completed',
      state: { messages: [{ role: 'user', content: 'v2' }], turnCount: 3 },
      createdAt: Date.now() + 2,
    });

    const loaded = store.loadSession('s2');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoints).toHaveLength(3);
    expect(loaded!.state.turnCount).toBe(3);
    expect(loaded!.state.messages[0].content).toBe('v2');
  });

  it('deletes a session', async () => {
    await store.saveCheckpoint('s3', {
      version: 0, label: 'start',
      state: { messages: [], turnCount: 0 },
      createdAt: Date.now(),
    });
    expect(store.loadSession('s3')).not.toBeNull();

    await store.deleteSession('s3');
    expect(store.loadSession('s3')).toBeNull();
  });

  it('deleteSession is no-op for unknown session', async () => {
    await store.deleteSession('never_existed');
    // should not throw
  });

  it('isolates checkpoints between sessions', async () => {
    await store.saveCheckpoint('a', {
      version: 0, label: 'a', state: { messages: [{ role: 'user', content: 'aaa' }], turnCount: 1 },
      createdAt: Date.now(),
    });
    await store.saveCheckpoint('b', {
      version: 0, label: 'b', state: { messages: [{ role: 'user', content: 'bbb' }], turnCount: 1 },
      createdAt: Date.now(),
    });

    const a = store.loadSession('a');
    const b = store.loadSession('b');
    expect(a!.state.messages[0].content).toBe('aaa');
    expect(b!.state.messages[0].content).toBe('bbb');
  });

  describe('sessionId path-traversal validation', () => {
    it('rejects traversal ids on saveCheckpoint', async () => {
      const backslash = String.fromCharCode(92);
      const nul = String.fromCharCode(0);
      const evilIds = [
        '../escape', '../../etc', 'a/b', 'a' + backslash + 'b', '..%2F',
        '..' + backslash, 'sess' + nul + 'ion', '..' + nul + '/etc/passwd',
      ];
      for (const evil of evilIds) {
        await expect(store.saveCheckpoint(evil, {
          version: 0, label: 'x', state: { messages: [], turnCount: 0 }, createdAt: Date.now(),
        })).rejects.toThrow();
      }
    });

    it('rejects traversal ids on deleteSession and never touches disk outside base', async () => {
      const outside = `${dir}/../pure-escape-probe`;
      await expect(store.deleteSession('../pure-escape-probe')).rejects.toThrow();
      // The parent directory must not contain the would-be escape dir.
      expect(existsSync(outside)).toBe(false);
    });

    it('loadSession returns null for traversal ids instead of reading outside base', () => {
      expect(store.loadSession('../nonexistent')).toBeNull();
      expect(store.loadSession('/etc/passwd')).toBeNull();
    });

    it('allows valid id characters (dots, dashes, underscores)', async () => {
      const cp = {
        version: 0, label: 'start',
        state: { messages: [{ role: 'user', content: 'ok' }], turnCount: 0 },
        createdAt: Date.now(),
      };
      await store.saveCheckpoint('subagent.web_1-2', cp);
      expect(store.loadSession('subagent.web_1-2')).not.toBeNull();
    });
  });
});
