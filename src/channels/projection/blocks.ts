// src/channels/projection/blocks.ts
// 把一条回答拆成「文本块 / 富块」。这是通道投影的第一个决策点：
//
//  - 文本块（段落、列表、引用、标题）→ 保持平台原生 markdown：可复制、可搜索、
//    链接可点，IM 客户端自己的排版也比一张图好读。
//  - 富块（代码块、GFM 表格、```chart/```svg/```mermaid/```puml）→ 交给桌面端
//    同一套渲染管线出图，因为这些正是平台 markdown 表达不了的东西。
//
// 纯字符串处理，不依赖 DOM —— 分块规则可以单测，渲染是后面的事。
export type AnswerBlockKind = 'text' | 'rich';

export interface AnswerBlock {
  kind: AnswerBlockKind;
  /** 原始 markdown 片段（块级，不含块与块之间的空行）。 */
  source: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function isFenceClose(line: string, marker: string): boolean {
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const head = lines[index];
  const divider = lines[index + 1];
  return TABLE_ROW.test(head) && divider !== undefined && TABLE_DIVIDER.test(divider);
}

/**
 * 按块切分回答。相邻的文本行合并成一个文本块（减少消息条数），富块各自成块。
 * 空行只是块的分隔，不产生独立块。
 */
export function splitAnswerIntoBlocks(markdown: string): AnswerBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let textBuffer: string[] = [];

  const flushText = (): void => {
    while (textBuffer.length > 0 && textBuffer[0].trim() === '') textBuffer.shift();
    while (textBuffer.length > 0 && textBuffer[textBuffer.length - 1].trim() === '') textBuffer.pop();
    if (textBuffer.length > 0) blocks.push({ kind: 'text', source: textBuffer.join('\n') });
    textBuffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushText();
      const marker = fence[1];
      const body: string[] = [line];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i], marker)) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) body.push(lines[i]);
      blocks.push({ kind: 'rich', source: body.join('\n') });
      continue;
    }

    if (isTableStart(lines, i)) {
      flushText();
      const body: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'rich', source: body.join('\n') });
      continue;
    }

    textBuffer.push(line);
  }

  flushText();
  return blocks;
}

/** 是否还有富块（决定要不要为一个回答启动 headless 渲染）。 */
export function hasRichBlock(blocks: AnswerBlock[]): boolean {
  return blocks.some((block) => block.kind === 'rich');
}
