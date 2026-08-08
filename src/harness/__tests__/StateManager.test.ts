// src/harness/__tests__/StateManager.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateManager } from '../StateManager';
import { FSStore } from '../../adapter/storage/FSStore';
import type { Message } from '../../shared/types';

describe('StateManager', () => {
  let dir: string;
  let store: FSStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-sm-'));
    store = new FSStore(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('starts fresh for new session', async () => {
    const sm = new StateManager(store, 'fresh1');
    expect(sm.loadLatest()).toBeNull();
    expect(sm.getLatestState()).toBeNull();
  });

  it('saves and restores checkpoints', async () => {
    const sm = new StateManager(store, 's1');
    const msgs: Message[] = [{ role: 'system', content: 'test' }];

    await sm.saveCheckpoint('turn_completed', msgs, 5);
    expect(sm.getCheckpointCount()).toBe(1);

    const state = sm.getLatestState();
    expect(state).not.toBeNull();
    expect(state!.turnCount).toBe(5);
    expect(state!.messages[0].content).toBe('test');
  });

  it('loads from persisted store', async () => {
    // First session
    const sm1 = new StateManager(store, 's2');
    await sm1.saveCheckpoint('turn_completed', [{ role: 'user', content: 'persisted' }], 3);

    // Second session (same ID, new StateManager)
    const sm2 = new StateManager(store, 's2');
    const state = sm2.loadLatest();
    expect(state).not.toBeNull();
    expect(state!.messages[0].content).toBe('persisted');
    expect(state!.turnCount).toBe(3);
  });

  it('returns null for never-saved session', () => {
    const sm = new StateManager(store, 'ghost');
    expect(sm.loadLatest()).toBeNull();
  });

  it('getLatestState returns last checkpoint', async () => {
    const sm = new StateManager(store, 's3');
    await sm.saveCheckpoint('start', [{ role: 'user', content: 'v1' }], 1);
    await sm.saveCheckpoint('mid', [{ role: 'user', content: 'v2' }], 2);
    await sm.saveCheckpoint('latest', [{ role: 'user', content: 'v3' }], 3);

    expect(sm.getLatestState()!.messages[0].content).toBe('v3');
    expect(sm.getCheckpointCount()).toBe(3);
  });
});
