// src/adapter/storage/__tests__/SQLiteStore.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

const makeStore = async () => {
  const { SQLiteStore } = await import('../SQLiteStore');
  const store = new SQLiteStore(':memory:');
  return { store };
};

describe('SQLiteStore', () => {
  let store: any;

  beforeEach(async () => {
    const s = await makeStore();
    store = s.store;
  });

  it('returns null for unknown session', () => {
    expect(store.loadSession('nonexistent')).toBeNull();
  });

  it('saves and loads a checkpoint', async () => {
    await store.saveCheckpoint('s1', {
      version: 0, label: 'session_start',
      state: { messages: [{ role: 'system', content: 'hi' }], turnCount: 0 },
      createdAt: Date.now(),
    });

    const loaded = store.loadSession('s1');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.state.messages[0].content).toBe('hi');
  });

  it('returns correct latest state from multiple checkpoints', async () => {
    await store.saveCheckpoint('s2', { version: 0, label: 'start', state: { messages: [{ role: 'user', content: 'v0' }], turnCount: 1 }, createdAt: 100 });
    await store.saveCheckpoint('s2', { version: 1, label: 'mid', state: { messages: [{ role: 'user', content: 'v1' }], turnCount: 2 }, createdAt: 200 });

    const loaded = store.loadSession('s2');
    expect(loaded!.state.turnCount).toBe(2);
    expect(loaded!.state.messages[0].content).toBe('v1');
  });

  it('deletes a session completely', async () => {
    await store.saveCheckpoint('s3', { version: 0, label: 'start', state: { messages: [], turnCount: 0 }, createdAt: 0 });
    expect(store.loadSession('s3')).not.toBeNull();

    await store.deleteSession('s3');
    expect(store.loadSession('s3')).toBeNull();
  });

  it('isolates sessions', async () => {
    await store.saveCheckpoint('a', { version: 0, label: 'a', state: { messages: [{ role: 'user', content: 'aaa' }], turnCount: 1 }, createdAt: 0 });
    await store.saveCheckpoint('b', { version: 0, label: 'b', state: { messages: [{ role: 'user', content: 'bbb' }], turnCount: 1 }, createdAt: 0 });

    expect(store.loadSession('a')!.state.messages[0].content).toBe('aaa');
    expect(store.loadSession('b')!.state.messages[0].content).toBe('bbb');
  });

  it('overwrites checkpoint with same version', async () => {
    await store.saveCheckpoint('s4', { version: 0, label: 'old', state: { messages: [{ role: 'user', content: 'old' }], turnCount: 0 }, createdAt: 0 });
    await store.saveCheckpoint('s4', { version: 0, label: 'new', state: { messages: [{ role: 'user', content: 'new' }], turnCount: 0 }, createdAt: 1 });

    const loaded = store.loadSession('s4');
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.state.messages[0].content).toBe('new');
  });
});
