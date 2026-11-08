// src/channels/remoteBridgeServer.ts
// 遥控桥网关侧：独立 localhost WS 端点（/internal/bridge），GUI WebView 作为
// client 连入（docs/remote-session-control-2026-11.md 架构决策 2）。
//
// 不挂在 webchat 的 Bun.serve 上——遥控面不得依赖任何通道开关；也不复用
// health server——那条命只在 webchat 关闭时存在。独立 serve，端口三档退让
// （port → port+1 → 0 随机），实际端口写发现文件 bridge.json，GUI 靠它连接。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BridgeFrame, BridgeGatewayMessage, BridgeGuiMessage, BridgeSessionState } from '../shared/remoteBridge';

export interface RemoteBridgeOptions {
  host: string;
  port: number;
  /** 端口发现文件路径（~/.pure/channels/bridge.json）。 */
  discoverPath: string;
  log: (message: string) => void;
  now?: () => number;
  /** GUI 推投影帧上来（Gateway 接：查附着表分发到通道）。 */
  onProjection?: (sessionId: string, frame: BridgeFrame) => void;
  /** GUI 上报的会话运行状态（hello 全量 / state 增量，供 /sessions 合并）。 */
  onState?: (sessionId: string, state: BridgeSessionState) => void;
}

export interface RemoteBridge {
  start(): Promise<number | null>;
  stop(): void;
  /** 是否有至少一个 GUI 连着（状态真话：没有 GUI 时 inject/stop 如实不可达）。 */
  hasGui(): boolean;
  /** 广播给所有 GUI 连接。 */
  publish(message: BridgeGatewayMessage): void;
  /** 停止指令是否真的送达了 GUI（false=桌面离线，调用方如实回报）。 */
  stopSession(sessionId: string): boolean;
  /** GUI 上报的 live 会话状态（写回调之外供 /sessions 直接读）。 */
  liveSessions(): BridgeSessionState[];
}

const PING_INTERVAL_MS = 30_000;

export function createRemoteBridge(options: RemoteBridgeOptions): RemoteBridge {
  const now = options.now ?? Date.now;
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  const guiLive = new Map<string, BridgeSessionState>();
  let server: Bun.Server<unknown> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pingId = 0;
  let boundPort: number | null = null;

  function handleGuiMessage(raw: string): void {
    let msg: BridgeGuiMessage;
    try {
      msg = JSON.parse(raw) as BridgeGuiMessage;
    } catch {
      options.log(`bridge: dropped malformed gui message (${raw.length} bytes)`);
      return;
    }
    switch (msg.type) {
      case 'hello':
        guiLive.clear();
        for (const state of msg.sessions) guiLive.set(state.sessionId, state);
        break;
      case 'state':
        guiLive.set(msg.sessionId, msg.state);
        options.onState?.(msg.sessionId, msg.state);
        break;
      case 'projection':
        options.onProjection?.(msg.sessionId, msg.frame);
        break;
      case 'pong':
        break;
    }
  }

  async function tryBind(port: number): Promise<boolean> {
    try {
      server = Bun.serve({
        hostname: options.host,
        port,
        fetch: (req, server) => {
          const url = new URL(req.url);
          if (url.pathname === '/internal/bridge' && server.upgrade(req, { data: undefined })) return undefined;
          return new Response('not found', { status: 404 });
        },
        websocket: {
          open(socket) {
            sockets.add(socket);
            options.log(`bridge: gui connected (${sockets.size} total)`);
          },
          close(socket) {
            sockets.delete(socket);
            options.log(`bridge: gui disconnected (${sockets.size} total)`);
          },
          message(socket, raw) {
            void socket;
            if (typeof raw === 'string') handleGuiMessage(raw);
          },
        },
      });
      return true;
    } catch (err) {
      options.log(`bridge: bind :${port} failed (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }

  return {
    async start() {
      // 两档退让（port → port+1）。不退随机端口：Bun port:0 的 server.port
      // 返回 0 而非实际绑定值，发现文件会写错端口。
      if (await tryBind(options.port)) {
        boundPort = options.port;
      } else if (await tryBind(options.port + 1)) {
        boundPort = options.port + 1;
      }
      if (boundPort === null || !server) {
        options.log('bridge: all port attempts failed — remote control projection disabled this run');
        return null;
      }
      try {
        mkdirSync(dirname(options.discoverPath), { recursive: true });
        writeFileSync(options.discoverPath, JSON.stringify({ port: boundPort, startedAt: now() }, null, 2), 'utf8');
      } catch (err) {
        options.log(`bridge: discover file write failed (${err instanceof Error ? err.message : String(err)}) — GUI 侧将连不上`);
      }
      pingTimer = setInterval(() => {
        pingId += 1;
        for (const socket of sockets) {
          try {
            socket.send(JSON.stringify({ type: 'ping', id: pingId } satisfies BridgeGatewayMessage));
          } catch {
            // 写失败的下一次 close 事件会清理；这里不逐个处理。
          }
        }
      }, PING_INTERVAL_MS);
      if (typeof pingTimer.unref === 'function') pingTimer.unref();
      options.log(`bridge: listening on ${options.host}:${boundPort} (/internal/bridge)`);
      return boundPort;
    },
    stop() {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = undefined;
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // 已断的连接 close 再抛也无事可做。
        }
      }
      sockets.clear();
      try {
        server?.stop(true);
      } catch {
        // serve 已死时 stop 抛错无影响。
      }
      server = undefined;
      boundPort = null;
      try {
        rmSync(options.discoverPath, { force: true });
      } catch {
        // 发现文件删不掉只影响 GUI 的重连速度。
      }
    },
    hasGui() {
      return sockets.size > 0;
    },
    publish(message) {
      const line = JSON.stringify(message);
      for (const socket of sockets) {
        try {
          socket.send(line);
        } catch {
          // 单连接写失败不拖累其余连接。
        }
      }
    },
    stopSession(sessionId) {
      if (sockets.size === 0) return false;
      this.publish({ type: 'stop', sessionId });
      return true;
    },
    liveSessions() {
      return [...guiLive.values()];
    },
  };
}

/** 发现文件形状（GUI 侧读它找端口）。 */
export interface BridgeDiscoverInfo {
  port: number;
  startedAt: number;
}

export function bridgeDiscoverPath(pureDir: string): string {
  return join(pureDir, 'channels', 'bridge.json');
}
