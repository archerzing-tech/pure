// src/shared/remoteBridge.ts
// GUI↔网关遥控桥的共享协议与投影格式（docs/remote-session-control-2026-11.md）。
// 这个文件两侧共用：GUI（WebView）与网关（Bun 进程）各自 import，消息形状只认
// 这一份——任何一侧私改字段都是契约破裂，加字段请在这里加。
//
// 投影正文复用 richOutput 的纯文本降级（图表→ASCII 投影 + 「完整源码见桌面端」
// note）；状态行/工具行由引擎事件在这里格式化。参数值不过账纪律：工具摘要只给
// 安全摘要（命令/路径前 60 字符），凭据类参数只出工具名。
import { renderRichOutput } from '../channels/richOutput';
import type { ChannelCapabilities } from '../channels/types';
import type { EngineEvent } from './types';

// ---------- 协议消息 ----------

/** GUI → 网关 */
export type BridgeGuiMessage =
  | { type: 'hello'; sessions: BridgeSessionState[] }
  | { type: 'state'; sessionId: string; state: BridgeSessionState }
  | { type: 'projection'; sessionId: string; frame: BridgeFrame }
  | { type: 'pong'; id: number };

/** 网关 → GUI */
export type BridgeGatewayMessage =
  | { type: 'inject'; msgId: string; sessionId: string; text: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'query_status'; id: number; sessionId: string }
  | { type: 'query_backfill'; id: number; sessionId: string }
  | { type: 'ping'; id: number };

/** 单会话运行状态（hello 批量 / state 增量，同一形状）。 */
export interface BridgeSessionState {
  sessionId: string;
  /** running | idle —— GUI 引擎视角的事实。 */
  running: boolean;
  /** 当前工具名（跑动中才有；给 /sessions 列表的「正在跑什么」）。 */
  toolNow?: string;
  /** 当前回合第几步（工具调用计数）。 */
  step?: number;
  /** 已产文本尾部预览（跑动中才有，洪控由 GUI 侧节流）。 */
  tail?: string;
}

/** 投影帧：kind 决定通道出站的可靠性档位。 */
export interface BridgeFrame {
  kind: 'status' | 'tool' | 'turn' | 'error';
  /** 投影后的人类可读文本（已含状态 emoji 与安全摘要纪律）。 */
  text: string;
}

/** 投影帧 → 出站消息 kind：turn/error 可靠，status/tool 可丢。 */
export function frameToOutboundKind(frame: BridgeFrame): 'progress' | 'notice' {
  return frame.kind === 'turn' || frame.kind === 'error' ? 'notice' : 'progress';
}

// ---------- 工具行格式化 ----------

/** 凭据类工具：参数一律不进摘要，只出工具名（与错误台账同一纪律）。 */
const CREDENTIAL_TOOLS = new Set(['configure_channel', 'set_secret', 'update_config']);

export function clipToolArgs(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function formatToolLine(toolName: string, argsSummary: string, durationMs: number | undefined, ok: boolean): string {
  const args = CREDENTIAL_TOOLS.has(toolName) ? '(参数不展示)' : clipToolArgs(argsSummary);
  const dur = typeof durationMs === 'number' && durationMs > 0 ? ` · ${(durationMs / 1000).toFixed(1)}s` : '';
  return `🔧 ${toolName} · ${args}${dur} ${ok ? '✓' : '✗'}`;
}

// ---------- 引擎事件 → 投影帧 ----------

const TEXT_ONLY_CAPS: ChannelCapabilities = {
  chatTypes: ['dm'],
  media: {},
  streaming: 'none',
  maxTextLength: 4096,
  markdown: 'none',
  canDeliverImages: false,
};

/**
 * 回合正文投影：富块（chart/map/paint）转文本投影，其余留 md 原文。
 * 归一化 notes（光栅化不存在于文本面，只可能剩「保留源码」类），不再重复发。
 */
export async function projectTurnText(text: string): Promise<{ text: string; notes: string[] }> {
  try {
    const result = await renderRichOutput(text, TEXT_ONLY_CAPS, {});
    const body = result.projectedText ?? text;
    // 文本面下 richOutput 对不可投影富块（svg/mermaid/puml）会记「保留源码」
    // note——手机面不需要逐条解释保留，收敛成一行占位提醒。
    const sawRich = result.notes.length > 0;
    return { text: body, notes: sawRich ? ['有富内容块未投影（见桌面端原文）。'] : [] };
  } catch {
    return { text, notes: [] };
  }
}

/** 状态行：回合开始/完成/失败/停止（引擎 StateChange/Completed/Interrupted/Error 的投影面）。 */
export function formatStatusLine(kind: 'start' | 'done' | 'failed' | 'stopped', detail?: string): string {
  switch (kind) {
    case 'start':
      return `▶ 回合开始${detail ? ` · ${detail}` : ''}`;
    case 'done':
      return `✓ 回合完成${detail ? ` · ${detail}` : ''}`;
    case 'failed':
      return `⛔ 回合失败${detail ? ` · ${detail}` : ''}`;
    case 'stopped':
      return `⏹ 已停止${detail ? ` · ${detail}` : ''}`;
  }
}

/**
 * 事件采样器：从引擎事件流里挑出值得投影的离散事件，产状态/工具行；
 * TokenDelta 等高频事件只喂状态（tail 预览），产不出帧。
 * 放在 shared 是为了让网关测试也能复用同一套判定。
 */
export class BridgeProjector {
  private step = 0;
  private toolNow: string | undefined;
  private tail = '';

  /** 高频事件喂数据（TokenDelta/StateChange），不产帧。 */
  feed(event: EngineEvent): void {
    if (event.type === 'TokenDelta' && !event.payload.isToolCall) {
      this.tail = (this.tail + event.payload.content).slice(-200);
    }
  }

  /** 离散事件 → 帧（多数返回 undefined）。 */
  project(event: EngineEvent): BridgeFrame[] {
    switch (event.type) {
      case 'StateChange':
        if (event.payload.to === 'THINK') {
          this.step = 0;
          this.toolNow = undefined;
          this.tail = '';
          return [{ kind: 'status', text: formatStatusLine('start') }];
        }
        return [];
      case 'ToolStarted': {
        this.step += 1;
        this.toolNow = event.payload.toolName;
        const args = typeof event.payload.toolCallArgs === 'string' ? event.payload.toolCallArgs : JSON.stringify(event.payload.toolCallArgs ?? {});
        return [{ kind: 'tool', text: `#${this.step} ${formatToolLine(event.payload.toolName, args, undefined, true)}` }];
      }
      case 'ToolResult': {
        const ok = event.payload.result?.success !== false;
        const dur = event.payload.duration;
        const args = '';
        this.toolNow = undefined;
        return [{ kind: 'tool', text: `${formatToolLine(event.payload.toolName, args, dur, ok)}${ok ? '' : ' — ' + (event.payload.result?.error ?? '').slice(0, 120)}` }];
      }
      default:
        return [];
  }
  }

  /** 回合终局帧（Completed/Interrupted 由调用方分流后传进来，正文走 projectTurnText）。 */
  turnFrame(kind: 'turn' | 'error' | 'status', text: string): BridgeFrame {
    this.toolNow = undefined;
    return { kind, text };
  }

  snapshot(sessionId: string): BridgeSessionState {
    return { sessionId, running: this.toolNow !== undefined, ...(this.toolNow ? { toolNow: this.toolNow } : {}), step: this.step, tail: this.tail || undefined };
  }
}

// ---------- chatKey → 投递目标 ----------

/**
 * chatKey（channelId:accountId:peerKind:peerId[:threadId]）→ 通道投递目标。
 * peerId 段若自带冒号会被误拆——与 sessionViews.splitSessionKey 同一既定
 * 约定（现行五通道的 peer id 都不含冒号），不另设转义。
 */
export function targetFromChatKey(chatKey: string): { channelId: string; accountId: string; peerKind: 'dm' | 'group'; peerId: string; threadId?: string } | null {
  const segs = chatKey.split(':');
  if (segs.length < 4) return null;
  const [channelId, accountId, peerKind, ...rest] = segs;
  if (peerKind !== 'dm' && peerKind !== 'group') return null;
  if (segs.length >= 5) {
    return { channelId, accountId, peerKind: peerKind as 'dm' | 'group', peerId: rest[0], threadId: rest.slice(1).join(':') };
  }
  return { channelId, accountId, peerKind: peerKind as 'dm' | 'group', peerId: rest.join(':') };
}
