// src/evolution/__tests__/overlayGuardHost.test.ts
// P1-2 — CLI 侧 overlay 回退判定的真 fs 覆盖：runCliOverlayGuardPass 自扫
// personas、绑 node:fs IO、注入 records 判卷。临时目录跑，绝不碰 ~/.pure。
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlayGuardPaths } from '../../harness/overlayGuard';
import { runCliOverlayGuardPass } from '../overlayGuardHost';
import type { PromptObservation } from '../../shared/promptObservability';

function runRecord(startedAt: number, toolName: string, success: boolean): PromptObservation {
  return {
    type: 'agent_run',
    traceId: `t${startedAt}${toolName}${success}`,
    startedAt,
    toolCalls: [{ toolName, success, durationMs: 100 }],
  } as unknown as PromptObservation;
}

/** 造一个带 meta 的已落盘 overlay：基线 0 失败，落盘时刻 1_000。 */
function seedOverlay(pureHome: string, role: string, opts: { prevExisted?: boolean; revertedAt?: number } = {}): void {
  const paths = overlayGuardPaths(role);
  mkdirSync(join(pureHome, 'personas'), { recursive: true });
  writeFileSync(join(pureHome, paths.overlay), `overlay for ${role}\n`, 'utf8');
  writeFileSync(
    join(pureHome, paths.meta),
    `${JSON.stringify({
      version: 1,
      writtenAt: 1_000,
      prevExisted: opts.prevExisted ?? false,
      baseline: { delegations: 10, failures: 0, failureRate: 0 },
      ...(opts.revertedAt ? { revertedAt: opts.revertedAt, revertedReason: 'earlier pass' } : {}),
    }, null, 2)}\n`,
    'utf8',
  );
}

describe('runCliOverlayGuardPass', () => {
  it('no personas dir = nothing to guard, returns []', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-og-'));
    try {
      expect(await runCliOverlayGuardPass({ pureHome: home, records: [] })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('persistent regression after writing flips the meta to reverted and archives the body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-og-'));
    try {
      seedOverlay(home, 'researcher');
      // 落盘后 10 次派发全败：100% ≥ 0% + 0.2 绝对线，也过 MIN_RUNS。
      const records = Array.from({ length: 10 }, (_, i) => runRecord(1_500 + i, 'researcher', false));
      expect(await runCliOverlayGuardPass({ pureHome: home, records })).toEqual(['researcher']);
      const meta = JSON.parse(readFileSync(join(home, overlayGuardPaths('researcher').meta), 'utf8'));
      expect(meta.revertedAt).toBeGreaterThan(0);
      expect(meta.revertedReason).toContain('100%');
      // 原文归档可查，正文未被删除（可逆）。
      expect(readFileSync(join(home, overlayGuardPaths('researcher').reverted), 'utf8')).toContain('overlay for researcher');
      expect(existsSync(join(home, overlayGuardPaths('researcher').overlay))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('healthy or under-sampled roles stay untouched; already-reverted ones do not flip again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-og-'));
    try {
      seedOverlay(home, 'healthy');
      seedOverlay(home, 'sparse');
      seedOverlay(home, 'already', { revertedAt: 2_000 });
      const records = [
        ...Array.from({ length: 10 }, (_, i) => runRecord(1_500 + i, 'healthy', true)), // 0% 优于基线
        ...Array.from({ length: 2 }, (_, i) => runRecord(1_500 + i, 'sparse', false)), // 2 次 < MIN_RUNS
        ...Array.from({ length: 10 }, (_, i) => runRecord(1_500 + i, 'already', false)), // 已回退 ⇒ 不横跳
      ];
      expect(await runCliOverlayGuardPass({ pureHome: home, records })).toEqual([]);
      const already = JSON.parse(readFileSync(join(home, overlayGuardPaths('already').meta), 'utf8'));
      expect(already.revertedReason).toBe('earlier pass');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
