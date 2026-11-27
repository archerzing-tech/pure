// src/ui/checkpointLog.ts
// P1-b（engine-worker-migration 落地计划）— 检查点的转录增量。
//
// events.jsonl 里的 `transcript_delta` 必须自带恢复所需的转录形状，但单行要
// 有界：工具参数（write_file 整个文件）和图片 base64 是体量炸点。这里只做
// 两件事——保留消息骨架、把无界字段截到可读上限；图片有盘上 path 时不再
// 重复带 dataUrl。
//
// 截断是**有意的降级**：日志尾用于崩溃打捞，完整内容仍在快照/盘上文件里。
// 读取侧遇到 truncated 标记时不应假设内容完整。

import type { Message, MessageImage } from '../shared/types';
import type { TranscriptDraft } from './store';

/** 单条消息/工具参数的字符上限。32k 足以覆盖绝大多数助手文本与 diff。 */
const MAX_TEXT_CHARS = 32_000;
/** 没有盘上 path 时，内联图片超过这个长度就不进日志（base64 不进事件）。 */
const MAX_INLINE_IMAGE_CHARS = 8_000;

function boundImage(image: MessageImage): MessageImage {
  if (image.path) return { ...image, dataUrl: '' };
  if (typeof image.dataUrl === 'string' && image.dataUrl.length > MAX_INLINE_IMAGE_CHARS) {
    return { ...image, dataUrl: '' };
  }
  return image;
}

function boundMessage(message: Message): Message {
  const next: Message = { ...message };
  if (typeof next.content === 'string' && next.content.length > MAX_TEXT_CHARS) {
    const dropped = next.content.length - MAX_TEXT_CHARS;
    next.content = `${next.content.slice(0, MAX_TEXT_CHARS)}\n…[checkpoint truncated ${dropped} chars]`;
  }
  if (next.images?.length) next.images = next.images.map(boundImage);
  if (next.toolCalls?.length) {
    next.toolCalls = next.toolCalls.map((call) => {
      const args = call.function?.arguments;
      if (typeof args !== 'string' || args.length <= MAX_TEXT_CHARS) return call;
      return {
        ...call,
        function: { ...call.function, arguments: `${args.slice(0, MAX_TEXT_CHARS)}…[truncated]` },
      };
    });
  }
  return next;
}

/** 把检查点新增的消息投影成带 modelMessageIndex 的转录草稿（游标连续）。 */
export function buildTranscriptDelta(
  messages: readonly Message[],
  startIndex: number,
): TranscriptDraft[] {
  return messages.map((message, offset) => ({
    message: boundMessage(message),
    modelMessageIndex: startIndex + offset,
  }));
}
