// src/shared/sessionProtocol.ts
// P2-b（engine-worker-migration 落地计划）— Worker ↔ 主线程协议的纯核。
//
// 这里只放类型与纯函数，不 import DOM/Tauri：Worker、主线程、测试三方共用一份，
// 避免「主线程以为的字段名」和「Worker 实际发的」漂移。
//
// 三条不变式（P2 的验收点）：
//   1. seq 单调：主线程按 seq 检测缺口，缺口时不猜、发 resync；
//   2. 重放幂等：seq ≤ 已应用水位的帧直接丢弃（崩溃恢复会重发一批帧）；
//   3. 预览可丢：project 不可丢，preview 在背压时只留最后一帧。

import type { Message, MessageImage } from './types';

export type SessionOp =
  | { type: 'append'; message: Message }
  | { type: 'replace'; index: number; message: Message }
  | { type: 'truncate'; length: number }
  | { type: 'reset'; messages: Message[] };

export interface ProjectFrame {
  seq: number;
  kind: 'project';
  ops: SessionOp[];
}

export interface PreviewFrame {
  seq: number;
  kind: 'preview';
  /** 已累积的可见文本（不是增量）——丢帧后仍能靠最后一帧收口。 */
  text: string;
  /** 工具卡/思考卡的可丢弃预览。 */
  card?: { callId: string; title: string; detail?: string };
}

export interface StatePatchFrame {
  seq: number;
  kind: 'state';
  patch: Record<string, unknown>;
}

export interface NeedFrame {
  seq: number;
  kind: 'need';
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PersistFrame {
  seq: number;
  kind: 'persist';
  event: { kind: string; payload: unknown };
}

export interface DiagFrame {
  seq: number;
  kind: 'diag';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type WorkerFrame =
  | ProjectFrame
  | PreviewFrame
  | StatePatchFrame
  | NeedFrame
  | PersistFrame
  | DiagFrame;

export interface AttachFrame {
  kind: 'attach';
  sessionId: string;
  workspace: string;
}

export interface RunFrame {
  kind: 'run';
  requestId: string;
  systemPrompt: string;
  userTurn: string;
  images?: MessageImage[];
}

export interface ContinueTurnFrame {
  kind: 'continueTurn';
  requestId: string;
  systemPrompt: string;
  messages: Message[];
  newUserPrompt: string;
  images?: MessageImage[];
  internal?: boolean;
}

export interface AbortFrame {
  kind: 'abort';
  requestId: string;
}

/** 工具桥（P3-a）：主线程执行完回填。 */
export interface NeedResultFrame {
  kind: 'needResult';
  callId: string;
  result: unknown;
}

export interface AckFrame {
  kind: 'ack';
  seq: number;
}

export interface ResyncFrame {
  kind: 'resync';
  fromSeq: number;
}

export type MainFrame =
  | AttachFrame
  | RunFrame
  | ContinueTurnFrame
  | AbortFrame
  | NeedResultFrame
  | AckFrame
  | ResyncFrame;

export interface ProjectionState {
  seq: number;
  messages: Message[];
}

export function applyOps(messages: readonly Message[], ops: readonly SessionOp[]): Message[] {
  const next = [...messages];
  for (const op of ops) {
    switch (op.type) {
      case 'append':
        next.push(op.message);
        break;
      case 'replace':
        if (op.index >= 0 && op.index < next.length) next[op.index] = op.message;
        break;
      case 'truncate':
        next.length = Math.max(0, Math.min(next.length, op.length));
        break;
      case 'reset':
        next.length = 0;
        next.push(...op.messages);
        break;
    }
  }
  return next;
}

export interface ApplyProjectResult {
  state: ProjectionState;
  /** seq 不连续：调用方应发 resync{fromSeq: state.seq + 1}，而不是应用这一帧。 */
  gap: boolean;
}

/**
 * 应用一帧 project：
 *   - seq ≤ 水位：重放，原样返回（幂等）；
 *   - seq > 水位+1：缺口，不应用，交给 resync；
 *   - seq = 水位+1：应用 ops 并推进水位。
 */
export function applyProjectFrame(
  state: ProjectionState,
  frame: ProjectFrame,
): ApplyProjectResult {
  if (frame.seq <= state.seq) return { state, gap: false };
  if (frame.seq > state.seq + 1) return { state, gap: true };
  return {
    state: { seq: frame.seq, messages: applyOps(state.messages, frame.ops) },
    gap: false,
  };
}

function previewBytes(frame: PreviewFrame): number {
  // JSON 长度是上界估计即可：这里只用于背压阈值，不做字节级记账。
  try {
    return JSON.stringify(frame).length;
  } catch {
    return 0;
  }
}

/**
 * 预览合帧：队列总量超过 maxBytes 时丢掉除最后一帧以外的所有帧。
 * 预览是「刷新即可重建」的数据，丢中间帧只损失流畅度，不损失终态。
 */
export function coalescePreview(
  queue: readonly PreviewFrame[],
  next: PreviewFrame,
  maxBytes = 16 * 1024,
): PreviewFrame[] {
  const all = [...queue, next];
  const total = all.reduce((sum, frame) => sum + previewBytes(frame), 0);
  if (total <= maxBytes) return all;
  return [next];
}

/** 缺口后请求重同步的帧；fromSeq 是期望的下一条。 */
export function resyncFrom(state: ProjectionState): ResyncFrame {
  return { kind: 'resync', fromSeq: state.seq + 1 };
}
