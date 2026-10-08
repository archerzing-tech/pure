// P1-2 — overlay 回退护栏的纯核覆盖：快照落盘、meta 形状闸、装载决策、
// 判卷阈值、周期 pass 的回退与豁免。IO 全内存桩。
import { describe, expect, it } from 'bun:test';
import {
  loadOverlayText,
  overlayGuardPaths,
  parseOverlayGuardMeta,
  reinstateOverlayMeta,
  roleStatsSince,
  runOverlayGuardPass,
  shouldRevertOverlay,
  writeOverlayGuardedly,
  type OverlayGuardIo,
  type OverlayGuardMeta,
} from '../overlayGuard';
import type { PromptObservation } from '../../shared/promptObservability';

function meta(partial: Partial<OverlayGuardMeta> = {}): OverlayGuardMeta {
  return {
    version: 1,
    writtenAt: 1_000,
    prevExisted: false,
    baseline: { delegations: 10, failures: 2, failureRate: 20 },
    ...partial,
  };
}

function memIo(files: Record<string, string> = {}): OverlayGuardIo & { files: Record<string, string> } {
  return {
    files,
    readFile: async (path) => files[path],
    writeFile: async (path, content) => { files[path] = content; },
  };
}

function runRecord(startedAt: number, toolName: string, success: boolean): PromptObservation {
  return {
    type: 'agent_run',
    traceId: `t${startedAt}${toolName}${success}`,
    startedAt,
    toolCalls: [{ toolName, success, durationMs: 100 }],
  } as unknown as PromptObservation;
}

describe('overlayGuard meta + load decision', () => {
  it('parses well-formed meta; anything else is a handwritten overlay (exempt)', () => {
    expect(parseOverlayGuardMeta(undefined)).toBeUndefined();
    expect(parseOverlayGuardMeta('not json')).toBeUndefined();
    expect(parseOverlayGuardMeta(JSON.stringify({ version: 2, writtenAt: 1, prevExisted: false }))).toBeUndefined();
    expect(parseOverlayGuardMeta(JSON.stringify(meta()))).toBeDefined();
  });

  it('loads the overlay text normally when no meta or not reverted', () => {
    expect(loadOverlayText(undefined, 'overlay', 'bak')).toBe('overlay');
    expect(loadOverlayText(meta(), 'overlay', 'bak')).toBe('overlay');
  });

  it('a reverted overlay falls back to the previous version, or to base when none existed', () => {
    expect(loadOverlayText(meta({ revertedAt: 5_000, prevExisted: true }), 'overlay', 'prev text')).toBe('prev text');
    expect(loadOverlayText(meta({ revertedAt: 5_000, prevExisted: false }), 'overlay', undefined)).toBeUndefined();
  });
});

describe('shouldRevertOverlay thresholds', () => {
  it('does not decide below the minimum runs', () => {
    expect(shouldRevertOverlay(meta(), { delegations: 7, failures: 7 }).revert).toBe(false);
  });

  it('reverts on absolute + relative worsening', () => {
    // 基线 20%：40% 恶化 = +0.2 且 2 倍 ⇒ 回退。
    expect(shouldRevertOverlay(meta(), { delegations: 10, failures: 4 }).revert).toBe(true);
  });

  it('relative guard blocks a small-base jump that only clears the delta', () => {
    // 基线 20%、35% = +0.15 未达 delta ⇒ 不动；45% = +0.25 且 2.25x ⇒ 回退。
    expect(shouldRevertOverlay(meta(), { delegations: 20, failures: 7 }).revert).toBe(false);
    expect(shouldRevertOverlay(meta(), { delegations: 20, failures: 9 }).revert).toBe(true);
  });

  it('zero baseline only needs the absolute delta', () => {
    expect(shouldRevertOverlay(meta({ baseline: { delegations: 20, failures: 0, failureRate: 0 } }), { delegations: 8, failures: 2 }).revert).toBe(true);
    expect(shouldRevertOverlay(meta({ baseline: { delegations: 20, failures: 0, failureRate: 0 } }), { delegations: 8, failures: 1 }).revert).toBe(false);
  });

  it('never double-reverts', () => {
    expect(shouldRevertOverlay(meta({ revertedAt: 5_000 }), { delegations: 50, failures: 50 }).revert).toBe(false);
  });
});

describe('writeOverlayGuardedly + runOverlayGuardPass', () => {
  it('snapshots the previous overlay and baseline at write time; second write refreshes the snapshot', async () => {
    const io = memIo({ [overlayGuardPaths('researcher').overlay]: 'old overlay' });
    await writeOverlayGuardedly(io, 'researcher', 'new overlay', { delegations: 151, failures: 8, failureRate: 5.3 }, 2_000);
    expect(io.files[overlayGuardPaths('researcher').bak]).toBe('old overlay');
    const written = parseOverlayGuardMeta(io.files[overlayGuardPaths('researcher').meta])!;
    expect(written.prevExisted).toBe(true);
    expect(written.writtenAt).toBe(2_000);
    expect(written.baseline.failureRate).toBe(5.3);

    await writeOverlayGuardedly(io, 'researcher', 'newer overlay', { delegations: 9, failures: 3, failureRate: 33.3 }, 3_000);
    expect(io.files[overlayGuardPaths('researcher').bak]?.trim()).toBe('new overlay'); // 前版快照跟着推进
  });

  it('the periodic pass reverts a regressed overlay: archives it and stamps the meta', async () => {
    const io = memIo();
    await writeOverlayGuardedly(io, 'researcher', 'risky overlay', { delegations: 10, failures: 1, failureRate: 10 }, 1_000);
    // 落盘后：10 派发 5 失败（50%，+0.4 且 5x）⇒ 回退；窗口前的记录不计入。
    const records = [
      runRecord(500, 'researcher', true),   // 窗口前
      runRecord(1_100, 'researcher', false),
      ...Array.from({ length: 9 }, (_, i) => runRecord(1_200 + i, 'researcher', i < 4)),
      runRecord(1_300, 'code_reviewer', false), // 别的角色不串门
    ];
    const report = await runOverlayGuardPass(io, ['researcher'], records, 5_000);
    expect(report.reverted).toEqual(['researcher']);
    const stamped = parseOverlayGuardMeta(io.files[overlayGuardPaths('researcher').meta])!;
    expect(stamped.revertedAt).toBe(5_000);
    expect(stamped.revertedReason).toContain('60%');
    expect(io.files[overlayGuardPaths('researcher').reverted]).toContain('risky overlay');
    // 装载侧从此回到 base（首落盘无前版）。
    expect(loadOverlayText(stamped, io.files[overlayGuardPaths('researcher').overlay], io.files[overlayGuardPaths('researcher').bak])).toBeUndefined();
  });

  it('leaves healthy overlays and handwritten files (no meta) untouched', async () => {
    const io = memIo({
      [overlayGuardPaths('researcher').overlay]: 'handwritten overlay', // 无 meta ⇒ 豁免
    });
    await writeOverlayGuardedly(io, 'code_reviewer', 'fine overlay', { delegations: 10, failures: 2, failureRate: 20 }, 1_000);
    const records = Array.from({ length: 10 }, (_, i) => runRecord(1_500 + i, 'code_reviewer', i < 9)); // 10% 优于基线
    const report = await runOverlayGuardPass(io, ['researcher', 'code_reviewer'], records, 5_000);
    expect(report.reverted).toEqual([]);
    expect(io.files[overlayGuardPaths('researcher').meta]).toBeUndefined();
  });
});

describe('roleStatsSince window', () => {
  it('counts only post-window delegations of that role', () => {
    const records = [
      runRecord(900, 'researcher', true),
      runRecord(1_000, 'researcher', false), // writtenAt 当刻计入（>= 窗口）
      runRecord(1_001, 'researcher', false),
      runRecord(1_002, 'researcher', true),
      runRecord(1_003, 'code_reviewer', false),
    ];
    expect(roleStatsSince(records, 'researcher', 1_000)).toEqual({ delegations: 3, failures: 2 });
  });
});

describe('reinstateOverlayMeta（用户触发的恢复）', () => {
  it('strips the revert markers so loading goes back to the overlay body', () => {
    const reinstated = reinstateOverlayMeta(meta({ revertedAt: 5_000, prevExisted: true, revertedReason: '回归' }));
    expect(reinstated.revertedAt).toBeUndefined();
    expect(reinstated.revertedReason).toBeUndefined();
    // 装载决策随之反转：回退态装前版，恢复态装正文。
    expect(loadOverlayText(meta({ revertedAt: 5_000, prevExisted: true }), 'overlay', 'prev')).toBe('prev');
    expect(loadOverlayText(reinstated, 'overlay', 'prev')).toBe('overlay');
  });

  it('is idempotent for a meta that was never reverted', () => {
    const plain = meta();
    expect(reinstateOverlayMeta(plain)).toEqual(plain);
  });
});

describe('loadOverlayText 防陈旧 bak（prevExisted:false 时盘上可能有上一世的 .bak）', () => {
  it('ignores a stale .bak when the overlay was written without a previous version', () => {
    // 变异「丢 prevExisted 判断、直接回 bakText」在此红：回退态无前版必须回 base。
    expect(loadOverlayText(meta({ revertedAt: 5_000, prevExisted: false }), 'overlay', 'stale bak from an earlier life')).toBeUndefined();
  });
});
