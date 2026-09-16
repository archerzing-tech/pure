// src/shared/__tests__/userHookApprovals.test.ts
// 2.3 — the "always allow" cache for user hooks: keyed by exact command text,
// tolerant of a missing/corrupt store, and never trusting malformed records.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookApprovalKey, loadHookApprovals } from '../userHookApprovals';

/** approve() persists fire-and-forget; give the write a moment to land. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe('hookApprovalKey', () => {
  it('keys on the exact command text — any edit invalidates the approval', () => {
    expect(hookApprovalKey('bun run lint')).toBe(hookApprovalKey('bun run lint'));
    expect(hookApprovalKey('bun run lint')).not.toBe(hookApprovalKey('bun run lint '));
    expect(hookApprovalKey('bun run lint')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadHookApprovals', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-hook-approvals-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty, and an approval persists for stores loaded later', async () => {
    const first = await loadHookApprovals(dir);
    expect(first.isApproved('bun run lint')).toBe(false);
    first.approve('bun run lint');
    await flush();

    const second = await loadHookApprovals(dir);
    expect(second.isApproved('bun run lint')).toBe(true);
    expect(second.isApproved('bun run lint ')).toBe(false);
  });

  it('tolerates a corrupt store file and creates a missing directory on save', async () => {
    writeFileSync(join(dir, 'hooks-approved.json'), '{ definitely not json');
    const corrupt = await loadHookApprovals(dir);
    expect(corrupt.isApproved('x')).toBe(false);

    const fresh = join(dir, 'nested-missing');
    const store = await loadHookApprovals(fresh);
    expect(store.isApproved('x')).toBe(false);
    store.approve('x');
    await flush();

    const reread = await loadHookApprovals(fresh);
    expect(reread.isApproved('x')).toBe(true);
  });

  it('drops malformed records under a matching key instead of trusting them', async () => {
    const key = hookApprovalKey('rm -rf /');
    writeFileSync(
      join(dir, 'hooks-approved.json'),
      JSON.stringify({ version: 1, approvals: { [key]: { command: 42, approvedAt: 'not-a-number' } } }),
    );
    const store = await loadHookApprovals(dir);
    expect(store.isApproved('rm -rf /')).toBe(false);
  });
});
