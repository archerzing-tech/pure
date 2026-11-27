// src/shared/workerProbeReport.ts
// P0-3（engine-worker-migration 落地计划）— 双平台探针的报告面。
//
// UI 侧只负责测量并写一行 JSON；CLI 侧只负责读日志、按平台取最新、打印表格。
// 两侧共用这里的类型与纯函数，避免「脚本读的字段和探针写的字段」漂移。
//
// 日志行形状：{ ts, kind: 'worker_probe', platform, ua, visibility, workers[], ... }
// 走 gui_perf.log（与 boot/stream/settle 同文件），不混进错误台账。

export type ProbePlatform = 'windows' | 'macos' | 'linux' | 'other';

export interface WorkerProbeSample {
  /** asset-classic / asset-module / blob-classic / blob-module */
  label: string;
  ok: boolean;
  /** new Worker() → 收到 ready 的墙钟。 */
  loadMs?: number;
  /** 小消息 ping-pong 的 p50/p95（WKWebView 会把单次 now() 钳到 1ms，p50 仅作分布参考）。 */
  rttP50Ms?: number;
  rttP95Ms?: number;
  /** 整段总耗时 / 轮数：不受单次 now() 精度钳制的平均值，矩阵以此为准。 */
  rttAvgMs?: number;
  /** 1MB 字符串单向克隆 + worker 回执。 */
  oneMbMs?: number;
  oneMbAvgMs?: number;
  /** 单条 EngineEvent（50KB 内容）克隆。 */
  eventMs?: number;
  eventAvgMs?: number;
  /** TurnCheckpoint 形状 { messages } 的克隆。 */
  checkpointMs?: number;
  checkpointAvgMs?: number;
  error?: string;
}

export interface WorkerProbeTimer {
  beatMs: number;
  p50DriftMs: number;
  maxDriftMs: number;
  visibility: string;
  /** 最小化后测的一轮；拿不到窗口 API 时缺省。 */
  background?: {
    beatMs: number;
    p50DriftMs: number;
    maxDriftMs: number;
    visibility: string;
    error?: string;
  };
}

export interface WorkerProbeReport {
  ts: number;
  platform: ProbePlatform;
  ua: string;
  visibility: string;
  hardwareConcurrency?: number;
  checkpoint: {
    messages: number;
    bytes: number;
    source: 'session' | 'synthetic';
  };
  workers: WorkerProbeSample[];
  timer: WorkerProbeTimer;
}

export function platformLabelFromUa(ua: string): ProbePlatform {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function buildProbeLogLine(report: WorkerProbeReport): string {
  return JSON.stringify({ kind: 'worker_probe', ...report });
}

/**
 * 容错解析：坏行跳过、别的 kind 跳过、缺字段的探针行也保留（用默认值），
 * 因为「加载失败」本身就是要记录的结果。旧日志永远不该让汇总脚本崩。
 */
export function parseProbeLines(raw: string): WorkerProbeReport[] {
  const out: WorkerProbeReport[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.kind !== 'worker_probe') continue;
    if (typeof obj.platform !== 'string' || !Array.isArray(obj.workers)) continue;
    const checkpoint = (obj.checkpoint ?? {}) as Record<string, unknown>;
    const timer = (obj.timer ?? {}) as Record<string, unknown>;
    const workers = (obj.workers as unknown[])
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        label: typeof item.label === 'string' ? item.label : 'unknown',
        ok: item.ok === true,
        ...(typeof item.loadMs === 'number' ? { loadMs: item.loadMs } : {}),
        ...(typeof item.rttP50Ms === 'number' ? { rttP50Ms: item.rttP50Ms } : {}),
        ...(typeof item.rttP95Ms === 'number' ? { rttP95Ms: item.rttP95Ms } : {}),
        ...(typeof item.rttAvgMs === 'number' ? { rttAvgMs: item.rttAvgMs } : {}),
        ...(typeof item.oneMbMs === 'number' ? { oneMbMs: item.oneMbMs } : {}),
        ...(typeof item.oneMbAvgMs === 'number' ? { oneMbAvgMs: item.oneMbAvgMs } : {}),
        ...(typeof item.eventMs === 'number' ? { eventMs: item.eventMs } : {}),
        ...(typeof item.eventAvgMs === 'number' ? { eventAvgMs: item.eventAvgMs } : {}),
        ...(typeof item.checkpointMs === 'number' ? { checkpointMs: item.checkpointMs } : {}),
        ...(typeof item.checkpointAvgMs === 'number' ? { checkpointAvgMs: item.checkpointAvgMs } : {}),
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
      }));
    out.push({
      ts: typeof obj.ts === 'number' ? obj.ts : 0,
      platform: obj.platform as ProbePlatform,
      ua: typeof obj.ua === 'string' ? obj.ua : '',
      visibility: typeof obj.visibility === 'string' ? obj.visibility : 'unknown',
      ...(typeof obj.hardwareConcurrency === 'number' ? { hardwareConcurrency: obj.hardwareConcurrency } : {}),
      checkpoint: {
        messages: typeof checkpoint.messages === 'number' ? checkpoint.messages : 0,
        bytes: typeof checkpoint.bytes === 'number' ? checkpoint.bytes : 0,
        source: checkpoint.source === 'session' ? 'session' : 'synthetic',
      },
      workers,
      timer: {
        beatMs: typeof timer.beatMs === 'number' ? timer.beatMs : 0,
        p50DriftMs: typeof timer.p50DriftMs === 'number' ? timer.p50DriftMs : 0,
        maxDriftMs: typeof timer.maxDriftMs === 'number' ? timer.maxDriftMs : 0,
        visibility: typeof timer.visibility === 'string' ? timer.visibility : 'unknown',
        ...(timer.background && typeof timer.background === 'object'
          ? {
              background: (() => {
                const bg = timer.background as Record<string, unknown>;
                return {
                  beatMs: typeof bg.beatMs === 'number' ? bg.beatMs : 0,
                  p50DriftMs: typeof bg.p50DriftMs === 'number' ? bg.p50DriftMs : 0,
                  maxDriftMs: typeof bg.maxDriftMs === 'number' ? bg.maxDriftMs : 0,
                  visibility: typeof bg.visibility === 'string' ? bg.visibility : 'unknown',
                  ...(typeof bg.error === 'string' ? { error: bg.error } : {}),
                };
              })(),
            }
          : {}),
      },
    });
  }
  return out;
}

/** 每个平台只留最新一份（跨多次运行对比时看最近一次环境）。 */
export function latestPerPlatform(reports: readonly WorkerProbeReport[]): WorkerProbeReport[] {
  const latest = new Map<string, WorkerProbeReport>();
  for (const report of reports) {
    const current = latest.get(report.platform);
    if (!current || report.ts >= current.ts) latest.set(report.platform, report);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

const ms = (value?: number): string => {
  if (value === undefined) return '-';
  return value < 10 ? `${value.toFixed(2)}ms` : `${Math.round(value)}ms`;
};

const size = (bytes: number): string => {
  if (bytes <= 0) return '-';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
};

/** 终端 / issue 都可直接贴的固定列宽表。 */
export function formatProbeTable(reports: readonly WorkerProbeReport[]): string {
  if (reports.length === 0) return '（日志里还没有 worker_probe 行）';
  const header = [
    'platform'.padEnd(9),
    'worker'.padEnd(15),
    'load'.padEnd(9),
    'rtt-avg'.padEnd(9),
    'rtt95'.padEnd(8),
    '1MB-avg'.padEnd(9),
    'evt-avg'.padEnd(9),
    'ckpt-avg'.padEnd(10),
    'timer'.padEnd(8),
    'timer-bg'.padEnd(10),
    'context'.padEnd(18),
  ].join('');
  const lines = [header];
  for (const report of reports) {
    const context = `${report.checkpoint.messages} msg / ${size(report.checkpoint.bytes)}${report.checkpoint.source === 'synthetic' ? ' (synth)' : ''}`;
    for (const worker of report.workers) {
      if (!worker.ok) {
        lines.push([
          report.platform.padEnd(9),
          worker.label.padEnd(15),
          'FAIL'.padEnd(9),
          '-'.padEnd(8),
          '-'.padEnd(9),
          '-'.padEnd(9),
          '-'.padEnd(10),
          '-'.padEnd(8),
          '-'.padEnd(10),
          (worker.error ?? '').slice(0, 60),
        ].join(''));
        continue;
      }
      lines.push([
        report.platform.padEnd(9),
        worker.label.padEnd(15),
        ms(worker.loadMs).padEnd(9),
        ms(worker.rttAvgMs ?? worker.rttP50Ms).padEnd(9),
        ms(worker.rttP95Ms).padEnd(8),
        ms(worker.oneMbAvgMs ?? worker.oneMbMs).padEnd(9),
        ms(worker.eventAvgMs ?? worker.eventMs).padEnd(9),
        ms(worker.checkpointAvgMs ?? worker.checkpointMs).padEnd(10),
        ms(report.timer.p50DriftMs).padEnd(8),
        (report.timer.background ? ms(report.timer.background.p50DriftMs) : '-').padEnd(10),
        context.padEnd(18),
      ].join(''));
    }
  }
  return lines.join('\n');
}
