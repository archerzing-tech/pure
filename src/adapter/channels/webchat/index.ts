// src/adapter/channels/webchat/index.ts
// 自带的零依赖通道（设计文档 §8：Phase 0 用它打通端到端，也是没公网时的兜底）。
// 一个极简页面 + WebSocket：没有飞书/企微的时限与频控，是最干净的参考实现。
//
// 适配器只做「平台协议 ↔ 规范类型」，不做渲染、分片、权限判断。
// 2026-10-11 起页面多一个「会话」栏（手机看服务端哪些会话在跑），数据走
// 同端口两个只读端点；options.sessions 缺省时端点 404，老宿主零感知。
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
import type { SessionView } from '../../../shared/node/sessionViews';
import type { TimelineEntry } from '../../../shared/sessionEventLog';

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
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>pure webchat</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 16px; }
  #tabs { display: flex; gap: 8px; margin-bottom: 12px; }
  .tab { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fafafa; font-size: 15px; }
  .tab.on { background: #d7f0ff; border-color: #8ccdee; font-weight: 600; }
  #log { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .bubble { padding: 8px 12px; border-radius: 10px; background: #f2f2f2; white-space: pre-wrap; word-break: break-word; }
  .bubble img.att { max-width: 100%; display: block; margin-top: 6px; border-radius: 8px; }
  .me { align-self: flex-end; background: #d7f0ff; }
  form { display: flex; gap: 8px; }
  input { flex: 1; padding: 8px; font-size: 15px; }
  button { padding: 8px 14px; }
  #status { color: #888; font-size: 13px; margin-bottom: 8px; }
  .sess { padding: 10px 12px; border: 1px solid #e2e2e2; border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
  .sess:active { background: #f4f4f4; }
  .sess .row1 { display: flex; align-items: center; gap: 8px; }
  .sess .meta { color: #888; font-size: 13px; margin-top: 2px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.running { background: #2fa66a; }
  .dot.settled { background: #b5b5b5; }
  .dot.failed { background: #d5493f; }
  .dot.idle { background: #d8d8d8; }
  .tl-entry { padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; word-break: break-word; }
  .tl-ts { color: #999; font-size: 12px; margin-right: 6px; }
  #back { margin: 0 0 10px; }
</style></head>
<body>
<div id="tabs">
  <button class="tab on" id="tab-chat" type="button">对话</button>
  <button class="tab" id="tab-sess" type="button">会话</button>
</div>
<div id="view-chat">
  <div id="status">连接中…</div>
  <div id="log"></div>
  <form id="composer"><input id="text" autocomplete="off" placeholder="说点什么…"><button>发送</button></form>
</div>
<div id="view-sess" hidden>
  <div id="sess-head" style="display:none"><button id="back" type="button">← 返回列表</button></div>
  <div id="sess-list">加载中…</div>
</div>
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

  // ── 会话总览：哪些会话在跑 / 落定了，点进去看时间线 ──
  const sessList = document.getElementById('sess-list');
  const sessHead = document.getElementById('sess-head');
  const views = { chat: document.getElementById('view-chat'), sess: document.getElementById('view-sess') };
  let timelineOpen = false;
  function switchTab(name) {
    document.getElementById('tab-chat').className = 'tab' + (name === 'chat' ? ' on' : '');
    document.getElementById('tab-sess').className = 'tab' + (name === 'sess' ? ' on' : '');
    views.chat.hidden = name !== 'chat';
    views.sess.hidden = name !== 'sess';
  }
  document.getElementById('tab-chat').addEventListener('click', () => switchTab('chat'));
  document.getElementById('tab-sess').addEventListener('click', () => { switchTab('sess'); loadSessions(); });
  function fmtAge(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.round(s) + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }
  function sessTitle(s) {
    let t = s.surface || '?';
    if (s.peer) t += ' · ' + s.peer;
    return t;
  }
  function loadSessions() {
    timelineOpen = false;
    sessHead.style.display = 'none';
    sessList.textContent = '加载中…';
    fetch('/sessions').then((r) => r.json()).then((items) => {
      if (timelineOpen) return;
      sessList.textContent = '';
      if (!items.length) { sessList.textContent = '还没有会话'; return; }
      items.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'sess';
        const row1 = document.createElement('div');
        row1.className = 'row1';
        const dot = document.createElement('span');
        dot.className = 'dot ' + (s.status || 'idle');
        const title = document.createElement('span');
        title.textContent = sessTitle(s);
        row1.appendChild(dot);
        row1.appendChild(title);
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (s.statusDetail || s.status || '') + (s.lastActivityAt ? ' · ' + fmtAge(s.lastActivityAt) : '');
        card.appendChild(row1);
        card.appendChild(meta);
        card.addEventListener('click', () => loadTimeline(s.sessionId));
        sessList.appendChild(card);
      });
    }).catch(() => { if (!timelineOpen) sessList.textContent = '加载失败'; });
  }
  function loadTimeline(id) {
    timelineOpen = true;
    sessHead.style.display = '';
    sessList.textContent = '加载中…';
    fetch('/sessions/' + encodeURIComponent(id) + '/timeline').then((r) => r.json()).then((entries) => {
      if (!timelineOpen) return;
      sessList.textContent = '';
      if (!entries.length) { sessList.textContent = '暂无事件'; return; }
      entries.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'tl-entry';
        const ts = document.createElement('span');
        ts.className = 'tl-ts';
        const d = new Date(e.ts);
        const pad = (n) => (n < 10 ? '0' + n : '' + n);
        ts.textContent = (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        const body = document.createElement('span');
        body.textContent = e.summary || e.kind || '';
        row.appendChild(ts);
        row.appendChild(body);
        sessList.appendChild(row);
      });
    }).catch(() => { if (timelineOpen) sessList.textContent = '加载失败'; });
  }
  document.querySelector('#sess-head button').addEventListener('click', loadSessions);
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

/** 手机端「会话」栏的数据源（实现：shared/node/sessionViews，宿主注入）。 */
export interface WebChatSessionsApi {
  /** 总览（通道索引 ∪ 事件目录，最近活动倒序）。 */
  list(): SessionView[];
  /** 单会话时间线投影；未知 id 返回空数组。 */
  timeline(sessionId: string): TimelineEntry[];
}

export interface WebChatOptions {
  host: string;
  port: number;
  /** 缺省 = /sessions 两端点 404（老宿主零感知）。 */
  sessions?: WebChatSessionsApi;
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
            // 只读会话总览/时间线（手机端「会话」栏）。缺数据源一律 404。
            if (url.pathname === '/sessions' && options.sessions) {
              return Response.json(options.sessions.list());
            }
            const timelineMatch = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]+)\/timeline$/);
            if (timelineMatch && options.sessions) {
              return Response.json(options.sessions.timeline(timelineMatch[1]));
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
