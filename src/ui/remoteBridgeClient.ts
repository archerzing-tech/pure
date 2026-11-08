// src/ui/remoteBridgeClient.ts
// 遥控桥 GUI 侧（docs/remote-session-control-2026-11.md 架构决策 2/4）：
// WebView 作为 WS client 连入网关 /internal/bridge，做三件事——
// ① 投影出站：chat.ts 事件循环里 tap 一下，离散引擎事件组帧发网关；
// ② 指挥注入：网关 inject/stop 落 ChatController（interject 内部自带
//    空闲=新回合/跑动=插话分流；stop 与桌面按钮同款 escapeWhileStreaming）；
// ③ live 状态上报：hello 批量 + state 增量（/sessions 列表的「正在跑什么」）。
//
// 纪律：这条链上任何异常都不许影响桌面主渲染——tap 与消息处理全部 try 包裹；
// 多窗口都连着桥时 inject 用 localStorage 幂等集去重（同源共享，天然跨窗口）。
import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import {
  BridgeProjector,
  projectTurnText,
  formatStatusLine,
  type BridgeFrame,
  type BridgeGatewayMessage,
  type BridgeGuiMessage,
  type BridgeSessionState,
} from '../shared/remoteBridge';
import type { EngineEvent } from '../shared/types';
import { runningSessionIdList, type SessionChatManager } from './chat';

interface RemoteBridgeDeps {
  manager: SessionChatManager;
  log?: (message: string) => void;
}

const RECONNECT_MAX_MS = 30_000;
const IDEMPOTENT_MAX = 200;

class RemoteBridgeClient {
  private ws: WebSocket | null = null;
  private reconnectMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private projectors = new Map<string, BridgeProjector>();
  private runningLive = new Map<string, BridgeSessionState>();
  private readonly processedInjects = new Set<string>();
  private readonly manager: SessionChatManager;
  private readonly log: (message: string) => void;

  constructor(deps: RemoteBridgeDeps) {
    this.manager = deps.manager;
    this.log = deps.log ?? ((m) => console.info(`[remote-bridge] ${m}`));
    // 幂等集初值从 localStorage 恢复（窗口重启后仍能挡住重放的旧 inject）。
    try {
      const saved = JSON.parse(localStorage.getItem('pure_bridge_injects') ?? '[]') as string[];
      for (const id of saved) this.processedInjects.add(id);
    } catch {
      // 坏了就当空集：幂等降级，不挡使用。
    }
  }

  start(): void {
    if (!isTauriRuntime()) return; // 非 Tauri（纯 web 预览）没有网关可连。
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      // 已断的连接 close 再抛也无事可做。
    }
    this.ws = null;
  }

  /** chat.ts 事件循环的投影缝：每个引擎事件 tap 一下，异常绝不外泄。 */
  tap(sessionId: string, event: EngineEvent): void {
    try {
      const projector = this.projectorFor(sessionId);
      projector.feed(event);
      const frames = projector.project(event);
      for (const frame of frames) this.sendProjection(sessionId, frame);
      this.maybeSendState(sessionId, projector);
      if (event.type === 'Completed') {
        const output = typeof event.payload.finalOutput === 'string' ? event.payload.finalOutput : '';
        void projectTurnText(output).then(({ text, notes }) => {
          const joined = notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text;
          this.sendProjection(sessionId, projector.turnFrame('turn', joined || formatStatusLine('done')));
        }).catch(() => {});
        this.runningLive.delete(sessionId);
        this.sendState(sessionId, { sessionId, running: false });
      } else if (event.type === 'Interrupted') {
        this.sendProjection(sessionId, projector.turnFrame('status', formatStatusLine('stopped', event.payload.reason)));
        this.runningLive.delete(sessionId);
        this.sendState(sessionId, { sessionId, running: false });
      } else if (event.type === 'Error' && event.payload.recoverable === false) {
        this.sendProjection(sessionId, projector.turnFrame('error', formatStatusLine('failed', event.payload.message.slice(0, 160))));
      }
    } catch {
      // 投影是旁路：任何异常都不许进主渲染路径。
    }
  }

  /** 注入后桌面侧确认（手机端「已受理」一行，状态真话）。 */
  private acknowledge(sessionId: string, text: string): void {
    this.sendProjection(sessionId, { kind: 'status', text: `📱 ${text}` });
  }

  private async handleInject(msg: Extract<BridgeGatewayMessage, { type: 'inject' }>): Promise<void> {
    if (this.processedInjects.has(msg.msgId)) return;
    this.processedInjects.add(msg.msgId);
    if (this.processedInjects.size > IDEMPOTENT_MAX) {
      const first = this.processedInjects.values().next().value;
      if (first) this.processedInjects.delete(first);
    }
    try {
      localStorage.setItem('pure_bridge_injects', JSON.stringify([...this.processedInjects].slice(-IDEMPOTENT_MAX)));
    } catch {
      // 存不进去只影响跨窗口幂等，单窗口仍安全。
    }
    try {
      const controller = this.manager.controllerFor(msg.sessionId) ?? this.manager.openSession(msg.sessionId).controller;
      this.acknowledge(msg.sessionId, `已受理：${msg.text.slice(0, 80)}`);
      await controller.interject(msg.text);
    } catch (err) {
      this.log(`inject failed: ${err instanceof Error ? err.message : String(err)}`);
      this.sendProjection(msg.sessionId, { kind: 'error', text: `📱 指令送达失败（${err instanceof Error ? err.message : '会话打不开'}）` });
    }
  }

  private handleStop(msg: Extract<BridgeGatewayMessage, { type: 'stop' }>): void {
    try {
      const controller = this.manager.controllerFor(msg.sessionId) ?? this.manager.openSession(msg.sessionId).controller;
      // 与桌面 ⏹/Esc 同款两段式：第一段暂停，pausing 态再收一次 = 硬停。
      controller.escapeWhileStreaming();
      this.acknowledge(msg.sessionId, '已执行停止（第一段=暂停，再发一次 /stop = 硬停）');
    } catch (err) {
      this.log(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleMessage(raw: string): void {
    let msg: BridgeGatewayMessage;
    try {
      msg = JSON.parse(raw) as BridgeGatewayMessage;
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'inject':
          void this.handleInject(msg);
          break;
        case 'stop':
          this.handleStop(msg);
          break;
        case 'ping':
          this.send({ type: 'pong', id: msg.id });
          break;
        case 'query_status': {
          const projector = this.projectors.get(msg.sessionId);
          this.sendProjection(msg.sessionId, projector ? { kind: 'status', text: JSON.stringify(projector.snapshot(msg.sessionId)) } : { kind: 'status', text: '（本窗口未打开该会话，无实时状态）' });
          break;
        }
        case 'query_backfill':
          // 回填第 6 步接 transcriptProjection；现在如实回「暂无回填」。
          this.sendProjection(msg.sessionId, { kind: 'status', text: '（回填尚未接通，之后的动态会实时推送）' });
          break;
      }
    } catch {
      // 单条消息处理失败不影响连接与其余消息。
    }
  }

  private projectorFor(sessionId: string): BridgeProjector {
    let projector = this.projectors.get(sessionId);
    if (!projector) {
      projector = new BridgeProjector();
      this.projectors.set(sessionId, projector);
    }
    return projector;
  }

  private sendProjection(sessionId: string, frame: BridgeFrame): void {
    this.send({ type: 'projection', sessionId, frame });
  }

  private maybeSendState(sessionId: string, projector: BridgeProjector): void {
    const snap = projector.snapshot(sessionId);
    const prev = this.runningLive.get(sessionId);
    const changed =
      !prev ||
      prev.running !== (snap.toolNow !== undefined || (snap.step ?? 0) > 0) ||
      prev.toolNow !== snap.toolNow ||
      prev.step !== snap.step;
    if (changed) this.sendState(sessionId, snap);
  }

  private sendState(sessionId: string, state: BridgeSessionState): void {
    this.runningLive.set(sessionId, state);
    this.send({ type: 'state', sessionId, state });
  }

  private send(msg: BridgeGuiMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // 写失败由 close→重连路径处理。
    }
  }

  private sendHello(): void {
    const sessions: BridgeSessionState[] = [];
    for (const id of runningSessionIdList()) {
      sessions.push({ sessionId: id, running: true });
    }
    for (const [sessionId, state] of this.runningLive) {
      if (!sessions.some((s) => s.sessionId === sessionId)) sessions.push(state);
    }
    this.send({ type: 'hello', sessions });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let port: number | null = null;
    try {
      port = (await tauriInvoke<number | null>('bridge_port')) ?? null;
    } catch {
      port = null;
    }
    if (port === null) {
      // 没有网关在跑（bridge.json 不存在）：如实不连，低频重试等它起来。
      this.scheduleReconnect();
      return;
    }
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/bridge`);
      ws.addEventListener('open', () => {
        this.ws = ws;
        this.reconnectMs = 1000;
        this.log(`connected to gateway bridge :${port}`);
        this.sendHello();
      });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') this.handleMessage(ev.data);
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // error 后的 close 由 close 事件处理。
        }
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}

let client: RemoteBridgeClient | null = null;

/** main.ts 装配点：整个 app 一条桥。 */
export function startRemoteBridge(manager: SessionChatManager): void {
  if (client) return;
  client = new RemoteBridgeClient({ manager });
  client.start();
}

/** chat.ts 事件循环的投影缝（未装配时是空操作）。 */
export function remoteBridgeTap(sessionId: string, event: EngineEvent): void {
  client?.tap(sessionId, event);
}
