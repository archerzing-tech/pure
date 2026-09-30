// src/channels/projection/projection.ts
// 把「桌面端的一条回答」投影成「通道里的一串消息」。
//
// 契约（与产品选择一致）：
//   文本块 → 平台原生 markdown（可复制、可搜索、链接可点）；
//   富块   → 桌面端同一渲染管线的截图（代码块、表格、chart/svg/mermaid/puml）。
// 富块渲染不出来时**把源码退回文本**，而不是丢掉内容 —— 降级永远不丢东西。
//
// 返回 null 表示「这次不该走投影」（没有富块 / 通道发不了图 / 渲染页不可用），
// 调用方据此走原来的纯文本路径。
import type { ChannelCapabilities, OutboundMessage } from '../types';
import { hasRichBlock, splitAnswerIntoBlocks } from './blocks';

export interface ProjectionDeps {
  /** 把一段富块 markdown 渲染成 PNG；不可用或失败返回 null。 */
  renderRichBlock?: (markdown: string) => Promise<Uint8Array | null>;
  /** 单张附件的字节上限（超过就退回文本，免得把巨图塞进 IM）。 */
  maxAttachmentBytes?: number;
}

export interface ProjectionResult {
  messages: OutboundMessage[];
  notes: string[];
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export type AnswerProjection = (
  text: string,
  capabilities: ChannelCapabilities,
) => Promise<ProjectionResult | null>;

export function createAnswerProjection(deps: ProjectionDeps): AnswerProjection {
  const maxBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  return async function projectAnswer(text, capabilities): Promise<ProjectionResult | null> {
    const render = deps.renderRichBlock;
    if (!render) return null;
    if ((capabilities.canDeliverImages ?? capabilities.media.images) !== true) return null;

    const blocks = splitAnswerIntoBlocks(text);
    if (!hasRichBlock(blocks)) return null;

    const messages: OutboundMessage[] = [];
    const notes: string[] = [];
    let pendingText: string[] = [];
    let imageIndex = 0;

    const flushText = (): void => {
      const source = pendingText.join('\n\n').trim();
      pendingText = [];
      if (source) messages.push({ kind: 'final', text: source, final: false });
    };

    for (const block of blocks) {
      if (block.kind === 'text') {
        pendingText.push(block.source);
        continue;
      }
      let png: Uint8Array | null = null;
      try {
        png = await render(block.source);
      } catch {
        png = null;
      }
      if (!png || png.length === 0) {
        // 渲染不出来就把源码并回正文 —— 不 flush，让失败的块和前后的文字
        // 合并成同一条消息，读起来仍是原来的连续回答。
        notes.push('有一块富内容没能渲染成图片，已把源码留在正文里。');
        pendingText.push(block.source);
        continue;
      }
      if (png.length > maxBytes) {
        notes.push('有一块富内容渲染出的图片过大，已把源码留在正文里。');
        pendingText.push(block.source);
        continue;
      }
      // 图片要落在它原本的位置上：先把盖着的文本发出去，再发图。
      flushText();
      imageIndex += 1;
      messages.push({
        kind: 'final',
        text: '',
        final: false,
        attachments: [{ name: `block-${imageIndex}.png`, mimeType: 'image/png', data: png }],
      });
    }
    flushText();

    if (messages.length === 0) return null;
    if (notes.length > 0) {
      const lastText = [...messages].reverse().find((message) => message.text.trim() !== '');
      if (lastText) lastText.text = `${lastText.text}\n\n${notes.join('\n')}`;
    }
    messages[messages.length - 1] = { ...messages[messages.length - 1], final: true };
    return { messages, notes };
  };
}
