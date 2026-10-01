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
  | 'user_input'            // 一条用户输入进入会话（含 origin）
  | 'turn_settled'          // 一个回合落定（完成/中断/失败，带耗时）
  | 'receipt'               // 插话/操作收执的终稿（settleAck 单点）
  | 'insertion_classified'  // 插话裁决结果（kind/action/via）
  | 'delegation_settled'    // 一路子代理委派落定（onDone/onError 单点）
  | 'turn_messages';        // 回合转录增量（引擎消息数组，快照 fold 的原料）

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

// ── S1-2：日志 → 时间线投影（远程 digest 与「重开即互见」的读取地基）──
// 投影只做归并与措辞，不发明新事实：每条时间线条目都能指回事件本身。未知
// kind 照样通过（前向兼容——旧读新日志，新事件顶多不带摘要）。

export interface TimelineEntry {
  ts: number;
  /** 事件 kind 原样（消费方按需过滤/分组）。 */
  kind: SessionEventKind | (string & {});
  /** 一行摘要（已截断；直接给 digest/通知用）。 */
  summary: string;
  origin?: SessionEventOrigin;
}

interface EventPayloadShape {
  text?: unknown;
  isAuto?: unknown;
  totalMs?: unknown;
  ttftMs?: unknown;
  branchEvents?: unknown;
  style?: unknown;
  final?: unknown;
  kind?: unknown;
  action?: unknown;
  via?: unknown;
  agentName?: unknown;
  agentId?: unknown;
  success?: unknown;
  outcome?: unknown;
  durationMs?: unknown;
}

function clip(text: unknown, max = 120): string {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ms(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n / 100) / 10}s` : '?';
}

/** 把事件日志投影成时间线（每事件一条，保持日志序）。 */
export function projectSessionTimeline(events: readonly SessionEvent[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const event of events) {
    // turn_messages 是转录原料（批量数据），不是时间线素材——digest 里一行
    // 「回合落定」已经代表它，重复罗列只会淹没真正的叙事事件。
    if (event.kind === 'turn_messages') continue;
    const p = (event.payload ?? {}) as EventPayloadShape;
    let summary: string;
    switch (event.kind) {
      case 'user_input': {
        const who = event.origin && event.origin.surface !== 'gui' ? `(${event.origin.surface})` : '';
        summary = `${p.isAuto === true ? '[自动]' : '用户'}${who}：${clip(p.text)}`;
        break;
      }
      case 'turn_settled':
        summary = `回合落定（${ms(p.totalMs)}，分支事件 ${typeof p.branchEvents === 'number' ? p.branchEvents : 0}）`;
        break;
      case 'receipt':
        summary = `回执：${clip(p.text)}`;
        break;
      case 'insertion_classified':
        summary = `插话裁决：${String(p.kind ?? '?')} → ${String(p.action ?? '?')}（${String(p.via ?? '?')}）：${clip(p.text, 60)}`;
        break;
      case 'delegation_settled':
        summary = `${String(p.agentName ?? '?')} ${p.success === true ? '✔' : '✘'}${p.outcome ? ` ${String(p.outcome)}` : ''}（${ms(p.durationMs)}）`;
        break;
      default:
        summary = event.kind;
    }
    out.push({ ts: event.ts, kind: event.kind, summary, ...(event.origin ? { origin: event.origin } : {}) });
  }
  return out;
}

/** digest 视图：最近 limit 条时间线（手机推送/快速回看的形状）。 */
export function recentTimelineDigest(events: readonly SessionEvent[], limit = 12): TimelineEntry[] {
  return projectSessionTimeline(events).slice(-limit);
}

// ── S1-4：fold 合并读取面 ──
// 快照 = 日志的压缩视图（foldedThrough 水位之前的 turn_messages 已在快照
// messages 里）；完整现状 = 快照 messages + 水位之后的 turn_messages 增量。
// 这是「日志为唯一事实源、快照为物化」的读取侧兑现。

/**
 * 合并 fold 与日志尾增量。保守不错记：
 *   - foldedThrough 缺省（标记诞生前的旧会话）⇒ 快照权威、忽略尾增量；
 *   - ts ≤ 水位的 turn_messages 已在快照里，跳过（水位语义即不重复计入）；
 *   - 非 turn_messages 事件不参与转录合并（叙事事件走时间线投影）。
 */
export function mergeFoldWithLog<T>(
  snapshotMessages: readonly T[],
  foldedThrough: number | undefined,
  events: readonly SessionEvent[],
): T[] {
  if (foldedThrough === undefined) return [...snapshotMessages];
  const tail: T[] = [];
  for (const event of events) {
    if (event.kind !== 'turn_messages' || event.ts <= foldedThrough) continue;
    const payload = event.payload as { messages?: unknown } | null | undefined;
    if (Array.isArray(payload?.messages)) tail.push(...(payload.messages as T[]));
  }
  return [...snapshotMessages, ...tail];
}
