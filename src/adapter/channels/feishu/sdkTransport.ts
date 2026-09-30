// src/adapter/channels/feishu/sdkTransport.ts
// 官方 SDK（@larksuiteoapi/node-sdk ≥1.24.0）上的飞书 transport。**动态 import**
// —— 未启用 feishu 通道时这个模块一行都不加载，SDK 不进 CLI/GUI 的其它路径。
//
// 长连接注意事项（README + 设计文档 §2.2）：
// 1) 建连时鉴权，后续事件明文，无需解密/验签；
// 2) 收到事件必须 3 秒内处理完，否则平台重推 → 宿主必须先 ack 再跑 agent（已由
//    renderer 的占位策略 + gateway 去重承接）；
// 3) 集群模式不广播，且文档明确「长连接仅支持事件订阅、不支持回调订阅」→ 卡片
//    按钮回调在长连接下不保证送达，所以审批必须永远同时给文字指令（双轨）。
import type { FeishuRawMessage, FeishuTransport, FeishuTransportHandlers } from './types';

// ── 依赖的最小 SDK 形状（避免把 SDK 类型带进项目类型图） ──

interface LarkMessageResource {
  create(args: unknown): Promise<unknown>;
  patch(args: unknown): Promise<unknown>;
}

interface LarkImageResource {
  create(args: unknown): Promise<unknown>;
}

interface LarkClientShape {
  im: {
    message: LarkMessageResource;
    image?: LarkImageResource;
    v1?: { message: LarkMessageResource; image?: LarkImageResource };
  };
}

interface LarkModuleShape {
  Client: new (config: { appId: string; appSecret: string }) => LarkClientShape;
  WSClient: new (config: { appId: string; appSecret: string; loggerLevel?: unknown }) => {
    start(options: { eventDispatcher: unknown }): void;
    stop?(): void;
  };
  EventDispatcher: new (config: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => unknown>): unknown;
  };
  LoggerLevel?: { info?: unknown };
}

export interface FeishuSdkTransportOptions {
  appId: string;
  appSecret: string;
  /** 机器人 open_id；有它才能精确判断群消息是否 @ 了机器人。 */
  botOpenId?: string;
  log?: (message: string) => void;
}

function messageResource(client: LarkClientShape): LarkMessageResource {
  const resource = client.im.message ?? client.im.v1?.message;
  if (!resource) throw new Error('feishu SDK shape mismatch: im.message is unavailable');
  return resource;
}

function messageIdOf(res: unknown): string {
  const r = res as { data?: { message_id?: string }; message_id?: string } | undefined;
  return r?.data?.message_id ?? r?.message_id ?? '';
}

/** 从 text / post 的 content JSON 里抽纯文本。 */
export function extractFeishuText(messageType: string, rawContent: unknown): string {
  let content: unknown = rawContent;
  if (typeof rawContent === 'string') {
    try { content = JSON.parse(rawContent); } catch { return rawContent; }
  }
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (messageType === 'text') {
    return typeof obj.text === 'string' ? obj.text : '';
  }
  if (messageType === 'post') {
    // { post: { zh_cn: { title, content: [[{tag,text}...]] } } }
    const post = obj.post as Record<string, { title?: string; content?: Array<Array<{ text?: string }>> }> | undefined;
    const locale = post?.zh_cn ?? post?.en_us ?? (post ? Object.values(post)[0] : undefined);
    if (!locale) return '';
    const lines = (locale.content ?? []).map((line) => line.map((seg) => seg.text ?? '').join(''));
    return [locale.title ?? '', ...lines].filter(Boolean).join('\n');
  }
  return '';
}

function toRawMessage(data: unknown, botOpenId?: string): FeishuRawMessage | null {
  const payload = data as {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      root_id?: string;
      mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
    };
    sender?: { sender_id?: { open_id?: string } };
  };
  const message = payload?.message;
  if (!message?.message_id || !message.chat_id) return null;
  const mentions = message.mentions ?? [];
  const mentionsBot = botOpenId
    ? mentions.some((m) => m.id?.open_id === botOpenId)
    : mentions.length > 0; // 拿不到机器人 open_id 时保守地「有任何 @ 就算」（见待实测清单）
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    messageType: message.message_type ?? 'text',
    text: extractFeishuText(message.message_type ?? 'text', message.content ?? ''),
    mentionsBot,
    senderId: payload.sender?.sender_id?.open_id ?? '',
    threadId: message.root_id,
  };
}

export async function createFeishuSdkTransport(options: FeishuSdkTransportOptions): Promise<FeishuTransport> {
  const specifier = '@larksuiteoapi/node-sdk';
  let mod: LarkModuleShape;
  try {
    mod = (await import(specifier)) as unknown as LarkModuleShape;
  } catch (err) {
    throw new Error(
      `飞书通道需要 @larksuiteoapi/node-sdk（≥1.24.0）：${err instanceof Error ? err.message : String(err)}。` +
      '请运行 bun add @larksuiteoapi/node-sdk 后重启 gateway。',
    );
  }
  const log = options.log ?? (() => {});
  const client = new mod.Client({ appId: options.appId, appSecret: options.appSecret });
  const ws = new mod.WSClient({ appId: options.appId, appSecret: options.appSecret, loggerLevel: mod.LoggerLevel?.info });

  return {
    async start(handlers: FeishuTransportHandlers): Promise<void> {
      const dispatcher = new mod.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
          const raw = toRawMessage(data, options.botOpenId);
          if (!raw) {
            handlers.log('ignoring feishu event without a usable message payload');
            return;
          }
          handlers.onMessage(raw);
        },
      });
      ws.start({ eventDispatcher: dispatcher });
      log('feishu WSClient started (long connection)');
    },

    async stop(): Promise<void> {
      try { ws.stop?.(); } catch { /* ignore */ }
    },

    async sendText(chatId: string, text: string): Promise<string> {
      const resource = messageResource(client);
      const res = await resource.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
      });
      return messageIdOf(res);
    },

    async sendCard(chatId: string, card: unknown): Promise<string> {
      const resource = messageResource(client);
      const res = await resource.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify(card), msg_type: 'interactive' },
      });
      return messageIdOf(res);
    },

    async patchCard(messageId: string, card: unknown): Promise<void> {
      const resource = messageResource(client);
      await resource.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },

    async sendImage(chatId: string, image: Uint8Array, _name: string): Promise<string> {
      const imageResource = client.im.image ?? client.im.v1?.image;
      if (!imageResource) throw new Error('feishu SDK shape mismatch: im.image is unavailable');
      const uploaded = await imageResource.create({
        data: { image_type: 'message', image: Buffer.from(image) },
      });
      const imageKey = (uploaded as { data?: { image_key?: string } })?.data?.image_key;
      if (!imageKey) throw new Error('feishu image upload returned no image_key');
      const res = await messageResource(client).create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ image_key: imageKey }), msg_type: 'image' },
      });
      return messageIdOf(res);
    },
  };
}
