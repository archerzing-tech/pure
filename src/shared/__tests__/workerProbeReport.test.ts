// src/shared/__tests__/workerProbeReport.test.ts
// 探针报告面的锁：日志格式、坏行容错、按平台取最新、表格列。
// 这些是 UI 与 CLI 的唯一契约，字段改名必须在这里先体现。

import { describe, expect, test } from 'bun:test';
import {
  buildProbeLogLine,
  formatProbeTable,
  latestPerPlatform,
  parseProbeLines,
  platformLabelFromUa,
  type WorkerProbeReport,
} from '../workerProbeReport';

function report(overrides: Partial<WorkerProbeReport> = {}): WorkerProbeReport {
  return {
    ts: 1_700_000_000_000,
    platform: 'macos',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
    visibility: 'visible',
    hardwareConcurrency: 8,
    checkpoint: { messages: 200, bytes: 420_000, source: 'synthetic' },
    workers: [
      {
        label: 'asset-classic',
        ok: true,
        loadMs: 35,
        rttP50Ms: 0.2,
        rttP95Ms: 0.4,
        rttAvgMs: 0.18,
        oneMbMs: 3.1,
        oneMbAvgMs: 3.0,
        eventMs: 0.5,
        eventAvgMs: 0.42,
        checkpointMs: 8.7,
        checkpointAvgMs: 8.5,
      },
      { label: 'asset-module', ok: false, error: 'SecurityError: module worker blocked' },
    ],
    timer: {
      beatMs: 50,
      p50DriftMs: 1.2,
      maxDriftMs: 4,
      visibility: 'visible',
      background: { beatMs: 50, p50DriftMs: 120, maxDriftMs: 400, visibility: 'hidden' },
    },
    ...overrides,
  };
}

describe('platformLabelFromUa', () => {
  test('三个平台与兜底', () => {
    expect(platformLabelFromUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformLabelFromUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos');
    expect(platformLabelFromUa('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(platformLabelFromUa('something-else')).toBe('other');
  });
});

describe('parseProbeLines', () => {
  test('只收 worker_probe，坏行与其他 kind 静默跳过', () => {
    const raw = [
      'not json',
      JSON.stringify({ ts: 1, kind: 'boot', ms: 120 }),
      buildProbeLogLine(report()),
      '',
    ].join('\n');
    const reports = parseProbeLines(raw);
    expect(reports).toHaveLength(1);
    expect(reports[0].platform).toBe('macos');
    expect(reports[0].workers[0].oneMbMs).toBe(3.1);
    expect(reports[0].workers[0].oneMbAvgMs).toBe(3.0);
    expect(reports[0].timer.background?.p50DriftMs).toBe(120);
    expect(reports[0].workers[1].ok).toBe(false);
  });

  test('缺字段的探针行保留，失败项不丢', () => {
    const raw = JSON.stringify({
      ts: 2,
      kind: 'worker_probe',
      platform: 'windows',
      workers: [{ label: 'asset-classic', ok: false, error: 'load failed' }],
    });
    const [parsed] = parseProbeLines(raw);
    expect(parsed.checkpoint).toEqual({ messages: 0, bytes: 0, source: 'synthetic' });
    expect(parsed.timer.beatMs).toBe(0);
    expect(parsed.workers[0].error).toBe('load failed');
  });

  test('没有 workers 数组的行不是探针结果', () => {
    expect(parseProbeLines(JSON.stringify({ kind: 'worker_probe', platform: 'macos' }))).toEqual([]);
  });
});

describe('latestPerPlatform', () => {
  test('每个平台只留 ts 最大的一份，并按平台排序', () => {
    const oldMac = report({ ts: 100 });
    const newMac = report({ ts: 300 });
    const windows = report({ ts: 200, platform: 'windows' });
    const latest = latestPerPlatform([oldMac, windows, newMac]);
    expect(latest.map((item) => item.platform)).toEqual(['macos', 'windows']);
    expect(latest[0].ts).toBe(300);
  });
});

describe('formatProbeTable', () => {
  test('成功行带数字，失败行带 FAIL 与错误，上下文标 synth', () => {
    const table = formatProbeTable([report()]);
    expect(table).toContain('asset-classic');
    expect(table).toContain('35ms');
    expect(table).toContain('FAIL');
    expect(table).toContain('module worker blocked');
    expect(table).toContain('200 msg');
    expect(table).toContain('(synth)');
    expect(table).toContain('timer-bg');
    expect(table).toContain('120ms');
  });

  test('空输入给出可读提示而不是空串', () => {
    expect(formatProbeTable([])).toContain('还没有');
  });
});
