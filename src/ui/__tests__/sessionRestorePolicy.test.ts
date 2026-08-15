import { describe, expect, it } from 'bun:test';
import { SESSION_RESTORE_BATCH_SIZE, shouldYieldAfterRestoreBlock } from '../sessionRestorePolicy';

describe('session restore batching', () => {
  it('yields only at the configured batch boundary', () => {
    expect(shouldYieldAfterRestoreBlock(SESSION_RESTORE_BATCH_SIZE - 1)).toBe(false);
    expect(shouldYieldAfterRestoreBlock(SESSION_RESTORE_BATCH_SIZE)).toBe(true);
    expect(SESSION_RESTORE_BATCH_SIZE).toBeGreaterThan(1);
  });
});
