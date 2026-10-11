// src/shared/node/sessionViews.ts
// 「手机看服务端会话」的只读视图层：把 ~/.pure 下的两份事实——
// channels/sessions.json（sessionKey → sessionId 索引）与
// sessions/<id>/events.jsonl（A1 事件日志）——合并成状态总览与时间线。
// 状态推导不改日志一个字：最后一条 user_input 之后还没有 turn_settled
// ⇒ running；落定了 ⇒ settled/failed；一个事件都没有 ⇒ idle。
// 读取一律有界尾读：日志里 turn_messages 可能很大，总览不为它买单。
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSessionEvents,
  projectSessionTimeline,
  type TimelineEntry,
} from '../sessionEventLog';

export interface SessionView {
  sessionId: string;
  /** 通道侧会话才有（gui 会话不在通道索引里）。 */
  sessionKey?: string;
  /** 输入面：通道名（qq/feishu/…）或 gui。 */
  surface: string;
  peer?: string;
  workspace?: string | null;
  lastActivityAt: number;
  status: 'running' | 'settled' | 'failed' | 'idle';
  statusDetail?: string;
}

/** 尾读窗口：状态推导只需要最近的 user_input/turn_settled 对。 */
const TAIL_BYTES = 1024 * 1024;

function readTail(file: string, bytes = TAIL_BYTES): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      // 起点落在某行中间：丢掉残行，从下一个完整行开始。
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

interface StatusReading {
  status: SessionView['status'];
  statusDetail?: string;
  lastEventTs?: number;
}

function deriveStatus(events: ReturnType<typeof parseSessionEvents>): StatusReading {
  let lastEventTs: number | undefined;
  let pendingInput: { ts: number; surface?: string } | undefined;
  let lastSettled: { failed: boolean; totalMs?: number; error?: string } | undefined;
  let lastInputSurface: string | undefined;
  for (const e of events) {
    lastEventTs = e.ts;
    if (e.kind === 'user_input') {
      pendingInput = { ts: e.ts, surface: e.origin?.surface };
      lastInputSurface = e.origin?.surface;
    } else if (e.kind === 'turn_settled') {
      const p = (e.payload ?? {}) as { totalMs?: unknown; failed?: unknown; error?: unknown };
      lastSettled = {
        failed: p.failed === true,
        totalMs: typeof p.totalMs === 'number' ? p.totalMs : undefined,
        error: typeof p.error === 'string' ? p.error : undefined,
      };
      pendingInput = undefined;
    }
  }
  if (pendingInput) {
    return { status: 'running', statusDetail: `回合进行中（输入于 ${new Date(pendingInput.ts).toLocaleTimeString()}）`, lastEventTs };
  }
  if (lastSettled) {
    if (lastSettled.failed) {
      return { status: 'failed', statusDetail: lastSettled.error?.slice(0, 200) ?? '回合失败', lastEventTs };
    }
    const secs = lastSettled.totalMs !== undefined ? `${Math.round(lastSettled.totalMs / 100) / 10}s` : '?';
    return { status: 'settled', statusDetail: `完成（${secs}）`, lastEventTs };
  }
  return { status: 'idle', lastEventTs };
}

function splitSessionKey(sessionKey: string): { surface: string; peer?: string } {
  const segs = sessionKey.split(':');
  if (segs.length < 2) return { surface: sessionKey };
  return { surface: segs[0], ...(segs.length >= 4 ? { peer: segs.slice(3).join(':') } : {}) };
}

/** 会话目录名只允许这几种字符（session_／chan_ 前缀形态），先把路径注入挡在门外。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 总览：通道索引 ∪ 事件目录，按最近活动倒序。events.jsonl 缺失的（旧会话）= idle。 */
export function listSessionViews(pureDir: string): SessionView[] {
  const byId = new Map<string, SessionView>();

  // 1) 通道索引（sessionKey → entry），surface/peer 从键拆出。
  try {
    const indexPath = join(pureDir, 'channels', 'sessions.json');
    if (existsSync(indexPath)) {
      const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, { sessionId: string; lastActivityAt: number; workspace: string | null }>;
      for (const [sessionKey, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.sessionId !== 'string') continue;
        const { surface, peer } = splitSessionKey(sessionKey);
        byId.set(entry.sessionId, {
          sessionId: entry.sessionId,
          sessionKey,
          surface,
          ...(peer ? { peer } : {}),
          workspace: entry.workspace ?? null,
          lastActivityAt: entry.lastActivityAt,
          status: 'idle',
        });
      }
    }
  } catch {
    // 索引坏了不拖垮总览：还有目录扫描兜底。
  }

  // 2) 事件目录：有日志的会话以日志为准（状态 + 活动时刻 + surface）。
  let dirs: string[] = [];
  try {
    const root = join(pureDir, 'sessions');
    if (existsSync(root)) {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    }
  } catch {
    return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  for (const id of dirs) {
    if (!SESSION_ID_RE.test(id)) continue;
    const file = join(pureDir, 'sessions', id, 'events.jsonl');
    if (!existsSync(file)) continue;
    let reading: StatusReading;
    try {
      reading = deriveStatus(parseSessionEvents(readTail(file)));
    } catch {
      continue; // 单会话日志读不动：总览少一行，不整页失败。
    }
    const view = byId.get(id);
    if (view) {
      view.status = reading.status;
      if (reading.statusDetail) view.statusDetail = reading.statusDetail;
      if (reading.lastEventTs !== undefined && reading.lastEventTs > view.lastActivityAt) view.lastActivityAt = reading.lastEventTs;
    } else {
      byId.set(id, {
        sessionId: id,
        surface: 'gui',
        lastActivityAt: reading.lastEventTs ?? 0,
        status: reading.status,
        ...(reading.statusDetail ? { statusDetail: reading.statusDetail } : {}),
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** 时间线：单会话最近 limit 条投影条目（日志序，S1-2 投影核心直用）。 */
export function readSessionTimeline(pureDir: string, sessionId: string, limit = 120): TimelineEntry[] {
  if (!SESSION_ID_RE.test(sessionId)) return [];
  const file = join(pureDir, 'sessions', sessionId, 'events.jsonl');
  if (!existsSync(file)) return [];
  try {
    return projectSessionTimeline(parseSessionEvents(readTail(file))).slice(-limit);
  } catch {
    return [];
  }
}
