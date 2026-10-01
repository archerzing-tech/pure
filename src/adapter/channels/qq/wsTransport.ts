// src/adapter/channels/qq/wsTransport.ts
// QQ 官方机器人的真实 transport：原生 WebSocket（入站）+ REST v2（出站）。
// 无 SDK 依赖 —— Bun 内建 WebSocket/fetch。连接模型与钉钉 Stream 同型：
// 出站长连接到平台（wss://api.sgroup.qq.com/websocket），不需要公网回调地址；
// 出站消息走 REST（被动回复：引用入站 msg_id + 递增 msg_seq，同一条入站最多
// 引用 5 次 —— 通道投影的分帧收敛在 chunk 数 ≤5 内由 chunkText 的长度上限保证）。
//
// 断线重连走全量 Identify（不实现 RESUME）：入站幂等由 gateway 的 messageId
// 去重兜底，出站走 REST 不经 WS，重连不丢语义。协议常量集中在顶部，实测
// 校准点见 cn-im-channels.md §7。
import type { QQRawMessage, QQTransport, QQTransportHandlers } from './types';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const WS_URL = 'wss://api.sgroup.qq.com/websocket';
/** 群/单聊事件 + 频道公开消息（C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE /
 *  AT_MESSAGE_CREATE / DIRECT_MESSAGE_CREATE）。 */
const INTENTS = (1 << 25) | (1 << 30);
/** 单条入站消息可被动回复的次数上限（平台限制 5）。 */
const MAX_PASSIVE_REPLIES = 5;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

export interface QQWsTransportOptions {
  appId: string;
  appSecret: string;
  log?: (message: string) => void;
  /** 注入点（单测用 WebSocket 假类 / fetch 桩）。 */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  fetchImpl?: typeof fetch;
}

/** 会话形态：回复路由（users/{openid} vs groups/{group_openid}）+ 被动回复锚。 */
interface ConversationMeta {
  kind: 'dm' | 'group';
  /** 最近一条入站 msg_id（被动回复引用它）。 */
  replyMsgId: string;
  /** 已引用次数（上限 MAX_PASSIVE_REPLIES，超过换下一条入站锚或拒发）。 */
  repliesUsed: number;
}

/** access_token 的取用与提前刷新（约 7200s，2/3 处刷新）。 */
class QQTokenKeeper {
  private token = '';
  private expiresAt = 0;
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number };
    if (!data.access_token) throw new Error(`QQ getAppAccessToken 失败：HTTP ${res.status}`);
    const ttl = Number(data.expires_in ?? 7200);
    this.token = data.access_token;
    this.expiresAt = Date.now() + Math.max(60, Math.floor(ttl * 1000 * 2 / 3));
    return this.token;
  }
}

export async function createQQWsTransport(options: QQWsTransportOptions): Promise<QQTransport> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  // Bun 的 WebSocket 运行时支持第三个参数带 headers，但 DOM lib 类型只有两个
  // 参数 —— 构造器收窄到真实签名，不用 any。
  type BunWebSocketCtor = new (url: string, protocols?: string, options?: { headers?: Record<string, string> }) => WebSocket;
  const wsFactory = options.wsFactory
    ?? ((url: string, headers: Record<string, string>) =>
      new (WebSocket as unknown as BunWebSocketCtor)(url, undefined, { headers }));
  const token = new QQTokenKeeper(options.appId, options.appSecret, fetchImpl);
  const conversations = new Map<string, ConversationMeta>();

  let ws: WebSocket | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let reconnectAttempt = 0;
  let connecting: Promise<void> | undefined;

  function sendOp(op: number, d: unknown): void {
    try {
      ws?.send(JSON.stringify({ op, d }));
    } catch {
      // 断线窗口的发送失败由重连兜底；出站消息本来就走 REST。
    }
  }

  /** WS 事件分发（op 0 Dispatch）。 */
  function dispatch(event: string, payload: unknown): void {
    if (event === 'READY') {
      reconnectAttempt = 0;
      log('qq websocket ready');
      return;
    }
    if (event === 'RESUMED') return;
    const p = payload as {
      id?: string;
      content?: string;
      timestamp?: string;
      author?: { id?: string; username?: string; member_openid?: string; open_id?: string };
      group_openid?: string;
      group_id?: string;
    };
    const text = typeof p.content === 'string' ? p.content.trim() : '';
    const isC2C = event === 'C2C_MESSAGE_CREATE';
    const isGroup = event === 'GROUP_AT_MESSAGE_CREATE';
    const isGuild = event === 'AT_MESSAGE_CREATE' || event === 'DIRECT_MESSAGE_CREATE';
    if (!isC2C && !isGroup && !isGuild) return;
    const conversationId = isGroup ? p.group_openid : (p.author?.open_id ?? p.author?.id ?? '');
    if (!p.id || !conversationId || !text) return;
    const raw: QQRawMessage = {
      messageId: p.id,
      conversationId,
      conversationType: isGroup ? 'group' : 'dm',
      text,
      authorId: p.author?.member_openid ?? p.author?.id ?? '',
      authorName: p.author?.username,
      replyMsgId: p.id,
      createTime: p.timestamp ? Date.parse(p.timestamp) || Date.now() : Date.now(),
    };
    const meta = conversations.get(conversationId);
    if (meta) {
      meta.replyMsgId = p.id;
      meta.repliesUsed = 0;
    } else {
      conversations.set(conversationId, { kind: raw.conversationType, replyMsgId: p.id, repliesUsed: 0 });
    }
    handlersRef?.onMessage(raw);
  }

  let handlersRef: QQTransportHandlers | undefined;

  async function connect(): Promise<void> {
    const accessToken = await token.get();
    const socket = wsFactory(WS_URL, { Authorization: `QQBot ${accessToken}` });
    ws = socket;
    socket.addEventListener('open', () => {
      sendOp(2, {
        token: `QQBot ${accessToken}`,
        intents: INTENTS,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'pure', $device: 'pure' },
      });
    });
    socket.addEventListener('message', (ev) => {
      let frame: { op?: number; s?: number; t?: string; d?: unknown };
      try {
        frame = JSON.parse(String(ev.data)) as typeof frame;
      } catch {
        return;
      }
      if (frame.op === 10) {
        const interval = Number((frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 30_000);
        heartbeatTimer = setInterval(() => sendOp(1, Date.now()), Math.max(5_000, interval));
      } else if (frame.op === 11) {
        // heartbeat ack —— 什么都不用做
      } else if (frame.op === 0 && frame.t) {
        dispatch(frame.t, frame.d);
      } else if (frame.op === 7) {
        log('qq websocket server requested reconnect');
        socket.close();
      }
    });
    socket.addEventListener('close', () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      ws = undefined;
      if (stopped) return;
      const backoff = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
      reconnectAttempt++;
      log(`qq websocket closed — reconnecting in ${backoff / 1000}s`);
      setTimeout(() => {
        connecting = connect().catch((err) => log(`qq reconnect failed: ${err instanceof Error ? err.message : String(err)}`));
      }, backoff);
    });
  }

  /** REST 头（v2 接口要求带 union appid）。 */
  async function restHeaders(): Promise<Record<string, string>> {
    const accessToken = await token.get();
    return {
      'content-type': 'application/json',
      Authorization: `QQBot ${accessToken}`,
      'X-Union-Appid': options.appId,
    };
  }

  /** 取该会话的被动回复锚（msg_id + 递增 msg_seq）。超限换新锚或失败。 */
  function replyAnchor(conversationId: string): { msg_id: string; msg_seq: number } | undefined {
    const meta = conversations.get(conversationId);
    if (!meta) return undefined;
    if (meta.repliesUsed >= MAX_PASSIVE_REPLIES) return undefined;
    meta.repliesUsed++;
    return { msg_id: meta.replyMsgId, msg_seq: meta.repliesUsed };
  }

  async function postMessage(conversationId: string, body: Record<string, unknown>): Promise<void> {
    const meta = conversations.get(conversationId);
    const url = meta?.kind === 'group'
      ? `${API_BASE}/v2/groups/${encodeURIComponent(conversationId)}/messages`
      : `${API_BASE}/v2/users/${encodeURIComponent(conversationId)}/messages`;
    const res = await fetchImpl(url, { method: 'POST', headers: await restHeaders(), body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`QQ POST ${url} 返回 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
  }

  return {
    async start(handlers: QQTransportHandlers): Promise<void> {
      handlersRef = handlers;
      stopped = false;
      await (connecting = connect());
      log('qq transport started');
    },

    async stop(): Promise<void> {
      stopped = true;
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      try { ws?.close(); } catch { /* ignore */ }
      ws = undefined;
    },

    async sendText(conversationId: string, text: string): Promise<string> {
      const anchor = replyAnchor(conversationId);
      if (!anchor) {
        throw new Error(`qq: 无可引用的入站消息（会话 ${conversationId} 的被动回复额度已用尽或无锚）`);
      }
      await postMessage(conversationId, {
        content: text,
        msg_type: 0,
        msg_id: anchor.msg_id,
        msg_seq: anchor.msg_seq,
      });
      return `qq_${anchor.msg_id}_${anchor.msg_seq}`;
    },

    async sendImage(conversationId: string, image: Uint8Array, name: string): Promise<string> {
      const meta = conversations.get(conversationId);
      const accessToken = await token.get();
      const form = new FormData();
      form.append('file_type', '1');
      form.append('file_image', new Blob([new Uint8Array(image)], { type: 'image/png' }), name || 'diagram.png');
      const url = meta?.kind === 'group'
        ? `${API_BASE}/v2/groups/${encodeURIComponent(conversationId)}/files`
        : `${API_BASE}/v2/users/${encodeURIComponent(conversationId)}/files`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'X-Union-Appid': options.appId },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { file_uuid?: string; file_info?: string; message?: string };
      const fileInfo = data.file_info ?? (data.file_uuid ? `uuid://${data.file_uuid}` : undefined);
      if (!fileInfo) throw new Error(`QQ 图片上传失败：${data.message ?? `HTTP ${res.status}`}`);
      const anchor = replyAnchor(conversationId);
      if (!anchor) throw new Error(`qq: 图片回复无锚（会话 ${conversationId}）`);
      await postMessage(conversationId, {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_id: anchor.msg_id,
        msg_seq: anchor.msg_seq,
      });
      return `qq_img_${anchor.msg_id}_${anchor.msg_seq}`;
    },
  };
}
