import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type TraceEventType =
  | 'interject'
  | 'interject_block'
  | 'cancel_before_dispatch'
  | 'route_decided'
  | 'delegate'
  | 'turn_route_prefetch'
  | 'turn_route_decided';

export interface TraceEvent {
  ts: number;
  type: TraceEventType;
  reason?: string;
  turnId?: string;
  subagentId?: string;
  route?: string;
  snippet?: string;
  [k: string]: unknown;
}

function tracePath(): string | null {
  try {
    // 优先使用项目根目录下 .pure-evo
    const root = process.cwd();
    const dir = join(root, '.pure-evo');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return join(dir, 'trace.jsonl');
  } catch {
    return null;
  }
}

export function appendTrace(event: Omit<TraceEvent, 'ts'>): void {
  try {
    const p = tracePath();
    if (!p) return;
    const rec: TraceEvent = { ts: Date.now(), ...event } as TraceEvent;
    const line = JSON.stringify(rec) + '\n';
    appendFileSync(p, line, { encoding: 'utf8' });
  } catch {
    // 静默：不影响主流程
  }
}
