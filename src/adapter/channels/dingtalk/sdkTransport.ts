// src/adapter/channels/dingtalk/sdkTransport.ts
// 官方 dingtalk-stream SDK 上的钉钉 transport。**动态 import** —— 未启用 dingtalk
// 通道时这个模块一行都不加载。
//
// 与飞书不同，钉钉的 Stream 通道回复走消息自带的 `sessionWebhook`（POST + access
// token），所以不需要公网回调地址。卡片流式（AI 卡片）需要卡片实例 OpenAPI +
// 模板 id，本实现把 `cardTemplateId` 作为显式配置：给了才开启卡片流式，否则
// `canStreamCards=false`，适配器自动降级为「只发最终结果」，审批按钮也降级为
// 文字双轨 —— 待实测项见 cn-im-channels.md §7。
import type { DingTalkCard, DingTalkRawMessage, DingTalkTransport, DingTalkTransportHandlers } from './types';

interface DownStream {
  headers: { messageId: string; topic?: string };
  data: string;
}

interface RobotMessageShape {
  text?: { content?: string };
  senderStaffId?: string;
  senderNick?: string;
  conversationId?: string;
  conversationType?: string;
  robotCode?: string;
  sessionWebhook?: string;
  atUsers?: Array<{ dingtalkId?: string }>;
  isInAtList?: boolean;
  chatbotUserId?: string;
  createAt?: number;
}

interface DingTalkModuleShape {
  DWClient: new (config: { clientId: string; clientSecret: string; debug?: boolean }) => {
    registerCallbackListener(topic: string, handler: (res: DownStream) => unknown): unknown;
    registerAllEventListener(handler: (res: DownStream) => unknown): unknown;
    connect(): void;
    disconnect?(): void;
    getAccessToken(): Promise<string>;
    socketCallBackResponse(messageId: string, data: unknown): void;
  };
  TOPIC_ROBOT: string;
  TOPIC_CARD?: string;
}

export interface DingTalkSdkTransportOptions {
  clientId: string;
  clientSecret: string;
  /** 卡片实例模板 id（内置公共 AI 卡片模板）；给了才开启卡片流式。 */
  cardTemplateId?: string;
  /** 机器人编码；正常从入站消息体里取，拿不到时用这个兜底（发图片必需）。 */
  robotCode?: string;
  log?: (message: string) => void;
}

/** 每个会话的元信息：发图片走 OpenAPI 时需要 robotCode + 会话形态。 */
interface ConversationMeta {
  conversationType: '1' | '2';
  senderStaffId?: string;
  robotCode?: string;
}

function parseRobotMessage(res: DownStream): DingTalkRawMessage | null {
  let payload: RobotMessageShape;
  try {
    payload = JSON.parse(res.data) as RobotMessageShape;
  } catch {
    return null;
  }
  const conversationId = payload.conversationId;
  if (!conversationId) return null;
  const atUsers = payload.atUsers ?? [];
  const atBot = payload.isInAtList === true
    || (!!payload.chatbotUserId && atUsers.some((u) => u.dingtalkId === payload.chatbotUserId))
    || (atUsers.length > 0 && !payload.chatbotUserId);
  return {
    messageId: res.headers.messageId,
    conversationId,
    conversationType: payload.conversationType === '2' ? '2' : '1',
    text: payload.text?.content ?? '',
    atBot,
    senderStaffId: payload.senderStaffId ?? '',
    senderNick: payload.senderNick,
    robotCode: payload.robotCode,
    sessionWebhook: payload.sessionWebhook,
    createTime: payload.createAt,
  };
}

/** 上传图片拿 media_id（旧版 oapi 接口 + query token）。导出供单测固定协议形态。 */
export async function uploadDingTalkMedia(
  token: string,
  image: Uint8Array,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(image)], { type: 'image/png' }), name || 'diagram.png');
  const res = await fetchImpl(`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
    method: 'POST',
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { media_id?: string; errmsg?: string };
  if (!data.media_id) throw new Error(`dingtalk 媒体上传失败：${data.errmsg ?? `HTTP ${res.status}`}`);
  return data.media_id;
}

/** 新版 OpenAPI POST（图片消息不在 sessionWebhook 的支持范围）。 */
export async function postDingTalkOpenApi(
  token: string,
  url: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`dingtalk OpenAPI ${url} 返回 HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export interface DingTalkImageRoute {
  conversationType: '1' | '2';
  openConversationId: string;
  senderStaffId?: string;
}

/** 图片消息落到哪个 robot 接口：群聊用 openConversationId，单聊用 userIds。 */
export function dingTalkImageRequest(
  robotCode: string,
  mediaId: string,
  route: DingTalkImageRoute,
): { url: string; body: Record<string, unknown> } {
  const msgParam = JSON.stringify({ photoURL: mediaId });
  if (route.conversationType === '2') {
    return {
      url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      body: { robotCode, openConversationId: route.openConversationId, msgKey: 'sampleImageMsg', msgParam },
    };
  }
  return {
    url: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    body: { robotCode, userIds: route.senderStaffId ? [route.senderStaffId] : [], msgKey: 'sampleImageMsg', msgParam },
  };
}

export async function createDingTalkSdkTransport(options: DingTalkSdkTransportOptions): Promise<DingTalkTransport> {
  const specifier = 'dingtalk-stream';
  let mod: DingTalkModuleShape;
  try {
    mod = (await import(specifier)) as unknown as DingTalkModuleShape;
  } catch (err) {
    throw new Error(
      `钉钉通道需要 dingtalk-stream：${err instanceof Error ? err.message : String(err)}。` +
      '请运行 bun add dingtalk-stream 后重启 gateway。',
    );
  }
  const log = options.log ?? (() => {});
  const client = new mod.DWClient({ clientId: options.clientId, clientSecret: options.clientSecret });
  const webhooks = new Map<string, string>();
  const conversations = new Map<string, ConversationMeta>();
  const canStreamCards = !!options.cardTemplateId;

  async function postToWebhook(conversationId: string, body: unknown): Promise<string> {
    const webhook = webhooks.get(conversationId);
    if (!webhook) throw new Error(`dingtalk: no sessionWebhook for conversation ${conversationId} (cannot push proactively)`);
    const token = await client.getAccessToken();
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { processQueryKey?: string; messageId?: string };
    return data.processQueryKey ?? data.messageId ?? `dt_${Date.now()}`;
  }

  return {
    canStreamCards,

    async start(handlers: DingTalkTransportHandlers): Promise<void> {
      client.registerCallbackListener(mod.TOPIC_ROBOT, (res) => {
        const raw = parseRobotMessage(res);
        // 立刻回执，避免 60 秒后平台重推（重推由 gateway 的 messageId 去重兜底）。
        client.socketCallBackResponse(res.headers.messageId, {});
        if (!raw) {
          handlers.log('ignoring dingtalk stream message without a usable payload');
          return;
        }
        if (raw.sessionWebhook) webhooks.set(raw.conversationId, raw.sessionWebhook);
        conversations.set(raw.conversationId, {
          conversationType: raw.conversationType,
          senderStaffId: raw.senderStaffId || undefined,
          robotCode: raw.robotCode,
        });
        handlers.onMessage(raw);
      });
      if (mod.TOPIC_CARD) {
        client.registerCallbackListener(mod.TOPIC_CARD, (res) => {
          client.socketCallBackResponse(res.headers.messageId, {});
          try {
            const payload = JSON.parse(res.data) as {
              outTrackId?: string;
              conversationId?: string;
              conversationType?: string;
              userId?: string;
              cardPrivateData?: { params?: { action?: string } };
              action?: string;
            };
            const action = payload.cardPrivateData?.params?.action ?? payload.action ?? '';
            if (payload.outTrackId && payload.conversationId) {
              handlers.onCardAction({
                outTrackId: payload.outTrackId,
                action,
                conversationId: payload.conversationId,
                conversationType: payload.conversationType === '2' ? '2' : '1',
                userId: payload.userId,
              });
            }
          } catch {
            handlers.log('failed to parse dingtalk card callback payload');
          }
        });
      }
      client.connect();
      log(`dingtalk stream client started (cards ${canStreamCards ? 'on' : 'off'})`);
    },

    async stop(): Promise<void> {
      try { client.disconnect?.(); } catch { /* ignore */ }
    },

    async sendMarkdown(conversationId: string, text: string): Promise<string> {
      return postToWebhook(conversationId, { msgtype: 'markdown', markdown: { title: 'pure', text } });
    },

    async sendCard(conversationId: string, card: DingTalkCard): Promise<string> {
      // 按钮降级为文字指令（AI 卡片实例需 templateId；未配置时走这条）。
      const hint = card.buttons?.length ? `\n\n${card.buttons.map((b) => `[${b.label}]`).join('  ')}\n（回复 y 批准 / n 拒绝 / a 本次会话总是允许）` : '';
      return postToWebhook(conversationId, { msgtype: 'markdown', markdown: { title: 'pure', text: `${card.markdown}${hint}` } });
    },

    async updateCard(outTrackId: string, card: DingTalkCard): Promise<void> {
      log(`dingtalk card update requested for ${outTrackId} (card instances require cardTemplateId; not sent)`);
      void card;
    },

    async sendImage(conversationId: string, image: Uint8Array, name: string): Promise<string> {
      const meta = conversations.get(conversationId);
      const robotCode = meta?.robotCode ?? options.robotCode;
      if (!robotCode) {
        throw new Error('dingtalk 图片发送需要 robotCode（消息体内没有，也没有配置兜底）');
      }
      if (meta?.conversationType !== '2' && !meta?.senderStaffId) {
        throw new Error(`dingtalk 单聊图片发送缺少 userId（会话 ${conversationId} 还没有入站消息可用）`);
      }
      const token = await client.getAccessToken();
      const mediaId = await uploadDingTalkMedia(token, image, name);
      const { url, body } = dingTalkImageRequest(robotCode, mediaId, {
        conversationType: meta?.conversationType ?? '1',
        openConversationId: conversationId,
        senderStaffId: meta?.senderStaffId,
      });
      await postDingTalkOpenApi(token, url, body);
      return `dt_img_${Date.now()}`;
    },
  };
}
