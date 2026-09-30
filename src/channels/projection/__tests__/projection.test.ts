import { describe, it, expect } from 'bun:test';
import { createAnswerProjection } from '../projection';
import type { ChannelCapabilities } from '../../types';

const CAPS: ChannelCapabilities = {
  chatTypes: ['dm'], media: { images: true }, canDeliverImages: true,
  streaming: 'card', maxTextLength: 4000, markdown: 'full',
};

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const ANSWER = [
  '先说结论。',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '然后是说明。',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
].join('\n');

describe('createAnswerProjection', () => {
  it('returns null when there is no rich renderer', async () => {
    const project = createAnswerProjection({});
    expect(await project(ANSWER, CAPS)).toBeNull();
  });

  it('returns null on a channel that cannot deliver images', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => PNG });
    expect(await project(ANSWER, { ...CAPS, canDeliverImages: false })).toBeNull();
  });

  it('returns null when the answer has no rich block', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => PNG });
    expect(await project('只有文字', CAPS)).toBeNull();
  });

  it('splits the answer into native text and one image per rich block, in order', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => PNG });
    const result = await project(ANSWER, CAPS);
    expect(result).not.toBeNull();
    const messages = result!.messages;
    expect(messages.map((m) => (m.attachments?.length ? 'image' : 'text'))).toEqual(['text', 'image', 'text', 'image']);
    expect(messages[0].text).toBe('先说结论。');
    expect(messages[2].text).toBe('然后是说明。');
    // 富块不进文本：源码被图替代，而不是图文重复。
    expect(messages.some((m) => m.text.includes('```'))).toBe(false);
    expect(result!.notes).toEqual([]);
  });

  it('marks only the last projected message as final', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => PNG });
    const messages = (await project(ANSWER, CAPS))!.messages;
    expect(messages.slice(0, -1).every((m) => m.final !== true)).toBe(true);
    expect(messages[messages.length - 1].final).toBe(true);
  });

  it('names attachments by index and uses png mime type', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => PNG });
    const messages = (await project(ANSWER, CAPS))!.messages;
    const images = messages.filter((m) => m.attachments?.length);
    expect(images.map((m) => m.attachments![0].name)).toEqual(['block-1.png', 'block-2.png']);
    expect(images[0].attachments![0].mimeType).toBe('image/png');
    expect(images[0].text).toBe('');
  });

  it('falls back to source text when a block fails to render', async () => {
    let calls = 0;
    const project = createAnswerProjection({
      renderRichBlock: async () => (++calls === 1 ? null : PNG),
    });
    const result = await project(ANSWER, CAPS);
    const messages = result!.messages;
    // 失败的代码块源码并回正文，成功的那块仍然是图。
    expect(messages.map((m) => (m.attachments?.length ? 'image' : 'text'))).toEqual(['text', 'image']);
    expect(messages[0].text).toContain('```ts');
    expect(messages[0].text).toContain('const a = 1;');
    expect(messages[0].text).not.toContain('```mermaid');
    expect(result!.notes.join('\n')).toContain('没能渲染成图片');
  });

  it('merges every failed block back into one continuous text message', async () => {
    const project = createAnswerProjection({
      renderRichBlock: async () => new Uint8Array(64),
      maxAttachmentBytes: 8,
    });
    const result = await project(ANSWER, CAPS);
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].text).toContain('```ts');
    expect(result!.messages[0].text).toContain('然后是说明。');
    expect(result!.messages[0].text).toContain('```mermaid');
    expect(result!.notes.join('\n')).toContain('过大');
  });

  it('degrades whole-message failures to a single text message', async () => {
    const project = createAnswerProjection({ renderRichBlock: async () => { throw new Error('boom'); } });
    const result = await project(ANSWER, CAPS);
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].text).toContain('```mermaid');
  });
});
