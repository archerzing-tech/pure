// src/shared/imageContext.ts
// P1-2（2026-11-13 性能审计）：历史截图在请求侧降级。
//
// 问题：`modelContext.messages[].images[].dataUrl` 永久保留原图 base64，两个
// 适配器组装请求时把它整份带上——一张 2.94MB 截图 → 3.74MB base64，每一轮
// 请求都重传一次，服务端也要重复计图像 token。
//
// 取舍：用户**最近**的 N 条带图消息保持原图（当前轮上传的截图永远原样发送），
// 更早的降级成 `thumbDataUrl`（≤0.5MP，气泡本来就渲染缩略图，视觉零变化）。
// 没有缩略图的老快照退化为「不含图 + 一句说明」，避免模型的引用悬空。
// 快照与磁盘一律不动：原图始终能从 ~/.pure/attachments/ 取回。

import type { Message } from './types';

export interface HistoricalImagePolicy {
  /** 关掉后完全不裁剪（等价于旧行为）。 */
  enabled: boolean;
  /** 保留原图的最近「带图用户消息」条数。 */
  keepRecentUserImages: number;
}

export const DEFAULT_HISTORICAL_IMAGE_POLICY: HistoricalImagePolicy = {
  enabled: true,
  keepRecentUserImages: 2,
};

let policy: HistoricalImagePolicy = { ...DEFAULT_HISTORICAL_IMAGE_POLICY };

/** 宿主（GUI 配置 / 测试）调整策略；缺省字段保持不变。 */
export function setHistoricalImagePolicy(next: Partial<HistoricalImagePolicy>): void {
  policy = { ...policy, ...next };
}

export function getHistoricalImagePolicy(): HistoricalImagePolicy {
  return { ...policy };
}

export const FOLDED_IMAGE_NOTE = '（较早的截图已折叠；原图仍保留在本机附件目录）';

/**
 * 把较早的用户截图降级为缩略图。返回新数组；无需改动时**返回原引用**
 * （调用方可以拿它做零成本短路）。
 */
export function trimHistoricalImages(
  messages: Message[],
  overrides: Partial<HistoricalImagePolicy> = {},
): Message[] {
  const active: HistoricalImagePolicy = { ...policy, ...overrides };
  if (!active.enabled || active.keepRecentUserImages < 0) return messages;

  const imageMessages: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user' && message.images?.length) imageMessages.push(index);
  }
  if (imageMessages.length <= active.keepRecentUserImages) return messages;

  const keepFrom = imageMessages[imageMessages.length - active.keepRecentUserImages];
  let changed = false;
  const out = messages.map((message, index): Message => {
    if (index >= keepFrom || message.role !== 'user' || !message.images?.length) return message;
    const folded = message.images
      .map((image) => (image.thumbDataUrl ? { ...image, dataUrl: image.thumbDataUrl } : null))
      .filter((image): image is NonNullable<typeof image> => image !== null);
    changed = true;
    if (folded.length > 0) return { ...message, images: folded };
    const content = (message.content ?? '').trim();
    return {
      ...message,
      images: undefined,
      content: content ? `${message.content}\n\n${FOLDED_IMAGE_NOTE}` : FOLDED_IMAGE_NOTE,
    };
  });
  return changed ? out : messages;
}
