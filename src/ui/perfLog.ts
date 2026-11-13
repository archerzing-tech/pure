// src/ui/perfLog.ts
// 性能埋点聚合器（2026-11-13 活锁三刀后挂账刀）：内存聚合 + 低频 flush 进
// ~/.pure/gui_perf.log（Rust gui_perf_log 命令，JSONL append + 1MB 轮转，
// 机制与错误台账同款、文件分开——错误台账语义是「错误」，性能样本混入会
// 污染 `pure errors`）。写盘频率与热路径拍数解耦：流式 5–10 拍/秒，每 100
// 拍或 60s 才落一行；桥不可用（单测环境/旧后端）静默丢——埋点永远不能
// 成为新的性能问题（写盘根治判例的逆向应用）。
//
// 当前两个观察点（活锁修复的量化收尾）：
// - stream：流式每拍渲染总成本（diffStreaming 实测 ms + 文本长度）——
//   lexer 增量化刀的前后对比基线；
// - settle：renderMarkdown 全文管线单次成本（完成态/恢复态共用，len 自
//   区分场景）——145k 收尾一次性停顿的量化。

import { loadTauriCore } from '../shared/tauri';

export interface PerfAggregator {
  /** 记一个样本：costMs=该拍实测耗时，textLen=该拍处理的文本长度。 */
  record(costMs: number, textLen: number): void;
  /** 强制落盘（例如 turn 收尾时），样本不足也落。 */
  flushNow(): Promise<void>;
}

/** 已排序样本的百分位（p∈[0,100]）。导出供单测钉边界。 */
export function percentileFromSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** 聚合器工厂：样本攒到 flushEveryBeats 个或首样本起 flushEveryMs 到期，
 *  落一行 {ts, kind, beats, p50, p90, max, lenMax}。 */
export function createPerfAggregator(
  kind: string,
  flushEveryBeats: number,
  flushEveryMs: number,
): PerfAggregator {
  const samples: number[] = [];
  const lens: number[] = [];
  let firstAt = 0;
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || samples.length === 0) return;
    flushing = true;
    const now = Date.now();
    const sorted = [...samples].sort((a, b) => a - b);
    const line = JSON.stringify({
      ts: now,
      kind,
      beats: samples.length,
      p50: Math.round(percentileFromSorted(sorted, 50)),
      p90: Math.round(percentileFromSorted(sorted, 90)),
      max: sorted[sorted.length - 1] ?? 0,
      lenMax: lens.length > 0 ? Math.max(...lens) : 0,
    });
    samples.length = 0;
    lens.length = 0;
    firstAt = 0;
    try {
      const core = await loadTauriCore();
      if (core) {
        await core.invoke('gui_perf_log', { lines: [line] });
      }
    } catch {
      // 命令不可用或写盘失败：静默。埋点是尽力而为，不该有可观察的失败面。
    } finally {
      flushing = false;
    }
  }

  return {
    record(costMs: number, textLen: number): void {
      if (samples.length === 0) firstAt = Date.now();
      samples.push(costMs);
      lens.push(textLen);
      // 拍数达标立即落；时间窗到期靠下一拍顺带触发（不挂独立 timer——
      // 低流量时段少一个常驻 interval）。
      if (samples.length >= flushEveryBeats) void flush();
    },
    flushNow(): Promise<void> {
      return flush();
    },
  };
}
