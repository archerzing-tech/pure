// src/ui/workerProbe.ts
// P0-3（engine-worker-migration 落地计划）— WebView 内的双平台探针。
//
// 量四件事，全部写进 ~/.pure/gui_perf.log 的 worker_probe 行：
//   1. worker 加载：asset URL（Tauri 自定义协议）与 blob 兜底，classic / module 各一条；
//   2. postMessage 小消息往返；
//   3. 结构化克隆：1MB 字符串、单条 EngineEvent、TurnCheckpoint 形状 {messages}；
//   4. setTimeout 漂移（App Nap / 后台 timer 合并的可见信号）。
//
// 只在 VITE_WORKER_PROBE=1 时由 main.ts 自动跑（dev 构建），或 devtools 里手动
// `await __pureWorkerProbe()`。任何一步失败都写进报告而不是抛出——探针不能成为
// 启动失败的新原因。

import { loadTauriCore } from '../shared/tauri';
import {
  buildProbeLogLine,
  platformLabelFromUa,
  type WorkerProbeReport,
  type WorkerProbeSample,
} from '../shared/workerProbeReport';

export interface WorkerProbeOptions {
  /** 有会话时用真实 messages 量 TurnCheckpoint 克隆；没有就用合成 200 条。 */
  sessionId?: string;
  pingRounds?: number;
  payloadRounds?: number;
  timerBeatMs?: number;
  timerSamples?: number;
}

interface ProbeReply {
  type?: string;
  id?: number;
  bytes?: number;
  messages?: number;
}

interface ProbeClient {
  ready: Promise<void>;
  send(payload: Record<string, unknown>): Promise<ProbeReply>;
  dispose(): void;
}

const READY_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 5_000;

const ONE_MB = 'x'.repeat(1024 * 1024);
// 50KB 的内容接近流式一拍的典型上界（Rust 侧 50ms/16KB 合批，多拍累积）。
const EVENT_PAYLOAD = {
  type: 'TokenDelta',
  payload: { content: 'y'.repeat(50_000), stateId: 'probe', isToolCall: false },
  timestamp: 0,
};

/** blob worker 的源码必须完全自包含（无 import），否则 classic 加载会失败。 */
const BLOB_SOURCE = `self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === 'ping') { self.postMessage({ type: 'pong', id: data.id }); return; }
  if (data.type === 'echo') {
    var payload = data.payload;
    var messages = payload && typeof payload === 'object' && Array.isArray(payload.messages)
      ? payload.messages.length : 0;
    self.postMessage({
      type: 'echoed', id: data.id,
      bytes: typeof payload === 'string' ? payload.length : 0,
      messages: messages,
    });
  }
};
self.postMessage({ type: 'ready' });`;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function attach(worker: Worker): ProbeClient {
  let nextId = 1;
  const pending = new Map<number, (reply: ProbeReply) => void>();
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;

  worker.onmessage = (event: MessageEvent<ProbeReply>) => {
    const data = event.data;
    if (data?.type === 'ready') {
      resolveReady?.();
      return;
    }
    if (typeof data?.id === 'number') {
      const callback = pending.get(data.id);
      if (callback) {
        pending.delete(data.id);
        callback(data);
      }
    }
  };
  worker.onerror = (event: ErrorEvent) => {
    const err = new Error(event.message || 'worker load error');
    rejectReady?.(err);
    for (const callback of pending.values()) callback({ type: 'error' });
    pending.clear();
  };

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  return {
    ready,
    send(payload: Record<string, unknown>): Promise<ProbeReply> {
      const id = nextId++;
      return new Promise<ProbeReply>((resolve, reject) => {
        pending.set(id, resolve);
        try {
          worker.postMessage({ ...payload, id });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    dispose(): void {
      worker.onmessage = null;
      worker.onerror = null;
      pending.clear();
    },
  };
}

function blobWorker(format: 'classic' | 'module'): Worker {
  const url = URL.createObjectURL(new Blob([BLOB_SOURCE], { type: 'text/javascript' }));
  // 立即 revoke 会让部分 WebView 在脚本尚未拉取时失败；给一个宽限窗。
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return format === 'module' ? new Worker(url, { type: 'module' }) : new Worker(url);
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

async function loadCheckpointPayload(
  sessionId?: string,
): Promise<{ payload: { messages: unknown[] }; source: 'session' | 'synthetic' }> {
  if (sessionId) {
    try {
      const core = await loadTauriCore();
      const data = await core?.invoke<Record<string, unknown>>('load_session', { sessionId });
      const snapshot = (data?.snapshot ?? data) as { modelContext?: { messages?: unknown } } | undefined;
      const messages = snapshot?.modelContext?.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        return { payload: { messages }, source: 'session' };
      }
    } catch {
      // 会话读不到就退化合成样本：加载成本是主问题，样本形状已够。
    }
  }
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `probe-${index}:` + 'x'.repeat(2048),
  }));
  return { payload: { messages }, source: 'synthetic' };
}

async function sample(
  run: () => Promise<unknown>,
  rounds: number,
): Promise<{ p50: number; p95: number; avg: number }> {
  const times: number[] = [];
  // 单次 now() 在 WKWebView 里被钳到 1ms（crossOriginIsolated=false），
  // 逐次差值会出现大量 0.00；用整段总耗时 / 轮数拿平均值。
  const allStarted = performance.now();
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  const total = performance.now() - allStarted;
  times.sort((a, b) => a - b);
  const at = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), avg: rounds > 0 ? total / rounds : 0 };
}

async function probeWorker(
  label: string,
  factory: () => Worker,
  checkpointPayload: { messages: unknown[] },
  pingRounds: number,
  payloadRounds: number,
): Promise<WorkerProbeSample> {
  const started = performance.now();
  let worker: Worker;
  try {
    worker = factory();
  } catch (err) {
    return { label, ok: false, error: `构造失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const client = attach(worker);
  try {
    await withTimeout(client.ready, READY_TIMEOUT_MS, `${label} ready`);
    const loadMs = performance.now() - started;
    const ping = () => withTimeout(client.send({ type: 'ping' }), SEND_TIMEOUT_MS, `${label} ping`);
    const echo = (payload: unknown) =>
      withTimeout(client.send({ type: 'echo', payload }), SEND_TIMEOUT_MS, `${label} echo`);

    const rtt = await sample(ping, pingRounds);
    const oneMb = await sample(() => echo(ONE_MB), payloadRounds);
    const event = await sample(() => echo(EVENT_PAYLOAD), payloadRounds);
    const checkpoint = await sample(() => echo(checkpointPayload), payloadRounds);
    return {
      label,
      ok: true,
      loadMs,
      rttP50Ms: rtt.p50,
      rttP95Ms: rtt.p95,
      rttAvgMs: rtt.avg,
      oneMbMs: oneMb.p50,
      oneMbAvgMs: oneMb.avg,
      eventMs: event.p50,
      eventAvgMs: event.avg,
      checkpointMs: checkpoint.p50,
      checkpointAvgMs: checkpoint.avg,
    };
  } catch (err) {
    return { label, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.dispose();
    worker.terminate();
  }
}

async function measureTimers(beatMs: number, samples: number): Promise<WorkerProbeReport['timer']> {
  const drifts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, beatMs));
    drifts.push(performance.now() - started - beatMs);
  }
  drifts.sort((a, b) => a - b);
  return {
    beatMs,
    p50DriftMs: drifts[Math.floor(drifts.length * 0.5)] ?? 0,
    maxDriftMs: drifts[drifts.length - 1] ?? 0,
    visibility: document.visibilityState,
  };
}

/**
 * 最小化自己再量 timer 漂移：这是 App Nap / Windows timer 合并的可见面。
 * 不最小化就只能量前台调度开销，回答不了「后台窗口会不会被节流」。
 * 失败/拿不到窗口 API 时返回 null，不让探针卡死。
 */
async function measureBackgroundTimers(
  beatMs: number,
): Promise<NonNullable<WorkerProbeReport['timer']['background']> | null> {
  let win: { minimize(): Promise<void>; unminimize(): Promise<void>; setFocus(): Promise<void> } | null = null;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    win = getCurrentWindow();
    await win.minimize();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // 后台只取 3 拍：若真被压到 1Hz，3s 也能收口；再长会拖慢探针。
    const measured = await Promise.race([
      measureTimers(beatMs, 3),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    if (!measured) {
      return {
        beatMs,
        p50DriftMs: -1,
        maxDriftMs: -1,
        visibility: document.visibilityState,
        error: '后台定时器 10s 内未完成',
      };
    }
    return measured;
  } catch {
    return null;
  } finally {
    try {
      await win?.unminimize();
      await win?.setFocus();
    } catch {
      // 窗口 API 不可用或已关闭：忽略，日志仍然写前台结果。
    }
  }
}

export async function runWorkerProbe(options: WorkerProbeOptions = {}): Promise<WorkerProbeReport> {
  // 顶层 visibility 记探针开始时的状态；后台测量会最小化窗口，别把恢复后的
  // （或恢复失败的）状态写进报告，那会让“前台测得”的行看起来像后台。
  const initialVisibility = document.visibilityState;
  const pingRounds = options.pingRounds ?? 200;
  const payloadRounds = options.payloadRounds ?? 8;
  const checkpoint = await loadCheckpointPayload(options.sessionId);

  const factories: Array<{ label: string; factory: () => Worker }> = [
    // asset URL：真正要回答的问题——Tauri 自定义协议下 Worker 能不能加载。
    { label: 'asset-classic', factory: () => new Worker(new URL('./workerProbe.worker.ts', import.meta.url)) },
    { label: 'asset-module', factory: () => new Worker(new URL('./workerProbe.worker.ts', import.meta.url), { type: 'module' }) },
    // blob 兜底：即使自定义协议不通，这条通路决定 P2 是否还有退路。
    { label: 'blob-classic', factory: () => blobWorker('classic') },
    { label: 'blob-module', factory: () => blobWorker('module') },
  ];

  const workers: WorkerProbeSample[] = [];
  for (const entry of factories) {
    workers.push(await probeWorker(entry.label, entry.factory, checkpoint.payload, pingRounds, payloadRounds));
  }

  const timer = await measureTimers(options.timerBeatMs ?? 50, options.timerSamples ?? 10);
  const background = await measureBackgroundTimers(options.timerBeatMs ?? 50);
  const report: WorkerProbeReport = {
    ts: Date.now(),
    platform: platformLabelFromUa(navigator.userAgent),
    ua: navigator.userAgent,
    visibility: initialVisibility,
    hardwareConcurrency: navigator.hardwareConcurrency || undefined,
    checkpoint: {
      messages: checkpoint.payload.messages.length,
      bytes: byteLength(checkpoint.payload),
      source: checkpoint.source,
    },
    workers,
    timer: { ...timer, ...(background ? { background } : {}) },
  };

  try {
    const core = await loadTauriCore();
    if (core) await core.invoke('gui_perf_log', { lines: [buildProbeLogLine(report)] });
  } catch {
    // 日志不可用（浏览器 dev / 旧后端）时探针仍然返回结果，由调用方展示。
  }
  console.info('[pure] worker probe', report);
  return report;
}
