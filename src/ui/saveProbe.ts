// src/ui/saveProbe.ts
// P0-4（engine-worker-migration 落地计划）— 任务 B 取证。
//
// 要回答的问题：主线程被长任务冻住时，`save_session` 的**写入**还会不会落盘？
//   - 文件在长、回执超时 ⇒ 只丢回执（P1-c 可缓）；
//   - 文件也停 ⇒ 丢写（P1-c 升级为必做）。
//
// 做法：构造一份 ~3MB 的快照，派发 save_session 后立刻忙等冻结主线程。
// Rust 侧 run_blocking 在独立线程写盘，外部 CLI 采样 session.json 的
// size/mtime；解冻后才处理 invoke 的回执。探针只写 gui_perf.log，不改产品路径。

import { loadTauriCore, tauriInvoke } from '../shared/tauri';

export interface SaveProbeOptions {
  freezeMs?: number;
  sessionId?: string;
}

interface SaveProbeReport {
  sessionId: string;
  freezeMs: number;
  freezeActualMs: number;
  dispatchMs: number;
  totalMs: number;
  snapshotBytes: number;
  /** 绝对时间戳：CLI 用它判断文件首次出现是否落在冻结窗口内。 */
  freezeStartedAt: number;
  freezeEndedAt: number;
  invokeStartedAt: number;
  invokeResolvedAt: number;
  bytes?: number;
  error?: string;
}

async function logLine(line: Record<string, unknown>): Promise<void> {
  try {
    const core = await loadTauriCore();
    if (core) await core.invoke('gui_perf_log', { lines: [JSON.stringify(line)] });
  } catch {
    // 取证失败不能反过来影响探针本身。
  }
}

function buildSnapshot(): { sessionId: string; snapshot: Record<string, unknown>; bytes: number } {
  const sessionId = `probe_save_${Date.now()}`;
  // 8KB × 400 ≈ 3.2MB：足够让写盘/IPC 有可观测的持续时间，又不至于卡死磁盘。
  const messages = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `probe-${index}:` + 'x'.repeat(8192),
  }));
  const snapshot = {
    version: 3,
    modelContext: { messages },
    events: [],
    transcript: [],
    uiState: {},
  };
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  } catch {
    bytes = 0;
  }
  return { sessionId, snapshot, bytes };
}

export async function runSaveProbe(options: SaveProbeOptions = {}): Promise<SaveProbeReport> {
  const freezeMs = Math.max(1_000, options.freezeMs ?? 15_000);
  const built = buildSnapshot();
  const sessionId = options.sessionId ?? built.sessionId;

  await logLine({
    ts: Date.now(),
    kind: 'save_probe_start',
    sessionId,
    freezeMs,
    snapshotBytes: built.bytes,
  });

  const invokeStartedAt = Date.now();
  const invokeStarted = performance.now();
  const pending = tauriInvoke<number>('save_session', {
    sessionId,
    snapshot: built.snapshot,
    workspace: '',
  });
  const dispatchMs = performance.now() - invokeStarted;

  // 立刻冻结：不给回执处理留拍。写盘在 Rust blocking 线程，但 IPC 的投递
  // 本身可能还在 WebView 主线程队列里——这正是要量出来的。
  const freezeStartedAt = Date.now();
  const freezeStarted = performance.now();
  while (performance.now() - freezeStarted < freezeMs) {
    // busy wait — 这就是要复现的「主线程长任务」。
  }
  const freezeActualMs = performance.now() - freezeStarted;
  const freezeEndedAt = Date.now();

  let bytes: number | undefined;
  let error: string | undefined;
  try {
    bytes = await pending;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const invokeResolvedAt = Date.now();
  const totalMs = performance.now() - invokeStarted;

  const report: SaveProbeReport = {
    sessionId,
    freezeMs,
    freezeActualMs,
    dispatchMs,
    totalMs,
    snapshotBytes: built.bytes,
    freezeStartedAt,
    freezeEndedAt,
    invokeStartedAt,
    invokeResolvedAt,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  await logLine({ ts: Date.now(), kind: 'save_probe_done', ...report });
  console.info('[pure] save probe', report);
  return report;
}
