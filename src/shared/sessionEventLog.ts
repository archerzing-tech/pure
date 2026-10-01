// src/shared/sessionEventLog.ts
// 架构评审 v2 A1（2026-10-01）— 会话事件日志的纯核：类型 + 串行化追加 +
// 行容错解析。events.jsonl 是会话的唯一事实源（快照降为压缩视图），本文档
// 见 docs/remote-office-bridge-design.md §2。
//
// S1-1 第一刀的范围刻意收窄：primitive + 两条最高价值事件（user_input /
// turn_settled）的落盘接缝。收执/插话/委派事件与「日志→messages 投影」归
// S1-2——投影层定形时再决定事件词汇表，不在地基刀里预支。
//
// 纪律：**事件日志永远不挡正事**——追加失败降级为 console.warn（一次性熔断
// 防刷屏），回合照常进行；「事件即接口」在这里的含义是：写不进日志的事可以
// 不发生，正在发生的事不能因为日志而停。

/** 事件的书写方。多进程并发追加是日志原语支持的正常形态（O_APPEND 行写）。 */
export type SessionEventActor = 'gui' | 'gateway' | 'cli' | 'sleep';

/** 输入来源标注（远程办公互见的根基：手机来的与本地来的都在日志里可分）。 */
export interface SessionEventOrigin {
  /** 输入面：gui | channel 名（qq/feishu/dingtalk/webchat）。 */
  surface: string;
  /** surface 为通道时的对端标识（配对键）。 */
  peer?: string;
}

/** v1 事件词汇表（有界起点，S1-2 随投影层扩展）。 */
export type SessionEventKind =
  | 'user_input'      // 一条用户输入进入会话（含 origin）
  | 'turn_settled';   // 一个回合落定（完成/中断/失败，带耗时）

export interface SessionEvent<K extends string = string> {
  /** 事件时刻（epoch ms）。 */
  ts: number;
  kind: K;
  actor: SessionEventActor;
  origin?: SessionEventOrigin;
  payload: unknown;
}

/** 追加接缝：GUI = Tauri append_session_event，测试 = 内存桩。 */
export interface SessionEventSink {
  append(event: SessionEvent): Promise<void>;
}

/**
 * 串行化追加：同一 sink 上的并发 append 按调用序逐个落行——事件顺序是日志
 * 的生命，调用方的 await 只保证「已入队」，顺序由内部 promise 链保证。
 */
export function createSerializingSink(
  writeLine: (line: string) => Promise<void>,
  onRecoverableError?: (err: unknown) => void,
): SessionEventSink {
  let chain: Promise<void> = Promise.resolve();
  let degraded = false;
  return {
    append(event: SessionEvent): Promise<void> {
      // 单行不变式由 JSON.stringify 保证（控制字符必被转义）——Rust 侧的
      // 多行拒绝是纵深防御，TS 侧无需重复检查。
      const line = JSON.stringify(event);
      chain = chain.then(() => writeLine(line)).catch((err) => {
        // 一次性熔断提示 + 静默续链：日志失败不升级为回合失败。
        if (!degraded) {
          degraded = true;
          (onRecoverableError ?? ((e) => console.warn('[session-event-log] append failed:', e)))(err);
        }
        chain = Promise.resolve(); // 失败后的链从干净状态续
      });
      return chain;
    },
  };
}

/**
 * 行容错解析：坏行跳过不拖垮整份日志（与 promptObservations 同一纪律）。
 * 输出保持文件序（追加序即因果序的近似；跨进程交错的行内序由 ts 兜底对齐）。
 */
export function parseSessionEvents(raw: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SessionEvent>;
      if (typeof parsed.ts === 'number' && typeof parsed.kind === 'string' && typeof parsed.actor === 'string') {
        out.push({
          ts: parsed.ts,
          kind: parsed.kind,
          actor: parsed.actor as SessionEvent['actor'],
          ...(parsed.origin ? { origin: parsed.origin } : {}),
          payload: parsed.payload,
        });
      }
    } catch {
      // 坏行：留档不读。
    }
  }
  return out;
}

/** 事件体里用户原文的截断上限——日志是账本不是转录备份。 */
export const SESSION_EVENT_TEXT_CAP = 2_000;

export function capEventText(text: string): string {
  return text.length > SESSION_EVENT_TEXT_CAP ? `${text.slice(0, SESSION_EVENT_TEXT_CAP)}…` : text;
}
