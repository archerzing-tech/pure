// src/shared/node/sessionEventFile.ts
// 会话事件日志的文件 sink（CLI/gateway 宿主侧）：append-only 行写，复用
// shared/sessionEventLog 的串行化核心（单行不变式、失败熔断不挡回合）。
// GUI 宿主走 Tauri append_session_event，本模块与它写同一种日志——
// ~/.pure/sessions/<sessionId>/events.jsonl，两端互见靠的就是同源格式。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSerializingSink, type SessionEventSink } from '../sessionEventLog';

export function createFileSessionEventSink(pureDir: string, sessionId: string): SessionEventSink {
  const dir = join(pureDir, 'sessions', sessionId);
  let ensured = false;
  return createSerializingSink(async (line) => {
    if (!ensured) {
      mkdirSync(dir, { recursive: true });
      ensured = true;
    }
    appendFileSync(join(dir, 'events.jsonl'), `${line}\n`, 'utf-8');
  });
}
