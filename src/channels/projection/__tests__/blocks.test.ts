import { describe, it, expect } from 'bun:test';
import { hasRichBlock, splitAnswerIntoBlocks } from '../blocks';

describe('splitAnswerIntoBlocks', () => {
  it('keeps prose as one text block', () => {
    const blocks = splitAnswerIntoBlocks('第一段\n\n第二段');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].source).toBe('第一段\n\n第二段');
  });

  it('lifts a fenced code block out as a rich block', () => {
    const blocks = splitAnswerIntoBlocks('看这段：\n\n```ts\nconst a = 1;\n```\n\n就这样');
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'rich', 'text']);
    expect(blocks[1].source).toBe('```ts\nconst a = 1;\n```');
    expect(blocks[0].source).toBe('看这段：');
    expect(blocks[2].source).toBe('就这样');
  });

  it('handles diagram fences the same way', () => {
    const blocks = splitAnswerIntoBlocks('```mermaid\ngraph TD; A-->B\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('rich');
  });

  it('accepts tilde fences and longer markers', () => {
    expect(splitAnswerIntoBlocks('~~~py\nprint(1)\n~~~')[0].kind).toBe('rich');
    expect(splitAnswerIntoBlocks('````md\n```\ninner\n```\n````')[0].source).toContain('inner');
  });

  it('lifts a GFM table out as a rich block', () => {
    const blocks = splitAnswerIntoBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n收尾');
    expect(blocks.map((b) => b.kind)).toEqual(['rich', 'text']);
    expect(blocks[0].source.split('\n')).toHaveLength(3);
    expect(blocks[1].source).toBe('收尾');
  });

  it('does not mistake a pipe-only line for a table', () => {
    const blocks = splitAnswerIntoBlocks('| 只有一个竖线行 |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
  });

  it('returns nothing for blank input', () => {
    expect(splitAnswerIntoBlocks('  \n\n ')).toEqual([]);
  });

  it('reports whether a rich block exists', () => {
    expect(hasRichBlock(splitAnswerIntoBlocks('纯文字'))).toBe(false);
    expect(hasRichBlock(splitAnswerIntoBlocks('```ts\nx\n```'))).toBe(true);
  });
});
