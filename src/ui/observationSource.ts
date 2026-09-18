// src/ui/observationSource.ts
// E4.2 — 进化仪表盘的数据入口（GUI 侧）。观测记录长期落在
// ~/.pure/observations/app.jsonl（E0.1），WebView 没有 node:fs，所以走 Rust 的
// read_observations 尾巴读：只取文件末尾一段，避免 64MB 的字符串跨 IPC。
//
// 浏览器模式 / 读失败都返回 available:false —— 仪表盘据此显示"桌面版才有
// 观测数据"，而不是把空数据当成"你从没跑过任务"。

import { parsePromptObservations, type PromptObservation } from '../shared/promptObservability';
import { tauriInvoke, isTauriRuntime } from '../shared/tauri';

export interface ObservationReadResult {
  /** true 表示真的读到后端（哪怕文件还是空的）；false = 浏览器模式或读取失败。 */
  available: boolean;
  records: PromptObservation[];
  /** 日志文件总字节数（用来判断尾巴读有没有被截断）。 */
  totalBytes: number;
  readBytes: number;
  truncated: boolean;
  path: string;
}

function unavailable(): ObservationReadResult {
  return { available: false, records: [], totalBytes: 0, readBytes: 0, truncated: false, path: '' };
}

/** 读取观测日志尾巴并解析成记录；永不抛异常。 */
export async function readGuiObservations(): Promise<ObservationReadResult> {
  if (!isTauriRuntime()) return unavailable();
  try {
    const dump = await tauriInvoke<{
      path?: string;
      totalBytes?: number;
      readBytes?: number;
      truncated?: boolean;
      text?: string;
    }>('read_observations');
    if (!dump) return unavailable();
    return {
      available: true,
      records: parsePromptObservations(dump.text ?? ''),
      totalBytes: dump.totalBytes ?? 0,
      readBytes: dump.readBytes ?? 0,
      truncated: dump.truncated === true,
      path: dump.path ?? '',
    };
  } catch (err) {
    console.warn('[pure] read_observations failed:', err);
    return unavailable();
  }
}
