// src/adapter/channels/webchat/index.ts
// 自带的零依赖通道（设计文档 §8：Phase 0 用它打通端到端，也是没公网时的兜底）。
// 一个极简页面 + WebSocket：没有飞书/企微的时限与频控，是最干净的参考实现。
//
// 适配器只做「平台协议 ↔ 规范类型」，不做渲染、分片、权限判断。
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelRuntimeContext,
  ChannelTarget,
  InboundEvent,
  LocalMedia,
  MediaRef,
  OutboundMessage,
  SendOptions,
  SendResult,
} from '../../../channels/types';

type ClientData = { peer: string };

interface WireFrame {
  type: 'message' | 'typing' | 'error';
  id?: string;
  text?: string;
  final?: boolean;
  on?: boolean;
  attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>;
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>pure webchat</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 16px; }
  #log { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .bubble { padding: 8px 12px; border-radius: 10px; background: #f2f2f2; white-space: pre-wrap; word-break: break-word; }
  .bubble img.att { max-width: 100%; display: block; margin-top: 6px; border-radius: 8px; }
  .me { align-self: flex-end; background: #d7f0ff; }
  form { display: flex; gap: 8px; }
  input { flex: 1; padding: 8px; font-size: 15px; }
  button { padding: 8px 14px; }
  #status { color: #888; font-size: 13px; margin-bottom: 8px; }
</style></head>
<body>
<div id="status">连接中…</div>
<div id="log"></div>
<form id="composer"><input id="text" autocomplete="off" placeholder="说点什么…"><button>发送</button></form>
<script>
  const peerKey = 'pure-webchat-peer';
  let peer = localStorage.getItem(peerKey);
  if (!peer) { peer = 'web-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(peerKey, peer); }
  const log = document.getElementById('log');
  const status = document.getElementById('status');
  const bubbles = new Map();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws?peer=' + encodeURIComponent(peer));
  function bubble(id) {
    if (bubbles.has(id)) return bubbles.get(id);
    const el = document.createElement('div');
    el.className = 'bubble';
    log.appendChild(el);
    bubbles.set(id, el);
    return el;
  }
  ws.onopen = () => { status.textContent = '已连接（peer ' + peer + '）'; };
  ws.onclose = () => { status.textContent = '连接已断开'; };
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'typing') { status.textContent = frame.on ? '对方正在输入…' : '已连接'; return; }
    if (frame.type === 'message' && frame.id) {
      const el = bubble(frame.id);
      el.textContent = frame.text || '';
      el.querySelectorAll('img.att').forEach((node) => node.remove());
      (frame.attachments || []).forEach((att) => {
        const img = document.createElement('img');
        img.className = 'att';
        img.src = 'data:' + att.mimeType + ';base64,' + att.dataBase64;
        el.appendChild(img);
      });
      if (frame.final) status.textContent = '已连接';
    }
  };
  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const el = document.createElement('div');
    el.className = 'bubble me';
    el.textContent = text;
    log.appendChild(el);
    ws.send(JSON.stringify({ text }));
  });
</script>
</body></html>`;

export const WEBCHAT_CAPABILITIES: ChannelCapabilities = {
  chatTypes: ['dm', 'group'],
  media: { files: true, images: true },
  canDeliverImages: true,
  streaming: 'edit',
  maxTextLength: 8000,
  markdown: 'basic',
  typing: true,
  editMessages: true,
  requiresMentionInGroup: false,
};

export interface WebChatOptions {
  host: string;
  port: number;
}

export function createWebChatAdapter(options: WebChatOptions): ChannelAdapter {
  const clients = new Map<string, Bun.ServerWebSocket<ClientData>>();
  let server: Bun.Server<ClientData> | undefined;
  let seq = 0;

  function frameFor(msg: OutboundMessage, id: string): WireFrame {
    return {
      type: 'message',
      id: msg.messageId ?? id,
      text: msg.text,
      final: msg.final === true,
      attachments: msg.attachments?.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        dataBase64: Buffer.from(a.data).toString('base64'),
      })),
    };
  }

  function push(target: ChannelTarget, msg: OutboundMessage): string {
    const messageId = msg.messageId ?? `wcmsg_${++seq}`;
    const ws = clients.get(target.peerId);
    if (ws) ws.send(JSON.stringify(frameFor(msg, messageId)));
    return messageId;
  }

  return {
    id: 'webchat',
    capabilities: WEBCHAT_CAPABILITIES,

    async send(target: ChannelTarget, msg: OutboundMessage, _opts?: SendOptions): Promise<SendResult> {
      return { messageId: push(target, msg) };
    },

    async editMessage(target: ChannelTarget, messageId: string, msg: OutboundMessage): Promise<void> {
      push(target, { ...msg, messageId });
    },

    async setTyping(target: ChannelTarget, on: boolean): Promise<void> {
      clients.get(target.peerId)?.send(JSON.stringify({ type: 'typing', on } satisfies WireFrame));
    },

    async downloadMedia(_ref: MediaRef): Promise<LocalMedia> {
      throw new Error('webchat does not serve inbound media yet');
    },

    async start(context: ChannelRuntimeContext): Promise<void> {
      try {
        server = Bun.serve<ClientData>({
          hostname: options.host,
          port: options.port,
          fetch(req, srv) {
            const url = new URL(req.url);
            // 端口契约（2026-10-01）：网关在跑就必答 /healthz——探活/连通性测试
            // 不依赖 webchat 是否被禁用（禁用时由 cliChannels 的极简应答器答）。
            if (url.pathname === '/healthz') {
              return new Response('ok', { headers: { 'content-type': 'text/plain' } });
            }
            if (url.pathname === '/ws') {
              const peer = url.searchParams.get('peer') || `web-${Math.random().toString(36).slice(2, 10)}`;
              if (srv.upgrade(req, { data: { peer } })) return undefined;
              return new Response('websocket upgrade failed', { status: 400 });
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
              return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }
            return new Response('not found', { status: 404 });
          },
          websocket: {
            open(ws) {
              clients.set(ws.data.peer, ws);
              context.log(`webchat client connected: ${ws.data.peer}`);
            },
            message(ws, data) {
              const text = typeof data === 'string' ? data : data.toString();
              let parsed: { text?: unknown; id?: unknown };
              try {
                parsed = JSON.parse(text);
              } catch {
                return;
              }
              const body = typeof parsed.text === 'string' ? parsed.text : '';
              if (!body.trim()) return;
              const event: InboundEvent = {
                kind: 'message',
                channelId: 'webchat',
                accountId: context.accountId,
                peer: { id: ws.data.peer, kind: 'dm', name: ws.data.peer },
                messageId: typeof parsed.id === 'string' ? parsed.id : `web_in_${++seq}`,
                text: body,
                attachments: [],
                receivedAt: Date.now(),
              };
              context.onInbound(event);
            },
            close(ws) {
              clients.delete(ws.data.peer);
              context.log(`webchat client disconnected: ${ws.data.peer}`);
            },
          },
        });
      } catch (err) {
        throw new Error(`webchat failed to bind ${options.host}:${options.port}: ${err instanceof Error ? err.message : String(err)}`);
      }
      context.log(`webchat listening on http://${options.host}:${options.port}`);
    },

    async stop(): Promise<void> {
      try {
        server?.stop(true);
      } catch {
        // already stopped
      }
      server = undefined;
      clients.clear();
    },

    listAccountIds(): string[] {
      return ['default'];
    },
  };
}
